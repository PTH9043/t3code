// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off anyUnknownInErrorContext:off
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeV8 from "node:v8";
import { RotatingFileSink } from "@t3tools/shared/logging";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { activeWorkRegistry } from "../orchestration/ActiveWorkTracker.ts";
import { rotateAgedEventsToColdArchive } from "../persistence/EventLogArchiver.ts";
import { serverSelfSignals, type SlowOperationSummary } from "./ServerSelfSignals.ts";

/**
 * Server memory telemetry watchdog (60s normal / 10s when heap >= 2GB) + rotating
 * `userdata/logs/memory.ndjson` (10MB × 5) + V8 near-heap-limit snapshot support +
 * safe in-process idle DB archiver.
 *
 * Addresses production OOM incidents (37m / 122m uptime, ~3.8GB heap) where Effect logs
 * were lost on crash and synchronous 2.8GB `writeHeapSnapshot` risked triggering OOM.
 */

export const MEMORY_WATCHDOG_INTERVAL_MS = 60_000;
export const MEMORY_HIGH_HEAP_INTERVAL_MS = 10_000;
export const MEMORY_FAST_POLL_HEAP_MB = 2_000;
export const MEMORY_WARN_HEAP_MB = 2_200;
export const MEMORY_SNAPSHOT_HEAP_MB = 2_800;
export const MAX_RETAINED_HEAP_SNAPSHOTS = 2;
export const MEMORY_LOG_FILE_NAME = "memory.ndjson";
export const MEMORY_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const MEMORY_LOG_MAX_FILES = 5;

const SNAPSHOT_COOLDOWN_MS = 60 * 60_000;
const IDLE_ARCHIVE_REQUIRED_MS = 15 * 60_000;
const IDLE_ARCHIVE_INTERVAL_MS = 24 * 60 * 60_000;
const IDLE_ARCHIVE_BATCH_LIMIT = 1_000;

export interface MemoryTelemetrySample {
  readonly ts: string;
  readonly tsMs: number;
  readonly pid: number;
  readonly uptimeSec: number;
  readonly rssMB: number;
  readonly heapUsedMB: number;
  readonly heapTotalMB: number;
  readonly externalMB: number;
  readonly arrayBuffersMB: number;
  readonly heapLimitMB: number;
  readonly eventLoopP99Ms: number;
  readonly activeWorkTotal: number;
  readonly providerSessions: number;
  readonly directoryBindings: number;
  readonly slowOpsTop5: ReadonlyArray<SlowOperationSummary>;
}

export interface NearHeapLimitConfigResult {
  readonly supported: boolean;
  readonly applied: boolean;
  readonly limit: number;
  readonly note: string;
}

export interface MemoryWatchdogOptions {
  readonly stateDir: string;
  readonly logsDir: string;
  readonly dbPath: string;
  readonly intervalMs?: number | undefined;
  readonly highHeapIntervalMs?: number | undefined;
  readonly fastPollHeapMB?: number | undefined;
  readonly warnHeapMB?: number | undefined;
  readonly snapshotHeapMB?: number | undefined;
  /**
   * Default `false`: direct synchronous `v8.writeHeapSnapshot()` near 2.8GB can itself
   * trigger OOM. Use `enableNearHeapLimitSnapshot` (Node `v8.setHeapSnapshotNearHeapLimit`)
   * instead unless explicitly requested.
   */
  readonly enableSyncThresholdSnapshot?: boolean | undefined;
  readonly enableNearHeapLimitSnapshot?: boolean | undefined;
  readonly enableIdleArchive?: boolean | undefined;
  readonly logFileName?: string | undefined;
  readonly logMaxBytes?: number | undefined;
  readonly logMaxFiles?: number | undefined;
  readonly getProviderSessionCount?: () => Effect.Effect<number, unknown>;
  readonly getDirectoryBindingCount?: () => Effect.Effect<number, unknown>;
  readonly drainSlowOps?: (limit: number) => ReadonlyArray<SlowOperationSummary>;
  readonly sampleMemory?: () => {
    readonly rss: number;
    readonly heapUsed: number;
    readonly heapTotal: number;
    readonly external: number;
    readonly arrayBuffers: number;
    readonly heapLimit: number;
  };
}

function toMB(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10;
}

