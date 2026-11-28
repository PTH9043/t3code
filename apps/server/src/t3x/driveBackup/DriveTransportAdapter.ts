// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetch:off globalDate:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import {
  DriveUploadQuotaExceededError,
  isGoogleDriveDailyUploadQuotaResponse,
  REMOTE_QUOTA_COOLDOWN_MS,
} from "./DriveBackupQuota.ts";
import { mbpsToBytesPerSec, sleepAbortable, TokenBucket } from "./TokenBucket.ts";

/**
 * Google Drive Dual Transport 어댑터:
 * - 모드 A (`local_drive_folder`): 로컬 Google Drive 데스크톱 마운트 폴더(또는 지정 폴더)에 원자적 기록 + 롤링 보존
 * - 모드 B (`gdrive_api`): Google Drive REST API v3 (OAuth2 refresh token + `drive.file` 최소 스코프) 직접 업로드·목록·다운로드
 */

export interface DriveUploadInput {
  readonly subFolder: string;
  readonly fileName: string;
  readonly content: Buffer;
  readonly retentionCount: number;
}

export interface DriveUploadResult {
  readonly destinationPath: string;
  readonly prunedCount: number;
}

export interface DriveMirrorItem {
  readonly objectId: string;
  readonly remoteName: string;
  readonly content: Buffer;
}

export interface GdriveOAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

function sanitizeSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "item";
}

/** 지식 폴더·파일명용 안전 정리: 한글/유니코드·공백은 보존하고 경로 구분자·Windows 금지 문자만 치환한다. */
export function sanitizeKnowledgePathSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.+$/g, "")
    .slice(0, 140)
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "item";
  return cleaned;
}

function guessMimeTypeForKnowledgeFile(fileName: string): string {
  const ext = NodePath.extname(fileName).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
    case ".csv":
    case ".tsv":
    case ".yaml":
    case ".yml":
    case ".toml":
      return "text/plain";
    case ".json":
    case ".jsonl":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".html":
    case ".htm":
      return "text/html";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
}

