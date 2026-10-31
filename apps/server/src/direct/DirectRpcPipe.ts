import {
  DESKTOP_DIRECT_RPC_QUEUE_CAPACITY,
  DesktopDirectRpcInput,
  DesktopDirectRpcOutput,
} from "@t3tools/contracts";
import * as NodeSink from "@effect/platform-node/NodeSink";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { DirectRpcChannel } from "./DirectRpcProtocol.ts";

const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopDirectRpcInput));
const encodeOutput = Schema.encodeSync(Schema.fromJsonString(DesktopDirectRpcOutput));

/** Adapts inherited process pipes to the same direct RPC channel used by the server. */
export const makeDirectRpcPipe = (
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Effect.Effect<DirectRpcChannel, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outgoing = yield* Queue.bounded<string>(DESKTOP_DIRECT_RPC_QUEUE_CAPACITY);
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(
        NodeSink.fromWritable({
          evaluate: () => output,
          onError: () => new Error("Direct RPC output pipe failed."),
          endOnDone: false,
        }),
      ),
      Effect.catch(() => Effect.void),
      Effect.ensuring(Queue.shutdown(outgoing)),
      Effect.forkScoped,
    );
    const incoming = NodeStream.fromReadable({
      evaluate: () => input,
      onError: () => new Error("Direct RPC input pipe failed."),
      closeOnDone: false,
    }).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.mapEffect((line) => decodeInput(line).pipe(Effect.option)),
      Stream.filter(Option.isSome),
      Stream.map((frame) => frame.value),
      Stream.catch(() => Stream.empty),
    );
    return {
      incoming,
      send: (frame) => Queue.offer(outgoing, `${encodeOutput(frame)}\n`).pipe(Effect.asVoid),
    };
  });
