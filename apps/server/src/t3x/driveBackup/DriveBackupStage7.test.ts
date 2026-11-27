// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import { execFile } from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { promisify } from "node:util";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const UPLOADER_SCRIPT = NodePath.resolve(
  import.meta.dirname,
  "../../../../../scripts/vps-drive-uploader/index.mjs",
);

interface MockDriveServerState {
  readonly server: NodeHttp.Server;
  readonly baseUrl: string;
  readonly uploadedFiles: Map<string, Buffer>;
  readonly getRetryAttempts: () => number;
  readonly setFailInvalidGrant: (flag: boolean) => void;
}

async function startMockVpsDriveServer(): Promise<MockDriveServerState> {
  const folders = new Map<string, string>();
  const uploadedFiles = new Map<string, Buffer>();
  const sessions = new Map<
    string,
    { readonly name: string; readonly total: number; readonly chunks: Buffer[]; received: number }
  >();
  let retryAttempts = 0;
  let injectedRateLimitCount = 0;
  let failInvalidGrant = false;
  let idSeq = 1;

  const server = NodeHttp.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    const bodyBuf = Buffer.concat(chunks);

    if (url.pathname === "/token") {
      if (failInvalidGrant) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Token expired" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "vps-mock-access-token" }));
      return;
    }

    if (url.pathname === "/drive/v3/files" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const nameMatch = /name = '([^']+)'/.exec(q);
      const name = nameMatch?.[1] ?? "";
      if (q.includes("application/vnd.google-apps.folder")) {
        const fid = folders.get(name);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ files: fid ? [{ id: fid, name }] : [] }));
        return;
      }
      const exists = uploadedFiles.has(name);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files: exists ? [{ id: `f-${name}`, name }] : [] }));
      return;
    }

    if (url.pathname === "/drive/v3/files" && req.method === "POST") {
      const payload = JSON.parse(bodyBuf.toString("utf8")) as { readonly name: string };
      const fid = `folder-${idSeq++}`;
      folders.set(payload.name, fid);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: fid, name: payload.name }));
      return;
    }

    if (url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
      const payload = JSON.parse(bodyBuf.toString("utf8")) as { readonly name: string };
      const total = Number(req.headers["x-upload-content-length"] ?? "0");
      const sid = `sess-${idSeq++}`;
      sessions.set(sid, { name: payload.name, total, chunks: [], received: 0 });
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res.writeHead(200, { location: `http://127.0.0.1:${port}/upload/session/${sid}` });
      res.end();
      return;
    }

    if (url.pathname.startsWith("/upload/session/") && req.method === "PUT") {
      // 첫 번째 청크 업로드 시 429 Too Many Requests 1회 주입해 지수 백오프 재시도 실증
      if (injectedRateLimitCount === 0) {
        injectedRateLimitCount += 1;
        retryAttempts += 1;
        res.writeHead(429, { "retry-after": "0" });
        res.end("Rate Limit Exceeded");
        return;
      }
      const sid = url.pathname.slice("/upload/session/".length);
      const sess = sessions.get(sid);
      if (!sess) {
        res.writeHead(404);
        res.end("Session not found");
        return;
      }
      sess.chunks.push(bodyBuf);
      sess.received += bodyBuf.byteLength;
      if (sess.received < sess.total) {
        res.writeHead(308, { range: `bytes=0-${sess.received - 1}` });
        res.end();
        return;
      }
      const assembled = Buffer.concat(sess.chunks);
      uploadedFiles.set(sess.name, assembled);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `up-${idSeq++}`, name: sess.name }));
      return;
    }

    res.writeHead(404);
    res.end(`Not found: ${url.pathname}`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    uploadedFiles,
    getRetryAttempts: () => retryAttempts,
    setFailInvalidGrant: (flag: boolean) => {
      failInvalidGrant = flag;
    },
  };
}

