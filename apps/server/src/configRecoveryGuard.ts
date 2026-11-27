// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface ConfigBackupResult {
  readonly written: boolean;
  readonly backupPath: string;
  readonly sha256: string;
}

/**
 * DSH #11714-inspired ConfigRecoveryGuard:
 * Maintains an atomic Last-Known-Good (LKG) snapshot of `settings.json` under
 * `<stateDir>/.recovery/last-known-good/` so a corrupt config edit or adapter
 * plugin fault never takes down the T3 core server or Electron UI.
 */
export function resolveLastKnownGoodPath(settingsPath: string): string {
  const dir = NodePath.dirname(settingsPath);
  const base = NodePath.basename(settingsPath);
  return NodePath.join(dir, ".recovery", "last-known-good", base);
}

export function sha256OfText(text: string): string {
  return NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function saveLastKnownGoodConfig(
  settingsPath: string,
  rawJsonText: string,
): ConfigBackupResult {
  const backupPath = resolveLastKnownGoodPath(settingsPath);
  const digest = sha256OfText(rawJsonText);
  try {
    if (NodeFS.existsSync(backupPath)) {
      const existing = NodeFS.readFileSync(backupPath, "utf8");
      if (sha256OfText(existing) === digest) {
        return { written: false, backupPath, sha256: digest };
      }
    }
    NodeFS.mkdirSync(NodePath.dirname(backupPath), { recursive: true });
    const tmp = `${backupPath}.${process.pid}.tmp`;
    NodeFS.writeFileSync(tmp, rawJsonText, "utf8");
    NodeFS.renameSync(tmp, backupPath);
    return { written: true, backupPath, sha256: digest };
  } catch {
    return { written: false, backupPath, sha256: digest };
  }
}

export function readLastKnownGoodConfig(settingsPath: string): string | null {
  const backupPath = resolveLastKnownGoodPath(settingsPath);
  try {
    if (!NodeFS.existsSync(backupPath)) return null;
    const text = NodeFS.readFileSync(backupPath, "utf8");
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

export interface AdapterIsolationState {
  readonly instanceId: string;
  readonly status: "healthy" | "degraded";
  readonly lastError?: string;
  readonly failureCount: number;
}

/**
 * Isolates failing provider/plugin adapters as `degraded` so one broken
 * provider never crashes the control plane or other healthy adapters.
 */
export class AdapterCircuitBreaker {
  private readonly states = new Map<string, AdapterIsolationState>();

  recordSuccess(instanceId: string): void {
    this.states.set(instanceId, {
      instanceId,
      status: "healthy",
      failureCount: 0,
    });
  }

  recordFailure(instanceId: string, error: unknown): AdapterIsolationState {
    const prev = this.states.get(instanceId);
    const next: AdapterIsolationState = {
      instanceId,
      status: "degraded",
      lastError: error instanceof Error ? error.message : String(error),
      failureCount: (prev?.failureCount ?? 0) + 1,
    };
    this.states.set(instanceId, next);
    return next;
  }

  getState(instanceId: string): AdapterIsolationState | undefined {
    return this.states.get(instanceId);
  }

  listDegraded(): ReadonlyArray<AdapterIsolationState> {
    return Array.from(this.states.values()).filter((s) => s.status === "degraded");
  }
}
