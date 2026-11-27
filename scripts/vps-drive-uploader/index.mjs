#!/usr/bin/env node
/**
 * T3 VPS → Google Drive 교환소 업로더 (최소 구현, 외부 npm 의존성 0개 · Node.js 22+ ESM)
 *
 * 설계 원칙:
 * 1. T3 PC와 동일한 Google Cloud 프로젝트의 OAuth Client ID / Secret (`drive.file` 최소 스코프) 사용.
 *    (Service Account 사용 금지: 개인 Google Drive 저장 용량 할당 없음; OAuth 앱 Production 게시 필수)
 * 2. Linux 토큰 파일 보호: `chmod 0600` + AES-256-GCM 암호화 봉투(`VPS-TOK1`, scrypt 키 파생).
 * 3. 교환소 불변 규약: 입력을 시간 단위 세그먼트(`<writer>_YYYYMMDDTHH_<uuid6>.jsonl.gz` + `.manifest.json`)
 *    로 묶어 `exchange/<writer>/outbox/`에 append-only 업로드 (소형 파일 대량 생성·덮어쓰기 금지).
 * 4. SQLite 원본 차단: `.sqlite`, `.sqlite3`, `.db`, `.sqlite-wal`, `.sqlite-shm`, `.sqlite-journal` 절대 거부.
 * 5. 복원력·대역폭 제한: 256KiB 배수 Resumable 업로드 + TokenBucket(기본 10 Mbps) + 403/429/5xx 지수 백오프.
 *
 * 사용 예:
 *   T3_VPS_TOKEN_KEY="strong-key" node scripts/vps-drive-uploader/index.mjs init-token \
 *     --token-file /etc/t3-vps/drive-token.enc \
 *     --client-id ... --client-secret ... --refresh-token ...
 *
 *   T3_VPS_TOKEN_KEY="strong-key" node scripts/vps-drive-uploader/index.mjs upload \
 *     --token-file /etc/t3-vps/drive-token.enc \
 *     --input-dir /var/lib/t3-vps/outbox-staging \
 *     --writer vps --drive-root T3-Backup --limit-mbps 10
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const TOKEN_MAGIC = Buffer.from("VPS-TOK1", "ascii"); // 8 bytes
const FORBIDDEN_EXTENSIONS = [
  ".sqlite",
  ".sqlite3",
  ".db",
  ".sqlite-wal",
  ".sqlite-shm",
  ".sqlite-journal",
];
const RESUMABLE_UNIT = 256 * 1024;

export function isForbiddenExchangeFile(filePath) {
  const lower = String(filePath).trim().toLowerCase();
  return FORBIDDEN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function assertAllowedExchangeFile(filePath) {
  if (isForbiddenExchangeFile(filePath)) {
    throw new Error(`교환소 정책 위반: SQLite 원본/잠금 파일(${filePath})은 업로드할 수 없습니다.`);
  }
}

export function encryptTokenEnvelope(credentialsObj, passphrase) {
  if (!passphrase || String(passphrase).length < 8) {
    throw new Error("토큰 암호화 키(T3_VPS_TOKEN_KEY 또는 --key-file)는 8자 이상이어야 합니다.");
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(Buffer.from(String(passphrase), "utf8"), salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(TOKEN_MAGIC);
  const plain = Buffer.from(JSON.stringify(credentialsObj), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([TOKEN_MAGIC, salt, iv, authTag, encrypted]);
}

export function decryptTokenEnvelope(rawBuf, passphrase) {
  if (!Buffer.isBuffer(rawBuf)) rawBuf = Buffer.from(rawBuf);
  if (rawBuf.byteLength < 8 + 16 + 12 + 16 + 1 || !rawBuf.subarray(0, 8).equals(TOKEN_MAGIC)) {
    throw new Error("유효한 VPS-TOK1 암호화 토큰 파일이 아닙니다.");
  }
  const salt = rawBuf.subarray(8, 24);
  const iv = rawBuf.subarray(24, 36);
  const authTag = rawBuf.subarray(36, 52);
  const ciphertext = rawBuf.subarray(52);
  const key = crypto.scryptSync(Buffer.from(String(passphrase), "utf8"), salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(TOKEN_MAGIC);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(plain.toString("utf8"));
  if (!parsed?.clientId || !parsed?.clientSecret || !parsed?.refreshToken) {
    throw new Error("토큰 파일에 clientId/clientSecret/refreshToken이 누락되었습니다.");
  }
  return parsed;
}

export function writeEncryptedTokenFile(tokenFilePath, credentialsObj, passphrase) {
  const envelope = encryptTokenEnvelope(credentialsObj, passphrase);
  fs.mkdirSync(path.dirname(path.resolve(tokenFilePath)), { recursive: true });
  const tmpPath = `${tokenFilePath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, envelope, { mode: 0o600 });
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // Windows ignores POSIX mode bits
    }
    fs.renameSync(tmpPath, tokenFilePath);
    try {
      fs.chmodSync(tokenFilePath, 0o600);
    } catch {
      // ignore on Windows
    }
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

export function readEncryptedTokenFile(tokenFilePath, passphrase) {
  const raw = fs.readFileSync(tokenFilePath);
  return decryptTokenEnvelope(raw, passphrase);
}

export class TokenBucket {
  constructor(bytesPerSecond) {
    this.rate = Math.max(0, Number(bytesPerSecond) || 0);
    this.capacity = Math.max(256 * 1024, this.rate);
    this.tokens = this.capacity;
    this.lastRefillMs = Date.now();
  }

  async consume(bytes) {
    if (this.rate <= 0 || bytes <= 0) return;
    while (true) {
      const now = Date.now();
      const elapsedSec = Math.max(0, (now - this.lastRefillMs) / 1000);
      this.lastRefillMs = now;
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate);
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      const needed = bytes - this.tokens;
      const waitMs = Math.max(10, Math.ceil((needed / this.rate) * 1000));
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 500)));
    }
  }
}

export async function fetchWithBackoff(url, init = {}, opts = {}) {
  const fetcher = opts.fetcher ?? fetch;
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetcher(url, init);
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        if (attempt === maxRetries) return res;
        const retryAfter = res.headers.get("retry-after");
        const sec = retryAfter !== null ? Number(retryAfter) : Number.NaN;
        const delayMs =
          Number.isFinite(sec) && sec >= 0
            ? Math.min(30_000, sec * 1000)
            : Math.min(16_000, baseDelayMs * 2 ** attempt + crypto.randomInt(0, 150));
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) throw err;
      const delayMs = Math.min(16_000, baseDelayMs * 2 ** attempt + crypto.randomInt(0, 150));
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr ?? new Error("HTTP 요청 재시도 한도 초과");
}

export function buildHourlySegmentId(writer = "vps", now = new Date()) {
  const safeWriter = String(writer).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(safeWriter)) {
    throw new Error(`유효하지 않은 writer 이름: ${writer}`);
  }
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}`;
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  return `${safeWriter}_${stamp}_${rand}`;
}

/**
 * 입력 디렉터리의 파일들을 읽어 단일 시간 단위 불변 세그먼트(`.jsonl.gz` + `.manifest.json`)로 묶는다.
 * SQLite 원본 파일(`.sqlite`, `.db`, `-wal`, `-shm`)은 차단 목록에 기록하고 포함하지 않는다.
 */
