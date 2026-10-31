import type { OrchestrationEvent, OrchestrationLatestTurn } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
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
  const projectionTurnRepository = yield* ProjectionTurnRepository;

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

        let pinned: Pick<OrchestrationLatestTurn, "turnId" | "requestedAt"> | null = null;

        const finish = Effect.fnUntraced(function* (turn: OrchestrationLatestTurn) {
          const result = yield* snapshotQuery.getThreadRuntimeContext(input.threadId, {
            messages: true,
          });
          if (Option.isNone(result)) {
            return yield* new OrchestrationTurnWaitThreadNotFoundError({
              threadId: input.threadId,
            });
          }
          return { thread: result.value, turn };
        });

        while (true) {
          const result = yield* snapshotQuery.getThreadRuntimeContext(input.threadId);
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

          if (pinned !== null && turn?.turnId !== pinned.turnId) {
            // `latestTurn` is bookkeeping that can transiently rewind to an
            // older turn — a diff finishing after the next turn already
            // started, an overlapping session's status write. Only a turn
            // requested at or after the pinned one is a genuine takeover.
            if (turn !== null && turn.requestedAt >= pinned.requestedAt) {
              // A newer turn took over the thread — a person speaking into a
              // live meeting, a restarted meeting reusing the seat's
              // conversation. The caller wants the thread's eventual answer,
              // so the wait follows the new turn instead of abandoning it.
              pinned = { turnId: turn.turnId, requestedAt: turn.requestedAt };
              if (turn.state !== "running") return yield* finish(turn);
            } else {
              const pinnedRow = yield* projectionTurnRepository.getByTurnId({
                threadId: input.threadId,
                turnId: pinned.turnId,
              });
              if (Option.isNone(pinnedRow)) {
                // The pinned turn is gone from the thread (reverted away), so
                // there is nothing left to await.
                return yield* new OrchestrationTurnWaitTargetReplacedError({
                  threadId: input.threadId,
                  expectedTurnId: pinned.turnId,
                  actualTurnId: turn?.turnId ?? null,
                });
              }
              const row = pinnedRow.value;
              if (row.state !== "pending" && row.state !== "running") {
                return yield* finish({
                  turnId: row.turnId,
                  state: row.state,
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                });
              }
            }
          } else {
            if (pinned === null && isRequestedTurn) {
              pinned = { turnId: turn.turnId, requestedAt: turn.requestedAt };
            }

            if (isRequestedTurn && turn.turnId === pinned?.turnId && turn.state !== "running") {
              return yield* finish(turn);
            }
          }

          const signal = yield* Queue.take(signals);
          if (signal.interrupts) {
            return yield* new OrchestrationTurnWaitInterruptedError({
              threadId: input.threadId,
              turnId: pinned?.turnId ?? null,
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
