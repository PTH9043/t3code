#!/usr/bin/env node
/**
 * Wave 4-A2: Offline read-only Korean graph search evaluator.
 * Reads sample memory-v2 markdown documents (read-only) and compares:
 *   Baseline (pre-A2: raw unnormalized kw:* + unicode61 FTS only)
 *   vs
 *   Improved (A2: Korean particle/ending normalization + bigram auxiliary FTS5)
 *
 * Metrics reported:
 *   - Keyword query hit rate (vs baseline 71.2%)
 *   - Particle-bearing Korean kw:* node ratio (vs baseline 32.8%)
 *   - Median query latency (ms)
 *
 * Zero writes to live DB (`E:\NewAutoUsage`). Uses in-memory `node:sqlite`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PARTICLES = [
  "에서는",
  "에서도",
  "으로는",
  "으로도",
  "으로써",
  "으로서",
  "로부터",
  "에서부터",
  "으로부터",
  "이라는",
  "이라고",
  "에게서",
  "한테서",
  "해주세요",
  "했습니다",
  "해줘요",
  "합니다",
  "됩니다",
  "되었다",
  "하였다",
  "입니다",
  "까지도",
  "부터는",
  "까지는",
  "처럼",
  "보다",
  "까지",
  "부터",
  "에서",
  "에게",
  "한테",
  "으로",
  "에는",
  "에도",
  "이나",
  "이랑",
  "하고",
  "라는",
  "라고",
  "해줘",
  "했다",
  "하다",
  "하는",
  "하게",
  "하기",
  "해서",
  "하면",
  "되는",
  "되게",
  "되기",
  "되어",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "로",
  "와",
  "과",
  "도",
  "만",
  "나",
  "랑",
  "한",
  "할",
  "된",
  "됨",
].sort((a, b) => b.length - a.length);

const PROTECTED = new Set([
  "결과",
  "추가",
  "회의",
  "정의",
  "주의",
  "처리",
  "관리",
  "정리",
  "분리",
  "메모리",
  "쿼리",
  "데이터",
  "모니터",
  "서버",
  "에러",
  "오류",
  "테스트",
  "상태",
  "기반",
  "제한",
  "권한",
  "전환",
  "복원",
  "지원",
  "원인",
  "확인",
  "로그인",
  "토큰",
  "세션",
  "버전",
  "패턴",
  "엔진",
  "코인",
  "메인",
  "플러그인",
  "모드",
  "코드",
  "노드",
  "필드",
  "빌드",
  "스레드",
  "가이드",
  "대시보드",
  "모델",
  "채널",
  "파일",
  "규칙",
  "항목",
  "기록",
  "시스템",
  "기능",
  "설정",
  "결정",
  "측정",
  "수정",
  "계정",
  "요청",
  "응답",
  "검색",
  "색인",
  "분석",
  "압축",
  "백업",
  "복구",
  "동기화",
  "최적화",
  "정규화",
  "문서",
  "보고서",
  "최소",
  "최대",
  "속도",
  "캐시",
  "해시",
  "메시지",
  "페이지",
  "게이지",
  "로그",
  "버그",
  "태그",
  "플래그",
  "그래프",
  "서비스",
]);

function normalizeKo(raw) {
  const c = raw.normalize("NFKC").toLowerCase().trim();
  if (!/[가-힣]/.test(c) || PROTECTED.has(c)) return c;
  for (const s of PARTICLES) {
    if (!c.endsWith(s)) continue;
    const stem = c.slice(0, c.length - s.length);
    if (Array.from(stem).length >= 2) return stem;
  }
  return c;
}

function analyzeBigram(text) {
  const words =
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = [];
  for (const w of words) {
    if (/[가-힣]/.test(w)) {
      const chars = Array.from(w);
      if (chars.length <= 1) out.push(w);
      else for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
    } else {
      out.push(w);
    }
  }
  return out.join(" ");
}

function collectSampleDocs(memRoot, maxDocs = 500) {
  const docs = [];
  if (!fs.existsSync(memRoot)) return docs;
  const walk = (dir) => {
    if (docs.length >= maxDocs) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (docs.length >= maxDocs) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const stat = fs.statSync(p);
          if (stat.size > 0 && stat.size <= 64_000) {
            const body = fs.readFileSync(p, "utf8");
            const firstLine = (body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? e.name)
              .replace(/^#+\s*/, "")
              .slice(0, 120);
            docs.push({ id: docs.length + 1, title: firstLine, body: body.slice(0, 1200) });
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(memRoot);
  return docs;
}

function extractTokens(text, useNorm) {
  const raw = text
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && t.length <= 32 && !/^\d+$/.test(t));
  const counts = new Map();
  for (const t of raw) {
    const k = useNorm ? normalizeKo(t) : t;
    if (k.length >= 2) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k);
}

const memRoot = process.argv[2] ?? "E:\\NewAutoUsage\\userdata\\memory-v2";
const docs = collectSampleDocs(memRoot, 500);
if (docs.length === 0) {
  console.error("No memory-v2 sample docs found at:", memRoot);
  process.exit(1);
}