export function buildHourlySegmentFromDir({
  inputDir,
  writer = "vps",
  source = "vps-drive-uploader",
  now = new Date(),
  explicitSegmentId,
}) {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`입력 디렉터리가 존재하지 않습니다: ${inputDir}`);
  }
  const stat = fs.statSync(inputDir);
  if (stat.isFile()) {
    assertAllowedExchangeFile(inputDir);
  }

  const records = [];
  const blockedFiles = [];
  const includedSources = [];

  const collectFile = (absPath, relPath) => {
    if (isForbiddenExchangeFile(relPath)) {
      blockedFiles.push(relPath);
      return;
    }
    const lower = relPath.toLowerCase();
    const rawText = fs.readFileSync(absPath, "utf8");
    includedSources.push(relPath);
    if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
      for (const line of rawText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push({ sourceFile: relPath, payload: JSON.parse(trimmed) });
        } catch {
          records.push({ sourceFile: relPath, rawLine: trimmed });
        }
      }
    } else if (lower.endsWith(".json")) {
      try {
        records.push({ sourceFile: relPath, payload: JSON.parse(rawText) });
      } catch {
        records.push({ sourceFile: relPath, text: rawText });
      }
    } else {
      records.push({ sourceFile: relPath, text: rawText });
    }
  };

  if (stat.isFile()) {
    collectFile(inputDir, path.basename(inputDir));
  } else {
    const walk = (dir, prefix) => {
      for (const entry of fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs, rel);
        } else if (entry.isFile()) {
          collectFile(abs, rel);
        }
      }
    };
    walk(inputDir, "");
  }

  const segmentId = explicitSegmentId?.trim() || buildHourlySegmentId(writer, now);
  assertAllowedExchangeFile(segmentId);
  const dataFileName = `${segmentId}.jsonl.gz`;
  const manifestFileName = `${segmentId}.manifest.json`;

  const jsonl = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  const rawBuf = Buffer.from(jsonl, "utf8");
  const gzipBuf = zlib.gzipSync(rawBuf, { level: 6 });
  const gzipSha256 = crypto.createHash("sha256").update(gzipBuf).digest("hex");

  const manifest = {
    schemaVersion: 1,
    segmentId,
    writer,
    createdAtIso: now.toISOString(),
    dataFileName,
    recordCount: records.length,
    rawBytes: rawBuf.byteLength,
    gzipBytes: gzipBuf.byteLength,
    gzipSha256,
    source,
    sourceFilesCount: includedSources.length,
  };
  const manifestBuf = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    segmentId,
    dataFileName,
    manifestFileName,
    gzipBuf,
    manifestBuf,
    manifest,
    blockedFiles,
    includedSources,
  };
}

