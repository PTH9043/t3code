import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  buildThreadFeed,
  buildPendingUserInputAnswers,
  buildPendingUserInputImages,
  derivePendingUserInputs,
  deriveThreadFeedPresentation,
  setPendingUserInputCustomAnswer,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
} from "./threadActivity";

it("keeps a question image with its answer and sends the upload without client-only fields", () => {
  const image = {
    id: "draft-image",
    type: "image" as const,
    name: "photo.png",
    mimeType: "image/png",
    sizeBytes: 3,
    dataUrl: "data:image/png;base64,YWJj",
    previewUri: "file:///photo.png",
  };
  const draft = setPendingUserInputCustomAnswer({ images: [image] }, "details");
  expect(draft.images).toEqual([image]);
  expect(
    buildPendingUserInputAnswers(
      [{ id: "q", header: "Q", question: "?", options: [], multiSelect: false }],
      { q: { images: [image] } },
    ),
  ).toEqual({ q: "첨부한 이미지를 참고해 주세요." });
  expect(buildPendingUserInputImages({ q: draft })).toEqual([
    {
      questionId: "q",
      image: {
        type: "image",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,YWJj",
      },
    },
  ]);
});

it("retains a free-text native question until its request is resolved", () => {
  const question = makeActivity({
    id: EventId.make("question-free-text"),
    createdAt: "2026-10-26T00:00:00.000Z",
    kind: "user-input.requested",
    summary: "Question",
    payload: {
      requestId: "free-text",
      questions: [{ id: "target", header: "Target", question: "Which directory?", options: [] }],
    },
  });
  expect(derivePendingUserInputs([question])[0]?.questions[0]?.options).toEqual([]);
  const resolved = makeActivity({
    id: EventId.make("question-resolved"),
    createdAt: "2026-10-26T00:00:01.000Z",
    kind: "user-input.resolved",
    summary: "Closed",
    payload: { requestId: "free-text", reason: "provider-resolved" },
  });
  expect(derivePendingUserInputs([question, resolved])).toEqual([]);
});

it("keeps a question visible when its delivery after restart is uncertain", () => {
  const requestId = "async:delivery-unknown";
  const detail = "답변이 전달됐는지 확인할 수 없습니다.";
  const question = makeActivity({
    id: EventId.make("uncertain-question"),
    kind: "user-input.requested",
    summary: "Question",
    createdAt: "2026-10-26T00:00:00.000Z",
    payload: {
      requestId,
      questions: [{ id: "q", header: "Q", question: "Which year?", options: [] }],
    },
  });
  const warning = makeActivity({
    id: EventId.make("uncertain-warning"),
    kind: "provider.user-input.respond.failed",
    summary: "질문 답변의 전달 여부를 확인해 주세요",
    tone: "error",
    createdAt: "2026-10-26T00:00:01.000Z",
    payload: { requestId, code: "delivery-unknown-after-restart", detail },
  });
  expect(derivePendingUserInputs([question, warning]).map((entry) => entry.requestId)).toEqual([
    requestId,
  ]);
  const thread = makeThread({
    id: ThreadId.make("uncertain"),
    projectId: ProjectId.make("uncertain"),
    title: "Question",
    activities: [question, warning],
  });
  expect(JSON.stringify(buildThreadFeed(thread))).toContain(detail);
});

function makeActivity(
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, "id" | "kind" | "summary" | "createdAt">,
): OrchestrationThreadActivity {
  return {
    tone: "info",
    payload: {},
    turnId: null,
    ...input,
  };
}

function makeThread(
  input: Partial<OrchestrationThread> & Pick<OrchestrationThread, "id" | "projectId" | "title">,
): OrchestrationThread {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...input,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
  };
}

