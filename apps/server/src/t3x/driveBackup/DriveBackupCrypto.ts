// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

/**
 * Zero-Knowledge 클라이언트 측 암호화 유틸리티 (Node.js 내장 `node:crypto` 전용, 외부 CLI 0개).
 *
 * 포맷 (`T3ENC1`):
 *   [0..5]   Magic "T3ENC1" (6 bytes)
 *   [6..21]  scrypt salt (16 bytes)
 *   [22..33] AES-256-GCM IV (12 bytes)
 *   [34..49] AES-256-GCM AuthTag (16 bytes)
 *   [50..]   Ciphertext
 */

const MAGIC = Buffer.from("T3ENC1", "ascii");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;

export function computeKeyFingerprint(passphrase: string): string {
  return NodeCrypto.createHash("sha256")
    .update(`t3-drive-backup-key-fp:${passphrase}`, "utf8")
    .digest("hex")
    .slice(0, 12);
}

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return NodeCrypto.createHash("sha256").update(data).digest("hex");
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return NodeCrypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function isEncryptedT3Bundle(data: Buffer): boolean {
  return data.length >= HEADER_LEN && data.subarray(0, MAGIC.length).equals(MAGIC);
}

export function encryptBufferAes256Gcm(plaintext: Buffer, passphrase: string): Buffer {
  if (!passphrase || passphrase.length < 4) {
    throw new Error("암호화 비밀번호는 4자 이상이어야 합니다.");
  }
  const salt = NodeCrypto.randomBytes(SALT_LEN);
  const iv = NodeCrypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, authTag, encrypted]);
}

export function decryptBufferAes256Gcm(encoded: Buffer, passphrase: string): Buffer {
  if (!isEncryptedT3Bundle(encoded)) {
    throw new Error("유효한 T3ENC1 암호화 아카이브 헤더가 아닙니다.");
  }
  const salt = encoded.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = encoded.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
  const authTag = encoded.subarray(
    MAGIC.length + SALT_LEN + IV_LEN,
    MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN,
  );
  const ciphertext = encoded.subarray(HEADER_LEN);
  const key = deriveKey(passphrase, salt);
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("복호화 실패: 비밀번호가 일치하지 않거나 아카이브가 손상되었습니다.");
  }
}
