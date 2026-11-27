// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { activeWorkRegistry } from "../orchestration/ActiveWorkTracker.ts";
import { rotateAgedEventsToColdArchive } from "../persistence/EventLogArchiver.ts";

/**
 * 5-minute server memory & connection watchdog + safe in-process idle DB archiver.
 *
 * Addresses two production incidents (2026-11-26 ~ 11-27):
 * 1. JavaScript heap OOM (~3.8 GB after ~2h uptime, 770 sessions) with zero
 *    memory telemetry in logs -> logs RSS/heap/external/session/active-work
 *    metrics every 5 minutes and writes a bounded rotating V8 heap snapshot
 *    once heapUsed crosses the critical threshold.
 * 2. Live `database is locked` errors caused by external `--apply --vacuum`
 *    -> runs small-batch (`1,000` rows + `PRAGMA incremental_vacuum`) in-process
 *    cold archiving ONLY after sustained server idle (`activeWorkCount === 0`
 *    for >= 15 minutes), at most once per 24 hours.
 */

export const MEMORY_WATCHDOG_INTERVAL_MS = 5 * 60_000;
export const MEMORY_WARN_HEAP_MB = 2_200;
export const MEMORY_SNAPSHOT_HEAP_MB = 2_800;
export const MAX_RETAINED_HEAP_SNAPSHOTS = 2;
const SNAPSHOT_COOLDOWN_MS = 60 * 60_000;
const IDLE_ARCHIVE_REQUIRED_MS = 15 * 60_000;
const IDLE_ARCHIVE_INTERVAL_MS = 24 * 60 * 60_000;
const IDLE_ARCHIVE_BATCH_LIMIT = 1_000;

export interface MemoryTelemetrySample {
  readonly rssMB: number;
  readonly heapUsedMB: number;
  readonly heapTotalMB: number;
  readonly externalMB: number;
  readonly arrayBuffersMB: number;
  readonly heapLimitMB: number;
  readonly activeWorkTotal: number;
  readonly providerSessions: number;
  readonly directoryBindings: number;
}

export interface MemoryWatchdogOptions {
  readonly stateDir: string;
  readonly logsDir: string;
  readonly dbPath: string;
  readonly intervalMs?: number | undefined;
  readonly warnHeapMB?: number | undefined;
  readonly snapshotHeapMB?: number | undefined;
  readonly enableIdleArchive?: boolean | undefined;
  readonly getProviderSessionCount?: () => Effect.Effect<number, unknown>;
  readonly getDirectoryBindingCount?: () => Effect.Effect<number, unknown>;
}

function toMB(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10;
}

