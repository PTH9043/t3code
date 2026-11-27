// @effect-diagnostics-next-line nodeBuiltinImport:off - Real hidden cmd.exe process-tree integration test requires Node child_process windowsHide.
import * as NodeChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createWindowsTerminalProcessGroup,
  isValidManagedWindowsPid,
  resolveWindowsTaskkillPath,
  terminateWindowsProcessTree,
  terminateWindowsProcessTreeSync,
} from "./windowsJobObject.ts";

describe("windowsJobObject", () => {
  it("resolves canonical taskkill.exe under SYSTEMROOT without PowerShell", () => {
    expect(resolveWindowsTaskkillPath({ SYSTEMROOT: "D:\\Windows\\" })).toBe(
      "D:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({ windir: "C:\\WINNT" })).toBe(
      "C:\\WINNT\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({})).toBe("C:\\Windows\\System32\\taskkill.exe");
  });

  it("rejects invalid and self PIDs", () => {
    expect(isValidManagedWindowsPid(0, 5000)).toBe(false);
    expect(isValidManagedWindowsPid(-10, 5000)).toBe(false);
    expect(isValidManagedWindowsPid(12.5, 5000)).toBe(false);
    expect(isValidManagedWindowsPid(5000, 5000)).toBe(false);
    expect(isValidManagedWindowsPid(4242, 5000)).toBe(true);
  });

  it("skips termination on non-win32 platforms and invalid PIDs", async () => {
    const execFile = vi.fn();
    const nonWin = await terminateWindowsProcessTree(4242, {
      platform: "linux",
      execFile,
    });
    expect(nonWin).toEqual({
      pid: 4242,
      attempted: false,
      terminated: false,
      reason: "unsupported-platform",
    });

    const selfKill = await terminateWindowsProcessTree(7777, {
      platform: "win32",
      currentPid: 7777,
      execFile,
    });
    expect(selfKill).toEqual({
      pid: 7777,
      attempted: false,
      terminated: false,
      reason: "invalid-pid",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("invokes taskkill.exe /PID <pid> /T /F hidden and treats exit 128 as already-exited", async () => {
    const calls: Array<{
      file: string;
      args: ReadonlyArray<string>;
      options: { readonly windowsHide: boolean; readonly timeout: number };
    }> = [];
    const unref = vi.fn();

    const okResult = await terminateWindowsProcessTree(8124, {
      platform: "win32",
      env: { SYSTEMROOT: "C:\\Windows" },
      currentPid: 1000,
      unrefChild: true,
      execFile: (file, args, options, callback) => {
        calls.push({ file, args, options });
        callback(null);
        return { unref };
      },
    });

    expect(okResult).toEqual({
      pid: 8124,
      attempted: true,
      terminated: true,
      reason: "terminated",
      exitCode: 0,
    });
    expect(unref).toHaveBeenCalledOnce();
    expect(calls[0]).toEqual({
      file: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "8124", "/T", "/F"],
      options: { windowsHide: true, timeout: 10_000 },
    });

    const alreadyExited = await terminateWindowsProcessTree(8128, {
      platform: "win32",
      env: { SYSTEMROOT: "C:\\Windows" },
      currentPid: 1000,
      execFile: (_file, _args, _options, callback) => {
        const err = Object.assign(new Error("not found"), { code: 128 });
        callback(err);
      },
    });
    expect(alreadyExited).toEqual({
      pid: 8128,
      attempted: true,
      terminated: true,
      reason: "already-exited",
      exitCode: 128,
    });
  });

  it("supports synchronous tree termination for process exit cleanup", () => {
    const execFileSync = vi.fn();
    const ok = terminateWindowsProcessTreeSync(9044, {
      platform: "win32",
      env: { SYSTEMROOT: "C:\\Windows" },
      currentPid: 1000,
      execFileSync,
    });
    expect(ok).toEqual({
      pid: 9044,
      attempted: true,
      terminated: true,
      reason: "terminated",
      exitCode: 0,
    });
    expect(execFileSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "9044", "/T", "/F"],
      { windowsHide: true, timeout: 10_000, stdio: "ignore" },
    );

    const gone = terminateWindowsProcessTreeSync(9048, {
      platform: "win32",
      env: { SYSTEMROOT: "C:\\Windows" },
      currentPid: 1000,
      execFileSync: () => {
        throw Object.assign(new Error("process not found"), { status: 128 });
      },
    });
    expect(gone.terminated).toBe(true);
    expect(gone.reason).toBe("already-exited");
  });

  it("tracks regular terminal PIDs, deduplicates concurrent terminatePid, and drains on terminateAll & exit hook", async () => {
    const asyncKilled: number[] = [];
    const syncKilled: number[] = [];
    const fakeProcess = new EventEmitter();

    const group = createWindowsTerminalProcessGroup({
      platform: "win32",
      currentPid: 1000,
      env: { SYSTEMROOT: "C:\\Windows" },
      targetProcess: fakeProcess as unknown as Pick<NodeJS.Process, "on" | "off">,
      execFile: (_file, args, _options, callback) => {
        const pid = Number(args[1]);
        asyncKilled.push(pid);
        queueMicrotask(() => callback(null));
      },
      execFileSync: (_file, args) => {
        syncKilled.push(Number(args[1]));
      },
    });

    expect(group.register(2004, "thread-1:default")).toBe(true);
    expect(group.register(2008, "thread-2:default")).toBe(true);
    expect(group.register(1000, "self-blocked")).toBe(false);
    expect(group.listPids()).toEqual([2004, 2008]);

    // Concurrent calls for the same PID invoke taskkill only once.
    const [first, second] = await Promise.all([group.terminatePid(2004), group.terminatePid(2004)]);
    expect(first.terminated).toBe(true);
    expect(second.terminated).toBe(true);
    expect(asyncKilled).toEqual([2004]);
    expect(group.has(2004)).toBe(false);
    expect(group.listPids()).toEqual([2008]);

    // Server graceful shutdown drains all remaining registered PIDs.
    const drained = await group.terminateAll();
    expect(drained.map((entry) => entry.pid)).toEqual([2008]);
    expect(group.size()).toBe(0);

    // Process exit hook synchronously reaps any still-tracked PIDs.
    expect(group.register(3012, "thread-3:default")).toBe(true);
    fakeProcess.emit("exit", 0);
    expect(syncKilled).toEqual([3012]);
    expect(group.size()).toBe(0);

    group.dispose();
    expect(fakeProcess.listenerCount("exit")).toBe(0);
  });

  it.skipIf(process.platform !== "win32")(
    "terminates a real hidden Windows cmd.exe child process tree without leaving zombies",
    async () => {
      const cmdPath = `${process.env.SYSTEMROOT || process.env.windir || "C:\\Windows"}\\System32\\cmd.exe`;
      const child = NodeChildProcess.spawn(cmdPath, ["/d", "/c", "ping -n 30 127.0.0.1 >nul"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const pid = child.pid;
      expect(typeof pid).toBe("number");
      if (!pid) return;

      const group = createWindowsTerminalProcessGroup({
        autoInstallExitHook: false,
      });
      try {
        expect(group.register(pid, "real-win32-tree-test")).toBe(true);
        const exitPromise = new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        });

        const result = await group.terminatePid(pid);
        expect(result.attempted).toBe(true);
        expect(result.terminated).toBe(true);

        await exitPromise;
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        group.dispose();
        if (child.exitCode === null) {
          child.kill();
        }
      }
    },
  );
});