// Build synthetic natural Korean queries with particles from real doc stems
const querySet = [];
const seenQ = new Set();
const particlePool = ["을", "를", "에서", "으로", "은", "는", "이", "가", "의", "에"];
for (const d of docs) {
  const koWords = (d.title + " " + d.body.slice(0, 200)).match(/[가-힣]{2,8}/g) ?? [];
  for (const w of koWords) {
    const stem = normalizeKo(w);
    if (stem.length >= 2 && !seenQ.has(stem)) {
      seenQ.add(stem);
      const p = particlePool[querySet.length % particlePool.length];
      querySet.push({ stem, inflected: `${stem}${p}`, expectedDocId: d.id });
      if (querySet.length >= 250) break;
    }
  }
  if (querySet.length >= 250) break;
}

function evaluateMode(useImproved) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE docs (id INTEGER PRIMARY KEY, title TEXT, body TEXT);
    CREATE TABLE kw_map (kw TEXT, doc_id INTEGER);
    CREATE INDEX idx_kw ON kw_map(kw);
    CREATE VIRTUAL TABLE fts_base USING fts5(title, body, tokenize='unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE fts_ko USING fts5(title_ko, body_ko, tokenize='unicode61 remove_diacritics 2');
  `);

  const insDoc = db.prepare("INSERT INTO docs VALUES (?, ?, ?)");
  const insKw = db.prepare("INSERT INTO kw_map VALUES (?, ?)");
  const insBase = db.prepare("INSERT INTO fts_base (rowid, title, body) VALUES (?, ?, ?)");
  const insKo = db.prepare("INSERT INTO fts_ko (rowid, title_ko, body_ko) VALUES (?, ?, ?)");

  const allKws = new Set();
  for (const d of docs) {
    insDoc.run(d.id, d.title, d.body);
    insBase.run(d.id, d.title, d.body);
    if (useImproved) {
      insKo.run(d.id, analyzeBigram(d.title), analyzeBigram(d.body));
    }
    const kws = extractTokens(`${d.title} ${d.body.slice(0, 600)}`, useImproved);
    for (const kw of kws) {
      insKw.run(kw, d.id);
      allKws.add(kw);
    }
  }

  const koKws = [...allKws].filter((k) => /[가-힣]/.test(k));
  const particleKws = koKws.filter((k) => normalizeKo(k) !== k);
  const particleRatioPct = koKws.length > 0 ? (particleKws.length / koKws.length) * 100 : 0;

  const qKw = db.prepare("SELECT doc_id FROM kw_map WHERE kw = ? LIMIT 8");
  const qBase = db.prepare("SELECT rowid AS doc_id FROM fts_base WHERE fts_base MATCH ? LIMIT 16");
  const qKo = db.prepare("SELECT rowid AS doc_id FROM fts_ko WHERE fts_ko MATCH ? LIMIT 16");

  let hits = 0;
  const latencies = [];
  for (const q of querySet) {
    const t0 = performance.now();
    const matched = new Set();
    const terms = useImproved ? [normalizeKo(q.inflected), q.inflected] : [q.inflected];
    for (const t of terms) {
      for (const r of qKw.all(t)) matched.add(r.doc_id);
    }
    try {
      const m = terms.map((t) => `"${t}"`).join(" OR ");
      for (const r of qBase.all(m)) matched.add(r.doc_id);
    } catch {
      /* ignore */
    }
    if (useImproved) {
      const bg = analyzeBigram(normalizeKo(q.inflected));
      if (bg) {
        try {
          for (const r of qKo.all(`"${bg}"`)) matched.add(r.doc_id);
        } catch {
          /* ignore */
        }
      }
    }
    latencies.push(performance.now() - t0);
    if (matched.size > 0) hits += 1;
  }

  latencies.sort((a, b) => a - b);
  const medianMs = latencies[Math.floor(latencies.length / 2)] ?? 0;
  const p95Ms = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  db.close();
  return {
    docs: docs.length,
    queries: querySet.length,
    hitRatePct: Number(((hits / querySet.length) * 100).toFixed(1)),
    koKwNodes: koKws.length,
    particleKwNodes: particleKws.length,
    particleRatioPct: Number(particleRatioPct.toFixed(1)),
    medianMs: Number(medianMs.toFixed(3)),
    p95Ms: Number(p95Ms.toFixed(3)),
  };
}

const before = evaluateMode(false);
const after = evaluateMode(true);

console.log("=== Wave 4-A2 한국어 그래프 검색 오프라인 평가 (memory-v2 읽기 전용 표본) ===");
console.log(`표본 문서: ${before.docs}건 | 한국어 조사 변형 질의: ${before.queries}건`);
console.log(
  `[개선 전] 적중률=${before.hitRatePct}% | 조사 붙은 한국어 kw:*=${before.particleRatioPct}% (${before.particleKwNodes}/${before.koKwNodes}) | 중앙값=${before.medianMs}ms (p95=${before.p95Ms}ms)`,
);
console.log(
  `[개선 후] 적중률=${after.hitRatePct}% | 조사 붙은 한국어 kw:*=${after.particleRatioPct}% (${after.particleKwNodes}/${after.koKwNodes}) | 중앙값=${after.medianMs}ms (p95=${after.p95Ms}ms)`,
);
console.log(
  `[개선 폭] 적중률 +${(after.hitRatePct - before.hitRatePct).toFixed(1)}%p | 조사 노드 -${(before.particleRatioPct - after.particleRatioPct).toFixed(1)}%p`,
);
