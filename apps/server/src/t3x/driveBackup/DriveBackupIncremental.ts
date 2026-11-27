// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import { sha256Hex } from "./DriveBackupCrypto.ts";

/**
 * 증분 백업 매니페스트 엔진:
 * - 파일별 (sizeBytes, mtimeMs, sha256)를 기록해 바뀐 파일만 추출·업로드한다.
 * - 1차로 (sizeBytes, mtimeMs)가 모두 같으면 디스크 재해싱을 생략해 12만+ 파일(memory-v2)을 빠르게 판별한다.
 * - 크기·mtime이 달라진 파일만 스트리밍 SHA-256으로 검증해 실제 내용 변경 여부를 확정한다.
 */

export interface IncrementalFileRecord {
  readonly path: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

export interface IncrementalTargetManifest {
  readonly schemaVersion: 1;
  readonly targetId: string;
  readonly updatedAtIso: string;
  readonly files: Readonly<Record<string, IncrementalFileRecord>>;
}

export interface IncrementalCandidateFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface IncrementalDiffResult {
  readonly changedFiles: ReadonlyArray<IncrementalCandidateFile & { readonly sha256: string }>;
  readonly unchangedCount: number;
  readonly deletedPaths: ReadonlyArray<string>;
  readonly nextManifest: IncrementalTargetManifest;
  readonly nextManifestJson: string;
  readonly nextManifestSha256: string;
}

export async function sha256FileStreaming(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  const rs = NodeFs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
  try {
    for await (const chunk of rs) {
      if (signal?.aborted) {
        rs.destroy();
        throw new Error(`해시 계산 일시정지됨: ${String(signal.reason ?? "aborted")}`);
      }
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return hash.digest("hex");
  } finally {
    rs.destroy();
  }
}

export function parseIncrementalManifest(
  rawJson: string | null | undefined,
): IncrementalTargetManifest | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as Partial<IncrementalTargetManifest>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.targetId === "string" &&
      parsed.files &&
      typeof parsed.files === "object"
    ) {
      return parsed as IncrementalTargetManifest;
    }
    return null;
  } catch {
    return null;
  }
}

export async function computeIncrementalDiff(input: {
  readonly targetId: string;
  readonly files: ReadonlyArray<IncrementalCandidateFile>;
  readonly previousManifest: IncrementalTargetManifest | null;
  readonly nowIso?: string;
  readonly signal?: AbortSignal;
}): Promise<IncrementalDiffResult> {
  const prevFiles = input.previousManifest?.files ?? {};
  const nextFiles: Record<string, IncrementalFileRecord> = {};
  const changedFiles: Array<IncrementalCandidateFile & { readonly sha256: string }> = [];
  let unchangedCount = 0;

  for (const file of input.files) {
    if (input.signal?.aborted) {
      throw new Error(`증분 비교 일시정지됨: ${String(input.signal.reason ?? "aborted")}`);
    }
    const prev = prevFiles[file.relativePath];
    const mtimeInt = Math.floor(file.mtimeMs);
    if (prev && prev.sizeBytes === file.sizeBytes && Math.floor(prev.mtimeMs) === mtimeInt) {
      nextFiles[file.relativePath] = prev;
      unchangedCount += 1;
      continue;
    }

    const digest = await sha256FileStreaming(file.absolutePath, input.signal);
    const record: IncrementalFileRecord = {
      path: file.relativePath,
      sizeBytes: file.sizeBytes,
      mtimeMs: mtimeInt,
      sha256: digest,
    };
    nextFiles[file.relativePath] = record;

    if (prev && prev.sha256 === digest && prev.sizeBytes === file.sizeBytes) {
      unchangedCount += 1;
    } else {
      changedFiles.push({ ...file, sha256: digest });
    }
  }

  const deletedPaths: string[] = [];
  for (const oldPath of Object.keys(prevFiles)) {
    if (!(oldPath in nextFiles)) {
      deletedPaths.push(oldPath);
    }
  }

  const nextManifest: IncrementalTargetManifest = {
    schemaVersion: 1,
    targetId: input.targetId,
    updatedAtIso: input.nowIso ?? new Date().toISOString(),
    files: nextFiles,
  };
  const nextManifestJson = JSON.stringify(nextManifest);
  const nextManifestSha256 = sha256Hex(nextManifestJson);

  return {
    changedFiles,
    unchangedCount,
    deletedPaths,
    nextManifest,
    nextManifestJson,
    nextManifestSha256,
  };
}
