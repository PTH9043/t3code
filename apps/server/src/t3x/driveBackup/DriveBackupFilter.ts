// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

/**
 * 선택형 Google Drive 백업용 안전 필터 & 로컬 마운트 감지기.
 *
 * - 시크릿/개인키/지갑 시드(.env, *.pem, *.key, *secret*, *seed* 등)는 Fail-Closed로 기본 차단한다.
 * - 재생성 가능한 빌드·캐시·대형 가중치(node_modules, .t3, target, *.gguf 등)는 기본 제외해
 *   Google Drive 용량 및 레이트리밋을 보호한다.
 */

export const DEFAULT_EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".t3",
  "dist",
  "dist-electron",
  "build",
  "release",
  "release-mock",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".tanstack",
  ".cache",
  ".parcel-cache",
  "coverage",
  "desktop-profile",
  "caches",
]);

export const DEFAULT_EXCLUDED_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /\.sqlite-(?:wal|shm)$/i,
  /\.tsbuildinfo$/i,
  /\.log$/i,
  /\.(?:gguf|safetensors|ckpt|pt|pth|onnx|node|dll|exe|dylib|so|zip|7z|rar|iso|mp4|mov|mkv)$/i,
  /^codex-history-archive-/i,
];

export const SECRET_BLOCK_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|\/)\.env(?:\.[^/]+)?$/i,
  /(?:^|\/)(?:secrets?|credentials?|auth\.json|clerk-tokens\.json|id_rsa|id_ed25519)(?:\/|$|\.)/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /(?:seed[_-]?phrase|mnemonic|private[_-]?key|wallet\.dat)/i,
  /(?:^|\/)hatch_sess/i,
];

const RISK_FOLDER_PATTERN = /(?:wallet|airdrop|secret|key|credential|vault)/i;

export interface PathFilterEvaluation {
  readonly included: boolean;
  readonly reason:
    | "ok"
    | "secret_blocked"
    | "excluded_dir"
    | "excluded_file"
    | "custom_glob"
    | "size_cap";
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`(?:^|/)${escaped}(?:/|$)`, "i");
}

export function detectRiskWarningForFolder(displayName: string, rootPath: string): string | null {
  if (RISK_FOLDER_PATTERN.test(`${displayName} ${rootPath}`)) {
    return "지갑·키·인증 민감 파일 포함 가능성 — 기본 OFF 권장, 백업 시 암호화 필수";
  }
  return null;
}

export function evaluateBackupFilePath(input: {
  readonly relativePosixPath: string;
  readonly sizeBytes?: number;
  readonly maxSingleFileBytes?: number;
  readonly customExcludeGlobs?: ReadonlyArray<string>;
}): PathFilterEvaluation {
  const norm = input.relativePosixPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = norm.split("/");

  // .env.example은 허용
  const isEnvExample = /(?:^|\/)\.env\.example$/i.test(norm);
  if (!isEnvExample) {
    for (const pat of SECRET_BLOCK_PATTERNS) {
      if (pat.test(norm)) {
        return { included: false, reason: "secret_blocked" };
      }
    }
  }

  for (let i = 0; i < segments.length - 1; i += 1) {
    if (DEFAULT_EXCLUDED_DIR_NAMES.has(segments[i]!.toLowerCase())) {
      return { included: false, reason: "excluded_dir" };
    }
  }

  const baseName = segments[segments.length - 1] ?? "";
  for (const pat of DEFAULT_EXCLUDED_FILE_PATTERNS) {
    if (pat.test(baseName)) {
      return { included: false, reason: "excluded_file" };
    }
  }

  if (input.customExcludeGlobs && input.customExcludeGlobs.length > 0) {
    for (const g of input.customExcludeGlobs) {
      if (!g.trim()) continue;
      if (globToRegExp(g).test(norm)) {
        return { included: false, reason: "custom_glob" };
      }
    }
  }

  const maxFile = input.maxSingleFileBytes ?? 50 * 1024 * 1024;
  if (input.sizeBytes !== undefined && input.sizeBytes > maxFile) {
    return { included: false, reason: "size_cap" };
  }

  return { included: true, reason: "ok" };
}

