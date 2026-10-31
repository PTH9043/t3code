// @effect-diagnostics preferSchemaOverJson:off -- Fixtures exercise the JSON wire format.
import {
  WsServerProbeRpc,
  type DesktopDirectRpcInput,
  type DesktopDirectRpcOutput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import {
  makeDirectRpcProtocol,
  runDirectRpcClients,
  trackDirectRpcSession,
} from "./DirectRpcProtocol.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const sessionLayer = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-direct-session-test-" })),
);

it.layer(NodeServices.layer)("direct signed sessions", (it) => {
  it.effect("routes separately verified bearer sessions and rejects revoked credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const alpha = yield* sessions.issue({
          method: "bearer-access-token",
          subject: "google:alpha",
          scopes: ["orchestration:read"],
        });
        const beta = yield* sessions.issue({
          method: "bearer-access-token",
          subject: "google:beta",
          scopes: ["access:write"],
        });
        const revoked = yield* sessions.issue({
          method: "bearer-access-token",
          subject: "revoked",
        });
        yield* sessions.revoke(revoked.sessionId);
        const inbound = yield* Queue.unbounded<DesktopDirectRpcInput>();
        const outbound = yield* Queue.unbounded<DesktopDirectRpcOutput>();
        const alphaClosed = yield* Deferred.make<void>();
        const betaClosed = yield* Deferred.make<void>();
        const builds: string[] = [];
        const group = RpcGroup.make(
          Rpc.make("identity", { payload: Schema.Struct({}), success: Schema.String }),
        );
        yield* runDirectRpcClients(
          {
            incoming: Stream.fromQueue(inbound),
            send: (frame) => Queue.offer(outbound, frame).pipe(Effect.asVoid),
          },
          (token) =>
            Effect.gen(function* () {
              if (token === undefined) return yield* Effect.fail("missing token");
              const principal = yield* sessions.verify(token);
              if (principal.method !== "bearer-access-token")
                return yield* Effect.fail("invalid method");
              return { key: principal.sessionId, principal };
            }),
          (principal, channel) =>
            Effect.gen(function* () {
              builds.push(principal.subject);
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(
                  principal.subject === "google:alpha" ? alphaClosed : betaClosed,
                  undefined,
                ).pipe(Effect.asVoid),
              );
              yield* trackDirectRpcSession(sessions, principal.sessionId);
              const protocol = yield* makeDirectRpcProtocol(channel, { preventReopen: false });
              const handlers = yield* Layer.build(
                group.toLayer(
                  Effect.succeed(
                    group.of({
                      identity: () =>
                        Effect.succeed(`${principal.subject}:${principal.scopes.join(",")}`),
                    }),
                  ),
                ),
              );
              yield* RpcServer.make(group, { disableFatalDefects: true }).pipe(
                Effect.provide(handlers),
                Effect.provideService(RpcServer.Protocol, protocol),
                Effect.forkScoped,
              );
            }),
        );
        for (const [clientId, bearerToken, accepted] of [
          [1, alpha.token, true],
          [5, alpha.token, true],
          [2, beta.token, true],
          [3, revoked.token, false],
          [4, "forged", false],
        ] as const) {
          yield* Queue.offer(inbound, { type: "open", clientId, bearerToken });
          expect(yield* Queue.take(outbound)).toEqual({
            type: accepted ? "opened" : "closed",
            clientId,
          });
        }
        expect(builds).toEqual(["google:alpha", "google:beta"]);
        expect(
          (yield* sessions.listActive()).find((item) => item.sessionId === alpha.sessionId)
            ?.connected,
        ).toBe(true);
        expect(
          (yield* sessions.listActive()).find((item) => item.sessionId === beta.sessionId)
            ?.connected,
        ).toBe(true);
        yield* sessions.revoke(alpha.sessionId);
        yield* Queue.offer(inbound, { type: "open", clientId: 6, bearerToken: alpha.token });
        expect(yield* Queue.take(outbound)).toEqual({ type: "closed", clientId: 6 });
        for (const clientId of [1, 2]) {
          yield* Queue.offer(inbound, {
            type: "data",
            clientId,
            data: JSON.stringify({
              _tag: "Request",
              id: "identity",
              tag: "identity",
              payload: {},
              headers: [],
            }),
          });
        }
        for (const frame of [yield* Queue.take(outbound), yield* Queue.take(outbound)]) {
          expect(frame.type).toBe("data");
          if (frame.type === "data")
            expect(JSON.parse(frame.data)).toMatchObject({
              exit: {
                _tag: "Success",
                value:
                  frame.clientId === 1
                    ? "google:alpha:orchestration:read"
                    : "google:beta:access:write",
              },
            });
        }
        for (const clientId of [1, 5]) {
          yield* Queue.offer(inbound, { type: "close", clientId });
          expect(yield* Queue.take(outbound)).toEqual({ type: "closed", clientId });
        }
        yield* Deferred.await(alphaClosed);
        yield* Queue.offer(inbound, { type: "open", clientId: 7, bearerToken: alpha.token });
        expect(yield* Queue.take(outbound)).toEqual({ type: "closed", clientId: 7 });
        yield* Queue.offer(inbound, { type: "open", clientId: 8, bearerToken: beta.token });
        expect(yield* Queue.take(outbound)).toEqual({ type: "opened", clientId: 8 });
        expect(builds).toEqual(["google:alpha", "google:beta"]);
        yield* Queue.offer(inbound, { type: "close", clientId: 2 });
        expect(yield* Queue.take(outbound)).toEqual({ type: "closed", clientId: 2 });
        expect(
          (yield* sessions.listActive()).find((item) => item.sessionId === beta.sessionId)
            ?.connected,
        ).toBe(true);
        yield* Queue.offer(inbound, { type: "close", clientId: 8 });
        expect(yield* Queue.take(outbound)).toEqual({ type: "closed", clientId: 8 });
        yield* Deferred.await(betaClosed);
        expect(
          (yield* sessions.listActive()).find((item) => item.sessionId === beta.sessionId)
            ?.connected,
        ).toBe(false);
        yield* Queue.offer(inbound, { type: "open", clientId: 9, bearerToken: beta.token });
        expect(yield* Queue.take(outbound)).toEqual({ type: "opened", clientId: 9 });
        expect(builds).toEqual(["google:alpha", "google:beta", "google:beta"]);
        expect(
          (yield* sessions.listActive()).find((item) => item.sessionId === beta.sessionId)
            ?.connected,
        ).toBe(true);
      }),
    ).pipe(Effect.provide(sessionLayer)),
  );
});

