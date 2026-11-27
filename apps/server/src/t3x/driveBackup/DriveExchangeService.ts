// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetch:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import {
  DEFAULT_MIRROR_MAX_FILE_BYTES,
  downloadDriveFileToPath,
  ensureGdriveFolderPath,
  exchangeRefreshTokenForAccessToken,
  fetchDriveChanges,
  getDriveChangesStartPageToken,
  listDriveFolderRecursive,
  uploadFileResumableToGoogleDriveApi,
  type DriveRemoteFileMeta,
  type GdriveOAuthCredentials,
} from "./DriveTransportAdapter.ts";

/**
 * 6단계: Google Drive PC ↔ VPS 파일 교환소(append-only) & 지식 미러 증분 엔진.
 *
 * 핵심 불변 규칙:
 * 1. SQLite 원본 파일(`.sqlite`, `.sqlite3`, `.db`, `.sqlite-wal`, `.sqlite-shm`, `.sqlite-journal`)은
 *    교환소에 업로드·다운로드·배치를 코드 레벨에서 절대 금지한다.
 * 2. 고정 폴더 규약: `exchange/<writer>/outbox`, `exchange/<writer>/inbox`, `exchange/<consumer>/acks`.
 * 3. Append-only 불변 세그먼트: `<writer>_YYYYMMDDTHH_<uuid6>.jsonl.gz` + `.manifest.json`.
 *    동일 파일명이 이미 존재하면 절대 덮어쓰지 않고 거부한다.
 * 4. 처리 완료 표시(ACK)는 원본 파일을 수정하지 않고 `exchange/<consumer>/acks/<segmentId>.ack.json`
 *    별도 파일로만 기록한다.
 */

const FORBIDDEN_EXCHANGE_EXTENSIONS = [
  ".sqlite",
  ".sqlite3",
  ".db",
  ".sqlite-wal",
  ".sqlite-shm",
  ".sqlite-journal",
] as const;

export class ExchangeForbiddenFileError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(
      `교환소에는 SQLite 원본/잠금 파일(${filePath})을 배치할 수 없습니다. 불변 JSONL.gz 세그먼트와 매니페스트만 허용됩니다.`,
    );
    this.name = "ExchangeForbiddenFileError";
    this.filePath = filePath;
  }
}

export class ExchangeOverwriteError extends Error {
  readonly targetName: string;
  constructor(targetName: string) {
    super(`교환소는 append-only 불변 저장소입니다. 기존 파일(${targetName})을 덮어쓸 수 없습니다.`);
    this.name = "ExchangeOverwriteError";
    this.targetName = targetName;
  }
}

export function isForbiddenExchangeFile(fileNameOrPath: string): boolean {
  const lower = fileNameOrPath.trim().toLowerCase();
  return FORBIDDEN_EXCHANGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function assertExchangeFileAllowed(fileNameOrPath: string): void {
  if (isForbiddenExchangeFile(fileNameOrPath)) {
    throw new ExchangeForbiddenFileError(fileNameOrPath);
  }
}

export function validateExchangeActorName(actor: string): string {
  const trimmed = actor.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(trimmed)) {
    throw new Error(
      `유효하지 않은 교환소 주체 이름입니다: '${actor}' (영문 소문자·숫자·-_ 1~32자)`,
    );
  }
  return trimmed;
}

export function resolveExchangeSubFolder(actor: string, box: "outbox" | "inbox" | "acks"): string {
  const safeActor = validateExchangeActorName(actor);
  return `exchange/${safeActor}/${box}`;
}