export async function exchangeRefreshToken({
  creds,
  tokenEndpoint = "https://oauth2.googleapis.com/token",
  fetcher = fetch,
}) {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetchWithBackoff(
    tokenEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    { fetcher, maxRetries: 3 },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const isInvalidGrant = /\binvalid_grant\b/i.test(errText);
    const err = new Error(
      isInvalidGrant
        ? "Google OAuth 토큰 만료(invalid_grant). OAuth 앱이 Testing이면 7일마다 만료됩니다. Google Cloud Console에서 Production으로 게시한 뒤 PC에서 토큰을 재발급해 주세요."
        : `Google OAuth 토큰 갱신 실패 (${res.status}): ${errText.slice(0, 200)}`,
    );
    err.code = isInvalidGrant ? "INVALID_GRANT" : "AUTH_FAILED";
    throw err;
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("OAuth 응답에 access_token이 없습니다.");
  }
  return data.access_token;
}

async function ensureFolder({ accessToken, name, parentId, apiBase, fetcher }) {
  const escaped = name.replace(/'/g, "\\'");
  const qParts = [
    `name = '${escaped}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    "trashed = false",
  ];
  if (parentId) qParts.push(`'${parentId}' in parents`);
  const searchRes = await fetchWithBackoff(
    `${apiBase}/drive/v3/files?q=${encodeURIComponent(qParts.join(" and "))}&fields=files(id,name)&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    { fetcher },
  );
  if (!searchRes.ok) throw new Error(`Drive 폴더 조회 실패 (${searchRes.status})`);
  const found = await searchRes.json();
  if (found.files?.[0]?.id) return found.files[0].id;

  const createRes = await fetchWithBackoff(
    `${apiBase}/drive/v3/files?fields=id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    },
    { fetcher },
  );
  if (!createRes.ok) throw new Error(`Drive 폴더 생성 실패 (${createRes.status})`);
  const created = await createRes.json();
  return created.id;
}

async function uploadBufferResumableImmutable({
  accessToken,
  parentId,
  fileName,
  contentBuf,
  uploadBase,
  apiBase,
  chunkSizeBytes,
  bucket,
  fetcher,
}) {
  assertAllowedExchangeFile(fileName);

  // 덮어쓰기 금지: 동일 파일명이 이미 있으면 즉시 거부
  const escaped = fileName.replace(/'/g, "\\'");
  const dupRes = await fetchWithBackoff(
    `${apiBase}/drive/v3/files?q=${encodeURIComponent(`name = '${escaped}' and '${parentId}' in parents and trashed = false`)}&fields=files(id)&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    { fetcher },
  );
  if (dupRes.ok) {
    const dup = await dupRes.json();
    if (dup.files?.length > 0) {
      throw new Error(
        `교환소 불변 규칙 위반: 파일 '${fileName}'이 이미 존재합니다(덮어쓰기 금지).`,
      );
    }
  }

  const totalBytes = contentBuf.byteLength;
  const alignedChunk =
    Math.max(1, Math.floor((chunkSizeBytes || 4 * 1024 * 1024) / RESUMABLE_UNIT)) * RESUMABLE_UNIT;

  const initRes = await fetchWithBackoff(
    `${uploadBase}/upload/drive/v3/files?uploadType=resumable&fields=id,name`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(totalBytes),
      },
      body: JSON.stringify({ name: fileName, parents: [parentId] }),
    },
    { fetcher },
  );
  if (!initRes.ok) {
    throw new Error(`Resumable 세션 시작 실패 (${initRes.status})`);
  }
  const sessionUrl = initRes.headers.get("location");
  if (!sessionUrl) {
    throw new Error("Resumable Location 헤더를 받지 못했습니다.");
  }

  let offset = 0;
  while (offset < totalBytes || totalBytes === 0) {
    const end = Math.min(totalBytes, offset + alignedChunk);
    const slice = contentBuf.subarray(offset, end);
    if (bucket) await bucket.consume(slice.byteLength);

    const headers =
      totalBytes === 0
        ? { "Content-Type": "application/octet-stream", "Content-Length": "0" }
        : {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(slice.byteLength),
            "Content-Range": `bytes ${offset}-${end - 1}/${totalBytes}`,
          };

    const putRes = await fetchWithBackoff(
      sessionUrl,
      { method: "PUT", headers, body: slice },
      { fetcher },
    );

    if (putRes.status === 200 || putRes.status === 201) {
      return await putRes.json();
    }
    if (putRes.status === 308) {
      const range = putRes.headers.get("range");
      const m = range ? /bytes=0-(\d+)/i.exec(range) : null;
      offset = m?.[1] ? Number(m[1]) + 1 : end;
      continue;
    }
    const errText = await putRes.text().catch(() => "");
    throw new Error(`Resumable 청크 업로드 실패 (${putRes.status}): ${errText.slice(0, 200)}`);
  }
  throw new Error("Resumable 업로드가 완료 응답 없이 종료되었습니다.");
}

