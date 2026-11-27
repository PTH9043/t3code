// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Zero-Knowledge 클라이언트 측 암호화 유틸리티 (Node.js 내장 `node:crypto` 전용, 외부 CLI 0개).
 *
 * 1) 레거시 포맷 (`T3ENC1`, 단일 버퍼 — 복원 하위 호환 유지):
 *   [0..5]   Magic "T3ENC1" (6 bytes)
 *   [6..21]  scrypt salt (16 bytes)
 *   [22..33] AES-256-GCM IV (12 bytes)
 *   [34..49] AES-256-GCM AuthTag (16 bytes)
 *   [50..]   Ciphertext
 *
 * 2) 스트리밍 청크 포맷 (`T3ENC2`, >2GiB 대용량 지원, scrypt 1회 파생):
 *   헤더 (46 bytes):
 *     [0..5]   Magic "T3ENC2" (6 bytes)
 *     [6]      Version 2 (1 byte)
 *     [7]      Flags 0 (1 byte)
 *     [8..23]  scrypt salt (16 bytes)
 *     [24..35] baseNonce (12 bytes)
 *     [36..39] chunkSize UInt32BE (기본 1 MiB)
 *     [40]     scryptNExp (14 -> N=16384)
 *     [41]     scryptR (8)
 *     [42]     scryptP (1)
 *     [43..45] reserved (3 bytes)
 *   반복 청크 레코드:
 *     [0..3]   plainLen UInt32BE
 *     [4]      chunkFlags (bit0 = isFinal)
 *     [5..5+plainLen)       ciphertext
 *     [5+plainLen..21+plainLen) GCM AuthTag (16 bytes)
 *   청크별 Nonce: baseNonce[0..3] || (baseNonce[4..11] XOR chunkIndex64BE)
 *   청크별 AAD:   "T3ENC2" || chunkIndex64BE || (isFinal ? 1 : 0)
 */

const MAGIC_V1 = Buffer.from("T3ENC1", "ascii");
const MAGIC_V2 = Buffer.from("T3ENC2", "ascii");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN_V1 = MAGIC_V1.length + SALT_LEN + IV_LEN + TAG_LEN;
export const T3ENC2_HEADER_LEN = 46;
export const T3ENC2_DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB

export function computeKeyFingerprint(passphrase: string): string {
  return NodeCrypto.createHash("sha256")
    .update(`t3-drive-backup-key-fp:${passphrase}`, "utf8")
    .digest("hex")
    .slice(0, 12);
}

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return NodeCrypto.createHash("sha256").update(data).digest("hex");
}

function deriveKey(passphrase: string, salt: Buffer, nExp = 14, r = 8, p = 1): Buffer {
  const N = 1 << nExp;
  return NodeCrypto.scryptSync(passphrase, salt, 32, { N, r, p });
}

export function isEncryptedT3Bundle(data: Buffer): boolean {
  return (
    (data.length >= HEADER_LEN_V1 && data.subarray(0, MAGIC_V1.length).equals(MAGIC_V1)) ||
    (data.length >= T3ENC2_HEADER_LEN && data.subarray(0, MAGIC_V2.length).equals(MAGIC_V2))
  );
}

export function isT3Enc1Buffer(data: Buffer): boolean {
  return data.length >= HEADER_LEN_V1 && data.subarray(0, MAGIC_V1.length).equals(MAGIC_V1);
}

export function isT3Enc2Buffer(data: Buffer): boolean {
  return data.length >= T3ENC2_HEADER_LEN && data.subarray(0, MAGIC_V2.length).equals(MAGIC_V2);
}

export function detectFileEncryptionFormat(filePath: string): "T3ENC2" | "T3ENC1" | "none" {
  const fd = NodeFs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(6);
    const bytesRead = NodeFs.readSync(fd, head, 0, 6, 0);
    if (bytesRead < 6) return "none";
    if (head.equals(MAGIC_V2)) return "T3ENC2";
    if (head.equals(MAGIC_V1)) return "T3ENC1";
    return "none";
  } finally {
    NodeFs.closeSync(fd);
  }
}

function deriveChunkNonce(baseNonce: Buffer, chunkIndex: bigint): Buffer {
  const nonce = Buffer.from(baseNonce);
  const tail = nonce.readBigUInt64BE(4);
  nonce.writeBigUInt64BE(tail ^ chunkIndex, 4);
  return nonce;
}

function buildChunkAad(chunkIndex: bigint, isFinal: boolean): Buffer {
  const aad = Buffer.alloc(MAGIC_V2.length + 8 + 1);
  MAGIC_V2.copy(aad, 0);
  aad.writeBigUInt64BE(chunkIndex, MAGIC_V2.length);
  aad[MAGIC_V2.length + 8] = isFinal ? 1 : 0;
  return aad;
}

// ---------------------------------------------------------------------------
// T3ENC1 (레거시 버퍼 암호화·복호화 — 하위 호환 유지)
// ---------------------------------------------------------------------------

