import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const OWNER = "org.newautousage.lab.owner";
const ROLE = "org.newautousage.lab.role";
const RELEASE = "org.newautousage.lab.release";
export const CADDY_IMAGE =
  "caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f";
const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
export const defaultStateDir = NodePath.join(repoRoot, ".t3", "server-lab");

export async function docker(args, options = {}) {
  try {
    const result = await execFile("docker", args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    if (options.allowFailure)
      return {
        code: error.code ?? 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message,
      };
    throw new Error(`docker ${args[0]} failed: ${error.stderr || error.stdout || error.message}`, {
      cause: error,
    });
  }
}
export function atomicJson(path, body, mode = 0o600) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const fd = NodeFS.openSync(temporary, "wx", mode);
  try {
    NodeFS.writeFileSync(fd, `${JSON.stringify(body, null, 2)}\n`);
    NodeFS.fchmodSync(fd, mode);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  NodeFS.renameSync(temporary, path);
}
export function readState(directory = defaultStateDir) {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(directory, "state.json"), "utf8"));
}
const save = (directory, state) => atomicJson(NodePath.join(directory, "state.json"), state);
const active = (state) => state.releases[state.activeId] ?? null;
const previous = (state) => state.releases[state.previousId] ?? null;
const event = (directory, body) =>
  NodeFS.appendFileSync(
    NodePath.join(directory, "events.ndjson"),
    `${JSON.stringify({ at: new Date().toISOString(), ...body })}\n`,
  );

export async function withLab(directory, operation) {
  directory = NodePath.resolve(directory);
  if (directory.includes(","))
    throw new Error("State directory cannot contain a comma (Docker mount syntax)");
  NodeFS.mkdirSync(directory, { recursive: true });
  const lock = NodePath.join(directory, "operation.lock");
  if (NodeFS.existsSync(lock)) {
    const existing = NodeFS.readFileSync(lock, "utf8");
    const owner = JSON.parse(existing);
    let absent = false;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      absent = error.code === "ESRCH";
    }
    if (!absent) throw new Error(`Another lab operation owns the lock (PID ${owner.pid})`);
    if (NodeFS.readFileSync(lock, "utf8") === existing) NodeFS.unlinkSync(lock);
  }
  const fd = NodeFS.openSync(lock, "wx", 0o600);
  NodeFS.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  NodeFS.closeSync(fd);
  try {
    const stateFile = NodePath.join(directory, "state.json");
    const state = NodeFS.existsSync(stateFile)
      ? readState(directory)
      : {
          schema: 1,
          labId: NodeCrypto.randomUUID(),
          createdAt: new Date().toISOString(),
          network: null,
          proxy: null,
          activeId: null,
          previousId: null,
          releases: {},
        };
    NodeAssert.equal(state.schema, 1);
    save(directory, state);
    return await operation(state, directory);
  } finally {
    NodeFS.unlinkSync(lock);
  }
}
const inspect = async (id, type = "container") =>
  JSON.parse((await docker(["inspect", "--type", type, id])).stdout)[0];
export async function inspectOwned(state, record) {
  NodeAssert.match(record.containerId, /^[a-f0-9]{64}$/);
  const info = await inspect(record.containerId);
  NodeAssert.equal(info.Id, record.containerId, "Container identity mismatch");
  NodeAssert.equal(info.Created, record.createdAt, "Container creation time mismatch");
  NodeAssert.equal(info.Config.Labels[OWNER], state.labId, "Container belongs to another lab");
  NodeAssert.equal(info.Config.Labels[ROLE], record.id ? "workload" : "gateway");
  if (record.id) NodeAssert.equal(info.Config.Labels[RELEASE], record.id);
  return info;
}
async function stopOwned(state, record) {
  const info = await inspectOwned(state, record);
  if (info.State.Running || info.State.Restarting)
    await docker(["stop", "--timeout", "3", record.containerId]);
}
async function captureLogs(directory, release) {
  const result = await docker(["logs", "--tail", "1000", release.containerId], {
    allowFailure: true,
  });
  const logDirectory = NodePath.join(directory, "releases", release.id);
  NodeFS.mkdirSync(logDirectory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(logDirectory, "stdout.log"), result.stdout);
  NodeFS.writeFileSync(NodePath.join(logDirectory, "stderr.log"), result.stderr);
  atomicJson(NodePath.join(logDirectory, "receipt.json"), release);
}

