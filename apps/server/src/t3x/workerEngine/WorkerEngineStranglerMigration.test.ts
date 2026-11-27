// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import { execFileSync } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WORKER_ENGINE_MAX_WAIT_SECONDS,
  WORKER_MAX_RUNNING_PER_THREAD,
  type ProviderRuntimeEvent,
  type SubordinateRole,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  DELEGATE_MAX_RUNNING,
  DELEGATE_WAIT,
  makeWorkspaceDelegate,
  type WorkspaceDelegateCaller,
} from "../../mcp/toolkits/workspaceDelegate.ts";
import { CouncilOrchestratorLive } from "../../orchestration/council/CouncilOrchestratorLive.ts";
import { CouncilOrchestratorService } from "../../orchestration/council/CouncilOrchestrator.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutionError,
  WorkspaceAgentExecutor,
} from "../../orchestration/Services/WorkspaceAgentExecutor.ts";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import type { SubordinateRow } from "../../provider/subagentSelection.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkerEngineService, makeWorkerEngineServiceLayer } from "./WorkerEngineService.ts";

const THREAD_ID = ThreadId.make("thread-stage3-migration");
const TURN_ID = TurnId.make("turn-stage3-1");
const PROJECT_ID = ProjectId.make("project-stage3");
const ANSWERING = ProviderInstanceId.make("claudeAgent");

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
  git(["config", "user.name", "T3 Stage3 Test"]);
  git(["config", "user.email", "t3-stage3@local"]);
  NodeFs.writeFileSync(NodePath.join(dir, "README.md"), "# stage3\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);
}

function makeMember(role: SubordinateRole, model: string): SubordinateRow {
  return {
    role,
    account: `${role}-acct`,
    instanceId: ProviderInstanceId.make(`${role}_inst`),
    model,
  };
}

function makeCaller(cwd: string, members: ReadonlyArray<SubordinateRow>): WorkspaceDelegateCaller {
  return {
    threadId: THREAD_ID,
    sessionKey: THREAD_ID,
    providerInstanceId: ANSWERING,
    runtimeMode: "full-access",
    interactionMode: "default",
    executionCwd: cwd,
    delegateTeam: {
      threadId: THREAD_ID,
      answeringInstanceId: ANSWERING,
      forModel: "claude-opus-5-5",
      source: "global",
      members,
    },
    activeDelegateTurnId: Effect.succeed(TURN_ID),
  };
}

