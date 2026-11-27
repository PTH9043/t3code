import { expect, it } from "vite-plus/test";
import { createSerialQueue } from "./backgroundModelQueue.ts";

it("finishes background jobs one at a time in arrival order, including after a failure", async () => {
  const run = createSerialQueue();
  const { signal } = new AbortController();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const order: string[] = [];
  const summary = run(signal, async () => {
    order.push("summary started");
    started.resolve();
    await release.promise;
    order.push("summary finished");
    throw new Error("generation failed");
  });
  const index = run(signal, async () => order.push("indexed"));
  const nextSummary = run(signal, async () => order.push("next summary"));
  await started.promise;
  expect(order).toEqual(["summary started"]);
  release.resolve();
  await expect(summary).rejects.toThrow("generation failed");
  await Promise.all([index, nextSummary]);
  expect(order).toEqual(["summary started", "summary finished", "indexed", "next summary"]);
});

it("cancels a waiting job without starting it or skipping the next job", async () => {
  const run = createSerialQueue();
  const { signal } = new AbortController();
  const release = Promise.withResolvers<void>();
  const current = run(signal, () => release.promise);
  const controller = new AbortController();
  const calls: string[] = [];
  const waiting = run(controller.signal, async () => calls.push("cancelled"));
  const next = run(signal, async () => calls.push("next"));
  controller.abort(new Error("stopped"));
  await expect(waiting).rejects.toThrow("stopped");
  expect(calls).toEqual([]);
  release.resolve();
  await Promise.all([current, next]);
  expect(calls).toEqual(["next"]);
});