export function encryptBufferAes256Gcm(plaintext: Buffer, passphrase: string): Buffer {
  if (!passphrase || passphrase.length < 4) {
    throw new Error("암호화 비밀번호는 4자 이상이어야 합니다.");
  }
  const salt = NodeCrypto.randomBytes(SALT_LEN);
  const iv = NodeCrypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC_V1);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC_V1, salt, iv, authTag, encrypted]);
}

export function decryptBufferAes256Gcm(encoded: Buffer, passphrase: string): Buffer {
  if (!isT3Enc1Buffer(encoded)) {
    throw new Error("유효한 T3ENC1 암호화 아카이브 헤더가 아닙니다.");
  }
  const salt = encoded.subarray(MAGIC_V1.length, MAGIC_V1.length + SALT_LEN);
  const iv = encoded.subarray(MAGIC_V1.length + SALT_LEN, MAGIC_V1.length + SALT_LEN + IV_LEN);
  const authTag = encoded.subarray(
    MAGIC_V1.length + SALT_LEN + IV_LEN,
    MAGIC_V1.length + SALT_LEN + IV_LEN + TAG_LEN,
  );
  const ciphertext = encoded.subarray(HEADER_LEN_V1);
  const key = deriveKey(passphrase, salt);
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(MAGIC_V1);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("복호화 실패: 비밀번호가 일치하지 않거나 아카이브가 손상되었습니다.");
  }
}

// ---------------------------------------------------------------------------
// T3ENC2 (스트리밍 청크 AES-256-GCM — scrypt 1회, chunkIndex+isFinal AAD)
// ---------------------------------------------------------------------------

