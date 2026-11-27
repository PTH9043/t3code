import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

const require = createRequire(import.meta.url);
const __dirname = NodePath.dirname(NodeUrl.fileURLToPath(import.meta.url));
const addon = require(NodePath.join(__dirname, "t3_memory_core.node"));

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    avgMs: +avg.toFixed(3),
    p50Ms: +s[Math.floor(s.length * 0.5)].toFixed(3),
    p95Ms: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(3),
  };
}

function jsCosineTopKF32(matrix, dim, query, topK) {
  const count = Math.floor(matrix.length / dim);
  const top = [];
  for (let v = 0; v < count; v++) {
    let dot = 0;
    const base = v * dim;
    for (let d = 0; d < dim; d++) dot += matrix[base + d] * query[d];
    if (top.length < topK) {
      top.push({ index: v, score: dot });
      if (top.length === topK) top.sort((a, b) => a.score - b.score);
    } else if (dot > top[0].score) {
      top[0] = { index: v, score: dot };
      let pos = 0;
      while (pos + 1 < top.length && top[pos].score > top[pos + 1].score) {
        const tmp = top[pos];
        top[pos] = top[pos + 1];
        top[pos + 1] = tmp;
        pos++;
      }
    }
  }
  return top.sort((a, b) => b.score - a.score);
}

function benchVectorScenario(count, dim, runs = 8) {
  const matrix = new Float32Array(count * dim);
  const query = new Float32Array(dim);
  for (let i = 0; i < dim; i++) query[i] = Math.sin(i * 0.13) * 0.5;
  for (let i = 0; i < matrix.length; i += 3) {
    matrix[i] = Math.sin((i % 1009) * 0.017);
  }
  // Plant 5 distinct strong hits to verify Top-K recall accuracy.
  for (let k = 0; k < 5; k++) {
    const idx = Math.floor(((k + 1) * count) / 6);
    const base = idx * dim;
    for (let d = 0; d < dim; d++) matrix[base + d] = query[d] * (1.2 - k * 0.08);
  }

  const quant = addon.quantizeF32ToI8(matrix, dim);

  // Warmup
  const jsRef = jsCosineTopKF32(matrix, dim, query, 10);
  const rsF32Ref = addon.cosineTopKF32(matrix, dim, query, 10);
  const rsI8Ref = addon.cosineTopKI8(quant.data, quant.scales, dim, query, 10);

  const jsTimes = [];
  const rsF32Times = [];
  const rsI8Times = [];
  for (let r = 0; r < runs; r++) {
    let t0 = performance.now();
    jsCosineTopKF32(matrix, dim, query, 10);
    jsTimes.push(performance.now() - t0);

    t0 = performance.now();
    addon.cosineTopKF32(matrix, dim, query, 10);
    rsF32Times.push(performance.now() - t0);

    t0 = performance.now();
    addon.cosineTopKI8(quant.data, quant.scales, dim, query, 10);
    rsI8Times.push(performance.now() - t0);
  }

  const jsTop5 = jsRef.slice(0, 5).map((x) => x.index);
  const f32Top5 = rsF32Ref.slice(0, 5).map((x) => x.index);
  const i8Top5 = rsI8Ref.slice(0, 5).map((x) => x.index);
  const f32Match = jsTop5.every((id, i) => id === f32Top5[i]);
  const i8RecallAt5 = jsTop5.filter((id) => i8Top5.includes(id)).length / 5;

  const jsS = stats(jsTimes);
  const f32S = stats(rsF32Times);
  const i8S = stats(rsI8Times);

  return {
    count,
    dim,
    ramF32MB: +((count * dim * 4) / 1048576).toFixed(1),
    ramI8MB: +((count * dim + count * 4) / 1048576).toFixed(1),
    jsF32: jsS,
    rustF32Avx2: f32S,
    rustI8Avx2: i8S,
    speedupF32x: +(jsS.avgMs / Math.max(0.001, f32S.avgMs)).toFixed(1),
    speedupI8x: +(jsS.avgMs / Math.max(0.001, i8S.avgMs)).toFixed(1),
    top5ExactMatchF32: f32Match,
    top5RecallI8: i8RecallAt5,
  };
}

function benchArenaText() {
  const db = new DatabaseSync("E:/NewAutoUsage/userdata/state.sqlite", { readOnly: true });
  const rows = db
    .prepare(
      `SELECT body_markdown FROM workspace_routing_nodes WHERE LENGTH(body_markdown) > 80 LIMIT 1000`,
    )
    .all();
  db.close();
  const docs = rows.map((r) => String(r.body_markdown ?? ""));
  const totalKB = +(docs.reduce((s, d) => s + Buffer.byteLength(d), 0) / 1024).toFixed(1);

  const jsTimes = [];
  let jsBigrams = 0;
  for (let r = 0; r < 10; r++) {
    const t0 = performance.now();
    let total = 0;
    for (const d of docs) {
      const clean = d
        .replace(/^\s*[-=_*#]{3,}\s*$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const tokens = clean
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, " ")
        .split(/\s+/u)
        .filter((t) => t.length >= 2);
      const set = new Set();
      for (const tok of tokens) {
        for (let i = 0; i < tok.length - 1; i++) set.add(tok.slice(i, i + 2));
      }
      total += set.size;
    }
    jsBigrams = total;
    jsTimes.push(performance.now() - t0);
  }

  // Warmup
  let rsRes = addon.compressAndBigramBatchArena(docs);
  const rsTimes = [];
  for (let r = 0; r < 10; r++) {
    const t0 = performance.now();
    rsRes = addon.compressAndBigramBatchArena(docs);
    rsTimes.push(performance.now() - t0);
  }

  const jsS = stats(jsTimes);
  const rsS = stats(rsTimes);
  return {
    docs: docs.length,
    totalKB,
    js: jsS,
    rustBumpArena: rsS,
    speedupX: +(jsS.avgMs / Math.max(0.001, rsS.avgMs)).toFixed(1),
    jsTotalBigrams: jsBigrams,
    rustStats: rsRes,
  };
}

console.log(
  JSON.stringify(
    {
      capabilities: addon.runtimeCapabilities(),
      vectors38k_768d: benchVectorScenario(37918, 768, 8),
      vectors38k_1024d: benchVectorScenario(37918, 1024, 8),
      vectors100k_1024d: benchVectorScenario(100000, 1024, 5),
      arenaText1000RealDocs: benchArenaText(),
    },
    null,
    2,
  ),
);
