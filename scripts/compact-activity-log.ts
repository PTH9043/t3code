// Shrinks tool output already stored in a T3 Code state database to what the
// server keeps for new activity (see compactActivityData). Messages, plans and
// every other table are left alone.
//
//   node scripts/compact-activity-log.ts "<state.sqlite>"
//       Dry run: reads only and reports how much would be saved. Safe while
//       the server runs.
//   node scripts/compact-activity-log.ts "<state.sqlite>" --apply
//       Rewrites oversized rows. Stop the server first: the run refuses to
//       start while anything else has the file open. The rewrite cannot be
//       undone. The file keeps its size; the freed pages are reused.
//   node scripts/compact-activity-log.ts "<state.sqlite>" --apply --vacuum
//       Also rebuilds the file so the space returns to the disk. The rewritten
//       previous file stays next to it as "<name>.before-compact" until you
//       delete it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  ACTIVITY_TEXT_LIMIT,
  compactActivityData,
} from "../apps/server/src/orchestration/activityDataCompaction.ts";

const dbPath = process.argv[2];
const flags = new Set(process.argv.slice(3));
const apply = flags.has("--apply");
const vacuum = flags.has("--vacuum");
if (!dbPath || [...flags].some((flag) => flag !== "--apply" && flag !== "--vacuum")) {
  console.error(
    'Usage: node scripts/compact-activity-log.ts "<state.sqlite>" [--apply] [--vacuum]',
  );
  process.exit(1);
}
if (vacuum && !apply) {
  console.error("--vacuum needs --apply.");
  process.exit(1);
}

const TOOL_KINDS = new Set(["tool.updated", "tool.completed"]);
type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;

/** Each table that stores tool activity, and where its payload lives in the row's JSON. */
const targets = [
  {
    table: "projection_thread_activities",
    key: "rowid",
    where: "kind IN ('tool.updated', 'tool.completed')",
    payload: (row: Json) => row,
  },
  {
    table: "orchestration_events",
    key: "sequence",
    where: "event_type = 'thread.activity-appended'",
    payload: (row: Json) => {
      const activity = record(row.activity);
      return activity && TOOL_KINDS.has(String(activity.kind))
        ? record(activity.payload)
        : undefined;
    },
  },
] as const;

const KEY_RANGE = 20_000;
const ROWS_PER_TRANSACTION = 100;
const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const fileSize = (path: string) => (NodeFS.existsSync(path) ? NodeFS.statSync(path).size : 0);
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const compactPath = `${dbPath}.compact`;
const previousPath = `${dbPath}.before-compact`;
const sizeBefore = fileSize(dbPath);
if (vacuum) {
  // Checked before any row changes, so a run never rewrites and then cannot finish.
  if (NodeFS.existsSync(previousPath)) {
    fail(`${previousPath} already exists. Delete it or move it away first.`);
  }
  const disk = NodeFS.statfsSync(NodePath.dirname(NodePath.resolve(dbPath)));
  if (disk.bavail * disk.bsize < sizeBefore) {
    fail(`Not enough free space next to the database to rebuild it (${gb(sizeBefore)} needed).`);
  }
}

const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: !apply });
if (apply) {
  try {
    // Only succeeds when no other process has the database open. A running
    // server would lose writes behind this script's write lock.
    db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; COMMIT");
  } catch (error) {
    fail(`The database is in use (${(error as Error).message}). Stop the server first.`);
  }
}

let savedBytes = 0;
let rewrittenRows = 0;

for (const target of targets) {
  const maxKey = Number(
    Object.values(db.prepare(`SELECT MAX(${target.key}) FROM ${target.table}`).get() ?? {})[0] ?? 0,
  );
  const oversized = db.prepare(
    `SELECT ${target.key} AS id FROM ${target.table}
     WHERE ${target.key} > ? AND ${target.key} <= ? AND ${target.where}
       AND LENGTH(payload_json) > ${ACTIVITY_TEXT_LIMIT}`,
  );
  const read = db.prepare(
    `SELECT payload_json AS json FROM ${target.table} WHERE ${target.key} = ? AND ${target.where}`,
  );
  const write = apply
    ? db.prepare(`UPDATE ${target.table} SET payload_json = ? WHERE ${target.key} = ?`)
    : undefined;
  let tableSaved = 0;
  let tableRows = 0;

  for (let from = 0; from < maxKey; from += KEY_RANGE) {
    const ids = oversized.all(from, from + KEY_RANGE).map((row) => Number(row.id));
    for (let start = 0; start < ids.length; start += ROWS_PER_TRANSACTION) {
      if (apply) db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of ids.slice(start, start + ROWS_PER_TRANSACTION)) {
          const json = read.get(id)?.json;
          if (typeof json !== "string") continue;
          const row = record(JSON.parse(json));
          const payload = row && target.payload(row);
          if (!payload) continue;
          const data = compactActivityData(payload.data);
          if (data === payload.data) continue;
          payload.data = data;
          const next = JSON.stringify(row);
          write?.run(next, id);
          tableSaved += Buffer.byteLength(json) - Buffer.byteLength(next);
          tableRows += 1;
        }
        if (apply) db.exec("COMMIT");
      } catch (error) {
        if (apply) db.exec("ROLLBACK");
        throw error;
      }
    }
    if ((from / KEY_RANGE) % 10 === 9) {
      console.error(
        `${target.table}: ${Math.min(from + KEY_RANGE, maxKey)}/${maxKey}, ${gb(tableSaved)}`,
      );
    }
  }
  console.log(
    `${target.table}: ${tableRows} rows ${apply ? "rewritten" : "would be rewritten"}, ${gb(tableSaved)} of tool output removed`,
  );
  savedBytes += tableSaved;
  rewrittenRows += tableRows;
}

