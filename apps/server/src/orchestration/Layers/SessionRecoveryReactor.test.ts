import {
  EventId,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkspaceCollaborationRunId,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type WorkspaceCollaborationRun,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivity,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { SessionRecoveryReactor } from "../Services/SessionRecoveryReactor.ts";
import { SessionRecoveryReactorLive } from "./SessionRecoveryReactor.ts";

const at = "2026-08-17T00:00:00.000Z";
const projectId = ProjectId.make("workspace-r");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude-a"),
  model: "claude-fable",
};

function session(input: {
  readonly threadId: ThreadId;
  readonly status: OrchestrationSession["status"];
  readonly activeTurnId?: TurnId | null;
}): OrchestrationSession {
  return {
    threadId: input.threadId,
    status: input.status,
    providerName: "claude",
    runtimeMode: "full-access",
    activeTurnId: input.activeTurnId ?? null,
    lastError: null,
    updatedAt: at,
  } as OrchestrationSession;
}

function threadShell(input: {
  readonly id: string;
  readonly session: OrchestrationSession | null;
  readonly hasPendingUserInput?: boolean;
}): OrchestrationThreadShell {
  return {
    id: ThreadId.make(input.id),
    projectId,
    title: input.id,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: input.session,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
  } as OrchestrationThreadShell;
}

function activity(input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt?: string;
}): ProjectionThreadActivity {
  return {
    activityId: EventId.make(input.id),
    threadId: input.threadId,
    turnId: null,
    tone: "info",
    kind: input.kind,
    summary: input.kind,
    payload: input.payload,
    createdAt: input.createdAt ?? at,
  };
}

function recoveryMessage(input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly createdAt: string;
}): ProjectionThreadMessage {
  return {
    messageId: MessageId.make(input.id),
    threadId: input.threadId,
    turnId: null,
    role: "user",
    text: "[자동 복구] 서버가 재시작되면서 직전 턴이 중단되었습니다.",
    isStreaming: false,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function makeHarness(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly resumableRuns?: ReadonlyArray<WorkspaceCollaborationRun>;
  readonly activities?: ReadonlyArray<ProjectionThreadActivity>;
  readonly messages?: ReadonlyArray<ProjectionThreadMessage>;
}) {
  return Effect.gen(function* () {
    const dispatchedRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    let sequence = 0;
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(dispatchedRef, (current) => [...current, command]).pipe(
          Effect.map(() => ({ sequence: ++sequence })),
        ),
    } as unknown as OrchestrationEngineShape;
    const query = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [],
          threads: input.threads,
          updatedAt: at,
        }),
    } as unknown as ProjectionSnapshotQueryShape;
    const repository = {
      listResumable: () => Effect.succeed(input.resumableRuns ?? []),
    } as unknown as ProjectionWorkspaceCollaborationRunRepository["Service"];
    const activityRepository = {
      listByThreadIdAndKinds: ({ threadId }: { readonly threadId: ThreadId }) =>
        Effect.succeed((input.activities ?? []).filter((row) => row.threadId === threadId)),
    } as unknown as ProjectionThreadActivityRepository["Service"];

    const messageRepository = {
      listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
        Effect.succeed((input.messages ?? []).filter((row) => row.threadId === threadId)),
    } as unknown as ProjectionThreadMessageRepository["Service"];

    const layer = SessionRecoveryReactorLive.pipe(
      Layer.provideMerge(Layer.succeed(ProjectionThreadMessageRepository, messageRepository)),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
      Layer.provideMerge(Layer.succeed(ProjectionWorkspaceCollaborationRunRepository, repository)),
      Layer.provideMerge(Layer.succeed(ProjectionThreadActivityRepository, activityRepository)),
      Layer.provideMerge(NodeServices.layer),
    );
    return { dispatchedRef, layer };
  });
}

const runSweep = <LayerError>(harness: {
  readonly layer: Layer.Layer<SessionRecoveryReactor, LayerError>;
}) =>
  Effect.gen(function* () {
    const reactor = yield* Effect.service(SessionRecoveryReactor);
    yield* reactor.start();
    yield* reactor.drain;
  }).pipe(Effect.provide(harness.layer), Effect.scoped);

it.effect("settles the phantom session and restarts the interrupted turn", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-interrupted");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-interrupted",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-1") }),
        }),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.session.stop",
      "thread.turn.start",
    ]);
    const turnStart = dispatched[1];
    if (turnStart?.type !== "thread.turn.start") throw new Error("expected a turn start");
    expect(turnStart.threadId).toBe(threadId);
    expect(turnStart.inputOrigin).toBe("automation");
    expect(turnStart.message.text).toContain("자동 복구");
    expect(turnStart.modelSelection).toEqual(modelSelection);
  }),
);

it.effect("only settles a session that had no turn in flight", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-idle-start");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-idle-start",
          session: session({ threadId, status: "starting", activeTurnId: null }),
        }),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual(["thread.session.stop"]);
  }),
);

