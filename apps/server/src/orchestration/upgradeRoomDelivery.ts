// @effect-diagnostics nodeBuiltinImport:off
// Match the Windows launcher's canonical primary path before opening the independent journal.
import path from "node:path";
import { installUpgradeRoomKnowledge } from "./upgradeRoomKnowledge.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import * as Effect from "effect/Effect";

/** Only the primary server that owns the canonical event log can publish these records. */
export async function startUpgradeRoomDelivery(
  config: { baseDir: string; dbPath: string; upgradeRoom?: unknown },
  dispatch: OrchestrationEngineShape["dispatch"],
) {
  if (
    config.upgradeRoom ||
    process.platform !== "win32" ||
    path.win32.relative("E:/NewAutoUsage", config.baseDir) !== ""
  )
    return;
  const bridge = installUpgradeRoomKnowledge({
    role: "primary",
    dbPath: config.dbPath,
    env: {
      T3CODE_UPGRADE_PRIMARY_HOME: config.baseDir,
      T3CODE_UPGRADE_PROJECT_ROOT: "D:/__NewAutoUsage",
    },
    dispatchAuthorized: (command) => Effect.runPromise(dispatch(command)),
  });
  // The bridge watches for a later room installation and drains committed records on startup.
  // Its queue carries IDs only. Failed deliveries remain durable and are retried by the watcher.
  return bridge?.watch(() => {
    Effect.runSync(Effect.logWarning("AutoUsage 업그레이드 방의 기억 전달을 다시 시도합니다."));
  });
}