describe("7단계 VPS 업로더 (토큰 암호화 · 시간 단위 세그먼트 · 429 백오프 Resumable · .sqlite 차단 · invalid_grant)", () => {
  const tempDirs: string[] = [];
  const servers: NodeHttp.Server[] = [];

  const mkTempDir = (prefix: string) => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()!;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop()!;
      try {
        NodeFs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("encrypts token with VPS-TOK1, packs hourly segment while blocking .sqlite, retries 429 with backoff, uploads chunks via Resumable API, rejects overwrite, and surfaces invalid_grant", async () => {
    const tmp = mkTempDir("t3-stage7-vps-");
    const tokenFile = NodePath.join(tmp, "drive-token.enc");
    const inputDir = NodePath.join(tmp, "staging");
    NodeFs.mkdirSync(inputDir, { recursive: true });

    // 입력 파일: JSONL + Markdown + 차단되어야 할 SQLite 원본
    const bigNote = "VPS hourly report line\n".repeat(15_000); // ~345 KB raw -> multi-chunk test
    NodeFs.writeFileSync(
      NodePath.join(inputDir, "events.jsonl"),
      '{"event":"tick","price":100}\n{"event":"signal","side":"buy"}\n',
    );
    NodeFs.writeFileSync(NodePath.join(inputDir, "summary.md"), bigNote);
    NodeFs.writeFileSync(NodePath.join(inputDir, "forbidden.sqlite"), "SQLite format 3\0");
    NodeFs.writeFileSync(NodePath.join(inputDir, "cache.sqlite-wal"), "wal-bytes");

    const mock = await startMockVpsDriveServer();
    servers.push(mock.server);

    const env = { ...process.env, T3_VPS_TOKEN_KEY: "vps-super-secret-master-key-2026" };

    // 1. CLI init-token -> 암호화 토큰 파일 생성 및 평문 미노출 확인
    const initRes = await execFileAsync(
      process.execPath,
      [
        UPLOADER_SCRIPT,
        "init-token",
        "--token-file",
        tokenFile,
        "--client-id",
        "cid-shared.apps.googleusercontent.com",
        "--client-secret",
        "GOCSPX-shared-secret",
        "--refresh-token",
        "1//vps-refresh-token-xyz",
      ],
      { env, windowsHide: true },
    );
    const initJson = JSON.parse(initRes.stdout.trim()) as {
      readonly ok: boolean;
      readonly format: string;
    };
    expect(initJson.ok).toBe(true);
    expect(initJson.format).toBe("VPS-TOK1");

    const rawTokenDisk = NodeFs.readFileSync(tokenFile);
    expect(rawTokenDisk.subarray(0, 8).toString("ascii")).toBe("VPS-TOK1");
    expect(rawTokenDisk.toString("utf8")).not.toContain("1//vps-refresh-token-xyz");
    expect(rawTokenDisk.toString("utf8")).not.toContain("GOCSPX-shared-secret");

    // 2. CLI upload -> 429 백오프 + Resumable 청크 업로드 + .sqlite 차단 확인
    const upRes = await execFileAsync(
      process.execPath,
      [
        UPLOADER_SCRIPT,
        "upload",
        "--token-file",
        tokenFile,
        "--input-dir",
        inputDir,
        "--writer",
        "vps",
        "--drive-root",
        "T3-Backup",
        "--segment-id",
        "vps_20261127T07_test01",
        "--chunk-bytes",
        String(256 * 1024),
        "--limit-mbps",
        "0",
        "--token-endpoint",
        `${mock.baseUrl}/token`,
        "--api-base",
        mock.baseUrl,
        "--upload-base",
        mock.baseUrl,
      ],
      { env, windowsHide: true },
    );
    const upJson = JSON.parse(upRes.stdout.trim()) as {
      readonly ok: boolean;
      readonly segmentId: string;
      readonly recordCount: number;
      readonly gzipSha256: string;
      readonly blockedFiles: ReadonlyArray<string>;
      readonly folderPath: string;
    };
    expect(upJson.ok).toBe(true);
    expect(upJson.segmentId).toBe("vps_20261127T07_test01");
    expect(upJson.recordCount).toBe(3); // 2 jsonl lines + 1 md file
    expect(upJson.folderPath).toBe("T3-Backup/exchange/vps/outbox");
    expect(upJson.blockedFiles).toEqual(["cache.sqlite-wal", "forbidden.sqlite"]);
    expect(mock.getRetryAttempts()).toBe(1);

    // 수신된 파일 무결성 검증
    const uploadedGzip = mock.uploadedFiles.get("vps_20261127T07_test01.jsonl.gz");
    const uploadedManifestBuf = mock.uploadedFiles.get("vps_20261127T07_test01.manifest.json");
    expect(uploadedGzip).toBeDefined();
    expect(uploadedManifestBuf).toBeDefined();
    const actualSha = NodeCrypto.createHash("sha256").update(uploadedGzip!).digest("hex");
    expect(actualSha).toBe(upJson.gzipSha256);
    const decompressedLines = NodeZlib.gunzipSync(uploadedGzip!)
      .toString("utf8")
      .trim()
      .split("\n");
    expect(decompressedLines.length).toBe(3);

    // 3. 동일 segmentId 재업로드 시도 -> 덮어쓰기 금지 거부!
    await expect(
      execFileAsync(
        process.execPath,
        [
          UPLOADER_SCRIPT,
          "upload",
          "--token-file",
          tokenFile,
          "--input-dir",
          inputDir,
          "--segment-id",
          "vps_20261127T07_test01",
          "--token-endpoint",
          `${mock.baseUrl}/token`,
          "--api-base",
          mock.baseUrl,
          "--upload-base",
          mock.baseUrl,
        ],
        { env, windowsHide: true },
      ),
    ).rejects.toThrow(/덮어쓰기 금지/);

    // 4. invalid_grant 시 Production 게시 안내 + exit code 12 확인
    mock.setFailInvalidGrant(true);
    let invalidGrantErr: { readonly code?: number; readonly stderr?: string } | null = null;
    try {
      await execFileAsync(
        process.execPath,
        [
          UPLOADER_SCRIPT,
          "upload",
          "--token-file",
          tokenFile,
          "--input-dir",
          inputDir,
          "--segment-id",
          "vps_20261127T07_test02",
          "--token-endpoint",
          `${mock.baseUrl}/token`,
          "--api-base",
          mock.baseUrl,
          "--upload-base",
          mock.baseUrl,
        ],
        { env, windowsHide: true },
      );
    } catch (err) {
      invalidGrantErr = err as { readonly code?: number; readonly stderr?: string };
    }
    expect(invalidGrantErr?.code).toBe(12);
    expect(invalidGrantErr?.stderr).toContain("Production");
  });
});
