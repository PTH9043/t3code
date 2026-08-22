import {
  EventId,
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivity,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
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

function makeHarness(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly resumableRuns?: ReadonlyArray<WorkspaceCollaborationRun>;
  readonly activities?: ReadonlyArray<ProjectionThreadActivity>;
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
      listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
        Effect.succeed((input.activities ?? []).filter((row) => row.threadId === threadId)),
    } as unknown as ProjectionThreadActivityRepository["Service"];

    const layer = SessionRecoveryReactorLive.pipe(
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
