// @effect-diagnostics nodeBuiltinImport:off - Exercises real Windows process trees.
// @effect-diagnostics globalDate:off - Waits on real child processes.
// @effect-diagnostics globalTimers:off - Waits on real child processes.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import NodeProcess from "node:process";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vite-plus/test";

const moduleUrl = pathToFileURL(NodePath.resolve(import.meta.dirname, "WatchdogProcess.ts")).href;
const pipeModuleUrl = pathToFileURL(NodePath.resolve(import.meta.dirname, "WatchdogPipe.ts")).href;
const dirs: string[] = [];
const workers: number[] = [];

afterEach(() => {
  for (const pid of workers.splice(0)) {
    try {
      NodeProcess.kill(pid);
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number) {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Start a stand-in backend that hands one job to a worker, then kill the backend's whole tree. */
async function survivesTreeKill(separateProcessTree: boolean) {
  const dir = mkdtempSync(NodePath.join(tmpdir(), "t3-watchdog-tree-"));
  dirs.push(dir);
  const out = NodePath.join(dir, "worker.json");
  const entry = NodePath.join(dir, "worker.ts");
  writeFileSync(
    entry,
    `import { WATCHDOG_SEPARATE_TREE_FLAG, receiveWatchdogLaunch, relayWatchdogLaunch } from ${JSON.stringify(moduleUrl)};
import { applyWatchdogEnvironment, readWatchdogPipeArguments, receiveWatchdogPipeLaunch } from ${JSON.stringify(pipeModuleUrl)};
import { writeFileSync } from "node:fs";
const pipe = readWatchdogPipeArguments(process.argv.slice(2));
if (pipe) {
  const launch = await receiveWatchdogPipeLaunch(pipe, 5000);
  applyWatchdogEnvironment(launch.environment);
  writeFileSync(launch.payload.out, JSON.stringify({ pid: process.pid, mode: "pipe" }));
  await launch.acknowledge();
  setInterval(() => {}, 1000);
} else if (process.argv.includes(WATCHDOG_SEPARATE_TREE_FLAG)) {
  await relayWatchdogLaunch(process.argv[1]);
} else {
  const { payload } = await receiveWatchdogLaunch((value) => value);
  writeFileSync(payload.out, JSON.stringify({ pid: process.pid, mode: "ipc" }));
  setInterval(() => {}, 1000);
}
`,
  );
  const backend = NodePath.join(dir, "backend.ts");
  writeFileSync(
    backend,
    `import { launchDetachedWatchdog } from ${JSON.stringify(moduleUrl)};
const result = await launchDetachedWatchdog({ entry: ${JSON.stringify(entry)}, jobId: "job", payload: { out: ${JSON.stringify(out)} }, separateProcessTree: ${separateProcessTree} });
console.log(result.status);
setInterval(() => {}, 1000);
`,
  );
  const child = spawn(NodeProcess.execPath, [backend], { stdio: ["ignore", "pipe", "inherit"] });
  let status = "";
  child.stdout.on("data", (chunk) => (status += String(chunk)));
  await waitFor(() => status.includes("\n") && existsSync(out));
  const report = JSON.parse(readFileSync(out, "utf8")) as { pid: number; mode: string };
  workers.push(report.pid);
  expect(status.trim()).toBe("received");
  spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { alive: alive(report.pid), mode: report.mode };
}

it.runIf(NodeProcess.platform === "win32")(
  "keeps a separated worker alive through WMI when the backend process tree is force-killed",
  async () => {
    expect(await survivesTreeKill(false)).toEqual({ alive: false, mode: "ipc" });
    expect(await survivesTreeKill(true)).toEqual({ alive: true, mode: "pipe" });
  },
  40_000,
);

it.runIf(NodeProcess.platform === "win32")(
  "falls back to IPC only on not-started and never retries on unknown",
  async () => {
    const dir = mkdtempSync(NodePath.join(tmpdir(), "t3-watchdog-fallback-"));
    dirs.push(dir);

    // 1. Legacy worker that exits immediately without connecting to the pipe -> not-started -> IPC fallback.
    const fallbackLog = NodePath.join(dir, "fallback.log");
    const legacyWorker = NodePath.join(dir, "legacy-worker.ts");
    writeFileSync(
      legacyWorker,
      `import { WATCHDOG_SEPARATE_TREE_FLAG, receiveWatchdogLaunch, relayWatchdogLaunch } from ${JSON.stringify(moduleUrl)};
import { appendFileSync } from "node:fs";
if (process.argv.includes(WATCHDOG_SEPARATE_TREE_FLAG)) {
  await relayWatchdogLaunch(process.argv[1]);
} else {
  const { payload } = await receiveWatchdogLaunch((value) => value);
  appendFileSync(payload.out, "ipc:" + process.pid + "\\n");
}
`,
    );
    const fallbackBackend = NodePath.join(dir, "fallback-backend.ts");
    writeFileSync(
      fallbackBackend,
      `import { launchDetachedWatchdog } from ${JSON.stringify(moduleUrl)};
const result = await launchDetachedWatchdog({ entry: ${JSON.stringify(legacyWorker)}, jobId: "job-fallback", payload: { out: ${JSON.stringify(fallbackLog)} }, separateProcessTree: true });
console.log(result.status);
`,
    );
    const fallbackRun = spawnSync(NodeProcess.execPath, [fallbackBackend], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    });
    expect(fallbackRun.stdout.trim()).toBe("received");
    expect(fallbackRun.stderr).toContain("falling back to process-tree launch");
    await waitFor(() => existsSync(fallbackLog));
    expect(readFileSync(fallbackLog, "utf8").trim().split("\n")).toHaveLength(1);

    // 2. Worker reads the launch over the pipe and exits without acknowledging -> unknown -> no IPC retry.
    const unknownLog = NodePath.join(dir, "unknown.log");
    const silentAckWorker = NodePath.join(dir, "silent-ack-worker.ts");
    writeFileSync(
      silentAckWorker,
      `import { WATCHDOG_SEPARATE_TREE_FLAG, receiveWatchdogLaunch, relayWatchdogLaunch } from ${JSON.stringify(moduleUrl)};
import { readWatchdogPipeArguments, receiveWatchdogPipeLaunch } from ${JSON.stringify(pipeModuleUrl)};
import { appendFileSync } from "node:fs";
const pipe = readWatchdogPipeArguments(process.argv.slice(2));
if (pipe) {
  const launch = await receiveWatchdogPipeLaunch(pipe, 5000);
  appendFileSync(launch.payload.out, "pipe:" + process.pid + "\\n");
  process.exit(0);
} else if (process.argv.includes(WATCHDOG_SEPARATE_TREE_FLAG)) {
  await relayWatchdogLaunch(process.argv[1]);
} else {
  const { payload } = await receiveWatchdogLaunch((value) => value);
  appendFileSync(payload.out, "ipc:" + process.pid + "\\n");
}
`,
    );
    const unknownBackend = NodePath.join(dir, "unknown-backend.ts");
    writeFileSync(
      unknownBackend,
      `import { launchDetachedWatchdog } from ${JSON.stringify(moduleUrl)};
const result = await launchDetachedWatchdog({ entry: ${JSON.stringify(silentAckWorker)}, jobId: "job-unknown", payload: { out: ${JSON.stringify(unknownLog)} }, separateProcessTree: true });
console.log(result.status);
`,
    );
    const unknownRun = spawnSync(NodeProcess.execPath, [unknownBackend], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    });
    expect(unknownRun.stdout.trim()).toBe("unknown");
    expect(unknownRun.stderr).not.toContain("falling back");
    await waitFor(() => existsSync(unknownLog));
    const lines = readFileSync(unknownLog, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^pipe:\d+$/);
  },
  45_000,
);