it.live(
  "Stage 3.1 & 3.2: routes workspace_delegate (tester pilot + all roles + built-in worktree + cancel + restart recovery) through WorkerEngineService",
  () =>
    Effect.gen(function* () {
      expect(DELEGATE_WAIT).toBe(`${WORKER_ENGINE_MAX_WAIT_SECONDS} seconds`);
      expect(DELEGATE_MAX_RUNNING).toBe(WORKER_MAX_RUNNING_PER_THREAD);

      const tempDir = makeTempDir("t3-stage3-delegate-");
      const repoDir = NodePath.join(tempDir, "repo");
      NodeFs.mkdirSync(repoDir, { recursive: true });
      initTempGitRepo(repoDir);
      const dbPath = NodePath.join(tempDir, "state.sqlite");

      try {
        const members: SubordinateRow[] = [
          makeMember("tester", "gpt-5.4-mini"),
          makeMember("scout", "gpt-5.4-mini"),
          makeMember("worker", "gpt-5.4"),
        ];
        const caller = makeCaller(repoDir, members);

        const queries = {
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                id: THREAD_ID,
                projectId: PROJECT_ID,
                branch: "main",
                worktreePath: null,
                runtimeMode: "full-access",
                interactionMode: "default",
              } as never),
            ),
          getProjectShellById: () =>
            Effect.succeed(Option.some({ id: PROJECT_ID, workspaceRoot: repoDir } as never)),
          getUnfinishedDelegationBlocks: () => Effect.succeed([]),
        };

        // --- Incarnation 1 ---
        const scope1 = yield* Scope.make();
        const sqlite1 = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
        const engineLayer1 = makeWorkerEngineServiceLayer({
          heartbeat: { startBackgroundFiber: false },
          reconcileOnBoot: true,
        }).pipe(Layer.provideMerge(sqlite1));
        const ctx1 = yield* Layer.buildWithScope(engineLayer1, scope1);
        const workerEngine1 = yield* WorkerEngineService.pipe(Effect.provide(ctx1));

        const hangStarted = yield* Deferred.make<void>();
        const hangGate = yield* Deferred.make<string, WorkspaceAgentExecutionError>();
        const cancelGate = yield* Deferred.make<string, WorkspaceAgentExecutionError>();

        const delegate1 = yield* makeWorkspaceDelegate({
          execute: (input) =>
            Effect.gen(function* () {
              if (input.instruction?.includes("hang-before-restart")) {
                yield* Deferred.succeed(hangStarted, undefined);
                return yield* Deferred.await(hangGate);
              }
              if (input.instruction?.includes("cancel-me")) {
                return yield* Deferred.await(cancelGate);
              }
              if (input.instruction?.includes("write-in-worktree")) {
                NodeFs.writeFileSync(
                  NodePath.join(input.cwd, "stage3-feature.txt"),
                  "written via WorkerEngine worktree\n",
                  "utf8",
                );
                return "created stage3-feature.txt";
              }
              return `ok:${input.role}:${input.instruction ?? ""}`;
            }),
          queries,
          events: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
          workerEngine: workerEngine1,
        }).pipe(Effect.provideService(Scope.Scope, scope1));

        // 1. Step 3.1 tester pilot via WorkerEngine
        const testerRes = yield* delegate1.invoke(caller, {
          action: "run",
          to: "tester",
          task: "run scoped unit checks",
        });
        expect(testerRes.status).toBe("completed");
        expect(testerRes.text).toContain("ok:verifier");
        const testerTask = yield* workerEngine1.getTask(testerRes.delegationId!);
        expect(testerTask?.callerKind).toBe("t3_supervisor");
        expect(testerTask?.role).toBe("tester");
        expect(testerTask?.status).toBe("completed");

        // 2. Step 3.2 worker with built-in WorkerEngine worktreeIsolation (no WorktreeProvisionService needed!)
        const wtRes = yield* delegate1.invoke(caller, {
          action: "run",
          to: "worker",
          task: "write-in-worktree",
          worktreeIsolation: true,
        });
        expect(wtRes.status).toBe("completed");
        expect(wtRes.worktreePath).not.toBeNull();
        expect(NodeFs.existsSync(wtRes.worktreePath!)).toBe(true);
        const diff = yield* workerEngine1.inspectWorktreeDiff(wtRes.delegationId!);
        expect(diff.filesModified).toContain("stage3-feature.txt");
        const merged = yield* workerEngine1.mergeWorktree(wtRes.delegationId!);
        expect(merged.worktreeState).toBe("merged");
        expect(NodeFs.existsSync(NodePath.join(repoDir, "stage3-feature.txt"))).toBe(true);

        // 3. Cancel propagates to WorkerEngine dispatch status
        const cancelStarted = yield* delegate1.invoke(caller, {
          action: "start",
          to: "scout",
          task: "cancel-me",
        });
        const cancelRes = yield* delegate1.invoke(caller, {
          action: "cancel",
          delegationId: cancelStarted.delegationId!,
        });
        expect(cancelRes.status).toBe("cancelled");
        const cancelledDisp = yield* workerEngine1.getDispatch(cancelStarted.delegationId!);
        expect(cancelledDisp?.status).toBe("cancelled");

        // 4. Seed two tasks before simulated server restart:
        //    (a) completed-uncollected (`start` finishes quickly, caller doesn't `wait` before restart)
        //    (b) hanging (`start` stays running when scope closes)
        const uncollectedStart = yield* delegate1.invoke(caller, {
          action: "start",
          to: "scout",
          task: "finish-before-restart",
        });
        // Give the fast scout fiber a moment to settle in WorkerEngine SQLite.
        yield* Effect.sleep("80 millis");

        const hangingStart = yield* delegate1.invoke(caller, {
          action: "start",
          to: "scout",
          task: "hang-before-restart",
        });
        yield* Deferred.await(hangStarted);

        // Simulate abrupt crash by closing scope1 WITHOUT stopping hangingStart cleanly via cancel.
        // Note: WorkerEngineService finalizer interrupts fibers, so mark the DB row active again or
        // verify completed-uncollected survives and hanging is cleanly settled.
        yield* Scope.close(scope1, Exit.void);

        // --- Incarnation 2 against the same SQLite DB ---
        const scope2 = yield* Scope.make();
        const sqlite2 = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
        const engineLayer2 = makeWorkerEngineServiceLayer({
          heartbeat: { startBackgroundFiber: false },
          reconcileOnBoot: true,
        }).pipe(Layer.provideMerge(sqlite2));
        const ctx2 = yield* Layer.buildWithScope(engineLayer2, scope2);
        const workerEngine2 = yield* WorkerEngineService.pipe(Effect.provide(ctx2));

        const delegate2 = yield* makeWorkspaceDelegate({
          execute: () => Effect.succeed("unused"),
          queries,
          events: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
          workerEngine: workerEngine2,
        }).pipe(Effect.provideService(Scope.Scope, scope2));

        // Uncollected completed delegation is recovered once from WorkerEngine mailbox!
        const recovered = yield* delegate2.invoke(caller, {
          action: "wait",
          delegationId: uncollectedStart.delegationId!,
        });
        expect(recovered.status).toBe("completed");
        expect(recovered.text).toContain("finish-before-restart");

        // Second wait on the already-acked ID must NOT replay duplicates.
        const secondWaitExit = yield* Effect.exit(
          delegate2.invoke(caller, {
            action: "wait",
            delegationId: uncollectedStart.delegationId!,
          }),
        );
        expect(Exit.isFailure(secondWaitExit)).toBe(true);

        // Hanging delegation was reconciled to interrupted_by_restart or cancelled on shutdown.
        const hangingDisp = yield* workerEngine2.getDispatch(hangingStart.delegationId!);
        expect(["interrupted_by_restart", "cancelled", "failed"]).toContain(hangingDisp?.status);

        yield* Scope.close(scope2, Exit.void);
      } finally {
        try {
          NodeFs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch {
          // Windows SQLite WAL handle release may lag briefly during temp dir cleanup.
        }
      }
    }),
  20_000,
);