it.effect("isolates direct clients by authenticated session and closes their streams", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inbound = yield* Queue.unbounded<DesktopDirectRpcInput>();
      const outbound = yield* Queue.unbounded<DesktopDirectRpcOutput>();
      const stopped = yield* Deferred.make<void>();
      const group = RpcGroup.make(
        Rpc.make("identity", { payload: Schema.Struct({}), success: Schema.String }),
        Rpc.make("watch", { payload: Schema.Struct({}), success: Schema.String, stream: true }),
      );
      yield* runDirectRpcClients(
        {
          incoming: Stream.fromQueue(inbound),
          send: (frame) => Queue.offer(outbound, frame).pipe(Effect.asVoid),
        },
        (token) =>
          Effect.gen(function* () {
            if (token !== "alpha" && token !== "beta") return yield* Effect.fail("invalid");
            return { key: token, principal: token };
          }),
        (token, channel) =>
          Effect.gen(function* () {
            const protocol = yield* makeDirectRpcProtocol(channel, { preventReopen: false });
            const handlers = yield* Layer.build(
              group.toLayer(
                Effect.succeed(
                  group.of({
                    identity: () => Effect.succeed(token),
                    watch: () =>
                      Stream.concat(Stream.make(token), Stream.fromEffect(Effect.never)).pipe(
                        Stream.ensuring(Deferred.succeed(stopped, undefined).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
              ),
            );
            yield* RpcServer.make(group, { disableFatalDefects: true }).pipe(
              Effect.provide(handlers),
              Effect.provideService(RpcServer.Protocol, protocol),
              Effect.forkScoped,
            );
          }),
      );
      for (const [clientId, bearerToken] of [
        [1, "alpha"],
        [2, "beta"],
        [3, "bad"],
      ] as const) {
        yield* Queue.offer(inbound, { type: "open", clientId, bearerToken });
        expect(yield* Queue.take(outbound)).toEqual({
          type: clientId === 3 ? "closed" : "opened",
          clientId,
        });
      }
      for (const clientId of [1, 2]) {
        yield* Queue.offer(inbound, {
          type: "data",
          clientId,
          data: JSON.stringify({
            _tag: "Request",
            id: "identity",
            tag: "identity",
            payload: {},
            headers: [],
          }),
        });
      }
      const first = yield* Queue.take(outbound);
      const second = yield* Queue.take(outbound);
      for (const frame of [first, second]) {
        expect(frame.type).toBe("data");
        if (frame.type === "data") {
          expect(JSON.parse(frame.data)).toMatchObject({
            _tag: "Exit",
            requestId: "identity",
            exit: { _tag: "Success", value: frame.clientId === 1 ? "alpha" : "beta" },
          });
        }
      }
      yield* Queue.offer(inbound, {
        type: "data",
        clientId: 1,
        data: JSON.stringify({
          _tag: "Request",
          id: "watch",
          tag: "watch",
          payload: {},
          headers: [],
        }),
      });
      expect((yield* Queue.take(outbound)).type).toBe("data");
      yield* Queue.offer(inbound, { type: "close", clientId: 1 });
      expect(yield* Queue.take(outbound)).toEqual({ type: "closed", clientId: 1 });
      yield* Deferred.await(stopped);
      yield* Queue.offer(inbound, {
        type: "data",
        clientId: 2,
        data: JSON.stringify({
          _tag: "Request",
          id: "again",
          tag: "identity",
          payload: {},
          headers: [],
        }),
      });
      const remaining = yield* Queue.take(outbound);
      expect(remaining.type).toBe("data");
      if (remaining.type === "data")
        expect(JSON.parse(remaining.data)).toMatchObject({
          requestId: "again",
          exit: { _tag: "Success", value: "beta" },
        });
    }),
  ),
);

it.effect("serves the real probe RPC over a direct channel for independent clients", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inbound = yield* Queue.unbounded<DesktopDirectRpcInput>();
      const outbound = yield* Queue.unbounded<DesktopDirectRpcOutput>();
      const protocol = yield* makeDirectRpcProtocol({
        incoming: Stream.fromQueue(inbound),
        send: (frame) => Queue.offer(outbound, frame).pipe(Effect.asVoid),
      });
      const group = RpcGroup.make(WsServerProbeRpc);
      const handlers = group.toLayer(
        Effect.succeed(group.of({ "server.probe": () => Effect.succeed({}) })),
      );
      const context = yield* Layer.build(handlers);
      yield* RpcServer.make(group, { disableFatalDefects: true }).pipe(
        Effect.provide(context),
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.forkScoped,
      );

      yield* Queue.offer(inbound, { type: "open", clientId: 1 });
      expect(yield* Queue.take(outbound)).toEqual({ type: "opened", clientId: 1 });
      yield* Queue.offer(inbound, { type: "open", clientId: 2 });
      expect(yield* Queue.take(outbound)).toEqual({ type: "opened", clientId: 2 });
      for (const clientId of [1, 2]) {
        yield* Queue.offer(inbound, {
          type: "data",
          clientId,
          data: JSON.stringify({
            _tag: "Request",
            id: "probe",
            tag: "server.probe",
            payload: {},
            headers: [],
          }),
        });
      }
      const first = yield* Queue.take(outbound);
      const second = yield* Queue.take(outbound);
      expect([first.clientId, second.clientId].sort()).toEqual([1, 2]);
      for (const frame of [first, second]) {
        expect(frame.type).toBe("data");
        if (frame.type === "data") {
          expect(JSON.parse(frame.data)).toMatchObject({
            _tag: "Exit",
            requestId: "probe",
            exit: { _tag: "Success", value: {} },
          });
        }
      }
      yield* Queue.offer(inbound, { type: "close", clientId: 1 });
      expect(yield* Queue.take(outbound)).toEqual({ type: "closed", clientId: 1 });
      yield* Queue.offer(inbound, { type: "open", clientId: 1 });
      expect(yield* Queue.take(outbound)).toEqual({ type: "closed", clientId: 1 });
      yield* Queue.offer(inbound, { type: "data", clientId: 2, data: "invalid-json" });
      expect(yield* Queue.take(outbound)).toEqual({ type: "closed", clientId: 2 });
    }),
  ),
);

