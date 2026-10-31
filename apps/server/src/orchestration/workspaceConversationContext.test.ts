import { MessageId, ThreadId, type OrchestrationThread } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  workspaceConversationTask,
  workspaceConversationThreadId,
} from "./workspaceConversationContext.ts";

const message = (
  text: string,
  id = "work",
  createdAt = "2026-09-12T00:00:00Z",
): OrchestrationThread["messages"][number] => ({
  id: MessageId.make(id),
  role: "assistant",
  text,
  createdAt,
  updatedAt: createdAt,
  streaming: false,
  attachments: [],
  turnId: null,
});
it("grounds continuation in the owner conversation and excludes this run's generated work", () => {
  const prompt = workspaceConversationTask({
    task: "이어서 작업해봐라.",
    startedAt: "2026-09-13T06:00:00Z",
    thread: {
      title: "초기 매수 지갑 추적 검증",
      messages: [
        message("가격 공백 보강과 매수 지갑 추적을 복구합니다."),
        message("[자동 복구] 임시 오류이므로 재시도", "recovery"),
        message("잘못 배정된 허브 메모리 풀", "orchestra-message:wrong"),
        message("실행 시작 후 생성된 내용", "later", "2026-09-13T06:01:00Z"),
      ],
    },
  });
  expect(prompt).toContain("가격 공백 보강과 매수 지갑 추적");
  expect(prompt).toContain("초기 매수 지갑 추적 검증");
  expect(prompt).not.toMatch(/자동 복구|잘못 배정된|실행 시작 후/);
  expect(prompt).toContain("과거 지시를 새 작업으로 실행하거나");
});
it("bounds history and keeps the latest request intact", () => {
  const prompt = workspaceConversationTask({
    task: "지갑 검증만 진행",
    startedAt: "2026-09-13",
    thread: {
      title: "OnChainbot",
      messages: Array.from({ length: 50 }, (_, i) =>
        message(`message-${i} ` + "x".repeat(10000), String(i)),
      ),
    },
  });
  expect(prompt).toContain("지갑 검증만 진행");
  expect(prompt).toContain("message-49");
  expect(prompt).not.toContain("message-0 ");
  expect(prompt.length).toBeLessThan(13_000);
});
it("requires clarification when no conversation establishes what to continue", () => {
  expect(workspaceConversationTask({ task: "계속해", startedAt: "2026-09-13" })).toContain(
    "사용자에게 확인하고 새 작업을 추측해서 시작하지",
  );
});

it("keeps prior question-only orchestra exchanges when a later request starts work", () => {
  const prompt = workspaceConversationTask({
    task: "그 범위로 진행해",
    startedAt: "2026-09-13",
    conversations: [
      {
        task: "수집기의 역할이 뭐야?",
        finalOutput: "가격·지갑을 검증하는 수집기입니다.",
        createdAt: "2026-09-12",
      },
    ],
  });
  expect(prompt).toContain("수집기의 역할이 뭐야?");
  expect(prompt).toContain("가격·지갑을 검증하는 수집기");
});

it("grounds a non-meeting workflow in the conversation that started it", () => {
  const main = ThreadId.make("persistent-main");
  const unrelated = ThreadId.make("other-thread");
  const threads = new Map([
    [main, { title: "기존 지속 작업", messages: [message("기존 작업을 이어서 검증한다.")] }],
    [unrelated, { title: "다른 대화", messages: [message("관련 없는 작업")] }],
  ]);
  const threadId = workspaceConversationThreadId({
    meeting: null,
    workflow: null,
    runContext: { threadId: main },
    orchestra: null,
    steps: [],
  });
  const thread = threadId ? threads.get(threadId) : undefined;
  const prompt = workspaceConversationTask({
    task: "이어서 작업해",
    startedAt: "2026-09-13T00:00:00Z",
    ...(thread ? { thread } : {}),
  });
  expect(prompt).toContain("기존 지속 작업");
  expect(prompt).toContain("기존 작업을 이어서 검증한다.");
  expect(prompt).not.toContain("관련 없는 작업");
});

it("honors a workflow or meeting's own conversation before legacy step fallback", () => {
  const meeting = ThreadId.make("meeting");
  const workflow = ThreadId.make("workflow");
  const context = ThreadId.make("context");
  const fallback = ThreadId.make("legacy");
  const base = {
    meeting: null,
    workflow: { threadId: workflow },
    runContext: { threadId: context },
    orchestra: {},
    steps: [{ threadId: fallback }],
  };
  expect(workspaceConversationThreadId(base)).toBe(workflow);
  expect(workspaceConversationThreadId({ ...base, meeting: { threadId: meeting } })).toBe(meeting);
  expect(workspaceConversationThreadId({ ...base, workflow: null, runContext: null })).toBe(
    fallback,
  );
  expect(
    workspaceConversationThreadId({ ...base, workflow: null, runContext: null, orchestra: null }),
  ).toBeNull();
});