function pruneOldHeapSnapshots(logsDir: string, keepCount = MAX_RETAINED_HEAP_SNAPSHOTS): void {
  try {
    if (!NodeFs.existsSync(logsDir)) return;
    const files = NodeFs.readdirSync(logsDir)
      .filter((name) => name.startsWith("heap-") && name.endsWith(".heapsnapshot"))
      .map((name) => {
        const fullPath = NodePath.join(logsDir, name);
        const mtimeMs = NodeFs.statSync(fullPath).mtimeMs;
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of files.slice(keepCount)) {
      NodeFs.rmSync(stale.fullPath, { force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}

export function captureMemoryTelemetrySample(counts: {
  readonly providerSessions: number;
  readonly directoryBindings: number;
}): MemoryTelemetrySample {
  const mem = process.memoryUsage();
  const heapStats = NodeV8.getHeapStatistics();
  const active = activeWorkRegistry.snapshot();
  return {
    rssMB: toMB(mem.rss),
    heapUsedMB: toMB(mem.heapUsed),
    heapTotalMB: toMB(mem.heapTotal),
    externalMB: toMB(mem.external),
    arrayBuffersMB: toMB(mem.arrayBuffers),
    heapLimitMB: toMB(heapStats.heap_size_limit),
    activeWorkTotal: active.totalActive,
    providerSessions: counts.providerSessions,
    directoryBindings: counts.directoryBindings,
  };
}

export function createMemoryWatchdogController(options: MemoryWatchdogOptions) {
  const warnHeapMB = options.warnHeapMB ?? MEMORY_WARN_HEAP_MB;
  const snapshotHeapMB = options.snapshotHeapMB ?? MEMORY_SNAPSHOT_HEAP_MB;
  let lastSnapshotAtMs = 0;
  let idleSinceMs: number | null = null;
  let lastIdleArchiveAtMs = 0;

  const tickOnce = Effect.gen(function* () {
    const nowMs = Date.now();
    const providerSessions = options.getProviderSessionCount
      ? yield* options.getProviderSessionCount().pipe(Effect.orElseSucceed(() => -1))
      : -1;
    const directoryBindings = options.getDirectoryBindingCount
      ? yield* options.getDirectoryBindingCount().pipe(Effect.orElseSucceed(() => -1))
      : -1;

    const sample = captureMemoryTelemetrySample({ providerSessions, directoryBindings });

    if (sample.heapUsedMB >= warnHeapMB) {
      yield* Effect.logWarning("server.memory.high", sample);
    } else {
      yield* Effect.logInfo("server.memory.telemetry", sample);
    }

    let snapshotPath: string | null = null;
    if (sample.heapUsedMB >= snapshotHeapMB && nowMs - lastSnapshotAtMs >= SNAPSHOT_COOLDOWN_MS) {
      lastSnapshotAtMs = nowMs;
      const target = yield* Effect.try({
        try: () => {
          NodeFs.mkdirSync(options.logsDir, { recursive: true });
          const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
          const filePath = NodePath.join(options.logsDir, `heap-${stamp}.heapsnapshot`);
          const written = NodeV8.writeHeapSnapshot(filePath);
          pruneOldHeapSnapshots(options.logsDir);
          return written;
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logError("server.memory.heap_snapshot_failed", {
            heapUsedMB: sample.heapUsedMB,
            cause: String(cause),
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
      if (target) {
        snapshotPath = target;
        yield* Effect.logWarning("server.memory.heap_snapshot_written", {
          snapshotPath: target,
          heapUsedMB: sample.heapUsedMB,
          rssMB: sample.rssMB,
        });
      }
    }

    // In-process safe small-batch DB archiving when completely idle for >= 15 min (max 1x/day).
    if (options.enableIdleArchive !== false) {
      if (sample.activeWorkTotal > 0) {
        idleSinceMs = null;
      } else {
        if (idleSinceMs === null) {
          idleSinceMs = nowMs;
        }
        const idleDurationMs = nowMs - idleSinceMs;
        const dueForArchive = nowMs - lastIdleArchiveAtMs >= IDLE_ARCHIVE_INTERVAL_MS;
        if (
          idleDurationMs >= IDLE_ARCHIVE_REQUIRED_MS &&
          dueForArchive &&
          NodeFs.existsSync(options.dbPath)
        ) {
          lastIdleArchiveAtMs = nowMs;
          const archiveDir = NodePath.join(options.stateDir, "archives");
          const res = yield* Effect.try({
            try: () =>
              rotateAgedEventsToColdArchive({
                hotDbPath: options.dbPath,
                archiveDir,
                batchLimit: IDLE_ARCHIVE_BATCH_LIMIT,
                activeWorkCount: activeWorkRegistry.snapshot().totalActive,
                dryRun: false,
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("server.idle_archive.failed", { cause: String(cause) }),
            ),
            Effect.orElseSucceed(() => null),
          );
          if (res && (res.archivedEvents > 0 || res.archivedActivities > 0)) {
            yield* Effect.logInfo("server.idle_archive.completed", {
              archivedEvents: res.archivedEvents,
              archivedActivities: res.archivedActivities,
              reclaimedBytes: res.reclaimedBytes,
              archiveDbPath: res.archiveDbPath,
            });
          }
        }
      }
    }

    return { sample, snapshotPath };
  });

  const start = Effect.gen(function* () {
    const intervalMs = Math.max(10_000, options.intervalMs ?? MEMORY_WATCHDOG_INTERVAL_MS);
    yield* tickOnce.pipe(Effect.ignoreCause({ log: true }));
    yield* tickOnce.pipe(
      Effect.ignoreCause({ log: true }),
      Effect.repeat(Schedule.spaced(Duration.millis(intervalMs))),
      Effect.forkScoped,
    );
  });

  return { tickOnce, start };
}