function atomicWriteBuffer(destPath: string, content: Buffer): void {
  NodeFs.mkdirSync(NodePath.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.${NodeCrypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    NodeFs.writeFileSync(tmpPath, content);
    NodeFs.renameSync(tmpPath, destPath);
  } finally {
    if (NodeFs.existsSync(tmpPath)) {
      try {
        NodeFs.rmSync(tmpPath, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

export function uploadToLocalDriveFolder(
  rootDir: string,
  backupFolderName: string,
  input: DriveUploadInput,
): DriveUploadResult {
  const safeSub = input.subFolder
    .split("/")
    .filter(Boolean)
    .map(sanitizeSegment)
    .join(NodePath.sep);
  const targetDir = NodePath.join(rootDir, sanitizeSegment(backupFolderName), safeSub);
  const destPath = NodePath.join(targetDir, sanitizeSegment(input.fileName));
  atomicWriteBuffer(destPath, input.content);

  // 롤링 보존: 최신 retentionCount개만 남기고 구세대 자동 정리
  let prunedCount = 0;
  const keep = Math.max(1, input.retentionCount);
  try {
    const files = NodeFs.readdirSync(targetDir)
      .filter((fn) => fn.endsWith(".t3arc") || fn.endsWith(".t3enc"))
      .map((fn) => {
        const full = NodePath.join(targetDir, fn);
        return { fn, full, mtimeMs: NodeFs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of files.slice(keep)) {
      NodeFs.rmSync(stale.full, { force: true });
      prunedCount += 1;
    }
  } catch {
    // non-fatal pruning failure
  }

  return { destinationPath: destPath, prunedCount };
}

export interface DriveFileUploadInput {
  readonly subFolder: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly retentionCount: number;
  readonly chunkSizeBytes?: number;
  readonly uploadLimitMbps?: number;
  /** 동적 업로드 속도 조회 콜백 (활성 작업 중 저속 ≤5 Mbps ↔ 유휴 시 원래 속도 자동 전환) */
  readonly getUploadLimitMbps?: () => number;
  readonly resumeSessionUri?: string | null;
  readonly resumeOffsetBytes?: number;
  readonly onCheckpoint?: (cp: {
    readonly sessionUri: string;
    readonly offsetBytes: number;
    readonly totalBytes: number;
  }) => Promise<void> | void;
  /** 청크 1건이 Google Drive에 정상 반영될 때마다 호출 (24시간 700 GiB 안전 예산 누적용) */
  readonly onChunkUploaded?: (bytesUploaded: number) => Promise<void> | void;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

export class ResumableUploadPausedError extends Error {
  readonly sessionUri: string;
  readonly offsetBytes: number;
  readonly totalBytes: number;
  constructor(sessionUri: string, offsetBytes: number, totalBytes: number, reason: string) {
    super(`Google Drive 업로드 일시정지됨 (${offsetBytes}/${totalBytes} B): ${reason}`);
    this.name = "ResumableUploadPausedError";
    this.sessionUri = sessionUri;
    this.offsetBytes = offsetBytes;
    this.totalBytes = totalBytes;
  }
}

export async function copyFileToLocalDriveFolder(
  rootDir: string,
  backupFolderName: string,
  input: Pick<
    DriveFileUploadInput,
    | "subFolder"
    | "fileName"
    | "filePath"
    | "retentionCount"
    | "uploadLimitMbps"
    | "getUploadLimitMbps"
    | "signal"
  >,
): Promise<DriveUploadResult> {
  const safeSub = input.subFolder
    .split("/")
    .filter(Boolean)
    .map(sanitizeSegment)
    .join(NodePath.sep);
  const targetDir = NodePath.join(rootDir, sanitizeSegment(backupFolderName), safeSub);
  const destPath = NodePath.join(targetDir, sanitizeSegment(input.fileName));
  NodeFs.mkdirSync(targetDir, { recursive: true });
  const tmpPath = `${destPath}.${NodeCrypto.randomUUID().slice(0, 8)}.tmp`;

  const bucket = input.getUploadLimitMbps
    ? new TokenBucket({
        bytesPerSecond: mbpsToBytesPerSec(input.getUploadLimitMbps()),
        getBytesPerSecond: () => mbpsToBytesPerSec(input.getUploadLimitMbps!()),
      })
    : input.uploadLimitMbps && input.uploadLimitMbps > 0
      ? new TokenBucket({ bytesPerSecond: mbpsToBytesPerSec(input.uploadLimitMbps) })
      : null;

  try {
    if (bucket) {
      const rs = NodeFs.createReadStream(input.filePath, { highWaterMark: 256 * 1024 });
      const ws = NodeFs.createWriteStream(tmpPath, { highWaterMark: 256 * 1024 });
      try {
        for await (const raw of rs) {
          if (input.signal?.aborted) {
            throw new Error(
              `로컬 드라이브 복사 일시정지됨: ${String(input.signal.reason ?? "aborted")}`,
            );
          }
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          await bucket.consume(chunk.byteLength, input.signal);
          if (!ws.write(chunk)) {
            await new Promise<void>((res, rej) => {
              ws.once("drain", res);
              ws.once("error", rej);
            });
          }
        }
        await new Promise<void>((res, rej) => {
          ws.end(() => res());
          ws.once("error", rej);
        });
      } catch (err) {
        rs.destroy();
        ws.destroy();
        throw err;
      }
    } else {
      await pipeline(
        NodeFs.createReadStream(input.filePath, { highWaterMark: 256 * 1024 }),
        NodeFs.createWriteStream(tmpPath, { highWaterMark: 256 * 1024 }),
        ...(input.signal ? [{ signal: input.signal }] : []),
      );
    }
    if (NodeFs.existsSync(destPath)) NodeFs.rmSync(destPath, { force: true });
    NodeFs.renameSync(tmpPath, destPath);
  } finally {
    if (NodeFs.existsSync(tmpPath)) {
      try {
        NodeFs.rmSync(tmpPath, { force: true });
      } catch {
        // ignore
      }
    }
  }

  let prunedCount = 0;
  const keep = Math.max(1, input.retentionCount);
  try {
    const files = NodeFs.readdirSync(targetDir)
      .filter((fn) => fn.endsWith(".t3arc") || fn.endsWith(".t3enc"))
      .map((fn) => {
        const full = NodePath.join(targetDir, fn);
        return { fn, full, mtimeMs: NodeFs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of files.slice(keep)) {
      NodeFs.rmSync(stale.full, { force: true });
      prunedCount += 1;
    }
  } catch {
    // non-fatal pruning failure
  }

  return { destinationPath: destPath, prunedCount };
}

export const DEFAULT_MIRROR_MAX_FILE_BYTES = 256 * 1024 * 1024; // 256 MiB (기존 25 MiB 하드 스킵 해제)
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveRemoteFileMeta {
  readonly id: string;
  readonly name: string;
  readonly relativePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly md5Checksum: string | null;
  readonly modifiedTime: string | null;
  readonly parents: ReadonlyArray<string>;
}

export interface LocalMirrorFileMeta {
  readonly objectId: string;
  readonly remoteName: string;
  readonly sourcePath: string;
  readonly sizeBytes: number;
  readonly modifiedTime: string;
}

export function listLocalKnowledgeMirrorMetadata(
  rootDir: string,
  knowledgeFolderName: string,
  maxFileSizeBytes = DEFAULT_MIRROR_MAX_FILE_BYTES,
): ReadonlyArray<LocalMirrorFileMeta> {
  const sourceDir = NodePath.join(rootDir, sanitizeSegment(knowledgeFolderName));
  if (!NodeFs.existsSync(sourceDir)) return [];
  const items: LocalMirrorFileMeta[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: NodeFs.Dirent[];
    try {
      entries = NodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        try {
          const stat = NodeFs.statSync(abs);
          if (maxFileSizeBytes > 0 && stat.size > maxFileSizeBytes) continue;
          items.push({
            objectId: `local:${rel}`,
            remoteName: rel,
            sourcePath: abs,
            sizeBytes: stat.size,
            modifiedTime: new Date(stat.mtimeMs).toISOString(),
          });
        } catch {
          // skip unreadable file
        }
      }
    }
  };
  walk(sourceDir, "");
  return items;
}

export function listLocalKnowledgeMirrorFiles(
  rootDir: string,
  knowledgeFolderName: string,
  maxFileSizeBytes = DEFAULT_MIRROR_MAX_FILE_BYTES,
): ReadonlyArray<DriveMirrorItem> {
  const metas = listLocalKnowledgeMirrorMetadata(rootDir, knowledgeFolderName, maxFileSizeBytes);
  const items: DriveMirrorItem[] = [];
  for (const meta of metas) {
    try {
      items.push({
        objectId: meta.objectId,
        remoteName: meta.remoteName,
        content: NodeFs.readFileSync(meta.sourcePath),
      });
    } catch {
      // skip
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Google Drive REST API v3 (OAuth2 Refresh Token -> Resumable / Multipart)
// ---------------------------------------------------------------------------

export class OAuthTokenRefreshError extends Error {
  readonly status: number;
  readonly oauthError: string | null;
  readonly isInvalidGrant: boolean;

  constructor(input: {
    readonly status: number;
    readonly oauthError: string | null;
    readonly detail: string;
  }) {
    const isInvalidGrant =
      input.oauthError === "invalid_grant" || /\binvalid_grant\b/i.test(input.detail);
    const message = isInvalidGrant
      ? "Google OAuth 토큰이 만료되었거나 폐기되었습니다(invalid_grant). OAuth 앱이 Testing이면 7일마다 만료됩니다. Google Cloud 콘솔에서 Production으로 게시하세요."
      : `Google OAuth2 토큰 갱신 실패 (${input.status}): ${input.detail.slice(0, 200)}`;
    super(message);
    this.name = "OAuthTokenRefreshError";
    this.status = input.status;
    this.oauthError = input.oauthError;
    this.isInvalidGrant = isInvalidGrant;
  }
}

export function isInvalidGrantError(cause: unknown): boolean {
  if (cause instanceof OAuthTokenRefreshError) {
    return cause.isInvalidGrant;
  }
  const msg = cause instanceof Error ? cause.message : String(cause);
  return /\binvalid_grant\b/i.test(msg);
}

function formatFetchErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message || err.name];
  let cur: unknown = (err as Error & { readonly cause?: unknown }).cause;
  let depth = 0;
  while (cur && depth < 4) {
    depth += 1;
    if (cur instanceof Error) {
      const code = (cur as Error & { readonly code?: unknown }).code;
      const syscall = (cur as Error & { readonly syscall?: unknown }).syscall;
      const detail = [
        typeof code === "string" && code ? code : null,
        typeof syscall === "string" && syscall ? syscall : null,
        cur.message || null,
      ]
        .filter(Boolean)
        .join(" ");
      if (detail) parts.push(detail);
      cur = (cur as Error & { readonly cause?: unknown }).cause;
    } else if (typeof cur === "object") {
      const rec = cur as Record<string, unknown>;
      const detail = [rec.code, rec.syscall, rec.message].filter(Boolean).join(" ");
      if (detail) parts.push(detail);
      break;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" ← ");
}

export async function exchangeRefreshTokenForAccessToken(
  creds: GdriveOAuthCredentials,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  let res: Response;
  try {
    res = await fetchWithRetry(
      fetcher,
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      undefined,
      3,
      "OAuth 토큰 갱신",
    );
  } catch (err) {
    throw new Error(`Google OAuth2 토큰 갱신 네트워크 오류: ${formatFetchErrorDetail(err)}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let oauthError: string | null = null;
    try {
      const parsed = JSON.parse(errText) as { readonly error?: unknown };
      if (typeof parsed.error === "string") oauthError = parsed.error;
    } catch {
      // non-JSON body
    }
    throw new OAuthTokenRefreshError({
      status: res.status,
      oauthError,
      detail: errText,
    });
  }
  const data = (await res.json()) as { readonly access_token?: string };
  if (!data.access_token) {
    throw new OAuthTokenRefreshError({
      status: res.status,
      oauthError: "missing_access_token",
      detail: "Google OAuth2 응답에 access_token이 없습니다.",
    });
  }
  return data.access_token;
}

async function ensureGdriveFolder(
  accessToken: string,
  folderName: string,
  parentId?: string,
): Promise<string> {
  const escaped = folderName.replace(/'/g, "\\'");
  const qParts = [
    `name = '${escaped}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    "trashed = false",
  ];
  if (parentId) qParts.push(`'${parentId}' in parents`);
  const queryUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qParts.join(" and "))}&fields=files(id,name)&pageSize=1`;

  const searchRes = await fetch(queryUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!searchRes.ok) {
    throw new Error(`Google Drive 폴더 조회 실패 (${searchRes.status})`);
  }
  const found = (await searchRes.json()) as {
    readonly files?: ReadonlyArray<{ readonly id: string }>;
  };
  if (found.files && found.files[0]?.id) {
    return found.files[0].id;
  }

  const createRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Google Drive 폴더 생성 실패 (${createRes.status})`);
  }
  const created = (await createRes.json()) as { readonly id: string };
  return created.id;
}

export async function uploadToGoogleDriveApi(
  creds: GdriveOAuthCredentials,
  backupFolderName: string,
  input: DriveUploadInput,
): Promise<DriveUploadResult> {
  const accessToken = await exchangeRefreshTokenForAccessToken(creds);
  let parentId = await ensureGdriveFolder(accessToken, backupFolderName);
  for (const seg of input.subFolder.split("/").filter(Boolean)) {
    parentId = await ensureGdriveFolder(accessToken, sanitizeSegment(seg), parentId);
  }

  // Resumable upload session initiate
  const initRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(input.content.byteLength),
      },
      body: JSON.stringify({
        name: sanitizeSegment(input.fileName),
        parents: [parentId],
      }),
    },
  );
  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => "");
    throw new Error(
      `Google Drive 업로드 세션 시작 실패 (${initRes.status}): ${errText.slice(0, 200)}`,
    );
  }
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) {
    throw new Error("Google Drive Resumable Upload URL(Location)을 받지 못했습니다.");
  }

  // undici 7/8 Dispatcher1Wrapper 브릿지에서 수동 Content-Length가 UND_ERR_INVALID_ARG를 유발하므로
  // fetch가 Uint8Array 본문 길이로 Content-Length를 자동 계산하도록 맡긴다.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(input.content),
  });
  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => "");
    throw new Error(`Google Drive 파일 업로드 실패 (${putRes.status}): ${errText.slice(0, 200)}`);
  }
  const uploaded = (await putRes.json()) as { readonly id: string; readonly name: string };

  // 롤링 보존: 최신 retentionCount 초과 구세대 파일 정리
  let prunedCount = 0;
  const keep = Math.max(1, input.retentionCount);
  try {
    const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and trashed = false`)}&orderBy=createdTime%20desc&fields=files(id,name)&pageSize=100`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (listRes.ok) {
      const listData = (await listRes.json()) as {
        readonly files?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      };
      const archiveFiles = (listData.files ?? []).filter(
        (f) => f.name.endsWith(".t3arc") || f.name.endsWith(".t3enc"),
      );
      for (const stale of archiveFiles.slice(keep)) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${stale.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        prunedCount += 1;
      }
    }
  } catch {
    // non-fatal
  }

  return {
    destinationPath: `gdrive://${backupFolderName}/${input.subFolder}/${uploaded.name} (${uploaded.id})`,
    prunedCount,
  };
}