if (!vacuum) {
  db.close();
  console.log(
    apply
      ? `Done: ${rewrittenRows} rows, ${gb(savedBytes)} freed inside the file. Run again with --vacuum to shrink the file itself.`
      : `Dry run: ${rewrittenRows} rows, ${gb(savedBytes)} would be removed. Nothing was changed.`,
  );
  process.exit(0);
}

// Rebuild into a new file and swap, so the rewritten file stays whole until the copy is verified.
NodeFS.rmSync(compactPath, { force: true });
const CONTENT_COLUMNS: Record<string, string> = {
  orchestration_events: "payload_json",
  projection_thread_activities: "payload_json",
  projection_thread_messages: "text",
};
// Row count and rowid range of every table, plus the stored length of the
// conversation tables. The server keeps rowids of tables without an integer
// key as cursors (memory progress, semantic index jobs), so the rebuilt file
// must carry the same ones; VACUUM INTO preserves them where a plain VACUUM
// may renumber.
const fingerprint = (database: NodeSqlite.DatabaseSync) =>
  database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name",
    )
    .all()
    .map(({ name }) => {
      const table = `"${String(name).replaceAll('"', '""')}"`;
      const first = (sql: string) => Object.values(database.prepare(sql).get() ?? {}).join("/");
      const content = CONTENT_COLUMNS[String(name)];
      try {
        return `${name}=${first(
          `SELECT COUNT(*), MAX(rowid), TOTAL(rowid)${content ? `, TOTAL(LENGTH(${content}))` : ""} FROM ${table}`,
        )}`;
      } catch {
        // WITHOUT ROWID tables have no rowid to compare.
        return `${name}=${first(`SELECT COUNT(*) FROM ${table}`)}`;
      }
    })
    .join("\n");

console.error("Rebuilding the file...");
const expected = fingerprint(db);
db.exec(`VACUUM INTO '${compactPath.replaceAll("'", "''")}'`);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
if (fileSize(`${dbPath}-wal`) > 0) {
  fail(
    `${dbPath}-wal still holds changes after closing, so the files were not swapped. The database is intact; the rebuilt copy is at ${compactPath}.`,
  );
}

const rebuilt = new NodeSqlite.DatabaseSync(compactPath, { readOnly: true });
const check = String(Object.values(rebuilt.prepare("PRAGMA quick_check").get() ?? {})[0]);
const actual = fingerprint(rebuilt);
rebuilt.close();
if (check !== "ok" || actual !== expected) {
  const expectedLines = expected.split("\n");
  const differing = actual.split("\n").filter((line, index) => line !== expectedLines[index]);
  fail(
    `The rebuilt file failed verification (check: ${check}; differing tables: ${differing.join(", ") || "none"}). The database is intact; the rebuilt copy is at ${compactPath}.`,
  );
}

/** Windows scanners briefly hold freshly written files open; a rename then fails with EPERM/EBUSY. */
const renameWithRetry = (from: string, to: string) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      NodeFS.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt === 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
};
renameWithRetry(dbPath, previousPath);
try {
  renameWithRetry(compactPath, dbPath);
} catch (error) {
  // Never leave the database path empty: the server would create a new one there.
  renameWithRetry(previousPath, dbPath);
  fail(
    `Could not move the rebuilt file into place (${(error as Error).message}). The database was put back; the rebuilt copy is at ${compactPath}.`,
  );
}
for (const suffix of ["-wal", "-shm"]) NodeFS.rmSync(`${dbPath}${suffix}`, { force: true });
console.log(
  `Done: ${rewrittenRows} rows, ${gb(savedBytes)} of tool output removed. File ${gb(sizeBefore)} -> ${gb(fileSize(dbPath))}.`,
);
console.log(
  `The previous file is kept at ${previousPath}; delete it once the server has started cleanly.`,
);