export function buildImmutableSegmentId(writer: string, now: Date = new Date()): string {
  const safeWriter = validateExchangeActorName(writer);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}`;
  const suffix = NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 6);
  return `${safeWriter}_${stamp}_${suffix}`;
}

export interface ExchangeSegmentManifest {
  readonly schemaVersion: 1;
  readonly segmentId: string;
  readonly writer: string;
  readonly createdAtIso: string;
  readonly dataFileName: string;
  readonly recordCount: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly gzipSha256: string;
  readonly source: string;
}

export interface ExchangeAckRecord {
  readonly schemaVersion: 1;
  readonly segmentId: string;
  readonly consumer: string;
  readonly status: "processed" | "rejected";
  readonly processedAtIso: string;
  readonly verifiedSha256: string | null;
  readonly note?: string;
}

export type ExchangeTransport =
  | {
      readonly mode: "local";
      readonly rootDir: string;
      readonly exchangeRootName?: string;
    }
  | {
      readonly mode: "gdrive_api";
      readonly creds: GdriveOAuthCredentials;
      readonly exchangeRootName?: string;
      readonly uploadLimitMbps?: number;
      readonly fetcher?: typeof fetch;
    };

function sha256Buf(buf: Buffer): string {
  return NodeCrypto.createHash("sha256").update(buf).digest("hex");
}

function localExchangeDir(
  transport: Extract<ExchangeTransport, { readonly mode: "local" }>,
  subFolder: string,
): string {
  const rootName = transport.exchangeRootName ?? "T3-Backup";
  return NodePath.join(transport.rootDir, rootName, ...subFolder.split("/").filter(Boolean));
}

async function checkRemoteFileExists(input: {
  readonly accessToken: string;
  readonly parentId: string;
  readonly fileName: string;
  readonly fetcher: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const escaped = input.fileName.replace(/'/g, "\\'");
  const q = `name = '${escaped}' and '${input.parentId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`;
  const res = await input.fetcher(url, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { readonly files?: ReadonlyArray<{ readonly id: string }> };
  return (data.files?.length ?? 0) > 0;
}

