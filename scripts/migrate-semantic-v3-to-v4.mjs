#!/usr/bin/env node
/**
 * Lossless migrator for legacy `userdata/semantic-rag/v3/<scopeKey>/<prefix>/<sha256>.json`
 * vector files into unified `userdata/semantic-rag/v4/vectors.sqlite`, followed by optional
 * verified cleanup (`--cleanup-v3`).
 *
 * Guarantees:
 * - Every valid JSON vector in `v3/` not yet in `v4/vectors.sqlite` is promoted first.
 * - Cleanup removes a `v3` file ONLY after confirming its `(scope_key, content_key)` exists in `v4/vectors.sqlite`
 *   (or if the file is an invalid/empty leftover `.tmp` file).
 * - Writes a `.migrated-v4` marker file inside `semantic-rag/` so `semanticSearch.ts` skips NTFS `stat` probes.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  let stateDir = "E:/NewAutoUsage/userdata";
  let apply = false;
  let cleanupV3 = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--state-dir" && argv[i + 1]) stateDir = argv[++i];
    else if (a === "--apply") apply = true;
    else if (a === "--cleanup-v3") cleanupV3 = true;
  }
  return { stateDir, apply, cleanupV3 };
}

function quantizeBinaryVector(vec) {
  const byteLength = Math.ceil(vec.length / 8);
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < vec.length; i += 1) {
    if ((vec[i] ?? 0) > 0) out[i >> 3] |= 1 << (i & 7);
  }
  return Buffer.from(out);
}

function serializeFloat64Vector(vec) {
  const f64 = new Float64Array(vec);
  return Buffer.from(f64.buffer, f64.byteOffset, f64.byteLength);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const v3Root = path.join(opts.stateDir, "semantic-rag", "v3");
  const v4Path = path.join(opts.stateDir, "semantic-rag", "v4", "vectors.sqlite");

  if (!fs.existsSync(v3Root)) {
    console.log(JSON.stringify({ ok: true, message: "v3 directory does not exist", v3Root }));
    return;
  }

  fs.mkdirSync(path.dirname(v4Path), { recursive: true });
  const db = new DatabaseSync(v4Path);
  db.exec(`
    PRAGMA busy_timeout = 10000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS semantic_vectors (
      scope_key TEXT NOT NULL,
      content_key TEXT NOT NULL,
      dim INTEGER NOT NULL,
      bin BLOB NOT NULL,
      f32 BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_key, content_key)
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_vectors_scope_updated
      ON semantic_vectors (scope_key, updated_at);
  `);

  const hasKeyStmt = db.prepare(
    "SELECT 1 FROM semantic_vectors WHERE scope_key = ? AND content_key = ?",
  );
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO semantic_vectors (scope_key, content_key, dim, bin, f32, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let scannedFiles = 0;
  let totalBytes = 0;
  let alreadyInV4 = 0;
  let promotedToV4 = 0;
  let invalidFiles = 0;
  let removedFiles = 0;
  let removedBytes = 0;

  const nowMs = Date.now();
  const pendingInsert = [];
  const verifiedToRemove = [];

  const flushInserts = () => {
    if (pendingInsert.length === 0) return;
    db.exec("BEGIN");
    try {
      for (const item of pendingInsert) {
        insertStmt.run(
          item.scopeKey,
          item.contentKey,
          item.dim,
          item.bin,
          item.f32,
          item.updatedAt,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    promotedToV4 += pendingInsert.length;
    pendingInsert.length = 0;
  };

  try {
    for (const scopeEntry of fs.readdirSync(v3Root, { withFileTypes: true })) {
      if (!scopeEntry.isDirectory()) continue;
      const scopeKey = scopeEntry.name;
      const scopePath = path.join(v3Root, scopeKey);
      for (const prefixEntry of fs.readdirSync(scopePath, { withFileTypes: true })) {
        if (!prefixEntry.isDirectory()) continue;
        const prefixPath = path.join(scopePath, prefixEntry.name);
        for (const fileEntry of fs.readdirSync(prefixPath, { withFileTypes: true })) {
          if (!fileEntry.isFile()) continue;
          const filePath = path.join(prefixPath, fileEntry.name);
          const stat = fs.statSync(filePath);
          scannedFiles += 1;
          totalBytes += stat.size;

          const match = /^([a-f0-9]{64})\.json$/i.exec(fileEntry.name);
          if (!match) {
            invalidFiles += 1;
            if (opts.apply && opts.cleanupV3 && fileEntry.name.endsWith(".tmp")) {
              verifiedToRemove.push({ filePath, size: stat.size });
            }
            continue;
          }
          const contentKey = match[1].toLowerCase();
          if (hasKeyStmt.get(scopeKey, contentKey)) {
            alreadyInV4 += 1;
            if (opts.apply && opts.cleanupV3) {
              verifiedToRemove.push({ filePath, size: stat.size });
            }
            continue;
          }

          if (opts.apply) {
            try {
              const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
              if (
                Array.isArray(raw) &&
                raw.length > 0 &&
                raw.length <= 4096 &&
                raw.every((n) => typeof n === "number" && Number.isFinite(n))
              ) {
                pendingInsert.push({
                  scopeKey,
                  contentKey,
                  dim: raw.length,
                  bin: quantizeBinaryVector(raw),
                  f32: serializeFloat64Vector(raw),
                  updatedAt: Math.round(stat.mtimeMs) || nowMs,
                });
                if (pendingInsert.length >= 1000) flushInserts();
                if (opts.cleanupV3) {
                  verifiedToRemove.push({
                    filePath,
                    size: stat.size,
                    verify: [scopeKey, contentKey],
                  });
                }
              } else {
                invalidFiles += 1;
              }
            } catch {
              invalidFiles += 1;
            }
          }
        }
      }
    }

    if (opts.apply) {
      flushInserts();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    }

    if (opts.apply && opts.cleanupV3) {
      for (const item of verifiedToRemove) {
        if (item.verify) {
          const [sk, ck] = item.verify;
          if (!hasKeyStmt.get(sk, ck)) continue;
        }
        try {
          fs.unlinkSync(item.filePath);
          removedFiles += 1;
          removedBytes += item.size;
        } catch {
          // Ignore individual unlink failures.
        }
      }
      // Prune empty directories under v3/
      const pruneEmptyDirs = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name));
        }
        if (fs.readdirSync(dir).length === 0) {
          try {
            fs.rmdirSync(dir);
          } catch {
            // ignore
          }
        }
      };
      pruneEmptyDirs(v3Root);
      fs.writeFileSync(
        path.join(opts.stateDir, "semantic-rag", ".migrated-v4"),
        JSON.stringify({
          migratedAt: new Date().toISOString(),
          promotedToV4,
          removedFiles,
          removedBytes,
        }),
      );
    }

    const totalV4Rows = Number(
      db.prepare("SELECT COUNT(*) AS cnt FROM semantic_vectors").get().cnt,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          apply: opts.apply,
          cleanupV3: opts.cleanupV3,
          scannedFiles,
          totalV3MB: +(totalBytes / 1048576).toFixed(2),
          alreadyInV4,
          promotedToV4,
          invalidFiles,
          removedFiles,
          removedMB: +(removedBytes / 1048576).toFixed(2),
          totalV4Rows,
          v4SizeMB: +(fs.statSync(v4Path).size / 1048576).toFixed(2),
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

main();
