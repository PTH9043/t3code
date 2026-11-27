/**
 * Loopback compatibility proxy for Antseed Gateway (`t3_antseed`).
 *
 * Some Antseed network peers (e.g. `deepseek/deepseek-v4.1-flash-1017`) emit
 * structured thinking block arrays inside OpenAI `choices[].delta.content`
 * (and `choices[].message.content`), such as:
 *   `[{"type":"thinking","thinking":[{"type":"text","text":"Let"}],"closed":true}]`
 *
 * OpenCode's `@ai-sdk/openai-compatible` Zod schema strictly requires
 * `delta.content` to be `string | null`, causing immediate stream failure
 * (`Type validation failed: expected string, received array`).
 *
 * This scoped loopback proxy transparently forwards all requests to the
 * configured Antseed Gateway and normalizes array-valued `content` payloads
 * into standard OpenAI `content` (`string | null`) + `reasoning_content`.
 *
 * @module provider/antseedCompatProxy
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

export class AntseedCompatProxyError extends Data.TaggedError("AntseedCompatProxyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractNestedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let out = "";
    for (const item of value) {
      out += extractNestedText(item);
    }
    return out;
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.thinking === "string") return value.thinking;
    if (Array.isArray(value.thinking)) return extractNestedText(value.thinking);
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return extractNestedText(value.content);
  }
  return "";
}

function normalizeStructuredContentArray(items: ReadonlyArray<unknown>): {
  readonly text: string;
  readonly reasoning: string;
} {
  let text = "";
  let reasoning = "";
  for (const item of items) {
    if (typeof item === "string") {
      text += item;
      continue;
    }
    if (!isRecord(item)) continue;
    const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
    if (type === "thinking" || type === "reasoning" || type === "thought" || "thinking" in item) {
      reasoning += extractNestedText(item.thinking ?? item.reasoning ?? item.text ?? item.content);
    } else if (type === "text" || typeof item.text === "string") {
      text += extractNestedText(item.text ?? item.content);
    }
  }
  return { text, reasoning };
}

function normalizeChoiceMessageContainer(
  container: Record<string, unknown>,
  emptyContentValue: string | null,
): boolean {
  let changed = false;

  if (Array.isArray(container.content)) {
    const { text, reasoning } = normalizeStructuredContentArray(container.content);
    container.content = text.length > 0 ? text : emptyContentValue;
    if (reasoning.length > 0) {
      const existing =
        typeof container.reasoning_content === "string" ? container.reasoning_content : "";
      container.reasoning_content = existing + reasoning;
    }
    changed = true;
  }

  if (Array.isArray(container.reasoning_content)) {
    const { text, reasoning } = normalizeStructuredContentArray(container.reasoning_content);
    container.reasoning_content = reasoning + text;
    changed = true;
  }

  return changed;
}

/**
 * Normalizes a parsed OpenAI chat completion (chunk or full response) object in place.
 * Returns `true` if any non-standard array content field was rewritten.
 */
export function normalizeAntseedChatCompletionPayload(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return false;
  }
  let changed = false;
  for (const choice of payload.choices) {
    if (!isRecord(choice)) continue;
    if (isRecord(choice.delta) && normalizeChoiceMessageContainer(choice.delta, null)) {
      changed = true;
    }
    if (isRecord(choice.message) && normalizeChoiceMessageContainer(choice.message, "")) {
      changed = true;
    }
  }
  return changed;
}

/**
 * Normalizes a single JSON string body (either SSE `data:` payload or JSON response).
 * Returns the original string untouched if it needs no rewriting or is not JSON.
 */
export function normalizeAntseedJsonText(rawJson: string): string {
  const trimmed = rawJson.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"choices"')) {
    return rawJson;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return rawJson;
  }
  if (!normalizeAntseedChatCompletionPayload(parsed)) {
    return rawJson;
  }
  return JSON.stringify(parsed);
}

/**
 * Normalizes a single Server-Sent Events frame (terminated by `\n\n` or `\r\n\r\n`).
 */
export function normalizeAntseedSseEvent(eventBlock: string): string {
  if (!eventBlock.includes("data:")) {
    return eventBlock;
  }
  const newline = eventBlock.includes("\r\n") ? "\r\n" : "\n";
  const lines = eventBlock.split(/\r?\n/);
  const dataLines: string[] = [];
  const otherLines: string[] = [];
  let dataStartIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("data:")) {
      if (dataStartIndex < 0) dataStartIndex = otherLines.length;
      dataLines.push(line.slice(5).replace(/^ /, ""));
    } else {
      otherLines.push(line);
    }
  }

  if (dataLines.length === 0) return eventBlock;
  const joinedData = dataLines.join("\n").trim();
  if (!joinedData || joinedData === "[DONE]") {
    return eventBlock;
  }
  const normalizedData = normalizeAntseedJsonText(joinedData);
  if (normalizedData === joinedData) {
    return eventBlock;
  }

  const rebuilt = [...otherLines];
  rebuilt.splice(dataStartIndex, 0, `data: ${normalizedData}`);
  return rebuilt.join(newline);
}

/**
 * Streaming SSE normalizer that buffers across TCP chunk boundaries and flushes
 * complete SSE frames immediately without accumulating the full response.
 */