it.effect("cancels an active RPC stream when its direct client disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inbound = yield* Queue.unbounded<DesktopDirectRpcInput>();
      const outbound = yield* Queue.unbounded<DesktopDirectRpcOutput>();
      const closed = yield* Deferred.make<void>();
      const protocol = yield* makeDirectRpcProtocol({
        incoming: Stream.fromQueue(inbound),
        send: (frame) => Queue.offer(outbound, frame).pipe(Effect.asVoid),
      });
      const group = RpcGroup.make(
        Rpc.make("watch", { payload: Schema.Struct({}), success: Schema.String, stream: true }),
      );
      const handlers = group.toLayer(
        Effect.succeed(
          group.of({
            watch: () =>
              Stream.concat(Stream.make("진행 중"), Stream.fromEffect(Effect.never)).pipe(
                Stream.ensuring(Deferred.succeed(closed, undefined).pipe(Effect.asVoid)),
              ),
          }),
        ),
      );
      const context = yield* Layer.build(handlers);
      yield* RpcServer.make(group, { disableFatalDefects: true }).pipe(
        Effect.provide(context),
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.forkScoped,
      );
      yield* Queue.offer(inbound, { type: "open", clientId: 3 });
      expect(yield* Queue.take(outbound)).toEqual({ type: "opened", clientId: 3 });
      yield* Queue.offer(inbound, {
        type: "data",
        clientId: 3,
        data: JSON.stringify({
          _tag: "Request",
          id: "watch",
          tag: "watch",
          payload: {},
          headers: [],
        }),
      });
      const chunk = yield* Queue.take(outbound);
      expect(chunk.type).toBe("data");
      if (chunk.type === "data") {
        expect(JSON.parse(chunk.data)).toMatchObject({ _tag: "Chunk", values: ["진행 중"] });
      }
      yield* Queue.offer(inbound, { type: "close", clientId: 3 });
      expect(yield* Queue.take(outbound)).toEqual({ type: "closed", clientId: 3 });
      yield* Deferred.await(closed);
    }),
  ),
);
