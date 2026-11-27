// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import { execFile } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  configureNearHeapLimitSnapshot,
  createMemoryWatchdogController,
  MEMORY_FAST_POLL_HEAP_MB,
  MEMORY_HIGH_HEAP_INTERVAL_MS,
  MEMORY_WATCHDOG_INTERVAL_MS,
  resolveMemoryWatchdogIntervalMs,
} from "./MemoryWatchdog.ts";
import { makeServerSelfSignals } from "./ServerSelfSignals.ts";

const execFileAsync = promisify(execFile);
const SUMMARY_CLI = NodePath.resolve(
  import.meta.dirname,
  "../../../../scripts/summarize-memory-log.mjs",
);

describe("Wave 1-B1: MemoryWatchdog 회전 파일 로깅 · 동적 주기 · slowOpsTop5 · 요약 CLI", () => {
  const tempDirs: string[] = [];
  const mkTempDir = (prefix: string) => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      try {
        NodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("switches polling interval dynamically between 60s (< 2GB) and 10s (>= 2GB)", () => {
    expect(resolveMemoryWatchdogIntervalMs(500)).toBe(MEMORY_WATCHDOG_INTERVAL_MS);
    expect(resolveMemoryWatchdogIntervalMs(MEMORY_FAST_POLL_HEAP_MB - 0.1)).toBe(60_000);
    expect(resolveMemoryWatchdogIntervalMs(MEMORY_FAST_POLL_HEAP_MB)).toBe(
      MEMORY_HIGH_HEAP_INTERVAL_MS,
    );
    expect(resolveMemoryWatchdogIntervalMs(3_200)).toBe(10_000);
  });

  it("writes NDJSON samples with slowOpsTop5, rotates at maxBytes keeping maxFiles, and survives disk write failure without throwing", async () => {
    const tmp = mkTempDir("t3-mem-b1-");
    const logsDir = NodePath.join(tmp, "logs");

    const signals = makeServerSelfSignals();
    const recordSlow = (name: string, durationMs: number) =>
      signals.recordSpan({
        type: "effect-span",
        name,
        kind: "internal",
        traceId: "t1",
        spanId: "s1",
        sampled: true,
        startTimeUnixNano: "0",
        endTimeUnixNano: String(Date.now() * 1_000_000),
        durationMs,
        attributes: {},
        events: [],
        links: [],
        exit: { _tag: "Success" },
      });

    recordSlow("applySnapshot", 4_200);
    recordSlow("applySnapshot", 1_500);
    recordSlow("WorkspaceKnowledgeReactor.reconcile", 6_360);
    recordSlow("fastOp", 45); // < 1s -> must be excluded

    let mockHeapBytes = 512 * 1024 * 1024;
    const controller = createMemoryWatchdogController({
      stateDir: tmp,
      logsDir,
      dbPath: NodePath.join(tmp, "none.sqlite"),
      enableIdleArchive: false,
      enableNearHeapLimitSnapshot: false,
      logMaxBytes: 420,
      logMaxFiles: 2,
      getProviderSessionCount: () => Effect.succeed(4),
      getDirectoryBindingCount: () => Effect.succeed(2),
      drainSlowOps: (limit) => signals.drainSlowOperationsTop(limit),
      sampleMemory: () => ({
        rss: mockHeapBytes + 128 * 1024 * 1024,
        heapUsed: mockHeapBytes,
        heapTotal: mockHeapBytes + 64 * 1024 * 1024,
        external: 12 * 1024 * 1024,
        arrayBuffers: 4 * 1024 * 1024,
        heapLimit: 4_096 * 1024 * 1024,
      }),
    });

    try {
      const r1 = await Effect.runPromise(controller.tickOnce);
      expect(r1.persistedToFile).toBe(true);
      expect(r1.nextIntervalMs).toBe(60_000);
      expect(r1.sample.slowOpsTop5.length).toBe(2);
      expect(r1.sample.slowOpsTop5[0]?.name).toBe("WorkspaceKnowledgeReactor.reconcile");
      expect(r1.sample.slowOpsTop5[1]?.name).toBe("applySnapshot");
      expect(r1.sample.slowOpsTop5[1]?.count).toBe(2);
      expect(r1.sample.pid).toBe(process.pid);
      expect(r1.sample.providerSessions).toBe(4);
      expect(r1.snapshotPath).toBeNull();

      // Simulate heap >= 2GB -> interval switches to 10s & trigger rotation across multiple ticks
      mockHeapBytes = 2_300 * 1024 * 1024;
      for (let i = 0; i < 6; i += 1) {
        const res = await Effect.runPromise(controller.tickOnce);
        expect(res.nextIntervalMs).toBe(10_000);
        // Drained after first tick -> empty on subsequent ticks
        expect(res.sample.slowOpsTop5.length).toBe(0);
      }

      // Verify rotation happened and backup files are bounded by logMaxFiles=2
      expect(NodeFs.existsSync(NodePath.join(logsDir, "memory.ndjson"))).toBe(true);
      expect(NodeFs.existsSync(NodePath.join(logsDir, "memory.ndjson.1"))).toBe(true);
      expect(NodeFs.existsSync(NodePath.join(logsDir, "memory.ndjson.3"))).toBe(false);

      // Verify write failure tolerance: point logsDir to an existing regular file path
      const blockingFile = NodePath.join(tmp, "not-a-dir");
      NodeFs.writeFileSync(blockingFile, "block");
      const brokenController = createMemoryWatchdogController({
        stateDir: tmp,
        logsDir: blockingFile,
        dbPath: NodePath.join(tmp, "none.sqlite"),
        enableIdleArchive: false,
        enableNearHeapLimitSnapshot: false,
      });
      try {
        const rFail = await Effect.runPromise(brokenController.tickOnce);
        expect(rFail.persistedToFile).toBe(false);
        expect(rFail.sample.heapUsedMB).toBeGreaterThan(0);
      } finally {
        brokenController.dispose();
      }
    } finally {
      controller.dispose();
    }

    // Verify Node 24 near-heap-limit snapshot support detection
    const nearLimit = configureNearHeapLimitSnapshot(2);
    expect(nearLimit.supported).toBe(true);
  });

  it("runs read-only summarize-memory-log.mjs CLI and reports hourly max heap, MB/min growth, and spike slowOps", async () => {
    const tmp = mkTempDir("t3-mem-cli-");
    const logPath = NodePath.join(tmp, "memory.ndjson");
    const baseMs = Date.now() - 10 * 60_000;
    const rows = [
      {
        ts: new Date(baseMs).toISOString(),
        tsMs: baseMs,
        pid: 1234,
        uptimeSec: 100,
        rssMB: 600,
        heapUsedMB: 400,
        heapTotalMB: 500,
        externalMB: 20,
        arrayBuffersMB: 5,
        heapLimitMB: 4096,
        eventLoopP99Ms: 12.5,
        activeWorkTotal: 0,
        providerSessions: 2,
        directoryBindings: 1,
        slowOpsTop5: [],
      },
      {
        ts: new Date(baseMs + 60_000).toISOString(),
        tsMs: baseMs + 60_000,
        pid: 1234,
        uptimeSec: 160,
        rssMB: 1300,
        heapUsedMB: 950,
        heapTotalMB: 1100,
        externalMB: 25,
        arrayBuffersMB: 6,
        heapLimitMB: 4096,
        eventLoopP99Ms: 42.1,
        activeWorkTotal: 2,
        providerSessions: 5,
        directoryBindings: 2,
        slowOpsTop5: [{ name: "applySnapshot", maxMs: 3800, totalMs: 3800, count: 1 }],
      },
    ];
    NodeFs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [SUMMARY_CLI, "--file", logPath, "--hours", "24", "--json"],
      { windowsHide: true },
    );
    const parsed = JSON.parse(stdout) as {
      readonly sampleCount: number;
      readonly maxHeapUsedMB: number;
      readonly topSpikes: ReadonlyArray<{
        readonly deltaMB: number;
        readonly rateMBPerMin: number;
        readonly slowOpsTop5: ReadonlyArray<{ readonly name: string }>;
      }>;
    };
    expect(parsed.sampleCount).toBe(2);
    expect(parsed.maxHeapUsedMB).toBe(950);
    expect(parsed.topSpikes[0]?.deltaMB).toBe(550);
    expect(parsed.topSpikes[0]?.rateMBPerMin).toBe(550);
    expect(parsed.topSpikes[0]?.slowOpsTop5[0]?.name).toBe("applySnapshot");
  });
});
