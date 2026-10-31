import {
  DESKTOP_DIRECT_RPC_QUEUE_CAPACITY,
  DesktopDirectRpcInput,
  type DesktopDirectRpcOutput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class DesktopDirectRpcError extends Schema.TaggedErrorClass<DesktopDirectRpcError>()(
  "DesktopDirectRpcError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

type Deliver = (frame: DesktopDirectRpcOutput) => void;
interface Client {
  readonly owner: number;
  readonly deliver: Deliver;
}
interface Generation {
  readonly backendId: string;
  readonly queue: Queue.Queue<DesktopDirectRpcInput>;
  readonly clients: Map<number, Client>;
}

export interface DesktopDirectRpcAttachment {
  readonly encoded: Stream.Stream<Uint8Array>;
  readonly receive: (frame: DesktopDirectRpcOutput) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export class DesktopDirectRpcHub extends Context.Service<
  DesktopDirectRpcHub,
  {
    readonly attach: Effect.Effect<DesktopDirectRpcAttachment, never, Scope.Scope>;
    readonly attachBackend: (
      backendId: string,
    ) => Effect.Effect<DesktopDirectRpcAttachment, never, Scope.Scope>;
    readonly open: (
      owner: number,
      deliver: Deliver,
      backendId?: string,
      bearerToken?: string,
    ) => Effect.Effect<number, DesktopDirectRpcError>;
    readonly send: (
      owner: number,
      clientId: number,
      data: string,
    ) => Effect.Effect<void, DesktopDirectRpcError>;
    readonly close: (owner: number, clientId: number) => Effect.Effect<void>;
    readonly closeOwner: (owner: number) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/backend/DesktopDirectRpcHub") {}

const encodeInput = Schema.encodeSync(Schema.fromJsonString(DesktopDirectRpcInput));
const unavailable = () =>
  new DesktopDirectRpcError({ detail: "로컬 직접 연결을 사용할 수 없습니다." });

export const make = Effect.sync(() => {
  const current = new Map<string, Generation>();
  const clients = new Map<number, Generation>();
  let nextClientId = 0;

  const notify = (client: Client, frame: DesktopDirectRpcOutput) => {
    try {
      client.deliver(frame);
    } catch {
      // A destroyed renderer cannot receive a final status.
    }
  };
  const retire = (generation: Generation) =>
    Effect.gen(function* () {
      if (current.get(generation.backendId) === generation) current.delete(generation.backendId);
      for (const [clientId, client] of generation.clients) {
        clients.delete(clientId);
        notify(client, { type: "closed", clientId });
      }
      generation.clients.clear();
      yield* Queue.shutdown(generation.queue);
    });

  const attachBackend = (backendId: string) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const previous = current.get(backendId);
        if (previous) yield* retire(previous);
        const generation: Generation = {
          backendId,
          queue: yield* Queue.bounded<DesktopDirectRpcInput>(DESKTOP_DIRECT_RPC_QUEUE_CAPACITY),
          clients: new Map(),
        };
        current.set(backendId, generation);
        return generation;
      }),
      retire,
    ).pipe(
      Effect.map(
        (generation): DesktopDirectRpcAttachment => ({
          encoded: Stream.fromQueue(generation.queue).pipe(
            Stream.map((frame) => `${encodeInput(frame)}\n`),
            Stream.encodeText,
          ),
          receive: (frame) =>
            Effect.sync(() => {
              if (current.get(backendId) !== generation) return;
              const client = generation.clients.get(frame.clientId);
              if (!client) return;
              if (frame.type === "closed") {
                generation.clients.delete(frame.clientId);
                clients.delete(frame.clientId);
              }
              notify(client, frame);
            }),
          close: retire(generation),
        }),
      ),
    );

  const open = (owner: number, deliver: Deliver, backendId = "primary", bearerToken?: string) =>
    Effect.gen(function* () {
      const generation = current.get(backendId);
      if (!generation) return yield* unavailable();
      const clientId = nextClientId++;
      generation.clients.set(clientId, { owner, deliver });
      clients.set(clientId, generation);
      const accepted = yield* Queue.offer(generation.queue, {
        type: "open",
        clientId,
        ...(bearerToken === undefined ? {} : { bearerToken }),
      });
      if (!accepted || current.get(backendId) !== generation) {
        generation.clients.delete(clientId);
        clients.delete(clientId);
        return yield* unavailable();
      }
      return clientId;
    });

  const send = (owner: number, clientId: number, data: string) =>
    Effect.gen(function* () {
      const generation = clients.get(clientId);
      if (!generation || generation.clients.get(clientId)?.owner !== owner) {
        return yield* unavailable();
      }
      const accepted = yield* Queue.offer(generation.queue, { type: "data", clientId, data });
      if (!accepted || current.get(generation.backendId) !== generation)
        return yield* unavailable();
    });

  const close = (owner: number, clientId: number) =>
    Effect.gen(function* () {
      const generation = clients.get(clientId);
      const client = generation?.clients.get(clientId);
      if (!generation || !client || client.owner !== owner) return;
      generation.clients.delete(clientId);
      clients.delete(clientId);
      notify(client, { type: "closed", clientId });
      yield* Queue.offer(generation.queue, { type: "close", clientId });
    });

  const closeOwner = (owner: number) =>
    Effect.gen(function* () {
      for (const generation of current.values()) {
        for (const [clientId, client] of generation.clients) {
          if (client.owner === owner) yield* close(owner, clientId);
        }
      }
    });

  return DesktopDirectRpcHub.of({
    attach: attachBackend("primary"),
    attachBackend,
    open,
    send,
    close,
    closeOwner,
  });
});

export const layer = Layer.effect(DesktopDirectRpcHub, make);
