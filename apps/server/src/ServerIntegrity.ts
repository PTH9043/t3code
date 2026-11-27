// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

export function parseWindowsIntegrityRid(output: string): number | null {
  const matches = [...output.matchAll(/\bS-1-16-(\d+)\b/g)];
  if (matches.length !== 1) return null;
  const value = Number(matches[0]?.[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/** The child inherits the server process token and never opens a console window. */
export function readServerIntegrityRid(): Promise<number | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  const executable = NodePath.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "whoami.exe",
  );
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      executable,
      ["/groups", "/fo", "csv", "/nh"],
      { windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 256 * 1024 },
      (error, stdout) => resolve(error ? null : parseWindowsIntegrityRid(stdout)),
    );
  });
}