const RESUMABLE_GRANULARITY = 256 * 1024; // Google Drive Resumable 청크는 반드시 256KiB 배수
const DEFAULT_RESUMABLE_CHUNK = 4 * 1024 * 1024; // 4 MiB (256KiB × 16)

export function alignResumableChunkSize(requested?: number): number {
  const raw = requested && requested > 0 ? requested : DEFAULT_RESUMABLE_CHUNK;
  const units = Math.max(1, Math.floor(raw / RESUMABLE_GRANULARITY));
  return units * RESUMABLE_GRANULARITY;
}

function parseResumeRangeOffset(rangeHeader: string | null): number | null {
  if (!rangeHeader) return null;
  const match = /bytes=0-(\d+)/i.exec(rangeHeader);
  if (!match?.[1]) return null;
  const endByte = Number(match[1]);
  return Number.isFinite(endByte) && endByte >= 0 ? endByte + 1 : null;
}

async function fetchWithRetry(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  maxRetries = 5,
  stageLabel?: string,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) {
      throw new Error(`Aborted: ${String(signal.reason ?? "paused")}`);
    }
    try {
      const res = await fetcher(url, { ...init, ...(signal ? { signal } : {}) });
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        if (res.status === 403) {
          const preview = await res
            .clone()
            .text()
            .catch(() => "");
          if (isGoogleDriveDailyUploadQuotaResponse(res.status, preview)) {
            return res;
          }
        }
        if (attempt === maxRetries) return res;
        const retryAfterRaw = res.headers.get("retry-after");
        const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : Number.NaN;
        const backoffMs =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(30_000, retryAfterSec * 1_000)
            : Math.min(16_000, 400 * 2 ** attempt + NodeCrypto.randomInt(0, 250));
        await sleepAbortable(backoffMs, signal);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (signal?.aborted || attempt === maxRetries) {
        if (signal?.aborted) throw err;
        const prefix = stageLabel ? `[${stageLabel}] ` : "";
        throw new Error(`${prefix}${formatFetchErrorDetail(err)}`, { cause: err });
      }
      const backoffMs = Math.min(16_000, 400 * 2 ** attempt + NodeCrypto.randomInt(0, 250));
      await sleepAbortable(backoffMs, signal);
    }
  }
  const prefix = stageLabel ? `[${stageLabel}] ` : "";
  throw new Error(`${prefix}${formatFetchErrorDetail(lastErr)}`, { cause: lastErr });
}

/**
 * Google Drive API v3 Resumable 청크 스트리밍 업로더 (256KiB 배수 청크, 끊김 재개, 404/410 세션 만료 시 해당 파일만 재시작, TokenBucket 속도 제한).
 */
