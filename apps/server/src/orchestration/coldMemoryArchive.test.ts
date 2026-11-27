// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  coldMemoryArchivePath,
  readColdMemoryGzipArchive,
  writeColdMemoryGzipArchive,
} from "./coldMemoryArchive.ts";
import {
  compactConversationHistoryWithMasking,
  resolveAdaptiveMemoryBudget,
} from "./workspacePromptTokens.ts";

describe("Adaptive prompt memory budget & observation masking", () => {
  it("scales prompt budgets across short (6.6KB), standard (15KB), and deep (30KB) queries", () => {
    const shortBudget = resolveAdaptiveMemoryBudget("고마워 진행해줘");
    expect(shortBudget).toEqual({
      tier: "short",
      maxRecentHistoryChars: 4_200,
      maxMemoryEvidenceChars: 2_400,
      maxMemoryItems: 2,
      compactToolOutputsOlderThanTurns: 1,
    });

    const standardBudget = resolveAdaptiveMemoryBudget("apps/server/src/http.ts 오류 확인해줘");
    expect(standardBudget).toEqual({
      tier: "standard",
      maxRecentHistoryChars: 9_000,
      maxMemoryEvidenceChars: 6_000,
      maxMemoryItems: 4,
      compactToolOutputsOlderThanTurns: 2,
    });

    const deepBudget = resolveAdaptiveMemoryBudget("전체 아키텍처 리팩토링 설계 비교 보고서 작성");
    expect(deepBudget).toEqual({
      tier: "deep",
      maxRecentHistoryChars: 16_000,
      maxMemoryEvidenceChars: 14_000,
      maxMemoryItems: 6,
      compactToolOutputsOlderThanTurns: 3,
    });
  });

  it("compacts old tool outputs with sha256 handle and summary while keeping recent tool outputs verbatim", () => {
    const bigSuccessLog = Array.from(
      { length: 30 },
      (_, i) => `build step ${i}: ok line output`,
    ).join("\n");
    const bigErrorLog = [
      ...Array.from({ length: 20 }, (_, i) => `info line ${i} padding text padding text`),
      "Error: ENOENT missing config.json",
    ].join("\n");
    const turns = [
      { id: "t1", role: "tool" as const, toolName: "shell", content: bigSuccessLog, createdAt: 1 },
      { id: "t2", role: "tool" as const, toolName: "shell", content: bigErrorLog, createdAt: 2 },
      { id: "t3", role: "tool" as const, toolName: "read", content: bigSuccessLog, createdAt: 3 },
    ];
    const compacted = compactConversationHistoryWithMasking(turns, 1);
    expect(compacted[0]?.content).toContain("[Tool Output Compacted: sha256:");
    expect(compacted[0]?.content).toContain("Summary:");
    expect(compacted[0]?.content).toContain("build step 0: ok line output");
    expect(compacted[1]?.content).toContain("[Tool Output Compacted: sha256:");
    expect(compacted[1]?.content).toContain("Error: ENOENT missing config.json");
    expect(compacted[2]?.content).toBe(bigSuccessLog);
  });
});

describe("Cold memory gzipped NDJSON archive", () => {
  it("compresses inactive cold memories into .ndjson.gz and restores them losslessly", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cold-archive-"));
    try {
      const archivePath = coldMemoryArchivePath(dir, "proj/alpha");
      const records = Array.from({ length: 10 }, (_, idx) => ({
        id: `cold-${idx}`,
        projectId: "proj/alpha",
        scope: "project",
        topic: "architecture",
        text: `Repeated historical architecture decision record #${idx}: `.repeat(20),
        sourceJson: `{"kind":"note","id":"n-${idx}"}`,
        origin: "user",
        verification: "user-statement",
        createdAt: "2026-09-01T00:00:00Z",
        validFrom: 1_700_000_000_000,
        validTo: 1_700_100_000_000,
        lastAccessedAt: null,
        accessCount: 0,
      }));

      const written = await writeColdMemoryGzipArchive(archivePath, records);
      expect(written.archivedCount).toBe(10);
      expect(written.gzipBytes).toBeLessThan(written.rawBytes / 5);

      const restored = await readColdMemoryGzipArchive(archivePath);
      expect(restored).toEqual(records);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
