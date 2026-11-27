// @effect-diagnostics nodeBuiltinImport:off - The relay belongs to the detached watchdog process.
// @effect-diagnostics globalDate:off - This socket boundary uses real elapsed time.
// @effect-diagnostics globalFetch:off - The relay forwards the HTTP protocol inside a detached Node process.
import * as Http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  WATCHDOG_OFFLINE_TOOL_MESSAGE,
  type WatchdogOfflineToolResult,
  type WatchdogRelayFallback,
} from "./WatchdogOfflineTools.ts";

const RETRY_INTERVAL_MS = 250;
const RECONNECT_WINDOW_MS = 120_000;
const FALLBACK_GRACE_MS = 5_000;
const INITIALIZE_LIMIT = 256 * 1024;
const BODY_LIMIT = 32 * 1024 * 1024;

type Session = {
  readonly initialize: Buffer;
  /** Absent for a session the relay opened locally while the backend was down. */
  upstreamId: string | undefined;
  protocolVersion: string;
  renewing?: Promise<void>;
};

type RpcMessage = { readonly id?: unknown; readonly method?: unknown; readonly params?: unknown };

/** The backend could not be reached, so nothing was delivered to it. */
class UpstreamUnreachable extends Error {}

const parseMessage = (body: Buffer): RpcMessage | undefined => {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as RpcMessage)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Accept both JSON and SSE-framed JSON-RPC replies. */
function rpcResult(contentType: string | null | undefined, data: Buffer, id: unknown): unknown {
  const text = data.toString("utf8");
  const payloads = contentType?.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [text];
  for (const payload of payloads) {
    try {
      const message: unknown = JSON.parse(payload);
      if (
        message &&
        typeof message === "object" &&
        "id" in message &&
        message.id === id &&
        "result" in message
      )
        return message.result;
    } catch {
      /* Ignore non-JSON frames. */
    }
  }
  return undefined;
}

/**
 * Provide a stable MCP session to one watchdog while the backend restarts or is off.
 * Only initialization and read-only ping are retried. A tool request is sent
 * exactly once after a live upstream session is established; an ambiguous
 * disconnect after that point is returned to the caller without replay.
 *
 * When the backend is unreachable (no live session could be established, or the
 * connection for the request itself was refused), the request was certainly not
 * delivered. Only then the relay answers locally: `fallback` tools run in this
 * process, every other tool returns an offline tool error, and tools/list is
 * served from the last list the backend returned. The relay keeps doing this
 * indefinitely and re-initializes upstream as soon as the backend answers again.
 */
