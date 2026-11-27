#!/usr/bin/env node
/**
 * 읽기 전용 그래프 검색(`WorkspaceRoutingGraph.queryMoc` / `WorkspaceRoutingGraph.promptInject`)
 * 일일 요약 CLI.
 *
 * 사용 예:
 *   node scripts/summarize-routing-moc.mjs --file E:\NewAutoUsage\userdata\logs\server.trace.ndjson [--hours 24] [--json]
 */

import * as fs from "node:fs";
import * as path from "node:path";

function parseArgs(argv) {
  const args = {
    file: path.join("E:\\NewAutoUsage", "userdata", "logs", "server.trace.ndjson"),
    maxFiles: 10,
    hours: 24,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--file" && argv[i + 1]) {
      args.file = argv[++i];
    } else if (tok === "--max-files" && argv[i + 1]) {
      args.maxFiles = Math.max(0, Number.parseInt(argv[++i], 10) || 10);
    } else if (tok === "--hours" && argv[i + 1]) {
      args.hours = Math.max(0, Number(argv[++i]) || 0);
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

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function numAttr(attrs, key) {
  const v = attrs?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function summarizeRoutingMocRecords(records) {
  const durations = [];
  let queryCount = 0;
  let zeroSeedCount = 0;
  let renderedNonEmptyCount = 0;
  let totalRenderedChars = 0;
  let totalPointerNodes = 0;

  const channelHits = { file: 0, symbol: 0, keyword: 0, fts: 0 };
  const channelSeedsSum = { file: 0, symbol: 0, keyword: 0, fts: 0 };
  const primaryKindCounts = {};

  let promptInjectSpans = 0;
  let promptInjectedCount = 0;
  let promptInjectedCharsSum = 0;

  for (const rec of records) {
    const attrs = rec?.attributes ?? {};
    if (rec?.name === "WorkspaceRoutingGraph.queryMoc") {
      queryCount += 1;
      const elapsed =
        typeof attrs["routing.elapsed_ms"] === "number"
          ? attrs["routing.elapsed_ms"]
          : typeof rec.durationMs === "number"
            ? rec.durationMs
            : 0;
      durations.push(elapsed);

      const seedCount = numAttr(attrs, "routing.seed_count");
      if (seedCount === 0) zeroSeedCount += 1;

      const fileC = numAttr(attrs, "routing.seed_file_count");
      const symC = numAttr(attrs, "routing.seed_symbol_count");
      const kwC = numAttr(attrs, "routing.seed_keyword_count");
      const ftsC = numAttr(attrs, "routing.seed_fts_count");
      if (fileC > 0) channelHits.file += 1;
      if (symC > 0) channelHits.symbol += 1;
      if (kwC > 0) channelHits.keyword += 1;
      if (ftsC > 0) channelHits.fts += 1;
      channelSeedsSum.file += fileC;
      channelSeedsSum.symbol += symC;
      channelSeedsSum.keyword += kwC;
      channelSeedsSum.fts += ftsC;

      const kind =
        typeof attrs["routing.primary_node_kind"] === "string"
          ? attrs["routing.primary_node_kind"]
          : "unknown";
      primaryKindCounts[kind] = (primaryKindCounts[kind] ?? 0) + 1;

      const chars = numAttr(attrs, "routing.rendered_moc_chars");
      if (chars > 0) renderedNonEmptyCount += 1;
      totalRenderedChars += chars;
      totalPointerNodes += numAttr(attrs, "routing.pointer_nodes_count");
    } else if (rec?.name === "WorkspaceRoutingGraph.promptInject") {
      promptInjectSpans += 1;
      if (attrs["routing.prompt_injected"] === true) {
        promptInjectedCount += 1;
        promptInjectedCharsSum += numAttr(attrs, "routing.prompt_injected_chars");
      }
    }
  }

  durations.sort((a, b) => a - b);
  const pct = (n, denom) => (denom > 0 ? Number(((n / denom) * 100).toFixed(1)) : 0);

  return {
    queryCount,
    zeroSeedCount,
    zeroSeedRatePct: pct(zeroSeedCount, queryCount),
    renderedNonEmptyCount,
    renderedNonEmptyRatePct: pct(renderedNonEmptyCount, queryCount),
    avgRenderedChars: queryCount > 0 ? Math.round(totalRenderedChars / queryCount) : 0,
    avgPointerNodes: queryCount > 0 ? Number((totalPointerNodes / queryCount).toFixed(2)) : 0,
    channels: {
      file: {
        hits: channelHits.file,
        hitRatePct: pct(channelHits.file, queryCount),
        totalSeeds: channelSeedsSum.file,
      },
      symbol: {
        hits: channelHits.symbol,
        hitRatePct: pct(channelHits.symbol, queryCount),
        totalSeeds: channelSeedsSum.symbol,
      },
      keyword: {
        hits: channelHits.keyword,
        hitRatePct: pct(channelHits.keyword, queryCount),
        totalSeeds: channelSeedsSum.keyword,
      },
      fts: {
        hits: channelHits.fts,
        hitRatePct: pct(channelHits.fts, queryCount),
        totalSeeds: channelSeedsSum.fts,
      },
    },
    primaryKindCounts,
    latencyMs: {
      median: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.length > 0 ? Number(durations[durations.length - 1].toFixed(2)) : 0,
    },
    promptInjection: {
      observedSpans: promptInjectSpans,
      injectedCount: promptInjectedCount,
      injectedRatePct: pct(promptInjectedCount, promptInjectSpans),
      avgInjectedChars:
        promptInjectedCount > 0 ? Math.round(promptInjectedCharsSum / promptInjectedCount) : 0,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = collectRotatedPaths(args.file, args.maxFiles);
  const cutoffMs = args.hours > 0 ? Date.now() - args.hours * 3_600_000 : 0;
  const matched = [];
  let parseErrors = 0;

  for (const fp of files) {
    const text = fs.readFileSync(fp, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (
        !trimmed.includes("WorkspaceRoutingGraph.queryMoc") &&
        !trimmed.includes("WorkspaceRoutingGraph.promptInject")
      ) {
        continue;
      }
      try {
        const rec = JSON.parse(trimmed);
        if (cutoffMs > 0 && rec.endTimeUnixNano) {
          const endMs = Number(BigInt(String(rec.endTimeUnixNano)) / 1_000_000n);
          if (Number.isFinite(endMs) && endMs < cutoffMs) continue;
        }
        matched.push(rec);
      } catch {
        parseErrors += 1;
      }
    }
  }

  const summary = {
    filesScanned: files,
    parseErrors,
    ...summarizeRoutingMocRecords(matched),
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(
    `=== 그래프 검색(queryMoc) 일일 요약 (${summary.queryCount}회, 파일 ${files.length}개) ===`,
  );
  console.log(
    `시작점 0건: ${summary.zeroSeedCount}회 (${summary.zeroSeedRatePct}%) | MoC 생성: ${summary.renderedNonEmptyCount}회 (${summary.renderedNonEmptyRatePct}%) | 평균 길이: ${summary.avgRenderedChars}자`,
  );
  console.log(
    `시간: 중앙값 ${summary.latencyMs.median}ms | p95 ${summary.latencyMs.p95}ms | 최대 ${summary.latencyMs.max}ms`,
  );
  console.log(
    `경로별 기여: 파일 ${summary.channels.file.hitRatePct}% (${summary.channels.file.hits}) | 심볼 ${summary.channels.symbol.hitRatePct}% (${summary.channels.symbol.hits}) | 키워드 ${summary.channels.keyword.hitRatePct}% (${summary.channels.keyword.hits}) | 전문 ${summary.channels.fts.hitRatePct}% (${summary.channels.fts.hits})`,
  );
  console.log(
    `프롬프트 주입: ${summary.promptInjection.injectedCount}/${summary.promptInjection.observedSpans} (${summary.promptInjection.injectedRatePct}%, 평균 ${summary.promptInjection.avgInjectedChars}자)`,
  );
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isDirect) {
  main();
}
