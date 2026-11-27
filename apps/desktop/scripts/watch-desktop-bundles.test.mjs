import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { watchDesktopBundles } from "./watch-desktop-bundles.mjs";

const fixturePrefix = NodePath.join(NodeOS.tmpdir(), "t3-bundle-watch-");
let root;
let files;
let stop;

beforeEach(() => {
  vi.useFakeTimers();
  root = NodeFS.mkdtempSync(fixturePrefix);
  NodeFS.mkdirSync(NodePath.join(root, "dist"));
  files = ["main.cjs", "preload.cjs", "bin.mjs"].map((name) => NodePath.join(root, "dist", name));
  for (const file of files) NodeFS.writeFileSync(file, "initial");
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  expect(NodePath.resolve(root).startsWith(fixturePrefix)).toBe(true);
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("desktop bundle watching on Windows", () => {
  it("stays idle without native directory watchers and stops checking after cleanup", () => {
    const onChange = vi.fn();
    const before = process
      ._getActiveHandles()
      .filter((handle) => handle.constructor.name === "FSWatcher").length;
    stop = watchDesktopBundles({ files, onChange, platform: "win32" });
    expect(
      process._getActiveHandles().filter((handle) => handle.constructor.name === "FSWatcher"),
    ).toHaveLength(before);
    vi.advanceTimersByTime(60_000);
    expect(onChange).not.toHaveBeenCalled();
    stop();
    NodeFS.writeFileSync(files[0], "changed after disposal");
    vi.advanceTimersByTime(10_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("detects a bundle edit once and coalesces a build burst", () => {
    const onChange = vi.fn();
    stop = watchDesktopBundles({ files, onChange, platform: "win32" });
    for (const file of files) NodeFS.writeFileSync(file, "rebuilt content");
    vi.advanceTimersByTime(999);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not restart when a watcher rewrites identical bundle bytes", () => {
    const onChange = vi.fn();
    stop = watchDesktopBundles({ files, onChange, platform: "win32" });
    for (const file of files) {
      NodeFS.writeFileSync(file, "initial");
      NodeFS.utimesSync(file, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    }
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
    NodeFS.writeFileSync(files[0], "changed");
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not restart if a temporarily missing bundle returns unchanged", () => {
    const onChange = vi.fn();
    stop = watchDesktopBundles({ files, onChange, platform: "win32" });
    NodeFS.unlinkSync(files[0]);
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
    NodeFS.writeFileSync(files[0], "initial");
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a temporary change that is restored before all bundles are ready", () => {
    const onChange = vi.fn();
    stop = watchDesktopBundles({ files, onChange, platform: "win32" });
    NodeFS.unlinkSync(files[1]);
    NodeFS.writeFileSync(files[0], "temporary change");
    vi.advanceTimersByTime(1_000);
    NodeFS.writeFileSync(files[0], "initial");
    NodeFS.writeFileSync(files[1], "initial");
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("survives replacement of a clean build directory and waits for all bundles", () => {
    const onChange = vi.fn();
    stop = watchDesktopBundles({ files, onChange, platform: "win32" });
    const original = NodePath.resolve(root, "dist");
    const retired = NodePath.resolve(root, "retired-dist");
    expect(NodePath.dirname(original)).toBe(root);
    expect(NodePath.dirname(retired)).toBe(root);
    NodeFS.renameSync(original, retired);
    vi.advanceTimersByTime(5_000);
    expect(onChange).not.toHaveBeenCalled();
    NodeFS.mkdirSync(original);
    NodeFS.writeFileSync(files[0], "replacement main");
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
    NodeFS.writeFileSync(files[1], "replacement preload");
    NodeFS.writeFileSync(files[2], "replacement server");
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
