// @effect-diagnostics nodeBuiltinImport:off -- Vite plugins use Node server callbacks.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";

import {
  DevEnvironment,
  type HotChannel,
  type HotChannelClient,
  type HotPayload,
  type Plugin,
} from "vite-plus";

/** Allows the desktop renderer to use the existing Vite instance without TCP. */
export function desktopDevPipePlugin(): Plugin {
  const pipe = process.env.T3CODE_DESKTOP_DEV_PIPE;
  const token = process.env.T3CODE_DESKTOP_DEV_PIPE_TOKEN;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Vite invokes this plugin outside Effect.
  const enabled = process.platform === "win32" && !!pipe && !!token;
  const events = new NodeEvents.EventEmitter();
  const clients = new Map<string, NodeHttp.ServerResponse>();
  let closePipe: (() => void) | undefined;

  function send(response: NodeHttp.ServerResponse, payload: HotPayload) {
    if (!response.destroyed) response.write(`${JSON.stringify(payload)}\n`);
  }

  return {
    name: "t3code:desktop-dev-pipe",
    apply: "serve",
    config() {
      if (!enabled) return;
      return {
        environments: {
          client: {
            dev: {
              createEnvironment(name, config, { ws }) {
                const channel: HotChannel = {
                  send(payload) {
                    ws.send(payload);
                    for (const response of clients.values()) send(response, payload);
                  },
                  on(event: string, listener: (data: unknown, client: HotChannelClient) => void) {
                    ws.on(event, listener);
                    events.on(event, listener);
                  },
                  off(event, listener) {
                    ws.off(event, listener);
                    events.off(event, listener as (...args: unknown[]) => void);
                  },
                  listen: () => ws.listen(),
                  close: () => {},
                };
                const context: ConstructorParameters<typeof DevEnvironment>[2] & {
                  readonly disableFetchModule: boolean;
                } = {
                  hot: true,
                  transport: channel,
                  disableFetchModule: true,
                };
                return new DevEnvironment(name, config, context);
              },
            },
          },
        },
      };
    },
    configureServer(vite) {
      if (!enabled) return;
      const expected = Buffer.from(token);
      const server = NodeHttp.createServer((request, response) => {
        const actual = Buffer.from(String(request.headers["x-t3-desktop-dev-token"] ?? ""));
        if (actual.length !== expected.length || !NodeCrypto.timingSafeEqual(actual, expected)) {
          response.writeHead(403).end();
          return;
        }
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== "/@t3/hmr") {
          vite.middlewares(request, response, () => response.writeHead(404).end());
          return;
        }
        const id = url.searchParams.get("id") ?? "";
        if (!/^[0-9a-f-]{36}$/iu.test(id)) {
          response.writeHead(400).end();
          return;
        }
        if (request.method === "GET") {
          if (clients.has(id)) {
            response.writeHead(409).end();
            return;
          }
          response.writeHead(200, {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
          });
          clients.set(id, response);
          const client = { send: (payload: HotPayload) => send(response, payload) };
          response.once("close", () => {
            if (clients.get(id) === response) clients.delete(id);
            events.emit("vite:client:disconnect", undefined, client);
          });
          send(response, { type: "connected" });
          events.emit("connection");
          events.emit("vite:client:connect", undefined, client);
          return;
        }
        if (request.method !== "POST" || !clients.has(id)) {
          response.writeHead(404).end();
          return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 1024 * 1024) request.destroy();
        });
        request.on("end", () => {
          try {
            const payload = JSON.parse(body) as { type?: unknown; event?: unknown; data?: unknown };
            const clientResponse = clients.get(id);
            if (payload.type === "custom" && typeof payload.event === "string" && clientResponse) {
              events.emit(payload.event, payload.data, {
                send: (reply: HotPayload) => send(clientResponse, reply),
              });
            }
            response.writeHead(204).end();
          } catch {
            response.writeHead(400).end();
          }
        });
      });
      server.on("error", (error) => vite.config.logger.error(`Desktop dev pipe: ${error.message}`));
      server.listen(pipe);
      const close = () => {
        if (!closePipe) return;
        closePipe = undefined;
        for (const response of clients.values()) response.end();
        clients.clear();
        server.close();
        server.closeAllConnections();
      };
      closePipe = close;
      vite.httpServer?.once("close", close);
      vite.watcher.once("close", close);
    },
    closeBundle() {
      closePipe?.();
    },
  };
}
