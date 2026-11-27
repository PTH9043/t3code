// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetch:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

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

export function listLocalKnowledgeMirrorFiles(
  rootDir: string,
  knowledgeFolderName: string,
): ReadonlyArray<DriveMirrorItem> {
  const sourceDir = NodePath.join(rootDir, sanitizeSegment(knowledgeFolderName));
  if (!NodeFs.existsSync(sourceDir)) return [];
  const items: DriveMirrorItem[] = [];
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
          if (stat.size > 25 * 1024 * 1024) continue;
          items.push({
            objectId: `local:${rel}`,
            remoteName: rel,
            content: NodeFs.readFileSync(abs),
          });
        } catch {
          // skip
        }
      }
    }
  };
  walk(sourceDir, "");
  return items;
}

// ---------------------------------------------------------------------------
// Google Drive REST API v3 (OAuth2 Refresh Token -> Resumable / Multipart)
// ---------------------------------------------------------------------------

async function exchangeRefreshTokenForAccessToken(creds: GdriveOAuthCredentials): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Google OAuth2 토큰 갱신 실패 (${res.status}): ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { readonly access_token?: string };
  if (!data.access_token) {
    throw new Error("Google OAuth2 응답에 access_token이 없습니다.");
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

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(input.content.byteLength),
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

export async function downloadKnowledgeMirrorFromGoogleDriveApi(
  creds: GdriveOAuthCredentials,
  knowledgeFolderName: string,
): Promise<ReadonlyArray<DriveMirrorItem>> {
  const accessToken = await exchangeRefreshTokenForAccessToken(creds);
  const folderId = await ensureGdriveFolder(accessToken, knowledgeFolderName);
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`)}&fields=files(id,name,size)&pageSize=100`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    throw new Error(`Google Drive 지식 폴더 목록 조회 실패 (${listRes.status})`);
  }
  const data = (await listRes.json()) as {
    readonly files?: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly size?: string;
    }>;
  };

  const items: DriveMirrorItem[] = [];
  for (const file of data.files ?? []) {
    const sizeNum = Number(file.size ?? 0);
    if (sizeNum > 25 * 1024 * 1024) continue;
    const dlRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!dlRes.ok) continue;
    const arr = await dlRes.arrayBuffer();
    items.push({
      objectId: file.id,
      remoteName: file.name,
      content: Buffer.from(arr),
    });
  }
  return items;
}
