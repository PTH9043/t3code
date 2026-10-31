// @effect-diagnostics nodeBuiltinImport:off -- Electron protocol callbacks use Node streams.
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import * as NodeTimersPromises from "node:timers/promises";

const pipeAgent = new NodeHttp.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });

const HMR_CLIENT = String.raw`
export class DesktopViteSocket extends EventTarget {
  OPEN = 1;
  readyState = 0;
  constructor(url, protocol) {
    super();
    this.url = url;
    this.protocol = protocol;
    this.id = crypto.randomUUID();
    this.abort = new AbortController();
    void this.connect();
  }
  async connect() {
    try {
      const response = await fetch('/@t3/hmr?id=' + this.id, { signal: this.abort.signal });
      if (!response.ok || !response.body) throw new Error('Desktop development pipe unavailable');
      if (this.readyState === 3) return;
      this.readyState = this.OPEN;
      this.dispatchEvent(new Event('open'));
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = '';
      while (this.readyState === this.OPEN) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += value;
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const data = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (data) this.dispatchEvent(new MessageEvent('message', { data }));
        }
      }
    } catch (error) {
      if (this.readyState !== 3) this.dispatchEvent(new Event('error'));
    } finally {
      this.close();
    }
  }
  send(data) {
    if (this.readyState !== this.OPEN) return;
    void fetch('/@t3/hmr?id=' + this.id, { method: 'POST', body: data, signal: this.abort.signal })
      .catch(() => this.close());
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.abort.abort();
    this.dispatchEvent(new Event('close'));
  }
}
`;

async function requestOnce(pipe: string, token: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/@t3/desktop-hmr.js") {
    return new Response(HMR_CLIENT, { headers: { "content-type": "text/javascript" } });
  }
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    !(url.pathname === "/@t3/hmr" && request.method === "POST")
  ) {
    return new Response(null, { status: 405 });
  }
  const headers: Record<string, string> = {
    host: "localhost",
    "x-t3-desktop-dev-token": token,
  };
  for (const name of ["accept", "content-type", "if-modified-since", "if-none-match"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  const body = request.method === "POST" ? Buffer.from(await request.arrayBuffer()) : undefined;
  if (body && body.length > 1024 * 1024) return new Response(null, { status: 413 });
  const response = await new Promise<Response>((resolve, reject) => {
    const outgoing = NodeHttp.request(
      {
        socketPath: pipe,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        agent: pipeAgent,
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") responseHeaders.set(name, value);
          else if (value) for (const item of value) responseHeaders.append(name, item);
        }
        const stream =
          request.method === "HEAD" || incoming.statusCode === 204 || incoming.statusCode === 304
            ? null
            : (NodeStream.Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(
          new Response(stream, { status: incoming.statusCode ?? 502, headers: responseHeaders }),
        );
      },
    );
    outgoing.once("error", reject);
    request.signal.addEventListener("abort", () => outgoing.destroy(), { once: true });
    outgoing.end(body);
  });
  if (url.pathname !== "/@vite/client" || !response.ok || request.method !== "GET") return response;
  const source = await response.text();
  const workerGuard = 'typeof SharedWorker === "undefined"';
  if (!source.includes(workerGuard) || !source.includes("new WebSocket(")) {
    throw new Error("Unsupported Vite HMR client; refusing network fallback.");
  }
  const headersOut = new Headers(response.headers);
  headersOut.delete("content-length");
  headersOut.delete("etag");
  return new Response(
    `import { DesktopViteSocket as WebSocket } from "/@t3/desktop-hmr.js";\n${source.replace(workerGuard, "true")}`,
    { status: response.status, headers: headersOut },
  );
}

export async function desktopDevPipeRequest(
  pipe: string,
  token: string,
  request: Request,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await requestOnce(pipe, token, request);
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const startupFailure = code === "ENOENT" || code === "ECONNREFUSED";
      const retryableReset = code === "ECONNRESET" && request.method !== "POST" && attempt < 3;
      if (request.signal.aborted || (!startupFailure && !retryableReset)) break;
      await NodeTimersPromises.setTimeout(150);
    }
  }
  throw lastError;
}