async function writeImmutableExchangeFile(input: {
  readonly transport: ExchangeTransport;
  readonly subFolder: string;
  readonly fileName: string;
  readonly content: Buffer;
  readonly stagingDir: string;
  readonly signal?: AbortSignal;
}): Promise<string> {
  assertExchangeFileAllowed(input.fileName);

  if (input.transport.mode === "local") {
    const dir = localExchangeDir(input.transport, input.subFolder);
    NodeFs.mkdirSync(dir, { recursive: true });
    const destPath = NodePath.join(dir, input.fileName);
    if (NodeFs.existsSync(destPath)) {
      throw new ExchangeOverwriteError(`${input.subFolder}/${input.fileName}`);
    }
    const tmpPath = `${destPath}.${NodeCrypto.randomUUID().slice(0, 8)}.tmp`;
    try {
      NodeFs.writeFileSync(tmpPath, input.content);
      // wx semantic check immediately before rename
      if (NodeFs.existsSync(destPath)) {
        throw new ExchangeOverwriteError(`${input.subFolder}/${input.fileName}`);
      }
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
    return destPath;
  }

  const fetcher = input.transport.fetcher ?? fetch;
  const accessToken = await exchangeRefreshTokenForAccessToken(input.transport.creds, fetcher);
  const rootName = input.transport.exchangeRootName ?? "T3-Backup";
  const parentId = await ensureGdriveFolderPath({
    accessToken,
    folderSegments: [rootName, ...input.subFolder.split("/").filter(Boolean)],
    fetcher,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const exists = await checkRemoteFileExists({
    accessToken,
    parentId,
    fileName: input.fileName,
    fetcher,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (exists) {
    throw new ExchangeOverwriteError(`${input.subFolder}/${input.fileName}`);
  }

  NodeFs.mkdirSync(input.stagingDir, { recursive: true });
  const tmpFile = NodePath.join(
    input.stagingDir,
    `exch-${NodeCrypto.randomUUID().slice(0, 8)}-${input.fileName}`,
  );
  try {
    NodeFs.writeFileSync(tmpFile, input.content);
    const uploaded = await uploadFileResumableToGoogleDriveApi(input.transport.creds, rootName, {
      subFolder: input.subFolder,
      fileName: input.fileName,
      filePath: tmpFile,
      retentionCount: 999_999, // 교환소 세그먼트는 자동 롤링 삭제 금지 (불변 보관)
      ...(input.transport.uploadLimitMbps !== undefined
        ? { uploadLimitMbps: input.transport.uploadLimitMbps }
        : {}),
      fetcher,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return uploaded.destinationPath;
  } finally {
    if (NodeFs.existsSync(tmpFile)) {
      try {
        NodeFs.rmSync(tmpFile, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 불변(append-only) 시간 단위 세그먼트(`.jsonl.gz` + `.manifest.json`)를
 * `exchange/<writer>/<box>`에 발행한다. 기존 파일 덮어쓰기와 SQLite 파일 배치는 거부된다.
 */
export async function publishExchangeSegment(input: {
  readonly transport: ExchangeTransport;
  readonly writer: string;
  readonly box?: "outbox" | "inbox";
  readonly records: ReadonlyArray<unknown>;
  readonly source: string;
  readonly stagingDir: string;
  readonly explicitSegmentId?: string;
  readonly now?: Date;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly manifest: ExchangeSegmentManifest;
  readonly dataDestination: string;
  readonly manifestDestination: string;
}> {
  const writer = validateExchangeActorName(input.writer);
  const box = input.box ?? "outbox";
  const subFolder = resolveExchangeSubFolder(writer, box);
  const now = input.now ?? new Date();
  const segmentId = input.explicitSegmentId?.trim() || buildImmutableSegmentId(writer, now);
  assertExchangeFileAllowed(segmentId);

  const dataFileName = `${segmentId}.jsonl.gz`;
  const manifestFileName = `${segmentId}.manifest.json`;
  assertExchangeFileAllowed(dataFileName);
  assertExchangeFileAllowed(manifestFileName);

  const jsonlText =
    input.records.map((rec) => JSON.stringify(rec)).join("\n") +
    (input.records.length > 0 ? "\n" : "");
  const rawBuf = Buffer.from(jsonlText, "utf8");
  const gzipBuf = NodeZlib.gzipSync(rawBuf, { level: 6 });

  const manifest: ExchangeSegmentManifest = {
    schemaVersion: 1,
    segmentId,
    writer,
    createdAtIso: now.toISOString(),
    dataFileName,
    recordCount: input.records.length,
    rawBytes: rawBuf.byteLength,
    gzipBytes: gzipBuf.byteLength,
    gzipSha256: sha256Buf(gzipBuf),
    source: input.source,
  };
  const manifestBuf = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const dataDestination = await writeImmutableExchangeFile({
    transport: input.transport,
    subFolder,
    fileName: dataFileName,
    content: gzipBuf,
    stagingDir: input.stagingDir,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const manifestDestination = await writeImmutableExchangeFile({
    transport: input.transport,
    subFolder,
    fileName: manifestFileName,
    content: manifestBuf,
    stagingDir: input.stagingDir,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return { manifest, dataDestination, manifestDestination };
}

/**
 * 소비자가 세그먼트 처리를 완료했음을 원본 수정 없이 별도 ACK 마커 파일
 * (`exchange/<consumer>/acks/<segmentId>.ack.json`)로 기록한다.
 */
export async function writeExchangeAck(input: {
  readonly transport: ExchangeTransport;
  readonly consumer: string;
  readonly segmentId: string;
  readonly status: "processed" | "rejected";
  readonly verifiedSha256: string | null;
  readonly note?: string;
  readonly stagingDir: string;
  readonly now?: Date;
  readonly signal?: AbortSignal;
}): Promise<{ readonly ack: ExchangeAckRecord; readonly destination: string }> {
  const consumer = validateExchangeActorName(input.consumer);
  assertExchangeFileAllowed(input.segmentId);
  const subFolder = resolveExchangeSubFolder(consumer, "acks");
  const ackFileName = `${input.segmentId}.ack.json`;
  const ack: ExchangeAckRecord = {
    schemaVersion: 1,
    segmentId: input.segmentId,
    consumer,
    status: input.status,
    processedAtIso: (input.now ?? new Date()).toISOString(),
    verifiedSha256: input.verifiedSha256,
    ...(input.note ? { note: input.note } : {}),
  };
  const destination = await writeImmutableExchangeFile({
    transport: input.transport,
    subFolder,
    fileName: ackFileName,
    content: Buffer.from(`${JSON.stringify(ack, null, 2)}\n`, "utf8"),
    stagingDir: input.stagingDir,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { ack, destination };
}

export interface ConsumedExchangeSegment {
  readonly manifest: ExchangeSegmentManifest;
  readonly records: ReadonlyArray<unknown>;
  readonly ackDestination: string;
}

/**
 * 상대방 `exchange/<peerWriter>/outbox`에서 아직 ACK되지 않은 불변 세그먼트를 조회·무결성 검증·소비하고,
 * 별도 `exchange/<consumer>/acks/<segmentId>.ack.json` 마커를 기록한다.
 * `.sqlite`/`.db` 등 금지 확장자 파일이 발견되면 다운로드하지 않고 차단 카운트에 기록한다.
 */
export async function consumeExchangeOutbox(input: {
  readonly transport: ExchangeTransport;
  readonly peerWriter: string;
  readonly consumer: string;
  readonly stagingDir: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly consumed: ReadonlyArray<ConsumedExchangeSegment>;
  readonly skippedAlreadyAcked: number;
  readonly blockedForbiddenFiles: ReadonlyArray<string>;
}> {
  const peerWriter = validateExchangeActorName(input.peerWriter);
  const consumer = validateExchangeActorName(input.consumer);
  const outboxSub = resolveExchangeSubFolder(peerWriter, "outbox");
  const acksSub = resolveExchangeSubFolder(consumer, "acks");

  const consumed: ConsumedExchangeSegment[] = [];
  const blockedForbiddenFiles: string[] = [];
  let skippedAlreadyAcked = 0;

  if (input.transport.mode === "local") {
    const outboxDir = localExchangeDir(input.transport, outboxSub);
    const acksDir = localExchangeDir(input.transport, acksSub);
    if (!NodeFs.existsSync(outboxDir)) {
      return { consumed, skippedAlreadyAcked, blockedForbiddenFiles };
    }
    const existingAcks = new Set<string>(
      NodeFs.existsSync(acksDir)
        ? NodeFs.readdirSync(acksDir).filter((f) => f.endsWith(".ack.json"))
        : [],
    );
    const outboxEntries = NodeFs.readdirSync(outboxDir).sort();
    for (const name of outboxEntries) {
      if (isForbiddenExchangeFile(name)) {
        blockedForbiddenFiles.push(name);
        continue;
      }
      if (!name.endsWith(".manifest.json")) continue;
      const manifestPath = NodePath.join(outboxDir, name);
      const manifest = JSON.parse(
        NodeFs.readFileSync(manifestPath, "utf8"),
      ) as ExchangeSegmentManifest;
      if (isForbiddenExchangeFile(manifest.dataFileName)) {
        blockedForbiddenFiles.push(manifest.dataFileName);
        continue;
      }
      if (existingAcks.has(`${manifest.segmentId}.ack.json`)) {
        skippedAlreadyAcked += 1;
        continue;
      }
      const dataPath = NodePath.join(outboxDir, manifest.dataFileName);
      if (!NodeFs.existsSync(dataPath)) continue;
      const gzipBuf = NodeFs.readFileSync(dataPath);
      const actualSha = sha256Buf(gzipBuf);
      if (actualSha !== manifest.gzipSha256) {
        throw new Error(`교환소 세그먼트 해시 불일치 (${manifest.segmentId})`);
      }
      const rawText = NodeZlib.gunzipSync(gzipBuf).toString("utf8");
      const records = rawText
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown);
      const { destination } = await writeExchangeAck({
        transport: input.transport,
        consumer,
        segmentId: manifest.segmentId,
        status: "processed",
        verifiedSha256: actualSha,
        stagingDir: input.stagingDir,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      consumed.push({ manifest, records, ackDestination: destination });
    }
    return { consumed, skippedAlreadyAcked, blockedForbiddenFiles };
  }

  const fetcher = input.transport.fetcher ?? fetch;
  const accessToken = await exchangeRefreshTokenForAccessToken(input.transport.creds, fetcher);
  const rootName = input.transport.exchangeRootName ?? "T3-Backup";

  const outboxFolderId = await ensureGdriveFolderPath({
    accessToken,
    folderSegments: [rootName, ...outboxSub.split("/").filter(Boolean)],
    fetcher,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const acksFolderId = await ensureGdriveFolderPath({
    accessToken,
    folderSegments: [rootName, ...acksSub.split("/").filter(Boolean)],
    fetcher,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const [outboxList, acksList] = await Promise.all([
    listDriveFolderRecursive({
      accessToken,
      rootFolderId: outboxFolderId,
      fetcher,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
    listDriveFolderRecursive({
      accessToken,
      rootFolderId: acksFolderId,
      fetcher,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  ]);

  const existingAcks = new Set(acksList.files.map((f) => f.name));
  const filesByName = new Map(outboxList.files.map((f) => [f.name, f]));

  NodeFs.mkdirSync(input.stagingDir, { recursive: true });
  for (const file of outboxList.files) {
    if (isForbiddenExchangeFile(file.name)) {
      blockedForbiddenFiles.push(file.name);
      continue;
    }
    if (!file.name.endsWith(".manifest.json")) continue;

    const tmpManifest = NodePath.join(
      input.stagingDir,
      `dl-${NodeCrypto.randomUUID().slice(0, 8)}-${file.name}`,
    );
    try {
      await downloadDriveFileToPath({
        accessToken,
        fileId: file.id,
        destPath: tmpManifest,
        fetcher,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const manifest = JSON.parse(
        NodeFs.readFileSync(tmpManifest, "utf8"),
      ) as ExchangeSegmentManifest;
      if (isForbiddenExchangeFile(manifest.dataFileName)) {
        blockedForbiddenFiles.push(manifest.dataFileName);
        continue;
      }
      if (existingAcks.has(`${manifest.segmentId}.ack.json`)) {
        skippedAlreadyAcked += 1;
        continue;
      }
      const dataFile = filesByName.get(manifest.dataFileName);
      if (!dataFile) continue;

      const tmpData = NodePath.join(
        input.stagingDir,
        `dl-${NodeCrypto.randomUUID().slice(0, 8)}-${dataFile.name}`,
      );
      try {
        const dl = await downloadDriveFileToPath({
          accessToken,
          fileId: dataFile.id,
          destPath: tmpData,
          fetcher,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (dl.sha256 !== manifest.gzipSha256) {
          throw new Error(`교환소 세그먼트 해시 불일치 (${manifest.segmentId})`);
        }
        const rawText = NodeZlib.gunzipSync(NodeFs.readFileSync(tmpData)).toString("utf8");
        const records = rawText
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as unknown);
        const { destination } = await writeExchangeAck({
          transport: input.transport,
          consumer,
          segmentId: manifest.segmentId,
          status: "processed",
          verifiedSha256: dl.sha256,
          stagingDir: input.stagingDir,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        consumed.push({ manifest, records, ackDestination: destination });
      } finally {
        if (NodeFs.existsSync(tmpData)) {
          try {
            NodeFs.rmSync(tmpData, { force: true });
          } catch {
            // ignore
          }
        }
      }
    } finally {
      if (NodeFs.existsSync(tmpManifest)) {
        try {
          NodeFs.rmSync(tmpManifest, { force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  return { consumed, skippedAlreadyAcked, blockedForbiddenFiles };
}

// ---------------------------------------------------------------------------
// 개선된 Google Drive API v3 지식 미러 엔진 (재귀 + 페이징 + 사전 비교 + Changes API)
// ---------------------------------------------------------------------------

export interface ExistingMirrorObjectState {
  readonly objectId: string;
  readonly sha256: string;
  readonly localPath: string;
  readonly sizeBytes: number;
  readonly md5Checksum: string | null;
  readonly modifiedTime: string | null;
}

export interface MirrorPersistedState {
  readonly rootFolderId?: string;
  readonly folderPathById?: Readonly<Record<string, string>>;
}

export interface SyncDriveApiMirrorResult {
  readonly syncedObjects: ReadonlyArray<{
    readonly objectId: string;
    readonly remoteName: string;
    readonly localPath: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly md5Checksum: string | null;
    readonly modifiedTime: string | null;
  }>;
  readonly skippedUnchangedCount: number;
  readonly blockedForbiddenCount: number;
  readonly totalBytes: number;
  readonly nextStartPageToken: string | null;
  readonly nextState: MirrorPersistedState;
  readonly usedChangesApi: boolean;
  readonly downloadsIssued: number;
}

export function isRemoteFileUnchangedBeforeDownload(
  remote: {
    readonly sizeBytes: number;
    readonly md5Checksum: string | null;
    readonly modifiedTime: string | null;
  },
  existing: ExistingMirrorObjectState | undefined,
): boolean {
  if (!existing) return false;
  if (!NodeFs.existsSync(existing.localPath)) return false;
  if (remote.md5Checksum && existing.md5Checksum) {
    return remote.md5Checksum === existing.md5Checksum;
  }
  if (remote.modifiedTime && existing.modifiedTime) {
    return remote.modifiedTime === existing.modifiedTime && remote.sizeBytes === existing.sizeBytes;
  }
  return false;
}

/**
 * Google Drive API v3 지식 미러 동기화:
 * - `startPageToken`이 있고 `!force`이면 Changes API로 변경된 항목만 추출
 * - 최초 동기화·`force`·토큰 만료 시 `listDriveFolderRecursive`로 전체 페이지(`nextPageToken`) + 하위 폴더 재귀 스캔
 * - 다운로드 전 `md5Checksum` / `modifiedTime` 비교로 미변경 파일은 HTTP 요청 0회로 스킵
 * - 25MB 하드 스킵 제거 (기본 256 MiB 스트리밍 다운로드)
 * - `.sqlite` 등 금지 확장자 차단
 */
export async function syncKnowledgeMirrorViaGoogleDriveApi(input: {
  readonly creds: GdriveOAuthCredentials;
  readonly knowledgeFolderName: string;
  readonly mirrorLocalDir: string;
  readonly existingByObjectId: ReadonlyMap<string, ExistingMirrorObjectState>;
  readonly startPageToken: string | null;
  readonly persistedState: MirrorPersistedState | null;
  readonly force?: boolean;
  readonly maxFileSizeBytes?: number;
  readonly downloadLimitMbps?: number;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<SyncDriveApiMirrorResult> {
  const fetcher = input.fetcher ?? fetch;
  const maxBytes = input.maxFileSizeBytes ?? DEFAULT_MIRROR_MAX_FILE_BYTES;
  const accessToken = await exchangeRefreshTokenForAccessToken(input.creds, fetcher);
  const rootFolderId =
    input.persistedState?.rootFolderId ||
    (await ensureGdriveFolderPath({
      accessToken,
      folderSegments: [input.knowledgeFolderName],
      fetcher,
      ...(input.signal ? { signal: input.signal } : {}),
    }));

  let candidates: ReadonlyArray<DriveRemoteFileMeta> = [];
  let folderPathById: Record<string, string> = {
    ...(input.persistedState?.folderPathById ?? {}),
    [rootFolderId]: "",
  };
  let nextStartPageToken: string | null = input.startPageToken;
  let usedChangesApi = false;

  // 1. Changes API 증분 시도 (기존 startPageToken이 있고 force가 아닐 때)
  let needsFullScan =
    Boolean(input.force) || !input.startPageToken || !input.persistedState?.rootFolderId;
  if (!needsFullScan && input.startPageToken) {
    const chRes = await fetchDriveChanges({
      accessToken,
      startPageToken: input.startPageToken,
      fetcher,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (chRes.tokenExpired) {
      needsFullScan = true;
    } else {
      usedChangesApi = true;
      nextStartPageToken = chRes.newStartPageToken;
      const changedFiles: DriveRemoteFileMeta[] = [];
      for (const change of chRes.changes) {
        if (change.removed || !change.file) continue;
        const f = change.file;
        if (f.mimeType === "application/vnd.google-apps.folder") {
          const parentKey = f.parents.find((p) => p in folderPathById);
          if (parentKey !== undefined) {
            const prefix = folderPathById[parentKey] ?? "";
            folderPathById[f.id] = prefix ? `${prefix}/${f.name}` : f.name;
          }
          continue;
        }
        if (f.mimeType.startsWith("application/vnd.google-apps.")) continue;
        const parentKey = f.parents.find((p) => p in folderPathById);
        if (parentKey === undefined) continue; // 지식 폴더 밖의 변경은 무시
        const prefix = folderPathById[parentKey] ?? "";
        const cleanName = f.name.replace(/[/\\]/g, "_");
        if (!cleanName || cleanName === "." || cleanName === "..") continue;
        changedFiles.push({
          id: f.id,
          name: cleanName,
          relativePath: prefix ? `${prefix}/${cleanName}` : cleanName,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          md5Checksum: f.md5Checksum,
          modifiedTime: f.modifiedTime,
          parents: f.parents,
        });
      }
      candidates = changedFiles;
    }
  }

  // 2. 전체 재귀 메타 스캔 + 새 startPageToken 확보
  if (needsFullScan) {
    nextStartPageToken = await getDriveChangesStartPageToken({
      accessToken,
      fetcher,
      ...(input.signal ? { signal: input.signal } : {}),
    }).catch(() => null);
    const listed = await listDriveFolderRecursive({
      accessToken,
      rootFolderId,
      fetcher,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    candidates = listed.files;
    folderPathById = { ...listed.folderPathById };
  }

  NodeFs.mkdirSync(input.mirrorLocalDir, { recursive: true });
  const resolvedMirrorRoot = NodePath.resolve(input.mirrorLocalDir);

  const syncedObjects: Array<{
    readonly objectId: string;
    readonly remoteName: string;
    readonly localPath: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly md5Checksum: string | null;
    readonly modifiedTime: string | null;
  }> = [];
  let skippedUnchangedCount = 0;
  let blockedForbiddenCount = 0;
  let totalBytes = 0;
  let downloadsIssued = 0;

  for (const file of candidates) {
    if (isForbiddenExchangeFile(file.name) || isForbiddenExchangeFile(file.relativePath)) {
      blockedForbiddenCount += 1;
      continue;
    }
    if (maxBytes > 0 && file.sizeBytes > maxBytes) {
      continue;
    }

    const safeRel = file.relativePath
      .replace(/\\/g, "/")
      .split("/")
      .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
      .map((seg) => seg.replace(/[<>:"|?*]/g, "_"))
      .join(NodePath.sep);
    if (!safeRel) continue;
    const destPath = NodePath.resolve(input.mirrorLocalDir, safeRel);
    if (!destPath.startsWith(resolvedMirrorRoot)) continue;

    // 다운로드 전 md5Checksum / modifiedTime 사전 비교 -> 미변경 파일 HTTP 0회 스킵!
    const existing = input.existingByObjectId.get(file.id);
    if (!input.force && isRemoteFileUnchangedBeforeDownload(file, existing)) {
      skippedUnchangedCount += 1;
      continue;
    }

    downloadsIssued += 1;
    const dl = await downloadDriveFileToPath({
      accessToken,
      fileId: file.id,
      destPath,
      maxFileSizeBytes: maxBytes,
      ...(input.downloadLimitMbps !== undefined
        ? { downloadLimitMbps: input.downloadLimitMbps }
        : {}),
      fetcher,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    syncedObjects.push({
      objectId: file.id,
      remoteName: file.relativePath,
      localPath: destPath,
      sha256: dl.sha256,
      sizeBytes: dl.bytesWritten,
      md5Checksum: file.md5Checksum,
      modifiedTime: file.modifiedTime,
    });
    totalBytes += dl.bytesWritten;
  }

  return {
    syncedObjects,
    skippedUnchangedCount,
    blockedForbiddenCount,
    totalBytes,
    nextStartPageToken,
    nextState: {
      rootFolderId,
      folderPathById,
    },
    usedChangesApi,
    downloadsIssued,
  };
}
