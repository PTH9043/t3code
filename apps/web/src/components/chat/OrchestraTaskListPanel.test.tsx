import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveOrchestraTaskLists,
  type OrchestraTaskList,
} from "@t3tools/client-runtime/state/presentation";
import { WorkspaceOrchestraBlock, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  DEFAULT_ORCHESTRA_LIST_STATE,
  OrchestraTaskListPanel,
  type OrchestraListState,
} from "./OrchestraTaskListPanel";

const decodeBlock = Schema.decodeUnknownSync(WorkspaceOrchestraBlock);
const owner = ThreadId.make("owner");
function fixture(): OrchestraTaskList {
  const blocks = [
    { nodeId: "compute", attempt: 1, status: "failed", text: "old failure evidence" },
    { nodeId: "compute", attempt: 2, status: "completed", text: "completed output" },
    { nodeId: "report", attempt: 1, status: "running", text: "live report output" },
  ].map((entry) => ({
    ...entry,
    block: decodeBlock({
      ...entry,
      executionId: `${entry.nodeId}-${entry.attempt}`,
      ownerThreadId: owner,
      runId: "run",
      messageId: `${entry.nodeId}-${entry.attempt}`,
      title: entry.nodeId,
      displayName: "Codex Sol",
      role: "implementer",
      kind: "implementation",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      instruction: "Do assigned work",
    }),
  }));
  return deriveOrchestraTaskLists({
    ownerThreadId: owner,
    runs: [],
    blocks: new Map(blocks.map((entry) => [entry.block.messageId, entry.block])),
    messages: blocks.map((entry) => ({
      id: entry.block.messageId,
      text: entry.text,
      streaming: entry.status === "running",
      createdAt: "2026-09-13T04:00:00.000Z",
    })),
  })[0]!;
}
const render = (state: OrchestraListState = DEFAULT_ORCHESTRA_LIST_STATE) =>
  renderToStaticMarkup(
    <OrchestraTaskListPanel
      list={fixture()}
      state={state}
      onChange={() => {}}
      renderAttempt={(attempt) => <p>{attempt.text}</p>}
    />,
  );

describe("OrchestraTaskListPanel", () => {
  it("keeps wait reasons visible and mounts usage only for expanded tasks", () => {
    const list = fixture();
    const markup = renderToStaticMarkup(
      <OrchestraTaskListPanel
        list={{
          ...list,
          tasks: list.tasks.map((task) => ({
            ...task,
            waitReason: "선행 작업 대기: 원본 처리",
            completedAttemptMs: 5500,
          })),
        }}
        state={{ ...DEFAULT_ORCHESTRA_LIST_STATE, expanded: { compute: false, report: true } }}
        onChange={() => {}}
        renderAttempt={() => null}
        renderUsage={(task) => <span>사용량 조회 대상:{task.id}</span>}
      />,
    );
    expect(markup).toContain("선행 작업 대기: 원본 처리");
    expect(markup).toContain("5.5초");
    expect(markup).toContain("사용량 조회 대상:report");
    expect(markup).not.toContain("사용량 조회 대상:compute");
  });
  it("shows a conductor question as answer waiting instead of running even with collapsed tasks", () => {
    const markup = renderToStaticMarkup(
      <OrchestraTaskListPanel
        list={{ ...fixture(), status: "running", question: "어느 작업을 우선할까요?" }}
        state={{ ...DEFAULT_ORCHESTRA_LIST_STATE, expanded: { compute: false, report: false } }}
        onChange={() => {}}
        renderAttempt={() => null}
      />,
    );
    expect(markup).toContain("답변 대기");
    expect(markup).toContain("어느 작업을 우선할까요?");
    expect(markup).toContain("대화 입력창에서 답변하면 작업이 이어집니다.");
    expect(markup).not.toContain(">진행 중<");
  });
  it("keeps the last received activity visible when the task is collapsed", () => {
    const list = fixture();
    const markup = renderToStaticMarkup(
      <OrchestraTaskListPanel
        list={{
          ...list,
          tasks: list.tasks.map((task) => ({
            ...task,
            progress: { summary: "검증 명령 실행 중", createdAt: "2026-09-13T04:02:00.000Z" },
          })),
        }}
        state={{ ...DEFAULT_ORCHESTRA_LIST_STATE, expanded: { compute: false, report: false } }}
        onChange={() => {}}
        renderAttempt={() => <p>hidden body</p>}
      />,
    );
    expect(markup).toContain("최근 활동 · 검증 명령 실행 중");
    expect(markup).toContain('dateTime="2026-09-13T04:02:00.000Z"');
    expect(markup).not.toContain("hidden body");
  });
  it("renders one task row per node, defaults completed work closed, and leaves the current output visible", () => {
    const markup = render();
    expect(markup.match(/data-orchestra-task=/g)).toHaveLength(2);
    expect(markup).toContain("재시도 1회");
    expect(markup).not.toContain("completed output");
    expect(markup).toContain("live report output");
    expect(markup).not.toContain("old failure evidence");
    expect(markup).toContain("모두 접기");
    expect(markup).toContain("모두 펼치기");
    expect(markup).not.toContain("href=");
  });

  it("filters without discarding expanded task or retry history state", () => {
    const state: OrchestraListState = {
      filter: "completed",
      expanded: { compute: true },
      history: { compute: true },
    };
    const markup = render(state);
    expect(markup).toContain("completed output");
    expect(markup).toContain("old failure evidence");
    expect(markup).not.toContain("live report output");
    expect(render({ ...state, filter: "running" })).toContain("live report output");
    expect(render({ ...state, filter: "all" })).toContain("old failure evidence");
  });

  it("shows an empty filter state with controls to return to the full list", () => {
    const markup = render({ ...DEFAULT_ORCHESTRA_LIST_STATE, filter: "attention" });
    expect(markup).toContain("이 상태의 작업이 없습니다.");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("전체");
    expect(markup).not.toContain("data-orchestra-task=");
  });
});

it("shows cancellation progress separately from a confirmed stop, including runs with no tasks", () => {
  for (const [status, label] of [
    ["cancel-requested", "중지 중"],
    ["cancelled", "중지됨"],
  ] as const) {
    const markup = renderToStaticMarkup(
      <OrchestraTaskListPanel
        list={{ ...fixture(), status, tasks: [] }}
        state={DEFAULT_ORCHESTRA_LIST_STATE}
        onChange={() => {}}
        renderAttempt={() => null}
      />,
    );
    expect(markup).toContain(label);
    if (status === "cancelled") expect(markup).not.toContain("배정을 기다리는");
  }
});
