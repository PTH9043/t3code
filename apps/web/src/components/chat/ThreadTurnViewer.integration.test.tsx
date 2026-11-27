import {
  CheckpointRef,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { ThreadTurnViewer } from "./ThreadTurnViewer";
import { deriveThreadTimelineWork } from "./threadTimelineWork";

it("shows one collapsed row per saved provider call and offers a diff only with turn evidence", () => {
  const turnId = TurnId.make("latest");
  const now = "2026-11-19T00:00:01.000Z";
  const command = "rg " + "fixture-only-long-search-".repeat(16);
  const tool = (
    id: string,
    kind: string,
    call: string,
    toolName: string,
    input: Record<string, string>,
    extra: Record<string, string> = {},
  ): OrchestrationThreadActivity => ({
    id: EventId.make(id),
    turnId,
    createdAt: now,
    kind,
    tone: "tool",
    summary: toolName,
    payload: {
      itemType: "dynamic_tool_call",
      ...(kind === "tool.started" ? { itemId: call } : {}),
      data: {
        toolName,
        input,
        ...(kind === "tool.started" ? {} : { result: { type: "tool_result", tool_use_id: call } }),
      },
      ...extra,
    },
  });
  const search = { command, token: "fixture-only-private-value" };
  const edit = { file_path: "src/revision.ts", patch: "fixture-only-patch-content" };
  const activities = [
    {
      ...tool("a-start", "tool.started", "call-a", "Bash", search, {
        reportedModel: "observed-worker",
      }),
      createdAt: "2026-11-19T00:00:00.000Z",
    },
    tool("b-start", "tool.started", "call-b", "Bash", search),
    tool("a-update", "tool.updated", "call-a", "Bash", search),
    tool("b-done", "tool.completed", "call-b", "Bash", search),
    tool("a-done", "tool.completed", "call-a", "Bash", search),
    // Saved rows without a sequence can sort a same-millisecond update after completion.
    tool("a-final-update", "tool.updated", "call-a", "Bash", search),
    tool("edit", "tool.completed", "call-edit", "Edit", edit),
    tool(
      "child",
      "tool.completed",
      "call-child",
      "Read",
      { file_path: "child-only.ts" },
      {
        agentId: "nested-agent",
      },
    ),
    {
      ...tool("old", "tool.completed", "call-a", "Read", { file_path: "old-only.ts" }),
      turnId: TurnId.make("earlier"),
    },
  ];
  const workLog = deriveThreadTimelineWork(activities);
  const groups = workLog
    .filter((row) => row.turnId === turnId)
    .flatMap((row) => (row.toolActivity ? [row.toolActivity] : []));
  expect(groups).toHaveLength(3);
  const byCall = new Map(groups.map((group) => [group.callId, group]));
  const first = byCall.get("call-a");
  expect(first?.eventIds.toSorted()).toEqual(["a-done", "a-final-update", "a-start", "a-update"]);
  expect(first).toMatchObject({ action: "search", phase: "completed" });
  expect(byCall.get("call-b")?.eventIds.toSorted()).toEqual(["b-done", "b-start"]);
  expect(byCall.get("call-edit")).toMatchObject({ action: "edit", eventIds: ["edit"] });
  const checkpoint = {
    turnId,
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make("refs/checkpoints/fixture"),
    status: "ready" as const,
    files: [{ path: "src/checkpoint-only.ts", kind: "modified", additions: 1, deletions: 0 }],
    assistantMessageId: null,
    completedAt: now,
  };
  const render = (hasCheckpoint: boolean) =>
    renderToStaticMarkup(
      <ThreadTurnViewer
        thread={{
          id: ThreadId.make("saved-room"),
          session: null,
          activities,
          messages: [],
          latestTurn: {
            turnId,
            state: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            assistantMessageId: null,
          },
        }}
        nextModel={null}
        blocks={new Map()}
        workLog={workLog}
        checkpoints={hasCheckpoint ? [checkpoint] : []}
        pendingApprovals={[]}
        onOpenTurnDiff={() => {}}
      />,
    );
  const html = render(true);
  for (const group of groups) {
    expect(html).toContain(group.summary);
  }
  expect(html).toContain("observed-worker");
  expect(html).toContain("src/checkpoint-only.ts · 차이 보기");
  expect(html).not.toContain("src/revision.ts · 차이 보기");
  expect(render(false)).not.toContain("차이 보기");
  for (const hidden of [
    command,
    search.token,
    edit.patch,
    "child-only.ts",
    "old-only.ts",
    "요약자 ·",
  ]) {
    expect(html).not.toContain(hidden);
  }
});