function proxyConfig(release) {
  return {
    admin: { listen: "127.0.0.1:2019", config: { persist: false } },
    apps: {
      http: {
        servers: {
          lab: {
            listen: [":8080"],
            routes: [
              {
                handle: [
                  release
                    ? {
                        handler: "reverse_proxy",
                        upstreams: [{ dial: `${release.alias}:8080` }],
                      }
                    : {
                        handler: "static_response",
                        status_code: 503,
                        body: "No approved simulation bot\n",
                      },
                ],
              },
            ],
          },
        },
      },
    },
  };
}
export function chooseGatewayPort() {
  return new Promise((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address.port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
async function ensureInfrastructure(state, directory) {
  if (!state.network) {
    const name = `naud-lab-${state.labId.slice(0, 12)}`;
    const created = await docker([
      "network",
      "create",
      "--internal",
      "--label",
      `${OWNER}=${state.labId}`,
      name,
    ]);
    state.network = { id: created.stdout.trim(), name };
    save(directory, state);
  }
  const network = await inspect(state.network.id, "network");
  NodeAssert.equal(network.Internal, true);
  NodeAssert.equal(network.Labels[OWNER], state.labId);
  if (!state.edge) {
    const name = `${state.network.name}-edge`;
    const created = await docker(["network", "create", "--label", `${OWNER}=${state.labId}`, name]);
    state.edge = { id: created.stdout.trim(), name };
    save(directory, state);
  }
  const edge = await inspect(state.edge.id, "network");
  NodeAssert.equal(edge.Internal, false);
  NodeAssert.equal(edge.Labels[OWNER], state.labId);
  const configDir = NodePath.join(directory, "proxy");
  NodeFS.mkdirSync(configDir, { recursive: true });
  NodeFS.chmodSync(configDir, 0o755);
  atomicJson(NodePath.join(configDir, "proxy.json"), proxyConfig(active(state)), 0o644);
  if (!state.proxy) {
    state.gatewayPort ??= await chooseGatewayPort();
    save(directory, state);
    const args = [
      "create",
      "--name",
      `${state.network.name}-gateway`,
      "--init",
      "--user",
      "1000:1000",
      "--network",
      state.edge.id,
      "--publish",
      `127.0.0.1:${state.gatewayPort}:8080`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_BIND_SERVICE",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      "64m",
      "--memory-swap",
      "64m",
      "--cpus",
      "0.25",
      "--pids-limit",
      "64",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=4m",
      "--tmpfs",
      "/config:rw,noexec,nosuid,size=4m,uid=1000,gid=1000",
      "--tmpfs",
      "/data:rw,noexec,nosuid,size=4m,uid=1000,gid=1000",
      "--restart",
      "on-failure:3",
      "--health-cmd",
      "wget -q -O /dev/null http://127.0.0.1:2019/config/",
      "--health-interval",
      "1s",
      "--health-timeout",
      "2s",
      "--health-start-period",
      "2s",
      "--health-retries",
      "2",
      "--log-driver",
      "json-file",
      "--log-opt",
      "max-size=1m",
      "--log-opt",
      "max-file=3",
      "--label",
      `${OWNER}=${state.labId}`,
      "--label",
      `${ROLE}=gateway`,
      "--mount",
      `type=bind,source=${configDir},target=/etc/lab-config,readonly`,
      CADDY_IMAGE,
      "caddy",
      "run",
      "--config",
      "/etc/lab-config/proxy.json",
    ];
    const id = (await docker(args)).stdout.trim();
    const info = await inspect(id);
    state.proxy = { containerId: id, createdAt: info.Created, origin: null };
    save(directory, state);
  }
  const info = await inspectOwned(state, state.proxy);
  if (
    !Object.values(info.NetworkSettings.Networks).some(
      (network) => network.NetworkID === state.network.id,
    )
  ) {
    await docker(["network", "connect", state.network.id, state.proxy.containerId]);
  }
  if (
    !Object.values(info.NetworkSettings.Networks).some(
      (network) => network.NetworkID === state.edge.id,
    )
  ) {
    await docker(["network", "connect", state.edge.id, state.proxy.containerId]);
  }
  if (!info.State.Running) await docker(["start", state.proxy.containerId]);
  let started;
  try {
    started = await waitForHealth(state.proxy.containerId);
  } catch (error) {
    const logs = await docker(["logs", state.proxy.containerId], { allowFailure: true });
    NodeFS.writeFileSync(NodePath.join(configDir, "startup.log"), logs.stdout + logs.stderr);
    throw new Error(`Gateway readiness failed; see ${NodePath.join(configDir, "startup.log")}`, {
      cause: error,
    });
  }
  const binding = started.NetworkSettings.Ports["8080/tcp"]?.[0];
  NodeAssert.ok(binding, "Gateway has no loopback port binding");
  NodeAssert.equal(binding.HostIp, "127.0.0.1");
  NodeAssert.equal(
    Number(binding.HostPort),
    state.gatewayPort,
    "Gateway port changed unexpectedly",
  );
  state.proxy.origin = `http://127.0.0.1:${binding.HostPort}`;
  state.proxy.pid = started.State.Pid;
  save(directory, state);
}

export async function waitForHealth(
  containerId,
  { timeoutMs = 25_000, differentStartedAt = null, allowUnhealthy = false } = {},
) {
  const assess = async () => {
    const info = await inspect(containerId);
    if (
      info.State.Running &&
      !info.State.Restarting &&
      info.State.Health?.Status === "healthy" &&
      info.State.StartedAt !== differentStartedAt
    )
      return info;
    if (info.State.Status === "exited" && info.RestartCount >= 3)
      throw new Error("restart_budget_exhausted");
    if (!allowUnhealthy && info.State.Health?.Status === "unhealthy")
      throw new Error("readiness_unhealthy");
    return null;
  };
  const initial = await assess();
  if (initial) return initial;
  return new Promise((resolve, reject) => {
    const stream = NodeChildProcess.spawn(
      "docker",
      [
        "events",
        "--since",
        new Date(Date.now() - 2000).toISOString(),
        "--filter",
        `container=${containerId}`,
        "--format",
        "{{json .}}",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let settled = false;
    const finish = (error, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      stream.kill();
      if (error) reject(error);
      else resolve(info);
    };
    const deadline = setTimeout(() => finish(new Error("readiness_deadline_exceeded")), timeoutMs);
    let queue = Promise.resolve();
    stream.stdout.on("data", () => {
      queue = queue.then(async () => {
        if (settled) return;
        try {
          const info = await assess();
          if (info) finish(null, info);
        } catch (error) {
          finish(error);
        }
      });
    });
    stream.on("error", (error) => finish(error));
    stream.on("exit", () => {
      if (!settled) finish(new Error("Docker event stream ended"));
    });
  });
}

async function createRelease(state, directory, image, { fault = "none", volumeName = null } = {}) {
  const imageInfo = await inspect(image, "image");
  NodeAssert.equal(
    imageInfo.Config.Labels["org.newautousage.lab.contract"],
    "probe-bot-v1",
    "Image has no supported lab contract",
  );
  NodeAssert.ok(["none", "crash-loop"].includes(fault), "Unsupported fault mode");
  const id = NodeCrypto.randomUUID().slice(0, 13);
  const alias = `bot-${id}`;
  const imagePin = `newautousage-lab-pinned:${state.labId}-${id}`;
  await docker(["image", "tag", imageInfo.Id, imagePin]);
  if (!volumeName) {
    volumeName = `${state.network.name}-${id}-data`;
    await docker(["volume", "create", "--label", `${OWNER}=${state.labId}`, volumeName]);
  }
  const volume = await inspect(volumeName, "volume");
  NodeAssert.equal(volume.Labels[OWNER], state.labId);
  const release = {
    id,
    alias,
    image: imageInfo.Id,
    imagePin,
    imageReference: image,
    version: imageInfo.Config.Labels["org.newautousage.lab.version"],
    variant: imageInfo.Config.Labels["org.newautousage.lab.variant"],
    fault,
    volumeName,
    status: "creating",
    containerId: null,
  };
  state.releases[id] = release;
  save(directory, state);
  const created = await docker([
    "create",
    "--name",
    `${state.network.name}-${id}`,
    "--init",
    "--user",
    "1000:1000",
    "--network",
    state.network.id,
    "--network-alias",
    alias,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--memory",
    "256m",
    "--memory-swap",
    "256m",
    "--cpus",
    "0.5",
    "--pids-limit",
    "64",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--mount",
    `type=volume,source=${volumeName},target=/data`,
    "--restart",
    "on-failure:3",
    "--log-driver",
    "json-file",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=3",
    "--label",
    `${OWNER}=${state.labId}`,
    "--label",
    `${ROLE}=workload`,
    "--label",
    `${RELEASE}=${id}`,
    "--env",
    `BOT_FAULT_MODE=${fault}`,
    imagePin,
  ]);
  release.containerId = created.stdout.trim();
  const info = await inspect(release.containerId);
  release.createdAt = info.Created;
  release.status = "candidate";
  save(directory, state);
  return release;
}
async function admit(state, release) {
  const before = await inspectOwned(state, release);
  if (!before.State.Running) await docker(["start", release.containerId]);
  const info = await waitForHealth(release.containerId);
  const result = await docker(["exec", release.containerId, "node", "/app/probe.mjs"]);
  const receipt = JSON.parse(result.stdout.trim());
  NodeAssert.equal(receipt.type, "admission.passed");
  NodeAssert.equal(receipt.build.version, release.version);
  NodeAssert.equal(receipt.build.mode, "simulation");
  release.pid = info.State.Pid;
  release.startedAt = info.State.StartedAt;
  release.restartCount = info.RestartCount;
  release.admission = receipt;
}
async function route(state, directory, release) {
  await inspectOwned(state, state.proxy);
  if (release) await admit(state, release);
  atomicJson(NodePath.join(directory, "proxy/proxy.json"), proxyConfig(release), 0o644);
  await docker([
    "exec",
    state.proxy.containerId,
    "caddy",
    "validate",
    "--config",
    "/etc/lab-config/proxy.json",
  ]);
  await docker([
    "exec",
    state.proxy.containerId,
    "caddy",
    "reload",
    "--config",
    "/etc/lab-config/proxy.json",
  ]);
  if (release) {
    const response = await fetch(`${state.proxy.origin}/ready`, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    NodeAssert.equal(response.status, 200);
    NodeAssert.equal(body.build.version, release.version);
    NodeAssert.equal(body.type, "bot.ready");
    NodeAssert.equal(body.bootId, release.admission.bootId, "Gateway routed to another bot boot");
  }
}
export async function deploy(directory, image, options = {}) {
  return withLab(directory, async (state, dir) => {
    await ensureInfrastructure(state, dir);
    const old = active(state);
    const release = await createRelease(state, dir, image, options);
    try {
      await route(state, dir, release);
    } catch (error) {
      release.status = "quarantined";
      release.reason = error.message;
      try {
        await route(state, dir, old);
      } catch (restoreError) {
        release.routeRestoreError = restoreError.message;
      }
      await stopOwned(state, release);
      const failed = await inspectOwned(state, release);
      release.restartCount = failed.RestartCount;
      save(dir, state);
      await captureLogs(dir, release);
      event(dir, {
        type: "release.quarantined",
        releaseId: release.id,
        reason: release.reason,
        restartCount: release.restartCount,
      });
      throw new Error(
        `Candidate quarantined: ${release.reason}${release.routeRestoreError ? "; route restore failed" : ""}`,
        { cause: error },
      );
    }
    if (previous(state)) previous(state).status = "retired";
    state.previousId = old?.id ?? null;
    state.activeId = release.id;
    release.status = "active";
    if (old) old.status = "previous";
    save(dir, state);
    if (old) await stopOwned(state, old);
    event(dir, {
      type: "release.promoted",
      releaseId: release.id,
      previousId: old?.id,
      origin: state.proxy.origin,
    });
    await captureLogs(dir, release);
    return { release, origin: state.proxy.origin };
  });
}
export async function rollback(directory) {
  return withLab(directory, async (state, dir) => {
    const target = previous(state);
    if (!target) throw new Error("No previous release is available");
    const current = active(state);
    await ensureInfrastructure(state, dir);
    try {
      await route(state, dir, target);
    } catch (error) {
      await route(state, dir, current);
      await stopOwned(state, target);
      event(dir, { type: "release.rollback_failed", releaseId: target.id, reason: error.message });
      throw error;
    }
    state.activeId = target.id;
    state.previousId = current.id;
    target.status = "active";
    current.status = "previous";
    save(dir, state);
    await stopOwned(state, current);
    event(dir, { type: "release.rolled_back", releaseId: target.id });
    return { release: target, origin: state.proxy.origin };
  });
}
export async function replaceActive(directory) {
  return withLab(directory, async (state, dir) => {
    const old = active(state);
    if (!old) throw new Error("No active release");
    await stopOwned(state, old);
    let replacement;
    try {
      replacement = await createRelease(state, dir, old.imagePin ?? old.image, {
        volumeName: old.volumeName,
      });
      await route(state, dir, replacement);
      old.status = "retired";
      replacement.status = "active";
      state.activeId = replacement.id;
      save(dir, state);
      event(dir, {
        type: "release.replaced",
        releaseId: replacement.id,
        previousContainerId: old.containerId,
      });
      return { release: replacement, origin: state.proxy.origin };
    } catch (error) {
      if (replacement) {
        await stopOwned(state, replacement);
        replacement.status = "quarantined";
        replacement.reason = error.message;
      }
      await route(state, dir, old);
      save(dir, state);
      if (replacement) await captureLogs(dir, replacement);
      throw error;
    }
  });
}
export async function status(directory = defaultStateDir) {
  const state = readState(directory);
  const result = {
    labId: state.labId,
    directory,
    origin: state.proxy?.origin,
    active: null,
    previous: null,
    quarantined: [],
  };
  for (const [name, release] of [
    ["active", active(state)],
    ["previous", previous(state)],
  ]) {
    if (!release) continue;
    const info = await inspectOwned(state, release);
    result[name] = {
      ...release,
      runtime: {
        status: info.State.Status,
        health: info.State.Health?.Status,
        pid: info.State.Pid,
        restartCount: info.RestartCount,
        oomKilled: info.State.OOMKilled,
      },
    };
  }
  result.quarantined = Object.values(state.releases)
    .filter((r) => r.status === "quarantined")
    .map((r) => ({ id: r.id, version: r.version, reason: r.reason, restartCount: r.restartCount }));
  return result;
}
export async function stop(directory = defaultStateDir) {
  return withLab(directory, async (state, dir) => {
    for (const release of Object.values(state.releases)) {
      if (!release.containerId) continue;
      await stopOwned(state, release);
      await captureLogs(dir, release);
    }
    if (state.proxy) await stopOwned(state, state.proxy);
    event(dir, { type: "lab.stopped" });
    return { stopped: true, dataRetained: true };
  });
}
export async function start(directory = defaultStateDir) {
  return withLab(directory, async (state, dir) => {
    if (!active(state)) throw new Error("No approved release to start");
    await ensureInfrastructure(state, dir);
    await route(state, dir, active(state));
    save(dir, state);
    event(dir, { type: "lab.started" });
    return { origin: state.proxy.origin, release: active(state) };
  });
}
export async function buildImage(directory, { version = "0.1.0", variant = "complete" } = {}) {
  NodeAssert.match(version, /^\d+\.\d+\.\d+$/);
  NodeAssert.ok(["complete", "incomplete", "wrong-result", "broken-build"].includes(variant));
  NodeFS.mkdirSync(NodePath.join(directory, "builds"), { recursive: true });
  const tag = `newautousage-probe-bot:${version}-${variant}`;
  const result = await docker(
    [
      "build",
      "--progress=plain",
      "--build-arg",
      `BOT_VERSION=${version}`,
      "--build-arg",
      `BOT_VARIANT=${variant}`,
      "--tag",
      tag,
      NodePath.join(repoRoot, "experiments/server-probe-bot"),
    ],
    { allowFailure: true },
  );
  const logFile = NodePath.join(directory, "builds", `${version}-${variant}.log`);
  NodeFS.writeFileSync(logFile, result.stdout + result.stderr);
  if (result.code !== 0) throw new Error(`Build rejected; see ${logFile}`);
  return { tag, version, variant, image: (await inspect(tag, "image")).Id, logFile };
}
