import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { atomicJson, defaultStateDir, docker, inspectOwned, readState } from "./manager.mjs";

const options = NodeUtil.parseArgs({
  options: {
    "state-dir": { type: "string", default: defaultStateDir },
    ticks: { type: "string", default: "360" },
    "retention-jobs": { type: "string", default: "1100" },
  },
}).values;
const directory = NodePath.resolve(options["state-dir"]);
const ticks = Number(options.ticks);
const retentionJobs = Number(options["retention-jobs"]);
NodeAssert.ok(Number.isSafeInteger(ticks) && ticks >= 10 && ticks <= 3600);
NodeAssert.ok(
  Number.isSafeInteger(retentionJobs) && retentionJobs >= 1100 && retentionJobs <= 10000,
);
const state = readState(directory);
const release = state.releases[state.activeId];
NodeAssert.ok(release, "Deploy an approved simulation bot first");
const runId = NodeCrypto.randomUUID();
const reportFile = NodePath.join(directory, `soak-${runId}.json`);
const checks = [];
const snapshots = [];
const startedAt = new Date().toISOString();
const emit = (type, detail = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), type, ...detail }));
const request = (path, init = {}) =>
  fetch(`${state.proxy.origin}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(5000),
  });
const json = async (path) => {
  const response = await request(path);
  NodeAssert.equal(response.status, 200);
  return response.json();
};
const check = (name, detail = {}) => {
  checks.push({ name, ...detail });
  emit("check.passed", { name, ...detail });
};
const snapshot = async () => {
  NodeAssert.equal(readState(directory).activeId, release.id, "Active release changed during soak");
  const info = await inspectOwned(state, release);
  const measured = await docker([
    "exec",
    release.containerId,
    "node",
    "-e",
    `const f=require('node:fs'); const read=p=>{try{return Number(f.readFileSync(p,'utf8').trim())}catch{return null}}; console.log(JSON.stringify({memoryCurrentBytes:read('/sys/fs/cgroup/memory.current'),memoryPeakBytes:read('/sys/fs/cgroup/memory.peak'),dataFiles:f.readdirSync('/data').map(name=>({name,bytes:f.statSync('/data/'+name).size}))}));`,
  ]);
  const result = {
    at: new Date().toISOString(),
    status: await json("/status"),
    restartCount: info.RestartCount,
    oomKilled: info.State.OOMKilled,
    health: info.State.Health.Status,
    ...JSON.parse(measured.stdout),
  };
  NodeAssert.equal(result.oomKilled, false);
  NodeAssert.equal(result.health, "healthy");
  NodeAssert.ok(
    result.memoryCurrentBytes > 0 && result.memoryCurrentBytes < info.HostConfig.Memory,
  );
  NodeAssert.equal(result.status.contract, 1);
  NodeAssert.equal(result.status.mode, "simulation");
  snapshots.push(result);
  return result;
};

try {
  const initial = await snapshot();
  NodeAssert.equal(initial.status.build.variant, "complete");
  emit("retention.start", {
    jobs: retentionJobs,
    concurrency: 8,
    containerId: release.containerId,
  });
  let next = 0;
  const latencies = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < retentionJobs) {
        const index = next++;
        const since = performance.now();
        const response = await request("/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: `soak-${runId}-${index}`, samples: [index, -2, 5] }),
        });
        NodeAssert.equal(response.status, 201);
        NodeAssert.deepEqual((await response.json()).job.result, {
          count: 3,
          sum: index + 3,
          min: Math.min(index, -2),
          max: Math.max(index, 5),
        });
        latencies.push(performance.now() - since);
      }
    }),
  );
  const afterLoad = await snapshot();
  NodeAssert.equal(
    afterLoad.status.manualCompleted - initial.status.manualCompleted,
    retentionJobs,
  );
  NodeAssert.equal(afterLoad.status.storedJobs, 1000);
  NodeAssert.equal((await request(`/jobs/soak-${runId}-0`)).status, 404);
  NodeAssert.equal(
    (await json(`/jobs/soak-${runId}-${retentionJobs - 1}`)).result.sum,
    retentionJobs + 2,
  );
  latencies.sort((a, b) => a - b);
  const p95Ms = Math.round(latencies[Math.ceil(latencies.length * 0.95) - 1]);
  NodeAssert.ok(p95Ms < 2000);
  check("bounded retention under concurrent writes", {
    processedJobs: retentionJobs,
    concurrency: 8,
    storedJobs: 1000,
    oldestEvicted: true,
    newestResultVerified: true,
    p95Ms,
    maxMs: Math.round(latencies.at(-1)),
  });

  let completed = 0;
  let cursor = afterLoad.status.scheduledCompleted;
  const since = performance.now();
  emit("soak.start", { ticks, origin: state.proxy.origin });
  while (completed < ticks) {
    const count = Math.min(120, ticks - completed);
    const response = await request(`/await-progress?after=${cursor}&count=${count}`, {
      signal: AbortSignal.timeout(135000),
    });
    NodeAssert.equal(response.status, 200);
    const receipt = await response.json();
    NodeAssert.equal(receipt.type, "bot.progress.reached");
    NodeAssert.equal(receipt.bootId, initial.status.bootId);
    NodeAssert.ok(receipt.scheduledCompleted >= cursor + count);
    const measured = await snapshot();
    NodeAssert.equal(measured.restartCount, initial.restartCount);
    NodeAssert.equal(measured.status.bootId, initial.status.bootId);
    NodeAssert.equal(measured.status.storedJobs, 1000);
    completed += count;
    cursor = measured.status.scheduledCompleted;
    emit("soak.progress", {
      completedTicks: completed,
      ticks,
      memoryCurrentBytes: measured.memoryCurrentBytes,
    });
  }
  check("continuous scheduled work and bounded storage", {
    completedTicks: completed,
    elapsedSeconds: Math.round((performance.now() - since) / 1000),
    unexpectedRestarts: 0,
    oomKilled: false,
  });
  atomicJson(reportFile, {
    status: "passed",
    startedAt,
    completedAt: new Date().toISOString(),
    origin: state.proxy.origin,
    containerId: release.containerId,
    image: release.image,
    checks,
    snapshots,
  });
  emit("soak.passed", { report: reportFile });
} catch (error) {
  atomicJson(reportFile, {
    status: "failed",
    startedAt,
    failedAt: new Date().toISOString(),
    origin: state.proxy.origin,
    containerId: release.containerId,
    checks,
    snapshots,
    error: error.message,
    stack: error.stack,
  });
  emit("soak.failed", { report: reportFile, error: error.message });
  process.exitCode = 1;
}
