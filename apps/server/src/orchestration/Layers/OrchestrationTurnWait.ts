import type { OrchestrationEvent, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationTurnWait,
  OrchestrationTurnWaitInterruptedError,
  OrchestrationTurnWaitProjectMismatchError,
  OrchestrationTurnWaitTargetReplacedError,
  OrchestrationTurnWaitThreadNotFoundError,
  type OrchestrationTurnWaitShape,
} from "../Services/OrchestrationTurnWait.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

type WaitSignal = {
  readonly event: OrchestrationEvent;
  readonly interrupts: boolean;
};

export const makeOrchestrationTurnWait = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const waitForSettledTurn: OrchestrationTurnWaitShape["waitForSettledTurn"] = Effect.fn(
    "OrchestrationTurnWait.waitForSettledTurn",
  )(function* (input) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const signals = yield* Queue.unbounded<WaitSignal>();
        yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          const interrupts = input.interruptWhen?.(event) === true;
          const belongsToThread =
            event.aggregateKind === "thread" && event.aggregateId === input.threadId;
          return interrupts || belongsToThread
            ? Queue.offer(signals, { event, interrupts }).pipe(Effect.asVoid)
            : Effect.void;
        }).pipe(Effect.forkScoped({ startImmediately: true }));

        let pinnedTurnId: TurnId | null = null;

        while (true) {
          const result = yield* snapshotQuery.getThreadDetailById(input.threadId);
          if (Option.isNone(result)) {
            return yield* new OrchestrationTurnWaitThreadNotFoundError({
              threadId: input.threadId,
            });
          }

          const thread = result.value;
          if (
            input.expectedProjectId !== undefined &&
            thread.projectId !== input.expectedProjectId
          ) {
            return yield* new OrchestrationTurnWaitProjectMismatchError({
              threadId: input.threadId,
              expectedProjectId: input.expectedProjectId,
              actualProjectId: thread.projectId,
            });
          }

          const turn = thread.latestTurn;
          const isRequestedTurn =
            turn !== null &&
            (input.requestedAtOrAfter === undefined ||
              turn.requestedAt >= input.requestedAtOrAfter);

          if (pinnedTurnId !== null && turn?.turnId !== pinnedTurnId) {
            return yield* new OrchestrationTurnWaitTargetReplacedError({
              threadId: input.threadId,
              expectedTurnId: pinnedTurnId,
              actualTurnId: turn?.turnId ?? null,
            });
          }

          if (pinnedTurnId === null && isRequestedTurn) pinnedTurnId = turn.turnId;

          if (isRequestedTurn && turn.turnId === pinnedTurnId && turn.state !== "running") {
            return { thread, turn };
          }

          const signal = yield* Queue.take(signals);
          if (signal.interrupts) {
            return yield* new OrchestrationTurnWaitInterruptedError({
              threadId: input.threadId,
              turnId: pinnedTurnId,
              eventType: signal.event.type,
            });
          }
        }
      }),
    );
  });

  return { waitForSettledTurn } satisfies OrchestrationTurnWaitShape;
});

export const OrchestrationTurnWaitLive = Layer.effect(
  OrchestrationTurnWait,
  makeOrchestrationTurnWait,
);
