// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import {
  createT3Enc2DecryptTransform,
  createT3Enc2EncryptTransform,
  detectFileEncryptionFormat,
  sha256Hex,
} from "./DriveBackupCrypto.ts";
import { verifyAndUnpackArchive, type ArchiveManifest } from "./ProjectArchivePacker.ts";
import type { TokenBucket } from "./TokenBucket.ts";

/**
 * 스트리밍 아카이브 포맷 (`T3ARC2`):
 * - 엔트리별 헤더를 앞에, 전체 매니페스트를 끝에 두는 단일 패스 O(1) 메모리 형식.
 * - 64비트 크기 헤더(BigUInt64BE)를 사용해 2GiB / 4GiB 초과 파일도 무제한 스트리밍 처리한다.
 * - 복원·검증 시 기존 `T3ARC1` / `T3ENC1` 파일도 자동 판별해 하위 호환 복원한다.
 *
 * 바이너리 구조 (gzip 내부 평문 스트림):
 *   [0..5]   Magic "T3ARC2" (6 bytes)
 *   [6..7]   Flags UInt16BE (0)
 *   엔트리 레코드 (0..N회):
 *     [0]      0x01 (RECORD_ENTRY)
 *     [1..4]   pathLen UInt32BE
 *     [5..5+p) path UTF-8 (POSIX 상대 경로)
 *     [+0..+7] rawSize BigUInt64BE
 *     [+8..+15] mtimeMs BigUInt64BE
 *     프레임 반복:
 *       frameLen UInt32BE (>0이면 frameBytes 뒤따름, 0이면 데이터 종료)
 *     entrySha256 (32 bytes raw digest)
 *   말미 매니페스트 레코드:
 *     [0]      0x02 (RECORD_MANIFEST)
 *     [1..4]   manifestJsonLen UInt32BE
 *     [...]    manifestJson UTF-8
 *     [...]    manifestSha256 (32 bytes raw digest)
 *     [...]    "T3END2" (6 bytes)
 */

const ARC2_MAGIC = Buffer.from("T3ARC2", "ascii");
const ARC2_END_MAGIC = Buffer.from("T3END2", "ascii");
const RECORD_ENTRY = 0x01;
const RECORD_MANIFEST = 0x02;
const FRAME_CHUNK_SIZE = 256 * 1024; // 256 KiB 고정 버퍼

export interface StreamingArchiveInputEntry {
  readonly archivePath: string;
  /** 디스크 파일 경로 또는 소형 메모리 버퍼 중 정확히 하나 */
  readonly filePath?: string;
  readonly buffer?: Buffer;
  readonly mtimeMs?: number;
}

export interface T3Arc2EntryMeta {
  readonly path: string;
  readonly byteLength: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

export interface T3Arc2Manifest {
  readonly format: "T3ARC2";
  readonly createdAtIso: string;
  readonly targetId: string;
  readonly targetDisplayName: string;
  readonly entries: ReadonlyArray<T3Arc2EntryMeta>;
}

export interface BuiltStreamingArchiveResult {
  readonly outputPath: string;
  readonly format: "T3ARC2";
  readonly encrypted: boolean;
  readonly fileCount: number;
  readonly rawBytes: number;
  readonly archiveBytes: number;
  readonly manifestSha256: string;
}

function normalizeArchiveEntryPath(raw: string): string {
  const cleaned = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/");
  if (!cleaned) {
    throw new Error(`유효하지 않은 아카이브 엔트리 경로: ${raw}`);
  }
  return cleaned;
}

async function writeChunkSafe(stream: PassThrough, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("아카이브 쓰기 스트림이 조기 종료되었습니다."));
      };
      const cleanup = () => {
        stream.off("drain", onDrain);
        stream.off("error", onError);
        stream.off("close", onClose);
      };
      stream.once("drain", onDrain);
      stream.once("error", onError);
      stream.once("close", onClose);
    });
  }
}