export const USERDATA_BACKUP_CANDIDATES: ReadonlyArray<{
  readonly name: string;
  readonly displayName: string;
  readonly requiresSnapshot: boolean;
}> = [
  { name: "memory-v2", displayName: "T3 장기기억 (memory-v2)", requiresSnapshot: false },
  {
    name: "semantic-rag",
    displayName: "시맨틱 RAG 인덱스 (semantic-rag)",
    requiresSnapshot: false,
  },
  { name: "document-rag", displayName: "문서 RAG 인덱스 (document-rag)", requiresSnapshot: false },
  { name: "attachments", displayName: "대화 첨부파일 (attachments)", requiresSnapshot: false },
  { name: "archives", displayName: "이벤트 콜드 아카이브 (archives)", requiresSnapshot: false },
  {
    name: "memory-cold-archive",
    displayName: "장기기억 콜드 아카이브 (memory-cold-archive)",
    requiresSnapshot: false,
  },
  {
    name: "provider-history",
    displayName: "프로바이더 이력 (provider-history)",
    requiresSnapshot: false,
  },
  {
    name: "workspace-context",
    displayName: "워크스페이스 문맥 (workspace-context)",
    requiresSnapshot: false,
  },
  { name: "document-ocr", displayName: "문서 OCR 캐시 (document-ocr)", requiresSnapshot: false },
  {
    name: "watchdog-journal.sqlite",
    displayName: "워치독 저널 DB (watchdog-journal.sqlite · 스냅샷)",
    requiresSnapshot: true,
  },
];

export const UNIFIED_USERDATA_TARGET_ID = "userdata:all";
export const UNIFIED_USERDATA_DISPLAY_NAME = "T3 전체 데이터 (userdata · DB · 설정)";

export const USERDATA_HARD_EXCLUDED_NAMES = new Set([
  "secrets",
  "provider-auth",
  "clerk-tokens.json",
  "logs",
  "desktop-profile",
  "active-work.json",
  "server-runtime.json",
  "clerk-callback-relay.json",
  "jasna",
  "provider-instances",
  "backups",
  "drive-mirror",
  "drive-backup-staging",
  "drive-backup-snapshots",
  "drive-knowledge-mirror",
]);

export function isUserdataHardExcluded(relativePosixPath: string): boolean {
  const norm = relativePosixPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = norm.split("/");
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (USERDATA_HARD_EXCLUDED_NAMES.has(lower)) return true;
    if (lower.startsWith("server-runtime.json.")) return true;
    if (lower.endsWith(".sqlite-wal") || lower.endsWith(".sqlite-shm")) return true;
  }
  return false;
}

export interface DiscoveredUserdataCandidate {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly requiresSnapshot: boolean;
}

export function discoverUserdataCandidates(
  stateDir: string,
): ReadonlyArray<DiscoveredUserdataCandidate> {
  if (!stateDir || !NodeFs.existsSync(stateDir)) return [];
  const results: DiscoveredUserdataCandidate[] = [];
  for (const cand of USERDATA_BACKUP_CANDIDATES) {
    if (isUserdataHardExcluded(cand.name)) continue;
    const fullPath = NodePath.join(stateDir, cand.name);
    if (!NodeFs.existsSync(fullPath)) continue;
    results.push({
      id: `userdata:${cand.name}`,
      name: cand.name,
      displayName: cand.displayName,
      rootPath: fullPath,
      requiresSnapshot: cand.requiresSnapshot,
    });
  }
  return results;
}

