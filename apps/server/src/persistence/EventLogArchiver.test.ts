// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { rotateAgedEventsToColdArchive } from "./EventLogArchiver.ts";

describe("Phase 5 — EventLogArchiver (Hot/Cold SQLite Rotation)", () => {
  it("verifies checksum, moves aged completed-thread events/activities to cold SQLite archive, and preserves recent/active threads", () => {
    const tmpDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-archiver-test-"));
    try {
      const hotPath = NodePath.join(tmpDir, "state.sqlite");
      const archiveDir = NodePath.join(tmpDir, "archives");
      const db = new NodeSqlite.DatabaseSync(hotPath);
      db.exec(`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE TABLE orchestration_events (
          sequence INTEGER PRIMARY KEY,
          event_id TEXT NOT NULL,
          aggregate_kind TEXT NOT NULL,
          stream_id TEXT NOT NULL,
          stream_version INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          command_id TEXT,
          causation_event_id TEXT,
          correlation_id TEXT,
          actor_kind TEXT,
          payload_json TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE projection_thread_activities (
          activity_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          tone TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          sequence INTEGER,
          created_at TEXT NOT NULL
        );
      `);

      const nowMs = Date.parse("2026-11-26T12:00:00.000Z");
      const oldIso = "2026-10-01T00:00:00.000Z";
      const recentIso = "2026-11-25T00:00:00.000Z";

      db.prepare("INSERT INTO projection_threads VALUES (?, ?, NULL)").run("thr-old", oldIso);
      db.prepare("INSERT INTO projection_threads VALUES (?, ?, NULL)").run("thr-active", recentIso);

      // Aged event on old thread -> should archive
      db.prepare(
        "INSERT INTO orchestration_events VALUES (1, 'ev-1', 'thread', 'thr-old', 1, 'thread.turn.completed', ?, NULL, NULL, NULL, 'system', '{\"big\":\"old\"}', '{}')",
      ).run(oldIso);
      // Aged event on STILL-ACTIVE thread -> MUST STAY in hot DB
      db.prepare(
        "INSERT INTO orchestration_events VALUES (2, 'ev-2', 'thread', 'thr-active', 1, 'thread.turn.completed', ?, NULL, NULL, NULL, 'system', '{\"keep\":true}', '{}')",
      ).run(oldIso);
      // Recent event -> MUST STAY
      db.prepare(
        "INSERT INTO orchestration_events VALUES (3, 'ev-3', 'thread', 'thr-active', 2, 'thread.turn.completed', ?, NULL, NULL, NULL, 'system', '{\"recent\":true}', '{}')",
      ).run(recentIso);

      db.prepare(
        "INSERT INTO projection_thread_activities VALUES ('act-1', 'thr-old', NULL, 'tool.completed', 'old', 'info', '{\"old\":1}', 1, ?)",
      ).run(oldIso);
      db.prepare(
        "INSERT INTO projection_thread_activities VALUES ('act-2', 'thr-active', NULL, 'tool.completed', 'recent', 'info', '{\"keep\":1}', 2, ?)",
      ).run(recentIso);
      db.close();

      // Safety gate: skips when activeWorkCount > 0
      const blocked = rotateAgedEventsToColdArchive({
        hotDbPath: hotPath,
        archiveDir,
        nowMs,
        activeWorkCount: 1,
      });
      expect(blocked.skippedReason).toBe("active-work-nonzero");

      // Dry run counts accurately without touching files
      const dry = rotateAgedEventsToColdArchive({
        hotDbPath: hotPath,
        archiveDir,
        nowMs,
        dryRun: true,
      });
      expect(dry.archivedEvents).toBe(1);
      expect(dry.archivedActivities).toBe(1);
      expect(NodeFs.existsSync(dry.archiveDbPath)).toBe(false);

      // Real run archives & verifies checksum
      const real = rotateAgedEventsToColdArchive({
        hotDbPath: hotPath,
        archiveDir,
        nowMs,
        dryRun: false,
      });
      expect(real.skippedReason).toBeNull();
      expect(real.archivedEvents).toBe(1);
      expect(real.archivedActivities).toBe(1);
      expect(real.verifiedChecksum).toMatch(/^[a-f0-9]{16}$/);
      expect(NodeFs.existsSync(real.archiveDbPath)).toBe(true);

      // Verify hot DB kept active/recent rows and pruned archived rows
      const hotVerify = new NodeSqlite.DatabaseSync(hotPath, { readOnly: true });
      expect(hotVerify.prepare("SELECT count(*) AS c FROM orchestration_events").get()?.c).toBe(2);
      expect(
        hotVerify.prepare("SELECT count(*) AS c FROM projection_thread_activities").get()?.c,
      ).toBe(1);
      hotVerify.close();

      // Verify cold archive DB holds exact lossless payload
      const coldVerify = new NodeSqlite.DatabaseSync(real.archiveDbPath, { readOnly: true });
      const evRow = coldVerify
        .prepare(
          "SELECT event_id, payload_json FROM archived_orchestration_events WHERE sequence = 1",
        )
        .get();
      expect(evRow).toEqual({ event_id: "ev-1", payload_json: '{"big":"old"}' });
      const actRow = coldVerify
        .prepare(
          "SELECT activity_id, payload_json FROM archived_thread_activities WHERE activity_id = 'act-1'",
        )
        .get();
      expect(actRow).toEqual({ activity_id: "act-1", payload_json: '{"old":1}' });
      coldVerify.close();
    } finally {
      NodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
