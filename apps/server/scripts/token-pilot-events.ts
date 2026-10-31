import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** Each job exclusively owns its queue consumer until the enclosing job scope closes. */
export const collectPilotEvents = (
  stream: Stream.Stream<ProviderRuntimeEvent>,
  threadId: ThreadId,
  onEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
) =>
  Stream.runForEach(stream, (event) =>
    event.threadId === threadId ? onEvent(event) : Effect.void,
  ).pipe(Effect.forkScoped);
