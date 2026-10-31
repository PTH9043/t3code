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
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/unstable/socket/Socket";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { DirectLocalRpc } from "../platform/capabilities.ts";
import * as RpcSession from "./session.ts";

const encodeServerSettings = Schema.encodeSync(ServerSettings);

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
          const config = {
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
          };
          const response =
            request._tag === "Ping"
              ? { _tag: "Pong" }
              : {
                  _tag: "Exit",
                  requestId: request.id,
                  exit: {
                    _tag: "Success",
                    value: request.tag === "server.getConfig" ? config : {},
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