export async function uploadExchangeSegmentToDrive({
  creds,
  segment,
  driveRootName = "T3-Backup",
  writer = "vps",
  limitMbps = 10,
  chunkSizeBytes = 4 * 1024 * 1024,
  tokenEndpoint = "https://oauth2.googleapis.com/token",
  apiBase = "https://www.googleapis.com",
  uploadBase = "https://www.googleapis.com",
  fetcher = fetch,
}) {
  const accessToken = await exchangeRefreshToken({ creds, tokenEndpoint, fetcher });
  let parentId = await ensureFolder({ accessToken, name: driveRootName, apiBase, fetcher });
  for (const seg of ["exchange", writer, "outbox"]) {
    parentId = await ensureFolder({ accessToken, name: seg, parentId, apiBase, fetcher });
  }
  const bucket = limitMbps > 0 ? new TokenBucket((limitMbps * 1_000_000) / 8) : null;

  const dataUploaded = await uploadBufferResumableImmutable({
    accessToken,
    parentId,
    fileName: segment.dataFileName,
    contentBuf: segment.gzipBuf,
    uploadBase,
    apiBase,
    chunkSizeBytes,
    bucket,
    fetcher,
  });
  const manifestUploaded = await uploadBufferResumableImmutable({
    accessToken,
    parentId,
    fileName: segment.manifestFileName,
    contentBuf: segment.manifestBuf,
    uploadBase,
    apiBase,
    chunkSizeBytes,
    bucket,
    fetcher,
  });

  return {
    dataFile: dataUploaded,
    manifestFile: manifestUploaded,
    folderPath: `${driveRootName}/exchange/${writer}/outbox`,
  };
}

