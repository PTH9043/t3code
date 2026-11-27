#!/usr/bin/env node
/**
 * Read-only Weekly Upstream Watcher for `stablyai/orca` (Stage 5).
 *
 * Compares the pinned Orca commit in `docs/operations/orca-upstream-manifest.json`
 * against the latest upstream release/main via GitHub REST API (or an offline fixture
 * in `--dry-run` / `--fixture <file>` mode), filters strictly to watched orchestration
 * paths while excluding non-adopted areas (SSH federation, PTY injection, bots), and
 * emits a Korean review proposal Markdown document.
 *
 * SAFETY INVARIANT:
 *   - Strictly READ-ONLY against upstream and T3 source code.
 *   - NEVER auto-patches, auto-merges, auto-commits, or modifies manifest pins.
 *
 * Usage:
 *   node scripts/watch-orca-upstream.mjs [--stdout] [--out <path>] [--dry-run] [--fixture <json>]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "docs", "operations", "orca-upstream-manifest.json");
const DEFAULT_PROPOSALS_DIR = path.join(REPO_ROOT, "docs", "operations", "orca-upstream-proposals");

function parseArgs(argv) {
  let manifestPath = DEFAULT_MANIFEST;
  let outPath = null;
  let toStdout = false;
  let dryRun = false;
  let fixturePath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--manifest" && argv[i + 1]) {
      manifestPath = path.resolve(argv[++i]);
    } else if (a === "--out" && argv[i + 1]) {
      outPath = path.resolve(argv[++i]);
    } else if (a === "--stdout") {
      toStdout = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--fixture" && argv[i + 1]) {
      fixturePath = path.resolve(argv[++i]);
    }
  }
  return { manifestPath, outPath, toStdout, dryRun, fixturePath };
}

function matchWatchedRule(filename, manifest) {
  const normalized = filename.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  for (const kw of manifest.excludedKeywords ?? []) {
    if (lower.includes(kw.toLowerCase())) {
      return { matched: false, excludedBy: kw, rule: null };
    }
  }
  for (const rule of manifest.watchedPaths ?? []) {
    const prefix = rule.prefix.replace(/\\/g, "/");
    if (normalized === prefix || normalized.startsWith(prefix)) {
      return { matched: true, excludedBy: null, rule };
    }
  }
  return { matched: false, excludedBy: null, rule: null };
}

async function fetchJson(url, token) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "t3-code-orca-upstream-watcher/1.0",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 240)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildDryRunFixture(manifest) {
  return {
    latestReleaseTag: manifest.pinned.releaseTag,
    latestReleaseUrl: `${manifest.upstream.url}/releases/tag/${manifest.pinned.releaseTag}`,
    headSha: manifest.pinned.commitSha,
    aheadBy: 2,
    commits: [
      {
        sha: "deadbeef0001",
        message: "fix(orchestration): harden mailbox delivery fencing savepoint",
        date: "2026-11-29T00:00:00Z",
      },
      {
        sha: "deadbeef0002",
        message: "feat(federation): add ssh remote relay metrics",
        date: "2026-11-29T01:00:00Z",
      },
    ],
    files: [
      {
        filename: "src/main/runtime/orchestration/db/messages/mailbox-delivery-finalization.ts",
        status: "modified",
        additions: 14,
        deletions: 3,
      },
      {
        filename: "src/main/runtime/orchestration/db/federated_dispatches.ts",
        status: "modified",
        additions: 40,
        deletions: 5,
      },
      {
        filename: "src/cli/orchestration/messages/check-keepalive.ts",
        status: "modified",
        additions: 4,
        deletions: 1,
      },
      {
        filename: "src/renderer/components/SettingsModal.tsx",
        status: "modified",
        additions: 22,
        deletions: 10,
      },
    ],
  };
}

async function loadUpstreamDiff(manifest, options) {
  if (options.fixturePath) {
    return JSON.parse(fs.readFileSync(options.fixturePath, "utf8"));
  }
  if (options.dryRun) {
    return buildDryRunFixture(manifest);
  }

  const repo = manifest.upstream.repo;
  const branch = manifest.upstream.defaultBranch || "main";
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

  let latestReleaseTag = manifest.pinned.releaseTag;
  let latestReleaseUrl = `${manifest.upstream.url}/releases`;
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, token);
    if (rel?.tag_name) latestReleaseTag = rel.tag_name;
    if (rel?.html_url) latestReleaseUrl = rel.html_url;
  } catch {
    // Keep fallback if release lookup fails or rate-limits.
  }

  const compare = await fetchJson(
    `https://api.github.com/repos/${repo}/compare/${manifest.pinned.commitSha}...${branch}`,
    token,
  );

  return {
    latestReleaseTag,
    latestReleaseUrl,
    headSha: compare?.commits?.at(-1)?.sha ?? manifest.pinned.commitSha,
    aheadBy: Number(compare?.ahead_by ?? 0),
    commits: (compare?.commits ?? []).map((c) => ({
      sha: String(c.sha ?? "").slice(0, 12),
      message: String(c.commit?.message ?? "").split(/\r?\n/)[0],
      date: String(c.commit?.author?.date ?? ""),
    })),
    files: (compare?.files ?? []).map((f) => ({
      filename: String(f.filename ?? ""),
      status: String(f.status ?? "modified"),
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
    })),
  };
}

function renderProposalMarkdown(manifest, diff, analysis, generatedDate, isDryRun) {
  const lines = [
    `# Orca 업스트림 주간 감시 제안서 (${generatedDate})${isDryRun ? " [DRY-RUN]" : ""}`,
    "",
    "> **안전 원칙**: 본 보고서는 읽기 전용 감시 결과이며 **자동 패치·자동 병합·자동 커밋을 수행하지 않습니다.**",
    "> 이식이 필요한 항목만 사용자 승인 후 수동 포팅하고, 코드 조각 이식 시 MIT 저작권(`Copyright (c) 2026 Lovecast Inc.`)을 유지하세요.",
    "",
    "## 1. 기준점 vs 업스트림 현황",
    "",
    "| 항목 | 값 |",
    "|---|---|",
    `| 업스트림 저장소 | \`${manifest.upstream.repo}\` (${manifest.upstream.license}) |`,
    `| T3 고정 기준 태그 / SHA | \`${manifest.pinned.releaseTag}\` / \`${manifest.pinned.commitSha.slice(0, 12)}\` |`,
    `| 업스트림 최신 태그 / HEAD | \`${diff.latestReleaseTag}\` / \`${String(diff.headSha).slice(0, 12)}\` |`,
    `| 신규 커밋 수 | ${diff.aheadBy}건 |`,
    `| 전체 변경 파일 수 | ${diff.files.length}개 |`,
    `| **감시 대상 교집합 파일** | **${analysis.relevant.length}개** |`,
    `| 비채택 제외(페더레이션·PTY·봇) | ${analysis.excluded.length}개 |`,
    `| 감시 외 파일(UI 등 무시) | ${analysis.ignoredCount}개 |`,
    "",
  ];

  if (analysis.relevant.length === 0) {
    lines.push(
      "## 2. 검토 필요 변경 사항",
      "",
      "- 감시 대상 오케스트레이션 경로에 새로운 변경이 없습니다. 현재 T3 작업자 엔진 기준선 유지가 권장됩니다.",
      "",
    );
  } else {
    lines.push(
      "## 2. 검토 필요 변경 사항 (T3 매핑)",
      "",
      "| Orca 변경 파일 | 상태 | +/- | 영역 | T3 대응 대상 |",
      "|---|---|---:|---|---|",
    );
    for (const item of analysis.relevant) {
      const targets = item.rule.t3Targets.map((t) => `\`${t}\``).join(", ");
      lines.push(
        `| \`${item.file.filename}\` | ${item.file.status} | +${item.file.additions}/-${item.file.deletions} | ${item.rule.area} | ${targets} |`,
      );
    }
    lines.push("");
  }

  if (analysis.excluded.length > 0) {
    lines.push("## 3. 비채택 경계로 자동 제외된 파일", "");
    for (const ex of analysis.excluded) {
      lines.push(`- \`${ex.file.filename}\` (제외 키워드: \`${ex.excludedBy}\`)`);
    }
    lines.push("");
  }

  if (diff.commits.length > 0) {
    lines.push("## 4. 관련 업스트림 커밋 요약 (최대 20건)", "");
    for (const c of diff.commits.slice(-20)) {
      lines.push(`- \`${c.sha}\` ${c.message} (${c.date})`);
    }
    lines.push("");
  }

  lines.push(
    "## 5. 수동 반영 체크리스트",
    "",
    "- [ ] 변경 사항이 T3 작업자 엔진(`apps/server/src/t3x/workerEngine/`)의 실제 결함 또는 안정성 향상에 해당하는지 확인",
    "- [ ] 비채택 영역(SSH 페더레이션, PTY 입력 주입, 봇 커넥터) 의존성이 섞이지 않았는지 확인",
    "- [ ] 코드 조각 이식 시 파일 상단과 `THIRD_PARTY_NOTICES.md`에 MIT 저작권 고지 보존",
    "- [ ] 포팅 및 `verify:fast` 통과 후 `docs/operations/orca-upstream-manifest.json`의 `pinned` SHA/태그 수동 갱신",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(options.manifestPath, "utf8"));
  const diff = await loadUpstreamDiff(manifest, options);

  const relevant = [];
  const excluded = [];
  let ignoredCount = 0;

  for (const file of diff.files ?? []) {
    const res = matchWatchedRule(file.filename, manifest);
    if (res.matched) {
      relevant.push({ file, rule: res.rule });
    } else if (res.excludedBy) {
      excluded.push({ file, excludedBy: res.excludedBy });
    } else {
      ignoredCount += 1;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const markdown = renderProposalMarkdown(
    manifest,
    diff,
    { relevant, excluded, ignoredCount },
    today,
    options.dryRun,
  );

  if (options.toStdout || (options.dryRun && !options.outPath)) {
    process.stdout.write(markdown);
    process.stderr.write(
      `[watch-orca-upstream] summary: aheadBy=${diff.aheadBy}, relevant=${relevant.length}, excluded=${excluded.length}, ignored=${ignoredCount}\n`,
    );
    return;
  }

  const targetOut = options.outPath ?? path.join(DEFAULT_PROPOSALS_DIR, `${today}.md`);
  fs.mkdirSync(path.dirname(targetOut), { recursive: true });
  fs.writeFileSync(targetOut, markdown, "utf8");
  console.log(
    JSON.stringify(
      {
        ok: true,
        proposalPath: targetOut,
        pinnedSha: manifest.pinned.commitSha,
        headSha: diff.headSha,
        aheadBy: diff.aheadBy,
        relevantCount: relevant.length,
        excludedCount: excluded.length,
        ignoredCount,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
