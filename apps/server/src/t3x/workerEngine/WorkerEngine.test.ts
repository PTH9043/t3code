// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDateInEffect:off
import { execFileSync } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  WORKER_CIRCUIT_BREAKER_THRESHOLD,
  WORKER_ENGINE_MAX_WAIT_SECONDS,
  WORKER_MAX_RUNNING_PER_THREAD,
  clampWorkerWaitSeconds,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../../persistence/Layers/Sqlite.ts";
import { startWorkerCheckKeepalive } from "./checkKeepalive.ts";
import {
  WorkerEngineService,
  makeWorkerEngineServiceLayer,
  type WorkerExecutionRunner,
} from "./WorkerEngineService.ts";
import { WorkerEngineError } from "./WorkerEngineStore.ts";

function makeTempDir(prefix: string): string {
  return NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));
}

function initTempGitRepo(dir: string): void {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "T3 Test"]);
  git(["config", "user.email", "t3-test@local"]);
  NodeFs.writeFileSync(NodePath.join(dir, "README.md"), "# test repo\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);
}

function buildMemoryEngineLayer(
  runner: WorkerExecutionRunner,
  options?: { readonly startHeartbeatFiber?: boolean; readonly reconcileOnBoot?: boolean },
) {
  return makeWorkerEngineServiceLayer({
    runner,
    heartbeat: {
      startBackgroundFiber: options?.startHeartbeatFiber ?? false,
      dbDebounceMs: 1_000,
    },
    reconcileOnBoot: options?.reconcileOnBoot ?? true,
  }).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provide(NodeServices.layer));
}

