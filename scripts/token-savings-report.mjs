#!/usr/bin/env node
/**
 * Read-only token efficiency & subordinate delegation report against T3's `state.sqlite`.
 * Usage: node scripts/token-savings-report.mjs [path/to/state.sqlite]
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dbPath = process.argv[2] || "E:/NewAutoUsage/userdata/state.sqlite";
const db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });

function weightedInput(provider, counts) {
  const p = String(provider || "").toLowerCase();
  const isClaude = p.includes("claude");
  const alpha5m = isClaude ? 1.25 : 1.0;
  const alpha1h = isClaude ? 2.0 : 1.0;
  const beta = isClaude ? 0.1 : 0.25;
  const gamma = 5.0;
  const input = counts.input || 0;
  const cr = counts.cacheRead || 0;
  const cw5 = counts.cacheWrite5m ?? (counts.cacheWrite || 0);
  const cw1 = counts.cacheWrite1h || 0;
  const uncached = Math.max(0, input - cr - cw5 - cw1);
  const outRsn = (counts.output || 0) + (counts.reasoning || 0);
  return Math.round(uncached + alpha5m * cw5 + alpha1h * cw1 + beta * cr + gamma * outRsn);
}

const rows = db
  .prepare(
    `SELECT r.work_id, r.node_id, r.has_native_children, s.provider, s.model, s.counts_json
     FROM projection_token_usage_samples s
     LEFT JOIN projection_token_usage_requests r ON s.request_id = r.request_id`,
  )
  .all();

const byRole = new Map();
const byModel = new Map();

for (const row of rows) {
  const role = row.node_id
    ? String(row.node_id).startsWith("delegate-")
      ? "delegate"
      : "workflow"
    : "root";
  const c = JSON.parse(row.counts_json || "{}");
  const w = weightedInput(row.provider, c);

  const accumulate = (map, key) => {
    const cur = map.get(key) || {
      runs: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
      reasoning: 0,
      weighted: 0,
    };
    cur.runs += 1;
    cur.input += c.input || 0;
    cur.cacheRead += c.cacheRead || 0;
    cur.cacheWrite5m += c.cacheWrite5m ?? (c.cacheWrite || 0);
    cur.cacheWrite1h += c.cacheWrite1h || 0;
    cur.output += c.output || 0;
    cur.reasoning += c.reasoning || 0;
    cur.weighted += w;
    map.set(key, cur);
  };

  accumulate(byRole, role);
  accumulate(byModel, `${role} | ${row.provider} | ${row.model}`);
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const pct = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "n/a");

console.log(`=== T3 Token & Delegation Efficiency Report (${rows.length} samples) ===`);
console.log("\n[1] By Execution Role");
for (const [role, s] of byRole.entries()) {
  console.log(
    `  ${role.padEnd(10)} runs=${String(s.runs).padStart(5)} | hit=${pct(s.cacheRead, s.input).padStart(6)} | rsn/out=${pct(s.reasoning, s.output).padStart(6)} | W_m=${fmt(s.weighted)} | cw5m=${fmt(s.cacheWrite5m)} | cw1h=${fmt(s.cacheWrite1h)}`,
  );
}

console.log("\n[2] Top 15 Models by Weighted Input-Equivalent Tokens (W_m)");
const top = [...byModel.entries()].sort((a, b) => b[1].weighted - a[1].weighted).slice(0, 15);
for (const [key, s] of top) {
  console.log(
    `  ${key.padEnd(46)} n=${String(s.runs).padStart(4)} | hit=${pct(s.cacheRead, s.input).padStart(6)} | rsn/out=${pct(s.reasoning, s.output).padStart(6)} | W_m=${fmt(s.weighted)}`,
  );
}

db.close();