function parseCliArgs(argv) {
  const args = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals[0] ?? "", args };
}

function resolveEncryptionKey(args) {
  if (args["key-file"]) {
    return fs.readFileSync(String(args["key-file"]), "utf8").trim();
  }
  return (process.env.T3_VPS_TOKEN_KEY ?? "").trim();
}

async function runCli() {
  const { command, args } = parseCliArgs(process.argv.slice(2));
  if (!command || command === "--help" || command === "-h") {
    console.log(
      [
        "T3 VPS Drive Exchange Uploader (외부 의존성 0개)",
        "  init-token --token-file <path> --client-id <id> --client-secret <sec> --refresh-token <tok> [--key-file <path>]",
        "  upload     --token-file <path> --input-dir <dir> [--writer vps] [--drive-root T3-Backup] [--limit-mbps 10] [--key-file <path>]",
      ].join("\n"),
    );
    return;
  }

  const key = resolveEncryptionKey(args);
  const tokenFile = String(args["token-file"] ?? "");
  if (!tokenFile) {
    throw new Error("--token-file 경로가 필요합니다.");
  }

  if (command === "init-token") {
    let creds;
    if (args["from-json"]) {
      creds = JSON.parse(fs.readFileSync(String(args["from-json"]), "utf8"));
    } else {
      creds = {
        clientId: String(args["client-id"] ?? "").trim(),
        clientSecret: String(args["client-secret"] ?? "").trim(),
        refreshToken: String(args["refresh-token"] ?? "").trim(),
      };
    }
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
      throw new Error("clientId, clientSecret, refreshToken을 모두 지정해야 합니다.");
    }
    writeEncryptedTokenFile(tokenFile, creds, key);
    console.log(
      JSON.stringify({
        ok: true,
        action: "init-token",
        tokenFile: path.resolve(tokenFile),
        format: "VPS-TOK1",
      }),
    );
    return;
  }

  if (command === "upload") {
    const inputDir = String(args["input-dir"] ?? "");
    if (!inputDir) throw new Error("--input-dir 경로가 필요합니다.");
    const writer = String(args.writer ?? "vps");
    const driveRootName = String(args["drive-root"] ?? "T3-Backup");
    const limitMbps = Number(args["limit-mbps"] ?? 10);
    const chunkSizeBytes = Number(args["chunk-bytes"] ?? 4 * 1024 * 1024);
    const tokenEndpoint = String(args["token-endpoint"] ?? "https://oauth2.googleapis.com/token");
    const apiBase = String(args["api-base"] ?? "https://www.googleapis.com");
    const uploadBase = String(args["upload-base"] ?? apiBase);

    const creds = readEncryptedTokenFile(tokenFile, key);
    const segment = buildHourlySegmentFromDir({
      inputDir,
      writer,
      explicitSegmentId: args["segment-id"] ? String(args["segment-id"]) : undefined,
    });
    if (segment.manifest.recordCount === 0) {
      console.log(
        JSON.stringify({
          ok: true,
          action: "upload",
          skipped: true,
          reason: "업로드할 허용 레코드가 없습니다.",
          blockedFiles: segment.blockedFiles,
        }),
      );
      return;
    }
    const uploaded = await uploadExchangeSegmentToDrive({
      creds,
      segment,
      driveRootName,
      writer,
      limitMbps,
      chunkSizeBytes,
      tokenEndpoint,
      apiBase,
      uploadBase,
    });
    console.log(
      JSON.stringify({
        ok: true,
        action: "upload",
        segmentId: segment.segmentId,
        recordCount: segment.manifest.recordCount,
        gzipSha256: segment.manifest.gzipSha256,
        blockedFiles: segment.blockedFiles,
        folderPath: uploaded.folderPath,
        dataFileId: uploaded.dataFile?.id ?? null,
        manifestFileId: uploaded.manifestFile?.id ?? null,
      }),
    );
    return;
  }

  throw new Error(`알 수 없는 명령입니다: ${command}`);
}

const isDirectMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectMain) {
  runCli().catch((err) => {
    const code = err?.code === "INVALID_GRANT" ? 12 : 1;
    console.error(`[vps-drive-uploader] 오류: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(code);
  });
}