it.live(
  "Stage 3.3: CouncilOrchestratorLive routes seat turns through WorkerEngineService with callerKind='council' and clean mailbox ack",
  () =>
    Effect.gen(function* () {
      const tmpDir = makeTempDir("t3-stage3-council-");
      try {
        NodeFs.mkdirSync(NodePath.join(tmpDir, "src"), { recursive: true });
        NodeFs.writeFileSync(
          NodePath.join(tmpDir, "src/app.ts"),
          "export const answer = 42;\n",
          "utf8",
        );

        const chairInst = ProviderInstanceId.make("codex_chair");
        const redInst = ProviderInstanceId.make("claude_red");

        const mockSettingsLayer = Layer.succeed(ServerSettingsService, {
          getSettings: Effect.succeed({
            globalSubordinateTeam: [
              { instanceId: redInst, model: "claude-sonnet-5-5", role: "advisor" },
            ],
            subordinateModels: [],
            providerInstances: {},
            providers: {},
          } as never),
        } as never);

        const mockProvidersLayer = Layer.succeed(ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: chairInst,
              driver: ProviderDriverKind.make("codex"),
              displayName: "Codex Chair",
              enabled: true,
              installed: true,
              status: "ready",
              auth: { status: "authenticated" },
              models: [{ slug: "gpt-5.4", isDefault: true, isLegacy: false }],
            },
            {
              instanceId: redInst,
              driver: ProviderDriverKind.make("claudeAgent"),
              displayName: "Claude Red",
              enabled: true,
              installed: true,
              status: "ready",
              auth: { status: "authenticated" },
              models: [{ slug: "claude-sonnet-5-5", isDefault: true, isLegacy: false }],
            },
          ] as never),
        } as never);

        const mockSnapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
          getShellSnapshot: () =>
            Effect.succeed({
              projects: [{ id: PROJECT_ID, title: "Stage3", workspaceRoot: tmpDir }],
              threads: [
                {
                  id: THREAD_ID,
                  projectId: PROJECT_ID,
                  title: "Council Thread",
                  modelSelection: { instanceId: chairInst, model: "gpt-5.4" },
                  worktreePath: null,
                },
              ],
            } as never),
        } as never);

        const mockExecutorLayer = Layer.succeed(WorkspaceAgentExecutor, {
          execute: (input: { readonly displayName?: string; readonly prompt?: string }) => {
            const prompt = input.prompt ?? "";
            if (prompt.includes("t3_council_synthesis")) {
              return Effect.succeed(
                `<t3_council_synthesis>${JSON.stringify({
                  titleKo: "answer 업데이트",
                  executiveSummaryKo: "src/app.ts의 answer를 갱신합니다.",
                  agreedItems: [{ summaryKo: "answer 검토 합의", supportingClaimIds: [] }],
                  disagreements: [],
                  uniqueInsights: [],
                  targetFiles: ["src/app.ts"],
                  acceptanceCommands: ["node -e process.exit(0)"],
                })}</t3_council_synthesis>`,
              );
            }
            if (prompt.includes("Proposal-1")) {
              return Effect.succeed(
                `<t3_council_critique>${JSON.stringify({
                  claimKind: "REBUTTAL_DEFENSE",
                  severity: null,
                  targetClaimId: null,
                  responseTaxonomy: "NEW_EVIDENCE_ADDED",
                  statementKo: `비평(${input.displayName ?? "seat"})`,
                  proposedDiffSketch: "update answer cleanly",
                  evidence: [
                    { filePath: "src/app.ts", startLine: 1, endLine: 1, astSymbol: "answer" },
                  ],
                })}</t3_council_critique>`,
              );
            }
            return Effect.succeed(
              `<t3_council_proposal>${JSON.stringify({
                claimKind: "PATCH_PROPOSAL",
                severity: "P1",
                statementKo: `제안(${input.displayName ?? "seat"})`,
                proposedDiffSketch: "update answer",
                evidence: [
                  { filePath: "src/app.ts", startLine: 1, endLine: 1, astSymbol: "answer" },
                ],
                acceptanceCommands: ["node -e process.exit(0)"],
              })}</t3_council_proposal>`,
            );
          },
        } as never);

        const workerEngineLayer = makeWorkerEngineServiceLayer({
          heartbeat: { startBackgroundFiber: false },
          reconcileOnBoot: false,
        });

        const fullLayer = CouncilOrchestratorLive.pipe(
          Layer.provideMerge(workerEngineLayer),
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(mockSettingsLayer),
          Layer.provide(mockProvidersLayer),
          Layer.provide(mockSnapshotLayer),
          Layer.provide(mockExecutorLayer),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const council = yield* CouncilOrchestratorService;
          const workerEngine = yield* WorkerEngineService;

          const started = yield* council.startAutoSeat({
            threadId: THREAD_ID,
            projectId: PROJECT_ID,
            userPrompt: "src/app.ts answer 상수를 검토하고 개선안을 도출해줘",
            forceCouncil: true,
          });
          expect(started.councilId).toBeTruthy();

          const settled = yield* council.awaitCouncil(started.councilId);
          expect(settled).not.toBeNull();

          const status = yield* workerEngine.status({ runId: started.councilId });
          expect(status.tasks.length).toBeGreaterThanOrEqual(2);
          expect(status.tasks.every((t) => t.callerKind === "council")).toBe(true);
          expect(status.tasks.every((t) => t.status === "completed")).toBe(true);
          expect(status.unreadMailboxCount).toBe(0);
        }).pipe(Effect.provide(fullLayer));
      } finally {
        try {
          NodeFs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch {
          // Best-effort temp cleanup.
        }
      }
    }).pipe(Effect.scoped),
  20_000,
);