export function createT3Enc2EncryptTransform(
  passphrase: string,
  options?: { readonly chunkSize?: number },
): Transform {
  if (!passphrase || passphrase.length < 4) {
    throw new Error("암호화 비밀번호는 4자 이상이어야 합니다.");
  }
  const chunkSize = Math.max(
    16 * 1024,
    Math.min(16 * 1024 * 1024, Math.floor(options?.chunkSize ?? T3ENC2_DEFAULT_CHUNK_SIZE)),
  );
  const salt = NodeCrypto.randomBytes(SALT_LEN);
  const baseNonce = NodeCrypto.randomBytes(IV_LEN);
  const nExp = 14;
  const r = 8;
  const p = 1;
  // scrypt는 파일 전체에 대해 단 1회만 파생한다
  const key = deriveKey(passphrase, salt, nExp, r, p);

  let headerEmitted = false;
  let chunkIndex = 0n;
  let pendingParts: Buffer[] = [];
  let pendingLen = 0;

  const emitHeader = (stream: Transform) => {
    if (headerEmitted) return;
    headerEmitted = true;
    const header = Buffer.alloc(T3ENC2_HEADER_LEN);
    MAGIC_V2.copy(header, 0);
    header[6] = 2; // version
    header[7] = 0; // flags
    salt.copy(header, 8);
    baseNonce.copy(header, 24);
    header.writeUInt32BE(chunkSize, 36);
    header[40] = nExp;
    header[41] = r;
    header[42] = p;
    header[43] = 0;
    header[44] = 0;
    header[45] = 0;
    stream.push(header);
  };

  const encryptChunk = (plain: Buffer, isFinal: boolean): Buffer => {
    const nonce = deriveChunkNonce(baseNonce, chunkIndex);
    const aad = buildChunkAad(chunkIndex, isFinal);
    chunkIndex += 1n;

    const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const ct1 = cipher.update(plain);
    const ct2 = cipher.final();
    const tag = cipher.getAuthTag();

    const frameHead = Buffer.alloc(5);
    frameHead.writeUInt32BE(plain.byteLength, 0);
    frameHead[4] = isFinal ? 1 : 0;
    return Buffer.concat([frameHead, ct1, ct2, tag]);
  };

  const takePending = (size: number): Buffer => {
    const combined = pendingParts.length === 1 ? pendingParts[0]! : Buffer.concat(pendingParts);
    if (combined.byteLength <= size) {
      pendingParts = [];
      pendingLen = 0;
      return combined;
    }
    const slice = combined.subarray(0, size);
    const rest = Buffer.from(combined.subarray(size));
    pendingParts = [rest];
    pendingLen = rest.byteLength;
    return slice;
  };

  return new Transform({
    highWaterMark: 256 * 1024,
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        emitHeader(this);
        if (chunk.byteLength > 0) {
          pendingParts.push(chunk);
          pendingLen += chunk.byteLength;
        }
        // 마지막 청크 여부를 flush 시점에 확정하기 위해 항상 최소 1바이트를 보류하거나 chunkSize 초과 시에만 비-최종 청크로 방출
        while (pendingLen > chunkSize) {
          const piece = takePending(chunkSize);
          this.push(encryptChunk(piece, false));
        }
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    flush(callback: TransformCallback) {
      try {
        emitHeader(this);
        const remaining =
          pendingLen > 0
            ? pendingParts.length === 1
              ? pendingParts[0]!
              : Buffer.concat(pendingParts)
            : Buffer.alloc(0);
        pendingParts = [];
        pendingLen = 0;
        this.push(encryptChunk(remaining, true));
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}

export function createT3Enc2DecryptTransform(passphrase: string): Transform {
  if (!passphrase || passphrase.length < 4) {
    throw new Error("복호화 비밀번호가 필요합니다.");
  }
  let buffer: Buffer = Buffer.alloc(0);
  let headerParsed = false;
  let key: Buffer | null = null;
  let baseNonce: Buffer | null = null;
  let maxChunkSize = T3ENC2_DEFAULT_CHUNK_SIZE;
  let chunkIndex = 0n;
  let sawFinal = false;

  const processBuffer = (stream: Transform) => {
    if (!headerParsed) {
      if (buffer.byteLength < T3ENC2_HEADER_LEN) return;
      if (!buffer.subarray(0, MAGIC_V2.length).equals(MAGIC_V2)) {
        throw new Error("유효한 T3ENC2 암호화 아카이브 헤더가 아닙니다.");
      }
      const version = buffer[6]!;
      if (version !== 2) {
        throw new Error(`지원하지 않는 T3ENC2 버전입니다: ${version}`);
      }
      const salt = Buffer.from(buffer.subarray(8, 24));
      baseNonce = Buffer.from(buffer.subarray(24, 36));
      maxChunkSize = buffer.readUInt32BE(36);
      const nExp = buffer[40]!;
      const r = buffer[41]!;
      const p = buffer[42]!;
      if (maxChunkSize < 16 * 1024 || maxChunkSize > 32 * 1024 * 1024 || nExp < 10 || nExp > 20) {
        throw new Error("손상된 T3ENC2 헤더 파라미터입니다.");
      }
      key = deriveKey(passphrase, salt, nExp, r, p);
      buffer = buffer.subarray(T3ENC2_HEADER_LEN);
      headerParsed = true;
    }

    while (buffer.byteLength >= 5) {
      if (sawFinal) {
        throw new Error("변조 감지: T3ENC2 마지막 청크 뒤에 예상치 못한 데이터가 존재합니다.");
      }
      const plainLen = buffer.readUInt32BE(0);
      const chunkFlags = buffer[4]!;
      const isFinal = (chunkFlags & 0x01) !== 0;
      if ((chunkFlags & ~0x01) !== 0 || plainLen > maxChunkSize) {
        throw new Error("손상된 T3ENC2 청크 헤더입니다.");
      }
      const frameLen = 5 + plainLen + TAG_LEN;
      if (buffer.byteLength < frameLen) return;

      const ciphertext = buffer.subarray(5, 5 + plainLen);
      const authTag = buffer.subarray(5 + plainLen, frameLen);
      buffer = buffer.subarray(frameLen);

      const nonce = deriveChunkNonce(baseNonce!, chunkIndex);
      const aad = buildChunkAad(chunkIndex, isFinal);
      chunkIndex += 1n;

      const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key!, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      try {
        const pt1 = decipher.update(ciphertext);
        const pt2 = decipher.final();
        if (pt1.byteLength > 0) stream.push(pt1);
        if (pt2.byteLength > 0) stream.push(pt2);
      } catch {
        throw new Error(
          `T3ENC2 복호화/무결성 검증 실패 (청크 #${String(chunkIndex - 1n)}): 비밀번호 불일치 또는 데이터 변조가 감지되었습니다.`,
        );
      }

      if (isFinal) {
        sawFinal = true;
        if (buffer.byteLength > 0) {
          throw new Error("변조 감지: T3ENC2 마지막 청크 뒤에 예상치 못한 잔여 바이트가 있습니다.");
        }
      }
    }
  };

  return new Transform({
    highWaterMark: 256 * 1024,
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      try {
        buffer = buffer.byteLength === 0 ? chunk : Buffer.concat([buffer, chunk]);
        processBuffer(this);
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    flush(callback: TransformCallback) {
      try {
        processBuffer(this);
        if (!headerParsed || !sawFinal || buffer.byteLength > 0) {
          throw new Error("손상된 T3ENC2 스트림: 마지막 청크가 누락되었거나 파일이 잘렸습니다.");
        }
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}

export async function encryptFileT3Enc2(input: {
  readonly srcPath: string;
  readonly dstPath: string;
  readonly passphrase: string;
  readonly chunkSize?: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const rs = NodeFs.createReadStream(input.srcPath, { highWaterMark: 256 * 1024 });
  const enc = createT3Enc2EncryptTransform(
    input.passphrase,
    input.chunkSize !== undefined ? { chunkSize: input.chunkSize } : undefined,
  );
  const ws = NodeFs.createWriteStream(input.dstPath, { highWaterMark: 256 * 1024 });
  await pipeline(rs, enc, ws, ...(input.signal ? [{ signal: input.signal }] : []));
}

export async function decryptFileT3Enc2(input: {
  readonly srcPath: string;
  readonly dstPath: string;
  readonly passphrase: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const rs = NodeFs.createReadStream(input.srcPath, { highWaterMark: 256 * 1024 });
  const dec = createT3Enc2DecryptTransform(input.passphrase);
  const ws = NodeFs.createWriteStream(input.dstPath, { highWaterMark: 256 * 1024 });
  await pipeline(rs, dec, ws, ...(input.signal ? [{ signal: input.signal }] : []));
}
