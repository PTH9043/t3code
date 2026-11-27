#!/usr/bin/env node
/**
 * 읽기 전용 메모리 회전 로그(`userdata/logs/memory.ndjson*`) 요약 CLI.
 *
 * 출력 항목:
 * - 전체 기간, 샘플 수, 최대 힙/RSS/이벤트 루프 p99
 * - 시간대별(1시간 버킷) 최대 힙, 평균 힙, 순증가 속도(MB/분)
 * - 급증 구간 Top 5 (구간 증가량·속도 MB/분 + 해당 시점 1초 이상 작업 slowOpsTop5)
 *
 * 사용 예:
 *   node scripts/summarize-memory-log.mjs --file E:\NewAutoUsage\userdata\logs\memory.ndjson [--hours 24] [--json]
 */

import * as fs from "node:fs";
import * as path from "node:path";

function parseArgs(argv) {
  const args = {
    file: path.join("E:\\NewAutoUsage", "userdata", "logs", "memory.ndjson"),
    maxFiles: 5,
    hours: 24,
    spikeLimit: 5,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--file" && argv[i + 1]) {
      args.file = argv[++i];
    } else if (tok === "--max-files" && argv[i + 1]) {
      args.maxFiles = Math.max(0, Number.parseInt(argv[++i], 10) || 5);
    } else if (tok === "--hours" && argv[i + 1]) {
      args.hours = Math.max(0, Number(argv[++i]) || 0);
    } else if (tok === "--spikes" && argv[i + 1]) {
      args.spikeLimit = Math.max(1, Number.parseInt(argv[++i], 10) || 5);
    } else if (tok === "--json") {
      args.json = true;
    }
  }
  return args;
}

function collectRotatedPaths(basePath, maxFiles) {
  const paths = [];
  for (let i = maxFiles; i >= 1; i -= 1) {
    const p = `${basePath}.${i}`;
    if (fs.existsSync(p)) paths.push(p);
  }
  if (fs.existsSync(basePath)) paths.push(basePath);
  return paths;
}