it.live(
  "Stage 3.4: WorkerEngineService.runAndCollect records orchestra callerKind, externalWorktree metadata, and cancels cleanly on interrupt",
  () =>
    Effect.gen(function* () {
      const layer = makeWorkerEngineServiceLayer({
        heartbeat: { startBackgroundFiber: false },
        reconcileOnBoot: false,
      }).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provide(NodeServices.layer));

      yield* Effect.gen(function* () {
        const workerEngine = yield* WorkerEngineService;

        // 1. Successful orchestra node execution with externalWorktree metadata.
        const okRes = yield* workerEngine.runAndCollect(
          {
            runId: "orch_run_1",
            threadId: THREAD_ID,
            callerKind: "orchestra",
            role: "implementer",
            targetInstanceId: "codex",
            targetModel: "gpt-5.4",
            specText: "orchestra node task",
            cwd: process.cwd(),
            worktreeMode: "isolated",
          },
          {
            dispatchId: "orch_exec_1",
            allowDuplicate: true,
            maxRunningPerThread: 32,
            skipLedger: true,
            externalWorktree: {
              worktreePath: "/virtual/orchestra/wt-1",
              worktreeBranch: "t3code/orch-1",
            },
            runner: () =>
              Effect.succeed({
                resultText: "orchestra node done",
                summary: "done",
                exitCode: 0,
              }),
          },
        );
        expect(okRes.resultText).toBe("orchestra node done");
        expect(okRes.worktreePath).toBe("/virtual/orchestra/wt-1");
        expect(okRes.worktreeBranch).toBe("t3code/orch-1");
        const okTask = yield* workerEngine.getTask(okRes.taskId);
        expect(okTask?.callerKind).toBe("orchestra");
        expect(okTask?.status).toBe("completed");

        // 2. Interrupting the caller fiber cleanly cancels the WorkerEngine dispatch.
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const runningFiber = yield* Effect.forkChild(
          workerEngine.runAndCollect(
            {
              runId: "orch_run_1",
              threadId: THREAD_ID,
              callerKind: "orchestra",
              role: "implementer",
              targetInstanceId: "codex",
              targetModel: "gpt-5.4",
              specText: "orchestra interruptible node",
              cwd: process.cwd(),
              worktreeMode: "current",
            },
            {
              dispatchId: "orch_exec_interrupt",
              allowDuplicate: true,
              maxRunningPerThread: 32,
              skipLedger: true,
              runner: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as({ resultText: "never", exitCode: 0 }),
                ),
            },
          ),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(runningFiber);

        const cancelledDisp = yield* workerEngine.getDispatch("orch_exec_interrupt");
        expect(cancelledDisp?.status).toBe("cancelled");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  15_000,
);
