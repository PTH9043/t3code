// @effect-diagnostics nodeBuiltinImport:off - Real Node ESM modules are created in a disposable directory.
import * as NodeFs from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeRuntimePluginLoader } from "./RuntimePluginLoader.ts";
import { startRuntimePluginWorker } from "./RuntimePluginWorker.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await NodeFs.rm(dir, { recursive: true, force: true });
});

describe("runtime plugin loader", () => {
  it("loads and replaces a real project module without changing another conversation", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-plugin-test-"));
    dirs.push(root);
    const folder = NodePath.join(root, ".t3", "runtime-plugins");
    await NodeFs.mkdir(folder, { recursive: true });
    const file = NodePath.join(folder, "echo.mjs");
    await NodeFs.writeFile(
      file,
      "export function activate(ctx) { ctx.register(input => ({ version: 1, input })); }",
    );
    const loader = makeRuntimePluginLoader();
    const first = await loader.load("chat-a", root, "echo");
    await loader.load("chat-b", root, "echo");
    await NodeFs.writeFile(
      file,
      "export function activate(ctx) { ctx.register(input => ({ version: 2, input })); }",
    );
    const second = await loader.load("chat-a", root, "echo");
    expect(second.revision).not.toBe(first.revision);
    expect(await loader.invoke("chat-a", "echo", "x")).toEqual({ version: 2, input: "x" });
    expect(await loader.invoke("chat-b", "echo", "x")).toEqual({ version: 1, input: "x" });
    await loader.unload("chat-a", "echo");
    await loader.unload("chat-b", "echo");
  });

  it("rejects invalid identifiers before reading outside the plugin directory", async () => {
    const loader = makeRuntimePluginLoader();
    await expect(loader.load("chat", ".", "../outside")).rejects.toThrow(
      "Invalid plugin identifier",
    );
  });

  it("terminates a worker when plugin disposal does not finish", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-plugin-disposal-"));
    dirs.push(root);
    const file = NodePath.join(root, "hang.mjs");
    const code =
      'export function activate(ctx) { ctx.register(() => "ready"); ctx.onDispose(() => new Promise(() => {})); }';
    await NodeFs.writeFile(file, code);
    const revision = NodeCrypto.createHash("sha256").update(code).digest("hex");
    const worker = await startRuntimePluginWorker({ file, revision, cleanupTimeoutMs: 50 });
    expect(await worker.invoke(null)).toBe("ready");
    await expect(worker.dispose()).rejects.toThrow("cleanup timed out");
    await expect(worker.invoke(null)).rejects.toThrow("not running");
  });

  it("keeps the host responsive and can terminate a plugin stuck in synchronous code", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-plugin-loop-"));
    dirs.push(root);
    const folder = NodePath.join(root, ".t3", "runtime-plugins");
    await NodeFs.mkdir(folder, { recursive: true });
    await NodeFs.writeFile(
      NodePath.join(folder, "loop.mjs"),
      "export function activate(ctx) { ctx.register(shared => { const flag = new Int32Array(shared); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); for (;;) {} }); }",
    );
    const loader = makeRuntimePluginLoader();
    await loader.load("chat", root, "loop");
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const invocation = loader.invoke("chat", "loop", flag.buffer);
    const rejected = expect(invocation).rejects.toThrow("Plugin worker exited");
    if (Atomics.load(flag, 0) === 0) {
      const wait = Atomics.waitAsync(flag, 0, 0, 5_000);
      if (wait.async) expect(await wait.value).toBe("ok");
    }
    const cancellation = await loader.cancel("chat", "loop");
    await rejected;
    expect(cancellation.cancelled).toBe(true);
    expect(loader.status("chat", "loop").revision).toBeNull();
  }, 15_000);

  it("stops a stuck worker when its conversation disables Creator mode", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-plugin-disable-"));
    dirs.push(root);
    const folder = NodePath.join(root, ".t3", "runtime-plugins");
    await NodeFs.mkdir(folder, { recursive: true });
    await NodeFs.writeFile(
      NodePath.join(folder, "loop.mjs"),
      "export function activate(ctx) { ctx.register(shared => { const flag = new Int32Array(shared); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); for (;;) {} }); }",
    );
    const loader = makeRuntimePluginLoader();
    await loader.load("chat", root, "loop");
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const invocation = loader.invoke("chat", "loop", flag.buffer);
    const rejected = expect(invocation).rejects.toThrow("Plugin worker exited");
    if (Atomics.load(flag, 0) === 0) {
      const wait = Atomics.waitAsync(flag, 0, 0, 5_000);
      if (wait.async) expect(await wait.value).toBe("ok");
    }
    await loader.unloadDisabled(new Set());
    await rejected;
    expect(loader.status("chat", "loop").revision).toBeNull();
    expect(loader.status("chat", "loop").cleanupFailures.length).toBeGreaterThan(0);
  }, 15_000);
});
