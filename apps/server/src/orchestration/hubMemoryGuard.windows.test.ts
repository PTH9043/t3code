// @effect-diagnostics nodeBuiltinImport:off - This integration test exercises native Windows child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePty from "node-pty";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";

import { HUB_COMMAND_ENV, HUB_LIMIT_ENV, windowsJobGuardCandidates } from "./hubMemoryGuard.ts";

const encodePowerShellCommand = (script: string) =>
  Buffer.from(script, "utf16le").toString("base64");
const powershell = NodePath.join(
  NodeProcess.env.SystemRoot ?? "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
function windowsJobGuardShell() {
  const shell = windowsJobGuardCandidates(NodePath, NodeProcess.arch).find((candidate) =>
    NodeFS.existsSync(candidate),
  );
  if (!shell)
    throw new Error("Build the native guard with vp run build:hub-memory before testing.");
  return { shell, args: [] };
}

function runGuard(
  command: string,
  onOutput?: (output: string, child: NodeChildProcess.ChildProcess) => void,
) {
  const shell = windowsJobGuardShell();
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(shell.shell, shell.args, {
      windowsHide: true,
      timeout: 10_000,
      env: { ...NodeProcess.env, [HUB_COMMAND_ENV]: command, [HUB_LIMIT_ENV]: "256" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      stdout += data;
      onOutput?.(stdout, child);
    });
    child.stderr.setEncoding("utf8").on("data", (data: string) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(NodeProcess.platform !== "win32")("Windows hub job integration", () => {
  it.effect("stops the native guard through the public Windows PTY adapter", () =>
    Effect.gen(function* () {
      const adapter = yield* NodePtyAdapter.make();
      const shell = windowsJobGuardShell();
      const child = yield* adapter.spawn({
        shell: shell.shell,
        args: [],
        cwd: NodeProcess.cwd(),
        cols: 120,
        rows: 30,
        env: {
          ...NodeProcess.env,
          [HUB_LIMIT_ENV]: "256",
          [HUB_COMMAND_ENV]: `"${NodeProcess.execPath}" -e "console.log('PTY_CHILD:'+process.pid);setInterval(()=>{},1000)"`,
        },
      });
      yield* Effect.promise(async () => {
        let output = "";
        let watching = false;
        let hasExited = false;
        const exited = new Promise((resolve) =>
          child.onExit((event) => {
            hasExited = true;
            resolve(event);
          }),
        );
        try {
          const descendantExited = await new Promise<number | null>((resolve, reject) => {
            child.onData((data) => {
              output += data;
              const pid = /PTY_CHILD:(\d+)/.exec(output)?.[1];
              if (!pid || watching) return;
              watching = true;
              const script = `$target=[System.Diagnostics.Process]::GetProcessById(${pid}); Write-Output 'WATCHING'; if ($target.WaitForExit(5000)) { exit 0 } else { exit 1 }`;
              const observer = NodeChildProcess.spawn(
                powershell,
                [
                  "-NoProfile",
                  "-NonInteractive",
                  "-EncodedCommand",
                  encodePowerShellCommand(script),
                ],
                { windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
              );
              let observed = "";
              observer.stdout.setEncoding("utf8").on("data", (chunk: string) => {
                observed += chunk;
                if (observed.includes("WATCHING")) child.kill("SIGTERM");
              });
              observer.once("error", reject);
              observer.once("close", resolve);
            });
          });
          expect(descendantExited).toBe(0);
          await exited;
        } finally {
          if (!hasExited) child.kill("SIGKILL");
        }
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("terminates the guarded descendant when the guard is stopped", async () => {
    let observedExit: Promise<number | null> | undefined;
    const command = `"${NodeProcess.execPath}" -e "console.log('TREE_PID:'+process.pid);setInterval(()=>{},1000)"`;
    await runGuard(command, (output, guard) => {
      const pid = /TREE_PID:(\d+)/.exec(output)?.[1];
      if (pid === undefined || observedExit !== undefined) return;
      observedExit = new Promise((resolve, reject) => {
        const script = `$ErrorActionPreference='Stop'; $target=[System.Diagnostics.Process]::GetProcessById(${pid}); Write-Output 'WATCHING'; if ($target.WaitForExit(5000)) { exit 0 } else { exit 1 }`;
        const observer = NodeChildProcess.spawn(
          powershell,
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(script)],
          { windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
        );
        let output = "";
        observer.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("WATCHING")) guard.kill();
        });
        observer.once("error", (error) => {
          guard.kill();
          reject(error);
        });
        observer.once("close", (code) => {
          guard.kill();
          resolve(code);
        });
      });
    });
    expect(observedExit).toBeDefined();
    expect(await observedExit).toBe(0);
  });

  it("preserves output and exit status through the real ConPTY launch path", async () => {
    const shell = windowsJobGuardShell();
    const result = await new Promise<{ code: number; output: string }>((resolve) => {
      const child = NodePty.spawn(shell.shell, shell.args, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: NodeProcess.cwd(),
        env: {
          ...NodeProcess.env,
          [HUB_LIMIT_ENV]: "256",
          [HUB_COMMAND_ENV]: "echo HUB_PTY_READY & exit /b 75",
        },
      });
      let output = "";
      child.onData((data) => {
        output += data;
      });
      child.onExit((event) => resolve({ code: event.exitCode, output }));
    });
    expect(result).toMatchObject({ code: 75, output: expect.stringContaining("HUB_PTY_READY") });
  });

  it("preserves a quoted executable, environment, output, and yield exit code", async () => {
    const result = await runGuard(
      `"${NodeProcess.execPath}" -e "console.log('hub:'+process.env.T3_HUB_MEMORY_HARD_CAP_MB);process.exit(75)"`,
    );
    expect(result, result.stderr).toMatchObject({
      code: 75,
      stdout: expect.stringContaining("hub:256"),
    });
  });

  it("enforces the commit cap in a descendant before it allocates memory", async () => {
    const probe = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HubCommitProbe {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size, uint allocationType, uint protect);
  [DllImport("kernel32.dll")]
  public static extern bool VirtualFree(IntPtr address, UIntPtr size, uint freeType);
}
'@
$small = [HubCommitProbe]::VirtualAlloc([IntPtr]::Zero, [UIntPtr][uint64](8MB), 0x3000, 4)
if ($small -eq [IntPtr]::Zero) { throw 'Small allocation failed' }
[void][HubCommitProbe]::VirtualFree($small, [UIntPtr]::Zero, 0x8000)
$large = [HubCommitProbe]::VirtualAlloc([IntPtr]::Zero, [UIntPtr][uint64](384MB), 0x3000, 4)
if ($large -ne [IntPtr]::Zero) {
  [void][HubCommitProbe]::VirtualFree($large, [UIntPtr]::Zero, 0x8000)
  throw 'Commit cap was bypassed'
}
Write-Output 'COMMIT_CAP_ENFORCED'
exit 23
`;
    const result = await runGuard(
      `"${powershell}" -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(probe)}`,
    );
    expect(result, result.stderr).toMatchObject({
      code: 23,
      stdout: expect.stringContaining("COMMIT_CAP_ENFORCED"),
    });
  });
});
