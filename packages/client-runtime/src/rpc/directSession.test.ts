// @effect-diagnostics preferSchemaOverJson:off -- The fixture speaks the RPC JSON wire protocol.
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerSettings,
  type DesktopDirectRpcBridge,
  type DesktopDirectRpcOutput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/unstable/socket/Socket";
import * as TestClock from "effect/testing/TestClock";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { DirectLocalRpc } from "../platform/capabilities.ts";
import * as RpcSession from "./session.ts";

const encodeServerSettings = Schema.encodeSync(ServerSettings);
const serverConfig = (target: PrimaryConnectionTarget) => ({
  environment: {
    environmentId: target.environmentId,
    label: target.label,
    platform: { os: "windows", arch: "x64" },
    serverVersion: "test",
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  },
  auth: {
    policy: "desktop-managed-local",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "D:/test",
  keybindingsConfigPath: "D:/test/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "D:/test/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: encodeServerSettings(DEFAULT_SERVER_SETTINGS),
});

it.effect("starts a local RPC session through IPC without constructing a network WebSocket", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("local-direct-test"),
        label: "local",
        httpBaseUrl: "http://127.0.0.1:13773",
        wsBaseUrl: "ws://127.0.0.1:13773",
      });
      let listener: (frame: DesktopDirectRpcOutput) => void = () => {};
      let nativeSocketCalls = 0;
      const bridge: DesktopDirectRpcBridge = {
        open: async () => {
          queueMicrotask(() => listener({ type: "opened", clientId: 10 }));
          return 10;
        },
        send: async (_clientId, data) => {
          const request = JSON.parse(data);
          const response =
            request._tag === "Ping"
              ? { _tag: "Pong" }
              : {
                  _tag: "Exit",
                  requestId: request.id,
                  exit: {
                    _tag: "Success",
                    value: request.tag === "server.getConfig" ? serverConfig(target) : {},
                  },
                };
          queueMicrotask(() =>
            listener({ type: "data", clientId: 10, data: JSON.stringify(response) }),
          );
        },
        close: async () => {},
        onFrame: (next) => {
          listener = next;
          return () => {};
        },
      };
      const native = Layer.succeed(Socket.WebSocketConstructor, () => {
        nativeSocketCalls++;
        throw new Error("A native WebSocket must not be opened for the local session.");
      });
      const direct = Layer.succeed(
        DirectLocalRpc,
        DirectLocalRpc.of({ bridge, supports: () => true }),
      );
      const factory = yield* RpcSession.RpcSessionFactory.pipe(
        Effect.provide(RpcSession.layer.pipe(Layer.provide(Layer.mergeAll(native, direct)))),
      );
      const session = yield* factory.connect({
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: "ws://127.0.0.1:13773/ws",
        httpAuthorization: null,
        transport: "desktop-direct",
        target,
      });
      yield* session.ready;
      yield* session.probe;
      expect(nativeSocketCalls).toBe(0);
    }),
  ),
);

