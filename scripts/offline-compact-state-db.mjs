#!/usr/bin/env node
/**
 * Offline SQLite compaction & old command-receipt pruning for T3 Code `state.sqlite`.
 * Must run only while T3 backend is completely stopped (enforced via EXCLUSIVE lock).
 * Preserves 100% of threads, messages, memory, RAG, events, activities, and token usage.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = path.resolve(process.argv[2] || "E:/NewAutoUsage/userdata/state.sqlite");
const keepReceiptsDays = Number(process.argv[3] || "7");
const keepBackup = process.argv.includes("--keep-backup");

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const sizeOf = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);

const totalBefore = sizeOf(dbPath) + sizeOf(`${dbPath}-wal`) + sizeOf(`${dbPath}-shm`);
console.log(`[offline-compact] target=${dbPath} before=${mb(totalBefore)}`);

const db = new DatabaseSync(dbPath);
try {
  db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; COMMIT;");
} catch (error) {
  console.error(`[offline-compact] DB locked or in use: ${error.message}`);
  db.close();
  process.exit(1);
}

// 1. Prune accepted idempotency receipts older than keepReceiptsDays (never touches events/messages/memory).
const cutoffIso = new Date(Date.now() - keepReceiptsDays * 86_400_000).toISOString();
const beforeReceipts = Number(
  db.prepare("SELECT COUNT(*) AS n FROM orchestration_command_receipts").get()?.n ?? 0,
);
const pruned = db
  .prepare(
    "DELETE FROM orchestration_command_receipts WHERE status = 'accepted' AND accepted_at < ?",
  )
  .run(cutoffIso);
const afterReceipts = Number(
  db.prepare("SELECT COUNT(*) AS n FROM orchestration_command_receipts").get()?.n ?? 0,
);
console.log(
  `[offline-compact] receipts pruned=${pruned.changes} (${beforeReceipts} -> ${afterReceipts}, cutoff=${cutoffIso})`,
);

// 2. Checkpoint WAL cleanly before VACUUM INTO.
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

// Capture core table row counts to verify lossless rebuild.
const countRows = (conn, table) =>
  Number(conn.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? 0);
const verifyTables = [
  "orchestration_events",
  "projection_thread_messages",
  "projection_thread_activities",
  "workspace_memory_v2",
  "projection_workspace_knowledge_items",
  "projection_token_usage_samples",
  "orchestration_command_receipts",
];
const expectedCounts = Object.fromEntries(verifyTables.map((t) => [t, countRows(db, t)]));

const compactPath = `${dbPath}.compact`;
fs.rmSync(compactPath, { force: true });
const escaped = compactPath.replaceAll("'", "''");
console.log(`[offline-compact] running VACUUM INTO ${compactPath} ...`);
const t0 = Date.now();
db.exec(`VACUUM INTO '${escaped}';`);
console.log(`[offline-compact] VACUUM INTO finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
db.close();

// 3. Verify integrity and exact row counts on compacted file before swapping.
const checkDb = new DatabaseSync(compactPath);
const integrity = checkDb.prepare("PRAGMA quick_check").get();
const integrityValue = Object.values(integrity ?? {})[0];
if (integrityValue !== "ok") {
  checkDb.close();
  fs.rmSync(compactPath, { force: true });
  console.error(`[offline-compact] integrity check failed: ${integrityValue}`);
  process.exit(1);
}
for (const table of verifyTables) {
  const actual = countRows(checkDb, table);
  if (actual !== expectedCounts[table]) {
    checkDb.close();
    fs.rmSync(compactPath, { force: true });
    console.error(
      `[offline-compact] row count mismatch on ${table}: expected=${expectedCounts[table]} actual=${actual}`,
    );
    process.exit(1);
  }
}
checkDb.exec("PRAGMA optimize;");
checkDb.close();

// 4. Atomic swap without retaining backup (unless --keep-backup).
const previousPath = `${dbPath}.before-compact`;
fs.rmSync(previousPath, { force: true });
fs.renameSync(dbPath, previousPath);
try {
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.renameSync(compactPath, dbPath);
} catch (swapError) {
  // Roll back on swap failure.
  if (!fs.existsSync(dbPath) && fs.existsSync(previousPath)) {
    fs.renameSync(previousPath, dbPath);
  }
  console.error(`[offline-compact] swap failed: ${swapError.message}`);
  process.exit(1);
}

if (!keepBackup) {
  fs.rmSync(previousPath, { force: true });
}

const totalAfter = sizeOf(dbPath) + sizeOf(`${dbPath}-wal`) + sizeOf(`${dbPath}-shm`);
console.log(
  `[offline-compact] DONE before=${mb(totalBefore)} after=${mb(totalAfter)} saved=${mb(totalBefore - totalAfter)} backupRetained=${keepBackup}`,
);
