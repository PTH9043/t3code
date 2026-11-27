// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetch:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  assertExchangeFileAllowed,
  consumeExchangeOutbox,
  ExchangeForbiddenFileError,
  ExchangeOverwriteError,
  publishExchangeSegment,
  syncKnowledgeMirrorViaGoogleDriveApi,
  type ExistingMirrorObjectState,
} from "./DriveExchangeService.ts";

interface MockDriveEntry {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly parents: ReadonlyArray<string>;
  readonly content: Buffer;
  readonly md5Checksum: string;
  readonly modifiedTime: string;
}

function md5Hex(buf: Buffer): string {
  return NodeCrypto.createHash("md5").update(buf).digest("hex");
}

function createMockGoogleDriveFetcher(input: { readonly pageSizeLimit?: number }) {
  const entries = new Map<string, MockDriveEntry>();
  const changeLog: Array<{
    readonly tokenNum: number;
    readonly fileId: string;
    readonly removed?: boolean;
  }> = [];
  let tokenCounter = 100;
  let downloadsCount = 0;
  let listPagesCount = 0;

  const addFolder = (id: string, name: string, parentId?: string) => {
    entries.set(id, {
      id,
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
      content: Buffer.alloc(0),
      md5Checksum: "",
      modifiedTime: "2026-11-27T00:00:00.000Z",
    });
  };

  const putFile = (
    id: string,
    name: string,
    parentId: string,
    content: Buffer,
    modifiedTime: string,
    recordChange = false,
  ) => {
    entries.set(id, {
      id,
      name,
      mimeType: "application/octet-stream",
      parents: [parentId],
      content,
      md5Checksum: md5Hex(content),
      modifiedTime,
    });
    if (recordChange) {
      tokenCounter += 1;
      changeLog.push({ tokenNum: tokenCounter, fileId: id });
    }
  };

  const pageCap = input.pageSizeLimit ?? 100;

  const fetcher = (async (rawUrl: string | URL | Request) => {
    const urlStr =
      typeof rawUrl === "string" ? rawUrl : rawUrl instanceof URL ? rawUrl.href : rawUrl.url;
    const url = new URL(urlStr);

    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
      return new Response(JSON.stringify({ access_token: "mock-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/drive/v3/changes/startPageToken") {
      return new Response(JSON.stringify({ startPageToken: String(tokenCounter) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/drive/v3/changes") {
      const since = Number(url.searchParams.get("pageToken") ?? "0");
      const matching = changeLog.filter((c) => c.tokenNum > since);
      return new Response(
        JSON.stringify({
          newStartPageToken: String(tokenCounter),
          changes: matching.map((c) => {
            const e = entries.get(c.fileId);
            return {
              fileId: c.fileId,
              removed: Boolean(c.removed),
              file: e
                ? {
                    id: e.id,
                    name: e.name,
                    mimeType: e.mimeType,
                    size: String(e.content.byteLength),
                    md5Checksum: e.md5Checksum,
                    modifiedTime: e.modifiedTime,
                    parents: e.parents,
                    trashed: false,
                  }
                : undefined,
            };
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.pathname.startsWith("/drive/v3/files/") && url.searchParams.get("alt") === "media") {
      const fileId = decodeURIComponent(url.pathname.slice("/drive/v3/files/".length));
      const entry = entries.get(fileId);
      if (!entry) return new Response("Not Found", { status: 404 });
      downloadsCount += 1;
      return new Response(new Uint8Array(entry.content), {
        status: 200,
        headers: { "content-type": entry.mimeType },
      });
    }

    if (url.pathname === "/drive/v3/files") {
      const q = url.searchParams.get("q") ?? "";
      // Folder lookup by name
      const nameMatch = /name = '([^']+)'/.exec(q);
      const parentMatch = /'([^']+)' in parents/.exec(q);
      if (nameMatch?.[1]) {
        const targetName = nameMatch[1];
        const parentId = parentMatch?.[1];
        const found = [...entries.values()].filter(
          (e) => e.name === targetName && (!parentId || e.parents.includes(parentId)),
        );
        return new Response(
          JSON.stringify({
            files: found.map((e) => ({ id: e.id, name: e.name })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Children listing with pagination
      if (parentMatch?.[1]) {
        listPagesCount += 1;
        const parentId = parentMatch[1];
        const children = [...entries.values()]
          .filter((e) => e.parents.includes(parentId))
          .sort((a, b) => a.id.localeCompare(b.id));
        const offset = Number(url.searchParams.get("pageToken") ?? "0");
        const slice = children.slice(offset, offset + pageCap);
        const nextOffset = offset + slice.length;
        const nextPageToken = nextOffset < children.length ? String(nextOffset) : undefined;
        return new Response(
          JSON.stringify({
            ...(nextPageToken ? { nextPageToken } : {}),
            files: slice.map((e) => ({
              id: e.id,
              name: e.name,
              mimeType: e.mimeType,
              size: String(e.content.byteLength),
              md5Checksum: e.md5Checksum || undefined,
              modifiedTime: e.modifiedTime,
              parents: e.parents,
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    }

    return new Response(`Unhandled mock route: ${urlStr}`, { status: 404 });
  }) as unknown as typeof fetch;

  return {
    fetcher,
    addFolder,
    putFile,
    getDownloadsCount: () => downloadsCount,
    resetDownloadsCount: () => {
      downloadsCount = 0;
    },
    getListPagesCount: () => listPagesCount,
  };
}

describe("6단계 Drive 지식 미러(재귀·페이징·사전비교·Changes API·>25MB) & PC↔VPS 교환소", () => {
  const tempDirs: string[] = [];
  const mkTempDir = (prefix: string) => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      try {
        NodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("paginates 250 files across 3 pages + 2-level nested subfolders, skips unchanged downloads (0 requests), downloads only 1 file on Changes API delta, and blocks .sqlite", async () => {
    const mirrorDir = mkTempDir("t3-stage6-mirror-");
    const mock = createMockGoogleDriveFetcher({ pageSizeLimit: 100 });

    mock.addFolder("root-know", "T3-Knowledge");
    mock.addFolder("sub-1", "research", "root-know");
    mock.addFolder("sub-2", "nested", "sub-1");

    // 248개 최상위 파일 (100 + 100 + 48 -> 3페이지 nextPageToken)
    for (let i = 0; i < 248; i += 1) {
      const id = `file-${String(i).padStart(3, "0")}`;
      mock.putFile(
        id,
        `doc-${String(i).padStart(3, "0")}.md`,
        "root-know",
        Buffer.from(`# Document ${i}\n`, "utf8"),
        "2026-11-27T01:00:00.000Z",
      );
    }
    // 2단 하위 폴더 파일 2개 -> 총 250개 허용 파일
    mock.putFile(
      "file-sub-a",
      "alpha.md",
      "sub-1",
      Buffer.from("sub-level-1 content\n", "utf8"),
      "2026-11-27T01:00:00.000Z",
    );
    mock.putFile(
      "file-sub-b",
      "beta.md",
      "sub-2",
      Buffer.from("sub-level-2 deep content\n", "utf8"),
      "2026-11-27T01:00:00.000Z",
    );
    // 금지된 .sqlite 파일 1개 -> 다운로드 0회 차단
    mock.putFile(
      "file-forbidden-db",
      "state.sqlite",
      "root-know",
      Buffer.from("SQLite format 3\0", "utf8"),
      "2026-11-27T01:00:00.000Z",
    );

    const creds = { clientId: "cid", clientSecret: "sec", refreshToken: "1//ref" };
    const existingMap = new Map<string, ExistingMirrorObjectState>();

    // 1차 전체 동기화: 250개 모두 수집 + 3페이지 이상 순회 + .sqlite 1건 차단
    const run1 = await syncKnowledgeMirrorViaGoogleDriveApi({
      creds,
      knowledgeFolderName: "T3-Knowledge",
      mirrorLocalDir: mirrorDir,
      existingByObjectId: existingMap,
      startPageToken: null,
      persistedState: null,
      fetcher: mock.fetcher,
    });
    expect(run1.syncedObjects.length).toBe(250);
    expect(run1.blockedForbiddenCount).toBe(1);
    expect(run1.downloadsIssued).toBe(250);
    expect(mock.getListPagesCount()).toBeGreaterThanOrEqual(5); // root 3p + sub1 1p + sub2 1p
    expect(run1.nextStartPageToken).toBe("100");
    expect(
      NodeFs.readFileSync(NodePath.join(mirrorDir, "research", "nested", "beta.md"), "utf8"),
    ).toBe("sub-level-2 deep content\n");
    expect(NodeFs.existsSync(NodePath.join(mirrorDir, "state.sqlite"))).toBe(false);

    for (const obj of run1.syncedObjects) {
      existingMap.set(obj.objectId, {
        objectId: obj.objectId,
        sha256: obj.sha256,
        localPath: obj.localPath,
        sizeBytes: obj.sizeBytes,
        md5Checksum: obj.md5Checksum,
        modifiedTime: obj.modifiedTime,
      });
    }

    // 2차 동기화 (force=false, startPageToken 없음으로 전체 메타 비교 강제 검증): md5Checksum 동일 -> 다운로드 요청 0회!
    mock.resetDownloadsCount();
    const run2PreCompare = await syncKnowledgeMirrorViaGoogleDriveApi({
      creds,
      knowledgeFolderName: "T3-Knowledge",
      mirrorLocalDir: mirrorDir,
      existingByObjectId: existingMap,
      startPageToken: null,
      persistedState: run1.nextState,
      fetcher: mock.fetcher,
    });
    expect(run2PreCompare.syncedObjects.length).toBe(0);
    expect(run2PreCompare.skippedUnchangedCount).toBe(250);
    expect(run2PreCompare.downloadsIssued).toBe(0);
    expect(mock.getDownloadsCount()).toBe(0);

    // 3차 동기화 (Changes API 증분): 250개 중 하위 폴더 1개 파일만 수정 -> 단 1건만 다운로드!
    mock.resetDownloadsCount();
    mock.putFile(
      "file-sub-b",
      "beta.md",
      "sub-2",
      Buffer.from("sub-level-2 UPDATED content\n", "utf8"),
      "2026-11-27T02:00:00.000Z",
      true,
    );
    const run3Delta = await syncKnowledgeMirrorViaGoogleDriveApi({
      creds,
      knowledgeFolderName: "T3-Knowledge",
      mirrorLocalDir: mirrorDir,
      existingByObjectId: existingMap,
      startPageToken: run1.nextStartPageToken,
      persistedState: run1.nextState,
      fetcher: mock.fetcher,
    });
    expect(run3Delta.usedChangesApi).toBe(true);
    expect(run3Delta.syncedObjects.length).toBe(1);
    expect(run3Delta.downloadsIssued).toBe(1);
    expect(mock.getDownloadsCount()).toBe(1);
    expect(
      NodeFs.readFileSync(NodePath.join(mirrorDir, "research", "nested", "beta.md"), "utf8"),
    ).toBe("sub-level-2 UPDATED content\n");
  });

  it("streams files larger than the old 25MB hard limit (26 MiB) without skipping", async () => {
    const mirrorDir = mkTempDir("t3-stage6-large-");
    const mock = createMockGoogleDriveFetcher({});
    mock.addFolder("root-big", "T3-Knowledge");
    const bigBuf = Buffer.alloc(26 * 1024 * 1024, 0x41);
    mock.putFile("big-1", "large-dataset.bin", "root-big", bigBuf, "2026-11-27T03:00:00.000Z");

    const res = await syncKnowledgeMirrorViaGoogleDriveApi({
      creds: { clientId: "cid", clientSecret: "sec", refreshToken: "1//ref" },
      knowledgeFolderName: "T3-Knowledge",
      mirrorLocalDir: mirrorDir,
      existingByObjectId: new Map(),
      startPageToken: null,
      persistedState: null,
      fetcher: mock.fetcher,
    });
    expect(res.syncedObjects.length).toBe(1);
    expect(res.syncedObjects[0]?.sizeBytes).toBe(26 * 1024 * 1024);
    expect(NodeFs.statSync(NodePath.join(mirrorDir, "large-dataset.bin")).size).toBe(
      26 * 1024 * 1024,
    );
  });

  it("enforces append-only exchange segments, rejects overwrite, records separate .ack.json without modifying originals, and blocks .sqlite/.db files", async () => {
    const driveRoot = mkTempDir("t3-stage6-exch-");
    const stagingDir = mkTempDir("t3-stage6-stage-");
    const transport = {
      mode: "local" as const,
      rootDir: driveRoot,
      exchangeRootName: "T3-Backup",
    };

    // 1. SQLite 파일 확장자 코드 레벨 차단 확인
    for (const forbidden of [
      "state.sqlite",
      "data.sqlite3",
      "memory.db",
      "state.sqlite-wal",
      "state.sqlite-shm",
    ]) {
      expect(() => assertExchangeFileAllowed(forbidden)).toThrow(ExchangeForbiddenFileError);
    }

    // 2. VPS -> outbox 불변 세그먼트 발행
    const pub = await publishExchangeSegment({
      transport,
      writer: "vps",
      records: [
        { type: "signal", ticker: "BTC", score: 0.91 },
        { type: "note", summary: "hourly summary" },
      ],
      source: "vps-collector",
      stagingDir,
      explicitSegmentId: "vps_20261127T07_abc123",
    });
    expect(pub.manifest.recordCount).toBe(2);
    expect(pub.dataDestination).toContain(NodePath.join("exchange", "vps", "outbox"));

    // 3. 동일 segmentId로 덮어쓰기 시도 -> 반드시 거부!
    await expect(
      publishExchangeSegment({
        transport,
        writer: "vps",
        records: [{ type: "tampered" }],
        source: "vps-collector",
        stagingDir,
        explicitSegmentId: "vps_20261127T07_abc123",
      }),
    ).rejects.toThrow(ExchangeOverwriteError);

    // 4. 악성/오배치 .sqlite 파일이 outbox에 있더라도 소비 단계에서 차단 기록
    const outboxDir = NodePath.join(driveRoot, "T3-Backup", "exchange", "vps", "outbox");
    NodeFs.writeFileSync(NodePath.join(outboxDir, "rogue.sqlite"), "SQLite format 3\0");

    const originalDataHash = NodeCrypto.createHash("sha256")
      .update(NodeFs.readFileSync(pub.dataDestination))
      .digest("hex");

    // 5. PC가 VPS outbox 소비 -> 세그먼트 복원 + 별도 exchange/pc/acks/<id>.ack.json 기록 (원본 무변경)
    const consumed1 = await consumeExchangeOutbox({
      transport,
      peerWriter: "vps",
      consumer: "pc",
      stagingDir,
    });
    expect(consumed1.consumed.length).toBe(1);
    expect(consumed1.consumed[0]?.records.length).toBe(2);
    expect(consumed1.blockedForbiddenFiles).toContain("rogue.sqlite");
    expect(
      NodeFs.existsSync(
        NodePath.join(
          driveRoot,
          "T3-Backup",
          "exchange",
          "pc",
          "acks",
          "vps_20261127T07_abc123.ack.json",
        ),
      ),
    ).toBe(true);

    // 원본 데이터 무변경 확인
    const afterDataHash = NodeCrypto.createHash("sha256")
      .update(NodeFs.readFileSync(pub.dataDestination))
      .digest("hex");
    expect(afterDataHash).toBe(originalDataHash);

    // 6. 재실행 시 이미 ACK된 세그먼트 스킵
    const consumed2 = await consumeExchangeOutbox({
      transport,
      peerWriter: "vps",
      consumer: "pc",
      stagingDir,
    });
    expect(consumed2.consumed.length).toBe(0);
    expect(consumed2.skippedAlreadyAcked).toBe(1);
  });
});
