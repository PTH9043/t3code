// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderExecutionId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkspaceCollaborationRunId,
  WorkspaceOrchestraBlock,
  WorkspaceTaskNodeId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  WorkspaceAgentExecutionError,
  type WorkspaceAgentExecutionInput,
} from "../../orchestration/Services/WorkspaceAgentExecutor.ts";
import {
  resolveTurnDelegateTeam,
  subordinateAddress,
  type SubordinateRow,
  type SubordinateSettingsSource,
} from "../../provider/subagentSelection.ts";
import {
  buildDelegatePrompt,
  capDelegateText,
  DELEGATE_STALL_ABORT_MS,
  DELEGATE_STALL_THRESHOLD_MS,
  DELEGATE_WAIT,
  makeWorkspaceDelegate,
  matchSubordinate,
  type WorkspaceDelegateCaller,
} from "./workspaceDelegate.ts";
import type {
  PersistedDelegationRow,
  WorkspaceDelegationStore,
} from "../../persistence/WorkspaceDelegations.ts";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex_main");
const at = "2026-11-16T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const turnA = TurnId.make("turn-a");
const turnB = TurnId.make("turn-b");
const callerOf = (
  id: ThreadId,
  model = "claude-opus-5-5",
  source = settings,
): WorkspaceDelegateCaller => ({
  threadId: id,
  sessionKey: id,
  providerInstanceId: CLAUDE,
  runtimeMode: "full-access",
  delegateTeam: resolveTurnDelegateTeam(source, {
    threadId: id,
    answeringInstanceId: CLAUDE,
    forModel: model,
  }),
  activeDelegateTurnId: Effect.succeed(turnA),
});
const thread = (id: ThreadId, model = "claude-opus-5-5"): OrchestrationThreadShell => ({
  id,
  projectId: ProjectId.make("project"),
  title: "Main",
  modelSelection: { instanceId: CLAUDE, model },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
const project: OrchestrationProjectShell = {
  id: ProjectId.make("project"),
  title: "Project",
  workspaceRoot: "/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: at,
  updatedAt: at,
};
const settings: SubordinateSettingsSource = {
  globalSubordinateTeam: [
    { instanceId: CODEX, model: "gpt-6-sol", role: "worker" },
    { instanceId: CODEX, model: "gpt-6-astra", role: "advisor" },
  ],
  subordinateModels: [
    { answeringInstanceId: CLAUDE, instanceId: CODEX, model: "gpt-6-sol", role: "worker" },
    {
      answeringInstanceId: CLAUDE,
      forModel: "claude-opus-5-5",
      instanceId: CODEX,
      model: "gpt-6-astra",
      role: "advisor",
    },
    { answeringInstanceId: CODEX, instanceId: CODEX, model: "gpt-6.1-terra", role: "scout" },
  ],
  providerInstances: { codex_main: { displayName: "Codex Main" } },
  providers: { claudeAgent: {} },
};

const encodeBlock = Schema.encodeSync(Schema.fromJsonString(WorkspaceOrchestraBlock));
const caller = callerOf(threadId);
const isBlock = Schema.is(WorkspaceOrchestraBlock);

interface FakeRun {
  readonly input: WorkspaceAgentExecutionInput;
  readonly done: Deferred.Deferred<string, WorkspaceAgentExecutionError>;
  readonly stopped: Deferred.Deferred<void>;
}

const makeHarness = Effect.fn("makeHarness")(function* (options?: {
  readonly model?: string;
  readonly staleBlocks?: ReadonlyArray<{ threadId: string; createdAt: string; payload: string }>;
  readonly store?: WorkspaceDelegationStore;
  readonly stallThresholdMs?: number;
  readonly stallAbortMs?: number;
}) {
  const started = yield* Queue.unbounded<FakeRun>();
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const dispatched: Array<OrchestrationCommand> = [];
  const staleClosed = yield* Deferred.make<void>();
  const delegate = yield* makeWorkspaceDelegate({
    execute: (input) =>
      Effect.gen(function* () {
        const run: FakeRun = {
          input,
          done: yield* Deferred.make<string, WorkspaceAgentExecutionError>(),
          stopped: yield* Deferred.make<void>(),
        };
        yield* Queue.offer(started, run);
        return yield* Deferred.await(run.done).pipe(
          Effect.onInterrupt(() => Deferred.succeed(run.stopped, undefined)),
        );
      }),
    queries: {
      getThreadShellById: (id) => Effect.succeed(Option.some(thread(id, options?.model))),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getUnfinishedDelegationBlocks: () => Effect.succeed(options?.staleBlocks ?? []),
    },
    events: Stream.fromPubSub(events),
    dispatch: (command) =>
      Effect.gen(function* () {
        dispatched.push(command);
        if (command.type === "thread.message.assistant.complete")
          yield* Deferred.succeed(staleClosed, undefined);
        return { sequence: dispatched.length };
      }),
    store: options?.store,
    stallThresholdMs: options?.stallThresholdMs,
    stallAbortMs: options?.stallAbortMs,
  });
  const run = (
    to: string,
    from: WorkspaceDelegateCaller = caller,
    task = "Fix the failing test.",
  ) => delegate.invoke(from, { action: "run", to, task });
  /** Starts a run and lets the caller's wait expire, as a long task would. */
  const startLongRun = Effect.fn("startLongRun")(function* (
    to = "worker",
    from: WorkspaceDelegateCaller = caller,
    task = "Fix the failing test.",
  ) {
    const call = yield* Effect.forkChild(run(to, from, task));
    const execution = yield* Queue.take(started);
    yield* TestClock.adjust(DELEGATE_WAIT);
    const result = yield* Fiber.join(call);
    assert.strictEqual(result.status, "running");
    return { execution, delegationId: result.delegationId ?? "" };
  });
  return { delegate, started, events, dispatched, staleClosed, run, startLongRun };
});

const ownerEvent = (
  id: ThreadId,
  type: "turn.completed" | "turn.aborted",
  execution?: ProviderRuntimeEvent["execution"],
  turnId = turnA,
): ProviderRuntimeEvent => ({
  eventId: EventId.make(`${type}:${id}:${execution?.executionId ?? "owner"}`),
  provider: ProviderDriverKind.make("claudeAgent"),
  threadId: id,
  turnId,
  providerInstanceId: CLAUDE,
  createdAt: at,
  ...(execution ? { execution } : {}),
  ...(type === "turn.completed"
    ? { type, payload: { state: "completed" } }
    : { type, payload: { reason: "stopped" } }),
});

describe("workspace_delegate helpers", () => {
  const rows: ReadonlyArray<SubordinateRow> = [
    { role: "worker", account: "Codex", instanceId: CODEX, model: "gpt-6-sol" },
    { role: "worker", account: "Codex", instanceId: CODEX, model: "gpt-6-luna" },
    { role: "advisor", account: "Codex", instanceId: CODEX, model: "gpt-6-astra" },
  ];

  it("matches a subordinate by role, or by model when the role is shared", () => {
    assert.deepStrictEqual(matchSubordinate(rows, " Advisor "), { match: rows[2]! });
    assert.deepStrictEqual(matchSubordinate(rows, "GPT-6-Luna"), { match: rows[1]! });
    const shared = matchSubordinate(rows, "worker");
    assert.isTrue("error" in shared && shared.error.includes('"gpt-6-sol"'));
    assert.isTrue("error" in shared && !shared.error.includes("gpt-6-astra"));
    const unknown = matchSubordinate(rows, "scout");
    assert.isTrue("error" in unknown && unknown.error.includes('"advisor"'));
    assert.isTrue("error" in matchSubordinate([], "worker"));
  });

  it("gives each role its own instructions around the task", () => {
    const worker = buildDelegatePrompt("worker", "Rename the flag.");
    assert.include(worker, "<task>\nRename the flag.\n</task>");
    assert.notInclude(worker, "Do not edit files");
    assert.include(buildDelegatePrompt("advisor", "Review."), "Do not edit files");
    assert.include(buildDelegatePrompt("scout", "Find."), "Do not edit files");
    assert.include(worker, "cannot ask the user");
  });

  it("routes each new role by exact address and gives it distinct work", () => {
    for (const [role, guidance] of [
      ["planner", "dependencies and acceptance criteria"],
      ["tester", "report what passed, failed, and was not run"],
      ["writer", "preserve verified facts and terminology"],
      ["diagnostician", "supported causes, and untested hypotheses"],
      ["analyst", "units, missing data, and limitations"],
      ["translator", "requested target language"],
    ] as const) {
      const row = { ...rows[0]!, role };
      assert.deepStrictEqual(matchSubordinate([...rows, row], `${role}@${CODEX}:gpt-6-sol`), {
        match: row,
      });
      assert.include(buildDelegatePrompt(role, "Assigned task", "Stay in scope"), guidance);
    }
  });

  it("keeps the tail of an answer that is too long", () => {
    assert.deepStrictEqual(capDelegateText("short", 10), { text: "short", omitted: 0 });
    assert.deepStrictEqual(capDelegateText("0123456789abc", 10), {
      text: "3456789abc",
      omitted: 3,
    });
    // The cut never leaves half of a surrogate pair at the start.
    assert.deepStrictEqual(capDelegateText("ab😀cd", 3), { text: "cd", omitted: 4 });
  });
});

describe("workspace_delegate", () => {
  it.effect("dispatches only exact members of the submitted turn, including their role text", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ model: "new-parent" });
      const first = { instanceId: CODEX, model: "same", role: "worker" } as const;
      const second = { ...first, instanceId: CLAUDE, instructions: "Trace only the renderer." };
      const scope = { threadId, answeringInstanceId: CLAUDE, forModel: "old-parent" };
      const from = callerOf(threadId, scope.forModel, {
        ...settings,
        globalSubordinateTeam: [first, second],
      });
      const disabled = callerOf(threadId, scope.forModel, {
        ...settings,
        providerInstances: { [CODEX]: { enabled: false } },
      });
      assert.include((yield* harness.run("worker", disabled).pipe(Effect.flip)).message, "비활성");
      for (const target of ["same", "worker", "gpt-6-sol", "worker@other:same"]) {
        yield* harness.run(target, from).pipe(Effect.flip);
      }
      const empty = callerOf(threadId, scope.forModel, {
        ...settings,
        globalSubordinateTeam: [],
      });
      yield* harness.run("worker", empty).pipe(Effect.flip);
      yield* harness.run("worker", { ...from, delegateTeam: undefined }).pipe(Effect.flip);
      yield* harness
        .run("worker", { ...caller, activeDelegateTurnId: Effect.succeed(undefined) })
        .pipe(Effect.flip);
      assert.strictEqual(yield* Queue.size(harness.started), 0);
      const call = yield* Effect.forkChild(
        harness.run(subordinateAddress({ ...second, account: "Claude" }), from),
      );
      const execution = yield* Queue.take(harness.started);
      assert.deepStrictEqual(execution.input.modelSelection, { instanceId: CLAUDE, model: "same" });
      assert.include(execution.input.prompt, second.instructions);
      yield* Deferred.succeed(execution.done, "done");
      assert.strictEqual((yield* Fiber.join(call)).status, "completed");
    }),
  );
  it.effect("lists the subordinates of the answering model", () =>
    Effect.gen(function* () {
      const opus = yield* makeHarness();
      const status = yield* opus.delegate.invoke(caller, { action: "status" });
      assert.deepStrictEqual(status, {
        subordinates: [
          { role: "worker", account: "Codex Main", instanceId: CODEX, model: "gpt-6-sol" },
          { role: "advisor", account: "Codex Main", instanceId: CODEX, model: "gpt-6-astra" },
        ],
        status: null,
        delegationId: null,
        text: null,
        message: null,
      });
      // A different responding model gets the same global team.
      const sonnet = yield* makeHarness({ model: "claude-sonnet-5-5" });
      const other = yield* sonnet.delegate.invoke(callerOf(threadId, "claude-sonnet-5-5"), {
        action: "status",
      });
      assert.deepStrictEqual(
        other.subordinates.map((row) => row.role),
        ["worker", "advisor"],
      );
      // An account without assignments gets a normal answer, not an error.
      const none = yield* opus.delegate.invoke(
        { ...caller, providerInstanceId: ProviderInstanceId.make("grok") },
        { action: "status" },
      );
      assert.deepStrictEqual(none.subordinates, []);
      assert.include(none.message ?? "", "지정되어 있지 않습니다");
    }),
  );

  it.effect("runs the task on the subordinate and returns its answer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const call = yield* Effect.forkChild(harness.run("worker"));
      const execution = yield* Queue.take(harness.started);
      const input = execution.input;
      assert.strictEqual(input.delegatingTurnId, turnA);
      assert.strictEqual(input.execution.ownerThreadId, threadId);
      assert.strictEqual(input.execution.nodeId, "delegate-worker");
      assert.strictEqual(input.execution.attempt, 1);
      assert.deepStrictEqual(input.modelSelection, { instanceId: CODEX, model: "gpt-6-sol" });
      // The caller's own permission mode, not the thread default, and never a plan mode.
      assert.strictEqual(input.runtimeMode, "full-access");
      assert.strictEqual(input.interactionMode, "default");
      assert.strictEqual(input.cwd, "/project");
      assert.strictEqual(input.role, "implementer");
      assert.strictEqual(input.kind, "implementation");
      assert.strictEqual(input.title, "일꾼 · Codex Main · gpt-6-sol");
      assert.isUndefined(input.orchestraPhase);
      assert.include(input.prompt, "Fix the failing test.");

      yield* Deferred.succeed(execution.done, "Done: fixed.");
      const result = yield* Fiber.join(call);
      assert.strictEqual(result.status, "completed");
      assert.strictEqual(result.text, "Done: fixed.");
      assert.strictEqual(result.delegationId, input.execution.executionId);
      // Delivered once: the id is gone afterwards.
      const again = yield* harness.delegate
        .invoke(caller, { action: "wait", delegationId: result.delegationId ?? "" })
        .pipe(Effect.flip);
      assert.include(again.message, "찾을 수 없습니다");
    }),
  );

  it.effect(
    "answers running after the wait and allows the next turn in the same thread to collect it",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { execution, delegationId } = yield* harness.startLongRun();
        const status = yield* harness.delegate.invoke(caller, { action: "status" });
        assert.include(status.message ?? "", delegationId);
        // Wave 1 thread-scoped lifetime: rotating to turnB in the same thread still sees and collects it.
        const laterTurn = { ...caller, activeDelegateTurnId: Effect.succeed(turnB) };
        const laterStatus = yield* harness.delegate.invoke(laterTurn, { action: "status" });
        assert.include(laterStatus.message ?? "", delegationId);
        // Another thread still cannot reach into this one's delegation.
        const foreign = yield* harness.delegate
          .invoke(callerOf(ThreadId.make("thread-2")), { action: "wait", delegationId })
          .pipe(Effect.flip);
        assert.include(foreign.message, "찾을 수 없습니다");

        const waiting = yield* Effect.forkChild(
          harness.delegate.invoke(laterTurn, { action: "wait", delegationId }),
        );
        yield* Deferred.succeed(execution.done, "Late answer.");
        const result = yield* Fiber.join(waiting);
        assert.strictEqual(result.status, "completed");
        assert.strictEqual(result.text, "Late answer.");
      }),
  );

  it.effect("delivers a settled result once and reports an empty worker answer as failed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { execution, delegationId } = yield* harness.startLongRun();
      const wait = harness.delegate
        .invoke(caller, { action: "wait", delegationId })
        .pipe(Effect.result);
      const first = yield* Effect.forkChild(wait);
      const second = yield* Effect.forkChild(wait);
      yield* Deferred.succeed(execution.done, "   ");
      const receipts = [yield* Fiber.join(first), yield* Fiber.join(second)];
      assert.lengthOf(
        receipts.filter((result) => result._tag === "Failure"),
        1,
      );
      assert.deepInclude(receipts.find((result) => result._tag === "Success")?.success, {
        status: "failed",
        text: null,
        delegationId,
      });
    }),
  );

  it.effect("reports a failed or stopped subordinate", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const failing = yield* Effect.forkChild(harness.run("worker"));
      const first = yield* Queue.take(harness.started);
      yield* Deferred.fail(first.done, new WorkspaceAgentExecutionError({ message: "boom" }));
      const failed = yield* Fiber.join(failing);
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.message, "boom");

      // The Stop button fails the execution as interrupted.
      const stopping = yield* Effect.forkChild(harness.run("worker"));
      const second = yield* Queue.take(harness.started);
      yield* Deferred.fail(
        second.done,
        new WorkspaceAgentExecutionError({
          message: "사용자가 실행을 중단했습니다.",
          interrupted: true,
        }),
      );
      const stopped = yield* Fiber.join(stopping);
      assert.strictEqual(stopped.status, "cancelled");
    }),
  );

  it.effect("cancels a running delegation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { execution, delegationId } = yield* harness.startLongRun();
      const result = yield* harness.delegate.invoke(caller, { action: "cancel", delegationId });
      assert.strictEqual(result.status, "cancelled");
      yield* Deferred.await(execution.stopped);
      const missing = yield* harness.delegate
        .invoke(caller, { action: "cancel", delegationId })
        .pipe(Effect.flip);
      assert.include(missing.message, "찾을 수 없습니다");
    }),
  );

  it.effect("keeps delegations alive on turn.completed and stops them on turn.aborted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const other = callerOf(ThreadId.make("thread-2"));
      const kept = yield* harness.startLongRun("worker", caller, "Kept across turn.completed");
      const ended = yield* harness.startLongRun("worker", other, "Stopped on turn.aborted");
      // A subordinate finishing its own turn is not the owner's turn ending.
      yield* PubSub.publish(
        harness.events,
        ownerEvent(threadId, "turn.completed", kept.execution.input.execution),
      );
      yield* PubSub.publish(harness.events, ownerEvent(other.threadId, "turn.aborted"));
      yield* Deferred.await(ended.execution.stopped);
      assert.isFalse(yield* Deferred.isDone(kept.execution.stopped));
      const gone = yield* harness.delegate
        .invoke(other, { action: "wait", delegationId: ended.delegationId })
        .pipe(Effect.flip);
      assert.include(gone.message, "찾을 수 없습니다");

      // Wave 1: owner turn.completed keeps running delegation alive for next-turn collection.
      yield* PubSub.publish(harness.events, ownerEvent(threadId, "turn.completed"));
      yield* TestClock.adjust("1 seconds");
      assert.isFalse(yield* Deferred.isDone(kept.execution.stopped));
      yield* Deferred.succeed(kept.execution.done, "Survived turn.completed");
      const nextTurn = { ...caller, activeDelegateTurnId: Effect.succeed(turnB) };
      const collected = yield* harness.delegate.invoke(nextTurn, {
        action: "wait",
        delegationId: kept.delegationId,
      });
      assert.strictEqual(collected.status, "completed");
      assert.strictEqual(collected.text, "Survived turn.completed");
    }),
  );

  it.effect(
    "keeps the next turn's worker when a delayed turn.aborted arrives in the same room",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const next = { ...callerOf(threadId), activeDelegateTurnId: Effect.succeed(turnB) };
        const first = yield* harness.startLongRun("worker", caller, "Task A");
        const second = yield* harness.startLongRun("worker", next, "Task B");
        yield* PubSub.publish(
          harness.events,
          ownerEvent(threadId, "turn.aborted", undefined, turnA),
        );
        yield* Deferred.await(first.execution.stopped);
        yield* Deferred.succeed(second.execution.done, "Turn B finished.");
        const result = yield* harness.delegate.invoke(next, {
          action: "wait",
          delegationId: second.delegationId,
        });
        assert.strictEqual(result.text, "Turn B finished.");
      }),
  );

  it.effect("ignores foreign account exits and keeps a replacement session in the same room", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      let oldSessionActive = true;
      const old = {
        ...callerOf(threadId),
        activeDelegateTurnId: Effect.sync(() => (oldSessionActive ? turnA : undefined)),
      };
      const first = yield* harness.startLongRun("worker", old, "Old session task");
      oldSessionActive = false;
      // Even the native ID can be reused after a session replacement.
      const replacement = callerOf(threadId);
      const second = yield* harness.startLongRun("worker", replacement, "Replacement session task");
      const exit = {
        type: "session.exited",
        eventId: EventId.make("exit-old"),
        provider: ProviderDriverKind.make("claudeAgent"),
        threadId,
        createdAt: at,
        payload: { exitKind: "graceful" },
      } as const;
      const markerThread = ThreadId.make("marker");
      const marker = yield* harness.startLongRun("worker", callerOf(markerThread));
      yield* PubSub.publish(harness.events, {
        ...exit,
        providerInstanceId: ProviderInstanceId.make("other-claude"),
      });
      yield* PubSub.publish(harness.events, ownerEvent(markerThread, "turn.aborted"));
      yield* Deferred.await(marker.execution.stopped);
      assert.isFalse(yield* Deferred.isDone(first.execution.stopped));
      yield* PubSub.publish(harness.events, { ...exit, providerInstanceId: CLAUDE });
      yield* Deferred.await(first.execution.stopped);
      yield* Deferred.succeed(second.execution.done, "Replacement finished.");
      const result = yield* harness.delegate.invoke(replacement, {
        action: "wait",
        delegationId: second.delegationId,
      });
      assert.strictEqual(result.text, "Replacement finished.");
    }),
  );

  it.effect("refuses nested, unknown and excess delegations", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      // A subordinate shares the owner's thread but has its own session key.
      const nested = { ...caller, sessionKey: ThreadId.make("execution-1") };
      const refused = yield* harness.run("worker", nested).pipe(Effect.flip);
      assert.include(refused.message, "넘길 수 없습니다");
      const nestedStatus = yield* harness.delegate.invoke(nested, { action: "status" });
      assert.deepStrictEqual(nestedStatus.subordinates, []);

      const unknown = yield* harness.run("scout").pipe(Effect.flip);
      assert.include(unknown.message, '"worker"');
      const incomplete = yield* harness.delegate
        .invoke(caller, { action: "run", to: "worker" })
        .pipe(Effect.flip);
      assert.include(incomplete.message, "task");
      // Plan mode forbids changes, so the worker is out; the advisor only reads.
      const planning = { ...caller, interactionMode: "plan" as const };
      const planned = yield* harness.run("worker", planning).pipe(Effect.flip);
      assert.include(planned.message, "계획 모드");
      const review = yield* Effect.forkChild(harness.run("advisor", planning));
      const reviewing = yield* Queue.take(harness.started);
      assert.strictEqual(reviewing.input.interactionMode, "plan");
      yield* Deferred.succeed(reviewing.done, "Looks fine.");
      assert.strictEqual((yield* Fiber.join(review)).status, "completed");

      for (let index = 0; index < 6; index++)
        yield* harness.startLongRun("worker", caller, `Distinct task #${index + 1}`);
      const excess = yield* harness.run("worker", caller, "Distinct task #7").pipe(Effect.flip);
      assert.include(excess.message, "6개");
      assert.strictEqual(yield* Queue.size(harness.started), 0);
    }),
  );

  it.effect(
    "runs multiple subordinates concurrently with run_parallel and shares a batch runId",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const call = yield* Effect.forkChild(
          harness.delegate.invoke(caller, {
            action: "run_parallel",
            tasks: [
              { to: "worker", task: "Inspect module A." },
              { to: "advisor", task: "Review module B." },
            ],
          }),
        );
        const first = yield* Queue.take(harness.started);
        const second = yield* Queue.take(harness.started);
        assert.strictEqual(first.input.execution.runId, second.input.execution.runId);
        assert.notStrictEqual(first.input.execution.nodeId, second.input.execution.nodeId);
        assert.isTrue(first.input.execution.nodeId.startsWith("delegate-"));
        assert.isTrue(second.input.execution.nodeId.startsWith("delegate-"));

        yield* Deferred.succeed(second.done, "Module B reviewed.");
        yield* Deferred.succeed(first.done, "Module A done.");
        const result = yield* Fiber.join(call);
        assert.strictEqual(result.status, "completed");
        assert.lengthOf(result.results ?? [], 2);
        assert.strictEqual(result.results?.[0]?.text, "Module A done.");
        assert.strictEqual(result.results?.[1]?.text, "Module B reviewed.");
      }),
  );

  it.effect("supports non-blocking start followed by multi-id wait", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const startedA = yield* harness.delegate.invoke(caller, {
        action: "start",
        to: "worker",
        task: "Part 1",
      });
      const startedB = yield* harness.delegate.invoke(caller, {
        action: "start",
        to: "advisor",
        task: "Part 2",
      });
      assert.strictEqual(startedA.status, "running");
      assert.strictEqual(startedB.status, "running");
      const execA = yield* Queue.take(harness.started);
      const execB = yield* Queue.take(harness.started);

      const waiting = yield* Effect.forkChild(
        harness.delegate.invoke(caller, {
          action: "wait",
          delegationIds: [startedA.delegationId!, startedB.delegationId!],
        }),
      );
      yield* Deferred.succeed(execA.done, "Answer 1");
      yield* Deferred.succeed(execB.done, "Answer 2");
      const collected = yield* Fiber.join(waiting);
      assert.strictEqual(collected.status, "completed");
      assert.deepStrictEqual(
        collected.results?.map((item) => item.text),
        ["Answer 1", "Answer 2"],
      );
    }),
  );

  it.effect("closes delegation blocks a server restart left running", () => {
    const block: WorkspaceOrchestraBlock = {
      executionId: ProviderExecutionId.make("stale-execution"),
      ownerThreadId: threadId,
      runId: WorkspaceCollaborationRunId.make("stale-run"),
      nodeId: WorkspaceTaskNodeId.make("delegate-worker"),
      attempt: 1,
      messageId: MessageId.make("stale-message"),
      title: "일꾼 · Codex Main · gpt-6-sol",
      displayName: "일꾼 · Codex Main · gpt-6-sol",
      role: "implementer",
      kind: "implementation",
      modelSelection: { instanceId: CODEX, model: "gpt-6-sol" },
      status: "running",
    };
    const payload = encodeBlock(block);
    return Effect.gen(function* () {
      const harness = yield* makeHarness({
        staleBlocks: [
          { threadId, createdAt: "1969-12-31T00:00:00.000Z", payload },
          { threadId, createdAt: "1969-12-31T00:00:00.000Z", payload: "{not a block}" },
          // Started by this process: not a leftover, even if it is no longer tracked.
          { threadId, createdAt: "2999-01-01T00:00:00.000Z", payload },
        ],
      });
      yield* Deferred.await(harness.staleClosed);
      assert.deepStrictEqual(
        harness.dispatched.map((command) => command.type),
        [
          "thread.activity.append",
          "thread.message.assistant.delta",
          "thread.message.assistant.complete",
        ],
      );
      const [append, note] = harness.dispatched;
      assert.isTrue(
        append?.type === "thread.activity.append" &&
          append.threadId === threadId &&
          append.activity.id === "orchestra-block:stale-execution:1" &&
          isBlock(append.activity.payload) &&
          append.activity.payload.status === "cancelled",
      );
      assert.isTrue(
        note?.type === "thread.message.assistant.delta" && note.delta.includes("서버 재시작"),
      );
    });
  });

  it.effect(
    "supports start_parallel, deduplicates active tasks, and returns per-item partial wait results",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const started = yield* harness.delegate.invoke(caller, {
          action: "start_parallel",
          tasks: [
            { to: "worker", task: "Inspect file A" },
            { to: "advisor", task: "Review file B" },
          ],
        });
        assert.strictEqual(started.status, "running");
        assert.lengthOf(started.results ?? [], 2);
        const idA = started.results![0]!.delegationId;
        const idB = started.results![1]!.delegationId;
        const execA = yield* Queue.take(harness.started);
        const execB = yield* Queue.take(harness.started);

        // Duplicate active task joins existing delegation instead of spawning a 3rd subprocess.
        const dup = yield* harness.delegate.invoke(caller, {
          action: "start",
          to: "worker",
          task: "Inspect   file   A",
        });
        assert.strictEqual(dup.delegationId, idA);
        assert.include(dup.message ?? "", "합류");
        assert.strictEqual(yield* Queue.size(harness.started), 0);

        // Partial wait: one bogus ID mixed with live IDs does NOT fail or drop live results.
        yield* Deferred.succeed(execA.done, "Result A");
        yield* Deferred.succeed(execB.done, "Result B");
        const batch = yield* harness.delegate.invoke(caller, {
          action: "wait",
          delegationIds: [idA, "non-existent-id", idB],
        });
        assert.lengthOf(batch.results ?? [], 3);
        assert.strictEqual(batch.results![0]!.status, "completed");
        assert.strictEqual(batch.results![0]!.text, "Result A");
        assert.strictEqual(batch.results![1]!.status, "not_found");
        assert.strictEqual(batch.results![2]!.status, "completed");
        assert.strictEqual(batch.results![2]!.text, "Result B");
      }),
  );

  it.effect(
    "persists delegations, distinguishes interrupted_by_restart, and emits delegate.completed push notifications",
    () =>
      Effect.gen(function* () {
        const rows = new Map<string, PersistedDelegationRow>();
        const fakeStore: WorkspaceDelegationStore = {
          insert: (input) =>
            Effect.sync(() => {
              rows.set(input.delegationId, {
                delegationId: input.delegationId,
                threadId: input.threadId,
                ownerTurnId: input.ownerTurnId,
                answeringInstanceId: input.answeringInstanceId,
                role: input.role,
                targetInstanceId: input.targetInstanceId,
                targetModel: input.targetModel,
                taskText: input.taskText,
                taskHash: input.taskHash,
                status: "running",
                resultText: null,
                errorMessage: null,
                mandateJson: input.mandate ? JSON.stringify(input.mandate) : null,
                lastActivityAt: input.startedAt,
                lastToolSummary: null,
                startedAt: input.startedAt,
                finishedAt: null,
                deliveredAt: null,
              });
            }),
          updateActivity: (input) =>
            Effect.sync(() => {
              const existing = rows.get(input.delegationId);
              if (!existing) return;
              rows.set(input.delegationId, {
                ...existing,
                lastActivityAt: input.lastActivityAt,
                lastToolSummary: input.lastToolSummary ?? existing.lastToolSummary,
                status: input.status ?? existing.status,
              });
            }),
          settle: (input) =>
            Effect.sync(() => {
              const existing = rows.get(input.delegationId);
              if (!existing) return;
              rows.set(input.delegationId, {
                ...existing,
                status: input.status,
                resultText: input.resultText ?? existing.resultText,
                errorMessage: input.errorMessage ?? existing.errorMessage,
                finishedAt: input.finishedAt,
              });
            }),
          markDelivered: (id, deliveredAt) =>
            Effect.sync(() => {
              const existing = rows.get(id);
              if (!existing) return;
              rows.set(id, { ...existing, deliveredAt: existing.deliveredAt ?? deliveredAt });
            }),
          markInterruptedBeforeBoot: (bootedAt, finishedAt) =>
            Effect.sync(() => {
              for (const [id, row] of rows) {
                if (
                  (row.status === "running" || row.status === "stalled") &&
                  row.startedAt < bootedAt
                ) {
                  rows.set(id, {
                    ...row,
                    status: "interrupted_by_restart",
                    errorMessage: "서버 재시작으로 중단되었습니다.",
                    finishedAt,
                  });
                }
              }
            }),
          getById: (id) => Effect.succeed(rows.get(id)),
          listByThread: (tid) =>
            Effect.succeed([...rows.values()].filter((r) => r.threadId === tid)),
          findActiveDuplicate: () => Effect.succeed(undefined),
        };

        // Pre-seed a delegation interrupted by a prior server restart.
        rows.set("pre-restart-id", {
          delegationId: "pre-restart-id",
          threadId,
          ownerTurnId: turnA,
          answeringInstanceId: CLAUDE,
          role: "worker",
          targetInstanceId: CODEX,
          targetModel: "gpt-6-sol",
          taskText: "Old task",
          taskHash: "hash-old",
          status: "interrupted_by_restart",
          resultText: null,
          errorMessage: "서버 재시작으로 중단되었습니다.",
          mandateJson: null,
          lastActivityAt: "2026-11-15T00:00:00.000Z",
          lastToolSummary: null,
          startedAt: "2026-11-15T00:00:00.000Z",
          finishedAt: "2026-11-15T00:05:00.000Z",
          deliveredAt: null,
        });

        const harness = yield* makeHarness({ store: fakeStore });
        const restarted = yield* harness.delegate.invoke(caller, {
          action: "wait",
          delegationId: "pre-restart-id",
        });
        assert.strictEqual(restarted.status, "interrupted_by_restart");
        assert.include(restarted.message ?? "", "재시작");

        // Background `start` with mandate emits `delegate.completed` push notification on completion.
        const started = yield* harness.delegate.invoke(caller, {
          action: "start",
          to: "worker",
          task: "Check mandate",
          mandate: {
            allowedPaths: ["apps/server/src/mcp"],
            allowNetwork: false,
            allowDestructiveGit: false,
            maxBudgetTokens: 8000,
          },
        });
        const exec = yield* Queue.take(harness.started);
        assert.include(exec.input.prompt, "<t3_mandate>");
        assert.include(exec.input.prompt, "apps/server/src/mcp");
        yield* Deferred.succeed(exec.done, "Background completed!");
        // Allow onExit finalizer to settle and dispatch push activity.
        yield* TestClock.adjust("1 seconds");
        const pushed = harness.dispatched.find(
          (cmd) =>
            cmd.type === "thread.activity.append" && cmd.activity.kind === "delegate.completed",
        );
        assert.isDefined(pushed);
        assert.strictEqual(rows.get(started.delegationId!)?.status, "completed");
      }),
  );

  it.effect("detects stalled delegations at 5m and auto-aborts hung delegations at 15m", () =>
    Effect.gen(function* () {
      assert.strictEqual(DELEGATE_WAIT, "120 seconds");
      assert.strictEqual(DELEGATE_STALL_THRESHOLD_MS, 5 * 60_000);
      assert.strictEqual(DELEGATE_STALL_ABORT_MS, 15 * 60_000);

      const harness = yield* makeHarness();
      const started = yield* harness.delegate.invoke(caller, {
        action: "start",
        to: "worker",
        task: "Long silent run",
      });
      const exec = yield* Queue.take(harness.started);

      // Advance 6 minutes with zero subordinate events -> status & wait report `stalled`.
      yield* TestClock.adjust("6 minutes");
      const status = yield* harness.delegate.invoke(caller, { action: "status" });
      assert.include(status.message ?? "", "멈춤 의심");

      const waitCall = yield* Effect.forkChild(
        harness.delegate.invoke(caller, { action: "wait", delegationId: started.delegationId! }),
      );
      yield* TestClock.adjust(DELEGATE_WAIT);
      const waitRes = yield* Fiber.join(waitCall);
      assert.strictEqual(waitRes.status, "stalled");

      // Advance past 15 minutes total silence -> watchdog auto-interrupts the hung fiber.
      yield* TestClock.adjust("10 minutes");
      yield* Deferred.await(exec.stopped);
    }),
  );
});
