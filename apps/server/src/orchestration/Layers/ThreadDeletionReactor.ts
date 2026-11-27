import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerConfig } from "../../config.ts";
import { purgePdfJobsForThread } from "../../documents/pdfIndexJob.ts";
import * as Option from "effect/Option";

class PdfCleanupError extends Schema.TaggedErrorClass<PdfCleanupError>()("PdfCleanupError", {
  cause: Schema.Defect(),
}) {}

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type ThreadRevertedEvent = Extract<OrchestrationEvent, { type: "thread.reverted" }>;
type ThreadCleanupEvent = ThreadDeletedEvent | ThreadRevertedEvent;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const config = yield* Effect.serviceOption(ServerConfig);
  const queries = yield* Effect.serviceOption(ProjectionSnapshotQuery);

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadCleanupEvent,
  ) {
    const { threadId } = event.payload;
    if (event.type === "thread.deleted") {
      yield* stopProviderSession(threadId);
      yield* closeThreadTerminals(threadId);
    }
    let retained: ReadonlySet<string> | undefined;
    if (event.type === "thread.reverted") {
      if (Option.isNone(queries)) return;
      const thread = yield* queries.value.getThreadRuntimeContext(threadId, { messages: true });
      if (Option.isNone(thread)) return;
      retained = new Set(thread.value.messages.map((message) => message.id));
    }
    if (Option.isSome(config))
      yield* Effect.tryPromise({
        try: () => purgePdfJobsForThread(config.value.stateDir, threadId, retained),
        catch: (cause) => new PdfCleanupError({ cause }),
      });
  });

  const processThreadDeletedSafely = (event: ThreadCleanupEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted" && event.type !== "thread.reverted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
      { startImmediately: true },
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
