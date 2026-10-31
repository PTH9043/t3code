// @effect-diagnostics nodeBuiltinImport:off -- These tests create isolated local files and fake child processes.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";
import type * as NodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeController } from "./JasnaSupervisor.ts";

class FakeChild extends NodeEvents.EventEmitter {
  readonly pid = 4242;
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill() {
    return true;
  }
}

const testRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../../.t3/jasna-tests",
);
let directory = "";

beforeEach(async () => {
  await NodeFSP.mkdir(testRoot, { recursive: true });
  directory = await NodeFSP.mkdtemp(NodePath.join(testRoot, "case-"));
});

afterEach(async () => {
  const actualRoot = await NodeFSP.realpath(testRoot);
  const actualDirectory = await NodeFSP.realpath(directory);
  if (
    NodePath.dirname(actualDirectory) !== actualRoot ||
    !NodePath.basename(actualDirectory).startsWith("case-")
  ) {
    throw new Error("Refusing to remove a path outside the isolated Jasna tests.");
  }
  await NodeFSP.rm(actualDirectory, { recursive: true });
});

async function fixture() {
  const executable = NodePath.join(directory, "jasna.exe");
  const input = NodePath.join(directory, "input.mp4");
  const output = NodePath.join(directory, "output.mp4");
  await NodeFSP.writeFile(executable, "fake executable");
  await NodeFSP.writeFile(input, "original input");
  const child = new FakeChild();
  const spawn = vi.fn(() => child);
  const controller = makeController(
    "win32",
    spawn as unknown as typeof NodeChildProcess.spawn,
    "C:\\Windows",
  );
  await controller.selectExecutable(executable);
  await controller.selectInput(input);
  await controller.selectOutput(output);
  const current = controller.snapshot();
  const selection = {
    executablePath: current.executablePath!,
    inputPath: current.inputPath!,
    outputPath: current.outputPath!,
    model: null,
  };
  return { child, spawn, controller, selection, input, output };
}

