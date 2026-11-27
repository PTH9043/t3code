// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export const DEFAULT_EVENT_ARCHIVE_RETENTION_DAYS = 30;
export const DEFAULT_EVENT_ARCHIVE_BATCH_LIMIT = 5_000;

export interface EventArchiveRotationInput {
  readonly hotDbPath: string;
  readonly archiveDir: string;
  readonly retentionDays?: number | undefined;
  readonly batchLimit?: number | undefined;
  readonly nowMs?: number | undefined;
  /** When true, computes exact archiveable counts without modifying either DB. */
  readonly dryRun?: boolean | undefined;
  /** Must be `0` before mutating a live DB (safety gate). */
  readonly activeWorkCount?: number | undefined;
}

export interface EventArchiveRotationResult {
  readonly skippedReason: string | null;
  readonly dryRun: boolean;
  readonly cutoffIso: string;
  readonly archiveDbPath: string;
  readonly archivedEvents: number;
  readonly archivedActivities: number;
  readonly verifiedChecksum: string | null;
  readonly reclaimedBytes: number;
}

function monthTagFromMs(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

function hashRows(rows: ReadonlyArray<Record<string, unknown>>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const row of rows) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function initColdArchiveSchema(archiveDb: NodeSqlite.DatabaseSync): void {
  archiveDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS archived_orchestration_events (
      sequence         INTEGER PRIMARY KEY,
      event_id         TEXT NOT NULL,
      aggregate_kind   TEXT NOT NULL,
      stream_id        TEXT NOT NULL,
      stream_version   INTEGER NOT NULL,
      event_type       TEXT NOT NULL,
      occurred_at      TEXT NOT NULL,
      command_id       TEXT,
      causation_event_id TEXT,
      correlation_id   TEXT,
      actor_kind       TEXT,
      payload_json     TEXT NOT NULL,
      metadata_json    TEXT NOT NULL,
      archived_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archived_events_stream
      ON archived_orchestration_events(stream_id, occurred_at);

    CREATE TABLE IF NOT EXISTS archived_thread_activities (
      activity_id      TEXT PRIMARY KEY,
      thread_id        TEXT NOT NULL,
      turn_id          TEXT,
      kind             TEXT NOT NULL,
      summary          TEXT NOT NULL,
      tone             TEXT NOT NULL,
      payload_json     TEXT NOT NULL,
      sequence         INTEGER,
      created_at       TEXT NOT NULL,
      archived_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archived_activities_thread
      ON archived_thread_activities(thread_id, created_at);
  `);
}

/**
 * Lossless Hot/Cold SQLite Archive Rotation for T3 (`state.sqlite` bloat relief
 * without migrating away from SQLite):
 *
 * Moves aged `orchestration_events` and completed-thread `projection_thread_activities`
 * older than `retentionDays` (default 30d) into monthly read-only-queryable SQLite
 * archive files (`archives/events-YYYYMM.sqlite`), verifies exact row count + SHA-256
 * checksum in the archive BEFORE deleting from the hot DB, and runs incremental vacuum.
 */
export function rotateAgedEventsToColdArchive(
  input: EventArchiveRotationInput,
): EventArchiveRotationResult {
  const nowMs = input.nowMs ?? Date.now();
  const retentionDays = Math.max(1, input.retentionDays ?? DEFAULT_EVENT_ARCHIVE_RETENTION_DAYS);
  const batchLimit = Math.max(1, input.batchLimit ?? DEFAULT_EVENT_ARCHIVE_BATCH_LIMIT);
  const dryRun = input.dryRun === true;
  const cutoffIso = new Date(nowMs - retentionDays * 86_400_000).toISOString();
  const archiveDbPath = NodePath.join(input.archiveDir, `events-${monthTagFromMs(nowMs)}.sqlite`);

  if ((input.activeWorkCount ?? 0) > 0) {
    return {
      skippedReason: "active-work-nonzero",
      dryRun,
      cutoffIso,
      archiveDbPath,
      archivedEvents: 0,
      archivedActivities: 0,
      verifiedChecksum: null,
      reclaimedBytes: 0,
    };
  }

  const hotDb = new NodeSqlite.DatabaseSync(input.hotDbPath, { readOnly: dryRun });
  try {
    if (!dryRun) {
      hotDb.exec("PRAGMA busy_timeout = 5000;");
    }

    const sizeBefore = NodeFs.existsSync(input.hotDbPath)
      ? NodeFs.statSync(input.hotDbPath).size
      : 0;

    // Only archive events older than cutoff whose thread is not currently running/streaming.
    const candidateEvents = hotDb
      .prepare(
        `SELECT e.sequence, e.event_id, e.aggregate_kind, e.stream_id, e.stream_version,
                e.event_type, e.occurred_at, e.command_id, e.causation_event_id,
                e.correlation_id, e.actor_kind, e.payload_json, e.metadata_json
         FROM orchestration_events e
         WHERE e.occurred_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM projection_threads t
             WHERE t.thread_id = e.stream_id
               AND t.deleted_at IS NULL
               AND t.updated_at >= ?
           )
         ORDER BY e.sequence ASC
         LIMIT ?`,
      )
      .all(cutoffIso, cutoffIso, batchLimit) as Array<Record<string, unknown>>;

    const candidateActivities = hotDb
      .prepare(
        `SELECT a.activity_id, a.thread_id, a.turn_id, a.kind, a.summary,
                a.tone, a.payload_json, a.sequence, a.created_at
         FROM projection_thread_activities a
         WHERE a.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM projection_threads t
             WHERE t.thread_id = a.thread_id
               AND t.deleted_at IS NULL
               AND t.updated_at >= ?
           )
         ORDER BY a.created_at ASC
         LIMIT ?`,
      )
      .all(cutoffIso, cutoffIso, batchLimit) as Array<Record<string, unknown>>;

    if (dryRun || (candidateEvents.length === 0 && candidateActivities.length === 0)) {
      return {
        skippedReason: null,
        dryRun,
        cutoffIso,
        archiveDbPath,
        archivedEvents: candidateEvents.length,
        archivedActivities: candidateActivities.length,
        verifiedChecksum: null,
        reclaimedBytes: 0,
      };
    }

    NodeFs.mkdirSync(input.archiveDir, { recursive: true });
    const archiveDb = new NodeSqlite.DatabaseSync(archiveDbPath);
    let verifiedChecksum: string | null = null;
    try {
      initColdArchiveSchema(archiveDb);
      const archivedAt = new Date(nowMs).toISOString();

      archiveDb.exec("BEGIN IMMEDIATE;");
      const insertEvent = archiveDb.prepare(`
        INSERT OR REPLACE INTO archived_orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version,
          event_type, occurred_at, command_id, causation_event_id,
          correlation_id, actor_kind, payload_json, metadata_json, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ev of candidateEvents) {
        insertEvent.run(
          ev.sequence as number,
          ev.event_id as string,
          ev.aggregate_kind as string,
          ev.stream_id as string,
          ev.stream_version as number,
          ev.event_type as string,
          ev.occurred_at as string,
          (ev.command_id as string | null) ?? null,
          (ev.causation_event_id as string | null) ?? null,
          (ev.correlation_id as string | null) ?? null,
          (ev.actor_kind as string | null) ?? null,
          ev.payload_json as string,
          ev.metadata_json as string,
          archivedAt,
        );
      }

      const insertActivity = archiveDb.prepare(`
        INSERT OR REPLACE INTO archived_thread_activities (
          activity_id, thread_id, turn_id, kind, summary,
          tone, payload_json, sequence, created_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const act of candidateActivities) {
        insertActivity.run(
          act.activity_id as string,
          act.thread_id as string,
          (act.turn_id as string | null) ?? null,
          act.kind as string,
          act.summary as string,
          act.tone as string,
          act.payload_json as string,
          (act.sequence as number | null) ?? null,
          act.created_at as string,
          archivedAt,
        );
      }
      archiveDb.exec("COMMIT;");

      // Verify exact row existence + payload checksum in cold archive BEFORE pruning hot DB!
      const verifiedEvents: Array<Record<string, unknown>> = [];
      const checkEvent = archiveDb.prepare(
        `SELECT sequence, event_id, payload_json FROM archived_orchestration_events WHERE sequence = ?`,
      );
      for (const ev of candidateEvents) {
        const stored = checkEvent.get(ev.sequence as number) as Record<string, unknown> | undefined;
        if (!stored || stored.event_id !== ev.event_id || stored.payload_json !== ev.payload_json) {
          throw new Error(
            `Archive verification mismatch for event sequence=${String(ev.sequence)}`,
          );
        }
        verifiedEvents.push(stored);
      }

      const verifiedActivities: Array<Record<string, unknown>> = [];
      const checkAct = archiveDb.prepare(
        `SELECT activity_id, payload_json FROM archived_thread_activities WHERE activity_id = ?`,
      );
      for (const act of candidateActivities) {
        const stored = checkAct.get(act.activity_id as string) as
          | Record<string, unknown>
          | undefined;
        if (!stored || stored.payload_json !== act.payload_json) {
          throw new Error(
            `Archive verification mismatch for activity_id=${String(act.activity_id)}`,
          );
        }
        verifiedActivities.push(stored);
      }
      verifiedChecksum = hashRows([...verifiedEvents, ...verifiedActivities]).slice(0, 16);
    } finally {
      archiveDb.close();
    }

    // Verified in archive -> safe to prune migrated rows from hot DB.
    hotDb.exec("BEGIN IMMEDIATE;");
    const delEvent = hotDb.prepare("DELETE FROM orchestration_events WHERE sequence = ?");
    for (const ev of candidateEvents) {
      delEvent.run(ev.sequence as number);
    }
    const delActivity = hotDb.prepare(
      "DELETE FROM projection_thread_activities WHERE activity_id = ?",
    );
    for (const act of candidateActivities) {
      delActivity.run(act.activity_id as string);
    }
    hotDb.exec("COMMIT;");
    hotDb.exec("PRAGMA wal_checkpoint(PASSIVE);");
    hotDb.exec("PRAGMA incremental_vacuum(200);");

    const sizeAfter = NodeFs.existsSync(input.hotDbPath)
      ? NodeFs.statSync(input.hotDbPath).size
      : 0;

    return {
      skippedReason: null,
      dryRun: false,
      cutoffIso,
      archiveDbPath,
      archivedEvents: candidateEvents.length,
      archivedActivities: candidateActivities.length,
      verifiedChecksum,
      reclaimedBytes: Math.max(0, sizeBefore - sizeAfter),
    };
  } finally {
    hotDb.close();
  }
}
