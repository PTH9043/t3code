// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { compressRagText } from "../orchestration/ragContextCompression.ts";
import {
  getNativeMemoryCore,
  getNativeMemoryCoreStatus,
  resetNativeMemoryCoreForTests,
  runNativeSafe,
} from "./nativeMemoryCore.ts";
import { cosineSimilarity } from "./semanticSearch.ts";

describe("nativeMemoryCore (Rust napi-rs 브릿지 · Zero-Crash 폴백 · 정확도 동등성)", () => {
  const originalEnv = process.env.T3_NATIVE_MEMORY_CORE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.T3_NATIVE_MEMORY_CORE;
    } else {
      process.env.T3_NATIVE_MEMORY_CORE = originalEnv;
    }
    resetNativeMemoryCoreForTests();
  });

  it("T3_NATIVE_MEMORY_CORE=off 설정 시 즉시 무오류 JS 폴백 모드로 전환한다", () => {
    process.env.T3_NATIVE_MEMORY_CORE = "off";
    resetNativeMemoryCoreForTests();
    expect(getNativeMemoryCore()).toBeNull();
    const status = getNativeMemoryCoreStatus();
    expect(status.mode).toBe("off");
    expect(status.loaded).toBe(false);
    expect(status.fallbackReason).toContain("off");
  });

  it("Rust 네이티브 애드온이 존재하면 정상 로드되고 F32/Int8/mmap 2-Stage/Bump Arena가 JS와 동일한 정확도를 보장한다", async () => {
    delete process.env.T3_NATIVE_MEMORY_CORE;
    resetNativeMemoryCoreForTests();
    const addon = getNativeMemoryCore();
    if (!addon) {
      // On machines without Rust toolchain, fallback must still report cleanly.
      expect(getNativeMemoryCoreStatus().loaded).toBe(false);
      return;
    }

    const status = getNativeMemoryCoreStatus();
    expect(status.loaded).toBe(true);
    expect(status.capabilities).toBeTruthy();

    // 1. Normalized Cosine Top-K exact parity with JS `cosineSimilarity`
    const dim = 64;
    const count = 40;
    const matrix = new Float32Array(count * dim);
    const query = new Float32Array(dim);
    for (let d = 0; d < dim; d++) query[d] = Math.sin(d * 0.17);
    const jsScores: Array<{ index: number; score: number }> = [];
    for (let v = 0; v < count; v++) {
      const row: number[] = [];
      for (let d = 0; d < dim; d++) {
        const val = Math.cos((v * 13 + d * 5) * 0.09);
        matrix[v * dim + d] = val;
        row.push(val);
      }
      jsScores.push({ index: v, score: cosineSimilarity(row, Array.from(query)) });
    }
    jsScores.sort((a, b) => b.score - a.score);
    const rustHits = addon.normalizedCosineTopKF32(matrix, dim, query, 5);
    expect(rustHits.map((h) => h.index)).toEqual(jsScores.slice(0, 5).map((h) => h.index));
    expect(Math.abs(rustHits[0]!.score - jsScores[0]!.score)).toBeLessThan(1e-4);

    // 2. Bump Arena text compression matches `compressRagText`
    const rawDoc =
      "=====\n한국어 RAG 압축 테스트 문장입니다 여기\n한국어 RAG 압축 테스트 문장입니다 여기\n\n\n핵심 결론 요약";
    const arenaOut = addon.compressAndBigramBatchArena([rawDoc], 120, true);
    expect(arenaOut.compressedDocs[0]).toBe(compressRagText(rawDoc, { maxChars: 120 }));

    // 3. mmap `.t3vec` v5 write → open → 2-stage search → close (Windows-safe teardown)
    const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-pool-"));
    try {
      const poolPath = NodePath.join(tmpDir, "pool-test-gen1.t3vec");
      const keys = Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, "0"));
      const writtenBytes = addon.writeVectorPool(poolPath, dim, keys, matrix, 1, 123456);
      expect(writtenBytes).toBeGreaterThan(0);

      const loaded = addon.openVectorPool("scope_bridge_test", poolPath);
      expect(loaded.vectorCount).toBe(count);
      expect(loaded.dim).toBe(dim);

      const hits = addon.searchVectorPool("scope_bridge_test", query, 5, 32);
      expect(hits).not.toBeNull();
      expect(hits!.slice(0, 3).map((h) => h.contentKey)).toEqual(
        jsScores.slice(0, 3).map((s) => keys[s.index]!),
      );

      expect(addon.closeVectorPool("scope_bridge_test")).toBe(true);
    } finally {
      await NodeFSP.rm(tmpDir, { recursive: true, force: true });
    }

    // 4. Safe wrapper catches runtime errors without throwing
    const safeNull = runNativeSafe((a) => a.openVectorPool("bad", "Z:/nonexistent/file.t3vec"));
    expect(safeNull).toBeNull();
  });
});
