import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  capActivityRows,
  compactOldActivityPayloads,
  isCompactedActivityPayload,
} from "./threadReducer.ts";
import { orchestraBlocksByMessage } from "./orchestra.ts";

const activity = (
  id: number,
  payload: unknown,
  kind = "tool.completed",
): OrchestrationThreadActivity => ({
  id: EventId.make(`activity-${id}`),
  kind,
  tone: "info",
  summary: "Activity",
  payload,
  createdAt: `2026-02-23T00:00:${String(id % 60).padStart(2, "0")}.000Z`,
  turnId: null,
});

const questions = [
  {
    id: "use_emoji",
    header: "README",
    question: "Should the greeting use emoji?",
    options: [
      { label: "Yes", description: "" },
      { label: "No", description: "Plain text" },
    ],
  },
];

describe("activity payload compaction", () => {
  it("keeps orchestra block identity and instructions after a long stream of tool output", () => {
    const block = {
      executionId: "worker",
      ownerThreadId: "owner",
      runId: "run",
      nodeId: "node",
      attempt: 1,
      messageId: "worker-message",
      title: "Research",
      displayName: "AI",
      role: "researcher",
      kind: "research",
      modelSelection: { instanceId: "codex", model: "test" },
      status: "completed",
      instruction: "Read the README",
    };
    const activities = [
      activity(0, block, "orchestra.block"),
      ...Array.from({ length: 3100 }, (_, i) => activity(i + 1, { output: "Tool log" })),
    ];
    const compacted = compactOldActivityPayloads(capActivityRows(activities));
    expect(compacted).toHaveLength(2001);
    expect([...orchestraBlocksByMessage(compacted).values()]).toEqual([block]);
    expect(isCompactedActivityPayload(compacted[0]!)).toBe(false);
  });

  it("keeps a pending question answerable after it falls out of the retention window", () => {
    const activities = [
      activity(0, { requestId: "req-1", questions }, "user-input.requested"),
      ...Array.from({ length: 305 }, (_, index) => activity(index + 1, { output: "old log" })),
    ];

    const compacted = compactOldActivityPayloads(activities);
    const prompt = compacted[0]?.payload as Record<string, unknown>;
    // Dropping `questions` removes the request from deriveOpenUserInputRequests, so the
    // answer UI disappears while the agent stays blocked on the prompt.
    expect(prompt.questions).toEqual(questions);
    expect(prompt.requestId).toBe("req-1");
  });

  it("reports a blanked payload as compacted so readers do not mistake it for empty", () => {
    const activities = [
      activity(0, { plan: [{ step: "Inspect code", status: "inProgress" }] }, "turn.plan.updated"),
      ...Array.from({ length: 305 }, (_, index) => activity(index + 1, { output: "old log" })),
    ];

    const compacted = compactOldActivityPayloads(activities);
    expect(isCompactedActivityPayload(compacted[0]!)).toBe(true);
    expect(isCompactedActivityPayload(compacted.at(-1)!)).toBe(false);
  });
});
