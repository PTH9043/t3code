import {
  DESKTOP_DIRECT_RPC_QUEUE_CAPACITY,
  type AuthSessionId,
  type DesktopDirectRpcInput,
  type DesktopDirectRpcOutput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import type { SessionStore } from "../auth/SessionStore.ts";

export interface DirectRpcChannel {
  readonly incoming: Stream.Stream<DesktopDirectRpcInput>;
  readonly send: (frame: DesktopDirectRpcOutput) => Effect.Effect<void>;
}

/** Tracks a shared session until its last direct client has disconnected. */
export const trackDirectRpcSession = (
  sessions: Pick<SessionStore["Service"], "markConnected" | "markDisconnected">,
  sessionId: AuthSessionId,
) =>
  Effect.acquireRelease(sessions.markConnected(sessionId), () =>
    sessions.markDisconnected(sessionId),
  );

/** Shares a handler only among clients whose credentials resolve to the same session. */
export const runDirectRpcClients = <P, E1, E2, R1, R2>(
  channel: DirectRpcChannel,
  resolve: (token: string | undefined) => Effect.Effect<{ key: string; principal: P }, E1, R1>,
  start: (
    principal: P,
    clientChannel: DirectRpcChannel,
  ) => Effect.Effect<void, E2, R2 | Scope.Scope>,
): Effect.Effect<void, never, R1 | R2 | Scope.Scope> =>
  Effect.gen(function* () {
    const parentScope = yield* Effect.scope;
    type Group = {
      readonly key: string;
      readonly queue: Queue.Queue<DesktopDirectRpcInput>;
      readonly scope: Scope.Closeable;
      readonly clients: Set<number>;
    };
    const groups = new Map<string, Group>();
    const clients = new Map<number, Group>();
    const used = new Set<number>();
    const dispose = (group: Group) =>
      Effect.gen(function* () {
        if (groups.get(group.key) === group) groups.delete(group.key);
        for (const clientId of group.clients) clients.delete(clientId);
        group.clients.clear();
        yield* Queue.shutdown(group.queue);
        yield* Scope.close(group.scope, Exit.void);
      });
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...groups.values()], (group) => dispose(group), { discard: true }),
    );
    yield* channel.incoming.pipe(
      Stream.runForEach((frame) =>
        Effect.gen(function* () {
          if (frame.type === "open") {
            if (clients.has(frame.clientId)) {
              yield* channel.send({ type: "opened", clientId: frame.clientId });
              return;
            }
            if (used.has(frame.clientId)) {
              yield* channel.send({ type: "closed", clientId: frame.clientId });
              return;
            }
            used.add(frame.clientId);
            const resolved = yield* resolve(frame.bearerToken).pipe(Effect.option);
            if (resolved._tag === "None") {
              yield* channel.send({ type: "closed", clientId: frame.clientId });
              return;
            }
            const { key, principal } = resolved.value;
            let group = groups.get(key);
            if (!group) {
              const queue = yield* Queue.bounded<DesktopDirectRpcInput>(
                DESKTOP_DIRECT_RPC_QUEUE_CAPACITY,
              );
              const scope = yield* Scope.make();
              const created: Group = { key, queue, scope, clients: new Set() };
              const clientChannel: DirectRpcChannel = {
                incoming: Stream.fromQueue(queue),
                send: (output) =>
                  Effect.gen(function* () {
                    let retire = false;
                    if (output.type === "closed" && clients.get(output.clientId) === created) {
                      clients.delete(output.clientId);
                      created.clients.delete(output.clientId);
                      if (created.clients.size === 0) {
                        if (groups.get(key) === created) groups.delete(key);
                        retire = true;
                      }
                    }
                    yield* channel.send(output);
                    if (retire) yield* Effect.forkIn(dispose(created), parentScope);
                  }),
              };
              const ready = yield* start(principal, clientChannel).pipe(
                Effect.provideService(Scope.Scope, scope),
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
              if (!ready) {
                yield* dispose(created);
                yield* channel.send({ type: "closed", clientId: frame.clientId });
                return;
              }
              groups.set(key, created);
              group = created;
            }
            group.clients.add(frame.clientId);
            clients.set(frame.clientId, group);
            yield* Queue.offer(group.queue, { type: "open", clientId: frame.clientId });
            return;
          }
          const client = clients.get(frame.clientId);
          if (!client) {
            if (frame.type === "data")
              yield* channel.send({ type: "closed", clientId: frame.clientId });
            return;
          }
          yield* Queue.offer(client.queue, frame);
        }),
      ),
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach([...groups.values()], (group) => dispose(group), { discard: true }),
        ),
      ),
      Effect.forkScoped,
    );
  });

class InvalidDirectRpcFrame extends Schema.TaggedErrorClass<InvalidDirectRpcFrame>()(
  "InvalidDirectRpcFrame",
  {},
) {}

/** Carries the existing RPC protocol over a desktop-owned direct channel. */
export const makeDirectRpcProtocol = (
  channel: DirectRpcChannel,
  options?: { readonly preventReopen?: boolean },
): Effect.Effect<RpcServer.Protocol["Service"], never, Scope.Scope> =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const disconnects = yield* Queue.unbounded<number>();
      const clients = new Map<number, RpcSerialization.Parser>();
      const usedClientIds = new Set<number>();

      const close = (clientId: number, notify: boolean) =>
        Effect.gen(function* () {
          if (clients.delete(clientId)) yield* Queue.offer(disconnects, clientId);
          if (notify) yield* channel.send({ type: "closed", clientId });
        });

      yield* channel.incoming.pipe(
        Stream.runForEach((frame) =>
          Effect.gen(function* () {
            if (frame.type === "open") {
              if (clients.has(frame.clientId)) {
                yield* channel.send({ type: "opened", clientId: frame.clientId });
                return;
              }
              if (options?.preventReopen !== false && usedClientIds.has(frame.clientId)) {
                yield* channel.send({ type: "closed", clientId: frame.clientId });
                return;
              }
              if (options?.preventReopen !== false) usedClientIds.add(frame.clientId);
              clients.set(frame.clientId, RpcSerialization.json.makeUnsafe());
              yield* channel.send({ type: "opened", clientId: frame.clientId });
              return;
            }
            if (frame.type === "close") {
              yield* close(frame.clientId, true);
              return;
            }
            const parser = clients.get(frame.clientId);
            if (!parser) {
              yield* channel.send({ type: "closed", clientId: frame.clientId });
              return;
            }
            const decoded = yield* Effect.try({
              try: () => parser.decode(frame.data) as ReadonlyArray<RpcMessage.FromClientEncoded>,
              catch: () => new InvalidDirectRpcFrame(),
            }).pipe(Effect.option);
            if (decoded._tag === "None") {
              yield* close(frame.clientId, true);
              return;
            }
            yield* Effect.forEach(
              decoded.value,
              (message) => writeRequest(frame.clientId, message),
              {
                discard: true,
              },
            );
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            for (const clientId of clients.keys()) yield* close(clientId, false);
          }),
        ),
        Effect.forkScoped,
      );

      return {
        disconnects,
        send: (clientId, response) => {
          const parser = clients.get(clientId);
          if (!parser) return Effect.void;
          const data = parser.encode(response);
          if (data === undefined) return Effect.void;
          return channel.send({
            type: "data",
            clientId,
            data: typeof data === "string" ? data : new TextDecoder().decode(data),
          });
        },
        end: (clientId) => close(clientId, true),
        clientIds: Effect.sync(() => new Set(clients.keys())),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
      };
    }),
  );
