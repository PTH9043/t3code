// @effect-diagnostics preferSchemaOverJson:off -- The private pipe uses Effect RPC JSON frames.
import type { DesktopDirectRpcOutput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DesktopDirectRpcHub } from "./DesktopDirectRpcHub.ts";

export function selectDirectHttpBearerToken(
  request: Request,
  backendId: string | undefined,
  selectedToken: string | undefined,
): string | undefined {
  if (backendId !== undefined && backendId !== "primary") return undefined;
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/google/challenge" || path === "/api/auth/google/token") return undefined;
  return selectedToken;
}

const OWNER = -1;
const REQUEST_ID = "http";

/** Routes a renderer request through the private pipe without a network socket. */
export async function directHttpRequest(
  hub: DesktopDirectRpcHub["Service"],
  request: Request,
  backendId?: string,
  bearerToken?: string,
): Promise<Response> {
  const url = new URL(request.url);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : Buffer.from(await request.arrayBuffer()).toString("base64");
  const headers = Array.from(request.headers, ([name, value]) => ({ name, value }));

  return await new Promise<Response>((resolve, reject) => {
    let clientId: number | undefined;
    let resolved = false;
    let finished = false;
    let pendingAck = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let sendChain = Promise.resolve();
    const earlyFrames: DesktopDirectRpcOutput[] = [];

    const close = () => {
      if (finished) return;
      finished = true;
      request.signal.removeEventListener("abort", abort);
      if (clientId !== undefined) void Effect.runPromise(hub.close(OWNER, clientId));
    };
    const fail = (error: Error) => {
      if (finished) return;
      if (resolved) controller?.error(error);
      else reject(error);
      close();
    };
    const abort = () => fail(new Error("Local request cancelled."));
    const send = (message: object) => {
      if (clientId === undefined || finished) return;
      const id = clientId;
      sendChain = sendChain
        .then(() => Effect.runPromise(hub.send(OWNER, id, JSON.stringify(message))))
        .catch(() => fail(new Error("Local connection closed.")));
    };
    const ack = () => {
      pendingAck = false;
      send({ _tag: "Ack", requestId: REQUEST_ID });
    };
    const receive = (frame: DesktopDirectRpcOutput) => {
      if (finished) return;
      if (clientId === undefined) {
        earlyFrames.push(frame);
        return;
      }
      if (frame.clientId !== clientId) return;
      if (frame.type === "closed") {
        fail(new Error("Local connection closed."));
        return;
      }
      if (frame.type === "opened") {
        send({
          _tag: "Request",
          id: REQUEST_ID,
          tag: "desktop.directHttp",
          payload: {
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers,
            ...(body === undefined ? {} : { body }),
          },
          headers: [],
        });
        return;
      }
      try {
        const message = JSON.parse(frame.data) as {
          _tag: string;
          requestId?: string;
          values?: Array<{
            type: string;
            status?: number;
            statusText?: string;
            headers?: Array<{ name: string; value: string }>;
            data?: string;
          }>;
          exit?: { _tag: string };
        };
        if (message.requestId !== REQUEST_ID) return;
        if (message._tag === "Chunk") {
          for (const part of message.values ?? []) {
            if (part.type === "headers" && !resolved && part.status !== undefined) {
              const responseHeaders = new Headers();
              for (const entry of part.headers ?? [])
                responseHeaders.append(entry.name, entry.value);
              const allowsBody =
                request.method !== "HEAD" && ![204, 205, 304].includes(part.status);
              const stream = allowsBody
                ? new ReadableStream<Uint8Array>({
                    start: (next) => {
                      controller = next;
                    },
                    pull: () => {
                      if (pendingAck) ack();
                    },
                    cancel: close,
                  })
                : null;
              resolved = true;
              resolve(
                new Response(stream, {
                  status: part.status,
                  statusText: part.statusText ?? "",
                  headers: responseHeaders,
                }),
              );
            } else if (part.type === "chunk" && typeof part.data === "string" && controller) {
              controller.enqueue(new Uint8Array(Buffer.from(part.data, "base64")));
            }
          }
          if (controller && (controller.desiredSize ?? 0) <= 0) pendingAck = true;
          else ack();
        } else if (message._tag === "Exit") {
          if (message.exit?._tag !== "Success" || !resolved) {
            fail(new Error("Local request failed."));
          } else {
            controller?.close();
            close();
          }
        }
      } catch {
        fail(new Error("Invalid local response."));
      }
    };

    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return;
    }
    void Effect.runPromise(hub.open(OWNER, receive, backendId, bearerToken)).then(
      (id) => {
        clientId = id;
        if (finished) {
          void Effect.runPromise(hub.close(OWNER, id));
          return;
        }
        for (const frame of earlyFrames) receive(frame);
      },
      () => fail(new Error("Local connection is unavailable.")),
    );
  });
}