it.effect(
  "reports an immediately rejected direct open without waiting for the socket timeout",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("local-direct-rejected"),
          label: "local",
          httpBaseUrl: "http://127.0.0.1:13773",
          wsBaseUrl: "ws://127.0.0.1:13773",
        });
        const bridge: DesktopDirectRpcBridge = {
          open: () => Promise.reject(new Error("backend unavailable")),
          send: async () => {},
          close: async () => {},
          onFrame: () => () => {},
        };
        const native = Layer.succeed(Socket.WebSocketConstructor, () => {
          throw new Error("unexpected network socket");
        });
        const direct = Layer.succeed(
          DirectLocalRpc,
          DirectLocalRpc.of({ bridge, supports: () => true }),
        );
        const factory = yield* RpcSession.RpcSessionFactory.pipe(
          Effect.provide(RpcSession.layer.pipe(Layer.provide(Layer.mergeAll(native, direct)))),
        );
        const session = yield* factory.connect({
          environmentId: target.environmentId,
          label: target.label,
          httpBaseUrl: target.httpBaseUrl,
          socketUrl: "ws://127.0.0.1:13773/ws",
          httpAuthorization: null,
          transport: "desktop-direct",
          target,
        });
        const waiting = yield* session.ready.pipe(
          Effect.timeout("1 second"),
          Effect.result,
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 second");
        const outcome = yield* Fiber.join(waiting);
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure")
          expect(outcome.failure._tag).toBe("ConnectionTransientError");
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("allows the local backend startup window before timing out a direct connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("local-direct-slow"),
        label: "local",
        httpBaseUrl: "http://127.0.0.1:13773",
        wsBaseUrl: "ws://127.0.0.1:13773",
      });
      let notifyOpen!: () => void;
      const attempted = new Promise<void>((resolve) => {
        notifyOpen = resolve;
      });
      let listener: (frame: DesktopDirectRpcOutput) => void = () => {};
      const bridge: DesktopDirectRpcBridge = {
        open: async () => {
          notifyOpen();
          return 42;
        },
        send: async (_id, data) => {
          const request = JSON.parse(data);
          const response =
            request._tag === "Ping"
              ? { _tag: "Pong" }
              : {
                  _tag: "Exit",
                  requestId: request.id,
                  exit: { _tag: "Success", value: serverConfig(target) },
                };
          queueMicrotask(() =>
            listener({ type: "data", clientId: 42, data: JSON.stringify(response) }),
          );
        },
        close: async () => {},
        onFrame: (next) => {
          listener = next;
          return () => {};
        },
      };
      const native = Layer.succeed(Socket.WebSocketConstructor, () => {
        throw new Error("unexpected network socket");
      });
      const direct = Layer.succeed(
        DirectLocalRpc,
        DirectLocalRpc.of({ bridge, supports: () => true }),
      );
      const factory = yield* RpcSession.RpcSessionFactory.pipe(
        Effect.provide(RpcSession.layer.pipe(Layer.provide(Layer.mergeAll(native, direct)))),
      );
      const session = yield* factory.connect({
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: "ws://127.0.0.1:13773/ws",
        httpAuthorization: null,
        transport: "desktop-direct",
        target,
      });
      const waiting = yield* session.ready.pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => attempted);
      yield* TestClock.adjust("20 seconds");
      expect(waiting.pollUnsafe()).toBeUndefined();
      listener({ type: "opened", clientId: 42 });
      const result = yield* Fiber.join(waiting);
      expect(result._tag).toBe("Success");
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "still times out a direct connection that never opens after the local startup window",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("local-direct-never-open"),
          label: "local",
          httpBaseUrl: "http://127.0.0.1:13773",
          wsBaseUrl: "ws://127.0.0.1:13773",
        });
        let notifyOpen!: () => void;
        const attempted = new Promise<void>((resolve) => {
          notifyOpen = resolve;
        });
        const bridge: DesktopDirectRpcBridge = {
          open: async () => {
            notifyOpen();
            return 42;
          },
          send: async () => {},
          close: async () => {},
          onFrame: () => () => {},
        };
        const native = Layer.succeed(Socket.WebSocketConstructor, () => {
          throw new Error("unexpected network socket");
        });
        const direct = Layer.succeed(
          DirectLocalRpc,
          DirectLocalRpc.of({ bridge, supports: () => true }),
        );
        const factory = yield* RpcSession.RpcSessionFactory.pipe(
          Effect.provide(RpcSession.layer.pipe(Layer.provide(Layer.mergeAll(native, direct)))),
        );
        const session = yield* factory.connect({
          environmentId: target.environmentId,
          label: target.label,
          httpBaseUrl: target.httpBaseUrl,
          socketUrl: "ws://127.0.0.1:13773/ws",
          httpAuthorization: null,
          transport: "desktop-direct",
          target,
        });
        const waiting = yield* session.ready.pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => attempted);
        yield* TestClock.adjust("59 seconds");
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(waiting);
        expect(result._tag).toBe("Failure");
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);
