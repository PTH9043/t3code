#!/usr/bin/env node
/**
 * T3 독립 복원 전용 CLI (외부 패키지·T3 서버 불필요, Node.js 22+ 내장 모듈 전용).
 *
 * 지원 포맷:
 *   - 암호화: T3ENC2 (스트리밍 청크 AES-256-GCM), T3ENC1 (레거시 버퍼 AES-256-GCM), 비암호화
 *   - 아카이브: T3ARC2 (스트리밍 엔트리 선행/매니페스트 말미), T3ARC1 (레거시 버퍼)
 *
 * 사용법:
 *   node scripts/t3-backup-restore.mjs inspect <archive> [--passphrase <pw> | --passphrase-env <ENV>]
 *   node scripts/t3-backup-restore.mjs verify  <archive> [--passphrase <pw> | --passphrase-env <ENV>]
 *   node scripts/t3-backup-restore.mjs restore <archive> --out <dir> [--passphrase <pw> | --passphrase-env <ENV>]
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as NodeZlib from "node:zlib";

const MAGIC_ENC1 = Buffer.from("T3ENC1", "ascii");
const MAGIC_ENC2 = Buffer.from("T3ENC2", "ascii");
const MAGIC_ARC1 = Buffer.from("T3ARC1", "ascii");
const MAGIC_ARC2 = Buffer.from("T3ARC2", "ascii");
const MAGIC_END2 = Buffer.from("T3END2", "ascii");
const RECORD_ENTRY = 0x01;
const RECORD_MANIFEST = 0x02;
const TAG_LEN = 16;
const T3ENC2_HEADER_LEN = 46;
const FRAME_CHUNK_SIZE = 256 * 1024;

function sha256Hex(data) {
  return NodeCrypto.createHash("sha256").update(data).digest("hex");
}

function deriveKey(passphrase, salt, nExp = 14, r = 8, p = 1) {
  return NodeCrypto.scryptSync(passphrase, salt, 32, { N: 1 << nExp, r, p });
}

function detectEncFormat(filePath) {
  const fd = NodeFs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(6);
    const n = NodeFs.readSync(fd, head, 0, 6, 0);
    if (n < 6) return "none";
    if (head.equals(MAGIC_ENC2)) return "T3ENC2";
    if (head.equals(MAGIC_ENC1)) return "T3ENC1";
    return "none";
  } finally {
    NodeFs.closeSync(fd);
  }
}

function decryptT3Enc1(encoded, passphrase) {
  const salt = encoded.subarray(6, 22);
  const iv = encoded.subarray(22, 34);
  const tag = encoded.subarray(34, 50);
  const ct = encoded.subarray(50);
  const key = deriveKey(passphrase, salt);
  const dec = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  dec.setAAD(MAGIC_ENC1);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]);
}

function createT3Enc2DecryptTransform(passphrase) {
  let buffer = Buffer.alloc(0);
  let headerParsed = false;
  let key = null;
  let baseNonce = null;
  let maxChunkSize = 1024 * 1024;
  let chunkIndex = 0n;
  let sawFinal = false;

  const processBuffer = (stream) => {
    if (!headerParsed) {
      if (buffer.byteLength < T3ENC2_HEADER_LEN) return;
      if (!buffer.subarray(0, 6).equals(MAGIC_ENC2)) {
        throw new Error("유효한 T3ENC2 헤더가 아닙니다.");
      }
      if (buffer[6] !== 2) throw new Error(`지원하지 않는 T3ENC2 버전: ${buffer[6]}`);
      const salt = Buffer.from(buffer.subarray(8, 24));
      baseNonce = Buffer.from(buffer.subarray(24, 36));
      maxChunkSize = buffer.readUInt32BE(36);
      key = deriveKey(passphrase, salt, buffer[40], buffer[41], buffer[42]);
      buffer = buffer.subarray(T3ENC2_HEADER_LEN);
      headerParsed = true;
    }

    while (buffer.byteLength >= 5) {
      if (sawFinal) throw new Error("변조 감지: 마지막 청크 뒤에 잔여 바이트 존재");
      const plainLen = buffer.readUInt32BE(0);
      const flags = buffer[4];
      const isFinal = (flags & 0x01) !== 0;
      if ((flags & ~0x01) !== 0 || plainLen > maxChunkSize) {
        throw new Error("손상된 T3ENC2 청크 헤더");
      }
      const frameLen = 5 + plainLen + TAG_LEN;
      if (buffer.byteLength < frameLen) return;

      const ct = buffer.subarray(5, 5 + plainLen);
      const tag = buffer.subarray(5 + plainLen, frameLen);
      buffer = buffer.subarray(frameLen);

      const nonce = Buffer.from(baseNonce);
      nonce.writeBigUInt64BE(nonce.readBigUInt64BE(4) ^ chunkIndex, 4);
      const aad = Buffer.alloc(MAGIC_ENC2.length + 8 + 1);
      MAGIC_ENC2.copy(aad, 0);
      aad.writeBigUInt64BE(chunkIndex, MAGIC_ENC2.length);
      aad[MAGIC_ENC2.length + 8] = isFinal ? 1 : 0;
      chunkIndex += 1n;

      const dec = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce);
      dec.setAAD(aad);
      dec.setAuthTag(tag);
      const pt1 = dec.update(ct);
      const pt2 = dec.final();
      if (pt1.byteLength > 0) stream.push(pt1);
      if (pt2.byteLength > 0) stream.push(pt2);
      if (isFinal) sawFinal = true;
    }
  };

  return new Transform({
    highWaterMark: FRAME_CHUNK_SIZE,
    transform(chunk, _enc, cb) {
      try {
        buffer = buffer.byteLength === 0 ? chunk : Buffer.concat([buffer, chunk]);
        processBuffer(this);
        cb();
      } catch (e) {
        cb(e);
      }
    },
    flush(cb) {
      try {
        processBuffer(this);
        if (!headerParsed || !sawFinal || buffer.byteLength > 0) {
          throw new Error("손상된 T3ENC2 스트림: 트렁케이션 또는 미종료");
        }
        cb();
      } catch (e) {
        cb(e);
      }
    },
  });
}

class AsyncByteReader {
  constructor(stream) {
    this.iter = stream[Symbol.asyncIterator]();
    this.chunks = [];
    this.buffered = 0;
    this.eof = false;
  }
  async fill(min) {
    while (this.buffered < min && !this.eof) {
      const next = await this.iter.next();
      if (next.done) {
        this.eof = true;
        break;
      }
      const b = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (b.byteLength > 0) {
        this.chunks.push(b);
        this.buffered += b.byteLength;
      }
    }
    return this.buffered >= min;
  }
  async readExact(len) {
    if (len === 0) return Buffer.alloc(0);
    if (!(await this.fill(len))) throw new Error(`예상(${len}B)보다 일찍 EOF 도달`);
    const out = Buffer.allocUnsafe(len);
    let pos = 0;
    while (pos < len) {
      const head = this.chunks[0];
      const take = Math.min(head.byteLength, len - pos);
      head.copy(out, pos, 0, take);
      pos += take;
      this.buffered -= take;
      if (take === head.byteLength) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    return out;
  }
  async readUInt8() {
    return (await this.readExact(1))[0];
  }
  async readUInt32BE() {
    return (await this.readExact(4)).readUInt32BE(0);
  }
  async readBigUInt64BE() {
    return (await this.readExact(8)).readBigUInt64BE(0);
  }
  async assertEof() {
    await this.fill(1);
    if (this.buffered > 0) throw new Error("트레일러 뒤에 예상치 못한 잔여 바이트 존재");
  }
}

function resolveSafePath(rootDir, entryPath) {
  const norm = entryPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..")
    .join("/");
  if (!norm) throw new Error(`유효하지 않은 엔트리 경로: ${entryPath}`);
  const root = NodePath.resolve(rootDir);
  const dest = NodePath.resolve(root, norm.split("/").join(NodePath.sep));
  if (
    dest !== root &&
    !dest.startsWith(root.endsWith(NodePath.sep) ? root : `${root}${NodePath.sep}`)
  ) {
    throw new Error(`경로 탈출 차단: ${entryPath}`);
  }
  return dest;
}

async function detectInnerFormat(archivePath, encFormat) {
  if (encFormat === "T3ENC1") return "T3ARC1";
  if (encFormat === "T3ENC2") return "T3ARC2";
  const rs = NodeFs.createReadStream(archivePath, { highWaterMark: 16 * 1024 });
  const gunzip = NodeZlib.createGunzip();
  rs.pipe(gunzip);
  try {
    const reader = new AsyncByteReader(gunzip);
    const magic = await reader.readExact(6);
    return magic.equals(MAGIC_ARC2) ? "T3ARC2" : "T3ARC1";
  } finally {
    rs.destroy();
    gunzip.destroy();
  }
}

async function runArchiveOp({ archivePath, passphrase, extractToDir }) {
  const encFormat = detectEncFormat(archivePath);
  if (encFormat !== "none" && !passphrase) {
    throw new Error("암호화된 아카이브입니다. --passphrase 또는 --passphrase-env를 지정하세요.");
  }
  const arcFormat = await detectInnerFormat(archivePath, encFormat);

  if (arcFormat === "T3ARC1") {
    const raw = await NodeFs.promises.readFile(archivePath);
    const gzipped = encFormat === "T3ENC1" ? decryptT3Enc1(raw, passphrase) : raw;
    const uncompressed = NodeZlib.gunzipSync(gzipped);
    if (!uncompressed.subarray(0, 6).equals(MAGIC_ARC1)) {
      throw new Error("T3ARC1 매직 헤더 불일치");
    }
    const manifestLen = uncompressed.readUInt32BE(6);
    const manifestBuf = uncompressed.subarray(10, 10 + manifestLen);
    const manifestSha256 = sha256Hex(manifestBuf);
    const manifest = JSON.parse(manifestBuf.toString("utf8"));
    let cursor = 10 + manifestLen;
    const extracted = [];
    for (const meta of manifest.entries) {
      const slice = uncompressed.subarray(cursor, cursor + meta.byteLength);
      if (sha256Hex(slice) !== meta.sha256) {
        throw new Error(`무결성 오류: '${meta.path}' SHA-256 불일치`);
      }
      if (extractToDir) {
        const dest = resolveSafePath(extractToDir, meta.path);
        NodeFs.mkdirSync(NodePath.dirname(dest), { recursive: true });
        await NodeFs.promises.writeFile(dest, slice);
        extracted.push(dest);
      }
      cursor += meta.byteLength;
    }
    return {
      format: "T3ARC1",
      encryptionFormat: encFormat,
      manifest,
      manifestSha256,
      verifiedFilesCount: manifest.entries.length,
      extractedFiles: extracted,
    };
  }

  // Streaming T3ARC2 (+ optional T3ENC2)
  const rs = NodeFs.createReadStream(archivePath, { highWaterMark: FRAME_CHUNK_SIZE });
  const gunzip = NodeZlib.createGunzip({ chunkSize: FRAME_CHUNK_SIZE });
  const outPass = new PassThrough({ highWaterMark: FRAME_CHUNK_SIZE });
  const pipePromise =
    encFormat === "T3ENC2"
      ? pipeline(rs, createT3Enc2DecryptTransform(passphrase), gunzip, outPass)
      : pipeline(rs, gunzip, outPass);

  const reader = new AsyncByteReader(outPass);
  const seen = [];
  const extracted = [];
  let manifest = null;
  let manifestSha256 = "";

  try {
    const magic = await reader.readExact(6);
    if (!magic.equals(MAGIC_ARC2)) throw new Error("T3ARC2 매직 불일치");
    await reader.readExact(2);

    while (true) {
      const recType = await reader.readUInt8();
      if (recType === RECORD_ENTRY) {
        const pathLen = await reader.readUInt32BE();
        const entryPath = (await reader.readExact(pathLen)).toString("utf8");
        await reader.readBigUInt64BE(); // declaredSize
        const mtimeMs = Number(await reader.readBigUInt64BE());

        let ws = null;
        let dest = null;
        if (extractToDir) {
          dest = resolveSafePath(extractToDir, entryPath);
          NodeFs.mkdirSync(NodePath.dirname(dest), { recursive: true });
          ws = NodeFs.createWriteStream(dest, { highWaterMark: FRAME_CHUNK_SIZE });
        }
        const hasher = NodeCrypto.createHash("sha256");
        let actualBytes = 0n;
        try {
          while (true) {
            const frameLen = await reader.readUInt32BE();
            if (frameLen === 0) break;
            const frame = await reader.readExact(frameLen);
            hasher.update(frame);
            actualBytes += BigInt(frameLen);
            if (ws && !ws.write(frame)) {
              await new Promise((res, rej) => {
                ws.once("drain", res);
                ws.once("error", rej);
              });
            }
          }
          if (ws) {
            await new Promise((res, rej) => {
              ws.end(() => res());
              ws.once("error", rej);
            });
          }
        } catch (err) {
          ws?.destroy();
          throw err;
        }
        const expectedHash = (await reader.readExact(32)).toString("hex");
        const actualHash = hasher.digest("hex");
        if (actualHash !== expectedHash) {
          throw new Error(`무결성 오류: '${entryPath}' SHA-256 불일치`);
        }
        seen.push({
          path: entryPath,
          byteLength: Number(actualBytes),
          mtimeMs,
          sha256: actualHash,
        });
        if (dest) extracted.push(dest);
      } else if (recType === RECORD_MANIFEST) {
        const len = await reader.readUInt32BE();
        const manifestBuf = await reader.readExact(len);
        const expectedHash = (await reader.readExact(32)).toString("hex");
        const endMagic = await reader.readExact(6);
        if (!endMagic.equals(MAGIC_END2)) throw new Error("T3END2 트레일러 불일치");
        const actualHash = sha256Hex(manifestBuf);
        if (actualHash !== expectedHash) throw new Error("매니페스트 SHA-256 불일치");
        manifest = JSON.parse(manifestBuf.toString("utf8"));
        manifestSha256 = actualHash;
        await reader.assertEof();
        break;
      } else {
        throw new Error(`알 수 없는 레코드 유형: ${recType}`);
      }
    }
    await pipePromise;
  } catch (err) {
    outPass.destroy();
    rs.destroy();
    await pipePromise.catch(() => undefined);
    throw err;
  }

  if (!manifest || manifest.entries.length !== seen.length) {
    throw new Error("매니페스트 엔트리 수 불일치");
  }
  for (let i = 0; i < manifest.entries.length; i += 1) {
    const m = manifest.entries[i];
    const s = seen[i];
    if (m.path !== s.path || m.sha256 !== s.sha256 || m.byteLength !== s.byteLength) {
      throw new Error(`매니페스트 항목 불일치: ${m.path}`);
    }
  }
  return {
    format: "T3ARC2",
    encryptionFormat: encFormat,
    manifest,
    manifestSha256,
    verifiedFilesCount: seen.length,
    extractedFiles: extracted,
  };
}

async function runSqliteQuickChecks(extractedFiles) {
  const sqliteFiles = extractedFiles.filter((f) => /\.sqlite$/i.test(f));
  if (sqliteFiles.length === 0) return [];
  const { DatabaseSync } = await import("node:sqlite");
  const results = [];
  for (const file of sqliteFiles) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare("PRAGMA quick_check").get();
      const status = String(row?.quick_check ?? "unknown");
      if (status !== "ok") {
        throw new Error(`복원된 SQLite quick_check 실패 (${file}): ${status}`);
      }
      results.push({ file, quickCheck: status });
    } finally {
      db.close();
    }
  }
  return results;
}

function parseArgs(argv) {
  const command = argv[0];
  const archivePath = argv[1];
  let outDir = null;
  let passphrase = null;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) {
      outDir = argv[i + 1];
      i += 1;
    } else if (arg === "--passphrase" && argv[i + 1]) {
      passphrase = argv[i + 1];
      i += 1;
    } else if (arg === "--passphrase-env" && argv[i + 1]) {
      passphrase = process.env[argv[i + 1]] ?? null;
      i += 1;
    }
  }
  return { command, archivePath, outDir, passphrase };
}

async function main() {
  const { command, archivePath, outDir, passphrase } = parseArgs(process.argv.slice(2));
  if (!command || !archivePath || !["inspect", "verify", "restore"].includes(command)) {
    console.error(
      "Usage: node scripts/t3-backup-restore.mjs <inspect|verify|restore> <archive> [--out <dir>] [--passphrase <pw> | --passphrase-env <VAR>]",
    );
    process.exit(2);
  }
  if (command === "restore" && !outDir) {
    console.error("restore 명령에는 --out <dir> 인자가 필요합니다.");
    process.exit(2);
  }

  const res = await runArchiveOp({
    archivePath: NodePath.resolve(archivePath),
    passphrase,
    extractToDir: command === "restore" ? NodePath.resolve(outDir) : undefined,
  });

  const sqliteChecks = command === "restore" ? await runSqliteQuickChecks(res.extractedFiles) : [];

  console.log(
    JSON.stringify(
      {
        ok: true,
        command,
        format: res.format,
        encryptionFormat: res.encryptionFormat,
        targetId: res.manifest.targetId,
        targetDisplayName: res.manifest.targetDisplayName,
        createdAtIso: res.manifest.createdAtIso,
        verifiedFilesCount: res.verifiedFilesCount,
        manifestSha256: res.manifestSha256,
        ...(command === "inspect" ? { entries: res.manifest.entries } : {}),
        ...(command === "restore"
          ? {
              outDir: NodePath.resolve(outDir),
              extractedCount: res.extractedFiles.length,
              sqliteQuickChecks: sqliteChecks,
            }
          : {}),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  process.exit(1);
});
