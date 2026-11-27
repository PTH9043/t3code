// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import { execFile } from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { promisify } from "node:util";
import * as NodeZlib from "node:zlib";
import {
  decryptBufferAes256Gcm,
  encryptBufferAes256Gcm,
  isEncryptedT3Bundle,
  sha256Hex,
} from "./DriveBackupCrypto.ts";
import { scanSelectedDirectory } from "./DriveBackupFilter.ts";

const execFileAsync = promisify(execFile);

/**
 * 자체 결정론적 압축 아카이브 패커 (`T3ARC1`, Node.js 내장 `zlib` 전용 — 외부 `tar`/`zstd` 불필요).
 *
 * 포맷 (gzip 압축 전):
 *   [0..5]   Magic "T3ARC1" (6 bytes)
 *   [6..9]   Manifest JSON byte length (UInt32BE)
 *   [10..10+len) Manifest JSON (UTF-8)
 *   [10+len..]   각 파일 바이트를 순서대로 이어붙인 바이너리 페이로드
 *
 * Windows 한글 경로·공백·긴 경로를 100% 무손실 왕복 복원하며,
 * 각 파일별 SHA-256과 전체 매니페스트 SHA-256을 복구 검증 시 대조한다.
 */

const ARC_MAGIC = Buffer.from("T3ARC1", "ascii");

