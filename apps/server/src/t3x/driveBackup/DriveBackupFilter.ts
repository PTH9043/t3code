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

export interface ScannedProjectFiles {
  readonly includedFiles: ReadonlyArray<{
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly sizeBytes: number;
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
}): ScannedProjectFiles {
  const maxFiles = input.maxFiles ?? 25_000;
  const maxTotalBytes = input.maxTotalBytes ?? 512 * 1024 * 1024;
  const includedFiles: Array<{
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly sizeBytes: number;
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
      let stat: NodeFs.Stats;
      try {
        stat = NodeFs.statSync(abs);
      } catch {
        continue;
      }
      const check = evaluateBackupFilePath({
        relativePosixPath: rel,
        sizeBytes: stat.size,
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

      includedFiles.push({ absolutePath: abs, relativePath: rel, sizeBytes: stat.size });
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