export function resolveMemoryWatchdogIntervalMs(
  heapUsedMB: number,
  options?: {
    readonly intervalMs?: number | undefined;
    readonly highHeapIntervalMs?: number | undefined;
    readonly fastPollHeapMB?: number | undefined;
  },
): number {
  const normalMs = Math.max(1_000, options?.intervalMs ?? MEMORY_WATCHDOG_INTERVAL_MS);
  const fastMs = Math.max(1_000, options?.highHeapIntervalMs ?? MEMORY_HIGH_HEAP_INTERVAL_MS);
  const thresholdMB = options?.fastPollHeapMB ?? MEMORY_FAST_POLL_HEAP_MB;
  return heapUsedMB >= thresholdMB ? Math.min(normalMs, fastMs) : normalMs;
}

export function pruneOldHeapSnapshots(
  logsDir: string,
  keepCount = MAX_RETAINED_HEAP_SNAPSHOTS,
): number {
  let removed = 0;
  try {
    if (!NodeFs.existsSync(logsDir)) return 0;
    const files = NodeFs.readdirSync(logsDir)
      .filter((name) => name.endsWith(".heapsnapshot"))
      .map((name) => {
        const fullPath = NodePath.join(logsDir, name);
        const mtimeMs = NodeFs.statSync(fullPath).mtimeMs;
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of files.slice(Math.max(0, keepCount))) {
      NodeFs.rmSync(stale.fullPath, { force: true });
      removed += 1;
    }
  } catch {
    // Best-effort cleanup
  }
  return removed;
}

/**
 * Configures Node's native `v8.setHeapSnapshotNearHeapLimit(limit)` so V8 writes a bounded
 * heap snapshot safely right before hitting the heap ceiling (instead of calling synchronous
 * `writeHeapSnapshot()` at 2.8GB inside the JS event loop).
 */
export function configureNearHeapLimitSnapshot(
  limit = MAX_RETAINED_HEAP_SNAPSHOTS,
): NearHeapLimitConfigResult {
  const fn = (
    NodeV8 as unknown as { readonly setHeapSnapshotNearHeapLimit?: (limit: number) => void }
  ).setHeapSnapshotNearHeapLimit;
  if (typeof fn !== "function") {
    return {
      supported: false,
      applied: false,
      limit,
      note: "v8.setHeapSnapshotNearHeapLimit is unavailable in this Node runtime.",
    };
  }
  try {
    fn(limit);
    return {
      supported: true,
      applied: true,
      limit,
      note: `v8.setHeapSnapshotNearHeapLimit(${limit}) armed.`,
    };
  } catch (err) {
    // Node throws ERR_INVALID_STATE if `--heapsnapshot-near-heap-limit` or a previous call already armed it.
    return {
      supported: true,
      applied: false,
      limit,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

export function captureMemoryTelemetrySample(input: {
  readonly nowMs?: number;
  readonly providerSessions: number;
  readonly directoryBindings: number;
  readonly eventLoopP99Ms?: number;
  readonly slowOpsTop5?: ReadonlyArray<SlowOperationSummary>;
  readonly sampleMemory?: MemoryWatchdogOptions["sampleMemory"];
}): MemoryTelemetrySample {
  const nowMs = input.nowMs ?? Date.now();
  const mem = input.sampleMemory
    ? input.sampleMemory()
    : (() => {
        const usage = process.memoryUsage();
        const stats = NodeV8.getHeapStatistics();
        return {
          rss: usage.rss,
          heapUsed: usage.heapUsed,
          heapTotal: usage.heapTotal,
          external: usage.external,
          arrayBuffers: usage.arrayBuffers,
          heapLimit: stats.heap_size_limit,
        };
      })();
  const active = activeWorkRegistry.snapshot();
  return {
    ts: new Date(nowMs).toISOString(),
    tsMs: nowMs,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMB: toMB(mem.rss),
    heapUsedMB: toMB(mem.heapUsed),
    heapTotalMB: toMB(mem.heapTotal),
    externalMB: toMB(mem.external),
    arrayBuffersMB: toMB(mem.arrayBuffers),
    heapLimitMB: toMB(mem.heapLimit),
    eventLoopP99Ms: Math.round((input.eventLoopP99Ms ?? 0) * 100) / 100,
    activeWorkTotal: active.totalActive,
    providerSessions: input.providerSessions,
    directoryBindings: input.directoryBindings,
    slowOpsTop5: input.slowOpsTop5 ?? [],
  };
}

export function createMemoryWatchdogController(options: MemoryWatchdogOptions) {
  const warnHeapMB = options.warnHeapMB ?? MEMORY_WARN_HEAP_MB;
  const snapshotHeapMB = options.snapshotHeapMB ?? MEMORY_SNAPSHOT_HEAP_MB;
  const enableSyncThresholdSnapshot = options.enableSyncThresholdSnapshot ?? false;
  const enableNearHeapLimitSnapshot = options.enableNearHeapLimitSnapshot ?? true;
  const memoryLogPath = NodePath.join(options.logsDir, options.logFileName ?? MEMORY_LOG_FILE_NAME);
  const logMaxBytes = options.logMaxBytes ?? MEMORY_LOG_MAX_BYTES;
  const logMaxFiles = options.logMaxFiles ?? MEMORY_LOG_MAX_FILES;

  let sink: RotatingFileSink | null = null;
  let sinkInitFailed = false;
  let lastSnapshotAtMs = 0;
  let idleSinceMs: number | null = null;
  let lastIdleArchiveAtMs = 0;

  let histogram: NodePerfHooks.IntervalHistogram | null = null;
  try {
    histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    histogram = null;
  }

  const readEventLoopP99Ms = (): number => {
    if (!histogram) return 0;
    try {
      const val = histogram.percentile(99);
      histogram.reset();
      return Number.isFinite(val) && val > 0 ? val / 1_000_000 : 0;
    } catch {
      return 0;
    }
  };

  const appendSampleToFile = (sample: MemoryTelemetrySample): boolean => {
    try {
      if (!sink && !sinkInitFailed) {
        sink = new RotatingFileSink({
          filePath: memoryLogPath,
          maxBytes: logMaxBytes,
          maxFiles: logMaxFiles,
          throwOnError: false,
        });
      }
      if (!sink) return false;
      sink.write(`${JSON.stringify(sample)}\n`);
      return true;
    } catch {
      // Never impact server operation if disk write or directory creation fails.
      sinkInitFailed = true;
      sink = null;
      return false;
    }
  };

  const tickOnce = Effect.gen(function* () {
    const nowMs = Date.now();
    const providerSessions = options.getProviderSessionCount
      ? yield* options.getProviderSessionCount().pipe(Effect.orElseSucceed(() => -1))
      : -1;
    const directoryBindings = options.getDirectoryBindingCount
      ? yield* options.getDirectoryBindingCount().pipe(Effect.orElseSucceed(() => -1))
      : -1;
    const slowOpsTop5 = (
      options.drainSlowOps ?? ((limit: number) => serverSelfSignals.drainSlowOperationsTop(limit))
    )(5);

    const sample = captureMemoryTelemetrySample({
      nowMs,
      providerSessions,
      directoryBindings,
      eventLoopP99Ms: readEventLoopP99Ms(),
      slowOpsTop5,
      sampleMemory: options.sampleMemory,
    });

    const persistedToFile = appendSampleToFile(sample);
    const nextIntervalMs = resolveMemoryWatchdogIntervalMs(sample.heapUsedMB, options);

    if (sample.heapUsedMB >= warnHeapMB) {
      yield* Effect.logWarning("server.memory.high", {
        ...sample,
        persistedToFile,
        nextIntervalMs,
      });
    } else {
      yield* Effect.logInfo("server.memory.telemetry", { ...sample, persistedToFile });
    }

    let snapshotPath: string | null = null;
    if (
      enableSyncThresholdSnapshot &&
      sample.heapUsedMB >= snapshotHeapMB &&
      nowMs - lastSnapshotAtMs >= SNAPSHOT_COOLDOWN_MS
    ) {
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
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logError("server.memory.heap_snapshot_failed", {
            heapUsedMB: sample.heapUsedMB,
            cause,
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
            catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
          }).pipe(
            Effect.tapError((cause) => Effect.logWarning("server.idle_archive.failed", { cause })),
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

    return { sample, snapshotPath, persistedToFile, nextIntervalMs };
  });

  const dispose = () => {
    try {
      histogram?.disable();
    } catch {
      // ignore
    }
    histogram = null;
  };

  const start = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(dispose));
    pruneOldHeapSnapshots(options.logsDir);
    if (enableNearHeapLimitSnapshot) {
      const armed = configureNearHeapLimitSnapshot(MAX_RETAINED_HEAP_SNAPSHOTS);
      yield* Effect.logInfo("server.memory.near_heap_limit_snapshot", armed);
    }

    const first = yield* tickOnce.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("server.memory.tick_failed", { cause: String(cause) }).pipe(
          Effect.as(null),
        ),
      ),
    );
    let waitMs = first?.nextIntervalMs ?? resolveMemoryWatchdogIntervalMs(0, options);

    yield* Effect.forever(
      Effect.sleep(Duration.millis(waitMs)).pipe(
        Effect.andThen(
          tickOnce.pipe(
            Effect.tap((res) =>
              Effect.sync(() => {
                waitMs = res.nextIntervalMs;
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("server.memory.tick_failed", { cause: String(cause) }),
            ),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);
  });

  return { tickOnce, start, dispose, memoryLogPath };
}
