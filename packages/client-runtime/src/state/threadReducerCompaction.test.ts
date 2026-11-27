import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  capActivityRows,
  compactOldActivityPayloads,
  isCompactedActivityPayload,
} from "./threadReducer.ts";
import { orchestraBlocksByMessage } from "./orchestra.ts";
import { separateThreadToolActivities } from "./threadToolActivity.ts";

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
  it("shows only old synthetic upgrade-room jobs as ordinary chat history", () => {
    const executionId = "upgrade-room-turn-" + "a".repeat(32);
    const block = {
      executionId,
      ownerThreadId: "autousage-upgrade-room",
      runId: "upgrade-room",
      nodeId: "turn-" + "a".repeat(32),
      attempt: 1,
      messageId: "old-assistant",
      title: "Work",
      displayName: "AI",
      role: "implementer",
      kind: "implementation",
      modelSelection: { instanceId: "claude", model: "haiku" },
      status: "completed",
    };
    const actualOrchestra = {
      ...block,
      runId: "explicit-run",
      executionId: "actual-worker",
      messageId: "actual-assistant",
    };
    const tool = {
      ...activity(2, {
        executionId,
        messageId: block.messageId,
        attempt: 1,
        itemType: "file_read",
        toolName: "Read",
        toolCallId: "read-1",
      }),
      id: EventId.make(`orchestra:${executionId}:1:read-1`),
    };
    const all = [
      activity(0, block, "orchestra.block"),
      activity(1, actualOrchestra, "orchestra.block"),
      tool,
    ];
    expect([...orchestraBlocksByMessage(all).values()]).toEqual([actualOrchestra]);
    const { tools } = separateThreadToolActivities(all);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ turnId: `upgrade-room:${executionId}` });
    expect(tools[0]).not.toHaveProperty("orchestraMessageId");
    expect(tool.payload).toMatchObject({ executionId });
  });

  it("keeps the turn plan readable through a step longer than the payload window", () => {
    const plan = [{ step: "전역 설정 반영", status: "inProgress" }];
    const rows = [
      activity(0, { plan }, "turn.plan.updated"),
      ...Array.from({ length: 400 }, (_, index) => activity(index + 1, { detail: "output" })),
    ];
    const compacted = compactOldActivityPayloads(rows);
    expect(isCompactedActivityPayload(compacted[1]!)).toBe(true);
    expect(compacted[0]).toBe(rows[0]);
  });

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
      activity(0, { detail: "Inspect code" }),
      ...Array.from({ length: 305 }, (_, index) => activity(index + 1, { output: "old log" })),
    ];

    const compacted = compactOldActivityPayloads(activities);
    expect(isCompactedActivityPayload(compacted[0]!)).toBe(true);
    expect(isCompactedActivityPayload(compacted.at(-1)!)).toBe(false);
  });

  it("keeps council/orchestra tool rows attached to their block and model after >300 activity compaction", () => {
    const executionId = "council-seat-exec-1";
    const messageId = "council-seat-msg-1";
    const block = {
      executionId,
      ownerThreadId: "owner-thread",
      runId: "cnc_test_1",
      nodeId: "seat_chair",
      attempt: 1,
      messageId,
      title: "다자간 위원회 R1 · CHAIR_ARBITER",
      displayName: "Claude",
      role: "verifier",
      kind: "validation",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      status: "completed",
    };
    const toolStarted = {
      ...activity(
        1,
        {
          executionId,
          messageId,
          attempt: 1,
          provider: "claudeAgent",
          providerInstanceId: "claudeAgent",
          itemType: "command_execution",
          toolName: "Bash",
          status: "inProgress",
          data: { toolCallId: "toolu_council_1", input: { command: "git status" } },
        },
        "tool.started",
      ),
      id: EventId.make(`orchestra:${executionId}:1:start-1`),
    };
    const toolCompleted = {
      ...activity(
        2,
        {
          executionId,
          messageId,
          attempt: 1,
          provider: "claudeAgent",
          providerInstanceId: "claudeAgent",
          itemType: "command_execution",
          toolName: "Bash",
          status: "completed",
          exitCode: 0,
          detail: "HUGE OUTPUT ".repeat(200),
          data: {
            toolCallId: "toolu_council_1",
            input: { command: "git status" },
            rawOutput: { stdout: "On branch main" },
          },
        },
        "tool.completed",
      ),
      id: EventId.make(`orchestra:${executionId}:1:end-1`),
    };
    const activities = [
      activity(0, block, "orchestra.block"),
      toolStarted,
      toolCompleted,
      ...Array.from({ length: 320 }, (_, i) =>
        activity(i + 3, { output: "filler" }, "runtime.info"),
      ),
    ];

    const compacted = compactOldActivityPayloads(activities);
    expect(isCompactedActivityPayload(compacted[1]!)).toBe(true);
    expect(isCompactedActivityPayload(compacted[2]!)).toBe(true);
    expect((compacted[2]!.payload as Record<string, unknown>).detail).toBeUndefined();
    expect((compacted[2]!.payload as Record<string, unknown>).data).toBeUndefined();

    const { tools } = separateThreadToolActivities(compacted);
    const leaked = tools.filter((entry) => entry.orchestraMessageId === undefined);
    expect(leaked).toEqual([]);
    const owned = tools.filter((entry) => entry.orchestraMessageId === messageId);
    expect(owned).toHaveLength(1);
    expect(owned[0]?.toolActivity?.executorSource).toBe("execution-assigned");
    expect(owned[0]?.toolActivity?.executorLabel).not.toContain("작업 모델 확인 안 됨");
    expect(owned[0]?.toolActivity?.action).toBe("read");
    expect(owned[0]?.toolActivity?.subject).toBe("repository-status");
  });
});
