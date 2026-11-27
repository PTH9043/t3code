// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
  type SubordinateRole,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { serverSelfSignals } from "../../diagnostics/ServerSelfSignals.ts";
import {
  inferGeminiTurnPhase,
  recommendGeminiTurnThoughtLevel,
  recommendPhaseThoughtLevel,
} from "../../provider/acp/GeminiAcpSupport.ts";
import { evaluatePrematureStopGuard } from "../../provider/acp/GeminiPrematureStopGuard.ts";
import type { SubordinateRow } from "../../provider/subagentSelection.ts";
import {
  buildCriticPrompt,
  buildDelegatePrompt,
  makeWorkspaceDelegate,
  resolveDelegateMaxWallTimeMs,
  type WorkspaceDelegateCaller,
} from "./workspaceDelegate.ts";

const THREAD_ID = ThreadId.make("thread-closed-loop");
const TURN_ID = TurnId.make("turn-closed-loop-1");
const PROJECT_ID = ProjectId.make("project-closed-loop");
const ANSWERING_INSTANCE = ProviderInstanceId.make("gemini-main");

const makeMember = (role: SubordinateRole, model: string): SubordinateRow => ({
  role,
  account: `${role}-acct`,
  instanceId: ProviderInstanceId.make(`${role}-inst`),
  model,
});

const makeCaller = (
  cwd: string,
  members: ReadonlyArray<SubordinateRow>,
): WorkspaceDelegateCaller => ({
  threadId: THREAD_ID,
  sessionKey: THREAD_ID,
  providerInstanceId: ANSWERING_INSTANCE,
  runtimeMode: "full-access",
  interactionMode: "default",
  executionCwd: cwd,
  delegateTeam: {
    threadId: THREAD_ID,
    answeringInstanceId: ANSWERING_INSTANCE,
    forModel: "gemini-4-neon",
    source: "global",
    members,
  },
  activeDelegateTurnId: Effect.succeed(TURN_ID),
});

