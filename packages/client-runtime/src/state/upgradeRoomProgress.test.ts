import { expect, it } from "vite-plus/test";
import { describeUpgradeRoomProgress, selectUpgradeRoomProgress } from "./threadToolActivity.ts";

const at = "2026-11-19T11:53:56.000Z";
const tool = {
  kind: "tool.updated",
  summary: "Review global settings implementation",
  turnId: "turn",
  createdAt: at,
  payload: { itemType: "collab_agent_tool_call" },
};
const select = (
  activities: Parameters<typeof selectUpgradeRoomProgress>[3],
  id = "autousage-upgrade-room",
) => selectUpgradeRoomProgress(id, "turn", at, activities);

it("scopes progress to the current upgrade room turn, excluding metadata", () => {
  expect(
    select([
      tool,
      { ...tool, turnId: "old", createdAt: "2026-11-19T11:54:00Z" },
      { ...tool, kind: "context-window.updated" },
    ]),
  ).toMatchObject({ label: "하위 AI · Review global settings implementation", recordedAt: at });
  expect(select([tool], "another-room")).toBeNull();
  expect(selectUpgradeRoomProgress("autousage-upgrade-room", null, at, [tool])).toBeNull();
});

it("distinguishes a stale receipt from an active tool and prioritizes user input", () => {
  const progress = select([tool])!;
  expect(describeUpgradeRoomProgress(progress, Date.parse(at) + 10_000, null)).toBe(
    "마지막 작업 기록",
  );
  expect(describeUpgradeRoomProgress(progress, Date.parse(at) + 180_000, null)).toBe(
    "3분간 새 작업 기록 없음",
  );
  expect(describeUpgradeRoomProgress(progress, Date.parse(at) + 180_000, "질문 답변 대기")).toBe(
    "질문 답변 대기",
  );
  expect(describeUpgradeRoomProgress(select([])!, Date.parse(at) + 5_000, null)).toBe(
    "아직 작업 기록 없음",
  );
});

// Payloads below are the shape clients receive: the server drops a provider's raw tool
// arguments and stamps `toolActivityOperation` with the work and its displayable paths.
const wire = (
  kind: string,
  summary: string,
  operation: Record<string, unknown>,
  createdAt = at,
) => ({
  ...tool,
  kind,
  summary,
  createdAt,
  payload: { itemType: "dynamic_tool_call", data: {}, toolActivityOperation: operation },
});

it("names the work, its target file and how many tools finished, never the tool input text", () => {
  const read = wire("tool.completed", "read", {
    action: "read",
    phase: "completed",
    targetPaths: ["ChatView.tsx"],
  });
  expect(select([{ ...read, kind: "tool.started" }, read])).toMatchObject({
    label: "파일 읽기 종료 · ChatView.tsx",
    completedTools: 1,
  });
  const grep = wire("tool.completed", "grep", {
    action: "search",
    phase: "completed",
    targetPaths: ["repo"],
  });
  expect(select([read, grep])).toMatchObject({ label: "자료 검색 종료 · repo", completedTools: 2 });
  const other = wire("tool.started", "t3-code_workspace_memory started", {
    action: "other",
    phase: "started",
    targetPaths: [],
  });
  expect(select([other])).toMatchObject({
    label: "도구 실행 시작 · t3-code_workspace_memory",
    completedTools: 0,
  });
  const delegated = {
    ...read,
    createdAt: "2026-11-19T11:54:30.000Z",
    payload: { ...read.payload, agentId: "child-session" },
  };
  expect(select([read, delegated])).toMatchObject({
    label: "하위 AI · 파일 읽기 종료 · ChatView.tsx",
    recordedAt: "2026-11-19T11:54:30.000Z",
  });
  // A running tool's summary is its title, which providers fill from the input.
  expect(select([{ ...other, kind: "tool.updated", summary: "private-query" }])).toMatchObject({
    label: "도구 실행 시작",
  });
  const edit = {
    ...wire("tool.completed", "edit", {
      action: "edit",
      phase: "completed",
      targetPaths: ["ChatView.tsx"],
      editCompletionReported: true,
    }),
    payload: {
      itemType: "file_change",
      detail: "Edit applied successfully.",
      data: {},
      toolActivityOperation: {
        action: "edit",
        phase: "completed",
        targetPaths: ["ChatView.tsx"],
        editCompletionReported: true,
      },
    },
  };
  expect(select([edit])?.label).toContain("ChatView.tsx");
});

it("shows which plan step the agent is on from its latest plan", () => {
  const planned = (createdAt: string, statuses: readonly string[]) => ({
    ...tool,
    kind: "turn.plan.updated",
    summary: "Plan updated",
    createdAt,
    payload: { plan: statuses.map((status, index) => ({ step: `단계 ${index + 1}`, status })) },
  });
  const first = planned(at, ["inProgress", "pending", "pending"]);
  const second = planned("2026-11-19T11:55:00.000Z", ["completed", "inProgress", "pending"]);
  expect(select([second, first])).toMatchObject({
    label: null,
    plan: "계획 1/3 완료 · 지금: 단계 2",
    completedTools: 0,
  });
  expect(select([first, second, { ...tool, createdAt: "2026-11-19T11:56:00.000Z" }])).toMatchObject(
    {
      label: "하위 AI · Review global settings implementation",
      plan: "계획 1/3 완료 · 지금: 단계 2",
    },
  );
  expect(select([planned(at, ["completed", "completed"])])).toMatchObject({
    plan: "계획 2/2 완료",
  });
  expect(select([tool])).toMatchObject({ plan: null });
  expect(select([second, planned("2026-11-19T11:58:00.000Z", [])])).toMatchObject({ plan: null });
  expect(select([{ ...second, turnId: "old" }])).toMatchObject({ plan: null });
});

it("shows a changed file without exposing raw tool output", () => {
  expect(
    selectUpgradeRoomProgress("autousage-upgrade-room", "turn", at, [
      {
        ...tool,
        kind: "tool.completed",
        summary: "apply_patch",
        payload: {
          itemType: "file_change",
          detail:
            "Success. Updated the following files:\nM apps/web/ChatView.tsx\nM apps/mobile/ThreadFeed.tsx",
        },
      },
    ]),
  ).toMatchObject({ label: "파일 수정 완료 · ChatView.tsx 외 1개" });
});
