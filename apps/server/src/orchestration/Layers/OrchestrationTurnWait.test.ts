import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { OrchestrationTurnWait } from "../Services/OrchestrationTurnWait.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationTurnWaitLive } from "./OrchestrationTurnWait.ts";

const projectId = ProjectId.make("project-turn-wait");
const threadId = ThreadId.make("thread-turn-wait");
const at = "2026-08-10T00:00:00.000Z";

function latestTurn(id: string, state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make(id),
    state,
    requestedAt: at,
    startedAt: at,
    completedAt: state === "running" ? null : at,
    assistantMessageId: null,
  };
}

function thread(turn: OrchestrationLatestTurn | null): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: "Event driven wait",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-turn-wait"),
      model: "gpt-5",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: turn,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function domainEvent(input: {
  readonly sequence: number;
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: input.type,
    payload: input.payload,
  } as OrchestrationEvent;
}

const createSystem = (initial: OrchestrationThread) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const threadRef = yield* Ref.make(initial);
    const firstRead = yield* Deferred.make<void>();
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.succeed({ sequence: 0 }),
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    } satisfies OrchestrationEngineShape;
    const query = {
      getThreadDetailById: () =>
        Ref.get(threadRef).pipe(
          Effect.tap(() => Deferred.succeed(firstRead, undefined)),
          Effect.map(Option.some),
        ),
    } as unknown as ProjectionSnapshotQueryShape;
    const dependencies = Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, engine),
      Layer.succeed(ProjectionSnapshotQuery, query),
    );
    const layer = OrchestrationTurnWaitLive.pipe(Layer.provide(dependencies));
    return { events, firstRead, layer, threadRef };
  });

it.effect("settles only after a committed event wakes the pinned turn", () =>
  Effect.gen(function* () {
    const system = yield* createSystem(thread(latestTurn("turn-1", "running")));

    const result = yield* Effect.gen(function* () {
      const wait = yield* Effect.service(OrchestrationTurnWait);
      const fiber = yield* wait
        .waitForSettledTurn({ threadId, expectedProjectId: projectId })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(system.firstRead);
      yield* Ref.set(system.threadRef, thread(latestTurn("turn-1", "completed")));
      yield* Queue.offer(
        system.events,
        domainEvent({
          sequence: 1,
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.session-set",
          payload: {},
        }),
      );
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(system.layer), Effect.scoped);

    expect(result.turn.turnId).toBe(TurnId.make("turn-1"));
    expect(result.turn.state).toBe("completed");
  }),
);

it.effect("rejects a replacement turn instead of satisfying the original wait", () =>
  Effect.gen(function* () {
    const system = yield* createSystem(thread(latestTurn("turn-original", "running")));

    const error = yield* Effect.gen(function* () {
      const wait = yield* Effect.service(OrchestrationTurnWait);
      const fiber = yield* wait
        .waitForSettledTurn({ threadId })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(system.firstRead);
      yield* Ref.set(system.threadRef, thread(latestTurn("turn-replacement", "completed")));
      yield* Queue.offer(
        system.events,
        domainEvent({
          sequence: 2,
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.session-set",
          payload: {},
        }),
      );
      return yield* Fiber.join(fiber).pipe(Effect.flip);
    }).pipe(Effect.provide(system.layer), Effect.scoped);

    expect(error._tag).toBe("OrchestrationTurnWaitTargetReplacedError");
    if (error._tag === "OrchestrationTurnWaitTargetReplacedError") {
      expect(error.expectedTurnId).toBe(TurnId.make("turn-original"));
      expect(error.actualTurnId).toBe(TurnId.make("turn-replacement"));
    }
  }),
);

it.effect("wakes immediately when the owning collaboration run is cancelled", () =>
  Effect.gen(function* () {
    const system = yield* createSystem(thread(latestTurn("turn-cancelled", "running")));

    const error = yield* Effect.gen(function* () {
      const wait = yield* Effect.service(OrchestrationTurnWait);
      const fiber = yield* wait
        .waitForSettledTurn({
          threadId,
          interruptWhen: (event) => event.type === "project.collaboration-run-cancel-requested",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(system.firstRead);
      yield* Queue.offer(
        system.events,
        domainEvent({
          sequence: 3,
          aggregateKind: "project",
          aggregateId: projectId,
          type: "project.collaboration-run-cancel-requested",
          payload: {},
        }),
      );
      return yield* Fiber.join(fiber).pipe(Effect.flip);
    }).pipe(Effect.provide(system.layer), Effect.scoped);

    expect(error._tag).toBe("OrchestrationTurnWaitInterruptedError");
  }),
);