export async function uploadFileResumableToGoogleDriveApi(
  creds: GdriveOAuthCredentials,
  backupFolderName: string,
  input: DriveFileUploadInput,
): Promise<DriveUploadResult & { readonly fileId: string; readonly resumed: boolean }> {
  const fetcher = input.fetcher ?? fetch;
  const totalBytes = NodeFs.statSync(input.filePath).size;
  const chunkSize = alignResumableChunkSize(input.chunkSizeBytes);
  const bucket = input.getUploadLimitMbps
    ? new TokenBucket({
        bytesPerSecond: mbpsToBytesPerSec(input.getUploadLimitMbps()),
        getBytesPerSecond: () => mbpsToBytesPerSec(input.getUploadLimitMbps!()),
      })
    : input.uploadLimitMbps && input.uploadLimitMbps > 0
      ? new TokenBucket({ bytesPerSecond: mbpsToBytesPerSec(input.uploadLimitMbps) })
      : null;

  const accessToken = await exchangeRefreshTokenForAccessToken(creds, fetcher);
  const ensureFolder = async (folderName: string, parentId?: string): Promise<string> => {
    const escaped = folderName.replace(/'/g, "\\'");
    const qParts = [
      `name = '${escaped}'`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      "trashed = false",
    ];
    if (parentId) qParts.push(`'${parentId}' in parents`);
    const queryUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qParts.join(" and "))}&fields=files(id,name)&pageSize=1`;
    const searchRes = await fetchWithRetry(
      fetcher,
      queryUrl,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      input.signal,
    );
    if (!searchRes.ok) throw new Error(`Google Drive 폴더 조회 실패 (${searchRes.status})`);
    const found = (await searchRes.json()) as {
      readonly files?: ReadonlyArray<{ readonly id: string }>;
    };
    if (found.files?.[0]?.id) return found.files[0].id;
    const createRes = await fetchWithRetry(
      fetcher,
      "https://www.googleapis.com/drive/v3/files?fields=id",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: folderName,
          mimeType: "application/vnd.google-apps.folder",
          ...(parentId ? { parents: [parentId] } : {}),
        }),
      },
      input.signal,
    );
    if (!createRes.ok) throw new Error(`Google Drive 폴더 생성 실패 (${createRes.status})`);
    return ((await createRes.json()) as { readonly id: string }).id;
  };

  let parentId = await ensureFolder(backupFolderName);
  for (const seg of input.subFolder.split("/").filter(Boolean)) {
    parentId = await ensureFolder(sanitizeSegment(seg), parentId);
  }

  const createSession = async (): Promise<string> => {
    const initRes = await fetchWithRetry(
      fetcher,
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "application/octet-stream",
          "X-Upload-Content-Length": String(totalBytes),
        },
        body: JSON.stringify({
          name: sanitizeSegment(input.fileName),
          parents: [parentId],
        }),
      },
      input.signal,
    );
    if (!initRes.ok) {
      const errText = await initRes.text().catch(() => "");
      if (isGoogleDriveDailyUploadQuotaResponse(initRes.status, errText)) {
        throw new DriveUploadQuotaExceededError({
          kind: "remote_quota_exceeded",
          retryAfterMs: Date.now() + REMOTE_QUOTA_COOLDOWN_MS,
          detail: errText,
        });
      }
      throw new Error(
        `Google Drive 업로드 세션 시작 실패 (${initRes.status}): ${errText.slice(0, 200)}`,
      );
    }
    const loc = initRes.headers.get("location");
    if (!loc) throw new Error("Google Drive Resumable Upload URL(Location)을 받지 못했습니다.");
    return loc;
  };

  let sessionUri = input.resumeSessionUri?.trim() || "";
  let offset = Math.max(0, Math.min(totalBytes, input.resumeOffsetBytes ?? 0));
  let resumed = false;
  let uploadedFile: { readonly id: string; readonly name: string } | null = null;

  // 기존 Resumable 세션 URI가 있으면 서버 확정 오프셋 질의 (만료 404/410 시 새 세션으로 자동 전환)
  if (sessionUri) {
    const probeRes = await fetchWithRetry(
      fetcher,
      sessionUri,
      {
        method: "PUT",
        redirect: "manual",
        headers: {
          "Content-Range": `bytes */${totalBytes}`,
        },
      },
      input.signal,
      5,
      "Resumable 세션 오프셋 조회",
    );
    if (probeRes.status === 200 || probeRes.status === 201) {
      uploadedFile = (await probeRes.json()) as { readonly id: string; readonly name: string };
      resumed = true;
    } else if (probeRes.status === 308) {
      const nextLoc = probeRes.headers.get("location");
      if (nextLoc) sessionUri = nextLoc;
      const serverOffset = parseResumeRangeOffset(probeRes.headers.get("range"));
      offset = serverOffset ?? 0;
      resumed = offset > 0;
    } else if (probeRes.status === 404 || probeRes.status === 410) {
      // 세션 만료 -> 이 파일만 처음부터 새 세션 시작
      sessionUri = "";
      offset = 0;
    } else {
      sessionUri = "";
      offset = 0;
    }
  }

  let sessionRestarts = 0;
  const fh = await NodeFs.promises.open(input.filePath, "r");
  const chunkBuf = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(1, totalBytes)));

  try {
    while (!uploadedFile) {
      if (!sessionUri) {
        sessionUri = await createSession();
        offset = 0;
        await input.onCheckpoint?.({ sessionUri, offsetBytes: 0, totalBytes });
      }

      if (input.signal?.aborted) {
        await input.onCheckpoint?.({ sessionUri, offsetBytes: offset, totalBytes });
        throw new ResumableUploadPausedError(
          sessionUri,
          offset,
          totalBytes,
          String(input.signal.reason ?? "paused"),
        );
      }

      if (totalBytes === 0) {
        const putRes = await fetchWithRetry(
          fetcher,
          sessionUri,
          {
            method: "PUT",
            redirect: "manual",
            headers: {
              "Content-Type": "application/octet-stream",
            },
          },
          input.signal,
          5,
          "빈 파일 업로드",
        );
        if (!putRes.ok) {
          throw new Error(`Google Drive 빈 파일 업로드 실패 (${putRes.status})`);
        }
        uploadedFile = (await putRes.json()) as { readonly id: string; readonly name: string };
        break;
      }

      const remaining = totalBytes - offset;
      const toRead = Math.min(chunkSize, remaining);
      const { bytesRead } = await fh.read(chunkBuf, 0, toRead, offset);
      if (bytesRead <= 0) {
        throw new Error(`업로드 파일 읽기 조기 종료 (offset=${offset}/${totalBytes})`);
      }

      if (bucket) {
        try {
          await bucket.consume(bytesRead, input.signal);
        } catch {
          await input.onCheckpoint?.({ sessionUri, offsetBytes: offset, totalBytes });
          throw new ResumableUploadPausedError(
            sessionUri,
            offset,
            totalBytes,
            String(input.signal?.reason ?? "paused"),
          );
        }
      }

      const endByte = offset + bytesRead - 1;
      const slice = chunkBuf.subarray(0, bytesRead);
      let putRes: Response;
      try {
        putRes = await fetchWithRetry(
          fetcher,
          sessionUri,
          {
            method: "PUT",
            redirect: "manual",
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Range": `bytes ${offset}-${endByte}/${totalBytes}`,
            },
            body: new Uint8Array(slice),
          },
          input.signal,
          5,
          `청크 업로드(${offset}-${endByte}/${totalBytes})`,
        );
      } catch (err) {
        if (input.signal?.aborted) {
          await input.onCheckpoint?.({ sessionUri, offsetBytes: offset, totalBytes });
          throw new ResumableUploadPausedError(
            sessionUri,
            offset,
            totalBytes,
            String(input.signal.reason ?? "paused"),
          );
        }
        throw err;
      }

      if (putRes.status === 200 || putRes.status === 201) {
        uploadedFile = (await putRes.json()) as { readonly id: string; readonly name: string };
        await input.onChunkUploaded?.(bytesRead);
        offset = totalBytes;
        await input.onCheckpoint?.({ sessionUri, offsetBytes: offset, totalBytes });
        break;
      }

      if (putRes.status === 308) {
        const nextLoc = putRes.headers.get("location");
        if (nextLoc) sessionUri = nextLoc;
        const confirmed = parseResumeRangeOffset(putRes.headers.get("range"));
        const nextOffset = confirmed ?? offset + bytesRead;
        const delta = Math.max(0, nextOffset - offset);
        offset = nextOffset;
        if (delta > 0) {
          await input.onChunkUploaded?.(delta);
        }
        await input.onCheckpoint?.({ sessionUri, offsetBytes: offset, totalBytes });
        continue;
      }

      if ((putRes.status === 404 || putRes.status === 410) && sessionRestarts < 1) {
        // 세션 만료: 해당 파일만 새 세션 시작
        sessionRestarts += 1;
        sessionUri = "";
        offset = 0;
        continue;
      }

      const errText = await putRes.text().catch(() => "");
      if (isGoogleDriveDailyUploadQuotaResponse(putRes.status, errText)) {
        await input.onCheckpoint?.({ sessionUri, offsetBytes: offset, totalBytes });
        throw new DriveUploadQuotaExceededError({
          kind: "remote_quota_exceeded",
          retryAfterMs: Date.now() + REMOTE_QUOTA_COOLDOWN_MS,
          sessionUri,
          offsetBytes: offset,
          totalBytes,
          detail: errText,
        });
      }
      throw new Error(`Google Drive 청크 업로드 실패 (${putRes.status}): ${errText.slice(0, 200)}`);
    }
  } finally {
    await fh.close();
  }

  // 롤링 보존: 최신 retentionCount 초과 구세대 파일 정리
  let prunedCount = 0;
  const keep = Math.max(1, input.retentionCount);
  try {
    const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and trashed = false`)}&orderBy=createdTime%20desc&fields=files(id,name)&pageSize=100`;
    const listRes = await fetchWithRetry(
      fetcher,
      listUrl,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      input.signal,
    );
    if (listRes.ok) {
      const listData = (await listRes.json()) as {
        readonly files?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      };
      const archiveFiles = (listData.files ?? []).filter(
        (f) => f.name.endsWith(".t3arc") || f.name.endsWith(".t3enc"),
      );
      for (const stale of archiveFiles.slice(keep)) {
        await fetcher(`https://www.googleapis.com/drive/v3/files/${stale.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        prunedCount += 1;
      }
    }
  } catch {
    // non-fatal
  }

  return {
    destinationPath: `gdrive://${backupFolderName}/${input.subFolder}/${uploadedFile.name} (${uploadedFile.id})`,
    prunedCount,
    fileId: uploadedFile.id,
    resumed,
  };
}

