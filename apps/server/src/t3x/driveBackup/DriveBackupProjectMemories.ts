// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { coldMemoryArchivePath } from "../../orchestration/coldMemoryArchive.ts";
import { memoryScopeDirectory } from "../../orchestration/memoryFiles.ts";
import { evaluateBackupFilePath } from "./DriveBackupFilter.ts";

/**
 * 선택된 프로젝트/저장소와 연관된 기억을 T3 내부·외부 저장소 전반에서 읽기 전용으로 자동 수집한다.
 *
 * 지원 출처:
 * 1. T3 SQLite 다중 project_id 매칭 (동일 경로 · 다른 드라이브 동일 경로 · 아카이브된 과거 ID)
 * 2. T3 memory-v2 워크스페이스 기억 (MEMORY.md, procedural/LESSONS.md, 활성 topics/*.md, observations 등; .history 및 대형 sources 덤프 제외)
 * 3. T3 memory-v2 전역 공용 기억 (global/MEMORY.md, procedural/LESSONS.md, topics/*.md)
 * 4. T3 memory-cold-archive (<projectId>-<digest>.ndjson.gz)
 * 5. Claude Code AutoMemory (~/.claude/projects/<encoded>/memory/** 및 T3 다중 계정 provider-instances)
 * 6. Codex CLI 롤아웃 요약 기억 (~/.codex/memories_v2/rollout_summaries/*.md 및 다중 계정 provider-instances)
 * 7. Grok CLI 워크스페이스 기억 (~/.grok/memory-v2/workspaces/<slug>-<hex>/** 및 ~/.grok/memory/<slug>-<hex>/**)
 *
 * 보안 원칙:
 * - 모든 외부 저장소는 읽기 전용으로만 접근한다.
 * - 모든 수집 파일은 DriveBackupFilter.evaluateBackupFilePath 시크릿 차단 필터를 통과시킨다.
 * - 평문 지식 폴더(T3-Knowledge/_memories)에는 정제 마크다운 기억만 허용하고, 대화 원문/아카이브/DB는 암호화 아카이브(T3-Backup)에만 넣는다.
 */

export type RelatedMemorySourceKind =
  | "t3_memory_v2"
  | "t3_global_memory"
  | "t3_cold_archive"
  | "claude_memory"
  | "codex_memory"
  | "grok_memory";

