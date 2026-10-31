import {
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type WorkspaceTaskAttempt,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  formatRepairDigest,
  latestFormatFailure,
  verifiedFormatRepairOutput,
} from "./workspaceFormatRepair.ts";
import { buildInitialWorkspaceTaskGraph } from "./workspaceTaskGraph.ts";

const output = "Original evidence with trailing spaces.  \n";
const attempt: WorkspaceTaskAttempt = {
  number: 1,
  agent: "fable",
  role: "coordinator",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "original-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  strategy: "primary",
  threadId: ThreadId.make("thread"),
  status: "failed",
  output,
  error: "Missing tags",
  failureClassification: "validation",
  confidence: null,
  startedAt: "2026-09-12T00:00:00.000Z",
  completedAt: "2026-09-12T00:01:00.000Z",
  formatRepair: {
    messageId: MessageId.make("original-message"),
    chars: output.length,
    sha256: formatRepairDigest(output),
  },
};
it("requires exact original content before a formatting retry", () => {
  expect(verifiedFormatRepairOutput(attempt, output)).toBe(output);
  for (const changed of [
    undefined,
    output.trim(),
    output.replace("evidence", "evidencE"),
    output.slice(0, -1),
  ]) {
    expect(verifiedFormatRepairOutput(attempt, changed)).toBeUndefined();
  }
});
it("never reuses an old formatting failure after a later settled attempt", () => {
  const node = buildInitialWorkspaceTaskGraph("task").nodes[0]!;
  expect(
    latestFormatFailure({
      ...node,
      attempts: [attempt, { ...attempt, number: 2, status: "running" }],
    }),
  ).toBe(attempt);
  expect(
    latestFormatFailure({
      ...node,
      attempts: [attempt, { ...attempt, number: 2, status: "completed" }],
    }),
  ).toBeUndefined();
  const { formatRepair: _repair, ...plain } = attempt;
  expect(
    latestFormatFailure({ ...node, attempts: [attempt, { ...plain, number: 2 }] }),
  ).toBeUndefined();
});
