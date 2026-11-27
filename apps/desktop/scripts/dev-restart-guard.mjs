import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { DatabaseSync } from "node:sqlite";

const guardPath = NodeURL.fileURLToPath(new URL("./dev-restart-guard.py", import.meta.url));

/** Do not interrupt active agent work just to reload a rebuilt development bundle. */
export function inspectAutomaticRestart(pid, environment = process.env) {
  const configuredHome = environment.T3CODE_HOME?.trim();
  const stateDir = configuredHome
    ? NodePath.join(NodePath.resolve(configuredHome), "userdata")
    : NodePath.join(NodeOS.homedir(), ".t3", "dev");
  let lock;
  try {
    lock = new DatabaseSync(NodePath.join(stateDir, ".assistant-voice-restart-guard.sqlite"), {
      timeout: 100,
    });
    lock.exec("BEGIN IMMEDIATE");
  } catch (error) {
    lock?.close();
    return {
      safe: false,
      reason: error?.errcode === 5 ? "assistant-recording" : "state-unavailable",
    };
  }
  const release = () => {
    lock?.close();
    lock = undefined;
  };
  let keepLock = false;
  try {
    const result = NodeChildProcess.spawnSync(
      "python",
      [guardPath, NodePath.join(stateDir, "state.sqlite"), String(pid)],
      { encoding: "utf8", shell: false, windowsHide: true, timeout: 5_000 },
    );
    if (result.status !== 0) return { safe: false, reason: "state-unavailable" };
    const response = JSON.parse(result.stdout);
    if (typeof response.safe === "boolean" && typeof response.reason === "string") {
      if (response.safe) {
        keepLock = true;
        return { ...response, release };
      }
      return response;
    }
  } catch {
    // A malformed response is not proof that the app is idle.
  } finally {
    if (!keepLock) release();
  }
  return { safe: false, reason: "state-unavailable" };
}
