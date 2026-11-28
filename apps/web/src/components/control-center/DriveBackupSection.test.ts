import type { DriveBackupTarget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  computeBackupPercent,
  formatBackupBytes,
  formatDurationKr,
  formatRelatedMemorySummary,
  formatTransferSpeed,
  liveProgressStageLabelKr,
  runKindLabelKr,
  runStatusBadgeVariant,
  runStatusLabelKr,
  summarizeSelectedTargets,
} from "./DriveBackupSection";

describe("DriveBackupSection helpers", () => {
  it("formats byte sizes cleanly across units", () => {
    expect(formatBackupBytes(0)).toBe("0 B");
    expect(formatBackupBytes(512)).toBe("512 B");
    expect(formatBackupBytes(1536)).toBe("1.5 KB");
    expect(formatBackupBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBackupBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("summarizes selected, risky, and git targets accurately", () => {
    const base: Omit<
      DriveBackupTarget,
      "id" | "displayName" | "enabled" | "isGitRepo" | "riskWarning"
    > = {
      kind: "project",
      projectId: null,
      rootPath: "D:/repo",
      existsOnDisk: true,
      syncFiles: true,
      syncT3Scope: true,
      syncDriveToLocalRag: false,
      syncLocalToDriveKnowledge: false,
      excludeGlobs: [],
      threadCount: 0,
      memoryCount: 0,
      lastBackedUpAtMs: null,
      updatedAtMs: 0,
    };
    const targets: DriveBackupTarget[] = [
      { ...base, id: "1", displayName: "AppA", enabled: true, isGitRepo: true, riskWarning: null },
      {
        ...base,
        id: "2",
        displayName: "__Wallet",
        enabled: true,
        isGitRepo: false,
        riskWarning: "지갑 민감",
      },
      { ...base, id: "3", displayName: "AppB", enabled: false, isGitRepo: true, riskWarning: null },
    ];
    expect(summarizeSelectedTargets(targets)).toEqual({
      selectedCount: 2,
      totalCount: 3,
      riskySelectedCount: 1,
      gitRepoCount: 2,
    });
  });

  it("maps run kinds and statuses to Korean labels and badge variants", () => {
    expect(runKindLabelKr("backup")).toBe("선택 백업");
    expect(runKindLabelKr("restore_verify")).toBe("복구 검증");
    expect(runKindLabelKr("knowledge_mirror")).toBe("지식 미러");

    expect(runStatusLabelKr("succeeded")).toBe("성공");
    expect(runStatusLabelKr("skipped_busy")).toBe("유휴 양보");
    expect(runStatusLabelKr("failed")).toBe("실패");
    expect(runStatusBadgeVariant("succeeded")).toBe("success");
    expect(runStatusBadgeVariant("skipped_busy")).toBe("warning");
    expect(runStatusBadgeVariant("failed")).toBe("error");
  });

  it("formats live backup progress stages, percentages, transfer speed, and ETA", () => {
    expect(liveProgressStageLabelKr("uploading")).toBe("Google Drive 업로드 중");
    expect(liveProgressStageLabelKr("paused_checkpoint")).toBe("이어올리기 체크포인트 대기 중");
    expect(computeBackupPercent(1_108_684_872, 2_217_369_743)).toBe(50);
    expect(computeBackupPercent(0, 0)).toBeNull();
    expect(formatDurationKr(45)).toBe("약 45초");
    expect(formatDurationKr(185)).toBe("약 3분 5초");
    expect(formatDurationKr(3660)).toBe("약 1시간 1분");
    expect(formatDurationKr(null)).toBe("계산 중");
    expect(formatTransferSpeed(2_500_000)).toContain("Mbps");
    expect(formatTransferSpeed(null)).toBe("-");
  });

  it("formats cross-storage related memory summary with source labels", () => {
    expect(
      formatRelatedMemorySummary({
        threadCount: 0,
        memoryCount: 0,
        knowledgeItemCount: 0,
        externalMemoryFilesCount: 0,
        relatedMemorySources: [],
      }),
    ).toBeNull();

    expect(
      formatRelatedMemorySummary({
        threadCount: 12,
        memoryCount: 11418,
        knowledgeItemCount: 1967,
        externalMemoryFilesCount: 118,
        relatedMemorySources: ["T3 DB", "T3 memory-v2", "Claude", "Codex", "Grok"],
      }),
    ).toBe(
      "대화 12건 · 장기기억 11,418건 · 위키·지식 1,967건 · 기억 파일 118개 (T3 DB · T3 memory-v2 · Claude · Codex · Grok)",
    );
  });
});