export interface RelatedMemoryFileEntry {
  readonly sourceKind: RelatedMemorySourceKind;
  readonly sourceLabel: string;
  readonly absolutePath: string;
  /** T3-Backup 암호화 아카이브 내부 경로 */
  readonly archivePath: string;
  /** T3-Knowledge/<project>/_memories/... 상대 경로 (평문 업로드 허용 마크다운만 non-null) */
  readonly knowledgeRelativePath: string | null;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface ProjectCatalogRow {
  readonly project_id: string;
  readonly title: string;
  readonly workspace_root: string;
  readonly deleted_at?: string | null;
}

export interface ProjectIdentity {
  readonly normalizedPaths: ReadonlySet<string>;
  readonly driveAgnosticPaths: ReadonlySet<string>;
  readonly rawPaths: ReadonlyArray<string>;
  readonly basenameLower: string | null;
  readonly slugCandidates: ReadonlySet<string>;
  readonly exactClaudeEncodedDirs: ReadonlySet<string>;
  readonly driveAgnosticClaudeSuffixes: ReadonlySet<string>;
  readonly basenameClaudeEncoded: string | null;
}

export interface RelatedMemoryDiscoveryResult {
  readonly files: ReadonlyArray<RelatedMemoryFileEntry>;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly knowledgeEligibleFiles: number;
  readonly knowledgeEligibleBytes: number;
  readonly blockedSecretsCount: number;
  readonly blockedSecretsSample: ReadonlyArray<string>;
  readonly sourceLabels: ReadonlyArray<string>;
  readonly countsBySource: {
    readonly t3MemoryV2: number;
    readonly t3GlobalMemory: number;
    readonly t3ColdArchive: number;
    readonly claude: number;
    readonly codex: number;
    readonly grok: number;
  };
  readonly warnings: ReadonlyArray<string>;
}

const DEFAULT_MAX_RELATED_MEMORY_FILES = 5_000;
const DEFAULT_MAX_RELATED_MEMORY_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_MEMORY_FILE_BYTES = 10 * 1024 * 1024;

const TEMPORARY_PROJECT_PATH_PATTERN =
  /(?:^|\/)(?:appdata\/local\/temp|\/tmp|\.t3\/(?:orchestra-|production-assistant|assistant-production|desktop-ui-audit)|node_modules)(?:\/|$)/i;

export function normalizeProjectPathKey(inputPath: string): string {
  let cleaned = inputPath.trim();
  if (cleaned.startsWith("\\\\?\\") || cleaned.startsWith("//?/")) {
    cleaned = cleaned.slice(4);
  }
  cleaned = cleaned.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (cleaned.length > 1 && cleaned.endsWith("/")) {
    cleaned = cleaned.replace(/\/+$/, "");
  }
  return cleaned.toLowerCase();
}

export function stripWindowsDrivePrefix(normalizedPath: string): string | null {
  const m = /^[a-z]:(\/.*)$/.exec(normalizedPath);
  if (!m) return null;
  const rest = m[1]!;
  return rest.length > 1 ? rest : null;
}

export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .replace(/^_+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function encodeClaudeProjectDirName(absPath: string): string {
  let cleaned = absPath.trim();
  if (cleaned.startsWith("\\\\?\\") || cleaned.startsWith("//?/")) {
    cleaned = cleaned.slice(4);
  }
  cleaned = cleaned.replace(/[\\/]+$/, "");
  return cleaned.replace(/[^a-zA-Z0-9]/g, "-");
}

function sanitizeArchiveSegment(input: string): string {
  return (
    input
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "item"
  );
}

function isTemporaryWorkspacePath(workspaceRoot: string): boolean {
  const norm = normalizeProjectPathKey(workspaceRoot);
  return TEMPORARY_PROJECT_PATH_PATTERN.test(norm);
}

export function buildProjectIdentity(input: {
  readonly displayName: string;
  readonly rootPath: string;
  readonly extraPaths?: ReadonlyArray<string>;
}): ProjectIdentity {
  const normalizedPaths = new Set<string>();
  const driveAgnosticPaths = new Set<string>();
  const rawPaths: string[] = [];
  const exactClaudeEncodedDirs = new Set<string>();
  const driveAgnosticClaudeSuffixes = new Set<string>();

  const allPaths = [input.rootPath, ...(input.extraPaths ?? [])];
  for (const p of allPaths) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    rawPaths.push(trimmed);
    const norm = normalizeProjectPathKey(trimmed);
    if (!norm) continue;
    normalizedPaths.add(norm);
    const agnostic = stripWindowsDrivePrefix(norm);
    if (agnostic) driveAgnosticPaths.add(agnostic);

    const encoded = encodeClaudeProjectDirName(trimmed).toLowerCase();
    if (encoded) {
      exactClaudeEncodedDirs.add(encoded);
      const driveStrip = /^[a-z](-+.*)$/.exec(encoded);
      if (driveStrip && driveStrip[1] && driveStrip[1].replace(/-/g, "").length >= 3) {
        driveAgnosticClaudeSuffixes.add(driveStrip[1]);
      }
    }
  }

  const rootNorm = normalizeProjectPathKey(input.rootPath);
  const rootLeaf = rootNorm.split("/").filter(Boolean).at(-1) ?? "";
  const isDriveOnlyRoot = /^[a-z]:$/i.test(rootLeaf);
  const basenameLower = !isDriveOnlyRoot && rootLeaf.length > 0 ? rootLeaf : null;

  const slugCandidates = new Set<string>();
  if (basenameLower) {
    const s = normalizeSlug(basenameLower);
    if (s.length >= 3) slugCandidates.add(s);
  }
  const displaySlug = normalizeSlug(input.displayName);
  if (displaySlug.length >= 3 && /^[a-z0-9]+$/.test(displaySlug)) {
    slugCandidates.add(displaySlug);
  }

  const basenameClaudeEncoded =
    basenameLower && normalizeSlug(basenameLower).length >= 4
      ? basenameLower.replace(/[^a-z0-9]/g, "-")
      : null;

  return {
    normalizedPaths,
    driveAgnosticPaths,
    rawPaths,
    basenameLower,
    slugCandidates,
    exactClaudeEncodedDirs,
    driveAgnosticClaudeSuffixes,
    basenameClaudeEncoded,
  };
}

/**
 * 선택된 대상(project / core / repo / knowledge)에 대응하는 모든 T3 `projection_projects` 행을 찾는다.
 * - 명시적 projectId 일치
 * - 정규화 workspace_root 정확 일치 (삭제/아카이브된 과거 ID 복구 포함 — 예: core:t3-repo ↔ __NewAutoUsage)
 * - 다른 드라이브의 동일 경로 (예: E:\__OIBOT ↔ D:\__OIBOT)
 * - 임시 경로가 아닌 동일 프로젝트 폴더명(영숫자 4자 이상) 일치
 */
export function resolveMatchingProjects(
  target: {
    readonly projectId: string | null;
    readonly displayName: string;
    readonly rootPath: string;
  },
  catalog: ReadonlyArray<ProjectCatalogRow>,
): ReadonlyArray<ProjectCatalogRow> {
  const identity = buildProjectIdentity({
    displayName: target.displayName,
    rootPath: target.rootPath,
  });
  const targetLeafSlug = identity.basenameLower ? normalizeSlug(identity.basenameLower) : "";
  const matched: ProjectCatalogRow[] = [];
  const seen = new Set<string>();

  for (const row of catalog) {
    if (!row.project_id || seen.has(row.project_id)) continue;

    if (target.projectId && row.project_id === target.projectId) {
      seen.add(row.project_id);
      matched.push(row);
      continue;
    }

    const rowNorm = normalizeProjectPathKey(row.workspace_root || "");
    if (!rowNorm) continue;

    if (identity.normalizedPaths.has(rowNorm)) {
      seen.add(row.project_id);
      matched.push(row);
      continue;
    }

    const rowAgnostic = stripWindowsDrivePrefix(rowNorm);
    if (rowAgnostic && identity.driveAgnosticPaths.has(rowAgnostic)) {
      seen.add(row.project_id);
      matched.push(row);
      continue;
    }

    if (isTemporaryWorkspacePath(row.workspace_root || "")) {
      continue;
    }

    if (targetLeafSlug.length >= 4) {
      const rowLeaf = rowNorm.split("/").filter(Boolean).at(-1) ?? "";
      const rowSlug = normalizeSlug(rowLeaf);
      if (rowSlug.length >= 4 && rowSlug === targetLeafSlug) {
        seen.add(row.project_id);
        matched.push(row);
      }
    }
  }

  return matched;
}

export function matchesClaudeProjectDirName(dirName: string, identity: ProjectIdentity): boolean {
  const lower = dirName.trim().toLowerCase();
  if (!lower) return false;
  if (identity.exactClaudeEncodedDirs.has(lower)) return true;

  for (const suffix of identity.driveAgnosticClaudeSuffixes) {
    if (/^[a-z]/.test(lower) && lower.slice(1) === suffix) {
      return true;
    }
  }

  // 워크트리나 다른 상위 경로에 위치한 동일 프로젝트 (예: C--Users-...-worktrees-...-__OIBOT)
  if (identity.basenameClaudeEncoded) {
    const tailExact = `-${identity.basenameClaudeEncoded}`;
    if (lower.endsWith(tailExact)) {
      const beforeIdx = lower.length - tailExact.length;
      if (beforeIdx === 0 || lower[beforeIdx - 1] === "-") {
        return true;
      }
    }
    const cleanSlug = normalizeSlug(identity.basenameClaudeEncoded);
    if (cleanSlug.length >= 5) {
      const slugTail = `--${cleanSlug}`;
      if (lower.endsWith(slugTail)) {
        return true;
      }
    }
  }

  return false;
}

export function matchesGrokWorkspaceDirName(dirName: string, identity: ProjectIdentity): boolean {
  const lower = dirName.trim().toLowerCase();
  if (!lower) return false;
  // Grok 워크스페이스 디렉터리명 형식: <slug>-<8hex> (예: oibot-e0dbd4cc, job-104daf2d, newautousage-ai-upgrade-20261012-508f680c)
  const stripped = lower.replace(/-[0-9a-f]{8}$/, "");
  if (stripped === lower) return false;
  const strippedCompact = normalizeSlug(stripped);

  for (const slug of identity.slugCandidates) {
    if (stripped === slug || strippedCompact === slug) {
      return true;
    }
    if (slug.length >= 6 && stripped.startsWith(`${slug}-`)) {
      return true;
    }
  }
  return false;
}

export function matchesCodexRolloutContent(headText: string, identity: ProjectIdentity): boolean {
  // 1차: 헤더 `cwd: ...`가 명시되어 있으면 경로 일치 여부로 결정론적 판정 (오매칭 방지)
  const cwdMatch = /^cwd:\s*(.+)$/im.exec(headText);
  if (cwdMatch && cwdMatch[1]) {
    const cwdNorm = normalizeProjectPathKey(cwdMatch[1]);
    if (!cwdNorm) return false;
    for (const rootNorm of identity.normalizedPaths) {
      if (cwdNorm === rootNorm || cwdNorm.startsWith(`${rootNorm}/`)) {
        return true;
      }
    }
    const cwdAgnostic = stripWindowsDrivePrefix(cwdNorm);
    if (cwdAgnostic) {
      for (const rootAgnostic of identity.driveAgnosticPaths) {
        if (cwdAgnostic === rootAgnostic || cwdAgnostic.startsWith(`${rootAgnostic}/`)) {
          return true;
        }
      }
    }
    return false;
  }

  // 2차: cwd 헤더가 없는 구형 요약 파일만 본문 앞부분의 정규화 경로 직접 등장으로 판정
  const normalizedHead = headText.replace(/\\\\/g, "/").replace(/\\/g, "/").toLowerCase();
  for (const rootNorm of identity.normalizedPaths) {
    if (rootNorm.length >= 5 && normalizedHead.includes(rootNorm)) {
      return true;
    }
  }
  return false;
}

function resolveDefaultExternalHomeDir(): string {
  const envOverride = process.env.T3CODE_DRIVE_BACKUP_EXTERNAL_HOME?.trim();
  if (envOverride) return envOverride;
  return NodeOs.homedir();
}

function discoverProviderInstanceCliHomes(stateDir: string): {
  readonly claudeHomes: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  readonly codexHomes: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  readonly grokHomes: ReadonlyArray<{ readonly label: string; readonly path: string }>;
} {
  const claudeHomes: Array<{ readonly label: string; readonly path: string }> = [];
  const codexHomes: Array<{ readonly label: string; readonly path: string }> = [];
  const grokHomes: Array<{ readonly label: string; readonly path: string }> = [];

  if (!stateDir) return { claudeHomes, codexHomes, grokHomes };
  const instancesDir = NodePath.join(stateDir, "provider-instances");
  if (!NodeFs.existsSync(instancesDir)) return { claudeHomes, codexHomes, grokHomes };

  let entries: NodeFs.Dirent[];
  try {
    entries = NodeFs.readdirSync(instancesDir, { withFileTypes: true });
  } catch {
    return { claudeHomes, codexHomes, grokHomes };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const instDir = NodePath.join(instancesDir, entry.name);
    const label = sanitizeArchiveSegment(entry.name);

    for (const sub of ["claude-home", "claude-api-home", ".claude"]) {
      const candidate = NodePath.join(instDir, sub);
      if (NodeFs.existsSync(NodePath.join(candidate, "projects"))) {
        claudeHomes.push({ label, path: candidate });
      }
    }
    for (const sub of ["codex-home", ".codex"]) {
      const candidate = NodePath.join(instDir, sub);
      if (NodeFs.existsSync(NodePath.join(candidate, "memories_v2"))) {
        codexHomes.push({ label, path: candidate });
      }
    }
    for (const sub of ["grok-home", ".grok"]) {
      const candidate = NodePath.join(instDir, sub);
      if (
        NodeFs.existsSync(NodePath.join(candidate, "memory-v2")) ||
        NodeFs.existsSync(NodePath.join(candidate, "memory"))
      ) {
        grokHomes.push({ label, path: candidate });
      }
    }
  }

  return { claudeHomes, codexHomes, grokHomes };
}

function isT3MemoryV2KnowledgeSafe(relPosix: string): boolean {
  const norm = relPosix.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm === "MEMORY.md") return true;
  if (norm.startsWith("procedural/") && norm.endsWith(".md")) return true;
  if (norm.startsWith("topics/") && norm.endsWith(".md")) return true;
  if (norm === "user-utterances/USER_STYLE_PROFILE.md") return true;
  return false;
}

