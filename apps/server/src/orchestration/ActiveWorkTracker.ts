// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import type { ExecutionKind } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface ActiveWorkItem {
  readonly kind: "turn" | "delegation" | "collaboration";
  readonly executionKind?: ExecutionKind | undefined;
  readonly id: string;
  readonly threadId: string;
  readonly summary: string;
  readonly startedAtMs: number;
}

export interface ActiveWorkSnapshot {
  readonly updatedAt: string;
  readonly pid: number;
  readonly activeTurns: number;
  readonly activeDelegations: number;
  readonly activeCollaborations: number;
  readonly totalActive: number;
  readonly items: ReadonlyArray<ActiveWorkItem & { readonly elapsedSec: number }>;
}

/**
 * Process-wide registry of in-flight turns & delegations, mirrored atomically
 * to `<stateDir>/active-work.json` so external launchers (`runtime.py`) can
 * block or wait-drain before terminating a production server mid-flight.
 */
class ActiveWorkRegistry {
  private readonly items = new Map<string, ActiveWorkItem>();
  private stateFilePath: string | null = null;

  configureStateDir(stateDir: string): void {
    this.stateFilePath = NodePath.join(stateDir, "active-work.json");
    this.flushToDisk();
  }

  register(item: ActiveWorkItem): void {
    this.items.set(`${item.kind}:${item.id}`, item);
    this.flushToDisk();
  }

  unregister(kind: ActiveWorkItem["kind"], id: string): void {
    if (this.items.delete(`${kind}:${id}`)) {
      this.flushToDisk();
    }
  }

  clearAll(): void {
    this.items.clear();
    this.flushToDisk();
  }

  snapshot(nowMs = Date.now()): ActiveWorkSnapshot {
    let activeTurns = 0;
    let activeDelegations = 0;
    let activeCollaborations = 0;
    const list: Array<ActiveWorkItem & { readonly elapsedSec: number }> = [];
    for (const item of this.items.values()) {
      if (item.kind === "turn") activeTurns += 1;
      else if (item.kind === "delegation") activeDelegations += 1;
      else activeCollaborations += 1;
      list.push({
        ...item,
        elapsedSec: Math.max(0, Math.round((nowMs - item.startedAtMs) / 1_000)),
      });
    }
    return {
      updatedAt: new Date(nowMs).toISOString(),
      pid: process.pid,
      activeTurns,
      activeDelegations,
      activeCollaborations,
      totalActive: list.length,
      items: list,
    };
  }

  private flushToDisk(): void {
    if (!this.stateFilePath) return;
    try {
      const snap = this.snapshot();
      const tmp = `${this.stateFilePath}.${process.pid}.tmp`;
      NodeFS.mkdirSync(NodePath.dirname(this.stateFilePath), { recursive: true });
      NodeFS.writeFileSync(tmp, JSON.stringify(snap, null, 2), "utf8");
      NodeFS.renameSync(tmp, this.stateFilePath);
    } catch {
      // Best-effort diagnostics mirror; never break the hot path.
    }
  }
}

export const activeWorkRegistry = new ActiveWorkRegistry();