export interface ScannedProjectFiles {
  readonly includedFiles: ReadonlyArray<{
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly sizeBytes: number;
    readonly mtimeMs: number;
  }>;
  readonly totalRawBytes: number;
  readonly blockedSecretsCount: number;
  readonly blockedSecretsSample: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export function scanSelectedDirectory(input: {
  readonly rootPath: string;
  readonly customExcludeGlobs?: ReadonlyArray<string>;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxSingleFileBytes?: number;
  readonly unlimited?: boolean;
  /** true이면 .sqlite/.sqlite3/.db 등 라이브 DB 파일을 일반 파일 스캔에서 제외 (워커 스냅샷으로 별도 백업 또는 지식 업로드 차단) */
  readonly excludeSqliteFiles?: boolean;
}): ScannedProjectFiles {
  const maxFiles = input.unlimited ? Number.POSITIVE_INFINITY : (input.maxFiles ?? 25_000);
  const maxTotalBytes = input.unlimited
    ? Number.POSITIVE_INFINITY
    : (input.maxTotalBytes ?? 512 * 1024 * 1024);
  const maxSingleFileBytes = input.unlimited
    ? Number.POSITIVE_INFINITY
    : (input.maxSingleFileBytes ?? 50 * 1024 * 1024);
  const includedFiles: Array<{
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly sizeBytes: number;
    readonly mtimeMs: number;
  }> = [];
  const blockedSecretsSample: string[] = [];
  const warnings: string[] = [];
  let blockedSecretsCount = 0;
  let totalRawBytes = 0;
  let hitFileCap = false;
  let hitByteCap = false;

  if (!NodeFs.existsSync(input.rootPath)) {
    return {
      includedFiles: [],
      totalRawBytes: 0,
      blockedSecretsCount: 0,
      blockedSecretsSample: [],
      warnings: [`폴더를 찾을 수 없습니다: ${input.rootPath}`],
    };
  }

  // 단일 파일 대상(예: watchdog-journal.sqlite)도 안전 지원
  try {
    const rootStat = NodeFs.statSync(input.rootPath);
    if (rootStat.isFile()) {
      const base = NodePath.basename(input.rootPath);
      if (isUserdataHardExcluded(base)) {
        return {
          includedFiles: [],
          totalRawBytes: 0,
          blockedSecretsCount: 1,
          blockedSecretsSample: [base],
          warnings: [],
        };
      }
      return {
        includedFiles: [
          {
            absolutePath: input.rootPath,
            relativePath: base,
            sizeBytes: rootStat.size,
            mtimeMs: Math.floor(rootStat.mtimeMs),
          },
        ],
        totalRawBytes: rootStat.size,
        blockedSecretsCount: 0,
        blockedSecretsSample: [],
        warnings: [],
      };
    }
  } catch {
    return {
      includedFiles: [],
      totalRawBytes: 0,
      blockedSecretsCount: 0,
      blockedSecretsSample: [],
      warnings: [`경로 상태를 읽을 수 없습니다: ${input.rootPath}`],
    };
  }

  const walk = (dir: string, relPrefix: string) => {
    if (hitFileCap || hitByteCap) return;
    let entries: NodeFs.Dirent[];
    try {
      entries = NodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hitFileCap || hitByteCap) return;
      if (entry.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = NodePath.join(dir, entry.name);

      if (isUserdataHardExcluded(rel)) {
        if (/(?:secrets?|provider-auth|clerk-tokens\.json)/i.test(rel)) {
          blockedSecretsCount += 1;
          if (blockedSecretsSample.length < 10) blockedSecretsSample.push(rel);
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIR_NAMES.has(entry.name.toLowerCase())) continue;
        if (/(?:^|\/)(?:secrets?|credentials?)$/i.test(rel)) {
          blockedSecretsCount += 1;
          if (blockedSecretsSample.length < 10) blockedSecretsSample.push(`${rel}/`);
          continue;
        }
        walk(abs, rel);
        continue;
      }

      if (!entry.isFile()) continue;
      if (
        input.excludeSqliteFiles &&
        /\.(?:sqlite|sqlite3|db|sqlite-wal|sqlite-shm|sqlite-journal)$/i.test(entry.name)
      ) {
        continue;
      }
      let stat: NodeFs.Stats;
      try {
        stat = NodeFs.statSync(abs);
      } catch {
        continue;
      }
      const check = evaluateBackupFilePath({
        relativePosixPath: rel,
        sizeBytes: stat.size,
        maxSingleFileBytes,
        ...(input.customExcludeGlobs ? { customExcludeGlobs: input.customExcludeGlobs } : {}),
      });
      if (!check.included) {
        if (check.reason === "secret_blocked") {
          blockedSecretsCount += 1;
          if (blockedSecretsSample.length < 10) blockedSecretsSample.push(rel);
        }
        continue;
      }

      if (includedFiles.length >= maxFiles) {
        hitFileCap = true;
        warnings.push(`단일 프로젝트 파일 수 상한(${maxFiles.toLocaleString()}개)에 도달했습니다.`);
        return;
      }
      if (totalRawBytes + stat.size > maxTotalBytes) {
        hitByteCap = true;
        warnings.push(
          `단일 프로젝트 원문 상한(${Math.round(maxTotalBytes / (1024 * 1024))}MB)에 도달했습니다.`,
        );
        return;
      }

      includedFiles.push({
        absolutePath: abs,
        relativePath: rel,
        sizeBytes: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
      });
      totalRawBytes += stat.size;
    }
  };

  walk(input.rootPath, "");
  return {
    includedFiles,
    totalRawBytes,
    blockedSecretsCount,
    blockedSecretsSample,
    warnings,
  };
}

/** Windows / macOS 로컬 Google Drive 마운트 경로 자동 감지 */
export function detectLocalGoogleDriveRoots(): ReadonlyArray<string> {
  const found: string[] = [];
  if (process.platform === "win32") {
    for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ") {
      for (const sub of ["내 드라이브", "My Drive"]) {
        const candidate = `${letter}:\\${sub}`;
        try {
          if (NodeFs.existsSync(candidate) && NodeFs.statSync(candidate).isDirectory()) {
            found.push(candidate);
          }
        } catch {
          // ignore inaccessible drives
        }
      }
    }
  }
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) {
    for (const sub of ["Google Drive", "Google 드라이브", "My Drive"]) {
      const candidate = NodePath.join(home, sub);
      try {
        if (NodeFs.existsSync(candidate) && NodeFs.statSync(candidate).isDirectory()) {
          found.push(candidate);
        }
      } catch {
        // ignore
      }
    }
  }
  return [...new Set(found)];
}