export async function ensureGdriveFolderPath(input: {
  readonly accessToken: string;
  readonly folderSegments: ReadonlyArray<string>;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const fetcher = input.fetcher ?? fetch;
  let parentId: string | undefined;
  for (const rawSeg of input.folderSegments) {
    const folderName = sanitizeSegment(rawSeg);
    const escaped = folderName.replace(/'/g, "\\'");
    const qParts = [`name = '${escaped}'`, `mimeType = '${GOOGLE_FOLDER_MIME}'`, "trashed = false"];
    if (parentId) qParts.push(`'${parentId}' in parents`);
    const queryUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qParts.join(" and "))}&fields=files(id,name)&pageSize=1`;
    const searchRes = await fetchWithRetry(
      fetcher,
      queryUrl,
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
      input.signal,
    );
    if (!searchRes.ok) {
      throw new Error(`Google Drive 폴더 조회 실패 (${searchRes.status})`);
    }
    const found = (await searchRes.json()) as {
      readonly files?: ReadonlyArray<{ readonly id: string }>;
    };
    if (found.files?.[0]?.id) {
      parentId = found.files[0].id;
      continue;
    }
    const createRes = await fetchWithRetry(
      fetcher,
      "https://www.googleapis.com/drive/v3/files?fields=id",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: folderName,
          mimeType: GOOGLE_FOLDER_MIME,
          ...(parentId ? { parents: [parentId] } : {}),
        }),
      },
      input.signal,
    );
    if (!createRes.ok) {
      throw new Error(`Google Drive 폴더 생성 실패 (${createRes.status})`);
    }
    parentId = ((await createRes.json()) as { readonly id: string }).id;
  }
  if (!parentId) {
    throw new Error("유효한 Google Drive 폴더 경로가 지정되지 않았습니다.");
  }
  return parentId;
}

export interface ListDriveFolderRecursiveResult {
  readonly rootFolderId: string;
  readonly files: ReadonlyArray<DriveRemoteFileMeta>;
  /** folderId -> relativePath 매핑 (Changes API 필터링용) */
  readonly folderPathById: Readonly<Record<string, string>>;
  readonly pagesFetched: number;
}

/**
 * 지정된 Google Drive 폴더 하위의 모든 파일을 `nextPageToken` 전체 페이징 + 하위 폴더 재귀로 나열한다.
 * 다운로드 전 `md5Checksum` · `modifiedTime` 사전 비교에 필요한 메타데이터만 가져온다.
 */
export async function listDriveFolderRecursive(input: {
  readonly accessToken: string;
  readonly rootFolderId: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly maxDepth?: number;
  readonly pageSize?: number;
}): Promise<ListDriveFolderRecursiveResult> {
  const fetcher = input.fetcher ?? fetch;
  const maxDepth = input.maxDepth ?? 16;
  const pageSize = Math.max(1, Math.min(1000, input.pageSize ?? 200));

  const files: DriveRemoteFileMeta[] = [];
  const folderPathById: Record<string, string> = { [input.rootFolderId]: "" };
  const visitedFolders = new Set<string>([input.rootFolderId]);
  const queue: Array<{
    readonly folderId: string;
    readonly prefix: string;
    readonly depth: number;
  }> = [{ folderId: input.rootFolderId, prefix: "", depth: 0 }];
  let pagesFetched = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    let pageToken: string | undefined;

    do {
      if (input.signal?.aborted) {
        throw new Error(
          `Google Drive 목록 조회 중단됨: ${String(input.signal.reason ?? "aborted")}`,
        );
      }
      const q = `'${current.folderId}' in parents and trashed = false`;
      const params = new URLSearchParams({
        q,
        fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,parents)",
        pageSize: String(pageSize),
      });
      if (pageToken) params.set("pageToken", pageToken);

      const res = await fetchWithRetry(
        fetcher,
        `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        { headers: { Authorization: `Bearer ${input.accessToken}` } },
        input.signal,
      );
      if (!res.ok) {
        throw new Error(`Google Drive 폴더 목록 조회 실패 (${res.status})`);
      }
      pagesFetched += 1;
      const data = (await res.json()) as {
        readonly nextPageToken?: string;
        readonly files?: ReadonlyArray<{
          readonly id: string;
          readonly name: string;
          readonly mimeType?: string;
          readonly size?: string | number;
          readonly md5Checksum?: string;
          readonly modifiedTime?: string;
          readonly parents?: ReadonlyArray<string>;
        }>;
      };

      for (const entry of data.files ?? []) {
        const cleanName = entry.name.replace(/[/\\]/g, "_");
        if (!cleanName || cleanName === "." || cleanName === "..") continue;
        const rel = current.prefix ? `${current.prefix}/${cleanName}` : cleanName;
        const mime = entry.mimeType ?? "application/octet-stream";

        if (mime === GOOGLE_FOLDER_MIME) {
          folderPathById[entry.id] = rel;
          if (!visitedFolders.has(entry.id) && current.depth < maxDepth) {
            visitedFolders.add(entry.id);
            queue.push({ folderId: entry.id, prefix: rel, depth: current.depth + 1 });
          }
          continue;
        }
        // Google Docs/Sheets 등 원시 미디어 다운로드가 불가능한 네이티브 문서는 스킵
        if (mime.startsWith("application/vnd.google-apps.")) {
          continue;
        }
        files.push({
          id: entry.id,
          name: cleanName,
          relativePath: rel,
          mimeType: mime,
          sizeBytes: Math.max(0, Number(entry.size ?? 0) || 0),
          md5Checksum: entry.md5Checksum ?? null,
          modifiedTime: entry.modifiedTime ?? null,
          parents: entry.parents ?? [current.folderId],
        });
      }

      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  return {
    rootFolderId: input.rootFolderId,
    files,
    folderPathById,
    pagesFetched,
  };
}

