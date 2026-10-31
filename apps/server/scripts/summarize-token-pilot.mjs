import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";

const root = NodePath.resolve(NodeURL.fileURLToPath(new URL("../../../", import.meta.url)));
const handoffSuite = process.argv.includes("--suite=handoff");
const evidence = NodePath.join(
  root,
  handoffSuite ? ".t3/token-handoff-pilot-2026-09-13" : ".t3/token-pilot-2026-09-13",
);
const numericFields = ["total", "input", "output", "cacheRead", "cacheWrite", "reasoning"];
const hash = (body) => NodeCrypto.createHash("sha256").update(body).digest("hex");
const read = (path) => NodeFS.readFileSync(path, "utf8");

function normalize(receipt) {
  const sources = new Map();
  for (const event of receipt.usageEvents) {
    for (const sample of event.payload.consumption ?? []) {
      const previous = sources.get(sample.sourceId);
      if (!previous || sample.counts.total >= previous.counts.total)
        sources.set(sample.sourceId, sample);
    }
  }
  const observations = [...sources.values()];
  const counts = Object.fromEntries(
    numericFields.map((field) => [
      field,
      observations.length &&
      observations.every((sample) => typeof sample.counts[field] === "number")
        ? observations.reduce((sum, sample) => sum + sample.counts[field], 0)
        : null,
    ]),
  );
  if (counts.total !== null && counts.total !== counts.input + counts.output) {
    throw new Error("Inconsistent token total: " + receipt.provider + "/" + receipt.id);
  }
  const eventPath = NodePath.join(evidence, receipt.provider, receipt.id + ".events.json");
  const events = JSON.parse(read(eventPath));
  const delegated = events.some((event) => /task\.(started|updated|completed)/.test(event.type));
  return {
    id: receipt.id,
    fixture: receipt.fixtureId,
    repetition: receipt.repetition,
    mode: receipt.mode,
    passed: receipt.passed,
    issues: receipt.assessment?.issues ?? [receipt.assessmentError],
    error: receipt.error,
    counts,
    wallMs: receipt.wallMs,
    promptChars: receipt.promptChars,
    protectedInputsUnchanged: receipt.protectedInputsUnchanged,
    sourceIds: [...sources.keys()],
    finalUsage: observations.every((sample) => sample.isFinal === true),
    delegated,
    reportedModels: Object.keys(receipt.cli?.complete?.payload?.modelUsage ?? {}),
    promptSha256: receipt.promptSha256,
    eventsSha256: hash(read(eventPath)),
  };
}

function aggregate(rows) {
  const counts = Object.fromEntries(
    numericFields.map((field) => [
      field,
      rows.length && rows.every((row) => row.counts[field] !== null)
        ? rows.reduce((sum, row) => sum + row.counts[field], 0)
        : null,
    ]),
  );
  return {
    runs: rows.length,
    passed: rows.filter((row) => row.passed).length,
    reported: rows.filter((row) => row.counts.total !== null).length,
    counts,
    nonCachedInput:
      counts.input !== null && counts.cacheRead !== null ? counts.input - counts.cacheRead : null,
    wallMs: rows.reduce((sum, row) => sum + row.wallMs, 0),
    delegatedRuns: rows.filter((row) => row.delegated).length,
  };
}

const results = [];
for (const provider of ["codex", "claude"]) {
  const manifest = JSON.parse(read(NodePath.join(evidence, provider, "manifest.json")));
  const path = NodePath.join(evidence, provider, "results.ndjson");
  const rows = (
    NodeFS.existsSync(path) ? read(path).trim().split("\n").filter(Boolean).map(JSON.parse) : []
  ).map(normalize);
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error("Duplicate jobs: " + provider);
  const arms = Object.fromEntries(
    ["standard", "relevant"].map((mode) => [
      mode,
      aggregate(rows.filter((row) => row.mode === mode)),
    ]),
  );
  const complete = rows.length === manifest.jobs.length;
  const comparisonEligible =
    complete && rows.every((row) => row.passed && row.counts.total !== null && !row.delegated);
  const comparison =
    comparisonEligible && arms.standard.counts.total && arms.relevant.counts.total
      ? {
          totalTokenChangePercent:
            (arms.relevant.counts.total / arms.standard.counts.total - 1) * 100,
          nonCachedInputChangePercent:
            arms.standard.nonCachedInput !== null &&
            arms.standard.nonCachedInput > 0 &&
            arms.relevant.nonCachedInput !== null
              ? (arms.relevant.nonCachedInput / arms.standard.nonCachedInput - 1) * 100
              : null,
          wallTimeChangePercent: (arms.relevant.wallMs / arms.standard.wallMs - 1) * 100,
        }
      : null;
  const tasks = Object.fromEntries(
    [...new Set(rows.map((row) => row.fixture))].map((fixture) => [
      fixture,
      Object.fromEntries(
        ["standard", "relevant"].map((mode) => [
          mode,
          aggregate(rows.filter((row) => row.fixture === fixture && row.mode === mode)),
        ]),
      ),
    ]),
  );
  results.push({
    provider,
    manifest,
    status: complete ? "completed-bounded-pilot" : "in-progress",
    comparisonEligible,
    arms,
    comparison,
    tasks,
    rows,
  });
}
const report = {
  at: new Date().toISOString(),
  providers: results,
  limits: [
    handoffSuite
      ? "One synthetic handoff task, three repetitions per arm; no statistical significance or production-wide savings claim."
      : "Five bounded tasks, three repetitions per arm; no statistical significance or production-wide savings claim.",
    "Provider comparisons are within each fixed model/effort configuration, not between models.",
    "Service cache was not flushed. Unknown counts remain null, not zero.",
    "All failures and reported consumption remain included; no automatic retry or selected winning attempts.",
    handoffSuite
      ? "Here relevant denotes compact cross-session handoff with original evidence retrieval, not same-session native compaction. Failed baselines preclude a savings comparison."
      : "RAG standard/relevant comparison does not measure memory-free chat, same-session native compaction, or all handoff optimizations.",
  ],
};
NodeFS.writeFileSync(NodePath.join(evidence, "summary.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    results.map(({ provider, status, arms, comparison }) => ({
      provider,
      status,
      arms,
      comparison,
    })),
    null,
    2,
  ),
);