export function createAntseedSseStreamNormalizer(): {
  readonly push: (chunk: string) => string;
  readonly flush: () => string;
} {
  let buffer = "";
  const separatorPattern = /\r?\n\r?\n/;

  return {
    push(chunk: string): string {
      buffer += chunk;
      let out = "";
      while (true) {
        const match = separatorPattern.exec(buffer);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        const delimiter = match[0];
        buffer = buffer.slice(match.index + delimiter.length);
        out += normalizeAntseedSseEvent(frame) + delimiter;
      }
      return out;
    },
    flush(): string {
      if (!buffer) return "";
      const remaining = buffer;
      buffer = "";
      return normalizeAntseedSseEvent(remaining);
    },
  };
}

function buildUpstreamUrl(upstreamBaseUrl: string, incomingUrl: string | undefined): URL {
  const normalizedBase = upstreamBaseUrl.replace(/\/+$/, "");
  const raw = incomingUrl && incomingUrl.length > 0 ? incomingUrl : "/";
  const queryIndex = raw.indexOf("?");
  const rawPath = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const rawQuery = queryIndex >= 0 ? raw.slice(queryIndex) : "";
  const relativePath =
    rawPath === "/v1"
      ? ""
      : rawPath.startsWith("/v1/")
        ? rawPath.slice(3)
        : rawPath.startsWith("/")
          ? rawPath
          : `/${rawPath}`;
  return new URL(`${normalizedBase}${relativePath}${rawQuery}`);
}

function copyForwardRequestHeaders(
  headers: NodeHttp.IncomingHttpHeaders,
  upstreamHost: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "accept-encoding") continue;
    out[key] = value;
  }
  out.host = upstreamHost;
  // Request uncompressed responses so SSE/JSON payloads can be normalized cleanly.
  out["accept-encoding"] = "identity";
  return out;
}

function copyForwardResponseHeaders(
  headers: NodeHttp.IncomingHttpHeaders,
  omitContentLength: boolean,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "connection" || lower === "keep-alive" || lower === "transfer-encoding") continue;
    if (omitContentLength && lower === "content-length") continue;
    out[key] = value;
  }
  return out;
}

export interface AntseedCompatProxyHandle {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

/**
 * Starts a loopback HTTP proxy that forwards to `upstreamBaseUrl` (already normalized to `.../v1`)
 * and normalizes Antseed's array-valued thinking content chunks into standard OpenAI responses.
 */
export async function createAntseedCompatProxyServer(
  upstreamBaseUrl: string,
): Promise<AntseedCompatProxyHandle> {
  const server = NodeHttp.createServer((req, res) => {
    let targetUrl: URL;
    try {
      targetUrl = buildUpstreamUrl(upstreamBaseUrl, req.url);
    } catch {
      res.statusCode = 400;
      res.end("Invalid upstream request URL");
      return;
    }

    const transport = targetUrl.protocol === "https:" ? NodeHttps : NodeHttp;
    const upstreamReq = transport.request(
      targetUrl,
      {
        method: req.method ?? "GET",
        headers: copyForwardRequestHeaders(req.headers, targetUrl.host),
      },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode ?? 502;
        const contentType = String(upstreamRes.headers["content-type"] ?? "").toLowerCase();
        const isSse = contentType.includes("text/event-stream");
        const isJson = contentType.includes("application/json");

        if (isSse) {
          res.writeHead(statusCode, copyForwardResponseHeaders(upstreamRes.headers, true));
          const normalizer = createAntseedSseStreamNormalizer();
          upstreamRes.setEncoding("utf8");
          upstreamRes.on("data", (chunk: string) => {
            const out = normalizer.push(chunk);
            if (out.length > 0 && !res.destroyed) {
              res.write(out);
            }
          });
          upstreamRes.on("end", () => {
            const tail = normalizer.flush();
            if (tail.length > 0 && !res.destroyed) {
              res.write(tail);
            }
            if (!res.destroyed) {
              res.end();
            }
          });
          upstreamRes.on("error", () => {
            if (!res.destroyed) {
              res.end();
            }
          });
          return;
        }

        if (isJson) {
          const chunks: Buffer[] = [];
          upstreamRes.on("data", (chunk: Buffer | string) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
          });
          upstreamRes.on("end", () => {
            if (res.destroyed) return;
            const rawText = Buffer.concat(chunks).toString("utf8");
            const normalized = normalizeAntseedJsonText(rawText);
            const body = Buffer.from(normalized, "utf8");
            const headers = copyForwardResponseHeaders(upstreamRes.headers, true);
            headers["content-length"] = String(body.byteLength);
            res.writeHead(statusCode, headers);
            res.end(body);
          });
          upstreamRes.on("error", () => {
            if (!res.destroyed) {
              res.statusCode = 502;
              res.end();
            }
          });
          return;
        }

        res.writeHead(statusCode, copyForwardResponseHeaders(upstreamRes.headers, false));
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `Antseed compatibility proxy upstream error: ${error.message}`,
              type: "proxy_error",
            },
          }),
        );
      } else if (!res.destroyed) {
        res.end();
      }
    });

    req.on("aborted", () => {
      upstreamReq.destroy();
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        upstreamReq.destroy();
      }
    });

    req.pipe(upstreamReq);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Antseed compatibility proxy failed to bind a loopback TCP port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Effect-scoped lifecycle wrapper for `createAntseedCompatProxyServer`.
 * Automatically closes the loopback proxy when the provider instance scope closes.
 */
export const acquireAntseedCompatProxy = (
  upstreamBaseUrl: string,
): Effect.Effect<AntseedCompatProxyHandle, AntseedCompatProxyError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createAntseedCompatProxyServer(upstreamBaseUrl),
      catch: (cause) =>
        new AntseedCompatProxyError({
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to start Antseed proxy: ${String(cause)}`,
          cause,
        }),
    }),
    (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
  );