it.effect("leaves healthy and stopped sessions alone", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-ready",
          session: session({ threadId: ThreadId.make("thread-ready"), status: "ready" }),
        }),
        threadShell({
          id: "thread-stopped",
          session: session({ threadId: ThreadId.make("thread-stopped"), status: "stopped" }),
        }),
        threadShell({ id: "thread-none", session: null }),
      ],
    });
    yield* runSweep(harness);

    expect(yield* Ref.get(harness.dispatchedRef)).toEqual([]);
  }),
);

it.effect("does not race the collaboration reactor for a resumable run's thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-meeting");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-meeting",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-m") }),
        }),
      ],
      resumableRuns: [
        {
          id: WorkspaceCollaborationRunId.make("run-m"),
          projectId,
          meeting: { threadId },
        } as unknown as WorkspaceCollaborationRun,
      ],
    });
    yield* runSweep(harness);

    // The phantom session still settles, but the collaboration reactor owns
    // restarting the work — no recovery turn here.
    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual(["thread.session.stop"]);
  }),
);

it.effect("does not inject a recovery turn into a resumable run's running attempt thread", () =>
  Effect.gen(function* () {
    const attemptThreadId = ThreadId.make("thread-graph-attempt");
    const stepThreadId = ThreadId.make("thread-legacy-step");
    const settledThreadId = ThreadId.make("thread-settled-attempt");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-graph-attempt",
          session: session({
            threadId: attemptThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-a"),
          }),
        }),
        threadShell({
          id: "thread-legacy-step",
          session: session({
            threadId: stepThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-s"),
          }),
        }),
        // A person kept chatting on a finished attempt's thread: the
        // collaboration reactor never re-drives it, so their interrupted
        // turn still gets the normal recovery restart.
        threadShell({
          id: "thread-settled-attempt",
          session: session({
            threadId: settledThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-user"),
          }),
        }),
      ],
      resumableRuns: [
        {
          id: WorkspaceCollaborationRunId.make("run-g"),
          projectId,
          meeting: null,
          graph: {
            nodes: [
              {
                attempts: [
                  { threadId: settledThreadId, status: "completed" },
                  { threadId: attemptThreadId, status: "running" },
                ],
              },
            ],
          },
          steps: [{ threadId: stepThreadId, status: "running" }],
        } as unknown as WorkspaceCollaborationRun,
      ],
    });
    yield* runSweep(harness);

    // The running attempt and step threads settle only — the collaboration
    // reactor owns resuming that work, and a recovery turn there would be
    // read back as node output. The settled attempt's thread still gets its
    // recovery turn.
    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.session.stop",
      "thread.session.stop",
      "thread.session.stop",
      "thread.turn.start",
    ]);
    const turnStart = dispatched[3];
    if (turnStart?.type !== "thread.turn.start") throw new Error("expected a turn start");
    expect(turnStart.threadId).toBe(settledThreadId);
  }),
);

it.effect(
  "does not inject a recovery turn into an orchestra node's fixed thread while it runs",
  () =>
    Effect.gen(function* () {
      const nodeThreadId = ThreadId.make("thread-orchestra-node");
      const harness = yield* makeHarness({
        threads: [
          threadShell({
            id: "thread-orchestra-node",
            session: session({
              threadId: nodeThreadId,
              status: "running",
              activeTurnId: TurnId.make("turn-n"),
            }),
          }),
        ],
        resumableRuns: [
          {
            id: WorkspaceCollaborationRunId.make("run-o"),
            projectId,
            meeting: null,
            graph: {
              nodes: [{ status: "running", threadId: nodeThreadId, attempts: [] }],
            },
            steps: [],
          } as unknown as WorkspaceCollaborationRun,
        ],
      });
      yield* runSweep(harness);

      const dispatched = yield* Ref.get(harness.dispatchedRef);
      expect(dispatched.map((command) => command.type)).toEqual(["thread.session.stop"]);
    }),
);

it.effect("closes the questions the dead session left open and tells the seat to ask again", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-asking");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-asking",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-1") }),
          hasPendingUserInput: true,
        }),
      ],
      activities: [
        // Answered before the restart: stays closed.
        activity({
          id: "a1",
          threadId,
          kind: "user-input.requested",
          payload: { requestId: "q-old" },
        }),
        activity({
          id: "a2",
          threadId,
          kind: "user-input.resolved",
          payload: { requestId: "q-old" },
        }),
        // Open when the server died: the provider no longer knows it.
        activity({
          id: "a3",
          threadId,
          kind: "user-input.requested",
          payload: { requestId: "q-open" },
        }),
        // Already failed as stale once: nothing left to close.
        activity({
          id: "a4",
          threadId,
          kind: "user-input.requested",
          payload: { requestId: "q-stale" },
        }),
        activity({
          id: "a5",
          threadId,
          kind: "provider.user-input.respond.failed",
          payload: { requestId: "q-stale", detail: "Stale pending user-input request: q-stale" },
        }),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.session.stop",
      "thread.activity.append",
      "thread.turn.start",
    ]);
    const closed = dispatched[1];
    if (closed?.type !== "thread.activity.append") throw new Error("expected an activity append");
    expect(closed.activity.kind).toBe("user-input.resolved");
    expect(closed.activity.payload).toMatchObject({ requestId: "q-open", abandoned: true });
    const turnStart = dispatched[2];
    if (turnStart?.type !== "thread.turn.start") throw new Error("expected a turn start");
    expect(turnStart.message.text).toContain("같은 질문을 다시 해 주세요");
  }),
);