export interface DriveChangeItem {
  readonly fileId: string;
  readonly removed: boolean;
  readonly file: {
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly md5Checksum: string | null;
    readonly modifiedTime: string | null;
    readonly parents: ReadonlyArray<string>;
    readonly trashed: boolean;
  } | null;
}

export interface FetchDriveChangesResult {
  readonly tokenExpired: boolean;
  readonly newStartPageToken: string | null;
  readonly changes: ReadonlyArray<DriveChangeItem>;
}

export async function getDriveChangesStartPageToken(input: {
  readonly accessToken: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const fetcher = input.fetcher ?? fetch;
  const res = await fetchWithRetry(
    fetcher,
    "https://www.googleapis.com/drive/v3/changes/startPageToken",
    { headers: { Authorization: `Bearer ${input.accessToken}` } },
    input.signal,
  );
  if (!res.ok) {
    throw new Error(`Google Drive Changes startPageToken 조회 실패 (${res.status})`);
  }
  const data = (await res.json()) as { readonly startPageToken?: string };
  if (!data.startPageToken) {
    throw new Error("Google Drive Changes startPageToken 응답이 비어 있습니다.");
  }
  return data.startPageToken;
}

/**
 * Google Drive Changes API v3로 `startPageToken` 이후 변경분만 증분 조회한다.
 * 토큰 만료/무효(400/404/410) 시 예외 대신 `tokenExpired: true`를 반환해 전체 재스캔 폴백을 유도한다.
 */
export async function fetchDriveChanges(input: {
  readonly accessToken: string;
  readonly startPageToken: string;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<FetchDriveChangesResult> {
  const fetcher = input.fetcher ?? fetch;
  const changes: DriveChangeItem[] = [];
  let pageToken: string | undefined = input.startPageToken;
  let newStartPageToken: string | null = null;

  while (pageToken) {
    const params = new URLSearchParams({
      pageToken,
      pageSize: "1000",
      includeRemoved: "true",
      fields:
        "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,md5Checksum,modifiedTime,parents,trashed))",
    });
    const res = await fetchWithRetry(
      fetcher,
      `https://www.googleapis.com/drive/v3/changes?${params.toString()}`,
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
      input.signal,
    );
    if (res.status === 400 || res.status === 404 || res.status === 410) {
      return { tokenExpired: true, newStartPageToken: null, changes: [] };
    }
    if (!res.ok) {
      throw new Error(`Google Drive Changes 목록 조회 실패 (${res.status})`);
    }
    const data = (await res.json()) as {
      readonly nextPageToken?: string;
      readonly newStartPageToken?: string;
      readonly changes?: ReadonlyArray<{
        readonly fileId: string;
        readonly removed?: boolean;
        readonly file?: {
          readonly id: string;
          readonly name: string;
          readonly mimeType?: string;
          readonly size?: string | number;
          readonly md5Checksum?: string;
          readonly modifiedTime?: string;
          readonly parents?: ReadonlyArray<string>;
          readonly trashed?: boolean;
        };
      }>;
    };

    for (const ch of data.changes ?? []) {
      changes.push({
        fileId: ch.fileId,
        removed: Boolean(ch.removed || ch.file?.trashed),
        file: ch.file
          ? {
              id: ch.file.id,
              name: ch.file.name,
              mimeType: ch.file.mimeType ?? "application/octet-stream",
              sizeBytes: Math.max(0, Number(ch.file.size ?? 0) || 0),
              md5Checksum: ch.file.md5Checksum ?? null,
              modifiedTime: ch.file.modifiedTime ?? null,
              parents: ch.file.parents ?? [],
              trashed: Boolean(ch.file.trashed),
            }
          : null,
      });
    }

    if (data.newStartPageToken) {
      newStartPageToken = data.newStartPageToken;
    }
    pageToken = data.nextPageToken;
  }

  return {
    tokenExpired: false,
    newStartPageToken: newStartPageToken ?? input.startPageToken,
    changes,
  };
}

/**
 * Google Drive 파일을 고정 버퍼 스트리밍으로 디스크에 원자적 다운로드하고 SHA-256을 계산한다.
 * 기존 25MB 하드 스킵을 제거하고 `maxFileSizeBytes`(기본 256 MiB) 상한과 TokenBucket을 적용한다.
 */
export async function downloadDriveFileToPath(input: {
  readonly accessToken: string;
  readonly fileId: string;
  readonly destPath: string;
  readonly maxFileSizeBytes?: number;
  readonly downloadLimitMbps?: number;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<{ readonly bytesWritten: number; readonly sha256: string }> {
  const fetcher = input.fetcher ?? fetch;
  const maxBytes = input.maxFileSizeBytes ?? DEFAULT_MIRROR_MAX_FILE_BYTES;
  const res = await fetchWithRetry(
    fetcher,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${input.accessToken}` } },
    input.signal,
  );
  if (!res.ok) {
    throw new Error(`Google Drive 파일 다운로드 실패 (${res.status}): ${input.fileId}`);
  }

  NodeFs.mkdirSync(NodePath.dirname(input.destPath), { recursive: true });
  const tmpPath = `${input.destPath}.${NodeCrypto.randomUUID().slice(0, 8)}.tmp`;
  const hasher = NodeCrypto.createHash("sha256");
  const bucket =
    input.downloadLimitMbps && input.downloadLimitMbps > 0
      ? new TokenBucket({ bytesPerSecond: mbpsToBytesPerSec(input.downloadLimitMbps) })
      : null;

  let bytesWritten = 0;
  try {
    if (res.body) {
      const ws = NodeFs.createWriteStream(tmpPath, { highWaterMark: 256 * 1024 });
      const nodeReadable = Readable.fromWeb(res.body as unknown as NodeWebReadableStream);
      try {
        for await (const raw of nodeReadable) {
          if (input.signal?.aborted) {
            throw new Error(`다운로드 중단됨: ${String(input.signal.reason ?? "aborted")}`);
          }
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          bytesWritten += chunk.byteLength;
          if (maxBytes > 0 && bytesWritten > maxBytes) {
            throw new Error(`다운로드 파일 크기가 허용 상한(${maxBytes} B)을 초과했습니다.`);
          }
          if (bucket) {
            await bucket.consume(chunk.byteLength, input.signal);
          }
          hasher.update(chunk);
          if (!ws.write(chunk)) {
            await new Promise<void>((resolve, reject) => {
              ws.once("drain", resolve);
              ws.once("error", reject);
            });
          }
        }
        await new Promise<void>((resolve, reject) => {
          ws.end(() => resolve());
          ws.once("error", reject);
        });
      } catch (err) {
        nodeReadable.destroy();
        ws.destroy();
        throw err;
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      bytesWritten = buf.byteLength;
      if (maxBytes > 0 && bytesWritten > maxBytes) {
        throw new Error(`다운로드 파일 크기가 허용 상한(${maxBytes} B)을 초과했습니다.`);
      }
      hasher.update(buf);
      NodeFs.writeFileSync(tmpPath, buf);
    }

    if (NodeFs.existsSync(input.destPath)) {
      NodeFs.rmSync(input.destPath, { force: true });
    }
    NodeFs.renameSync(tmpPath, input.destPath);
    return { bytesWritten, sha256: hasher.digest("hex") };
  } finally {
    if (NodeFs.existsSync(tmpPath)) {
      try {
        NodeFs.rmSync(tmpPath, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

export async function downloadKnowledgeMirrorFromGoogleDriveApi(
  creds: GdriveOAuthCredentials,
  knowledgeFolderName: string,
  opts?: {
    readonly fetcher?: typeof fetch;
    readonly maxFileSizeBytes?: number;
    readonly signal?: AbortSignal;
  },
): Promise<ReadonlyArray<DriveMirrorItem>> {
  const fetcher = opts?.fetcher ?? fetch;
  const maxBytes = opts?.maxFileSizeBytes ?? DEFAULT_MIRROR_MAX_FILE_BYTES;
  const accessToken = await exchangeRefreshTokenForAccessToken(creds, fetcher);
  const rootFolderId = await ensureGdriveFolderPath({
    accessToken,
    folderSegments: [knowledgeFolderName],
    fetcher,
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  const listed = await listDriveFolderRecursive({
    accessToken,
    rootFolderId,
    fetcher,
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });

  const items: DriveMirrorItem[] = [];
  for (const file of listed.files) {
    if (maxBytes > 0 && file.sizeBytes > maxBytes) continue;
    const dlRes = await fetchWithRetry(
      fetcher,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      opts?.signal,
    );
    if (!dlRes.ok) continue;
    const arr = await dlRes.arrayBuffer();
    items.push({
      objectId: file.id,
      remoteName: file.relativePath,
      content: Buffer.from(arr),
    });
  }
  return items;
}

/**
 * 로컬 지식 폴더의 원본 파일을 로컬 Google Drive 마운트 폴더(`T3-Knowledge/<폴더명>/...`)에
 * 스트리밍·원자적으로 복사한다(한글 파일명·하위 폴더 구조 보존, 롤링 삭제 없음).
 */
export async function copyKnowledgeFileToLocalDriveFolder(
  rootDir: string,
  knowledgeFolderName: string,
  input: {
    readonly subFolder: string;
    readonly fileName: string;
    readonly filePath: string;
    readonly uploadLimitMbps?: number;
    readonly getUploadLimitMbps?: () => number;
    readonly signal?: AbortSignal;
  },
): Promise<{ readonly destinationPath: string; readonly bytesCopied: number }> {
  const safeRoot = sanitizeKnowledgePathSegment(knowledgeFolderName);
  const safeSubParts = input.subFolder
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..")
    .map(sanitizeKnowledgePathSegment);
  const safeName = sanitizeKnowledgePathSegment(input.fileName);
  const targetDir = NodePath.join(rootDir, safeRoot, ...safeSubParts);
  const destPath = NodePath.join(targetDir, safeName);
  NodeFs.mkdirSync(targetDir, { recursive: true });
  const tmpPath = `${destPath}.${NodeCrypto.randomUUID().slice(0, 8)}.tmp`;

  const bucket = input.getUploadLimitMbps
    ? new TokenBucket({
        bytesPerSecond: mbpsToBytesPerSec(input.getUploadLimitMbps()),
        getBytesPerSecond: () => mbpsToBytesPerSec(input.getUploadLimitMbps!()),
      })
    : input.uploadLimitMbps && input.uploadLimitMbps > 0
      ? new TokenBucket({ bytesPerSecond: mbpsToBytesPerSec(input.uploadLimitMbps) })
      : null;

  let bytesCopied = 0;
  try {
    const rs = NodeFs.createReadStream(input.filePath, { highWaterMark: 256 * 1024 });
    const ws = NodeFs.createWriteStream(tmpPath, { highWaterMark: 256 * 1024 });
    try {
      for await (const raw of rs) {
        if (input.signal?.aborted) {
          throw new Error(`지식 파일 복사 일시정지됨: ${String(input.signal.reason ?? "aborted")}`);
        }
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        bytesCopied += chunk.byteLength;
        if (bucket) {
          await bucket.consume(chunk.byteLength, input.signal);
        }
        if (!ws.write(chunk)) {
          await new Promise<void>((res, rej) => {
            ws.once("drain", res);
            ws.once("error", rej);
          });
        }
      }
      await new Promise<void>((res, rej) => {
        ws.end(() => res());
        ws.once("error", rej);
      });
    } catch (err) {
      rs.destroy();
      ws.destroy();
      throw err;
    }
    if (NodeFs.existsSync(destPath)) NodeFs.rmSync(destPath, { force: true });
    NodeFs.renameSync(tmpPath, destPath);
    return { destinationPath: destPath, bytesCopied };
  } finally {
    if (NodeFs.existsSync(tmpPath)) {
      try {
        NodeFs.rmSync(tmpPath, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

async function ensureGdriveFolderPathPreserveUnicode(input: {
  readonly accessToken: string;
  readonly folderSegments: ReadonlyArray<string>;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const fetcher = input.fetcher ?? fetch;
  let parentId: string | undefined;
  for (const rawSeg of input.folderSegments) {
    const folderName = sanitizeKnowledgePathSegment(rawSeg);
    const escaped = folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const qParts = [`name = '${escaped}'`, `mimeType = '${GOOGLE_FOLDER_MIME}'`, "trashed = false"];
    if (parentId) qParts.push(`'${parentId}' in parents`);
    const queryUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qParts.join(" and "))}&fields=files(id,name)&pageSize=1`;
    const searchRes = await fetchWithRetry(
      fetcher,
      queryUrl,
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
      input.signal,
    );
    if (!searchRes.ok) {
      throw new Error(`Google Drive 지식 폴더 조회 실패 (${searchRes.status})`);
    }
    const found = (await searchRes.json()) as {
      readonly files?: ReadonlyArray<{ readonly id: string }>;
    };
    if (found.files?.[0]?.id) {
      parentId = found.files[0].id;
      continue;
    }
    const createRes = await fetchWithRetry(
      fetcher,
      "https://www.googleapis.com/drive/v3/files?fields=id",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: folderName,
          mimeType: GOOGLE_FOLDER_MIME,
          ...(parentId ? { parents: [parentId] } : {}),
        }),
      },
      input.signal,
    );
    if (!createRes.ok) {
      throw new Error(`Google Drive 지식 폴더 생성 실패 (${createRes.status})`);
    }
    parentId = ((await createRes.json()) as { readonly id: string }).id;
  }
  if (!parentId) {
    throw new Error("유효한 Google Drive 지식 폴더 경로가 지정되지 않았습니다.");
  }
  return parentId;
}

/**
 * 로컬 지식 파일을 Google Drive `T3-Knowledge/<폴더명>/...`에 원본 파일 그대로(평문) 업로드한다.
 * 동일 폴더에 동일 파일명이 이미 있으면 PATCH로 제자리 갱신해 중복 파일 생성을 방지한다.
 */
export async function uploadKnowledgeFileToGoogleDriveApi(
  creds: GdriveOAuthCredentials,
  knowledgeFolderName: string,
  input: {
    readonly subFolder: string;
    readonly fileName: string;
    readonly filePath: string;
    readonly uploadLimitMbps?: number;
    readonly getUploadLimitMbps?: () => number;
    readonly chunkSizeBytes?: number;
    readonly accessToken?: string;
    readonly onChunkUploaded?: (bytesUploaded: number) => Promise<void> | void;
    readonly fetcher?: typeof fetch;
    readonly signal?: AbortSignal;
  },
): Promise<{
  readonly destinationPath: string;
  readonly fileId: string;
  readonly updatedExisting: boolean;
  readonly bytesUploaded: number;
}> {
  const fetcher = input.fetcher ?? fetch;
  const accessToken =
    input.accessToken || (await exchangeRefreshTokenForAccessToken(creds, fetcher));
  const safeSubParts = input.subFolder
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..")
    .map(sanitizeKnowledgePathSegment);
  const safeName = sanitizeKnowledgePathSegment(input.fileName);
  const parentId = await ensureGdriveFolderPathPreserveUnicode({
    accessToken,
    folderSegments: [knowledgeFolderName, ...safeSubParts],
    fetcher,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  // 동일 폴더 내 기존 파일 존재 여부 확인 (있으면 PATCH 제자리 갱신)
  const escaped = safeName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const existingQ = `name = '${escaped}' and '${parentId}' in parents and trashed = false and mimeType != '${GOOGLE_FOLDER_MIME}'`;
  const existingRes = await fetchWithRetry(
    fetcher,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(existingQ)}&fields=files(id,name)&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    input.signal,
  );
  let existingFileId: string | null = null;
  if (existingRes.ok) {
    const existingData = (await existingRes.json()) as {
      readonly files?: ReadonlyArray<{ readonly id: string }>;
    };
    existingFileId = existingData.files?.[0]?.id ?? null;
  }

  const stat = await NodeFs.promises.stat(input.filePath);
  const totalBytes = stat.size;
  const mimeType = guessMimeTypeForKnowledgeFile(safeName);
  const rawChunk = input.chunkSizeBytes ?? 2 * 1024 * 1024;
  const chunkSize = Math.max(256 * 1024, Math.floor(rawChunk / (256 * 1024)) * (256 * 1024));
  const bucket = input.getUploadLimitMbps
    ? new TokenBucket({
        bytesPerSecond: mbpsToBytesPerSec(input.getUploadLimitMbps()),
        getBytesPerSecond: () => mbpsToBytesPerSec(input.getUploadLimitMbps!()),
      })
    : input.uploadLimitMbps && input.uploadLimitMbps > 0
      ? new TokenBucket({ bytesPerSecond: mbpsToBytesPerSec(input.uploadLimitMbps) })
      : null;

  const initUrl = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=resumable&fields=id,name`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name";
  const initRes = await fetchWithRetry(
    fetcher,
    initUrl,
    {
      method: existingFileId ? "PATCH" : "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(totalBytes),
      },
      body: JSON.stringify(
        existingFileId
          ? { name: safeName }
          : {
              name: safeName,
              parents: [parentId],
            },
      ),
    },
    input.signal,
  );
  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => "");
    if (isGoogleDriveDailyUploadQuotaResponse(initRes.status, errText)) {
      throw new DriveUploadQuotaExceededError({
        kind: "remote_quota_exceeded",
        retryAfterMs: Date.now() + REMOTE_QUOTA_COOLDOWN_MS,
        detail: errText,
      });
    }
    throw new Error(
      `Google Drive 지식 파일 업로드 세션 시작 실패 (${initRes.status}): ${errText.slice(0, 200)}`,
    );
  }
  const sessionUri = initRes.headers.get("location");
  if (!sessionUri) {
    throw new Error("Google Drive 지식 업로드 Location URL을 받지 못했습니다.");
  }

  let uploadedFile: { readonly id: string; readonly name: string } | null = null;
  let activeSessionUri = sessionUri;
  if (totalBytes === 0) {
    const putRes = await fetchWithRetry(
      fetcher,
      activeSessionUri,
      {
        method: "PUT",
        redirect: "manual",
        headers: {
          "Content-Type": mimeType,
        },
      },
      input.signal,
      5,
      `지식 빈 파일 업로드(${safeName})`,
    );
    if (!putRes.ok) {
      const errText = await putRes.text().catch(() => "");
      if (isGoogleDriveDailyUploadQuotaResponse(putRes.status, errText)) {
        throw new DriveUploadQuotaExceededError({
          kind: "remote_quota_exceeded",
          retryAfterMs: Date.now() + REMOTE_QUOTA_COOLDOWN_MS,
          detail: errText,
        });
      }
      throw new Error(`Google Drive 빈 지식 파일 업로드 실패 (${putRes.status})`);
    }
    uploadedFile = (await putRes.json()) as { readonly id: string; readonly name: string };
  } else {
    const fh = await NodeFs.promises.open(input.filePath, "r");
    const chunkBuf = Buffer.allocUnsafe(Math.min(chunkSize, totalBytes));
    let offset = 0;
    try {
      while (!uploadedFile) {
        if (input.signal?.aborted) {
          throw new Error(
            `지식 파일 업로드 일시정지됨: ${String(input.signal.reason ?? "aborted")}`,
          );
        }
        const toRead = Math.min(chunkSize, totalBytes - offset);
        const { bytesRead } = await fh.read(chunkBuf, 0, toRead, offset);
        if (bytesRead <= 0) {
          throw new Error(`지식 파일 읽기 조기 종료 (${offset}/${totalBytes})`);
        }
        if (bucket) {
          await bucket.consume(bytesRead, input.signal);
        }
        const endByte = offset + bytesRead - 1;
        const slice = chunkBuf.subarray(0, bytesRead);
        const putRes = await fetchWithRetry(
          fetcher,
          activeSessionUri,
          {
            method: "PUT",
            redirect: "manual",
            headers: {
              "Content-Type": mimeType,
              "Content-Range": `bytes ${offset}-${endByte}/${totalBytes}`,
            },
            body: new Uint8Array(slice),
          },
          input.signal,
          5,
          `지식 청크 업로드(${safeName} ${offset}-${endByte}/${totalBytes})`,
        );
        if (putRes.status === 200 || putRes.status === 201) {
          uploadedFile = (await putRes.json()) as { readonly id: string; readonly name: string };
          await input.onChunkUploaded?.(bytesRead);
          break;
        }
        if (putRes.status === 308) {
          const nextLoc = putRes.headers.get("location");
          if (nextLoc) activeSessionUri = nextLoc;
          const confirmed = parseResumeRangeOffset(putRes.headers.get("range"));
          const nextOffset = confirmed ?? offset + bytesRead;
          const delta = Math.max(0, nextOffset - offset);
          offset = nextOffset;
          if (delta > 0) {
            await input.onChunkUploaded?.(delta);
          }
          continue;
        }
        const errText = await putRes.text().catch(() => "");
        if (isGoogleDriveDailyUploadQuotaResponse(putRes.status, errText)) {
          throw new DriveUploadQuotaExceededError({
            kind: "remote_quota_exceeded",
            retryAfterMs: Date.now() + REMOTE_QUOTA_COOLDOWN_MS,
            detail: errText,
          });
        }
        throw new Error(
          `Google Drive 지식 파일 청크 업로드 실패 (${putRes.status}): ${errText.slice(0, 200)}`,
        );
      }
    } finally {
      await fh.close();
    }
  }

  const relDisplay = [...safeSubParts, uploadedFile.name].join("/");
  return {
    destinationPath: `gdrive://${sanitizeKnowledgePathSegment(knowledgeFolderName)}/${relDisplay} (${uploadedFile.id})`,
    fileId: uploadedFile.id,
    updatedExisting: existingFileId !== null,
    bytesUploaded: totalBytes,
  };
}
