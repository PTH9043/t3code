// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- This test exercises process streams and JSON framing.
import * as NodeStream from "node:stream";
import { WsServerProbeRpc } from "@t3tools/contracts";
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { makeDirectRpcPipe } from "./DirectRpcPipe.ts";
import { makeDirectRpcProtocol } from "./DirectRpcProtocol.ts";

it.effect("handles a real RPC across framed direct streams with split UTF-8 bytes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = new NodeStream.PassThrough();
      const output = new NodeStream.PassThrough();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          input.destroy();
          output.destroy();
        }),
      );
      const received = yield* Queue.unbounded<string>();
      yield* EffectNodeStream.fromReadable({ evaluate: () => output }).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Queue.offer(received, line).pipe(Effect.asVoid)),
        Effect.orDie,
        Effect.forkScoped,
      );
      const channel = yield* makeDirectRpcPipe(input, output);
      const protocol = yield* makeDirectRpcProtocol(channel);
      const group = RpcGroup.make(WsServerProbeRpc);
      const context = yield* Layer.build(
        group.toLayer(Effect.succeed(group.of({ "server.probe": () => Effect.succeed({}) }))),
      );
      yield* RpcServer.make(group, { disableFatalDefects: true }).pipe(
        Effect.provide(context),
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.forkScoped,
      );

      // One malformed frame must not terminate all later direct RPC traffic.
      input.write(`not-json\n${JSON.stringify({ type: "open", clientId: 9 })}\n`);
      expect(JSON.parse(yield* Queue.take(received))).toEqual({ type: "opened", clientId: 9 });
      const request = Buffer.from(
        `${JSON.stringify({
          type: "data",
          clientId: 9,
          data: JSON.stringify({
            _tag: "Request",
            id: "한글-🌏",
            tag: "server.probe",
            payload: {},
            headers: [],
          }),
        })}\n`,
      );
      const split = request.indexOf(Buffer.from("한")) + 1;
      input.write(request.subarray(0, split));
      input.write(request.subarray(split));
      const result = JSON.parse(yield* Queue.take(received));
      expect(result).toMatchObject({ type: "data", clientId: 9 });
      expect(JSON.parse(result.data)).toMatchObject({
        _tag: "Exit",
        requestId: "한글-🌏",
        exit: { _tag: "Success", value: {} },
      });
      input.write(`${JSON.stringify({ type: "close", clientId: 9 })}\n`);
      expect(JSON.parse(yield* Queue.take(received))).toEqual({ type: "closed", clientId: 9 });
    }),
  ),
);
