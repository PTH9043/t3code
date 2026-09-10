// Runs the two bundle watchers and one Electron launcher, side by side:
//
//   - apps/server  `vp pack --watch --no-clean`  → apps/server/dist/bin.mjs
//   - apps/desktop `vp pack --watch`             → dist-electron/*.cjs
//   - apps/desktop `node scripts/dev-electron.mjs`
//
// The launcher waits for its resources, then watches both outputs itself.
// Spawning it from pack's onSuccess leaks launchers across rebuilds on Windows.
// `--no-clean` keeps service-launcher.mjs, which the one-shot `t3#build`
// produced and the server watcher never rebuilds.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptsDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(scriptsDir, "..");
const serverDir = NodePath.resolve(desktopDir, "..", "server");
const require = NodeModule.createRequire(import.meta.url);
// Resolve the vite-plus CLI entry directly and run it with this node binary:
// PATH-based `vp` lookups from a nested spawn fail on Windows dev shells.
const vpBin = NodePath.join(
  NodePath.dirname(require.resolve("vite-plus/package.json")),
  "bin",
  "vp",
);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();

const children = [
  {
    name: "server-bundle",
    cwd: serverDir,
    args: [vpBin, "pack", "--watch", "--no-clean"],
  },
  {
    name: "desktop-bundle",
    cwd: desktopDir,
    args: [vpBin, "pack", "--watch"],
  },
  {
    name: "electron-launcher",
    cwd: desktopDir,
    args: [NodePath.join(scriptsDir, "dev-electron.mjs")],
  },
].map((spec) => {
  const child = NodeChildProcess.spawn(process.execPath, spec.args, {
    cwd: spec.cwd,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", (error) => {
    console.error(`[dev-desktop-bundles] ${spec.name} failed to start: ${error.message}`);
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev-desktop-bundles] ${spec.name} exited (${signal ?? code}); shutting down`);
    void shutdown(spec.name === "electron-launcher" ? (code ?? 1) : code || 1);
  });
  return { ...spec, child };
});

let shuttingDown = false;

function killTree(child) {
  if (typeof child.pid !== "number" || child.exitCode !== null || child.signalCode !== null) return;
  if (hostPlatform === "win32") {
    NodeChildProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) killTree(child);
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
process.once("SIGHUP", () => void shutdown(129));
