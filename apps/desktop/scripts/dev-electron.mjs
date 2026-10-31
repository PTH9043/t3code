import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  desktopDir,
  resolveDevProtocolClient,
  resolveElectronLaunchCommand,
} from "./electron-launcher.mjs";
import { inspectAutomaticRestart } from "./dev-restart-guard.mjs";
import { waitForResources } from "./wait-for-resources.mjs";
import { watchDesktopBundles } from "./watch-desktop-bundles.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "../server/dist/bin.mjs",
];
const forcedShutdownTimeoutMs = 1_500;
// Long enough to swallow a rebuild burst: one contracts edit rewrites
// main.cjs, preload.cjs and bin.mjs within about a second, and every restart
// kills the backend — and any in-app agent turn running on it — so restarting
// once per burst matters.
const restartDebounceMs = 1_000;
const activeWorkRetryMs = 5_000;
// A main process that dies (or fails to load) this soon after launch is a
// broken bundle, not a transient. After `rapidCrashLimit` such launches the
// loop waits for the next bundle change instead of respawning forever.
const rapidCrashWindowMs = 15_000;
const rapidCrashLimit = 3;
// A rebuild burst can make healthy launches look like crashes: an instance
// started while its predecessor is still releasing the single-instance lock
// quits at once. One relaunch after a quiet spell tells the two apart; only
// a second streak holds for a new bundle.
const rapidCrashCooldownMs = 10_000;
const mainLoadFailureMarker = "App threw an error during load";
const childTreeGracePeriodMs = 1_200;
const remoteDebuggingPort = process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();

