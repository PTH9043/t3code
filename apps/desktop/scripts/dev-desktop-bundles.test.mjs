import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", () => mocks);
vi.mock("node:os", () => ({ platform: () => "win32" }));

let children;
let signals;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  children = [];
  signals = new Map();
  const originalOnce = process.once;
  vi.spyOn(process, "once").mockImplementation(function (event, handler) {
    if (["SIGINT", "SIGTERM", "SIGHUP"].includes(event)) {
      signals.set(event, handler);
      return this;
    }
    return originalOnce.call(this, event, handler);
  });
  vi.spyOn(process, "exit").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.spawn.mockImplementation((_command, args) => {
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      pid: 50_000 + children.length,
      args,
      exitCode: null,
      signalCode: null,
    });
    children.push(child);
    return child;
  });
  mocks.spawnSync.mockImplementation((command, args) => {
    if (command === process.execPath) return { status: 0 };
    expect(command).toBe("taskkill");
    const child = children.find((child) => child.pid === Number(args[1]));
    child.exitCode = 1;
    child.emit("exit", 1, null);
    return { status: 0 };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("desktop development process ownership", () => {
  it("preserves existing bundles while starting both watchers", async () => {
    await import("./dev-desktop-bundles.mjs");
    expect(children[0].args).toContain("--no-clean");
    expect(children[1].args).toContain("--no-clean");
  });

  it.each([0, 7])(
    "cleans up both watchers when the sole launcher exits with %i",
    async (exitCode) => {
      await import("./dev-desktop-bundles.mjs");
      mocks.spawnSync.mockClear();
      const launcher = children.find((child) => child.args[0].endsWith("dev-electron.mjs"));
      expect(launcher).toBeDefined();
      expect(children).toHaveLength(3);
      launcher.exitCode = exitCode;
      launcher.emit("exit", exitCode, null);
      await vi.runAllTimersAsync();
      expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
      expect(children.every((child) => child.exitCode !== null)).toBe(true);
      expect(process.exit).toHaveBeenCalledWith(exitCode);
    },
  );

  it("keeps the app running and retries if a watcher fails to spawn", async () => {
    await import("./dev-desktop-bundles.mjs");
    mocks.spawnSync.mockClear();
    children[0].pid = undefined;
    children[0].emit("error", new Error("Cannot start watcher"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(children).toHaveLength(4);
    expect(children[3].args).toEqual(children[0].args);
    expect(process.exit).not.toHaveBeenCalled();
    signals.get("SIGTERM")();
    await vi.runAllTimersAsync();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(3);
    expect(process.exit).toHaveBeenCalledWith(143);
  });

  it("does not terminate the launcher when a watcher exits", async () => {
    await import("./dev-desktop-bundles.mjs");
    mocks.spawnSync.mockClear();
    children[1].exitCode = 1;
    children[1].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(children).toHaveLength(4);
    expect(children[3].args).toEqual(children[1].args);
    signals.get("SIGTERM")();
    await vi.runAllTimersAsync();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(3);
  });

  it("terminates every owned child tree exactly once on repeated shutdown signals", async () => {
    await import("./dev-desktop-bundles.mjs");
    mocks.spawnSync.mockClear();
    signals.get("SIGINT")();
    signals.get("SIGTERM")();
    await vi.runAllTimersAsync();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(3);
    expect(children.every((child) => child.exitCode !== null)).toBe(true);
    expect(process.exit).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(130);
  });
});
