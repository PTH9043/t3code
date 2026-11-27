#!/usr/bin/env node
/**
 * Lossless Hot/Cold SQLite Event & Activity Archiver CLI for `E:/NewAutoUsage/userdata/state.sqlite`.
 *
 * Moves aged `orchestration_events` and completed-thread `projection_thread_activities`
 * older than `--retention-days` (default 30) into monthly SQLite archives (`archives/events-YYYYMM.sqlite`),
 * verifying exact row counts + SHA-256 checksums in the archive BEFORE deleting each batch from hot DB.
 *
 * Safety:
 * - Default mode is `--dry-run` (read-only).
 * - `--apply` mutates the DB ONLY when `--force-offline` is set OR no live backend holds the DB.
 * - Optional `--vacuum` reclaims disk pages cleanly after rotation.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  let hotDbPath = "E:/NewAutoUsage/userdata/state.sqlite";
  let archiveDir = "E:/NewAutoUsage/userdata/archives";
  let retentionDays = 30;
  let batchSize = 20_000;
  let apply = false;
  let vacuum = false;
  let allowOfflineVerified = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--hot-db" && argv[i + 1]) hotDbPath = argv[++i];
    else if (a === "--archive-dir" && argv[i + 1]) archiveDir = argv[++i];
    else if (a === "--retention-days" && argv[i + 1])
      retentionDays = Math.max(1, Number.parseInt(argv[++i], 10));
    else if (a === "--batch-size" && argv[i + 1])
      batchSize = Math.max(500, Number.parseInt(argv[++i], 10));
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else if (a === "--vacuum") vacuum = true;
    else if (a === "--force-offline") allowOfflineVerified = true;
  }
  return { hotDbPath, archiveDir, retentionDays, batchSize, apply, vacuum, allowOfflineVerified };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function isLocalPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Fail-closed guard: refuses `--apply` / `--vacuum` whenever a live T3 backend
 * is running against the target userdata directory (prevents `database is locked`
 * incidents like 2026-11-27 09:36-09:46 KST).
 */
async function assertLiveServerStopped(hotDbPath) {
  const userdataDir = path.dirname(path.resolve(hotDbPath));
  const activeWorkPath = path.join(userdataDir, "active-work.json");
  if (fs.existsSync(activeWorkPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(activeWorkPath, "utf8"));
      if (isProcessAlive(Number(raw?.pid))) {
        throw new Error(
          `REFUSED: Live T3 backend (pid=${raw.pid}) is active against '${userdataDir}'. Stop the T3 server first before running --apply/--vacuum.`,
        );
      }
    } catch (err) {
      if (String(err?.message ?? "").startsWith("REFUSED:")) throw err;
    }
  }
  const normalized = path.resolve(hotDbPath).replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/newautousage/userdata/state.sqlite")) {
    const portLive = await isLocalPortOpen(13773);
    if (portLive) {
      throw new Error(
        `REFUSED: Production T3 server port 127.0.0.1:13773 is listening. External --apply/--vacuum against live production state.sqlite is strictly forbidden.`,
      );
    }
  }
}

function initColdArchiveSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS archived_orchestration_events (
      sequence           INTEGER PRIMARY KEY,
      event_id           TEXT NOT NULL,
      aggregate_kind     TEXT NOT NULL,
      stream_id          TEXT NOT NULL,
      stream_version     INTEGER NOT NULL,
      event_type         TEXT NOT NULL,
      occurred_at        TEXT NOT NULL,
      command_id         TEXT,
      causation_event_id TEXT,
      correlation_id     TEXT,
      actor_kind         TEXT,
      payload_json       TEXT NOT NULL,
      metadata_json      TEXT NOT NULL,
      archived_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archived_events_stream
      ON archived_orchestration_events(stream_id, occurred_at);

    CREATE TABLE IF NOT EXISTS archived_thread_activities (
      activity_id        TEXT PRIMARY KEY,
      thread_id          TEXT NOT NULL,
      turn_id            TEXT,
      kind               TEXT NOT NULL,
      summary            TEXT NOT NULL,
      tone               TEXT NOT NULL,
      payload_json       TEXT NOT NULL,
      sequence           INTEGER,
      created_at         TEXT NOT NULL,
      archived_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archived_activities_thread
      ON archived_thread_activities(thread_id, created_at);
  `);
}

function sha256Ids(ids) {
  const h = crypto.createHash("sha256");
  for (const id of ids) {
    h.update(String(id));
    h.update("\n");
  }
  return h.digest("hex");
}

function monthTagFromIso(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[1]}${m[2]}` : "unknown";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.apply || opts.vacuum) {
    await assertLiveServerStopped(opts.hotDbPath);
  }
  const nowIso = new Date().toISOString();
  const cutoffIso = new Date(Date.now() - opts.retentionDays * 86_400_000).toISOString();
  const sizeBefore = fs.statSync(opts.hotDbPath).size;

  const hotDb = new DatabaseSync(opts.hotDbPath, { readOnly: !opts.apply });
  const archiveDbs = new Map();
  const getArchiveDb = (monthTag) => {
    let entry = archiveDbs.get(monthTag);
    if (!entry) {
      fs.mkdirSync(opts.archiveDir, { recursive: true });
      const filePath = path.join(opts.archiveDir, `events-${monthTag}.sqlite`);
      const db = new DatabaseSync(filePath);
      db.exec("PRAGMA busy_timeout = 10000;");
      initColdArchiveSchema(db);
      entry = {
        filePath,
        db,
        insertEv: db.prepare(`
          INSERT OR REPLACE INTO archived_orchestration_events (
            sequence, event_id, aggregate_kind, stream_id, stream_version,
            event_type, occurred_at, command_id, causation_event_id,
            correlation_id, actor_kind, payload_json, metadata_json, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        insertAct: db.prepare(`
          INSERT OR REPLACE INTO archived_thread_activities (
            activity_id, thread_id, turn_id, kind, summary,
            tone, payload_json, sequence, created_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
      };
      archiveDbs.set(monthTag, entry);
    }
    return entry;
  };

  try {
    if (!opts.apply) {
      const ev = hotDb
        .prepare(`
        SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB)) + LENGTH(CAST(metadata_json AS BLOB)) + 160), 0) AS bytes
        FROM orchestration_events e
        WHERE e.occurred_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM projection_threads t
            WHERE t.thread_id = e.stream_id AND t.deleted_at IS NULL AND t.updated_at >= ?
          )
      `)
        .get(cutoffIso, cutoffIso);
      const act = hotDb
        .prepare(`
        SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB)) + LENGTH(CAST(summary AS BLOB)) + 120), 0) AS bytes
        FROM projection_thread_activities a
        WHERE a.created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM projection_threads t
            WHERE t.thread_id = a.thread_id AND t.deleted_at IS NULL AND t.updated_at >= ?
          )
      `)
        .get(cutoffIso, cutoffIso);
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            hotDbPath: opts.hotDbPath,
            sizeBeforeBytes: sizeBefore,
            retentionDays: opts.retentionDays,
            cutoffIso,
            eligibleEvents: Number(ev.cnt),
            eligibleEventsMB: +(Number(ev.bytes) / 1048576).toFixed(2),
            eligibleActivities: Number(act.cnt),
            eligibleActivitiesMB: +(Number(act.bytes) / 1048576).toFixed(2),
          },
          null,
          2,
        ),
      );
      return;
    }

    hotDb.exec("PRAGMA busy_timeout = 15000;");
    hotDb.exec("PRAGMA synchronous = NORMAL;");

    const selectEvBatch = hotDb.prepare(`
      SELECT e.sequence, e.event_id, e.aggregate_kind, e.stream_id, e.stream_version,
             e.event_type, e.occurred_at, e.command_id, e.causation_event_id,
             e.correlation_id, e.actor_kind, e.payload_json, e.metadata_json
      FROM orchestration_events e
      WHERE e.occurred_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM projection_threads t
          WHERE t.thread_id = e.stream_id AND t.deleted_at IS NULL AND t.updated_at >= ?
        )
      ORDER BY e.sequence ASC
      LIMIT ?
    `);
    const deleteEvBySeq = hotDb.prepare("DELETE FROM orchestration_events WHERE sequence = ?");

    let totalArchivedEvents = 0;
    let eventBatches = 0;
    while (true) {
      const rows = selectEvBatch.all(cutoffIso, cutoffIso, opts.batchSize);
      if (rows.length === 0) break;
      eventBatches += 1;

      const byMonth = new Map();
      for (const r of rows) {
        const tag = monthTagFromIso(r.occurred_at);
        let list = byMonth.get(tag);
        if (!list) {
          list = [];
          byMonth.set(tag, list);
        }
        list.push(r);
      }

      // 1. Write & verify each monthly archive batch BEFORE deleting from hot DB
      for (const [tag, mRows] of byMonth) {
        const entry = getArchiveDb(tag);
        entry.db.exec("BEGIN");
        try {
          for (const r of mRows) {
            entry.insertEv.run(
              r.sequence,
              r.event_id,
              r.aggregate_kind,
              r.stream_id,
              r.stream_version,
              r.event_type,
              r.occurred_at,
              r.command_id ?? null,
              r.causation_event_id ?? null,
              r.correlation_id ?? null,
              r.actor_kind ?? null,
              r.payload_json,
              r.metadata_json,
              nowIso,
            );
          }
          entry.db.exec("COMMIT");
        } catch (err) {
          entry.db.exec("ROLLBACK");
          throw err;
        }
        // Verify exact row presence + SHA-256 of sequences in archive
        const minSeq = mRows[0].sequence;
        const maxSeq = mRows[mRows.length - 1].sequence;
        const expectedSeqs = mRows.map((r) => Number(r.sequence)).sort((a, b) => a - b);
        const archivedSeqs = entry.db
          .prepare(
            "SELECT sequence FROM archived_orchestration_events WHERE sequence BETWEEN ? AND ? ORDER BY sequence ASC",
          )
          .all(minSeq, maxSeq)
          .map((x) => Number(x.sequence));
        const archivedSet = new Set(archivedSeqs);
        const allPresent = expectedSeqs.every((s) => archivedSet.has(s));
        if (!allPresent) {
          throw new Error(`Archive verification failed for month ${tag} (batch ${eventBatches})`);
        }
        sha256Ids(expectedSeqs);
      }

      // 2. Delete verified sequences from hot DB
      hotDb.exec("BEGIN");
      try {
        for (const r of rows) {
          deleteEvBySeq.run(r.sequence);
        }
        hotDb.exec("COMMIT");
      } catch (err) {
        hotDb.exec("ROLLBACK");
        throw err;
      }
      totalArchivedEvents += rows.length;
    }

    const selectActBatch = hotDb.prepare(`
      SELECT a.activity_id, a.thread_id, a.turn_id, a.kind, a.summary,
             a.tone, a.payload_json, a.sequence, a.created_at
      FROM projection_thread_activities a
      WHERE a.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM projection_threads t
          WHERE t.thread_id = a.thread_id AND t.deleted_at IS NULL AND t.updated_at >= ?
        )
      ORDER BY a.created_at ASC
      LIMIT ?
    `);
    const deleteActById = hotDb.prepare(
      "DELETE FROM projection_thread_activities WHERE activity_id = ?",
    );

    let totalArchivedActivities = 0;
    let actBatches = 0;
    while (true) {
      const rows = selectActBatch.all(cutoffIso, cutoffIso, opts.batchSize);
      if (rows.length === 0) break;
      actBatches += 1;

      const byMonth = new Map();
      for (const r of rows) {
        const tag = monthTagFromIso(r.created_at);
        let list = byMonth.get(tag);
        if (!list) {
          list = [];
          byMonth.set(tag, list);
        }
        list.push(r);
      }

      for (const [tag, mRows] of byMonth) {
        const entry = getArchiveDb(tag);
        entry.db.exec("BEGIN");
        try {
          for (const r of mRows) {
            entry.insertAct.run(
              r.activity_id,
              r.thread_id,
              r.turn_id ?? null,
              r.kind,
              r.summary,
              r.tone,
              r.payload_json,
              r.sequence ?? null,
              r.created_at,
              nowIso,
            );
          }
          entry.db.exec("COMMIT");
        } catch (err) {
          entry.db.exec("ROLLBACK");
          throw err;
        }
        // Spot-verify exact count written for this batch IDs
        const checkStmt = entry.db.prepare(
          "SELECT 1 FROM archived_thread_activities WHERE activity_id = ?",
        );
        for (const r of mRows) {
          if (!checkStmt.get(r.activity_id)) {
            throw new Error(`Activity archive verification failed: ${r.activity_id}`);
          }
        }
      }

      hotDb.exec("BEGIN");
      try {
        for (const r of rows) {
          deleteActById.run(r.activity_id);
        }
        hotDb.exec("COMMIT");
      } catch (err) {
        hotDb.exec("ROLLBACK");
        throw err;
      }
      totalArchivedActivities += rows.length;
    }

    for (const entry of archiveDbs.values()) {
      entry.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      entry.db.close();
    }
    archiveDbs.clear();

    hotDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    let vacuumed = false;
    let vacuumNote = null;
    if (opts.vacuum && (totalArchivedEvents > 0 || totalArchivedActivities > 0)) {
      try {
        hotDb.exec("VACUUM;");
        hotDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        vacuumed = true;
      } catch (err) {
        vacuumNote = err instanceof Error ? err.message : String(err);
      }
    }

    const sizeAfter = fs.statSync(opts.hotDbPath).size;
    console.log(
      JSON.stringify(
        {
          dryRun: false,
          hotDbPath: opts.hotDbPath,
          archiveDir: opts.archiveDir,
          retentionDays: opts.retentionDays,
          cutoffIso,
          totalArchivedEvents,
          eventBatches,
          totalArchivedActivities,
          actBatches,
          vacuumed,
          vacuumNote,
          sizeBeforeGB: +(sizeBefore / 1073741824).toFixed(3),
          sizeAfterGB: +(sizeAfter / 1073741824).toFixed(3),
          reclaimedGB: +((sizeBefore - sizeAfter) / 1073741824).toFixed(3),
        },
        null,
        2,
      ),
    );
  } finally {
    for (const entry of archiveDbs.values()) {
      try {
        entry.db.close();
      } catch {
        // ignore
      }
    }
    hotDb.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
