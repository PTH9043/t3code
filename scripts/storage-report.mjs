// Read-only size report for a T3 Code state database.
//
//   node scripts/storage-report.mjs "E:\NewAutoUsage\userdata\state.sqlite"
//
// Opens the database read-only, so no row, table or setting in it changes and
// it is safe while the app is running. Prints how much space each table (with
// its indexes) takes and how much is free pages that a VACUUM would return,
// and saves the same report as storage-report.json in the current directory
// (or the path given as the second argument). On a database of several GB the
// scan reads the whole file and can take a few minutes.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node scripts/storage-report.mjs "<path to state.sqlite>" [report.json]');
  process.exit(1);
}
const outPath = resolve(process.argv[3] ?? "storage-report.json");
const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql) => Object.values(db.prepare(sql).get())[0];
const pageSize = Number(one("PRAGMA page_size"));
const pageCount = Number(one("PRAGMA page_count"));
const freePages = Number(one("PRAGMA freelist_count"));

const owner = new Map(
  db
    .prepare("SELECT name, tbl_name AS tableName, type FROM sqlite_schema")
    .all()
    .map((row) => [row.name, row]),
);

let objects;
try {
  console.error("Scanning pages (this reads the whole file)...");
  objects = db
    .prepare(
      "SELECT name, SUM(pgsize) AS bytes, SUM(unused) AS unusedBytes, COUNT(*) AS pages " +
        "FROM dbstat GROUP BY name ORDER BY bytes DESC",
    )
    .all();
} catch (error) {
  console.error(`Per-table sizes are unavailable in this Node build: ${error.message}`);
  objects = [];
}

const tables = new Map();
for (const object of objects) {
  const info = owner.get(object.name);
  const table = info?.tableName ?? object.name;
  const entry = tables.get(table) ?? { table, dataMb: 0, indexMb: 0, unusedMb: 0 };
  if (info?.type === "index") entry.indexMb += Number(object.bytes);
  else entry.dataMb += Number(object.bytes);
  entry.unusedMb += Number(object.unusedBytes);
  tables.set(table, entry);
}
const byTable = [...tables.values()]
  .map((entry) => ({
    table: entry.table,
    totalMb: mb(entry.dataMb + entry.indexMb),
    dataMb: mb(entry.dataMb),
    indexMb: mb(entry.indexMb),
    unusedMb: mb(entry.unusedMb),
  }))
  .sort((left, right) => right.totalMb - left.totalMb);

// Row counts only for the largest tables: counting scans the table again.
for (const entry of byTable.slice(0, 15)) {
  if (owner.get(entry.table)?.type !== "table") continue;
  try {
    entry.rows = Number(one(`SELECT COUNT(*) FROM "${entry.table.replaceAll('"', '""')}"`));
  } catch {
    // Virtual tables whose module is missing here cannot be counted.
  }
}

const report = {
  database: dbPath,
  generatedAt: new Date().toISOString(),
  totalMb: mb(pageSize * pageCount),
  freeMb: mb(pageSize * freePages),
  pageSize,
  tables: byTable,
};
db.close();

writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Total ${report.totalMb} MB, free pages ${report.freeMb} MB (returned by VACUUM)`);
console.table(byTable.slice(0, 25));
console.log(`Saved ${outPath}`);