export interface ArchiveEntryMeta {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ArchiveManifest {
  readonly format: "T3ARC1";
  readonly createdAtIso: string;
  readonly targetId: string;
  readonly targetDisplayName: string;
  readonly entries: ReadonlyArray<ArchiveEntryMeta>;
}

export interface PackedArchiveInputEntry {
  readonly archivePath: string;
  readonly content: Buffer;
}

export interface BuiltArchiveResult {
  readonly buffer: Buffer;
  readonly encrypted: boolean;
  readonly fileCount: number;
  readonly rawBytes: number;
  readonly archiveBytes: number;
  readonly manifestSha256: string;
  readonly blockedSecretsCount: number;
  readonly blockedSecretsSample: ReadonlyArray<string>;
}

export function packEntriesToArchive(input: {
  readonly targetId: string;
  readonly targetDisplayName: string;
  readonly entries: ReadonlyArray<PackedArchiveInputEntry>;
  readonly createdAtIso: string;
  readonly encryptionPassphrase?: string | null;
}): Omit<BuiltArchiveResult, "blockedSecretsCount" | "blockedSecretsSample"> {
  const metas: ArchiveEntryMeta[] = [];
  const payloads: Buffer[] = [];
  let rawBytes = 0;

  for (const entry of input.entries) {
    const hash = sha256Hex(entry.content);
    metas.push({
      path: entry.archivePath,
      byteLength: entry.content.byteLength,
      sha256: hash,
    });
    payloads.push(entry.content);
    rawBytes += entry.content.byteLength;
  }

  const manifest: ArchiveManifest = {
    format: "T3ARC1",
    createdAtIso: input.createdAtIso,
    targetId: input.targetId,
    targetDisplayName: input.targetDisplayName,
    entries: metas,
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest), "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(manifestBuf.byteLength, 0);

  const uncompressed = Buffer.concat([ARC_MAGIC, lenBuf, manifestBuf, ...payloads]);
  const gzipped = NodeZlib.gzipSync(uncompressed, { level: 6 });
  const manifestSha256 = sha256Hex(manifestBuf);

  const encrypted = Boolean(input.encryptionPassphrase);
  const finalBuf = input.encryptionPassphrase
    ? encryptBufferAes256Gcm(gzipped, input.encryptionPassphrase)
    : gzipped;

  return {
    buffer: finalBuf,
    encrypted,
    fileCount: metas.length,
    rawBytes,
    archiveBytes: finalBuf.byteLength,
    manifestSha256,
  };
}

export interface VerifiedArchiveResult {
  readonly verified: boolean;
  readonly encrypted: boolean;
  readonly manifest: ArchiveManifest;
  readonly manifestSha256: string;
  readonly entries: ReadonlyArray<{ readonly path: string; readonly content: Buffer }>;
}

export function verifyAndUnpackArchive(
  rawBuffer: Buffer,
  encryptionPassphrase?: string | null,
): VerifiedArchiveResult {
  const encrypted = isEncryptedT3Bundle(rawBuffer);
  let gzipped = rawBuffer;
  if (encrypted) {
    if (!encryptionPassphrase) {
      throw new Error("암호화된 백업 아카이브입니다. 복호화 비밀번호가 필요합니다.");
    }
    gzipped = decryptBufferAes256Gcm(rawBuffer, encryptionPassphrase);
  }

  const uncompressed = NodeZlib.gunzipSync(gzipped);
  if (uncompressed.byteLength < ARC_MAGIC.length + 4) {
    throw new Error("손상된 아카이브: 헤더 길이가 부족합니다.");
  }
  if (!uncompressed.subarray(0, ARC_MAGIC.length).equals(ARC_MAGIC)) {
    throw new Error("손상된 아카이브: T3ARC1 매직 헤더가 일치하지 않습니다.");
  }

  const manifestLen = uncompressed.readUInt32BE(ARC_MAGIC.length);
  const manifestStart = ARC_MAGIC.length + 4;
  const manifestEnd = manifestStart + manifestLen;
  if (manifestEnd > uncompressed.byteLength) {
    throw new Error("손상된 아카이브: 매니페스트 길이가 버퍼를 초과합니다.");
  }

  const manifestBuf = uncompressed.subarray(manifestStart, manifestEnd);
  const manifestSha256 = sha256Hex(manifestBuf);
  const manifest = JSON.parse(manifestBuf.toString("utf8")) as ArchiveManifest;

  const unpacked: Array<{ readonly path: string; readonly content: Buffer }> = [];
  let cursor = manifestEnd;
  for (const meta of manifest.entries) {
    const end = cursor + meta.byteLength;
    if (end > uncompressed.byteLength) {
      throw new Error(`손상된 아카이브: 엔트리 '${meta.path}' 바이트가 잘렸습니다.`);
    }
    const slice = Buffer.from(uncompressed.subarray(cursor, end));
    const actualHash = sha256Hex(slice);
    if (actualHash !== meta.sha256) {
      throw new Error(`무결성 오류: '${meta.path}' SHA-256 불일치`);
    }
    unpacked.push({ path: meta.path, content: slice });
    cursor = end;
  }

  return {
    verified: true,
    encrypted,
    manifest,
    manifestSha256,
    entries: unpacked,
  };
}

async function createGitBundleIfRepo(rootPath: string): Promise<Buffer | null> {
  if (!NodeFs.existsSync(NodePath.join(rootPath, ".git"))) return null;
  const tmpFile = NodePath.join(
    NodeOs.tmpdir(),
    `t3-git-bundle-${NodeCrypto.randomUUID().slice(0, 12)}.bundle`,
  );
  try {
    await execFileAsync("git", ["bundle", "create", tmpFile, "--all"], {
      cwd: rootPath,
      timeout: 60_000,
      windowsHide: true,
    });
    return NodeFs.readFileSync(tmpFile);
  } catch {
    return null;
  } finally {
    try {
      if (NodeFs.existsSync(tmpFile)) NodeFs.rmSync(tmpFile, { force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

export async function buildSelectedTargetArchive(input: {
  readonly targetId: string;
  readonly targetDisplayName: string;
  readonly rootPath: string;
  readonly syncFiles: boolean;
  readonly excludeGlobs?: ReadonlyArray<string>;
  readonly extraEntries?: ReadonlyArray<PackedArchiveInputEntry>;
  readonly createdAtIso: string;
  readonly encryptionPassphrase?: string | null;
}): Promise<BuiltArchiveResult> {
  const entries: PackedArchiveInputEntry[] = [];
  let blockedSecretsCount = 0;
  let blockedSecretsSample: ReadonlyArray<string> = [];

  if (input.syncFiles && NodeFs.existsSync(input.rootPath)) {
    const scanned = scanSelectedDirectory({
      rootPath: input.rootPath,
      ...(input.excludeGlobs ? { customExcludeGlobs: input.excludeGlobs } : {}),
    });
    blockedSecretsCount = scanned.blockedSecretsCount;
    blockedSecretsSample = scanned.blockedSecretsSample;

    for (const file of scanned.includedFiles) {
      try {
        const content = NodeFs.readFileSync(file.absolutePath);
        entries.push({
          archivePath: `workspace/${file.relativePath}`,
          content,
        });
      } catch {
        // skip unreadable transient files
      }
    }

    const gitBundle = await createGitBundleIfRepo(input.rootPath);
    if (gitBundle && gitBundle.byteLength > 0) {
      entries.push({
        archivePath: "git/repository.bundle",
        content: gitBundle,
      });
    }
  }

  if (input.extraEntries) {
    for (const extra of input.extraEntries) {
      entries.push(extra);
    }
  }

  const packed = packEntriesToArchive({
    targetId: input.targetId,
    targetDisplayName: input.targetDisplayName,
    entries,
    createdAtIso: input.createdAtIso,
    ...(input.encryptionPassphrase ? { encryptionPassphrase: input.encryptionPassphrase } : {}),
  });

  return {
    ...packed,
    blockedSecretsCount,
    blockedSecretsSample,
  };
}
