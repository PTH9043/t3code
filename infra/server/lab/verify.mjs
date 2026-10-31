import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  atomicJson,
  buildImage,
  defaultStateDir,
  deploy,
  docker,
  inspectOwned,
  readState,
  replaceActive,
  rollback,
  start,
  status,
  stop,
  waitForHealth,
} from "./manager.mjs";

const options = NodeUtil.parseArgs({
  options: {
    "state-dir": { type: "string", default: defaultStateDir },
    "soak-ticks": { type: "string", default: "120" },
  },
}).values;
const directory = NodePath.resolve(options["state-dir"]);
const soakTicks = Number(options["soak-ticks"]);
NodeAssert.ok(Number.isInteger(soakTicks) && soakTicks >= 10 && soakTicks <= 120);
NodeFS.mkdirSync(directory, { recursive: true });
if (NodeFS.existsSync(NodePath.join(directory, "state.json")))
  throw new Error("Use a fresh state directory for a new validation run");
const checks = [];
let origin;
const emit = (type, body = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), type, ...body }));
const request = async (path, init = {}) =>
  fetch(`${origin}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(5_000) });
const json = async (path) => {
  const r = await request(path);
  NodeAssert.equal(r.status, 200);
  return r.json();
};
const post = (body) =>
  request("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const check = (name, detail = {}) => {
  checks.push({ name, ...detail });
  emit("check.passed", { name, ...detail });
};

try {
  emit("build.start", { program: "new server-probe-bot" });
  const v1 = await buildImage(directory, { version: "0.1.0" });
  const v2 = await buildImage(directory, { version: "0.2.0" });
  const incomplete = await buildImage(directory, { version: "0.3.0", variant: "incomplete" });
  const wrongResult = await buildImage(directory, { version: "0.5.0", variant: "wrong-result" });
  check("four independent bot images built", {
    v1: v1.image,
    v2: v2.image,
    incomplete: incomplete.image,
    wrongResult: wrongResult.image,
  });
  const deployed = await deploy(directory, v1.tag);
  origin = deployed.origin;
  check("new simulation bot admitted", { origin, containerId: deployed.release.containerId });

  const marker = { id: `durable-${NodeCrypto.randomUUID()}`, samples: [2, -3, 5, 0] };
  const accepted = await post(marker);
  NodeAssert.equal(accepted.status, 201);
  NodeAssert.deepEqual((await accepted.json()).job.result, { count: 4, sum: 4, min: -3, max: 5 });
  const duplicate = await post(marker);
  NodeAssert.equal(duplicate.status, 200);
  NodeAssert.equal((await duplicate.json()).duplicate, true);
  NodeAssert.equal((await post({ ...marker, samples: [99] })).status, 409);
  NodeAssert.equal((await post({ id: "bad", samples: [] })).status, 400);
  const malformed = await request("/jobs", { method: "POST", body: "{" });
  NodeAssert.equal(malformed.status, 400);
  check("functional oracle, idempotency, conflict and malformed input");

  const beforeCollision = await json("/status");
  const reserved = await post({
    id: `scheduled-${beforeCollision.scheduledCompleted + 1}`,
    samples: [999],
  });
  NodeAssert.equal(reserved.status, 400);
  const continued = await request(
    `/await-progress?after=${beforeCollision.scheduledCompleted}&count=2`,
  );
  NodeAssert.equal(continued.status, 200);
  NodeAssert.equal((await continued.json()).bootId, beforeCollision.bootId);
  check("manual ID collision cannot stall scheduled work");

  const latencies = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < 200) {
        const index = next++;
        const started = performance.now();
        const response = await post({ id: `load-${index}`, samples: [index, 2, -1] });
        NodeAssert.equal(response.status, 201);
        NodeAssert.equal((await response.json()).job.result.sum, index + 1);
        latencies.push(performance.now() - started);
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  NodeAssert.ok(latencies[189] < 2_000, "p95 exceeds the local acceptance budget");
  check("200 jobs at concurrency 8", {
    p95Ms: Math.round(latencies[189]),
    maxMs: Math.round(latencies.at(-1)),
  });

  let state = readState(directory);
  let release = state.releases[state.activeId];
  let info = await inspectOwned(state, release);
  NodeAssert.equal(info.HostConfig.Memory, 256 * 1024 * 1024);
  NodeAssert.equal(info.HostConfig.NanoCpus, 500_000_000);
  NodeAssert.equal(info.HostConfig.PidsLimit, 64);
  NodeAssert.equal(info.HostConfig.ReadonlyRootfs, true);
  NodeAssert.equal(info.Config.User, "1000:1000");
  NodeAssert.deepEqual(info.HostConfig.CapDrop, ["ALL"]);
  NodeAssert.equal(info.HostConfig.RestartPolicy.MaximumRetryCount, 3);
  NodeAssert.equal(
    info.Mounts.some((mount) => mount.Destination.includes("docker.sock")),
    false,
  );
  NodeAssert.ok(info.Mounts.every((mount) => mount.Destination === "/data"));
  const kernel = await docker([
    "exec",
    release.containerId,
    "node",
    "-e",
    `const f=require('node:fs'); const a=require('node:assert/strict'); a.equal(f.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'268435456'); a.equal(f.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'64'); a.throws(()=>f.writeFileSync('/app/prohibited','x'),{code:'EROFS'}); console.log('kernel-limits-and-readonly-pass');`,
  ]);
  NodeAssert.match(kernel.stdout, /kernel-limits-and-readonly-pass/);
  const network = JSON.parse((await docker(["network", "inspect", state.network.id])).stdout)[0];
  NodeAssert.equal(network.Internal, true);
  NodeAssert.deepEqual(
    Object.values(info.NetworkSettings.Networks).map((network) => network.NetworkID),
    [state.network.id],
  );
  await NodeAssert.rejects(
    inspectOwned({ ...state, labId: NodeCrypto.randomUUID() }, release),
    /another lab/,
  );
  check(
    "kernel memory/PID limits, read-only root, non-root user, internal network and ownership guard",
  );

  for (const signal of ["SIGKILL", "SIGSTOP"]) {
    const before = await inspectOwned(state, release);
    const worker = await json("/status");
    emit("fault.injecting", { signal, workerPid: worker.pid, containerId: release.containerId });
    await docker([
      "exec",
      release.containerId,
      "node",
      "-e",
      `process.kill(${worker.pid},${JSON.stringify(signal)})`,
    ]);
    const recovered = await waitForHealth(release.containerId, {
      differentStartedAt: before.State.StartedAt,
      allowUnhealthy: true,
      timeoutMs: 30_000,
    });
    NodeAssert.ok(recovered.RestartCount > before.RestartCount);
    NodeAssert.notEqual((await json("/status")).bootId, worker.bootId);
    NodeAssert.equal((await json(`/jobs/${marker.id}`)).result.sum, 4);
    check(signal === "SIGKILL" ? "worker crash recovery" : "hung worker watchdog recovery", {
      restartCount: recovered.RestartCount,
    });
  }

  const recoveredActiveId = readState(directory).activeId;
  await NodeAssert.rejects(deploy(directory, wrongResult.tag), /quarantined/);
  NodeAssert.equal(readState(directory).activeId, recoveredActiveId);
  NodeAssert.equal((await json("/ready")).build.version, "0.1.0");
  check("failed candidate restores the recovered bot after an automatic restart");

  const upgraded = await deploy(directory, v2.tag);
  NodeAssert.equal(upgraded.origin, origin);
  NodeAssert.equal((await json("/status")).build.version, "0.2.0");
  const rolledBack = await rollback(directory);
  NodeAssert.equal(rolledBack.origin, origin);
  NodeAssert.equal((await json("/status")).build.version, "0.1.0");
  NodeAssert.equal((await json(`/jobs/${marker.id}`)).result.sum, 4);
  check("verified upgrade and rollback keep the same endpoint and the previous dataset");

  const beforeRejection = readState(directory).activeId;
  await NodeAssert.rejects(deploy(directory, incomplete.tag), /quarantined/);
  NodeAssert.equal(readState(directory).activeId, beforeRejection);
  NodeAssert.equal((await json("/ready")).build.version, "0.1.0");
  check("unfinished prototype quarantined without replacing the healthy bot");

  await NodeAssert.rejects(deploy(directory, wrongResult.tag), /quarantined/);
  NodeAssert.equal(readState(directory).activeId, beforeRejection);
  NodeAssert.equal((await json("/ready")).build.version, "0.1.0");
  check("a healthy-looking bot with incorrect results fails independent admission");

  await NodeAssert.rejects(deploy(directory, v2.tag, { fault: "crash-loop" }), /quarantined/);
  const crashLoop = Object.values(readState(directory).releases).find(
    (r) => r.fault === "crash-loop",
  );
  NodeAssert.equal(crashLoop.status, "quarantined");
  NodeAssert.equal(crashLoop.restartCount, 3);
  NodeAssert.equal((await json("/ready")).build.version, "0.1.0");
  check("crash loop stops at the restart budget and is quarantined", {
    restartCount: crashLoop.restartCount,
  });

  await NodeAssert.rejects(
    buildImage(directory, { version: "0.4.0", variant: "broken-build" }),
    /Build rejected/,
  );
  NodeAssert.equal(readState(directory).activeId, beforeRejection);
  NodeAssert.equal((await json("/ready")).build.version, "0.1.0");
  check("deliberately invalid build cannot replace the active image");

  const replaced = await replaceActive(directory);
  NodeAssert.notEqual(replaced.release.containerId, deployed.release.containerId);
  NodeAssert.equal(replaced.origin, origin);
  NodeAssert.equal((await json(`/jobs/${marker.id}`)).result.sum, 4);
  check("container replacement retains its own SQLite volume");

  await stop(directory);
  NodeAssert.equal(
    (await start(directory)).origin,
    origin,
    "Published endpoint changed after restart",
  );
  NodeAssert.equal((await json(`/jobs/${marker.id}`)).result.sum, 4);
  check("explicit stop and start retain data");

  state = readState(directory);
  release = state.releases[state.activeId];
  info = await inspectOwned(state, release);
  const starting = await json("/status");
  const startedAt = performance.now();
  emit("soak.start", { ticks: soakTicks, origin, containerId: release.containerId });
  const progress = await request(
    `/await-progress?after=${starting.scheduledCompleted}&count=${soakTicks}`,
    { signal: AbortSignal.timeout(135_000) },
  );
  NodeAssert.equal(progress.status, 200);
  const reached = await progress.json();
  NodeAssert.equal(reached.type, "bot.progress.reached");
  const finished = await inspectOwned(state, release);
  NodeAssert.equal(finished.RestartCount, info.RestartCount);
  NodeAssert.equal(finished.State.OOMKilled, false);
  NodeAssert.equal(finished.State.Health.Status, "healthy");
  NodeAssert.equal(reached.bootId, starting.bootId);
  NodeAssert.ok(reached.storedJobs <= 1000);
  check("continuous background-work soak", {
    completedTicks: soakTicks,
    elapsedSeconds: Math.round((performance.now() - startedAt) / 1000),
    unexpectedRestarts: 0,
    oomKilled: false,
  });
  const stats = await docker([
    "stats",
    "--no-stream",
    "--format",
    "{{json .}}",
    release.containerId,
    state.proxy.containerId,
  ]);
  const result = {
    status: "passed",
    completedAt: new Date().toISOString(),
    directory,
    origin,
    checks,
    runtime: await status(directory),
    measuredDockerStats: stats.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  };
  atomicJson(NodePath.join(directory, "verification.json"), result);
  emit("verification.passed", {
    report: NodePath.join(directory, "verification.json"),
    origin,
    checks: checks.length,
  });
} catch (error) {
  atomicJson(NodePath.join(directory, "verification.json"), {
    status: "failed",
    at: new Date().toISOString(),
    checks,
    error: error.message,
    stack: error.stack,
  });
  emit("verification.failed", {
    error: error.message,
    report: NodePath.join(directory, "verification.json"),
  });
  process.exitCode = 1;
}