await waitForResources({
  baseDir: desktopDir,
  files: requiredFiles,
  tcpHost: devServer.hostname,
  tcpPort: port,
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const devProtocolClient = resolveDevProtocolClient();
if (devProtocolClient) {
  childEnv.T3CODE_DESKTOP_APP_USER_MODEL_ID = devProtocolClient.appBundleId;
  childEnv.T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED = "1";
}

let shuttingDown = false;
let restartTimer = null;
let activeWorkRetryTimer = null;
let activeWorkReason = null;
let currentApp = null;
let currentAppStartedAt = 0;
let rapidCrashCount = 0;
/** Set when the bundle proved unloadable; cleared by the next bundle change. */
let heldForBundleChange = false;
let cooldownRetryTimer = null;
/** True once the post-streak relaunch has been spent on this bundle. */
let cooldownRetryUsed = false;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
let stopWatchingBundles = null;

function killChildTreeByPid(pid, signal) {
  if (typeof pid !== "number") {
    return;
  }

  if (hostPlatform === "win32") {
    // Windows has no signals: `ChildProcess.kill` terminates only the main
    // process and leaves its renderer/GPU children and the backend it spawned
    // running. taskkill /T takes the whole tree down.
    NodeChildProcess.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function holdForBundleChange(reason) {
  heldForBundleChange = true;
  console.error(`[dev-electron] ${reason}; waiting for the next bundle change before relaunching`);
}

function delayAutomaticStop(reason, retry) {
  if (activeWorkReason !== reason) {
    console.error(
      `[dev-electron] delaying automatic restart while work is active or cannot be checked (${reason})`,
    );
    activeWorkReason = reason;
  }
  if (!activeWorkRetryTimer) {
    activeWorkRetryTimer = setTimeout(() => {
      activeWorkRetryTimer = null;
      retry();
    }, activeWorkRetryMs);
  }
}

function clearAutomaticStopDelay() {
  activeWorkReason = null;
  if (activeWorkRetryTimer) {
    clearTimeout(activeWorkRetryTimer);
    activeWorkRetryTimer = null;
  }
}

function stopFailedAppWhenSafe(app) {
  restartQueue = restartQueue
    .catch(() => undefined)
    .then(async () => {
      if (shuttingDown || !heldForBundleChange || currentApp !== app) return;
      if (hostPlatform === "win32") {
        const inspection = inspectAutomaticRestart(app.pid);
        if (!inspection.safe) {
          delayAutomaticStop(inspection.reason, () => stopFailedAppWhenSafe(app));
          return;
        }
      }
      clearAutomaticStopDelay();
      await stopApp();
    });
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const electronArgs = remoteDebuggingPort
    ? [`--remote-debugging-port=${remoteDebuggingPort}`]
    : [];
  const launchArgs = devProtocolClient
    ? electronArgs
    : [...electronArgs, `--t3code-dev-root=${desktopDir}`, "dist-electron/main.cjs"];
  const electronCommand = resolveElectronLaunchCommand(launchArgs);
  // stderr is piped (and echoed) so a main-process load failure can be
  // recognised: Electron reports it there and then sits on a modal error
  // dialog instead of exiting, which no exit-code check would ever see.
  const app = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
    cwd: desktopDir,
    env: childEnv,
    stdio: ["inherit", "inherit", "pipe"],
  });

  currentApp = app;
  currentAppStartedAt = Date.now();

  let loadFailed = false;
  app.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    if (loadFailed || !chunk.toString().includes(mainLoadFailureMarker)) {
      return;
    }
    loadFailed = true;
    if (shuttingDown || currentApp !== app) {
      return;
    }
    holdForBundleChange("main process failed to load the bundle");
    stopFailedAppWhenSafe(app);
  });

  app.once("error", () => {
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown) {
      scheduleRestart();
    }
  });

  app.once("exit", (code, signal) => {
    if (currentApp === app) {
      currentApp = null;
    }

    const exitedAbnormally = signal !== null || code !== 0;
    if (shuttingDown || expectedExits.has(app) || !exitedAbnormally) {
      return;
    }
    const diedQuickly = Date.now() - currentAppStartedAt < rapidCrashWindowMs;
    rapidCrashCount = diedQuickly ? rapidCrashCount + 1 : 1;
    if (rapidCrashCount >= rapidCrashLimit) {
      if (cooldownRetryUsed) {
        holdForBundleChange(
          `app exited ${rapidCrashCount} times within ${rapidCrashWindowMs}ms of launch`,
        );
        return;
      }
      cooldownRetryUsed = true;
      heldForBundleChange = true;
      console.error(
        `[dev-electron] app exited ${rapidCrashCount} times within ${rapidCrashWindowMs}ms of launch; relaunching once after ${rapidCrashCooldownMs}ms`,
      );
      cooldownRetryTimer = setTimeout(() => {
        cooldownRetryTimer = null;
        if (shuttingDown || !heldForBundleChange) return;
        heldForBundleChange = false;
        rapidCrashCount = 0;
        scheduleRestart();
      }, rapidCrashCooldownMs);
      return;
    }
    scheduleRestart();
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    killChildTreeByPid(app.pid, "TERM");
    // Keep the parent alive until Windows has found and terminated its tree.
    // Killing it first can orphan its renderer and backend processes.
    if (hostPlatform !== "win32") app.kill("SIGTERM");

    setTimeout(() => {
      if (settled) {
        return;
      }

      killChildTreeByPid(app.pid, "KILL");
      if (hostPlatform !== "win32") app.kill("SIGKILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart({ bundleChanged = false } = {}) {
  if (shuttingDown) {
    return;
  }

  if (bundleChanged) {
    // A fresh bundle is a fresh chance: forget the crash streak and any hold.
    rapidCrashCount = 0;
    heldForBundleChange = false;
    cooldownRetryUsed = false;
    if (cooldownRetryTimer) {
      clearTimeout(cooldownRetryTimer);
      cooldownRetryTimer = null;
    }
  } else if (heldForBundleChange) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        if (currentApp && hostPlatform === "win32") {
          const inspection = inspectAutomaticRestart(currentApp.pid);
          if (!inspection.safe) {
            delayAutomaticStop(inspection.reason, () => scheduleRestart());
            return;
          }
        }
        clearAutomaticStopDelay();
        await stopApp();
        if (!shuttingDown) {
          startApp();
        }
      });
  }, restartDebounceMs);
}

function startWatchers() {
  stopWatchingBundles = watchDesktopBundles({
    files: requiredFiles.map((file) => NodePath.resolve(desktopDir, file)),
    platform: hostPlatform,
    onChange: () => scheduleRestart({ bundleChanged: true }),
  });
}

function killChildTree(signal) {
  if (hostPlatform === "win32") {
    return;
  }

  // Kill direct children as a final fallback in case normal shutdown leaves stragglers.
  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], {
    stdio: "ignore",
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (activeWorkRetryTimer) {
    clearTimeout(activeWorkRetryTimer);
    activeWorkRetryTimer = null;
  }

  stopWatchingBundles?.();
  stopWatchingBundles = null;

  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");

  process.exit(exitCode);
}

startWatchers();
startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
