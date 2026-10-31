import { expect, it } from "vite-plus/test";
import { parseWorkspaceProgramHubMemory } from "./workspaceProgramHubMemory";

const blank = { commitLimitMb: "", concurrencyGroup: "", concurrencySlots: "", sharedDatasets: "" };

it("defaults a named group to one slot and preserves equals signs in dataset paths", () => {
  expect(
    parseWorkspaceProgramHubMemory({
      ...blank,
      concurrencyGroup: " research ",
      sharedDatasets: "events=data/a=b.jsonl",
    }),
  ).toEqual({
    commitLimitMb: null,
    concurrencyGroup: "research",
    concurrencySlots: 1,
    sharedDatasets: [{ name: "EVENTS", relativeSource: "data/a=b.jsonl" }],
  });
});

it.each([
  { sharedDatasets: "missing separator" },
  { sharedDatasets: "DATA=" },
  { sharedDatasets: "DATA=a.jsonl\ndata=b.jsonl" },
  { sharedDatasets: "DATA=../outside.jsonl" },
  { commitLimitMb: "63" },
  { commitLimitMb: "abc" },
  { concurrencySlots: "2" },
  { concurrencyGroup: "research", concurrencySlots: "0" },
])("rejects invalid hub settings without silently dropping input: %j", (input) => {
  expect(() => parseWorkspaceProgramHubMemory({ ...blank, ...input })).toThrow();
});
