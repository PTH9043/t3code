import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { summarize, validateJob } from "./job.mjs";

const build = JSON.parse(NodeFS.readFileSync(new URL("./build.json", import.meta.url), "utf8"));
const dataDir = process.env.BOT_DATA_DIR ?? "/data";
NodeFS.mkdirSync(dataDir, { recursive: true });
const database = new NodeSqlite.DatabaseSync(NodePath.join(dataDir, "bot.sqlite"));
database.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA busy_timeout=1000;
  PRAGMA cache_size=-512;
  CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    source TEXT NOT NULL, inputs TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);
const bootId = NodeCrypto.randomUUID();
const emit = (event) => {
  const receipt = { at: new Date().toISOString(), bootId, ...event };
  console.log(JSON.stringify(receipt));
  process.send?.(receipt);
};
const increment = database.prepare(`
  INSERT INTO counters(name, value) VALUES (?, 1)
  ON CONFLICT(name) DO UPDATE SET value=value+1 RETURNING value
`);
const counter = (name) =>
  database.prepare("SELECT value FROM counters WHERE name=?").get(name)?.value ?? 0;
const getJob = (id) => database.prepare("SELECT * FROM jobs WHERE id=?").get(id);
let lastProgress = performance.now();
let completedThisBoot = 0;
let lastJobAt = null;
let closing = false;
const progressWaiters = new Set();

function executeJob(job, source) {
  const inputs = JSON.stringify(job.samples);
  const previous = getJob(job.id);
  if (previous) {
    if (previous.inputs !== inputs) return { conflict: true };
    return { duplicate: true, job: { id: job.id, result: JSON.parse(previous.result) } };
  }
  const result = summarize(job.samples);
  if (build.variant === "wrong-result") result.sum += 1;
  const at = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("INSERT INTO jobs(id,source,inputs,result,created_at) VALUES (?,?,?,?,?)")
      .run(job.id, source, inputs, JSON.stringify(result), at);
    increment.get(source);
    database.exec(
      "DELETE FROM jobs WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-1000 FROM jobs)",
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  lastProgress = performance.now();
  lastJobAt = at;
  completedThisBoot += 1;
  emit({ type: "job.completed", source, id: job.id, total: counter(source), result });
  for (const notify of progressWaiters) notify();
  if (counter("scheduled") % 20 === 0) database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return { duplicate: false, job: { id: job.id, result } };
}

const status = () => ({
  type: "bot.status",
  contract: 1,
  mode: "simulation",
  build,
  bootId,
  pid: process.pid,
  scheduledCompleted: counter("scheduled"),
  manualCompleted: counter("manual"),
  storedJobs: database.prepare("SELECT count(*) AS count FROM jobs").get().count,
  completedThisBoot,
  lastJobAt,
  progressLagMs: Math.round(performance.now() - lastProgress),
});
const ready = () =>
  !closing &&
  build.variant !== "incomplete" &&
  completedThisBoot >= 2 &&
  performance.now() - lastProgress < 4000;
const send = (response, code, body) => {
  response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const server = NodeHttp.createServer(async (request, response) => {
  const url = new URL(request.url, "http://bot");
  try {
    if (request.method === "GET" && url.pathname === "/health")
      return send(response, 200, { type: "bot.alive" });
    if (request.method === "GET" && url.pathname === "/status")
      return send(response, 200, status());
    if (request.method === "GET" && url.pathname === "/ready") {
      return send(response, ready() ? 200 : 503, {
        ...status(),
        type: ready() ? "bot.ready" : "bot.unready",
        reason:
          build.variant === "incomplete"
            ? "prototype_algorithm_unimplemented"
            : ready()
              ? null
              : "progress_not_ready",
      });
    }
    if (request.method === "GET" && url.pathname === "/await-progress") {
      const after = Number(url.searchParams.get("after"));
      const count = Number(url.searchParams.get("count"));
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 120
      ) {
        return send(response, 400, { error: "invalid_progress_range" });
      }
      if (progressWaiters.size >= 8) return send(response, 503, { error: "wait_capacity" });
      let timeout;
      const notify = () => {
        if (counter("scheduled") < after + count) return;
        progressWaiters.delete(notify);
        clearTimeout(timeout);
        send(response, 200, { ...status(), type: "bot.progress.reached" });
      };
      progressWaiters.add(notify);
      timeout = setTimeout(() => {
        progressWaiters.delete(notify);
        send(response, 408, { type: "bot.progress.deadline" });
      }, 130_000);
      response.on("close", () => {
        progressWaiters.delete(notify);
        clearTimeout(timeout);
      });
      notify();
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
      const job = getJob(decodeURIComponent(url.pathname.slice(6)));
      return send(
        response,
        job ? 200 : 404,
        job ? { id: job.id, result: JSON.parse(job.result) } : { error: "not_found" },
      );
    }
    if (request.method === "POST" && url.pathname === "/jobs") {
      if (!ready()) return send(response, 503, { error: "not_ready" });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16_384) {
          send(response, 413, { error: "job_too_large" });
          return;
        }
        chunks.push(chunk);
      }
      const job = validateJob(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = executeJob(job, "manual");
      if (result.conflict) return send(response, 409, { error: "idempotency_conflict" });
      return send(response, result.duplicate ? 200 : 201, result);
    }
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error?.message?.startsWith("Expected") ||
      error?.message?.startsWith("Invalid")
    ) {
      return send(response, 400, { error: "invalid_job" });
    }
    emit({ type: "job.failed", message: error instanceof Error ? error.message : String(error) });
    return send(response, 500, { error: "internal_error" });
  }
});
server.requestTimeout = 150_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 2_000;

if (process.env.BOT_FAULT_MODE === "crash-loop") {
  emit({ type: "bot.injected_crash" });
  database.close();
  process.exit(70);
}
server.listen(8080, "0.0.0.0", () => emit({ type: "bot.listening", pid: process.pid, build }));
const tick = setInterval(() => {
  if (build.variant === "incomplete") return;
  const sequence = counter("scheduled") + 1;
  executeJob({ id: `scheduled-${sequence}`, samples: [sequence % 17, 2, -1] }, "scheduled");
}, 1_000);

function stop() {
  if (closing) return;
  closing = true;
  clearInterval(tick);
  emit({ type: "bot.stopping" });
  server.close(() => {
    database.close();
    process.exit(0);
  });
  server.closeAllConnections();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