it.live(
  "survives server restart with zero mail loss, replays unacknowledged deliveries, and preserves interrupted worktrees",
  () =>
    Effect.gen(function* () {
      const tempDir = makeTempDir("t3-worker-restart-");
      const repoDir = NodePath.join(tempDir, "repo");
      NodeFs.mkdirSync(repoDir, { recursive: true });
      initTempGitRepo(repoDir);
      const dbPath = NodePath.join(tempDir, "state.sqlite");

      try {
        const hangGate = yield* Deferred.make<void>();
        const startedHanging = yield* Deferred.make<void>();

        const runner1: WorkerExecutionRunner = (req) => {
          if (req.task.specText.includes("fast-task")) {
            return Effect.succeed({
              resultText: "fast completed output",
              summary: "fast task succeeded",
              exitCode: 0,
            });
          }
          return Effect.gen(function* () {
            NodeFs.writeFileSync(
              NodePath.join(req.effectiveCwd, "in-progress.txt"),
              "partial work before crash\n",
              "utf8",
            );
            yield* Deferred.succeed(startedHanging, undefined);
            yield* Deferred.await(hangGate);
            return { resultText: "unreachable", exitCode: 0 };
          });
        };

        // 1st server incarnation: complete task A (leave mail unacked) + leave task B running in isolated worktree.
        const scope1 = yield* Scope.make();
        const sqlite1 = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
        const layer1 = makeWorkerEngineServiceLayer({
          runner: runner1,
          heartbeat: { startBackgroundFiber: false },
          reconcileOnBoot: true,
        }).pipe(Layer.provideMerge(sqlite1));
        const ctx1 = yield* Layer.buildWithScope(layer1, scope1);
        const engine1 = yield* WorkerEngineService.pipe(Effect.provide(ctx1));

        const fastReceipt = yield* engine1.dispatch({
          runId: "run_restart",
          threadId: "thread_restart",
          role: "reviewer",
          targetInstanceId: "codex",
          targetModel: "gpt-5.4",
          specText: "fast-task verify",
          cwd: repoDir,
          worktreeMode: "current",
        });
        expect(fastReceipt.deduplicated).toBe(false);

        const firstCheck = yield* engine1.check({
          runId: "run_restart",
          wait: true,
          timeoutSec: 5,
        });
        expect(firstCheck.deliveryId).not.toBeNull();
        expect(firstCheck.replayed).toBe(false);
        expect(firstCheck.messages.some((m) => m.type === "worker_done")).toBe(true);
        const unackedDeliveryId = firstCheck.deliveryId!;

        // Intentionally DO NOT ack `unackedDeliveryId` before simulated crash.
        const hangReceipt = yield* engine1.dispatch({
          runId: "run_restart",
          threadId: "thread_restart",
          role: "worker",
          targetInstanceId: "codex",
          targetModel: "gpt-5.4",
          specText: "long-running worktree edit",
          cwd: repoDir,
          worktreeMode: "isolated",
        });
        expect(hangReceipt.worktreePath).not.toBeNull();
        yield* Deferred.await(startedHanging);

        // Simulate abrupt server restart by closing scope1.
        yield* Scope.close(scope1, Exit.void);

        // 2nd server incarnation against the exact same SQLite file.
        const scope2 = yield* Scope.make();
        const sqlite2 = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
        const layer2 = makeWorkerEngineServiceLayer({
          runner: () => Effect.succeed({ resultText: "noop" }),
          heartbeat: { startBackgroundFiber: false },
          reconcileOnBoot: true,
        }).pipe(Layer.provideMerge(sqlite2));
        const ctx2 = yield* Layer.buildWithScope(layer2, scope2);
        const engine2 = yield* WorkerEngineService.pipe(Effect.provide(ctx2));

        // 1. Unacknowledged delivery replays with the exact same deliveryId (0 mail loss).
        const replayedCheck = yield* engine2.check({ runId: "run_restart" });
        expect(replayedCheck.replayed).toBe(true);
        expect(replayedCheck.deliveryId).toBe(unackedDeliveryId);
        expect(replayedCheck.messages.some((m) => m.type === "worker_done")).toBe(true);

        const ackRes = yield* engine2.ack({ deliveryId: unackedDeliveryId });
        expect(ackRes.acknowledged).toBe(true);
        expect(ackRes.acknowledgedMessageCount).toBeGreaterThanOrEqual(1);

        // 2. Interrupted worker dispatch was reconciled, escalation mail emitted, and worktree preserved.
        const reconciledDispatch = yield* engine2.getDispatch(hangReceipt.dispatchId);
        expect(reconciledDispatch?.status).toBe("interrupted_by_restart");
        const reconciledTask = yield* engine2.getTask(hangReceipt.taskId);
        expect(reconciledTask?.status).toBe("failed");
        expect(reconciledTask?.worktreeState).toBe("review_ready");
        expect(NodeFs.existsSync(hangReceipt.worktreePath!)).toBe(true);
        expect(NodeFs.existsSync(NodePath.join(hangReceipt.worktreePath!, "in-progress.txt"))).toBe(
          true,
        );

        const escalationCheck = yield* engine2.check({ runId: "run_restart" });
        expect(
          escalationCheck.messages.some(
            (m) => m.type === "escalation" && m.dispatchId === hangReceipt.dispatchId,
          ),
        ).toBe(true);
        if (escalationCheck.deliveryId) {
          yield* engine2.ack({ deliveryId: escalationCheck.deliveryId });
        }

        // Clean up worktree via discard so temp directory can be removed cleanly on Windows.
        yield* engine2.discardWorktree(hangReceipt.taskId);
        yield* Scope.close(scope2, Exit.void);
      } finally {
        NodeFs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  20_000,
);

it.live(
  "enforces DB deduplication, idempotencyKey, fencing token rejection, 3-strike circuit breaker, and 6-worker concurrency cap",
  () =>
    Effect.gen(function* () {
      let executions = 0;
      const releaseGate = yield* Deferred.make<void>();
      let failMode = false;

      const runner: WorkerExecutionRunner = (req) =>
        Effect.gen(function* () {
          executions += 1;
          if (req.task.specText.includes("always-fail") || failMode) {
            return yield* new WorkerEngineError({
              code: "invalid_state",
              message: "simulated worker failure",
            });
          }
          if (req.task.specText.includes("hold")) {
            yield* Deferred.await(releaseGate);
          }
          return { resultText: `done:${req.task.specText}`, exitCode: 0 };
        });

      yield* Effect.gen(function* () {
        const engine = yield* WorkerEngineService;

        // 1. 3 parallel dispatches with identical (role, target, model, spec, cwd) -> only 1 execution.
        const [r1, r2, r3] = yield* Effect.all(
          [
            engine.dispatch({
              runId: "run_dedup",
              threadId: "thread_dedup",
              role: "reviewer",
              targetInstanceId: "codex",
              targetModel: "gpt-5.4",
              specText: "hold identical spec",
              cwd: process.cwd(),
              worktreeMode: "current",
            }),
            engine.dispatch({
              runId: "run_dedup",
              threadId: "thread_dedup",
              role: "reviewer",
              targetInstanceId: "codex",
              targetModel: "gpt-5.4",
              specText: "hold   identical   spec",
              cwd: process.cwd(),
              worktreeMode: "current",
            }),
            engine.dispatch({
              runId: "run_dedup",
              threadId: "thread_dedup",
              role: "reviewer",
              targetInstanceId: "codex",
              targetModel: "gpt-5.4",
              specText: "hold identical spec",
              cwd: process.cwd(),
              worktreeMode: "current",
            }),
          ],
          { concurrency: "unbounded" },
        );

        expect(r1.taskId).toBe(r2.taskId);
        expect(r2.taskId).toBe(r3.taskId);
        expect(r1.dispatchId).toBe(r2.dispatchId);
        const dedupCount = [r1, r2, r3].filter((r) => r.deduplicated).length;
        expect(dedupCount).toBe(2);

        // 2. Stale fencing token rejection.
        const staleExit = yield* Effect.exit(
          engine.recordWorkerDone({
            taskId: r1.taskId,
            dispatchId: r1.dispatchId,
            fencingToken: r1.fencingToken + 99,
            outcome: {
              status: "succeeded",
              summary: "stale",
              filesModified: [],
              latencyMs: 10,
              provider: "codex",
              model: "gpt-5.4",
            },
          }),
        );
        expect(Exit.isFailure(staleExit)).toBe(true);

        // Release held worker and wait for completion.
        yield* Deferred.succeed(releaseGate, undefined);
        const checkDone = yield* engine.check({ runId: "run_dedup", wait: true, timeoutSec: 5 });
        expect(checkDone.messages.some((m) => m.type === "worker_done")).toBe(true);
        expect(executions).toBe(1);

        // 3. Idempotency key reuse returns exact original receipt without running again.
        const idem1 = yield* engine.dispatch({
          runId: "run_idem",
          threadId: "thread_idem",
          idempotencyKey: "idem-unique-1",
          role: "reviewer",
          targetInstanceId: "codex",
          specText: "quick idem check",
          cwd: process.cwd(),
          worktreeMode: "current",
        });
        yield* engine.check({ runId: "run_idem", wait: true, timeoutSec: 5 });
        const idem2 = yield* engine.dispatch({
          runId: "run_idem",
          threadId: "thread_idem",
          idempotencyKey: "idem-unique-1",
          role: "reviewer",
          targetInstanceId: "codex",
          specText: "quick idem check",
          cwd: process.cwd(),
          worktreeMode: "current",
        });
        expect(idem2.reusedIdempotency).toBe(true);
        expect(idem2.taskId).toBe(idem1.taskId);
        expect(idem2.dispatchId).toBe(idem1.dispatchId);

        // 4. Retry 3-strike circuit breaker.
        let lastDispatchId: string | undefined;
        for (let i = 0; i < WORKER_CIRCUIT_BREAKER_THRESHOLD; i += 1) {
          const rec = yield* engine.dispatch({
            runId: "run_cb",
            threadId: "thread_cb",
            role: "reviewer",
            targetInstanceId: "codex",
            specText: "always-fail spec",
            cwd: process.cwd(),
            worktreeMode: "current",
            ...(lastDispatchId ? { retryOfDispatchId: lastDispatchId } : {}),
          });
          lastDispatchId = rec.dispatchId;
          const c = yield* engine.check({ runId: "run_cb", wait: true, timeoutSec: 5 });
          if (c.deliveryId) {
            yield* engine.ack({ deliveryId: c.deliveryId });
          }
        }
        const breakerRes = yield* Effect.result(
          engine.dispatch({
            runId: "run_cb",
            threadId: "thread_cb",
            role: "reviewer",
            targetInstanceId: "codex",
            specText: "always-fail spec",
            cwd: process.cwd(),
            worktreeMode: "current",
            retryOfDispatchId: lastDispatchId!,
          }),
        );
        expect(breakerRes._tag).toBe("Failure");
        if (breakerRes._tag === "Failure") {
          expect(breakerRes.failure.code).toBe("circuit_broken");
        }
      }).pipe(Effect.provide(buildMemoryEngineLayer(runner)));

      // 5. Per-thread active concurrency ceiling (`WORKER_MAX_RUNNING_PER_THREAD = 6`).
      const holdGate2 = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const capEngine = yield* WorkerEngineService;
        for (let i = 0; i < WORKER_MAX_RUNNING_PER_THREAD; i += 1) {
          yield* capEngine.dispatch({
            runId: "run_cap",
            threadId: "thread_cap",
            role: "reviewer",
            targetInstanceId: "codex",
            specText: `distinct-spec-${i}`,
            cwd: process.cwd(),
            worktreeMode: "current",
          });
        }
        const overCap = yield* Effect.result(
          capEngine.dispatch({
            runId: "run_cap",
            threadId: "thread_cap",
            role: "reviewer",
            targetInstanceId: "codex",
            specText: "distinct-spec-overflow",
            cwd: process.cwd(),
            worktreeMode: "current",
          }),
        );
        expect(overCap._tag).toBe("Failure");
        if (overCap._tag === "Failure") {
          expect(overCap.failure.code).toBe("concurrency_limit");
        }
        yield* Deferred.succeed(holdGate2, undefined);
      }).pipe(
        Effect.provide(
          buildMemoryEngineLayer(() =>
            Deferred.await(holdGate2).pipe(Effect.as({ resultText: "ok" })),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  20_000,
);

it.live(
  "clamps wait timeout to <= 120s, wakes immediately on mail, and emits stderr keepalive JSON",
  () =>
    Effect.gen(function* () {
      expect(clampWorkerWaitSeconds(200)).toBe(WORKER_ENGINE_MAX_WAIT_SECONDS);
      expect(clampWorkerWaitSeconds(0)).toBe(1);
      expect(clampWorkerWaitSeconds(undefined, 45)).toBe(45);

      const frames: string[] = [];
      const stopKeepalive = startWorkerCheckKeepalive({
        intervalMs: 20,
        deadlineMs: Date.now() + 10_000,
        writeLine: (line) => frames.push(line),
      });
      yield* Effect.sleep("75 millis");
      stopKeepalive();
      expect(frames.length).toBeGreaterThanOrEqual(2);
      const parsed = JSON.parse(frames[0]!) as Record<string, unknown>;
      expect(parsed._keepalive).toBe(true);
      expect(parsed._heartbeat).toBe(true);
      expect(typeof parsed.elapsedMs).toBe("number");

      yield* Effect.gen(function* () {
        const engine = yield* WorkerEngineService;

        const waitFiber = yield* Effect.forkChild(
          engine.check({
            runId: "run_wait",
            wait: true,
            timeoutSec: 300,
          }),
        );
        yield* Effect.sleep("40 millis");
        yield* engine.postMessage({
          runId: "run_wait",
          threadId: "thread_wait",
          fromActor: "worker:1",
          toActor: "run:run_wait",
          type: "status",
          subject: "wakeup",
          body: "woke up",
        });

        const waited = yield* Fiber.join(waitFiber);
        expect(waited.clampedTimeoutSec).toBe(WORKER_ENGINE_MAX_WAIT_SECONDS);
        expect(waited.messages.length).toBe(1);
        expect(waited.messages[0]?.subject).toBe("wakeup");
      }).pipe(Effect.provide(buildMemoryEngineLayer(() => Effect.succeed({ resultText: "ok" }))));
    }).pipe(Effect.scoped),
);

it.effect(
  "transitions silent worker to stalled at 5m and aborts at 15m under TestClock while keeping active workers alive",
  () =>
    Effect.gen(function* () {
      const stuckGate = yield* Deferred.make<void>();
      const activeGate = yield* Deferred.make<void>();
      const touchActiveRef: {
        current: ((summary?: string | null) => Effect.Effect<void>) | null;
      } = { current: null };

      yield* Effect.gen(function* () {
        const engine = yield* WorkerEngineService;

        const stuckReceipt = yield* engine.dispatch({
          runId: "run_hb",
          threadId: "thread_hb",
          role: "reviewer",
          targetInstanceId: "codex",
          specText: "stuck-worker",
          cwd: process.cwd(),
          worktreeMode: "current",
        });
        const activeReceipt = yield* engine.dispatch({
          runId: "run_hb",
          threadId: "thread_hb",
          role: "reviewer",
          targetInstanceId: "codex",
          specText: "active-worker",
          cwd: process.cwd(),
          worktreeMode: "current",
        });

        // Let forked fibers enter runner.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        // Advance 4 minutes -> touch active worker -> advance 2 more minutes (stuck=6m, active=2m).
        yield* TestClock.adjust("4 minutes");
        if (touchActiveRef.current) {
          yield* touchActiveRef.current("reading files");
        }
        yield* TestClock.adjust("2 minutes");

        const sweep1 = yield* engine.sweepHeartbeatsOnce();
        expect(sweep1.stalled).toContain(stuckReceipt.dispatchId);
        expect(sweep1.stalled).not.toContain(activeReceipt.dispatchId);
        expect(sweep1.aborted).toEqual([]);

        const stuckAfter5m = yield* engine.getDispatch(stuckReceipt.dispatchId);
        expect(stuckAfter5m?.status).toBe("stalled");

        const escalationMail = yield* engine.check({ runId: "run_hb" });
        expect(
          escalationMail.messages.some(
            (m) => m.type === "escalation" && m.dispatchId === stuckReceipt.dispatchId,
          ),
        ).toBe(true);
        if (escalationMail.deliveryId) {
          yield* engine.ack({ deliveryId: escalationMail.deliveryId });
        }

        // Advance 10 more minutes (stuck idle=16m >= 15m abort threshold); keep active touched before sweep.
        yield* TestClock.adjust("5 minutes");
        if (touchActiveRef.current) {
          yield* touchActiveRef.current("still working");
        }
        yield* TestClock.adjust("5 minutes");
        if (touchActiveRef.current) {
          yield* touchActiveRef.current("finishing");
        }

        const sweep2 = yield* engine.sweepHeartbeatsOnce();
        expect(sweep2.aborted).toContain(stuckReceipt.dispatchId);
        expect(sweep2.aborted).not.toContain(activeReceipt.dispatchId);

        const stuckAfter15m = yield* engine.getDispatch(stuckReceipt.dispatchId);
        expect(stuckAfter15m?.status).toBe("failed");

        const doneMail = yield* engine.check({ runId: "run_hb" });
        expect(
          doneMail.messages.some(
            (m) =>
              m.type === "worker_done" &&
              m.dispatchId === stuckReceipt.dispatchId &&
              m.outcome === "failed",
          ),
        ).toBe(true);

        yield* Deferred.succeed(activeGate, undefined);
        yield* Deferred.succeed(stuckGate, undefined);
      }).pipe(
        Effect.provide(
          buildMemoryEngineLayer((req) => {
            if (req.task.specText === "active-worker") {
              touchActiveRef.current = req.onActivity;
              return Deferred.await(activeGate).pipe(Effect.as({ resultText: "active ok" }));
            }
            return Deferred.await(stuckGate).pipe(Effect.as({ resultText: "never" }));
          }),
        ),
      );
    }).pipe(Effect.scoped),
);

it.live(
  "preserves isolated worktree in review_ready on completion and supports explicit diff, merge, and discard",
  () =>
    Effect.gen(function* () {
      const tempDir = makeTempDir("t3-worker-wt-");
      initTempGitRepo(tempDir);

      try {
        yield* Effect.gen(function* () {
          const engine = yield* WorkerEngineService;

          // 1. Merge flow
          const mergeRec = yield* engine.dispatch({
            runId: "run_wt",
            threadId: "thread_wt",
            role: "worker",
            targetInstanceId: "codex",
            specText: "create merged feature",
            cwd: tempDir,
            worktreeMode: "isolated",
          });
          expect(mergeRec.worktreeMode).toBe("isolated");
          expect(mergeRec.worktreePath).not.toBeNull();

          const checkMerge = yield* engine.check({ runId: "run_wt", wait: true, timeoutSec: 5 });
          const types1 = checkMerge.messages.map((m) => m.type);
          expect(types1).toContain("worker_done");
          expect(types1).toContain("merge_ready");
          if (checkMerge.deliveryId) {
            yield* engine.ack({ deliveryId: checkMerge.deliveryId });
          }

          // Worktree must STILL exist after completion (never auto-deleted!).
          const taskAfterDone = yield* engine.getTask(mergeRec.taskId);
          expect(taskAfterDone?.worktreeState).toBe("review_ready");
          expect(NodeFs.existsSync(mergeRec.worktreePath!)).toBe(true);
          expect(NodeFs.existsSync(NodePath.join(tempDir, "merged-feature.txt"))).toBe(false);

          const diff = yield* engine.inspectWorktreeDiff(mergeRec.taskId);
          expect(diff.filesModified).toContain("merged-feature.txt");

          const merged = yield* engine.mergeWorktree(mergeRec.taskId);
          expect(merged.worktreeState).toBe("merged");
          expect(merged.mergedCommit).not.toBeNull();
          expect(NodeFs.existsSync(NodePath.join(tempDir, "merged-feature.txt"))).toBe(true);
          expect(NodeFs.existsSync(mergeRec.worktreePath!)).toBe(false);

          // 2. Discard flow
          const discardRec = yield* engine.dispatch({
            runId: "run_wt",
            threadId: "thread_wt",
            role: "worker",
            targetInstanceId: "codex",
            specText: "create discard candidate",
            cwd: tempDir,
            worktreeMode: "isolated",
          });
          const checkDiscard = yield* engine.check({ runId: "run_wt", wait: true, timeoutSec: 5 });
          if (checkDiscard.deliveryId) {
            yield* engine.ack({ deliveryId: checkDiscard.deliveryId });
          }
          expect(NodeFs.existsSync(discardRec.worktreePath!)).toBe(true);

          const discarded = yield* engine.discardWorktree(discardRec.taskId);
          expect(discarded.worktreeState).toBe("discarded");
          expect(NodeFs.existsSync(discardRec.worktreePath!)).toBe(false);
          expect(NodeFs.existsSync(NodePath.join(tempDir, "discard-me.txt"))).toBe(false);
        }).pipe(
          Effect.provide(
            buildMemoryEngineLayer((req) =>
              Effect.sync(() => {
                const fileName = req.task.specText.includes("discard")
                  ? "discard-me.txt"
                  : "merged-feature.txt";
                NodeFs.writeFileSync(
                  NodePath.join(req.effectiveCwd, fileName),
                  `content for ${req.task.taskId}\n`,
                  "utf8",
                );
                return {
                  resultText: `created ${fileName}`,
                  summary: `created ${fileName}`,
                  filesModified: [fileName],
                  exitCode: 0,
                };
              }),
            ),
          ),
        );
      } finally {
        NodeFs.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.scoped),
  20_000,
);

it.live(
  "blocks risky tasks on DecisionGate, records host_audit_chain entries, and resumes cleanly after approval",
  () =>
    Effect.gen(function* () {
      const layer = buildMemoryEngineLayer(() =>
        Effect.succeed({ resultText: "executed after approval", exitCode: 0 }),
      );

      yield* Effect.gen(function* () {
        const engine = yield* WorkerEngineService;
        const sql = yield* SqlClient.SqlClient;

        const rec = yield* engine.dispatch({
          runId: "run_gate",
          threadId: "thread_gate",
          role: "worker",
          targetInstanceId: "codex",
          specText: "drop unused staging table",
          cwd: process.cwd(),
          worktreeMode: "current",
          requireApproval: true,
          approvalRiskLevel: "critical",
          approvalQuestion: "스테이징 테이블 삭제를 승인할까요?",
        });

        expect(rec.status).toBe("blocked");
        expect(rec.gateId).not.toBeNull();

        // Pre-flight blocked task must not hold an active worker slot.
        const blockedStatus = yield* engine.status({ runId: "run_gate" });
        expect(blockedStatus.activeDispatches.length).toBe(0);
        expect(blockedStatus.openGates.length).toBe(1);

        const checkGate = yield* engine.check({ runId: "run_gate" });
        expect(checkGate.messages.some((m) => m.type === "decision_gate")).toBe(true);
        if (checkGate.deliveryId) {
          yield* engine.ack({ deliveryId: checkGate.deliveryId });
        }

        const resolved = yield* engine.resolveGate({
          gateId: rec.gateId!,
          decision: "approve",
          resolution: "확인 완료, 진행 허용",
          resolvedBy: "user-test",
        });
        expect(resolved.status).toBe("approved");

        const taskAfterApprove = yield* engine.getTask(rec.taskId);
        expect(taskAfterApprove?.status).toBe("ready");

        const checkAnswer = yield* engine.check({ runId: "run_gate" });
        expect(checkAnswer.messages.some((m) => m.type === "answer")).toBe(true);
        if (checkAnswer.deliveryId) {
          yield* engine.ack({ deliveryId: checkAnswer.deliveryId });
        }

        // Approved ready task can now be dispatched cleanly with a bumped fencing token.
        const resumed = yield* engine.dispatch({
          taskId: rec.taskId,
          runId: "run_gate",
          threadId: "thread_gate",
          role: "worker",
          targetInstanceId: "codex",
          specText: "drop unused staging table",
          cwd: process.cwd(),
          worktreeMode: "current",
        });
        expect(resumed.taskId).toBe(rec.taskId);
        expect(resumed.fencingToken).toBeGreaterThan(rec.fencingToken);
        const doneAfterApprove = yield* engine.check({
          runId: "run_gate",
          wait: true,
          timeoutSec: 5,
        });
        expect(doneAfterApprove.messages.some((m) => m.type === "worker_done")).toBe(true);

        const auditRows = yield* sql<{ readonly kind: string; readonly resource: string }>`
          SELECT kind, resource FROM host_audit_chain
          WHERE resource = ${`worker_gate:${rec.gateId!}`}
          ORDER BY seq ASC
        `;
        expect(auditRows.map((r) => r.kind)).toEqual(["approval.requested", "approval.approved"]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  15_000,
);