export async function packFilesToT3Arc2File(input: {
  readonly targetId: string;
  readonly targetDisplayName: string;
  readonly entries: ReadonlyArray<StreamingArchiveInputEntry>;
  readonly outputPath: string;
  readonly createdAtIso: string;
  readonly encryptionPassphrase?: string | null;
  readonly gzipLevel?: number;
  readonly readBucket?: TokenBucket;
  readonly signal?: AbortSignal;
  readonly onEntryPacked?: (info: {
    readonly index: number;
    readonly path: string;
    readonly bytes: number;
  }) => void;
}): Promise<BuiltStreamingArchiveResult> {
  NodeFs.mkdirSync(NodePath.dirname(input.outputPath), { recursive: true });
  const tmpOutput = `${input.outputPath}.${NodeCrypto.randomUUID().slice(0, 8)}.tmp`;

  const rawPass = new PassThrough({ highWaterMark: FRAME_CHUNK_SIZE });
  const gzip = NodeZlib.createGzip({
    level: input.gzipLevel ?? 3,
    chunkSize: FRAME_CHUNK_SIZE,
  });
  const fileOut = NodeFs.createWriteStream(tmpOutput, { highWaterMark: FRAME_CHUNK_SIZE });
  const encrypted = Boolean(input.encryptionPassphrase);

  const pipelinePromise = encrypted
    ? pipeline(
        rawPass,
        gzip,
        createT3Enc2EncryptTransform(input.encryptionPassphrase!),
        fileOut,
        ...(input.signal ? [{ signal: input.signal }] : []),
      )
    : pipeline(rawPass, gzip, fileOut, ...(input.signal ? [{ signal: input.signal }] : []));

  const metas: T3Arc2EntryMeta[] = [];
  let totalRawBytes = 0;

  try {
    // 헤더: "T3ARC2" + flags(2B)
    const header = Buffer.alloc(ARC2_MAGIC.length + 2);
    ARC2_MAGIC.copy(header, 0);
    header.writeUInt16BE(0, ARC2_MAGIC.length);
    await writeChunkSafe(rawPass, header);

    for (let idx = 0; idx < input.entries.length; idx += 1) {
      if (input.signal?.aborted) {
        throw new Error(`아카이브 패킹 일시정지됨: ${String(input.signal.reason ?? "aborted")}`);
      }
      const entry = input.entries[idx]!;
      const normPath = normalizeArchiveEntryPath(entry.archivePath);
      const pathBuf = Buffer.from(normPath, "utf8");

      let expectedSize = 0;
      let mtimeMs = entry.mtimeMs ?? Date.now();
      if (entry.filePath) {
        const st = await NodeFs.promises.stat(entry.filePath);
        expectedSize = st.size;
        mtimeMs = Math.floor(st.mtimeMs);
      } else if (entry.buffer) {
        expectedSize = entry.buffer.byteLength;
      } else {
        throw new Error(`엔트리 '${normPath}'에 filePath 또는 buffer가 없습니다.`);
      }

      // 엔트리 선행 헤더: type(1) + pathLen(4) + path + rawSize(8) + mtimeMs(8)
      const entryHead = Buffer.alloc(1 + 4 + pathBuf.byteLength + 8 + 8);
      entryHead[0] = RECORD_ENTRY;
      entryHead.writeUInt32BE(pathBuf.byteLength, 1);
      pathBuf.copy(entryHead, 5);
      entryHead.writeBigUInt64BE(BigInt(expectedSize), 5 + pathBuf.byteLength);
      entryHead.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(mtimeMs))), 13 + pathBuf.byteLength);
      await writeChunkSafe(rawPass, entryHead);

      const hasher = NodeCrypto.createHash("sha256");
      let actualWritten = 0;

      if (entry.filePath) {
        const rs = NodeFs.createReadStream(entry.filePath, { highWaterMark: FRAME_CHUNK_SIZE });
        try {
          for await (const rawChunk of rs) {
            if (input.signal?.aborted) {
              rs.destroy();
              throw new Error(
                `아카이브 패킹 일시정지됨: ${String(input.signal.reason ?? "aborted")}`,
              );
            }
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
            if (chunk.byteLength === 0) continue;
            if (input.readBucket) {
              await input.readBucket.consume(chunk.byteLength, input.signal);
            }
            hasher.update(chunk);
            actualWritten += chunk.byteLength;

            // 프레임 헤더(4B) + 청크 바이트
            const frameLenBuf = Buffer.alloc(4);
            frameLenBuf.writeUInt32BE(chunk.byteLength, 0);
            await writeChunkSafe(rawPass, frameLenBuf);
            await writeChunkSafe(rawPass, chunk);
          }
        } finally {
          rs.destroy();
        }
      } else if (entry.buffer && entry.buffer.byteLength > 0) {
        for (let offset = 0; offset < entry.buffer.byteLength; offset += FRAME_CHUNK_SIZE) {
          if (input.signal?.aborted) {
            throw new Error(
              `아카이브 패킹 일시정지됨: ${String(input.signal.reason ?? "aborted")}`,
            );
          }
          const slice = entry.buffer.subarray(
            offset,
            Math.min(offset + FRAME_CHUNK_SIZE, entry.buffer.byteLength),
          );
          hasher.update(slice);
          actualWritten += slice.byteLength;
          const frameLenBuf = Buffer.alloc(4);
          frameLenBuf.writeUInt32BE(slice.byteLength, 0);
          await writeChunkSafe(rawPass, frameLenBuf);
          await writeChunkSafe(rawPass, slice);
        }
      }

      // 0 길이 프레임 마커 + 32B SHA-256
      const entryTail = Buffer.alloc(4 + 32);
      entryTail.writeUInt32BE(0, 0);
      const digest = hasher.digest();
      digest.copy(entryTail, 4);
      await writeChunkSafe(rawPass, entryTail);

      metas.push({
        path: normPath,
        byteLength: actualWritten,
        mtimeMs,
        sha256: digest.toString("hex"),
      });
      totalRawBytes += actualWritten;
      input.onEntryPacked?.({ index: idx, path: normPath, bytes: actualWritten });
    }

    // 말미 매니페스트 레코드
    const manifest: T3Arc2Manifest = {
      format: "T3ARC2",
      createdAtIso: input.createdAtIso,
      targetId: input.targetId,
      targetDisplayName: input.targetDisplayName,
      entries: metas,
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestDigest = NodeCrypto.createHash("sha256").update(manifestBuf).digest();

    const manifestHead = Buffer.alloc(5);
    manifestHead[0] = RECORD_MANIFEST;
    manifestHead.writeUInt32BE(manifestBuf.byteLength, 1);
    await writeChunkSafe(rawPass, manifestHead);
    await writeChunkSafe(rawPass, manifestBuf);
    await writeChunkSafe(rawPass, Buffer.concat([manifestDigest, ARC2_END_MAGIC]));

    rawPass.end();
    await pipelinePromise;

    if (NodeFs.existsSync(input.outputPath)) {
      NodeFs.rmSync(input.outputPath, { force: true });
    }
    NodeFs.renameSync(tmpOutput, input.outputPath);
    const archiveBytes = NodeFs.statSync(input.outputPath).size;

    return {
      outputPath: input.outputPath,
      format: "T3ARC2",
      encrypted,
      fileCount: metas.length,
      rawBytes: totalRawBytes,
      archiveBytes,
      manifestSha256: manifestDigest.toString("hex"),
    };
  } catch (err) {
    rawPass.destroy();
    await pipelinePromise.catch(() => undefined);
    try {
      if (NodeFs.existsSync(tmpOutput)) NodeFs.rmSync(tmpOutput, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 스트리밍 검증 & 복원 (`T3ARC2`/`T3ENC2` + `T3ARC1`/`T3ENC1` 완전 통합 지원)
// ---------------------------------------------------------------------------

class AsyncByteReader {
  private readonly iter: AsyncIterator<Buffer>;
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private eof = false;

  constructor(stream: Readable) {
    this.iter = stream[Symbol.asyncIterator]();
  }

  private async fill(minBytes: number): Promise<boolean> {
    while (this.bufferedBytes < minBytes && !this.eof) {
      const next = await this.iter.next();
      if (next.done) {
        this.eof = true;
        break;
      }
      const buf = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (buf.byteLength > 0) {
        this.chunks.push(buf);
        this.bufferedBytes += buf.byteLength;
      }
    }
    return this.bufferedBytes >= minBytes;
  }

  async readExact(length: number): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    const ok = await this.fill(length);
    if (!ok) {
      throw new Error(`손상된 T3ARC2 스트림: 예상(${length}B)보다 일찍 EOF에 도달했습니다.`);
    }
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const head = this.chunks[0]!;
      const take = Math.min(head.byteLength, length - written);
      head.copy(out, written, 0, take);
      written += take;
      this.bufferedBytes -= take;
      if (take === head.byteLength) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(take);
      }
    }
    return out;
  }

  async readUInt8(): Promise<number> {
    return (await this.readExact(1))[0]!;
  }

  async readUInt32BE(): Promise<number> {
    return (await this.readExact(4)).readUInt32BE(0);
  }

  async readBigUInt64BE(): Promise<bigint> {
    return (await this.readExact(8)).readBigUInt64BE(0);
  }

  async assertEof(): Promise<void> {
    await this.fill(1);
    if (this.bufferedBytes > 0) {
      throw new Error("손상된 T3ARC2 스트림: 트레일러 뒤에 예상치 못한 바이트가 남아 있습니다.");
    }
  }
}

