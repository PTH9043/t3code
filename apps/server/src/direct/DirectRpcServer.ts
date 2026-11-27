// @effect-diagnostics nodeBuiltinImport:off -- These are inherited private process pipes.
import * as NodeFS from "node:fs";
import { DesktopDirectHttpRpc, WsRpcGroup } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as GeminiAuth from "../provider/GeminiAuth.ts";
import { makeRpcHandlerLayer } from "../ws.ts";
import { makeDirectRpcPipe } from "./DirectRpcPipe.ts";
import {
  makeDirectRpcProtocol,
  runDirectRpcClients,
  trackDirectRpcSession,
} from "./DirectRpcProtocol.ts";

export class DirectHttpHandler extends Context.Service<
  DirectHttpHandler,
  { readonly handle: (request: Request) => Promise<Response> }
>()("t3/direct/DirectRpcServer/DirectHttpHandler") {}

const directHttpGroup = RpcGroup.make(DesktopDirectHttpRpc);
const directGroup = WsRpcGroup.merge(directHttpGroup);

/** Starts only when the desktop has passed both inherited pipe descriptors. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const inputFd = config.desktopDirectRpcInputFd;
    const outputFd = config.desktopDirectRpcOutputFd;
    if (inputFd === undefined && outputFd === undefined) return;
    if (inputFd === undefined || outputFd === undefined) {
      yield* Effect.logError("Desktop direct RPC requires both process pipes.");
      return;
    }

    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const geminiAuth = yield* GeminiAuth.GeminiAuth;
    const pdfWorkerScope = yield* Effect.scope;
    const http = yield* DirectHttpHandler;
    const defaultSession = yield* Effect.acquireRelease(
      auth.issueSession({ subject: "desktop-direct", label: "T3 Code Desktop" }).pipe(Effect.orDie),
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore),
    );
    const input = NodeFS.createReadStream("", { fd: inputFd, autoClose: false });
    const output = NodeFS.createWriteStream("", { fd: outputFd, autoClose: false });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        input.destroy();
        output.destroy();
      }),
    );
    const channel = yield* makeDirectRpcPipe(input, output);
    yield* runDirectRpcClients(
      channel,
      (token) =>
        Effect.gen(function* () {
          const session = token === undefined ? defaultSession : yield* sessions.verify(token);
          if (
            session.method !== "bearer-access-token" ||
            ("proofKeyThumbprint" in session && session.proofKeyThumbprint)
          ) {
            return yield* Effect.fail("Invalid direct session method.");
          }
          return { key: session.sessionId, principal: session };
        }),
      (session, clientChannel) =>
        Effect.gen(function* () {
          yield* trackDirectRpcSession(sessions, session.sessionId);
          const protocol = yield* makeDirectRpcProtocol(clientChannel, { preventReopen: false });
          const handlers = yield* Layer.build(
            Layer.mergeAll(
              makeRpcHandlerLayer(
                session,
                pdfWorkerScope,
                broker,
                selfUpdate,
                geminiAuth,
                "desktop-direct",
              ),
              directHttpGroup.toLayer({
                "desktop.directHttp": (payload) =>
                  Stream.unwrap(
                    Effect.tryPromise({
                      try: (signal) => {
                        if (!payload.path.startsWith("/") || payload.path.startsWith("//")) {
                          throw new Error("Invalid local request path.");
                        }
                        const headers = new Headers();
                        for (const entry of payload.headers)
                          headers.append(entry.name, entry.value);
                        headers.delete("cookie");
                        headers.set("authorization", `Bearer ${session.token}`);
                        const request = new Request(
                          new URL(payload.path, "http://desktop.invalid").toString(),
                          {
                            method: payload.method,
                            headers,
                            signal,
                            ...(payload.body === undefined
                              ? {}
                              : { body: new Uint8Array(Buffer.from(payload.body, "base64")) }),
                          },
                        );
                        return http.handle(request);
                      },
                      catch: () => "Could not process the local request.",
                    }).pipe(
                      Effect.map((response) => {
                        const headers = Array.from(response.headers, ([name, value]) => ({
                          name,
                          value,
                        }));
                        const head = Stream.make({
                          type: "headers" as const,
                          status: response.status,
                          statusText: response.statusText,
                          headers,
                        });
                        const body = response.body;
                        return body === null
                          ? head
                          : Stream.concat(
                              head,
                              Stream.fromReadableStream({
                                evaluate: () => body,
                                onError: () => "Could not read the local response.",
                              }).pipe(
                                Stream.map((chunk) => ({
                                  type: "chunk" as const,
                                  data: Buffer.from(chunk).toString("base64"),
                                })),
                              ),
                            );
                      }),
                    ),
                  ),
              }),
            ),
          );
          yield* RpcServer.make(directGroup, { disableTracing: true }).pipe(
            Effect.provide(handlers),
            Effect.provideService(RpcServer.Protocol, protocol),
            Effect.forkScoped,
          );
        }),
    );
  }),
);