function isGrokKnowledgeSafe(relPosix: string): boolean {
  const norm = relPosix.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm === "MEMORY.md") return true;
  if (norm.startsWith("topics/") && norm.endsWith(".md")) return true;
  return false;
}

export function discoverRelatedProjectMemoryFiles(input: {
  readonly displayName: string;
  readonly rootPath: string;
  readonly matchedProjectIds: ReadonlyArray<string>;
  readonly extraProjectRoots?: ReadonlyArray<string>;
  readonly stateDir: string;
  /** 외부 AI CLI 홈 디렉터리 (테스트에서 격리된 임시 홈을 주입하거나 빈 문자열로 비활성화 가능) */
  readonly externalHomeDir?: string;
  readonly includeGlobalMemory?: boolean;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxSingleFileBytes?: number;
}): RelatedMemoryDiscoveryResult {
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_RELATED_MEMORY_FILES;
  const maxTotalBytes = input.maxTotalBytes ?? DEFAULT_MAX_RELATED_MEMORY_BYTES;
  const maxSingleFileBytes = input.maxSingleFileBytes ?? DEFAULT_MAX_SINGLE_MEMORY_FILE_BYTES;
  const includeGlobalMemory = input.includeGlobalMemory ?? true;
  const externalHomeDir =
    input.externalHomeDir !== undefined ? input.externalHomeDir : resolveDefaultExternalHomeDir();

  const identity = buildProjectIdentity({
    displayName: input.displayName,
    rootPath: input.rootPath,
    ...(input.extraProjectRoots ? { extraPaths: input.extraProjectRoots } : {}),
  });

  const files: RelatedMemoryFileEntry[] = [];
  const seenAbsolutePaths = new Set<string>();
  const seenArchivePaths = new Set<string>();
  const blockedSecretsSample: string[] = [];
  const warnings: string[] = [];
  const sourceLabelsSet = new Set<string>();

  let totalBytes = 0;
  let knowledgeEligibleFiles = 0;
  let knowledgeEligibleBytes = 0;
  let blockedSecretsCount = 0;
  let hitCap = false;

  const countsBySource = {
    t3MemoryV2: 0,
    t3GlobalMemory: 0,
    t3ColdArchive: 0,
    claude: 0,
    codex: 0,
    grok: 0,
  };

  const tryAddFile = (opts: {
    readonly sourceKind: RelatedMemorySourceKind;
    readonly sourceLabel: string;
    readonly absolutePath: string;
    readonly archivePath: string;
    readonly knowledgeRelativePath: string | null;
    readonly filterRelativePath: string;
  }) => {
    if (hitCap) return;
    const absNorm = normalizeProjectPathKey(opts.absolutePath);
    if (seenAbsolutePaths.has(absNorm) || seenArchivePaths.has(opts.archivePath)) return;

    let stat: NodeFs.Stats;
    try {
      stat = NodeFs.statSync(opts.absolutePath);
    } catch {
      return;
    }
    if (!stat.isFile()) return;

    const filterCheck = evaluateBackupFilePath({
      relativePosixPath: opts.filterRelativePath,
      sizeBytes: stat.size,
      maxSingleFileBytes,
    });
    if (!filterCheck.included) {
      if (filterCheck.reason === "secret_blocked") {
        blockedSecretsCount += 1;
        if (blockedSecretsSample.length < 10) {
          blockedSecretsSample.push(opts.archivePath);
        }
      }
      return;
    }

    if (files.length >= maxFiles) {
      hitCap = true;
      warnings.push(`연관 기억 파일 수 상한(${maxFiles.toLocaleString()}개)에 도달했습니다.`);
      return;
    }
    if (totalBytes + stat.size > maxTotalBytes) {
      hitCap = true;
      warnings.push(
        `연관 기억 용량 상한(${Math.round(maxTotalBytes / (1024 * 1024))}MB)에 도달했습니다.`,
      );
      return;
    }

    seenAbsolutePaths.add(absNorm);
    seenArchivePaths.add(opts.archivePath);
    files.push({
      sourceKind: opts.sourceKind,
      sourceLabel: opts.sourceLabel,
      absolutePath: opts.absolutePath,
      archivePath: opts.archivePath,
      knowledgeRelativePath: opts.knowledgeRelativePath,
      sizeBytes: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    });
    totalBytes += stat.size;
    if (opts.knowledgeRelativePath) {
      knowledgeEligibleFiles += 1;
      knowledgeEligibleBytes += stat.size;
    }
    sourceLabelsSet.add(opts.sourceLabel);

    switch (opts.sourceKind) {
      case "t3_memory_v2":
        countsBySource.t3MemoryV2 += 1;
        break;
      case "t3_global_memory":
        countsBySource.t3GlobalMemory += 1;
        break;
      case "t3_cold_archive":
        countsBySource.t3ColdArchive += 1;
        break;
      case "claude_memory":
        countsBySource.claude += 1;
        break;
      case "codex_memory":
        countsBySource.codex += 1;
        break;
      case "grok_memory":
        countsBySource.grok += 1;
        break;
    }
  };

  const walkMemoryDir = (opts: {
    readonly dirPath: string;
    readonly sourceKind: RelatedMemorySourceKind;
    readonly sourceLabel: string;
    readonly archivePrefix: string;
    readonly knowledgePrefix: string | null;
    readonly allowedExtensions: ReadonlySet<string> | null;
    readonly skipDirNames: ReadonlySet<string>;
    readonly isKnowledgeSafeFn: (relPosix: string) => boolean;
  }) => {
    if (hitCap || !NodeFs.existsSync(opts.dirPath)) return;
    const walk = (curDir: string, relPrefix: string) => {
      if (hitCap) return;
      let entries: NodeFs.Dirent[];
      try {
        entries = NodeFs.readdirSync(curDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hitCap) return;
        if (entry.isSymbolicLink()) continue;
        const lowerName = entry.name.toLowerCase();
        if (entry.isDirectory()) {
          if (opts.skipDirNames.has(lowerName)) continue;
          const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
          walk(NodePath.join(curDir, entry.name), nextRel);
          continue;
        }
        if (!entry.isFile()) continue;
        if (lowerName.startsWith(".tmp")) continue;
        if (/\.(?:sqlite|sqlite3|db|sqlite-wal|sqlite-shm|sqlite-journal)$/i.test(lowerName)) {
          continue;
        }
        const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        const secretPreCheck = evaluateBackupFilePath({ relativePosixPath: relPosix });
        if (!secretPreCheck.included && secretPreCheck.reason === "secret_blocked") {
          blockedSecretsCount += 1;
          if (blockedSecretsSample.length < 10) {
            blockedSecretsSample.push(`${opts.archivePrefix}/${relPosix}`);
          }
          continue;
        }
        if (opts.allowedExtensions) {
          const ext = NodePath.extname(lowerName);
          if (!opts.allowedExtensions.has(ext)) continue;
        }
        const abs = NodePath.join(curDir, entry.name);
        const knowledgeRelativePath =
          opts.knowledgePrefix && opts.isKnowledgeSafeFn(relPosix)
            ? `${opts.knowledgePrefix}/${relPosix}`
            : null;
        tryAddFile({
          sourceKind: opts.sourceKind,
          sourceLabel: opts.sourceLabel,
          absolutePath: abs,
          archivePath: `${opts.archivePrefix}/${relPosix}`,
          knowledgeRelativePath,
          filterRelativePath: relPosix,
        });
      }
    };
    walk(opts.dirPath, "");
  };

  // 1. T3 memory-v2 워크스페이스 기억 + 2. memory-cold-archive
  const uniqueProjectIds = [
    ...new Set(input.matchedProjectIds.filter((id) => id.trim().length > 0)),
  ];
  if (input.stateDir && uniqueProjectIds.length > 0) {
    for (const pid of uniqueProjectIds) {
      const pidSeg = sanitizeArchiveSegment(pid.slice(0, 16));
      const wsDir = memoryScopeDirectory(input.stateDir, pid, "project");
      walkMemoryDir({
        dirPath: wsDir,
        sourceKind: "t3_memory_v2",
        sourceLabel: "T3 memory-v2",
        archivePrefix: `t3-memories/workspace/${pidSeg}`,
        knowledgePrefix: `t3-memory-v2/${pidSeg}`,
        allowedExtensions: new Set([".md", ".txt", ".json"]),
        skipDirNames: new Set([".history", "sources", ".git"]),
        isKnowledgeSafeFn: isT3MemoryV2KnowledgeSafe,
      });

      const coldPath = coldMemoryArchivePath(input.stateDir, pid);
      if (NodeFs.existsSync(coldPath)) {
        const base = NodePath.basename(coldPath);
        tryAddFile({
          sourceKind: "t3_cold_archive",
          sourceLabel: "T3 콜드 아카이브",
          absolutePath: coldPath,
          archivePath: `t3-memories/cold-archive/${base}`,
          knowledgeRelativePath: null,
          filterRelativePath: base,
        });
      }
    }
  }

  // 3. 외부 AI CLI 기억 (기본 홈 + T3 다중 계정 provider-instances)
  const providerHomes = discoverProviderInstanceCliHomes(input.stateDir);

  // 3-A. Claude Code AutoMemory
  const claudeHomes: Array<{ readonly label: string; readonly path: string }> = [];
  if (externalHomeDir) {
    const defaultClaude = NodePath.join(externalHomeDir, ".claude");
    if (NodeFs.existsSync(NodePath.join(defaultClaude, "projects"))) {
      claudeHomes.push({ label: "default", path: defaultClaude });
    }
  }
  for (const h of providerHomes.claudeHomes) claudeHomes.push(h);

  const seenClaudeHomePaths = new Set<string>();
  for (const ch of claudeHomes) {
    const homeNorm = normalizeProjectPathKey(ch.path);
    if (seenClaudeHomePaths.has(homeNorm)) continue;
    seenClaudeHomePaths.add(homeNorm);

    const projectsDir = NodePath.join(ch.path, "projects");
    let projDirs: NodeFs.Dirent[];
    try {
      projDirs = NodeFs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pd of projDirs) {
      if (!pd.isDirectory() || pd.isSymbolicLink()) continue;
      if (!matchesClaudeProjectDirName(pd.name, identity)) continue;
      const memoryDir = NodePath.join(projectsDir, pd.name, "memory");
      if (!NodeFs.existsSync(memoryDir)) continue;
      const safeDir = sanitizeArchiveSegment(pd.name);
      walkMemoryDir({
        dirPath: memoryDir,
        sourceKind: "claude_memory",
        sourceLabel: "Claude",
        archivePrefix: `external-memories/claude/${ch.label}/${safeDir}`,
        knowledgePrefix: `claude/${ch.label}/${safeDir}`,
        allowedExtensions: new Set([".md", ".txt", ".json"]),
        skipDirNames: new Set([".history", ".git"]),
        isKnowledgeSafeFn: (rel) => rel.toLowerCase().endsWith(".md"),
      });
    }
  }

  // 3-B. Codex CLI 기억 (memories_v2/rollout_summaries/*.md)
  const codexHomes: Array<{ readonly label: string; readonly path: string }> = [];
  if (externalHomeDir) {
    const defaultCodex = NodePath.join(externalHomeDir, ".codex");
    if (NodeFs.existsSync(NodePath.join(defaultCodex, "memories_v2"))) {
      codexHomes.push({ label: "default", path: defaultCodex });
    }
  }
  for (const h of providerHomes.codexHomes) codexHomes.push(h);

  const seenCodexHomePaths = new Set<string>();
  for (const xh of codexHomes) {
    const homeNorm = normalizeProjectPathKey(xh.path);
    if (seenCodexHomePaths.has(homeNorm)) continue;
    seenCodexHomePaths.add(homeNorm);

    const rolloutDir = NodePath.join(xh.path, "memories_v2", "rollout_summaries");
    if (!NodeFs.existsSync(rolloutDir)) continue;
    let mdEntries: NodeFs.Dirent[];
    try {
      mdEntries = NodeFs.readdirSync(rolloutDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of mdEntries) {
      if (hitCap) break;
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      const abs = NodePath.join(rolloutDir, entry.name);
      let headText = "";
      try {
        const fd = NodeFs.openSync(abs, "r");
        try {
          const buf = Buffer.alloc(1536);
          const bytesRead = NodeFs.readSync(fd, buf, 0, buf.length, 0);
          headText = buf.subarray(0, bytesRead).toString("utf8");
        } finally {
          NodeFs.closeSync(fd);
        }
      } catch {
        continue;
      }
      if (!matchesCodexRolloutContent(headText, identity)) continue;
      tryAddFile({
        sourceKind: "codex_memory",
        sourceLabel: "Codex",
        absolutePath: abs,
        archivePath: `external-memories/codex/${xh.label}/rollout_summaries/${entry.name}`,
        knowledgeRelativePath: `codex/${xh.label}/rollout_summaries/${entry.name}`,
        filterRelativePath: entry.name,
      });
    }
  }

  // 3-C. Grok CLI 기억 (~/.grok/memory-v2/workspaces/<slug>-<hex> & ~/.grok/memory/<slug>-<hex>)
  const grokHomes: Array<{ readonly label: string; readonly path: string }> = [];
  if (externalHomeDir) {
    const defaultGrok = NodePath.join(externalHomeDir, ".grok");
    if (
      NodeFs.existsSync(NodePath.join(defaultGrok, "memory-v2")) ||
      NodeFs.existsSync(NodePath.join(defaultGrok, "memory"))
    ) {
      grokHomes.push({ label: "default", path: defaultGrok });
    }
  }
  for (const h of providerHomes.grokHomes) grokHomes.push(h);

  const seenGrokHomePaths = new Set<string>();
  for (const gh of grokHomes) {
    const homeNorm = normalizeProjectPathKey(gh.path);
    if (seenGrokHomePaths.has(homeNorm)) continue;
    seenGrokHomePaths.add(homeNorm);

    const grokStores = [
      { storeName: "memory-v2", dir: NodePath.join(gh.path, "memory-v2", "workspaces") },
      { storeName: "memory", dir: NodePath.join(gh.path, "memory") },
    ];
    for (const st of grokStores) {
      if (!NodeFs.existsSync(st.dir)) continue;
      let wsDirs: NodeFs.Dirent[];
      try {
        wsDirs = NodeFs.readdirSync(st.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const wd of wsDirs) {
        if (!wd.isDirectory() || wd.isSymbolicLink()) continue;
        if (!matchesGrokWorkspaceDirName(wd.name, identity)) continue;
        const safeWs = sanitizeArchiveSegment(wd.name);
        walkMemoryDir({
          dirPath: NodePath.join(st.dir, wd.name),
          sourceKind: "grok_memory",
          sourceLabel: "Grok",
          archivePrefix: `external-memories/grok/${gh.label}/${st.storeName}/${safeWs}`,
          knowledgePrefix: `grok/${gh.label}/${st.storeName}/${safeWs}`,
          allowedExtensions: new Set([".md", ".txt"]),
          skipDirNames: new Set([".history", ".git"]),
          isKnowledgeSafeFn: isGrokKnowledgeSafe,
        });
      }
    }
  }

  // 4. T3 전역 공용 기억 (프로젝트 기억이 1건 이상 있거나 등록 프로젝트에 매칭된 경우 함께 포함해 복원성 보장)
  const hasProjectSpecificLink = uniqueProjectIds.length > 0 || files.length > 0;
  if (includeGlobalMemory && input.stateDir && hasProjectSpecificLink) {
    const globalDir = memoryScopeDirectory(input.stateDir, "", "global");
    walkMemoryDir({
      dirPath: globalDir,
      sourceKind: "t3_global_memory",
      sourceLabel: "T3 공용 기억",
      archivePrefix: "t3-memories/global",
      knowledgePrefix: "t3-global-memory",
      allowedExtensions: new Set([".md", ".txt", ".json"]),
      skipDirNames: new Set([".history", "sources", ".git"]),
      isKnowledgeSafeFn: isT3MemoryV2KnowledgeSafe,
    });
  }

  return {
    files,
    totalFiles: files.length,
    totalBytes,
    knowledgeEligibleFiles,
    knowledgeEligibleBytes,
    blockedSecretsCount,
    blockedSecretsSample,
    sourceLabels: [...sourceLabelsSet],
    countsBySource,
    warnings,
  };
}