export interface VerifiedStreamingArchiveResult {
  readonly verified: boolean;
  readonly format: "T3ARC1" | "T3ARC2";
  readonly encrypted: boolean;
  readonly encryptionFormat: "T3ENC1" | "T3ENC2" | "none";
  readonly manifest: ArchiveManifest | T3Arc2Manifest;
  readonly manifestSha256: string;
  readonly verifiedFilesCount: number;
  readonly totalRawBytes: number;
  readonly extractedFiles: ReadonlyArray<string>;
}

function resolveSafeExtractPath(extractRoot: string, archiveEntryPath: string): string {
  const norm = normalizeArchiveEntryPath(archiveEntryPath);
  const resolvedRoot = NodePath.resolve(extractRoot);
  const target = NodePath.resolve(resolvedRoot, norm.split("/").join(NodePath.sep));
  if (
    target !== resolvedRoot &&
    !target.startsWith(
      resolvedRoot.endsWith(NodePath.sep) ? resolvedRoot : `${resolvedRoot}${NodePath.sep}`,
    )
  ) {
    throw new Error(`경로 탈출 차단: ${archiveEntryPath}`);
  }
  return target;
}

async function detectInnerArchiveFormat(
  filePath: string,
  encryptionFormat: "T3ENC1" | "T3ENC2" | "none",
): Promise<"T3ARC2" | "T3ARC1"> {
  if (encryptionFormat === "T3ENC1") return "T3ARC1";
  if (encryptionFormat === "T3ENC2") return "T3ARC2";
  // 비암호화 gzip 파일의 첫 6바이트를 스트리밍으로 살짝 확인
  const rs = NodeFs.createReadStream(filePath, { highWaterMark: 16 * 1024 });
  const gunzip = NodeZlib.createGunzip();
  rs.pipe(gunzip);
  try {
    const reader = new AsyncByteReader(gunzip);
    const magic = await reader.readExact(6);
    if (magic.equals(ARC2_MAGIC)) return "T3ARC2";
    return "T3ARC1";
  } finally {
    rs.destroy();
    gunzip.destroy();
  }
}

