import type { DriveBackupTarget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  formatBackupBytes,
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
});
