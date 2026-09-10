// Runs the two bundle watchers desktop development needs, side by side:
//
//   - apps/server  `vp pack --watch --no-clean`  → apps/server/dist/bin.mjs
//   - apps/desktop `vp pack --watch`             → dist-electron/*.cjs, which
//     also (re)launches Electron through the pack config's onSuccess hook.
//
// dev-electron.mjs watches both outputs and restarts the app when either
// changes, so a server-side edit now reaches the running desktop app without a
// manual `build:bundle`. `--no-clean` keeps service-launcher.mjs, which the
// one-shot `t3#build` produced and the watcher never rebuilds.
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
    args: ["pack", "--watch", "--no-clean"],
    env: {},
  },
  {
    name: "desktop-bundle",
    cwd: desktopDir,
    args: ["pack", "--watch"],
    env: { T3CODE_DESKTOP_DEV: "1" },
  },
].map((spec) => {
  const child = NodeChildProcess.spawn(process.execPath, [vpBin, ...spec.args], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: "inherit",
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[dev-desktop-bundles] ${spec.name} watcher exited (${signal ?? code}); shutting down`,
    );
    void shutdown(typeof code === "number" && code !== 0 ? code : 1);
  });
  return { ...spec, child };
});

let shuttingDown = false;

function killTree(child) {
  if (typeof child.pid !== "number" || child.exitCode !== null) return;
  if (hostPlatform === "win32") {
    NodeChildProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
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