export async function startWatchdogMcpRelay(input: {
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly fallback?: WatchdogRelayFallback;
  /** How long a request without a local answer waits for the backend to return. */
  readonly reconnectWindowMs?: number;
  /** How long a request with a local answer waits before using it. */
  readonly fallbackGraceMs?: number;
}): Promise<{
  readonly endpoint: string;
  readonly ready: Promise<boolean>;
  readonly close: () => Promise<void>;
}> {
  const target = new URL(input.endpoint);
  if (
    target.protocol !== "http:" ||
    target.username ||
    target.password ||
    !input.authorizationHeader
  )
    throw new Error("Unsupported watchdog MCP endpoint");
  const reconnectWindowMs = input.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
  const fallbackGraceMs = Math.min(input.fallbackGraceMs ?? FALLBACK_GRACE_MS, reconnectWindowMs);
  const expectedAuth = Buffer.from(input.authorizationHeader);
  const sessions = new Map<string, Session>();
  const sockets = new Set<import("node:net").Socket>();
  const shutdown = new AbortController();
  const ready = Promise.withResolvers<boolean>();
  let toolsAreReady = false;
  let offlineSince: number | undefined;
  let cachedInitialize: { readonly result: unknown; readonly protocolVersion: string } | undefined;
  let cachedTools: unknown;
  const headers = (sessionId?: string, protocolVersion?: string) => ({
    authorization: input.authorizationHeader,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
  });

  /** A request waits until the reconnect window that began with the first failure closes. */
  const waitBudget = (grace: number) =>
    offlineSince === undefined
      ? grace
      : Math.max(0, Math.min(grace, offlineSince + reconnectWindowMs - Date.now()));

  async function control(
    body: string | Buffer,
    sessionId: string | undefined,
    signal: AbortSignal,
    waitMs: number,
    protocolVersion?: string,
  ) {
    const deadline = Date.now() + waitMs;
    while (true) {
      try {
        const response = await fetch(target, {
          method: "POST",
          headers: headers(sessionId, protocolVersion),
          body,
          redirect: "error",
          signal: AbortSignal.any([signal, shutdown.signal, AbortSignal.timeout(10_000)]),
        });
        const data = Buffer.from(await response.arrayBuffer());
        offlineSince = undefined;
        return { status: response.status, headers: response.headers, data };
      } catch (error) {
        if (signal.aborted || shutdown.signal.aborted) throw error;
        offlineSince ??= Date.now();
        if (Date.now() >= deadline)
          throw new UpstreamUnreachable("Watchdog MCP backend is unreachable");
        await delay(RETRY_INTERVAL_MS, undefined, {
          signal: AbortSignal.any([signal, shutdown.signal]),
        });
      }
    }
  }

  async function ensureSession(
    session: Session,
    signal: AbortSignal,
    waitMs: number,
  ): Promise<void> {
    const checkedId = session.upstreamId;
    if (checkedId) {
      const check = await control(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `t3-ping-${randomUUID()}`,
          method: "ping",
          params: {},
        }),
        checkedId,
        signal,
        waitMs,
        session.protocolVersion,
      );
      if (check.status === 200) return;
      if (check.status !== 404) throw new Error("Watchdog MCP session check failed");
      if (session.upstreamId !== checkedId) return;
    }
    session.renewing ??= (async () => {
      const initialized = await control(session.initialize, undefined, signal, waitMs);
      const nextId = initialized.headers.get("mcp-session-id");
      const nextVersion = initialized.headers.get("mcp-protocol-version");
      if (initialized.status !== 200 || !nextId || !nextVersion)
        throw new Error("Watchdog MCP initialization failed");
      const notification = await control(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        nextId,
        signal,
        waitMs,
        nextVersion,
      );
      if (notification.status !== 202 && notification.status !== 204)
        throw new Error("Watchdog MCP initialization notification failed");
      session.upstreamId = nextId;
      session.protocolVersion = nextVersion;
    })().finally(() => {
      delete session.renewing;
    });
    await session.renewing;
  }

  const canFallback = (message: RpcMessage | undefined) => {
    if (!message || message.method !== "tools/call") return false;
    const params = message.params;
    const name = params && typeof params === "object" && "name" in params ? params.name : undefined;
    return typeof name === "string" && (input.fallback?.tools.has(name) ?? false);
  };

  const sendJson = (response: Http.ServerResponse, value: unknown) =>
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));

  const toolResult = (result: WatchdogOfflineToolResult) => ({
    content: [{ type: "text", text: result.text }],
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError ? { isError: true } : {}),
  });

  /** Answer a message the backend never received. */
  async function answerOffline(
    request: Http.IncomingMessage,
    response: Http.ServerResponse,
    message: RpcMessage | undefined,
    signal: AbortSignal,
  ) {
    if (request.method === "GET") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    if (request.method === "DELETE") {
      const clientId = request.headers["mcp-session-id"];
      if (typeof clientId === "string") sessions.delete(clientId);
      response.writeHead(200).end();
      return;
    }
    if (!message || message.id === undefined || typeof message.method !== "string") {
      // Notifications and client responses have no reply to give.
      response.writeHead(202).end();
      return;
    }
    const reply = (result: unknown) =>
      sendJson(response, { jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "ping":
        reply({});
        return;
      case "tools/list":
        if (cachedTools !== undefined) {
          toolsAreReady = true;
          ready.resolve(true);
          reply(cachedTools);
          return;
        }
        break;
      case "tools/call": {
        const params = (message.params ?? {}) as {
          readonly name?: unknown;
          readonly arguments?: unknown;
        };
        const name = typeof params.name === "string" ? params.name : "";
        const result =
          input.fallback && input.fallback.tools.has(name)
            ? await input.fallback.call(name, params.arguments ?? {}, signal)
            : { text: WATCHDOG_OFFLINE_TOOL_MESSAGE, isError: true };
        if (!response.destroyed) reply(toolResult(result));
        return;
      }
    }
    sendJson(response, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: WATCHDOG_OFFLINE_TOOL_MESSAGE },
    });
  }

  async function readBody(request: Http.IncomingMessage, limit: number) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const part = Buffer.from(chunk);
      size += part.length;
      if (size > limit) return undefined;
      chunks.push(part);
    }
    return Buffer.concat(chunks);
  }

  const server = Http.createServer((request, response) => {
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    void (async () => {
      const actualAuth = Buffer.from(request.headers.authorization ?? "");
      if (actualAuth.length !== expectedAuth.length || !timingSafeEqual(actualAuth, expectedAuth)) {
        response.writeHead(401).end();
        return;
      }
      if (request.url !== `${target.pathname}${target.search}`) {
        response.writeHead(404).end();
        return;
      }
      const clientId = request.headers["mcp-session-id"];
      if (request.method === "POST" && typeof clientId !== "string") {
        const body = await readBody(request, INITIALIZE_LIMIT);
        if (!body) throw new Error("MCP initialization is too large");
        const parsed = parseMessage(body);
        if (!parsed || parsed.method !== "initialize") {
          response.writeHead(400).end();
          return;
        }
        let initialized;
        try {
          initialized = await control(
            body,
            undefined,
            controller.signal,
            waitBudget(cachedInitialize ? fallbackGraceMs : reconnectWindowMs),
          );
        } catch (error) {
          if (!(error instanceof UpstreamUnreachable) || !cachedInitialize) throw error;
          const localId = randomUUID();
          sessions.set(localId, {
            initialize: body,
            upstreamId: undefined,
            protocolVersion: cachedInitialize.protocolVersion,
          });
          response
            .writeHead(200, {
              "content-type": "application/json",
              "mcp-session-id": localId,
              "mcp-protocol-version": cachedInitialize.protocolVersion,
            })
            .end(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: cachedInitialize.result }),
            );
          return;
        }
        const sessionId = initialized.headers.get("mcp-session-id");
        const protocolVersion = initialized.headers.get("mcp-protocol-version");
        if (initialized.status === 200 && sessionId && protocolVersion) {
          sessions.set(sessionId, { initialize: body, upstreamId: sessionId, protocolVersion });
          const result = rpcResult(
            initialized.headers.get("content-type"),
            initialized.data,
            parsed.id,
          );
          if (result !== undefined) cachedInitialize = { result, protocolVersion };
        }
        const outgoing: Record<string, string> = {};
        for (const key of ["content-type", "mcp-session-id", "mcp-protocol-version"])
          if (initialized.headers.has(key)) outgoing[key] = initialized.headers.get(key)!;
        response.writeHead(initialized.status, outgoing).end(initialized.data);
        return;
      }
      if (typeof clientId !== "string") {
        response.writeHead(400).end();
        return;
      }
      const session = sessions.get(clientId);
      if (!session) {
        response.writeHead(404).end();
        return;
      }
      let body: Buffer | undefined;
      if (request.method === "POST") {
        body = await readBody(request, BODY_LIMIT);
        if (!body) {
          response.writeHead(413).end();
          return;
        }
      }
      const message = body ? parseMessage(body) : undefined;
      const hasLocalAnswer =
        canFallback(message) ||
        request.method !== "POST" ||
        message?.method === "tools/list" ||
        message?.method === "ping" ||
        message?.id === undefined;
      try {
        await ensureSession(
          session,
          controller.signal,
          waitBudget(hasLocalAnswer ? fallbackGraceMs : reconnectWindowMs),
        );
      } catch (error) {
        if (!(error instanceof UpstreamUnreachable)) throw error;
        await answerOffline(request, response, message, controller.signal);
        return;
      }
      if (controller.signal.aborted) return;
      const forwardedHeaders: Http.OutgoingHttpHeaders = {
        ...request.headers,
        host: target.host,
        "mcp-session-id": session.upstreamId,
        "mcp-protocol-version": session.protocolVersion,
      };
      delete forwardedHeaders.connection;
      if (body) forwardedHeaders["content-length"] = String(body.length);
      delete forwardedHeaders["transfer-encoding"];
      const capturesTools = message?.method === "tools/list";
      let connected = false;
      const upstream = Http.request(
        target,
        { method: request.method, headers: forwardedHeaders, agent: false },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          const captured: Buffer[] = [];
          if (capturesTools) reply.on("data", (chunk: Buffer) => captured.push(Buffer.from(chunk)));
          reply.once("end", () => {
            if (reply.statusCode === 200 && capturesTools) {
              const tools = rpcResult(
                reply.headers["content-type"],
                Buffer.concat(captured),
                message.id,
              );
              if (tools !== undefined) cachedTools = tools;
              if (!toolsAreReady) {
                toolsAreReady = true;
                ready.resolve(true);
              }
            }
          });
          reply.pipe(response);
          reply.on("error", () => response.destroy());
        },
      );
      upstream.once("socket", (socket) => {
        if (!socket.connecting) connected = true;
        else socket.once("connect", () => (connected = true));
      });
      upstream.on("error", () => {
        if (!connected && !response.headersSent && !controller.signal.aborted) {
          // The connection was never opened, so the backend received nothing.
          offlineSince ??= Date.now();
          void answerOffline(request, response, message, controller.signal).catch(() => {
            if (!response.headersSent) response.writeHead(503).end();
          });
          return;
        }
        if (!response.headersSent) response.writeHead(502).end();
        else response.destroy();
      });
      response.once("close", () => upstream.destroy());
      upstream.end(body);
    })().catch(() => {
      if (!response.headersSent && !response.destroyed) response.writeHead(503).end();
      else response.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Relay has no local port");
  }
  const exposed = new URL(target);
  exposed.hostname = "127.0.0.1";
  exposed.port = String(address.port);
  return {
    endpoint: exposed.toString(),
    ready: ready.promise,
    close: () =>
      new Promise<void>((resolve) => {
        shutdown.abort();
        ready.resolve(false);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