describe("buildThreadFeed", () => {
  it("retains a legacy restart as a dated background task in the native history", () => {
    const at = "2026-11-12T10:20:00+09:00";
    const thread = makeThread({
      id: ThreadId.make("restart-history"),
      projectId: ProjectId.make("project"),
      title: "History",
      activities: [
        makeActivity({
          id: EventId.make("restart"),
          kind: "session.recovered",
          summary: "서버 재시작으로 백그라운드 감시 2개가 끊겼습니다",
          createdAt: at,
          payload: { interruptedTasks: [{ taskId: "one" }, { taskId: "two" }] },
        }),
      ],
    });
    expect(buildThreadFeed(thread)).toMatchObject([
      {
        type: "activity-group",
        activities: [
          {
            id: "restart",
            createdAt: at,
            summary: "서버 재시작으로 중단된 항목 · 백그라운드 작업 2개",
          },
        ],
      },
    ]);
  });
  it("hides internal question delivery markers while keeping delivery failures visible", () => {
    const thread = makeThread({
      id: ThreadId.make("delivery-markers"),
      projectId: ProjectId.make("delivery-markers"),
      title: "Question",
      activities: [
        makeActivity({
          id: EventId.make("queued"),
          kind: "provider.user-input.recovery.queued",
          summary: "Queued",
          createdAt: "2026-04-01T00:00:01.000Z",
        }),
        makeActivity({
          id: EventId.make("started"),
          kind: "provider.user-input.delivery.started",
          summary: "Sending",
          createdAt: "2026-04-01T00:00:02.000Z",
        }),
        makeActivity({
          id: EventId.make("failed"),
          kind: "provider.turn.start.failed",
          summary: "Failed",
          tone: "error",
          createdAt: "2026-04-01T00:00:03.000Z",
        }),
      ],
    });
    expect(buildThreadFeed(thread)).toMatchObject([
      { type: "activity-group", activities: [{ id: "failed", summary: "Failed" }] },
    ]);
  });

  it("keeps a failed conversation handoff in the conversation activity", () => {
    const summary = "이전 대화 인계 준비에 실패해 AI에 누락을 알렸습니다.";
    const thread = makeThread({
      id: ThreadId.make("handoff-notice-thread"),
      projectId: ProjectId.make("handoff-notice-project"),
      title: "Handoff",
      activities: [
        makeActivity({
          id: EventId.make("handoff-notice"),
          kind: "conversation.handoff.unavailable",
          summary,
          tone: "error",
          createdAt: "2026-04-01T00:00:01.000Z",
        }),
      ],
    });
    expect(buildThreadFeed(thread)).toMatchObject([
      { type: "activity-group", activities: [{ id: "handoff-notice", summary }] },
    ]);
  });

  it("keeps historic work entries attributed to their turns", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Runtime warning thread",
      latestTurn: {
        turnId: TurnId.make("turn-latest"),
        state: "running",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("activity-old"),
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-old"),
          payload: {
            message: "Old warning",
          },
        }),
        makeActivity({
          id: EventId.make("activity-latest"),
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-01T00:00:03.000Z",
          turnId: TurnId.make("turn-latest"),
          payload: {
            message: "Latest warning",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(feed).toMatchObject([
      {
        type: "activity-group",
        turnId: "turn-old",
        activities: [{ id: "activity-old", turnId: "turn-old" }],
      },
      {
        type: "activity-group",
        turnId: "turn-latest",
        activities: [{ id: "activity-latest", turnId: "turn-latest" }],
      },
    ]);
  });

  it("collapses matching tool lifecycle rows like desktop", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-1"),
      title: "Collapsed tools",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:03.000Z",
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("tool-updated"),
          kind: "tool.updated",
          tone: "tool",
          summary: "Run tests",
          createdAt: "2026-04-01T00:00:01.000Z",
          turnId: TurnId.make("turn-1"),
          payload: {
            toolCallId: "shared-test-call",
            title: "Run tests",
            itemType: "command_execution",
            data: { item: { command: "node --test" } },
          },
        }),
        makeActivity({
          id: EventId.make("tool-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Run tests completed",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-1"),
          payload: {
            toolCallId: "shared-test-call",
            title: "Run tests",
            itemType: "command_execution",
            data: { item: { command: "node --test" } },
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const group = feed[0];

    expect(group).toMatchObject({
      type: "activity-group",
    });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities).toHaveLength(1);
    expect(group.activities[0]).toMatchObject({
      id: "tool-updated",
      createdAt: "2026-04-01T00:00:01.000Z",
      turnId: "turn-1",
      summary: expect.stringContaining("테스트"),
      detail: null,
      canExpand: true,
      icon: "command",
      toolLike: true,
      status: "success",
    });
    expect(group.activities[0]?.getFullDetail()).toContain("node --test");
    expect(group.activities[0]?.getCopyText()).toContain("테스트");
    expect(group.activities[0]?.presented?.toolActivity?.eventIds).toEqual([
      "tool-updated",
      "tool-completed",
    ]);
  });

  it("keeps masked MCP input fields available to expanded mobile work rows", () => {
    const turnId = TurnId.make("turn-mcp");
    const thread = makeThread({
      id: ThreadId.make("thread-mcp"),
      projectId: ProjectId.make("project-1"),
      title: "Expandable MCP call",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:03.000Z",
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("mcp-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Call repository tool",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId,
          payload: {
            title: "Call repository tool",
            itemType: "mcp_tool_call",
            detail: "repository.search",
            status: "completed",
            data: {
              item: {
                server: "repository",
                tool: "search",
                arguments: { query: "work log" },
              },
            },
          },
        }),
      ],
    });

    const group = buildThreadFeed(thread)[0];
    expect(group).toMatchObject({ type: "activity-group" });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities[0]?.canExpand).toBe(true);
    expect(group.activities[0]?.getFullDetail()).toContain("query=•••");
    expect(group.activities[0]?.getFullDetail()).not.toContain("work log");
  });

  it("keeps arbitrary large tool output out of technical previews and copied summaries", () => {
    let serializedToolOutputs = 0;
    const activities = Array.from({ length: 5_000 }, (_, index) =>
      makeActivity({
        id: EventId.make(`large-tool-${index}`),
        kind: "tool.completed",
        tone: "tool",
        summary: `Tool ${index}`,
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, index)).toISOString(),
        payload: {
          title: `Tool ${index}`,
          itemType: "mcp_tool_call",
          status: "completed",
          data: {
            item: {
              toJSON: () => {
                serializedToolOutputs += 1;
                return { output: "x".repeat(32_768) };
              },
            },
          },
        },
      }),
    );
    const thread = makeThread({
      id: ThreadId.make("thread-large-tools"),
      projectId: ProjectId.make("project-1"),
      title: "Large tools",
      activities,
    });

    const feed = buildThreadFeed(thread);
    expect(serializedToolOutputs).toBe(0);

    const group = feed[0];
    expect(group).toMatchObject({ type: "activity-group" });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities).toHaveLength(5_000);
    expect(group.activities[0]?.getFullDetail()).not.toContain('"output"');
    expect(group.activities[0]?.getCopyText()).not.toContain('"output"');
    expect(serializedToolOutputs).toBe(0);
  });

  it("folds settled turn work while leaving the terminal answer visible", () => {
    const turnId = TurnId.make("turn-1");
    const thread = makeThread({
      id: ThreadId.make("thread-3"),
      projectId: ProjectId.make("project-1"),
      title: "Folded work",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:18.000Z",
        assistantMessageId: MessageId.make("assistant-final"),
      },
      messages: [
        {
          id: MessageId.make("assistant-commentary"),
          role: "assistant",
          text: "I am checking.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:02.000Z",
          updatedAt: "2026-04-01T00:00:03.000Z",
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "Done.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:17.000Z",
          updatedAt: "2026-04-01T00:00:18.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("tool-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Read files",
          createdAt: "2026-04-01T00:00:05.000Z",
          turnId,
          payload: {
            title: "Read files",
            itemType: "file_read",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["turn-fold:turn-1", "assistant-final"]);
    expect(collapsed[0]).toMatchObject({
      type: "turn-fold",
      label: "Worked for 17s",
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set([turnId]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-commentary",
      "tool-completed",
      "assistant-final",
    ]);
  });

  it("measures a steer-superseded turn from its user boundary through trailing work", () => {
    const firstTurnId = TurnId.make("turn-1");
    const secondTurnId = TurnId.make("turn-2");
    const thread = makeThread({
      id: ThreadId.make("thread-steered"),
      projectId: ProjectId.make("project-1"),
      title: "Steered work",
      latestTurn: {
        turnId: secondTurnId,
        state: "running",
        requestedAt: "2026-04-01T00:00:14.000Z",
        startedAt: "2026-04-01T00:00:14.000Z",
        completedAt: null,
        assistantMessageId: MessageId.make("assistant-next"),
      },
      messages: [
        {
          id: MessageId.make("user-1"),
          role: "user",
          text: "Do it once more.",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: MessageId.make("assistant-commentary"),
          role: "assistant",
          text: "Kicking off call 1.",
          turnId: firstTurnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:09.000Z",
          updatedAt: "2026-04-01T00:00:09.000Z",
        },
        {
          id: MessageId.make("user-2"),
          role: "user",
          text: "Actually do 15.",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:00:14.000Z",
          updatedAt: "2026-04-01T00:00:14.000Z",
        },
        {
          id: MessageId.make("assistant-next"),
          role: "assistant",
          text: "One down - adjusting.",
          turnId: secondTurnId,
          streaming: true,
          createdAt: "2026-04-01T00:00:17.000Z",
          updatedAt: "2026-04-01T00:00:17.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("work-1"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Ran command",
          createdAt: "2026-04-01T00:00:12.000Z",
          turnId: firstTurnId,
          payload: {
            title: "Ran command",
            itemType: "command_execution",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    expect(collapsed.find((entry) => entry.type === "turn-fold")).toMatchObject({
      turnId: firstTurnId,
      label: "Worked for 12s",
    });
  });

  it("keeps an active turn expanded and classifies error-shaped tool output", () => {
    const turnId = TurnId.make("turn-running");
    const thread = makeThread({
      id: ThreadId.make("thread-4"),
      projectId: ProjectId.make("project-1"),
      title: "Running work",
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("tool-failed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Run command",
          createdAt: "2026-04-01T00:00:05.000Z",
          turnId,
          payload: {
            title: "Run command",
            itemType: "command_execution",
            detail: "zsh: command not found: nope",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(deriveThreadFeedPresentation(feed, thread.latestTurn, new Set())).toEqual(feed);
    expect(feed[0]).toMatchObject({
      type: "activity-group",
      activities: [{ status: "failure" }],
    });
  });

  it("appends active work as a normal timeline row", () => {
    const startedAt = "2026-04-01T00:00:01.000Z";
    const presented = deriveThreadFeedPresentation([], null, new Set(), new Set(), startedAt);

    expect(presented).toEqual([
      {
        type: "working",
        id: "working-indicator-row",
        createdAt: startedAt,
      },
    ]);
    expect(deriveThreadFeedPresentation(presented, null, new Set())).toEqual([]);
  });

  it("models work-log overflow as list rows", () => {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity["status"] = "success",
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      turnId: null,
      summary: `Tool ${id}`,
      detail: null,
      canExpand: false,
      getFullDetail: () => null,
      getCopyText: () => id,
      icon: "command",
      toolLike: true,
      status,
    });
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "work-group-1",
        createdAt: "2026-04-01T00:00:01.000Z",
        turnId: null,
        activities: [
          activity("activity-1", "2026-04-01T00:00:01.000Z"),
          activity("activity-neutral", "2026-04-01T00:00:02.000Z", "neutral"),
          activity("activity-2", "2026-04-01T00:00:03.000Z"),
          activity("activity-3", "2026-04-01T00:00:04.000Z"),
        ],
      },
    ];

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["activity-3", "work-toggle:work-group-1"]);
    expect(collapsed[1]).toMatchObject({
      type: "work-toggle",
      groupId: "work-group-1",
      hiddenCount: 2,
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, null, new Set(), new Set(["work-group-1"]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "work-toggle:work-group-1",
    ]);
    expect(expanded.at(-1)).toMatchObject({
      type: "work-toggle",
      expanded: true,
    });
  });
});

describe("quiet timeline: nested agents", () => {
  it("keeps a nested agent's terminal row but hides its background work", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-nested"),
      projectId: ProjectId.make("project-1"),
      title: "Nested agents",
      activities: [
        // A subagent's own shell: internal, covered by the owner's liveness.
        makeActivity({
          id: EventId.make("shell-done"),
          kind: "task.completed",
          summary: "Task completed",
          createdAt: "2026-04-01T00:00:02.000Z",
          payload: { taskId: "sh-1", agentId: "owner", agentKind: "background" },
        }),
        // A nested AGENT's completion: mobile has no Agents sheet, so this
        // terminal row is the only signal it ever finished.
        makeActivity({
          id: EventId.make("nested-done"),
          kind: "task.completed",
          summary: "Task completed",
          createdAt: "2026-04-01T00:00:03.000Z",
          payload: { taskId: "n-1", agentId: "owner", agentKind: "agent" },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const ids = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities.map((row) => row.id) : [],
    );
    expect(ids).toContain("nested-done");
    expect(ids).not.toContain("shell-done");
  });
});
