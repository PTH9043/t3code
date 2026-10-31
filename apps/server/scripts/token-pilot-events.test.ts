import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { collectPilotEvents } from "./token-pilot-events.ts";

it.effect(
  "releases the previous job's consumer before another thread uses the same adapter queue",
  () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const delivered: string[] = [];
      for (const id of ["first", "second", "third", "fourth"]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const threadId = ThreadId.make(id);
            const received = yield* Deferred.make<void>();
            yield* collectPilotEvents(Stream.fromQueue(queue), threadId, (event) =>
              Effect.gen(function* () {
                delivered.push(event.threadId);
                yield* Deferred.succeed(received, undefined);
              }),
            );
            yield* Queue.offer(queue, {
              type: "turn.completed",
              eventId: EventId.make(id),
              provider: ProviderDriverKind.make("codex"),
              threadId,
              createdAt: "2026-09-13T00:00:00.000Z",
              payload: { state: "completed" },
            });
            yield* Deferred.await(received);
          }),
        );
      }
      expect(delivered).toEqual(["first", "second", "third", "fourth"]);
    }),
);