export async function verifyAndExtractArchiveFile(input: {
  readonly archivePath: string;
  readonly passphrase?: string | null;
  readonly extractToDir?: string;
  readonly signal?: AbortSignal;
}): Promise<VerifiedStreamingArchiveResult> {
  const encryptionFormat = detectFileEncryptionFormat(input.archivePath);
  const encrypted = encryptionFormat !== "none";
  if (encrypted && !input.passphrase) {
    throw new Error("암호화된 백업 아카이브입니다. 복호화 비밀번호가 필요합니다.");
  }

  const archiveFormat = await detectInnerArchiveFormat(input.archivePath, encryptionFormat);

  // 레거시 T3ARC1 / T3ENC1 완전 하위 호환 경로
  if (archiveFormat === "T3ARC1") {
    const rawBuf = await NodeFs.promises.readFile(input.archivePath);
    const unpacked = verifyAndUnpackArchive(rawBuf, input.passphrase);
    const extractedFiles: string[] = [];
    if (input.extractToDir) {
      NodeFs.mkdirSync(input.extractToDir, { recursive: true });
      for (const entry of unpacked.entries) {
        const dest = resolveSafeExtractPath(input.extractToDir, entry.path);
        NodeFs.mkdirSync(NodePath.dirname(dest), { recursive: true });
        await NodeFs.promises.writeFile(dest, entry.content);
        extractedFiles.push(dest);
      }
    }
    return {
      verified: true,
      format: "T3ARC1",
      encrypted: unpacked.encrypted,
      encryptionFormat,
      manifest: unpacked.manifest,
      manifestSha256: unpacked.manifestSha256,
      verifiedFilesCount: unpacked.entries.length,
      totalRawBytes: unpacked.entries.reduce((sum, e) => sum + e.content.byteLength, 0),
      extractedFiles,
    };
  }

  // 스트리밍 T3ARC2 (+ 선택 T3ENC2) 검증·복원 경로 (O(1) 메모리)
  const rs = NodeFs.createReadStream(input.archivePath, { highWaterMark: FRAME_CHUNK_SIZE });
  const gunzip = NodeZlib.createGunzip({ chunkSize: FRAME_CHUNK_SIZE });
  const outPass = new PassThrough({ highWaterMark: FRAME_CHUNK_SIZE });

  const pipePromise =
    encryptionFormat === "T3ENC2"
      ? pipeline(
          rs,
          createT3Enc2DecryptTransform(input.passphrase!),
          gunzip,
          outPass,
          ...(input.signal ? [{ signal: input.signal }] : []),
        )
      : pipeline(rs, gunzip, outPass, ...(input.signal ? [{ signal: input.signal }] : []));

  const reader = new AsyncByteReader(outPass);
  const seenEntries: T3Arc2EntryMeta[] = [];
  const extractedFiles: string[] = [];
  let totalRawBytes = 0;

  try {
    const magic = await reader.readExact(6);
    if (!magic.equals(ARC2_MAGIC)) {
      throw new Error("손상된 아카이브: T3ARC2 매직 헤더가 일치하지 않습니다.");
    }
    await reader.readExact(2); // flags

    let manifest: T3Arc2Manifest | null = null;
    let manifestSha256 = "";

    while (true) {
      const recType = await reader.readUInt8();
      if (recType === RECORD_ENTRY) {
        const pathLen = await reader.readUInt32BE();
        if (pathLen === 0 || pathLen > 32 * 1024) {
          throw new Error("손상된 T3ARC2 엔트리 경로 길이입니다.");
        }
        const entryPath = (await reader.readExact(pathLen)).toString("utf8");
        const declaredSize = await reader.readBigUInt64BE();
        const mtimeMs = Number(await reader.readBigUInt64BE());

        let extractStream: NodeFs.WriteStream | null = null;
        let extractDestPath: string | null = null;
        if (input.extractToDir) {
          extractDestPath = resolveSafeExtractPath(input.extractToDir, entryPath);
          NodeFs.mkdirSync(NodePath.dirname(extractDestPath), { recursive: true });
          extractStream = NodeFs.createWriteStream(extractDestPath, {
            highWaterMark: FRAME_CHUNK_SIZE,
          });
        }

        const hasher = NodeCrypto.createHash("sha256");
        let actualBytes = 0n;

        try {
          while (true) {
            const frameLen = await reader.readUInt32BE();
            if (frameLen === 0) break;
            if (frameLen > 32 * 1024 * 1024) {
              throw new Error(`손상된 T3ARC2 프레임 길이: ${frameLen}`);
            }
            const frame = await reader.readExact(frameLen);
            hasher.update(frame);
            actualBytes += BigInt(frameLen);
            if (extractStream) {
              if (!extractStream.write(frame)) {
                await new Promise<void>((res, rej) => {
                  extractStream!.once("drain", res);
                  extractStream!.once("error", rej);
                });
              }
            }
          }
          if (extractStream) {
            await new Promise<void>((res, rej) => {
              extractStream!.end(() => res());
              extractStream!.once("error", rej);
            });
          }
        } catch (e) {
          extractStream?.destroy();
          throw e;
        }

        const expectedHash = (await reader.readExact(32)).toString("hex");
        const actualHash = hasher.digest("hex");
        if (actualHash !== expectedHash) {
          throw new Error(`무결성 오류: '${entryPath}' SHA-256 불일치`);
        }
        if (declaredSize !== actualBytes) {
          // 스냅샷 등 가변 파일이어도 실제 기록 바이트와 매니페스트 대조
          // (매니페스트의 byteLength와 정확히 일치해야 함)
        }

        seenEntries.push({
          path: entryPath,
          byteLength: Number(actualBytes),
          mtimeMs,
          sha256: actualHash,
        });
        totalRawBytes += Number(actualBytes);
        if (extractDestPath) extractedFiles.push(extractDestPath);
      } else if (recType === RECORD_MANIFEST) {
        const manifestLen = await reader.readUInt32BE();
        if (manifestLen === 0 || manifestLen > 128 * 1024 * 1024) {
          throw new Error("손상된 T3ARC2 매니페스트 길이입니다.");
        }
        const manifestBuf = await reader.readExact(manifestLen);
        const expectedManifestHash = (await reader.readExact(32)).toString("hex");
        const endMagic = await reader.readExact(6);
        if (!endMagic.equals(ARC2_END_MAGIC)) {
          throw new Error("손상된 T3ARC2 아카이브: T3END2 끝 매직이 일치하지 않습니다.");
        }
        const actualManifestHash = sha256Hex(manifestBuf);
        if (actualManifestHash !== expectedManifestHash) {
          throw new Error("무결성 오류: T3ARC2 매니페스트 SHA-256 불일치");
        }
        manifest = JSON.parse(manifestBuf.toString("utf8")) as T3Arc2Manifest;
        manifestSha256 = actualManifestHash;
        await reader.assertEof();
        break;
      } else {
        throw new Error(`알 수 없는 T3ARC2 레코드 유형: 0x${recType.toString(16)}`);
      }
    }

    await pipePromise;

    if (!manifest) {
      throw new Error("손상된 T3ARC2 아카이브: 말미 매니페스트가 누락되었습니다.");
    }
    if (manifest.entries.length !== seenEntries.length) {
      throw new Error(
        `무결성 오류: 매니페스트 엔트리 수(${manifest.entries.length})와 실제 엔트리 수(${seenEntries.length})가 다릅니다.`,
      );
    }
    for (let i = 0; i < manifest.entries.length; i += 1) {
      const m = manifest.entries[i]!;
      const s = seenEntries[i]!;
      if (m.path !== s.path || m.sha256 !== s.sha256 || m.byteLength !== s.byteLength) {
        throw new Error(`무결성 오류: 매니페스트 항목 '${m.path}'가 스트림 엔트리와 불일치합니다.`);
      }
    }

    return {
      verified: true,
      format: "T3ARC2",
      encrypted,
      encryptionFormat,
      manifest,
      manifestSha256,
      verifiedFilesCount: seenEntries.length,
      totalRawBytes,
      extractedFiles,
    };
  } catch (err) {
    outPass.destroy();
    rs.destroy();
    await pipePromise.catch(() => undefined);
    throw err;
  }
}
