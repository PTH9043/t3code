import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  watch: vi.fn(),
  inspectRestart: vi.fn(),
}));
vi.mock("node:child_process", () => mocks);
vi.mock("node:os", () => ({ platform: () => "win32" }));
vi.mock("./electron-launcher.mjs", () => ({
  desktopDir: "/desktop",
  resolveDevProtocolClient: () => null,
  resolveElectronLaunchCommand: (args) => ({ electronPath: "electron", args }),
}));
vi.mock("./wait-for-resources.mjs", () => ({ waitForResources: async () => {} }));
vi.mock("./watch-desktop-bundles.mjs", () => ({ watchDesktopBundles: mocks.watch }));
vi.mock("./dev-restart-guard.mjs", () => ({ inspectAutomaticRestart: mocks.inspectRestart }));

let signals;
let running;
let stopWatching;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5733");
  signals = new Map();
  running = new Map();
  stopWatching = vi.fn();
  mocks.watch.mockReturnValue(stopWatching);
  mocks.inspectRestart.mockReturnValue({ safe: true, reason: "idle" });
  const originalOnce = process.once;
  vi.spyOn(process, "once").mockImplementation(function (event, handler) {
    if (["SIGINT", "SIGTERM", "SIGHUP"].includes(event)) {
      signals.set(event, handler);
      return this;
    }
    return originalOnce.call(this, event, handler);
  });
  vi.spyOn(process, "exit").mockImplementation(() => {});
  let nextPid = 40_000;
  mocks.spawn.mockImplementation(() => {
    const app = Object.assign(new NodeEvents.EventEmitter(), {
      pid: nextPid++,
      stderr: new NodeEvents.EventEmitter(),
      kill: vi.fn(),
    });
    expect(running.size, "Previous app must be terminated before replacement").toBe(0);
    running.set(app.pid, app);
    return app;
  });
  mocks.spawnSync.mockImplementation((command, args) => {
    expect(command).toBe("taskkill");
    const app = running.get(Number(args[1]));
    expect(app?.kill).not.toHaveBeenCalled();
    running.delete(app.pid);
    app.emit("exit", 1, null);
    return { status: 0 };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("desktop launcher process lifetime", () => {
  it("keeps one app across rebuilds and terminates its Windows tree before replacing it", async () => {
    await import("./dev-electron.mjs");
    const watched = mocks.watch.mock.calls[0][0].files;
    expect(watched.some((file) => file.endsWith("preview-pick-preload.cjs"))).toBe(true);
    expect(watched.some((file) => file.endsWith("preview-pip-preload.cjs"))).toBe(true);
    const { onChange } = mocks.watch.mock.calls[0][0];
    for (let build = 0; build < 20; build++) {
      onChange();
      onChange();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(running.size).toBe(1);
      expect(mocks.spawn).toHaveBeenCalledTimes(build + 2);
    }
    expect(mocks.watch).toHaveBeenCalledTimes(1);
    signals.get("SIGTERM")();
    await vi.runAllTimersAsync();
    expect(running.size).toBe(0);
    expect(stopWatching).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(143);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a queued rebuild during shutdown without spawning a replacement", async () => {
    await import("./dev-electron.mjs");
    mocks.watch.mock.calls[0][0].onChange();
    signals.get("SIGINT")();
    await vi.runAllTimersAsync();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(running.size).toBe(0);
    expect(stopWatching).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(130);
  });

  it("keeps active work alive across rebuilds and applies them after the guard clears", async () => {
    mocks.inspectRestart.mockReturnValue({ safe: false, reason: "active-work" });
    await import("./dev-electron.mjs");
    const { onChange } = mocks.watch.mock.calls[0][0];
    onChange();
    await vi.advanceTimersByTimeAsync(1_000);
    onChange();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(running.size).toBe(1);

    mocks.inspectRestart.mockReturnValue({ safe: true, reason: "idle" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(running.size).toBe(1);

    signals.get("SIGTERM")();
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not terminate active work when the main process reports a load failure", async () => {
    mocks.inspectRestart.mockReturnValue({ safe: false, reason: "active-work" });
    await import("./dev-electron.mjs");
    const app = [...running.values()][0];
    app.stderr.emit("data", Buffer.from("App threw an error during load"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(running.size).toBe(1);

    mocks.inspectRestart.mockReturnValue({ safe: true, reason: "idle" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.spawnSync).toHaveBeenCalledOnce();
    expect(running.size).toBe(0);
    mocks.watch.mock.calls[0][0].onChange();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(running.size).toBe(1);
    signals.get("SIGTERM")();
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("holds the restart lock until the previous app has stopped", async () => {
    const release = vi.fn(() => expect(running.size).toBe(0));
    mocks.inspectRestart.mockReturnValue({ safe: true, reason: "idle", release });
    await import("./dev-electron.mjs");
    mocks.watch.mock.calls[0][0].onChange();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.spawnSync).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(running.size).toBe(1);
    signals.get("SIGTERM")();
    await vi.runAllTimersAsync();
  });
});
