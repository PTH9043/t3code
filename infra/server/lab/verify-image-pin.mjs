import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { atomicJson, deploy, docker, readState, replaceActive, stop } from "./manager.mjs";

const options = NodeUtil.parseArgs({ options: { "state-dir": { type: "string" } } }).values;
NodeAssert.ok(options["state-dir"], "Use a fresh --state-dir for this isolated regression test");
const directory = NodePath.resolve(options["state-dir"]);
NodeAssert.equal(NodeFS.existsSync(NodePath.join(directory, "state.json")), false);
const mutableTag = `newautousage-pin-regression:${NodeCrypto.randomUUID()}`;
const version1 = JSON.parse(
  (await docker(["image", "inspect", "newautousage-probe-bot:0.1.0-complete"])).stdout,
)[0];
const version2 = JSON.parse(
  (await docker(["image", "inspect", "newautousage-probe-bot:0.2.0-complete"])).stdout,
)[0];
const checks = [];
let failure;
try {
  await docker(["image", "tag", version1.Id, mutableTag]);
  const deployed = await deploy(directory, mutableTag);
  NodeAssert.ok(deployed.release.imagePin);
  const marker = `pin-${NodeCrypto.randomUUID()}`;
  const created = await fetch(`${deployed.origin}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: marker, samples: [7, -2] }),
    signal: AbortSignal.timeout(5000),
  });
  NodeAssert.equal(created.status, 201);
  await created.arrayBuffer();
  await docker(["image", "tag", version2.Id, mutableTag]);
  const moved = JSON.parse((await docker(["image", "inspect", mutableTag])).stdout)[0];
  NodeAssert.equal(moved.Id, version2.Id);
  const pinned = JSON.parse(
    (await docker(["image", "inspect", deployed.release.imagePin])).stdout,
  )[0];
  NodeAssert.equal(pinned.Id, version1.Id);
  checks.push("the deployment retains its exact image after the input tag moves");
  const replaced = await replaceActive(directory);
  NodeAssert.notEqual(replaced.release.containerId, deployed.release.containerId);
  NodeAssert.equal(replaced.release.image, version1.Id);
  NodeAssert.equal(replaced.origin, deployed.origin);
  const ready = await fetch(`${deployed.origin}/ready`, { signal: AbortSignal.timeout(5000) });
  NodeAssert.equal(ready.status, 200);
  const body = await ready.json();
  NodeAssert.equal(body.build.version, "0.1.0");
  NodeAssert.equal(body.bootId, replaced.release.admission.bootId);
  const stored = await fetch(`${deployed.origin}/jobs/${marker}`, {
    signal: AbortSignal.timeout(5000),
  });
  NodeAssert.equal(stored.status, 200);
  NodeAssert.equal((await stored.json()).result.sum, 5);
  checks.push("replacement uses the pinned image and keeps the same volume and endpoint");
} catch (error) {
  failure = error;
} finally {
  if (NodeFS.existsSync(NodePath.join(directory, "state.json"))) await stop(directory);
  await docker(["image", "rm", mutableTag]);
}
const report = {
  status: failure ? "failed" : "passed",
  completedAt: new Date().toISOString(),
  checks,
  error: failure?.message,
  originalImage: version1.Id,
  movedTagImage: version2.Id,
  runtime: readState(directory),
};
atomicJson(NodePath.join(directory, "verification.json"), report);
console.log(JSON.stringify({ ...report, runtime: undefined }));
if (failure) process.exitCode = 1;
