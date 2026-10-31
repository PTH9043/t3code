import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";

const request = async (path, options = {}) =>
  fetch(`http://127.0.0.1:8080${path}`, {
    ...options,
    signal: AbortSignal.timeout(3_000),
  });
const ready = await request("/ready");
const state = await ready.json();
NodeAssert.equal(ready.status, 200);
NodeAssert.equal(state.contract, 1);
NodeAssert.equal(state.type, "bot.ready");
NodeAssert.equal(state.mode, "simulation");
const id = `admission-${NodeCrypto.randomUUID()}`;
const payload = { id, samples: [2, -3, 5, 0] };
const options = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
};
const result = await request("/jobs", options);
NodeAssert.equal(result.status, 201);
NodeAssert.deepEqual((await result.json()).job.result, { count: 4, sum: 4, min: -3, max: 5 });
const duplicate = await request("/jobs", options);
NodeAssert.equal(duplicate.status, 200);
NodeAssert.equal((await duplicate.json()).duplicate, true);
console.log(
  JSON.stringify({
    type: "admission.passed",
    build: state.build,
    bootId: state.bootId,
    idempotency: true,
  }),
);