describe("local Jasna video restoration", () => {
  it("restores the user's selected executable from the desktop state directory", async () => {
    const { selection, spawn } = await fixture();
    const settingsPath = NodePath.join(directory, "state", "jasna-settings.json");
    const first = makeController(
      "win32",
      spawn as unknown as typeof NodeChildProcess.spawn,
      "C:\\Windows",
      settingsPath,
    );
    await first.selectExecutable(selection.executablePath);
    const next = makeController(
      "win32",
      spawn as unknown as typeof NodeChildProcess.spawn,
      "C:\\Windows",
      settingsPath,
    );
    await next.restoreExecutable();
    expect(next.snapshot().executablePath).toBe(selection.executablePath);
    expect(spawn).not.toHaveBeenCalled();
    await next.clearExecutable();
    expect(next.snapshot().executablePath).toBeNull();
    expect((await NodeFSP.stat(selection.executablePath)).isFile()).toBe(true);
    expect(JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"))).toMatchObject({
      executablePath: null,
    });
  });

  it("discovers the approved installation only when no explicit selection exists", async () => {
    const { selection, spawn } = await fixture();
    const settingsPath = NodePath.join(directory, "state", "jasna-settings.json");
    const approved = NodePath.join(directory, "approved", "jasna.exe");
    await NodeFSP.mkdir(NodePath.dirname(approved), { recursive: true });
    await NodeFSP.writeFile(approved, "approved installation");
    const make = () =>
      makeController(
        "win32",
        spawn as unknown as typeof NodeChildProcess.spawn,
        "C:\\Windows",
        settingsPath,
        approved,
      );

    const discovered = make();
    await discovered.restoreExecutable();
    expect(discovered.snapshot().executablePath).toBe(approved);
    await discovered.selectExecutable(selection.executablePath);
    const restored = make();
    await restored.restoreExecutable();
    expect(restored.snapshot().executablePath).toBe(selection.executablePath);
    await restored.clearExecutable();
    const cleared = make();
    await cleared.restoreExecutable();
    expect(cleared.snapshot().executablePath).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not replace an invalid saved selection with the approved installation", async () => {
    const { spawn } = await fixture();
    const settingsPath = NodePath.join(directory, "state", "jasna-settings.json");
    const approved = NodePath.join(directory, "approved", "jasna.exe");
    await NodeFSP.mkdir(NodePath.dirname(settingsPath), { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(approved), { recursive: true });
    await NodeFSP.writeFile(approved, "approved installation");
    await NodeFSP.writeFile(settingsPath, JSON.stringify({ executablePath: "missing" }));
    const controller = makeController(
      "win32",
      spawn as unknown as typeof NodeChildProcess.spawn,
      "C:\\Windows",
      settingsPath,
      approved,
    );
    await expect(controller.restoreExecutable()).rejects.toMatchObject({ code: "ENOENT" });
    expect(controller.snapshot().executablePath).toBeNull();
  });

  it("rejects existing output and stale file selections before launching anything", async () => {
    const { controller, selection, output, spawn } = await fixture();
    await NodeFSP.writeFile(output, "existing output");
    await expect(controller.start(selection)).rejects.toThrow("이미 있습니다");
    expect(await NodeFSP.readFile(output, "utf8")).toBe("existing output");
    await expect(controller.start({ ...selection, inputPath: "different" })).rejects.toThrow(
      "변경됐습니다",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the selected executable directly and commits a completed video without modifying the input", async () => {
    const { child, spawn, controller, selection, input, output } = await fixture();
    const started = await controller.start(selection);
    const id = started.jobs[0]!.id;
    const [command, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { shell: boolean; cwd: string },
    ];
    expect(command).toBe(selection.executablePath);
    expect(args.slice(0, 3)).toEqual(["--input", selection.inputPath, "--output"]);
    expect(args).toHaveLength(4);
    expect(options).toMatchObject({
      shell: false,
      cwd: NodePath.dirname(selection.executablePath),
    });
    const temporary = args[3]!;
    expect(NodePath.dirname(temporary)).toBe(NodePath.dirname(output));
    child.emit("spawn");
    child.stderr.write("working");
    await NodeFSP.writeFile(temporary, "restored video");
    child.exitCode = 0;
    child.emit("close", 0);
    const completed = await controller.waitForJob(id);
    expect(completed.jobs[0]).toMatchObject({
      status: "completed",
      logTail: "working",
      outputPath: output,
    });
    expect(await NodeFSP.readFile(input, "utf8")).toBe("original input");
    expect(await NodeFSP.readFile(output, "utf8")).toBe("restored video");
    await expect(NodeFSP.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a destination created during processing and keeps the temporary result", async () => {
    const { child, spawn, controller, selection, output } = await fixture();
    const started = await controller.start(selection);
    const id = started.jobs[0]!.id;
    const [, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    const temporary = args[3]!;
    await NodeFSP.writeFile(temporary, "restored video");
    await NodeFSP.writeFile(output, "other process output");
    child.exitCode = 0;
    child.emit("close", 0);
    const finished = await controller.waitForJob(id);
    expect(finished.jobs[0]?.status).toBe("failed");
    expect(finished.jobs[0]?.error).toContain(temporary);
    expect(await NodeFSP.readFile(output, "utf8")).toBe("other process output");
    expect(await NodeFSP.readFile(temporary, "utf8")).toBe("restored video");
  });

  it("reports a zero-byte result as failure", async () => {
    const { child, controller, selection, output } = await fixture();
    const started = await controller.start(selection);
    const id = started.jobs[0]!.id;
    child.exitCode = 0;
    child.emit("close", 0);
    expect((await controller.waitForJob(id)).jobs[0]?.status).toBe("failed");
    await expect(NodeFSP.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not start two concurrent jobs for the same destination", async () => {
    const { child, spawn, controller, selection } = await fixture();
    const attempts = await Promise.allSettled([
      controller.start(selection),
      controller.start(selection),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const id = controller.snapshot().jobs[0]!.id;
    child.exitCode = 1;
    child.emit("close", 1);
    expect((await controller.waitForJob(id)).jobs[0]?.status).toBe("failed");
  });

  it("passes the user's selected model and leaves the default unspecified", async () => {
    const { child, spawn, controller, selection } = await fixture();
    const started = await controller.start({ ...selection, model: "ltx-4step" });
    const [, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(args.slice(4)).toEqual(["--restoration-model-name", "ltx-4step"]);
    expect(started.jobs[0]?.model).toBe("ltx-4step");
    child.exitCode = 1;
    child.emit("close", 1);
    await controller.waitForJob(started.jobs[0]!.id);
  });

  it("cancels only the child process created for that job", async () => {
    const { child, spawn, controller, selection } = await fixture();
    const killer = new FakeChild();
    spawn
      .mockImplementationOnce(() => child)
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.signalCode = "SIGTERM";
          child.emit("close", null);
          killer.exitCode = 0;
          killer.emit("close", 0);
        });
        return killer;
      });
    const started = await controller.start(selection);
    const id = started.jobs[0]!.id;
    await controller.cancel(id);
    const [command, args] = spawn.mock.calls[1] as unknown as [string, string[]];
    expect(NodePath.basename(command).toLowerCase()).toBe("taskkill.exe");
    expect(args).toEqual(["/PID", String(child.pid), "/T", "/F"]);
    expect((await controller.waitForJob(id)).jobs[0]?.status).toBe("cancelled");
  });
});
