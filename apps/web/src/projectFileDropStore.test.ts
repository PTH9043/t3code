import { beforeEach, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DraftId } from "./composerDraftStore";
import { fileDropTargetKey, useProjectFileDropStore } from "./projectFileDropStore";

beforeEach(() => useProjectFileDropStore.setState({ pending: {} }));
it("holds a project drop for its destination and consumes it exactly once", () => {
  const target = DraftId.make("a"),
    other = DraftId.make("b");
  const file = new File(["image"], "사진.png", { type: "image/png" });
  const store = useProjectFileDropStore.getState();
  store.queue(target, [file]);
  expect(store.take(other)).toEqual([]);
  expect(store.take(target)).toEqual([file]);
  expect(store.take(target)).toEqual([]);
});
it("separates equal thread IDs in different environments and accumulates consecutive drops", () => {
  const a = scopeThreadRef(EnvironmentId.make("a"), ThreadId.make("same"));
  const b = scopeThreadRef(EnvironmentId.make("b"), ThreadId.make("same"));
  const store = useProjectFileDropStore.getState();
  const one = new File(["1"], "one.txt"),
    two = new File(["2"], "two.txt");
  store.queue(a, [one]);
  store.queue(a, [two]);
  expect(fileDropTargetKey(a)).not.toBe(fileDropTargetKey(b));
  expect(store.take(b)).toEqual([]);
  expect(store.take(a)).toEqual([one, two]);
});
it("bounds pending drops to the message attachment limit and reports rejected files", () => {
  const target = DraftId.make("limited");
  const files = Array.from({ length: 10 }, (_, i) => new File([String(i)], `${i}.txt`));
  const store = useProjectFileDropStore.getState();
  expect(store.queue(target, files)).toBe(2);
  expect(store.take(target)).toEqual(files.slice(0, 8));
});