describe("T3 Closed-Loop 6-Track Integration Scenarios", () => {
  it.effect(
    "Scenario 1: start_parallel issues batchRunId and join collects partial then full settlement",
    () =>
      Effect.gen(function* () {
        const fastGate = yield* Deferred.make<string>();
        const slowGate = yield* Deferred.make<string>();
        let callIndex = 0;

        const delegate = yield* makeWorkspaceDelegate({
          execute: () => {
            callIndex += 1;
            const current = callIndex;
            return current === 1 ? Deferred.await(fastGate) : Deferred.await(slowGate);
          },
          queries: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some({
                  id: THREAD_ID,
                  projectId: PROJECT_ID,
                  worktreePath: null,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                } as never),
              ),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getUnfinishedDelegationBlocks: () => Effect.succeed([]),
          },
          events: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
        });

        const caller = makeCaller(process.cwd(), [
          makeMember("scout", "model-a"),
          makeMember("tester", "model-b"),
        ]);

        const started = yield* delegate.invoke(caller, {
          action: "start_parallel",
          tasks: [
            { to: "scout", task: "Inspect module A" },
            { to: "tester", task: "Run scoped check B" },
          ],
        });

        assert.isDefined(started.batchRunId);
        assert.strictEqual(started.allSettled, false);
        assert.lengthOf(started.unresolvedIds ?? [], 2);

        yield* Deferred.succeed(fastGate, "Scout A findings");
        yield* Deferred.succeed(slowGate, "Tester B passed");

        const joined = yield* delegate.invoke(caller, {
          action: "join",
          batchRunId: started.batchRunId!,
          waitTimeoutSec: 10,
        });

        assert.strictEqual(joined.allSettled, true);
        assert.strictEqual(joined.status, "completed");
        assert.strictEqual(joined.counts?.total, 2);
        assert.strictEqual(joined.counts?.completed, 2);
        assert.lengthOf(joined.unresolvedIds ?? [], 0);
      }),
  );

  it.live(
    "Scenario 2: hard exit limits (max_wall_time + max_idle) emit delegation.limit.hit and increment telemetry",
    () =>
      Effect.gen(function* () {
        const dispatched: OrchestrationCommand[] = [];
        const beforeHits = serverSelfSignals.readDelegationCounters().delegationLimitsHit;
        const neverFinishes = yield* Deferred.make<string>();

        const delegate = yield* makeWorkspaceDelegate({
          execute: () => Deferred.await(neverFinishes),
          queries: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some({
                  id: THREAD_ID,
                  projectId: PROJECT_ID,
                  worktreePath: null,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                } as never),
              ),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getUnfinishedDelegationBlocks: () => Effect.succeed([]),
          },
          events: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
          dispatch: (cmd) =>
            Effect.sync(() => {
              dispatched.push(cmd);
              return { sequence: dispatched.length };
            }),
          maxWallTimeMs: 40,
          maxIdleMs: 5_000,
          sweepInterval: "20 millis",
        });

        const caller = makeCaller(process.cwd(), [makeMember("scout", "model-fast")]);
        const started = yield* delegate.invoke(caller, {
          action: "start",
          to: "scout",
          task: "Long stuck scout",
        });

        assert.isNotNull(started.delegationId);
        // Wait briefly for the 20ms watchdog sweep to trigger max_wall_time at 40ms.
        yield* Effect.sleep("120 millis");

        const collected = yield* delegate.invoke(caller, {
          action: "join",
          delegationIds: [started.delegationId!],
          waitTimeoutSec: 10,
        });

        assert.strictEqual(collected.status, "limit_exceeded");
        assert.strictEqual(collected.counts?.limitExceeded, 1);
        assert.strictEqual(collected.results?.[0]?.limitReason, "max_wall_time");
        assert.isAbove(serverSelfSignals.readDelegationCounters().delegationLimitsHit, beforeHits);
        assert.isTrue(
          dispatched.some(
            (cmd) =>
              cmd.type === "thread.activity.append" && cmd.activity.kind === "delegation.limit.hit",
          ),
        );
      }),
  );

  it.effect("Scenario 3: deduplication joins live identical task and increments counter", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<string>();
      let spawns = 0;
      const beforeDedup = serverSelfSignals.readDelegationCounters().delegationsDeduplicated;

      const delegate = yield* makeWorkspaceDelegate({
        execute: () => {
          spawns += 1;
          return Deferred.await(gate);
        },
        queries: {
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                id: THREAD_ID,
                projectId: PROJECT_ID,
                worktreePath: null,
                runtimeMode: "full-access",
                interactionMode: "default",
              } as never),
            ),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getUnfinishedDelegationBlocks: () => Effect.succeed([]),
        },
        events: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
      });

      const caller = makeCaller(process.cwd(), [makeMember("worker", "model-w")]);
      const first = yield* delegate.invoke(caller, {
        action: "start",
        to: "worker",
        task: "Implement feature X",
      });
      const second = yield* delegate.invoke(caller, {
        action: "start",
        to: "worker",
        task: "  implement   feature x ",
      });

      assert.strictEqual(spawns, 1);
      assert.strictEqual(first.delegationId, second.delegationId);
      assert.isAbove(
        serverSelfSignals.readDelegationCounters().delegationsDeduplicated,
        beforeDedup,
      );

      yield* Deferred.succeed(gate, "done");
      yield* delegate.invoke(caller, { action: "wait", delegationId: first.delegationId! });
    }),
  );

  it("Scenario 4: role separation and isolated independent critic rubric", () => {
    assert.strictEqual(resolveDelegateMaxWallTimeMs("scout"), 5 * 60_000);
    assert.strictEqual(resolveDelegateMaxWallTimeMs("tester"), 5 * 60_000);
    assert.strictEqual(resolveDelegateMaxWallTimeMs("worker"), 20 * 60_000);
    assert.strictEqual(resolveDelegateMaxWallTimeMs("advisor"), 10 * 60_000);

    const testerPrompt = buildDelegatePrompt("tester", "Run vitest");
    assert.include(testerPrompt, "mechanical tester");
    assert.include(testerPrompt, "Do NOT issue final architectural approval");

    const criticPrompt = buildCriticPrompt({
      task: "I think everything works fine.",
      criticContext: {
        pinnedSpec: "All tests must exit 0 and zero files outside src/ modified.",
        deterministicEvidence: "exitCode=0, 12/12 passed",
        checklist: ["Check race conditions", "Verify error paths"],
      },
    });
    assert.include(criticPrompt, "<independent_rubric>");
    assert.include(criticPrompt, "<author_report_untrusted>");
    assert.include(criticPrompt, "VERDICT: CONFIRM");
    assert.include(criticPrompt, "VERDICT: UNVERIFIED_ERROR");
    assert.include(criticPrompt, "Check race conditions");
    assert.notInclude(criticPrompt, "Security Audit Profile");

    // Wave 4 opt-in Security Audit rubric: only injected when explicitly requested
    const secCriticPrompt = buildCriticPrompt({
      task: "Added file download endpoint.",
      criticContext: {
        auditProfile: "security",
      },
    });
    assert.include(secCriticPrompt, "Security Audit Profile");
    assert.include(secCriticPrompt, ".agents/skills/security-audit");
  });

  it.effect(
    "Scenario 4b (Wave 1 & 3): worktreeIsolation allocates isolated worker worktree and CCR stores truncated output losslessly",
    () =>
      Effect.gen(function* () {
        const { makeCcrToolOutputStore } = yield* Effect.promise(() => import("./workspaceCcr.ts"));
        const ccrStore = makeCcrToolOutputStore();
        const seenCwds: string[] = [];
        const seenPrompts: string[] = [];
        const provisionedBranches: string[] = [];
        const longOutput = `HEAD_MARKER_UNIQUE_42\n${"x".repeat(26_000)}\nTAIL_MARKER_99`;

        const delegate = yield* makeWorkspaceDelegate({
          execute: (input) =>
            Effect.sync(() => {
              seenCwds.push(input.cwd);
              seenPrompts.push(input.prompt);
              return longOutput;
            }),
          queries: {
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
              Effect.succeed(Option.some({ id: PROJECT_ID, workspaceRoot: "/repo" } as never)),
            getUnfinishedDelegationBlocks: () => Effect.succeed([]),
          },
          events: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
          ccrStore,
          worktreeProvision: {
            provision: (req) => {
              provisionedBranches.push(req.branch ?? "");
              return Effect.succeed({
                worktreePath: `/worktrees/${req.branch}`,
                refName: req.branch ?? "t3code/delegate-test",
                reused: false,
              });
            },
            runSetupGate: () => Effect.succeed({ status: "ok" as const }),
          },
        });

        const caller = makeCaller("/repo", [
          makeMember("worker", "model-w"),
          makeMember("scout", "model-s"),
        ]);

        // Read-only scout MUST reject worktreeIsolation
        const scoutExit = yield* Effect.exit(
          delegate.invoke(caller, {
            action: "run",
            to: "scout",
            task: "Inspect files",
            worktreeIsolation: true,
          }),
        );
        assert.isTrue(scoutExit._tag === "Failure");

        // Write worker with worktreeIsolation provisions isolated worktree + stores long output in CCR
        const res = yield* delegate.invoke(caller, {
          action: "run",
          to: "worker",
          task: "Implement feature",
          worktreeIsolation: true,
        });
        assert.strictEqual(res.status, "completed");
        assert.isTrue(res.worktreeBranch?.startsWith("t3code/delegate-") ?? false);
        assert.strictEqual(seenCwds[0], res.worktreePath);
        assert.include(seenPrompts[0]!, "<t3_worktree_isolation>");
        assert.include(res.message ?? "", "CCR outputHash=ccr_");

        const hashMatch = (res.message ?? "").match(/outputHash=(ccr_[0-9a-f]+)/);
        assert.isNotNull(hashMatch);
        const recovered = yield* ccrStore.retrieve({
          threadId: THREAD_ID,
          request: { outputHash: hashMatch![1]!, sliceStart: 0, sliceLength: 256 },
        });
        assert.isTrue(recovered.found);
        assert.include(recovered.content, "HEAD_MARKER_UNIQUE_42");
      }),
  );

  it.effect(
    "Scenario 5: action=verify runs deterministic verifier returning CONFIRM / REJECT / UNVERIFIED_ERROR",
    () =>
      Effect.gen(function* () {
        const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-verify-action-"));
        try {
          const delegate = yield* makeWorkspaceDelegate({
            execute: () => Effect.succeed("unused"),
            queries: {
              getThreadShellById: () =>
                Effect.succeed(
                  Option.some({
                    id: THREAD_ID,
                    projectId: PROJECT_ID,
                    worktreePath: tmpDir,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                  } as never),
                ),
              getProjectShellById: () => Effect.succeed(Option.none()),
              getUnfinishedDelegationBlocks: () => Effect.succeed([]),
            },
            events: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
          });

          const caller = makeCaller(tmpDir, [makeMember("tester", "model-t")]);

          const passRes = yield* delegate.invoke(caller, {
            action: "verify",
            verifySpec: {
              command: process.execPath,
              args: ["-e", "console.log('ok')"],
              timeoutMs: 10_000,
            },
          });
          assert.strictEqual(passRes.verifierOutcome?.verdict, "CONFIRM");
          assert.strictEqual(passRes.verifierOutcome?.passed, true);
          assert.strictEqual(passRes.verifierOutcome?.exitCode, 0);

          const failRes = yield* delegate.invoke(caller, {
            action: "verify",
            verifySpec: {
              command: process.execPath,
              args: ["-e", "console.error('boom'); process.exit(1)"],
              timeoutMs: 10_000,
            },
          });
          assert.strictEqual(failRes.verifierOutcome?.verdict, "REJECT");
          assert.strictEqual(failRes.verifierOutcome?.passed, false);
          assert.strictEqual(failRes.verifierOutcome?.exitCode, 1);

          const traversalRes = yield* delegate.invoke(caller, {
            action: "verify",
            verifySpec: {
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
              cwdRelative: "../../outside-workspace",
              timeoutMs: 10_000,
            },
          });
          assert.strictEqual(traversalRes.verifierOutcome?.verdict, "UNVERIFIED_ERROR");
          assert.strictEqual(traversalRes.verifierOutcome?.passed, false);
        } finally {
          NodeFS.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
  );

  it("Scenario 6: phase-bound thinking_level (xhigh) and structured-first premature stop guard with telemetry", () => {
    assert.strictEqual(
      inferGeminiTurnPhase({
        prompt: "## 현재 사용자 작업\n변경 사항 최종 감사 및 보안 검토해 줘",
      }),
      "final_audit",
    );
    assert.strictEqual(
      recommendPhaseThoughtLevel("final_audit", ["low", "medium", "high", "xhigh"]),
      "xhigh",
    );
    assert.strictEqual(
      recommendPhaseThoughtLevel("final_audit", ["low", "medium", "high"]),
      "high",
    );
    assert.strictEqual(
      recommendGeminiTurnThoughtLevel("standard-dev", {
        interactionMode: "plan",
        prompt: "설계해 줘",
      }),
      "high",
    );

    // Structured activeDelegationCount takes priority over regex promise_pattern.
    const delegationStop = evaluatePrematureStopGuard({
      assistantText: "작업이 진행 중입니다. 완료되면 알려드리겠습니다.",
      planStatuses: ["in_progress"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
      activeDelegationCount: 2,
    });
    assert.strictEqual(delegationStop.shouldContinue, true);
    assert.strictEqual(delegationStop.reason, "active_delegation");
    assert.strictEqual(delegationStop.telemetry.signalSource, "structured");
    assert.strictEqual(delegationStop.telemetry.fallbackUsed, false);

    // Structured incomplete_plan takes priority over regex promise_pattern.
    const planStop = evaluatePrematureStopGuard({
      assistantText: "진행 중입니다. 완료되면 보고하겠습니다.",
      planStatuses: ["pending"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });
    assert.strictEqual(planStop.shouldContinue, true);
    assert.strictEqual(planStop.reason, "incomplete_plan");
    assert.strictEqual(planStop.telemetry.signalSource, "structured");

    // Clean stop records allow_stop telemetry.
    const cleanStop = evaluatePrematureStopGuard({
      assistantText: "모든 수정과 테스트(12/12)를 완료했습니다.",
      planStatuses: ["completed"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });
    assert.strictEqual(cleanStop.shouldContinue, false);
    assert.strictEqual(cleanStop.telemetry.decision, "allow_stop");
  });
});

// Keep EventId referenced only if needed by type imports.
void EventId;
