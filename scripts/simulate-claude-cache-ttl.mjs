#!/usr/bin/env node
/**
 * Wave 2-B3: Read-only offline simulator comparing Claude prompt cache TTL (1h vs 5m)
 * using actual provider event logs (e.g. E:\NewAutoUsage\userdata\logs\provider\events.*).
 *
 * Reports:
 * - Inter-call gap distribution (<=5m, 5m..60m, >60m)
 * - API list-price equivalent cost (standard + >200k long-context surcharge)
 * - Per-model breakdown (Opus vs Sonnet vs Fable/Haiku)
 *
 * Note: Costs are API list-price equivalents for relative comparison only;
 * subscription plans (Pro/Max) do not bill per-token API list prices.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// Anthropic public list prices ($ / MTok)
// Base input, cache write 5m (1.25x), cache write 1h (2.0x), cache read (0.1x), output
const MODEL_PRICING = [
  { match: /opus/i, name: "opus", input: 15, out: 75 },
  { match: /sonnet/i, name: "sonnet", input: 3, out: 15 },
  { match: /fable/i, name: "fable", input: 1, out: 5 },
  { match: /haiku/i, name: "haiku", input: 0.8, out: 4 },
];

function getPricing(model) {
  for (const p of MODEL_PRICING) {
    if (p.match.test(model ?? "")) return p;
  }
  return { name: "sonnet", input: 3, out: 15 };
}

function parseArgs(argv) {
  const opts = {
    logsDir: "E:\\NewAutoUsage\\userdata\\logs\\provider",
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--logs-dir" && argv[i + 1]) {
      opts.logsDir = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--json") {
      opts.json = true;
    }
  }
  return opts;
}

function extractCallsFromFile(filePath, seenKeys) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const calls = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (
      !line.includes("cache_read_input_tokens") &&
      !line.includes("cache_creation_input_tokens")
    ) {
      continue;
    }
    const jsonStart = line.indexOf("{");
    if (jsonStart < 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line.slice(jsonStart));
    } catch {
      continue;
    }
    const ev = parsed.event ?? parsed;
    const payload = ev.payload ?? ev.raw?.payload;
    if (!payload || typeof payload !== "object") continue;

    // Only count individual assistant/message_start API calls (skip cumulative result summaries)
    if (payload.type === "result" || (!payload.message && !payload.event?.message)) continue;
    const msg = payload.message ?? payload.event?.message;
    const usage = msg?.usage;
    if (!usage || typeof usage !== "object") continue;

    const inputTok = Number(usage.input_tokens ?? 0);
    const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
    const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
    const outputTok = Number(usage.output_tokens ?? 0);
    const totalInput = inputTok + cacheRead + cacheCreate;
    if (totalInput <= 0) continue;

    const sessionId =
      payload.session_id ?? ev.providerThreadId ?? ev.threadId ?? path.basename(filePath);
    const msgId = msg?.id ?? ev.eventId ?? ev.id ?? `${sessionId}:${ev.createdAt}:${totalInput}`;
    const dedupKey = `${sessionId}|${msgId}|${totalInput}|${outputTok}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    const tsMs = Date.parse(ev.createdAt ?? parsed.observedAt ?? "");
    if (!Number.isFinite(tsMs)) continue;

    const model = msg?.model ?? payload.model ?? "unknown";
    calls.push({
      sessionId,
      tsMs,
      model,
      inputTok,
      cacheRead,
      cacheCreate,
      outputTok,
      totalInput,
    });
  }
  return calls;
}

function simulate(calls, ttlMs, longContextSurcharge) {
  const bySession = new Map();
  for (const c of calls) {
    const arr = bySession.get(c.sessionId) ?? [];
    arr.push(c);
    bySession.set(c.sessionId, arr);
  }

  const writeMult = ttlMs >= 3_600_000 ? 2.0 : 1.25;
  let totalUsd = 0;
  let coldRewrites = 0;
  const byModel = new Map();

  for (const arr of bySession.values()) {
    arr.sort((a, b) => a.tsMs - b.tsMs);
    let lastTs = null;
    for (const c of arr) {
      const p = getPricing(c.model);
      const isLong = longContextSurcharge && c.totalInput > 200_000;
      const inRate = (p.input / 1_000_000) * (isLong ? 2.0 : 1.0);
      const outRate = (p.out / 1_000_000) * (isLong ? 1.5 : 1.0);

      let effRead = c.cacheRead;
      let effWrite = c.cacheCreate;
      if (lastTs !== null && c.tsMs - lastTs > ttlMs && effRead > 0) {
        // Cache expired under simulated TTL -> previously cached prefix must be rewritten
        effWrite += effRead;
        effRead = 0;
        coldRewrites += 1;
      }
      lastTs = c.tsMs;

      const cost =
        c.inputTok * inRate +
        effWrite * inRate * writeMult +
        effRead * inRate * 0.1 +
        c.outputTok * outRate;
      totalUsd += cost;

      const entry = byModel.get(c.model) ?? { calls: 0, usd: 0 };
      entry.calls += 1;
      entry.usd += cost;
      byModel.set(c.model, entry);
    }
  }
  return { totalUsd, coldRewrites, byModel };
}

const opts = parseArgs(process.argv.slice(2));
if (!fs.existsSync(opts.logsDir)) {
  console.error(`Logs dir not found: ${opts.logsDir}`);
  process.exit(1);
}

const files = fs
  .readdirSync(opts.logsDir)
  .filter((f) => f.startsWith("events."))
  .map((f) => path.join(opts.logsDir, f));

const seenKeys = new Set();
const allCalls = [];
for (const f of files) {
  allCalls.push(...extractCallsFromFile(f, seenKeys));
}

// Compute gap distribution across sessions
const bySession = new Map();
for (const c of allCalls) {
  const arr = bySession.get(c.sessionId) ?? [];
  arr.push(c);
  bySession.set(c.sessionId, arr);
}

let gapsLe5m = 0;
let gaps5to60m = 0;
let gapsGt60m = 0;
for (const arr of bySession.values()) {
  arr.sort((a, b) => a.tsMs - b.tsMs);
  for (let i = 1; i < arr.length; i += 1) {
    const gap = arr[i].tsMs - arr[i - 1].tsMs;
    if (gap <= 300_000) gapsLe5m += 1;
    else if (gap <= 3_600_000) gaps5to60m += 1;
    else gapsGt60m += 1;
  }
}
const totalGaps = gapsLe5m + gaps5to60m + gapsGt60m;

const std1h = simulate(allCalls, 3_600_000, false);
const std5m = simulate(allCalls, 300_000, false);
const long1h = simulate(allCalls, 3_600_000, true);
const long5m = simulate(allCalls, 300_000, true);

const summary = {
  filesScanned: files.length,
  uniqueCalls: allCalls.length,
  sessions: bySession.size,
  gaps: {
    total: totalGaps,
    le5m: gapsLe5m,
    le5mPct: totalGaps > 0 ? Number(((gapsLe5m / totalGaps) * 100).toFixed(1)) : 0,
    between5mAnd60m: gaps5to60m,
    between5mAnd60mPct: totalGaps > 0 ? Number(((gaps5to60m / totalGaps) * 100).toFixed(1)) : 0,
    gt60m: gapsGt60m,
    gt60mPct: totalGaps > 0 ? Number(((gapsGt60m / totalGaps) * 100).toFixed(1)) : 0,
  },
  standardListPriceUsd: {
    ttl1h: Number(std1h.totalUsd.toFixed(2)),
    ttl5m: Number(std5m.totalUsd.toFixed(2)),
    diff5mMinus1h: Number((std5m.totalUsd - std1h.totalUsd).toFixed(2)),
    rewrites1h: std1h.coldRewrites,
    rewrites5m: std5m.coldRewrites,
  },
  withLongContextSurchargeUsd: {
    ttl1h: Number(long1h.totalUsd.toFixed(2)),
    ttl5m: Number(long5m.totalUsd.toFixed(2)),
    diff5mMinus1h: Number((long5m.totalUsd - long1h.totalUsd).toFixed(2)),
  },
  byModelStandardUsd: Object.fromEntries(
    [...new Set([...std1h.byModel.keys(), ...std5m.byModel.keys()])].sort().map((m) => {
      const a = std1h.byModel.get(m) ?? { calls: 0, usd: 0 };
      const b = std5m.byModel.get(m) ?? { calls: 0, usd: 0 };
      return [
        m,
        {
          calls: a.calls,
          ttl1hUsd: Number(a.usd.toFixed(2)),
          ttl5mUsd: Number(b.usd.toFixed(2)),
          diff5mMinus1h: Number((b.usd - a.usd).toFixed(2)),
        },
      ];
    }),
  ),
  note: "API 목록가 환산 비교치이며 Claude Pro/Max 구독의 실제 청구액이 아닙니다.",
};

if (opts.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("=== Claude 프롬프트 캐시 TTL (1시간 vs 5분) 오프라인 시뮬레이션 ===");
  console.log(
    `로그 파일: ${summary.filesScanned}개 | 고유 호출: ${summary.uniqueCalls}건 | 세션: ${summary.sessions}개`,
  );
  console.log(
    `호출 간격(${totalGaps}건): <=5분 ${gapsLe5m}건(${summary.gaps.le5mPct}%) | 5~60분 ${gaps5to60m}건(${summary.gaps.between5mAnd60mPct}%) | >60분 ${gapsGt60m}건(${summary.gaps.gt60mPct}%)`,
  );
  console.log(
    `[기본 목록가 환산] 1h: $${summary.standardListPriceUsd.ttl1h} (재쓰기 ${std1h.coldRewrites}회) vs 5m: $${summary.standardListPriceUsd.ttl5m} (재쓰기 ${std5m.coldRewrites}회) | 차이(5m-1h): ${summary.standardListPriceUsd.diff5mMinus1h >= 0 ? "+" : ""}$${summary.standardListPriceUsd.diff5mMinus1h}`,
  );
  console.log(
    `[>200k 장문맥 할증 포함] 1h: $${summary.withLongContextSurchargeUsd.ttl1h} vs 5m: $${summary.withLongContextSurchargeUsd.ttl5m} | 차이(5m-1h): ${summary.withLongContextSurchargeUsd.diff5mMinus1h >= 0 ? "+" : ""}$${summary.withLongContextSurchargeUsd.diff5mMinus1h}`,
  );
  console.log("[모델별 비교 (기본 목록가)]");
  for (const [m, d] of Object.entries(summary.byModelStandardUsd)) {
    console.log(
      `  - ${m} (${d.calls}건): 1h=$${d.ttl1hUsd} vs 5m=$${d.ttl5mUsd} (5m-1h=${d.diff5mMinus1h >= 0 ? "+" : ""}$${d.diff5mMinus1h})`,
    );
  }
  console.log(`※ ${summary.note}`);
}
