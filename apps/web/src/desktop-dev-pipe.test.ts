// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the operating-system pipe.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createServer } from "vite-plus";
import { expect, it } from "vite-plus/test";

import { desktopDevPipePlugin } from "../desktop-dev-pipe";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The test requires Windows named pipes.
const test = process.platform === "win32" ? it : it.skip;

function removeFixture(fixture: string, parent: string) {
  if (
    NodePath.dirname(NodeFS.realpathSync(fixture)) !== parent ||
    !NodePath.basename(fixture).startsWith("t3-vite-pipe-")
  ) {
    throw new Error("Refusing to remove a non-test directory.");
  }
  NodeFS.rmSync(fixture, { recursive: true, force: true });
}

test("serves Vite and HMR over an authenticated desktop pipe", async () => {
  const parent = NodeFS.realpathSync(NodeOS.tmpdir());
  const fixture = NodeFS.mkdtempSync(NodePath.join(parent, "t3-vite-pipe-"));
  const pipe = `\\\\.\\pipe\\t3-vite-test-${NodeCrypto.randomUUID()}`;
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const oldPipe = process.env.T3CODE_DESKTOP_DEV_PIPE;
  const oldToken = process.env.T3CODE_DESKTOP_DEV_PIPE_TOKEN;
  process.env.T3CODE_DESKTOP_DEV_PIPE = pipe;
  process.env.T3CODE_DESKTOP_DEV_PIPE_TOKEN = token;
  NodeFS.writeFileSync(
    NodePath.join(fixture, "index.html"),
    '<script type="module" src="/main.js"></script>',
  );
  NodeFS.writeFileSync(
    NodePath.join(fixture, "main.js"),
    'if (import.meta.hot) import.meta.hot.accept(); console.log("before")',
  );
  const upstream = NodeHttp.createServer();
  const vite = await createServer({
    root: fixture,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: { server: upstream }, hmr: { server: upstream } },
    plugins: [desktopDevPipePlugin()],
  });
  const get = (path: string, credential = token) =>
    new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
      const request = NodeHttp.request(
        {
          socketPath: pipe,
          path,
          headers: { host: "localhost", "x-t3-desktop-dev-token": credential },
        },
        resolve,
      );
      request.once("error", reject);
      request.end();
    });
  const body = async (response: NodeHttp.IncomingMessage) => {
    let text = "";
    for await (const chunk of response) text += String(chunk);
    return text;
  };
  try {
    const denied = await get("/", "incorrect");
    expect(denied.statusCode).toBe(403);
    await body(denied);
    expect(await body(await get("/main.js"))).toContain("before");
    const stream = await get(`/@t3/hmr?id=${NodeCrypto.randomUUID()}`);
    expect(stream.statusCode).toBe(200);
    let buffer = "";
    const update = new Promise<void>((resolve, reject) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line) as { type?: string };
            if (message.type === "connected") {
              NodeFS.writeFileSync(
                NodePath.join(fixture, "main.js"),
                'if (import.meta.hot) import.meta.hot.accept(); console.log("after")',
              );
            } else if (message.type === "update" || message.type === "full-reload") {
              resolve();
            }
          } catch (error) {
            reject(error);
          }
        }
      });
      stream.once("error", reject);
    });
    await update;
    expect(await body(await get("/main.js"))).toContain("after");
    stream.destroy();
  } finally {
    await vite.close();
    upstream.close();
    if (oldPipe === undefined) delete process.env.T3CODE_DESKTOP_DEV_PIPE;
    else process.env.T3CODE_DESKTOP_DEV_PIPE = oldPipe;
    if (oldToken === undefined) delete process.env.T3CODE_DESKTOP_DEV_PIPE_TOKEN;
    else process.env.T3CODE_DESKTOP_DEV_PIPE_TOKEN = oldToken;
    removeFixture(fixture, parent);
  }
});
