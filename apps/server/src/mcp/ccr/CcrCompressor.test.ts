import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";
import Migration0106 from "../../persistence/Migrations/106_CcrToolOutputs.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  alignPromptForPrefixCache,
  compressCodingToolOutputAtT0,
  compressToolOutputForCcr,
  evaluateBatchCompactionGate,
  formatCompactEditReceipt,
  scrubCcrPayload,
} from "./CcrCompressor.ts";
import { makeCcrToolOutputStore } from "../toolkits/workspaceCcr.ts";

describe("Wave 1 — Headroom Native CCR, SmartCrusher & CacheAligner", () => {
  it("compresses large JSON arrays by >=70% while preserving 100% of error/anomaly items", () => {
    const records = Array.from({ length: 120 }, (_, i) => ({
      id: `job-${i}`,
      status: i === 47 || i === 93 ? "error" : "ok",
      httpStatus: i === 47 ? 500 : i === 93 ? 503 : 200,
      passed: i !== 47 && i !== 93,
      message:
        i === 47
          ? "CRITICAL_SQLITE_LOCK_TIMEOUT on row 47"
          : i === 93
            ? "FATAL_OOM_WORKER_93"
            : `Routine batch item ${i} processed cleanly with standard metadata payload padding.`,
      durationMs: 12 + (i % 5),
    }));
    const rawJson = JSON.stringify({ runId: "batch-1", items: records });
    const result = compressToolOutputForCcr({
      toolName: "test_json_dump",
      rawText: rawJson,
      mimeHint: "json",
    });

    expect(result.compressed).toBe(true);
    expect(result.mimeKind).toBe("json");
    expect(result.savedPercent).toBeGreaterThanOrEqual(70);
    expect(result.summaryText).toContain("CRITICAL_SQLITE_LOCK_TIMEOUT on row 47");
    expect(result.summaryText).toContain("FATAL_OOM_WORKER_93");
    expect(result.summaryText).toContain(`outputHash=${result.outputHash}`);
    expect(result.summaryText).toContain("workspace_retrieve_output");
  });

  it("compresses verbose test logs while preserving FAIL/ERROR lines verbatim", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 250; i += 1) {
      if (i === 112) {
        lines.push("FAIL apps/server/src/auth.test.ts > rejects expired token");
        lines.push("AssertionError: expected 401 to be 200");
        lines.push("    at Object.<anonymous> (apps/server/src/auth.test.ts:44:12)");
      } else {
        lines.push(
          `2026-11-22T15:00:${String(i % 60).padStart(2, "0")}Z [info] worker tick ${i} completed in ${i % 17}ms`,
        );
      }
    }
    const rawLog = lines.join("\n");
    const result = compressToolOutputForCcr({
      toolName: "vitest_run",
      rawText: rawLog,
      mimeHint: "log",
    });

    expect(result.compressed).toBe(true);
    expect(result.savedPercent).toBeGreaterThanOrEqual(65);
    expect(result.summaryText).toContain("FAIL apps/server/src/auth.test.ts");
    expect(result.summaryText).toContain("AssertionError: expected 401 to be 200");
    expect(result.summaryText).toContain("at Object.<anonymous>");
  });

  it("scrubs secrets before CCR persistence and enforces strict thread isolation on retrieval", async () => {
    const store = makeCcrToolOutputStore();
    const secretPayload = JSON.stringify({
      items: Array.from({ length: 80 }, (_, i) => ({
        idx: i,
        note:
          i === 25
            ? "Leaked token Bearer eyJhbGciOiJIUzI1NiJ9.superSecretPayloadToken12345 and key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"
            : `normal payload line ${i} `.repeat(4),
      })),
    });

    const compressed = await Effect.runPromise(
      store.compressAndStore({
        threadId: "thread-alpha",
        toolName: "diagnostic_dump",
        rawText: secretPayload,
        mimeHint: "json",
      }),
    );
    expect(compressed.compressed).toBe(true);
    expect(compressed.scrubbedOriginal).not.toContain("superSecretPayloadToken12345");
    expect(compressed.scrubbedOriginal).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234");
    expect(scrubCcrPayload("API_KEY=my-secret-value-9999")).not.toContain("my-secret-value-9999");

    // Same thread retrieves exact jsonPath and grep losslessly (with secrets redacted).
    const byPath = await Effect.runPromise(
      store.retrieve({
        threadId: "thread-alpha",
        request: { outputHash: compressed.outputHash, jsonPath: "items[25]" },
      }),
    );
    expect(byPath.found).toBe(true);
    expect(byPath.content).toContain('"idx": 25');
    expect(byPath.content).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234");

    const byGrep = await Effect.runPromise(
      store.retrieve({
        threadId: "thread-alpha",
        request: { outputHash: compressed.outputHash, grep: "Leaked token" },
      }),
    );
    expect(byGrep.found).toBe(true);
    expect(byGrep.content).toContain("Leaked token");

    // Different thread MUST NOT read thread-alpha's CCR payload.
    const crossThread = await Effect.runPromise(
      store.retrieve({
        threadId: "thread-beta",
        request: { outputHash: compressed.outputHash },
      }),
    );
    expect(crossThread.found).toBe(false);
    expect(crossThread.content).toBe("");
  });

  it("aligns static prefix vs volatile runtime lines for KV-cache stability (CacheAligner)", () => {
    const turn1 = alignPromptForPrefixCache({
      staticSections: [
        "Core Policy: Never bypass auth.\ncurrentTimestamp: 2026-11-22T15:01:00Z\nAlways run unit tests.",
        "pid: 12345\nUse strict schemas.",
      ],
      volatileSections: ["Active turn: turn-1"],
    });
    const turn2 = alignPromptForPrefixCache({
      staticSections: [
        "Core Policy: Never bypass auth.\ncurrentTimestamp: 2026-11-22T15:09:42Z\nAlways run unit tests.",
        "pid: 98765\nUse strict schemas.",
      ],
      volatileSections: ["Active turn: turn-2"],
    });

    expect(turn1.relocatedVolatileLines).toBe(2);
    expect(turn1.stablePrefix).toBe(turn2.stablePrefix);
    expect(turn1.stablePrefix).not.toContain("2026-11-22");
    expect(turn1.volatileSuffix).toContain("currentTimestamp: 2026-11-22T15:01:00Z");
    expect(turn2.volatileSuffix).toContain("Active turn: turn-2");
  });

  it("persists gzipped CCR payloads in SQLite Migration 106 and recovers losslessly from a cold store", async () => {
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0106;

      const writerStore = makeCcrToolOutputStore(sql);
      const raw = JSON.stringify({
        items: Array.from({ length: 100 }, (_, idx) => ({
          idx,
          status: idx === 77 ? "error" : "ok",
          detail: idx === 77 ? "SQLITE_PERSISTED_MARKER_77" : `row-${idx}-payload-padding-xyz`,
        })),
      });

      const stored = yield* writerStore.compressAndStore({
        threadId: "thread-sqlite-1",
        toolName: "sqlite_test_tool",
        rawText: raw,
        mimeHint: "json",
      });
      expect(stored.compressed).toBe(true);

      // Fresh store instance has empty memory cache -> forces real SQLite + gunzip read.
      const coldReaderStore = makeCcrToolOutputStore(sql);
      const recovered = yield* coldReaderStore.retrieve({
        threadId: "thread-sqlite-1",
        request: { outputHash: stored.outputHash, jsonPath: "items[77]" },
      });
      expect(recovered.found).toBe(true);
      expect(recovered.toolName).toBe("sqlite_test_tool");
      expect(recovered.content).toContain("SQLITE_PERSISTED_MARKER_77");

      const wrongThread = yield* coldReaderStore.retrieve({
        threadId: "thread-sqlite-other",
        request: { outputHash: stored.outputHash },
      });
      expect(wrongThread.found).toBe(false);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));

    await Effect.runPromise(program);
  });

  it("applies Phase 3 t0 coding-tool rules: preserves explicit <=350-line reads, outlines >400-line reads, summarizes Exit 0 tests, clusters tsc errors, omits lockfile diffs, and checks break-even gate", () => {
    const shortLines = Array.from({ length: 120 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const explicitRead = compressCodingToolOutputAtT0({
      toolKind: "read",
      toolName: "read_file",
      rawText: shortLines,
      explicitLineRange: true,
    });
    expect(explicitRead.compressed).toBe(false);
    expect(explicitRead.summaryText).toBe(shortLines);

    const bigFileLines = [
      ...Array.from({ length: 60 }, (_, i) => `import mod${i} from "./m${i}";`),
      "export function targetHandler(id: string) {",
      ...Array.from({ length: 400 }, (_, i) => `  const step${i} = id + "${i}";`),
      "}",
      "export class CoreService {",
      "  run() { return true; }",
      "}",
    ].join("\n");
    const unboundedRead = compressCodingToolOutputAtT0({
      toolKind: "read",
      toolName: "read_file",
      filePath: "apps/server/src/big.ts",
      rawText: bigFileLines,
      explicitLineRange: false,
    });
    expect(unboundedRead.compressed).toBe(true);
    expect(unboundedRead.summaryText).toContain("[SYMBOL OUTLINE]");
    expect(unboundedRead.summaryText).toContain("L61: export function targetHandler");
    expect(unboundedRead.summaryText).toContain("export class CoreService");
    expect(unboundedRead.savedPercent).toBeGreaterThanOrEqual(60);

    const passTest = compressCodingToolOutputAtT0({
      toolKind: "test",
      toolName: "vitest",
      exitCode: 0,
      rawText:
        Array.from({ length: 100 }, (_, i) => ` ✓ test case ${i} passed (2ms)`).join("\n") +
        "\n Test Files  12 passed (12)\n      Tests  180 passed (180)\n   Duration  2.4s",
    });
    expect(passTest.compressed).toBe(true);
    expect(passTest.summaryText).toContain("[PASS]");
    expect(passTest.summaryText).toContain("180 passed");

    const tscRaw = Array.from(
      { length: 40 },
      (_, i) =>
        `apps/server/src/f${i}.ts(${i + 1},5): error TS2345: Argument of type 'string' is not assignable.`,
    ).join("\n");
    const tscOut = compressCodingToolOutputAtT0({
      toolKind: "typecheck",
      toolName: "tsgo",
      exitCode: 1,
      rawText: tscRaw,
    });
    expect(tscOut.compressed).toBe(true);
    expect(tscOut.summaryText).toContain("[TS2345 x40]");
    expect(tscOut.summaryText).toContain("+37 more TS2345");

    const diffRaw = [
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
      ...Array.from({ length: 120 }, (_, i) => `+  pkg-${i}: 1.0.${i}`),
      "diff --git a/apps/server/src/app.ts b/apps/server/src/app.ts",
      "+export const ok = true;",
    ].join("\n");
    const diffOut = compressCodingToolOutputAtT0({
      toolKind: "git-diff",
      toolName: "git",
      rawText: diffRaw,
    });
    expect(diffOut.compressed).toBe(true);
    expect(diffOut.summaryText).toContain("[omitted generated/lockfile diff: pnpm-lock.yaml");
    expect(diffOut.summaryText).toContain("+export const ok = true;");

    const receipt = formatCompactEditReceipt({
      path: "apps/server/src/app.ts",
      lineRange: "L10-24",
      lineDelta: -4,
      contentAfter: "export const ok = true;\n",
      syntaxStatus: "PASS",
    });
    expect(receipt).toMatch(
      /^\[EDIT OK\] apps\/server\/src\/app\.ts:L10-24 \(-4 lines\) \| sha256:[a-f0-9]{8} \| syntax:PASS$/,
    );

    // Idempotency guard: already-compressed output is not re-compressed.
    const idempotent = compressToolOutputForCcr({
      toolName: "vitest",
      rawText: passTest.summaryText,
    });
    expect(idempotent.compressed).toBe(false);

    // Break-even gate + Haiku cliff guard
    expect(
      evaluateBatchCompactionGate({
        model: "claude-opus-5-5",
        totalContextTokens: 45_000,
        removableObservationTokens: 20_000,
        protectedSuffixTokens: 16_000,
      }).shouldRollover,
    ).toBe(false);
    expect(
      evaluateBatchCompactionGate({
        model: "claude-opus-5-5",
        totalContextTokens: 60_000,
        removableObservationTokens: 32_000,
        protectedSuffixTokens: 16_000,
      }),
    ).toEqual({ shouldRollover: true, reason: "breakeven-batch" });
    expect(
      evaluateBatchCompactionGate({
        model: "claude-haiku-5-5",
        totalContextTokens: 66_000,
        removableObservationTokens: 10_000,
        protectedSuffixTokens: 16_000,
      }),
    ).toEqual({ shouldRollover: true, reason: "haiku-cliff-guard" });
  });
});