it.effect("marks background monitors and a pending self-wakeup as lost, and tells the seat", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-watching");
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-watching",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-1") }),
        }),
      ],
      activities: [
        // A monitor that already ended normally: not reported.
        activity({
          id: "t1",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "done",
            agentKind: "background",
            taskType: "local_bash",
            title: "old",
          },
          createdAt: "2026-08-17T00:00:01.000Z",
        }),
        activity({
          id: "t2",
          threadId,
          kind: "task.completed",
          payload: { taskId: "done", status: "completed" },
          createdAt: "2026-08-17T00:00:02.000Z",
        }),
        // Two live watch loops.
        activity({
          id: "t3",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "m1",
            agentKind: "background",
            taskType: "local_bash",
            title: "log watch",
          },
          createdAt: "2026-08-17T00:00:03.000Z",
        }),
        activity({
          id: "t4",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "m2",
            agentKind: "background",
            taskType: "monitor",
            title: "liveness",
          },
          createdAt: "2026-08-17T00:00:04.000Z",
        }),
        // An agent (not background) must not be counted as a monitor.
        activity({
          id: "t5",
          threadId,
          kind: "task.started",
          payload: { taskId: "a1", agentKind: "agent", taskType: "local_agent", title: "worker" },
          createdAt: "2026-08-17T00:00:05.000Z",
        }),
        // A self-wakeup scheduled 20 minutes out: still ahead of the sweep.
        activity({
          id: "t6",
          threadId,
          kind: "tool.completed",
          payload: {
            itemType: "dynamic_tool_call",
            detail: "ScheduleWakeup: {}",
            data: { toolName: "ScheduleWakeup", input: { delaySeconds: 1200, noop: false } },
          },
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 60_000)),
        }),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.session.stop",
      "thread.activity.append",
      "thread.activity.append",
      "thread.activity.append",
      "thread.turn.start",
    ]);
    const appended = dispatched.filter((command) => command.type === "thread.activity.append");
    expect(appended.map((command) => command.activity.kind)).toEqual([
      "task.completed",
      "task.completed",
      "session.recovered",
    ]);
    expect(
      appended.map((command) => (command.activity.payload as { taskId?: string }).taskId),
    ).toEqual(["m1", "m2", undefined]);
    const marker = appended[2]!.activity.payload as {
      interruptedTasks: ReadonlyArray<{ taskId: string }>;
      wakeupScheduledFor: string | null;
    };
    expect(marker.interruptedTasks.map((task) => task.taskId)).toEqual(["m1", "m2"]);
    expect(marker.wakeupScheduledFor).not.toBeNull();
    const turnStart = dispatched.at(-1);
    if (turnStart?.type !== "thread.turn.start") throw new Error("expected a turn start");
    expect(turnStart.message.text).toContain("백그라운드 감시 2개");
    expect(turnStart.message.text).toContain("자동 깨어남");
  }),
);

// The storm guard measures against the wall clock, which `it.effect`'s
// TestClock would freeze at the epoch — hence `it.live` for these two.
it.live("holds the recovery turn once restarts keep killing the same thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-storm");
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-storm",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-9") }),
        }),
      ],
      messages: [1, 2, 3].map((index) =>
        recoveryMessage({
          id: `recovery-${index}`,
          threadId,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - index * 60_000)),
        }),
      ),
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.session.stop",
      "thread.activity.append",
    ]);
    const marker = dispatched[1];
    if (marker?.type !== "thread.activity.append") throw new Error("expected a hold marker");
    expect(marker.activity.kind).toBe("session.recovery-held");
    expect(marker.activity.summary).toContain("자동 복구 보류");
  }),
);

it.live("recovery turns outside the storm window do not hold the thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-old-storm");
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-old-storm",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-9") }),
        }),
      ],
      messages: [
        recoveryMessage({
          id: "recovery-recent",
          threadId,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - 60_000)),
        }),
        ...[1, 2, 3].map((index) =>
          recoveryMessage({
            id: `recovery-old-${index}`,
            threadId,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - (20 + index) * 60_000)),
          }),
        ),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.session.stop",
      "thread.turn.start",
    ]);
  }),
);
