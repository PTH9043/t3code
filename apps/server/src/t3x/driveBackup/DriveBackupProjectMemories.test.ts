// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { coldMemoryArchivePath } from "../../orchestration/coldMemoryArchive.ts";
import { memoryScopeDirectory } from "../../orchestration/memoryFiles.ts";
import {
  buildProjectIdentity,
  discoverRelatedProjectMemoryFiles,
  encodeClaudeProjectDirName,
  matchesClaudeProjectDirName,
  matchesCodexRolloutContent,
  matchesGrokWorkspaceDirName,
  normalizeProjectPathKey,
  resolveMatchingProjects,
} from "./DriveBackupProjectMemories.ts";

describe("DriveBackupProjectMemories", () => {
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

  it("normalizes Windows extended paths and encodes Claude project directories accurately", () => {
    expect(normalizeProjectPathKey("\\\\?\\D:\\__OIBOT\\")).toBe("d:/__oibot");
    expect(encodeClaudeProjectDirName("D:\\__OIBOT")).toBe("D----OIBOT");
    expect(encodeClaudeProjectDirName("D:\\___AIModel")).toBe("D-----AIModel");
    expect(encodeClaudeProjectDirName("D:\\__NewAutoUsage")).toBe("D----NewAutoUsage");
  });

  it("matches projects across drives, archived project IDs, and excludes temporary verification paths", () => {
    const catalog = [
      {
        project_id: "proj-oibot-active",
        title: "__OIBOT",
        workspace_root: "D:\\__OIBOT",
        deleted_at: null,
      },
      {
        project_id: "proj-oibot-old-e",
        title: "__OIBOT (E)",
        workspace_root: "E:\\__OIBOT",
        deleted_at: "2026-10-01T00:00:00Z",
      },
      {
        project_id: "proj-newautousage-archived",
        title: "__NewAutoUsage",
        workspace_root: "D:\\__NewAutoUsage",
        deleted_at: "2026-11-23T02:30:48Z",
      },
      {
        project_id: "proj-temp-verify",
        title: "임시 검증",
        workspace_root: "C:\\Users\\test\\AppData\\Local\\Temp\\t3-verify\\__OIBOT",
        deleted_at: "2026-11-06T00:00:00Z",
      },
      {
        project_id: "proj-other",
        title: "__Wallet",
        workspace_root: "D:\\__Wallet",
        deleted_at: null,
      },
    ];

    // D:\__OIBOT 선택 시 활성 ID + E:\__OIBOT 과거 ID까지 연결되고 임시/타 프로젝트는 제외
    const oibotMatched = resolveMatchingProjects(
      { projectId: "proj-oibot-active", displayName: "__OIBOT", rootPath: "D:\\__OIBOT" },
      catalog,
    );
    expect(oibotMatched.map((m) => m.project_id)).toEqual([
      "proj-oibot-active",
      "proj-oibot-old-e",
    ]);

    // core:t3-repo처럼 projectId가 null인 대상도 workspace_root 일치로 과거 project_id 연결
    const coreMatched = resolveMatchingProjects(
      { projectId: null, displayName: "T3 본체 저장소", rootPath: "D:\\__NewAutoUsage" },
      catalog,
    );
    expect(coreMatched.map((m) => m.project_id)).toEqual(["proj-newautousage-archived"]);
  });

  it("matches Claude, Codex, and Grok project memory directories without cross-project leakage", () => {
    const oibotId = buildProjectIdentity({ displayName: "__OIBOT", rootPath: "D:\\__OIBOT" });

    expect(matchesClaudeProjectDirName("D----OIBOT", oibotId)).toBe(true);
    expect(matchesClaudeProjectDirName("E----OIBOT", oibotId)).toBe(true);
    expect(matchesClaudeProjectDirName("C--Users-me-worktrees-wt1---OIBOT", oibotId)).toBe(true);
    expect(matchesClaudeProjectDirName("D----Wallet", oibotId)).toBe(false);

    expect(matchesGrokWorkspaceDirName("oibot-e0dbd4cc", oibotId)).toBe(true);
    expect(matchesGrokWorkspaceDirName("job-104daf2d", oibotId)).toBe(false);

    expect(
      matchesCodexRolloutContent(
        "thread_id: 1\ncwd: \\\\?\\D:\\__OIBOT\\research-kit\n\nSummary...",
        oibotId,
      ),
    ).toBe(true);
    expect(
      matchesCodexRolloutContent("thread_id: 2\ncwd: \\\\?\\D:\\__job\n\nMentions OIBOT", oibotId),
    ).toBe(false);
  });

  it("discovers T3 memory-v2, global, cold-archive, Claude (default+multi-account), Codex, and Grok memories while skipping .history/sources/secrets", () => {
    const stateDir = mkTempDir("t3-mem-state-");
    const fakeHome = mkTempDir("t3-mem-home-");
    const projectId = "proj-oibot-1234";

    // 1) T3 memory-v2 workspace (정상 파일 + .history/sources 제외 검증 + 시크릿 차단 검증)
    const wsDir = memoryScopeDirectory(stateDir, projectId, "project");
    NodeFs.mkdirSync(NodePath.join(wsDir, "procedural"), { recursive: true });
    NodeFs.mkdirSync(NodePath.join(wsDir, "topics", ".history"), { recursive: true });
    NodeFs.mkdirSync(NodePath.join(wsDir, "sources"), { recursive: true });
    NodeFs.mkdirSync(NodePath.join(wsDir, "user-utterances"), { recursive: true });
    NodeFs.writeFileSync(NodePath.join(wsDir, "MEMORY.md"), "# OIBOT Memory\n");
    NodeFs.writeFileSync(NodePath.join(wsDir, "procedural", "LESSONS.md"), "# Lessons\n");
    NodeFs.writeFileSync(NodePath.join(wsDir, "topics", "topic-0000.md"), "# Active topic\n");
    NodeFs.writeFileSync(
      NodePath.join(wsDir, "topics", ".history", "old-topic.md"),
      "MUST_SKIP_HISTORY",
    );
    NodeFs.writeFileSync(
      NodePath.join(wsDir, "sources", "huge.ndjson.gz"),
      "MUST_SKIP_RAW_SOURCE_DUMP",
    );
    NodeFs.writeFileSync(
      NodePath.join(wsDir, "user-utterances", "utterances-0000.md"),
      "Private raw utterance (archive only)",
    );

    // 2) T3 global memory
    const globalDir = memoryScopeDirectory(stateDir, "", "global");
    NodeFs.mkdirSync(globalDir, { recursive: true });
    NodeFs.writeFileSync(NodePath.join(globalDir, "MEMORY.md"), "# Global rule\n");

    // 3) T3 cold archive
    const coldFile = coldMemoryArchivePath(stateDir, projectId);
    NodeFs.mkdirSync(NodePath.dirname(coldFile), { recursive: true });
    NodeFs.writeFileSync(coldFile, "cold-gz-placeholder");

    // 4) Claude default + multi-account provider-instances + unrelated project + secret
    const claudeDefaultOibot = NodePath.join(
      fakeHome,
      ".claude",
      "projects",
      "D----OIBOT",
      "memory",
    );
    const claudeDefaultWallet = NodePath.join(
      fakeHome,
      ".claude",
      "projects",
      "D----Wallet",
      "memory",
    );
    const claudeInstOibot = NodePath.join(
      stateDir,
      "provider-instances",
      "claude_alt1",
      "claude-home",
      "projects",
      "E----OIBOT",
      "memory",
    );
    NodeFs.mkdirSync(claudeDefaultOibot, { recursive: true });
    NodeFs.mkdirSync(claudeDefaultWallet, { recursive: true });
    NodeFs.mkdirSync(claudeInstOibot, { recursive: true });
    NodeFs.writeFileSync(NodePath.join(claudeDefaultOibot, "MEMORY.md"), "# Claude OIBOT\n");
    NodeFs.writeFileSync(NodePath.join(claudeDefaultOibot, ".env"), "SECRET=NEVER_INCLUDE\n");
    NodeFs.writeFileSync(
      NodePath.join(claudeDefaultWallet, "MEMORY.md"),
      "MUST_NOT_LEAK_WALLET_MEMORY",
    );
    NodeFs.writeFileSync(NodePath.join(claudeInstOibot, "alt-note.md"), "# Multi-account note\n");

    // 5) Codex rollout_summaries (matching + non-matching)
    const codexRollouts = NodePath.join(fakeHome, ".codex", "memories_v2", "rollout_summaries");
    NodeFs.mkdirSync(codexRollouts, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(codexRollouts, "2026-11-24-oibot-audit.md"),
      "thread_id: a\ncwd: \\\\?\\D:\\__OIBOT\n\nOIBOT audit summary\n",
    );
    NodeFs.writeFileSync(
      NodePath.join(codexRollouts, "2026-11-24-job-summary.md"),
      "thread_id: b\ncwd: \\\\?\\D:\\__job\n\nJob summary\n",
    );

    // 6) Grok memory-v2 (matching + sqlite excluded + non-matching)
    const grokOibot = NodePath.join(fakeHome, ".grok", "memory-v2", "workspaces", "oibot-e0dbd4cc");
    const grokJob = NodePath.join(fakeHome, ".grok", "memory-v2", "workspaces", "job-104daf2d");
    NodeFs.mkdirSync(NodePath.join(grokOibot, "topics"), { recursive: true });
    NodeFs.mkdirSync(grokJob, { recursive: true });
    NodeFs.writeFileSync(NodePath.join(grokOibot, "MEMORY.md"), "# Grok OIBOT\n");
    NodeFs.writeFileSync(NodePath.join(grokOibot, "topics", "strategy.md"), "# Strategy\n");
    NodeFs.writeFileSync(NodePath.join(grokOibot, "index.sqlite"), "SQLITE_SKIP");
    NodeFs.writeFileSync(NodePath.join(grokJob, "MEMORY.md"), "MUST_NOT_LEAK_JOB");

    const res = discoverRelatedProjectMemoryFiles({
      displayName: "__OIBOT",
      rootPath: "D:\\__OIBOT",
      matchedProjectIds: [projectId],
      stateDir,
      externalHomeDir: fakeHome,
    });

    const archivePaths = res.files.map((f) => f.archivePath);
    expect(res.countsBySource).toEqual({
      t3MemoryV2: 4, // MEMORY.md, procedural/LESSONS.md, topics/topic-0000.md, user-utterances/utterances-0000.md
      t3GlobalMemory: 1,
      t3ColdArchive: 1,
      claude: 2, // default + claude_alt1 (E----OIBOT)
      codex: 1,
      grok: 2, // MEMORY.md + topics/strategy.md
    });
    expect(res.totalFiles).toBe(11);
    expect(res.blockedSecretsCount).toBe(1); // .env in Claude memory dir blocked!

    // 제외 검증
    expect(archivePaths.some((p) => p.includes(".history"))).toBe(false);
    expect(archivePaths.some((p) => p.includes("sources"))).toBe(false);
    expect(archivePaths.some((p) => p.includes("Wallet"))).toBe(false);
    expect(archivePaths.some((p) => p.includes("job-summary"))).toBe(false);
    expect(archivePaths.some((p) => p.includes("job-104daf2d"))).toBe(false);
    expect(archivePaths.some((p) => p.endsWith(".sqlite"))).toBe(false);

    // 평문 T3-Knowledge 허용 목록 검증: utterances 및 cold-archive는 제외, 정제 MD만 포함
    const knowledgePaths = res.files
      .map((f) => f.knowledgeRelativePath)
      .filter((p): p is string => p !== null);
    expect(knowledgePaths.some((p) => p.includes("utterances-0000.md"))).toBe(false);
    expect(knowledgePaths.some((p) => p.includes("cold-archive"))).toBe(false);
    expect(knowledgePaths.some((p) => p.endsWith("MEMORY.md"))).toBe(true);
    expect(knowledgePaths.some((p) => p.includes("claude/default/D----OIBOT/MEMORY.md"))).toBe(
      true,
    );
    expect(
      knowledgePaths.some((p) => p.includes("claude/claude_alt1/E----OIBOT/alt-note.md")),
    ).toBe(true);
    expect(knowledgePaths.some((p) => p.includes("codex/default/rollout_summaries/"))).toBe(true);
    expect(knowledgePaths.some((p) => p.includes("grok/default/memory-v2/oibot-e0dbd4cc/"))).toBe(
      true,
    );

    expect(res.sourceLabels).toEqual(
      expect.arrayContaining([
        "T3 memory-v2",
        "T3 콜드 아카이브",
        "Claude",
        "Codex",
        "Grok",
        "T3 공용 기억",
      ]),
    );
  });
});
