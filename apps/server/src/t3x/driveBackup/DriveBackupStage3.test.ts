// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off globalFetch:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  decryptFileT3Enc2,
  encryptFileT3Enc2,
  sha256Hex,
  T3ENC2_HEADER_LEN,
} from "./DriveBackupCrypto.ts";
import {
  ResumableUploadPausedError,
  uploadFileResumableToGoogleDriveApi,
} from "./DriveTransportAdapter.ts";
import { packEntriesToArchive } from "./ProjectArchivePacker.ts";
import { packFilesToT3Arc2File, verifyAndExtractArchiveFile } from "./StreamingArchivePacker.ts";

describe("Stage 3: T3ARC2 / T3ENC2 streaming, tamper detection, T3ARC1 compat & Resumable chunk resume", () => {
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

  it("detects T3ENC2 tampering: bit flip, chunk swap, truncation, trailing injection, and wrong password", async () => {
    const dir = mkTempDir("t3-enc2-tamper-");
    const srcPath = NodePath.join(dir, "plain.bin");
    const encPath = NodePath.join(dir, "cipher.t3enc");
    const outPath = NodePath.join(dir, "dec.bin");

    // 3 chunks at 32KiB chunk size (96KiB + 100B)
    const plain = NodeCrypto.randomBytes(32 * 1024 * 3 + 100);
    NodeFs.writeFileSync(srcPath, plain);

    await encryptFileT3Enc2({
      srcPath,
      dstPath: encPath,
      passphrase: "CorrectHorseBattery99!",
      chunkSize: 32 * 1024,
    });

    // Valid roundtrip passes
    await decryptFileT3Enc2({
      srcPath: encPath,
      dstPath: outPath,
      passphrase: "CorrectHorseBattery99!",
    });
    expect(NodeFs.readFileSync(outPath).equals(plain)).toBe(true);

    // 1) Wrong passphrase rejected
    await expect(
      decryptFileT3Enc2({
        srcPath: encPath,
        dstPath: NodePath.join(dir, "wrong.bin"),
        passphrase: "WrongPassword99!",
      }),
    ).rejects.toThrow();

    const raw = NodeFs.readFileSync(encPath);

    // 2) Single bit flip in ciphertext rejected
    const flipped = Buffer.from(raw);
    flipped[T3ENC2_HEADER_LEN + 20] = flipped[T3ENC2_HEADER_LEN + 20]! ^ 0x01;
    const flippedPath = NodePath.join(dir, "flipped.t3enc");
    NodeFs.writeFileSync(flippedPath, flipped);
    await expect(
      decryptFileT3Enc2({
        srcPath: flippedPath,
        dstPath: NodePath.join(dir, "dec-flip.bin"),
        passphrase: "CorrectHorseBattery99!",
      }),
    ).rejects.toThrow();

    // 3) Swapping chunk #0 and chunk #1 rejected (chunkIndex in AAD + nonce)
    const frame0Len = 5 + raw.readUInt32BE(T3ENC2_HEADER_LEN) + 16;
    const frame1Start = T3ENC2_HEADER_LEN + frame0Len;
    const frame1Len = 5 + raw.readUInt32BE(frame1Start) + 16;
    const swapped = Buffer.concat([
      raw.subarray(0, T3ENC2_HEADER_LEN),
      raw.subarray(frame1Start, frame1Start + frame1Len),
      raw.subarray(T3ENC2_HEADER_LEN, frame1Start),
      raw.subarray(frame1Start + frame1Len),
    ]);
    const swappedPath = NodePath.join(dir, "swapped.t3enc");
    NodeFs.writeFileSync(swappedPath, swapped);
    await expect(
      decryptFileT3Enc2({
        srcPath: swappedPath,
        dstPath: NodePath.join(dir, "dec-swap.bin"),
        passphrase: "CorrectHorseBattery99!",
      }),
    ).rejects.toThrow();

    // 4) Truncating final chunk (dropping chunk #3) rejected (isFinal in AAD)
    const truncated = raw.subarray(0, frame1Start + frame1Len);
    const truncPath = NodePath.join(dir, "trunc.t3enc");
    NodeFs.writeFileSync(truncPath, truncated);
    await expect(
      decryptFileT3Enc2({
        srcPath: truncPath,
        dstPath: NodePath.join(dir, "dec-trunc.bin"),
        passphrase: "CorrectHorseBattery99!",
      }),
    ).rejects.toThrow();

    // 5) Trailing byte injection after final chunk rejected
    const injected = Buffer.concat([raw, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])]);
    const injPath = NodePath.join(dir, "inj.t3enc");
    NodeFs.writeFileSync(injPath, injected);
    await expect(
      decryptFileT3Enc2({
        srcPath: injPath,
        dstPath: NodePath.join(dir, "dec-inj.bin"),
        passphrase: "CorrectHorseBattery99!",
      }),
    ).rejects.toThrow();
  });

  it("maintains full backward compatibility with T3ARC1 + T3ENC1 and supports T3ARC2 + T3ENC2 roundtrip extraction", async () => {
    const dir = mkTempDir("t3-arc-compat-");

    // 1) Legacy T3ARC1 + T3ENC1
    const v1 = packEntriesToArchive({
      targetId: "legacy-1",
      targetDisplayName: "LegacyTarget",
      entries: [
        { archivePath: "docs/한글메모.md", content: Buffer.from("레거시 백업 본문\n", "utf8") },
      ],
      createdAtIso: "2026-11-27T00:00:00.000Z",
      encryptionPassphrase: "LegacyPassword!1",
    });
    const v1Path = NodePath.join(dir, "legacy.t3enc");
    NodeFs.writeFileSync(v1Path, v1.buffer);
    const v1ExtractDir = NodePath.join(dir, "extract-v1");
    const v1Verified = await verifyAndExtractArchiveFile({
      archivePath: v1Path,
      passphrase: "LegacyPassword!1",
      extractToDir: v1ExtractDir,
    });
    expect(v1Verified.format).toBe("T3ARC1");
    expect(v1Verified.encryptionFormat).toBe("T3ENC1");
    expect(v1Verified.verifiedFilesCount).toBe(1);
    expect(NodeFs.readFileSync(NodePath.join(v1ExtractDir, "docs", "한글메모.md"), "utf8")).toBe(
      "레거시 백업 본문\n",
    );

    // 2) Streaming T3ARC2 + T3ENC2
    const srcA = NodePath.join(dir, "srcA.bin");
    const bufA = NodeCrypto.randomBytes(600 * 1024);
    NodeFs.writeFileSync(srcA, bufA);
    const v2Path = NodePath.join(dir, "stream.t3enc");
    const packed = await packFilesToT3Arc2File({
      targetId: "stream-2",
      targetDisplayName: "StreamTarget",
      entries: [
        { archivePath: "data/large.bin", filePath: srcA },
        { archivePath: "meta/정보.json", buffer: Buffer.from('{"ok":true}\n', "utf8") },
      ],
      outputPath: v2Path,
      createdAtIso: "2026-11-27T00:00:00.000Z",
      encryptionPassphrase: "StreamPassword!2",
    });
    expect(packed.format).toBe("T3ARC2");
    expect(packed.fileCount).toBe(2);

    const v2ExtractDir = NodePath.join(dir, "extract-v2");
    const v2Verified = await verifyAndExtractArchiveFile({
      archivePath: v2Path,
      passphrase: "StreamPassword!2",
      extractToDir: v2ExtractDir,
    });
    expect(v2Verified.format).toBe("T3ARC2");
    expect(v2Verified.encryptionFormat).toBe("T3ENC2");
    expect(v2Verified.manifestSha256).toBe(packed.manifestSha256);
    expect(NodeFs.readFileSync(NodePath.join(v2ExtractDir, "data", "large.bin")).equals(bufA)).toBe(
      true,
    );
    expect(NodeFs.readFileSync(NodePath.join(v2ExtractDir, "meta", "정보.json"), "utf8")).toBe(
      '{"ok":true}\n',
    );
  });

  it("resumes chunked Google Drive upload from saved offset after interruption and restarts single file on 404 session expiry", async () => {
    const dir = mkTempDir("t3-resumable-");
    const filePath = NodePath.join(dir, "archive.t3enc");
    // 1 MiB = 4 × 256 KiB chunks
    const payload = NodeCrypto.randomBytes(1024 * 1024);
    NodeFs.writeFileSync(filePath, payload);
    const expectedHash = sha256Hex(payload);

    const sessions = new Map<
      string,
      { readonly total: number; readonly chunks: Buffer[]; received: number; expired?: boolean }
    >();
    let sessionSeq = 0;
    const uploadedRanges: string[] = [];

    const server = NodeHttp.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const body = Buffer.concat(chunks);

      if (url.pathname === "/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "mock-access-tok" }));
        return;
      }
      if (url.pathname === "/drive/v3/files" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ files: [{ id: "folder-1", name: "T3-Backup" }] }));
        return;
      }
      if (url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
        sessionSeq += 1;
        const sid = `sess-${sessionSeq}`;
        const total = Number(req.headers["x-upload-content-length"] ?? 0);
        sessions.set(sid, { total, chunks: [], received: 0 });
        res.writeHead(200, { location: `http://127.0.0.1:${port}/resumable/${sid}` });
        res.end();
        return;
      }
      if (url.pathname.startsWith("/resumable/") && req.method === "PUT") {
        const sid = url.pathname.slice("/resumable/".length);
        const sess = sessions.get(sid);
        if (!sess || sess.expired) {
          res.writeHead(404);
          res.end("session expired");
          return;
        }
        const cr = String(req.headers["content-range"] ?? "");
        if (cr.startsWith("bytes */")) {
          res.writeHead(308, sess.received > 0 ? { range: `bytes=0-${sess.received - 1}` } : {});
          res.end();
          return;
        }
        uploadedRanges.push(cr);
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
        if (!m) {
          res.writeHead(400);
          res.end("bad range");
          return;
        }
        const start = Number(m[1]);
        const end = Number(m[2]);
        expect(start).toBe(sess.received);
        sess.chunks.push(body);
        sess.received = end + 1;
        if (sess.received >= sess.total) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: `file-${sid}`, name: "archive.t3enc" }));
        } else {
          res.writeHead(308, { range: `bytes=0-${sess.received - 1}` });
          res.end();
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { readonly port: number }).port;

    const rewrittenFetch = (async (inputUrl: string | URL | Request, init?: RequestInit) => {
      const raw =
        typeof inputUrl === "string"
          ? inputUrl
          : inputUrl instanceof URL
            ? inputUrl.href
            : inputUrl.url;
      const mapped = raw
        .replace("https://oauth2.googleapis.com", `http://127.0.0.1:${port}`)
        .replace("https://www.googleapis.com", `http://127.0.0.1:${port}`);
      return fetch(mapped, init);
    }) as typeof fetch;

    try {
      // 1) Pause after 2nd chunk (512 KiB)
      const ac = new AbortController();
      const savedCpRef: {
        current: { sessionUri: string; offsetBytes: number; totalBytes: number } | null;
      } = { current: null };
      await expect(
        uploadFileResumableToGoogleDriveApi(
          { clientId: "cid", clientSecret: "sec", refreshToken: "ref" },
          "T3-Backup",
          {
            subFolder: "core",
            fileName: "archive.t3enc",
            filePath,
            retentionCount: 2,
            chunkSizeBytes: 256 * 1024,
            onCheckpoint: (cp) => {
              savedCpRef.current = cp;
              if (cp.offsetBytes >= 512 * 1024) {
                ac.abort("user_returned");
              }
            },
            signal: ac.signal,
            fetcher: rewrittenFetch,
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ResumableUploadPausedError && err.offsetBytes === 512 * 1024,
      );

      expect(savedCpRef.current?.offsetBytes).toBe(512 * 1024);

      // 2) Resume from checkpoint — only remaining 512 KiB uploaded, zero retransmission of first 512 KiB
      const resumedRes = await uploadFileResumableToGoogleDriveApi(
        { clientId: "cid", clientSecret: "sec", refreshToken: "ref" },
        "T3-Backup",
        {
          subFolder: "core",
          fileName: "archive.t3enc",
          filePath,
          retentionCount: 2,
          chunkSizeBytes: 256 * 1024,
          resumeSessionUri: savedCpRef.current!.sessionUri,
          resumeOffsetBytes: savedCpRef.current!.offsetBytes,
          fetcher: rewrittenFetch,
        },
      );
      expect(resumedRes.resumed).toBe(true);
      expect(uploadedRanges).toEqual([
        "bytes 0-262143/1048576",
        "bytes 262144-524287/1048576",
        "bytes 524288-786431/1048576",
        "bytes 786432-1048575/1048576",
      ]);
      const assembled = Buffer.concat(sessions.get("sess-1")!.chunks);
      expect(sha256Hex(assembled)).toBe(expectedHash);

      // 3) Expired session (404) -> restarts only this file with fresh session
      sessions.get("sess-1")!.expired = true;
      const restarted = await uploadFileResumableToGoogleDriveApi(
        { clientId: "cid", clientSecret: "sec", refreshToken: "ref" },
        "T3-Backup",
        {
          subFolder: "core",
          fileName: "archive.t3enc",
          filePath,
          retentionCount: 2,
          chunkSizeBytes: 512 * 1024,
          resumeSessionUri: savedCpRef.current!.sessionUri,
          resumeOffsetBytes: 512 * 1024,
          fetcher: rewrittenFetch,
        },
      );
      expect(restarted.fileId).toBe("file-sess-2");
      expect(sha256Hex(Buffer.concat(sessions.get("sess-2")!.chunks))).toBe(expectedHash);
    } finally {
      server.close();
    }
  });

  const heavyIt = process.env.T3_HEAVY_STREAM_TEST === "1" ? it : it.skip;
  heavyIt(
    "streams a >2GiB sparse file through T3ARC2 + T3ENC2 + verify without ERR_FS_FILE_TOO_LARGE and stays under 300MB RSS",
    async () => {
      const dir = mkTempDir("t3-heavy-2gib-");
      const sparsePath = NodePath.join(dir, "big-2.2gib.bin");
      const archivePath = NodePath.join(dir, "big.t3enc");

      // Create 2.2 GiB sparse file (near-zero disk blocks, real >2GiB stream bytes)
      const targetSize = 2_250 * 1024 * 1024;
      const fh = await NodeFs.promises.open(sparsePath, "w");
      try {
        await fh.truncate(targetSize);
        await fh.write(Buffer.from("T3-HEAD-MARKER"), 0, 14, 0);
        await fh.write(Buffer.from("T3-TAIL-MARKER"), 0, 14, targetSize - 14);
      } finally {
        await fh.close();
      }

      const packed = await packFilesToT3Arc2File({
        targetId: "heavy-2gib",
        targetDisplayName: "Heavy2GiB",
        entries: [{ archivePath: "core/big.sqlite", filePath: sparsePath }],
        outputPath: archivePath,
        createdAtIso: "2026-11-27T00:00:00.000Z",
        encryptionPassphrase: "HeavyStreamPass!2026",
        gzipLevel: 1,
      });
      expect(packed.rawBytes).toBe(targetSize);
      expect(packed.fileCount).toBe(1);
      expect(process.memoryUsage().rss).toBeLessThan(300 * 1024 * 1024);

      const verified = await verifyAndExtractArchiveFile({
        archivePath,
        passphrase: "HeavyStreamPass!2026",
      });
      expect(verified.verified).toBe(true);
      expect(verified.format).toBe("T3ARC2");
      expect(verified.totalRawBytes).toBe(targetSize);
      expect(process.memoryUsage().rss).toBeLessThan(300 * 1024 * 1024);
    },
    180_000,
  );
});
