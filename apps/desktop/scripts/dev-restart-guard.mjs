import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const guardPath = NodeURL.fileURLToPath(new URL("./dev-restart-guard.py", import.meta.url));

/** Do not interrupt active agent work just to reload a rebuilt development bundle. */
export function inspectAutomaticRestart(pid, environment = process.env) {
  const configuredHome = environment.T3CODE_HOME?.trim();
  const stateDir = configuredHome
    ? NodePath.join(NodePath.resolve(configuredHome), "userdata")
    : NodePath.join(NodeOS.homedir(), ".t3", "dev");
  const result = NodeChildProcess.spawnSync(
    "python",
    [guardPath, NodePath.join(stateDir, "state.sqlite"), String(pid)],
    { encoding: "utf8", shell: false, windowsHide: true, timeout: 5_000 },
  );
  if (result.status !== 0) return { safe: false, reason: "state-unavailable" };
  try {
    const response = JSON.parse(result.stdout);
    return typeof response.safe === "boolean" && typeof response.reason === "string"
      ? response
      : { safe: false, reason: "state-unavailable" };
  } catch {
    return { safe: false, reason: "state-unavailable" };
  }
}