export function summarizeMemorySamples(samples, options = {}) {
  const spikeLimit = options.spikeLimit ?? 5;
  const sorted = [...samples]
    .filter((s) => typeof s.tsMs === "number" && typeof s.heapUsedMB === "number")
    .sort((a, b) => a.tsMs - b.tsMs);

  if (sorted.length === 0) {
    return {
      sampleCount: 0,
      firstTs: null,
      lastTs: null,
      maxHeapUsedMB: 0,
      maxRssMB: 0,
      maxEventLoopP99Ms: 0,
      overallGrowthMBPerMin: 0,
      hourlyBuckets: [],
      topSpikes: [],
    };
  }

  let maxHeapUsedMB = 0;
  let maxRssMB = 0;
  let maxEventLoopP99Ms = 0;
  const hourlyMap = new Map();

  for (const s of sorted) {
    if (s.heapUsedMB > maxHeapUsedMB) maxHeapUsedMB = s.heapUsedMB;
    if ((s.rssMB ?? 0) > maxRssMB) maxRssMB = s.rssMB ?? 0;
    if ((s.eventLoopP99Ms ?? 0) > maxEventLoopP99Ms) maxEventLoopP99Ms = s.eventLoopP99Ms ?? 0;

    const hourKey = new Date(s.tsMs).toISOString().slice(0, 13) + ":00Z";
    const bucket = hourlyMap.get(hourKey) ?? {
      hour: hourKey,
      count: 0,
      maxHeapMB: 0,
      sumHeapMB: 0,
      firstHeapMB: s.heapUsedMB,
      firstTsMs: s.tsMs,
      lastHeapMB: s.heapUsedMB,
      lastTsMs: s.tsMs,
      maxEventLoopP99Ms: 0,
    };
    bucket.count += 1;
    bucket.sumHeapMB += s.heapUsedMB;
    if (s.heapUsedMB > bucket.maxHeapMB) bucket.maxHeapMB = s.heapUsedMB;
    if ((s.eventLoopP99Ms ?? 0) > bucket.maxEventLoopP99Ms) {
      bucket.maxEventLoopP99Ms = s.eventLoopP99Ms ?? 0;
    }
    bucket.lastHeapMB = s.heapUsedMB;
    bucket.lastTsMs = s.tsMs;
    hourlyMap.set(hourKey, bucket);
  }

  const hourlyBuckets = [...hourlyMap.values()].map((b) => {
    const dtMin = Math.max(0.01, (b.lastTsMs - b.firstTsMs) / 60_000);
    const growthMBPerMin =
      b.count > 1 ? Number(((b.lastHeapMB - b.firstHeapMB) / dtMin).toFixed(2)) : 0;
    return {
      hour: b.hour,
      samples: b.count,
      maxHeapMB: Number(b.maxHeapMB.toFixed(1)),
      avgHeapMB: Number((b.sumHeapMB / b.count).toFixed(1)),
      growthMBPerMin,
      maxEventLoopP99Ms: Number(b.maxEventLoopP99Ms.toFixed(2)),
    };
  });

  // 인접 샘플(동일 PID) 간 힙 급증 구간 탐지
  const spikes = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev.pid && curr.pid && prev.pid !== curr.pid) continue;
    const dtMin = (curr.tsMs - prev.tsMs) / 60_000;
    if (dtMin <= 0 || dtMin > 30) continue;
    const deltaMB = curr.heapUsedMB - prev.heapUsedMB;
    if (deltaMB <= 0) continue;
    const rateMBPerMin = deltaMB / dtMin;
    spikes.push({
      fromTs: prev.ts,
      toTs: curr.ts,
      pid: curr.pid ?? null,
      fromHeapMB: prev.heapUsedMB,
      toHeapMB: curr.heapUsedMB,
      deltaMB: Number(deltaMB.toFixed(1)),
      rateMBPerMin: Number(rateMBPerMin.toFixed(2)),
      activeWorkTotal: curr.activeWorkTotal ?? 0,
      providerSessions: curr.providerSessions ?? -1,
      slowOpsTop5: Array.isArray(curr.slowOpsTop5) ? curr.slowOpsTop5 : [],
    });
  }
  spikes.sort((a, b) => b.deltaMB - a.deltaMB || b.rateMBPerMin - a.rateMBPerMin);

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const totalMin = (last.tsMs - first.tsMs) / 60_000;
  const overallGrowthMBPerMin =
    totalMin > 0 && first.pid === last.pid
      ? Number(((last.heapUsedMB - first.heapUsedMB) / totalMin).toFixed(2))
      : 0;

  return {
    sampleCount: sorted.length,
    firstTs: first.ts,
    lastTs: last.ts,
    maxHeapUsedMB: Number(maxHeapUsedMB.toFixed(1)),
    maxRssMB: Number(maxRssMB.toFixed(1)),
    maxEventLoopP99Ms: Number(maxEventLoopP99Ms.toFixed(2)),
    overallGrowthMBPerMin,
    hourlyBuckets,
    topSpikes: spikes.slice(0, spikeLimit),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = collectRotatedPaths(args.file, args.maxFiles);
  const samples = [];
  let parseErrors = 0;

  const cutoffMs = args.hours > 0 ? Date.now() - args.hours * 3_600_000 : 0;
  for (const fp of files) {
    const text = fs.readFileSync(fp, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (cutoffMs > 0 && typeof obj.tsMs === "number" && obj.tsMs < cutoffMs) continue;
        samples.push(obj);
      } catch {
        parseErrors += 1;
      }
    }
  }

  const summary = {
    filesScanned: files,
    parseErrors,
    ...summarizeMemorySamples(samples, { spikeLimit: args.spikeLimit }),
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(
    `=== 메모리 로그 요약 (${summary.sampleCount}건, 파일 ${files.length}개, 파싱 오류 ${parseErrors}건) ===`,
  );
  console.log(`기간: ${summary.firstTs ?? "-"} ~ ${summary.lastTs ?? "-"}`);
  console.log(
    `최대 힙: ${summary.maxHeapUsedMB} MB | 최대 RSS: ${summary.maxRssMB} MB | 최대 EL p99: ${summary.maxEventLoopP99Ms} ms | 전체 증가율: ${summary.overallGrowthMBPerMin} MB/분`,
  );
  console.log("\n[시간대별 최대 힙 및 증가 속도]");
  for (const b of summary.hourlyBuckets) {
    console.log(
      `  ${b.hour}: max=${b.maxHeapMB}MB avg=${b.avgHeapMB}MB rate=${b.growthMBPerMin}MB/m elP99=${b.maxEventLoopP99Ms}ms (n=${b.samples})`,
    );
  }
  console.log("\n[힙 급증 구간 Top " + args.spikeLimit + "]");
  for (const sp of summary.topSpikes) {
    const ops =
      sp.slowOpsTop5.map((o) => `${o.name}(${o.maxMs}ms×${o.count})`).join(", ") || "없음";
    console.log(
      `  ${sp.fromTs} → ${sp.toTs}: ${sp.fromHeapMB}→${sp.toHeapMB}MB (+${sp.deltaMB}MB, ${sp.rateMBPerMin}MB/m) | 작업: ${ops}`,
    );
  }
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isDirect) {
  main();
}
