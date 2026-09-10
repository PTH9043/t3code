import { it as effectIt } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";
import {
  buildConversationHandoff,
  planCompactHandoff,
  prepareCompactHandoff,
} from "./conversationHandoff.ts";

const now = "2026-09-05T03:00:00.000Z";
const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: now,
  updatedAt: now,
});
function fixture(): OrchestrationThread {
  return {
    id: ThreadId.make("thread-a"),
    projectId: ProjectId.make("project-a"),
    title: "Server",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "unchanged-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    handoffMode: "compact",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    session: null,
    messages: [
      message("goal", "user", "서버를 정리해. 모델·추론 수준 유지. 테스트 실패를 숨기지 마."),
      ...Array.from({ length: 12 }, (_, index) =>
        message(
          `progress-${index}`,
          "assistant",
          `파일 ${index} 조사 기록: ${"상세 코드 설명 ".repeat(220)}`,
        ),
      ),
      message("correction", "user", "수정: 서버 실행은 보류하고 문서 작업을 계속해."),
      message("recent-1", "assistant", "파서 수정 완료. 테스트의 timeout 실패는 아직 미해결."),
      message("recent-2", "assistant", "문서를 정리했고 다음은 오류 재현 기록 작성이다."),
      message("current", "user", "이어서 진행해. 이 메시지는 한 번만 전달해."),
      message("queued", "user", "미래 대기열 메시지: 이번 인계에 포함 금지"),
    ],
    activities: [
      {
        id: EventId.make("failure"),
        kind: "tool.completed",
        tone: "error",
        summary: "test exit 1",
        payload: { command: "vp test run parser.test.ts", exitCode: 1 },
        turnId: null,
        createdAt: now,
      },
    ],
    proposedPlans: [
      {
        id: "plan-1",
        turnId: null,
        planMarkdown: "1. timeout 재현\n2. 문서 업데이트",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("refs/t3/checkpoints/1"),
        status: "ready",
        files: [{ path: "parser.cpp", kind: "modified", additions: 3, deletions: 1 }],
        assistantMessageId: null,
        completedAt: now,
      },
    ],
  };
}
const input = (thread = fixture()) => ({
  thread,
  currentMessageId: MessageId.make("current"),
  standardHandoff: buildConversationHandoff(thread.messages)!,
  decisions: [],
});
const plan = (thread = fixture()) =>
  planCompactHandoff(input(thread), (digest) => `/state/${digest}.json`);

describe("conservative conversation handoff", () => {
  it("keeps user corrections, unresolved work, failed checks and checkpoint evidence while reducing repeated progress", () => {
    const result = plan();
    expect(result.report.status).toBe("compact");
    for (const text of [
      "모델·추론 수준 유지",
      "서버 실행은 보류",
      "timeout 실패",
      "vp test run parser.test.ts",
      "parser.cpp",
      "refs/t3/checkpoints/1",
    ])
      expect(result.text).toContain(text);
    expect(result.text).not.toContain("미래 대기열");
    expect(result.text).not.toContain("이 메시지는 한 번만");
    expect(result.text).not.toContain("파일 0 조사 기록");
    expect(result.source?.text).toContain("파일 0 조사 기록");
    expect(result.report.savedChars).toBeGreaterThan(500);
    expect(result.report.sentChars + result.report.savedChars).toBe(result.report.originalChars);
    expect(result.report.sourceHash).toBe(
      NodeCrypto.createHash("sha256").update(result.source!.text).digest("hex"),
    );
  });
  it("retains an early constraint beyond the legacy thirty-message limit", () => {
    const thread = fixture();
    const messages = [...thread.messages];
    messages.splice(
      1,
      0,
      ...Array.from({ length: 35 }, (_, index) =>
        message(`older-${index}`, "assistant", "일상적인 중간 보고."),
      ),
    );
    const result = plan({ ...thread, messages });
    expect(result.report.status).toBe("compact");
    expect(result.text).toContain("테스트 실패를 숨기지 마");
  });
  it("preserves explicit choices even when the provider never acknowledges the answer", () => {
    const result = planCompactHandoff(
      {
        ...input(),
        decisions: [
          {
            id: EventId.make("choice"),
            kind: "thread.user-input-response-requested",
            tone: "info",
            summary: "User decision",
            turnId: null,
            createdAt: now,
            payload: {
              requestId: "question-a",
              answers: { rollout: { answers: ["대화별 선택 적용"] } },
            },
          },
        ],
      },
      () => "/state/source.json",
    );
    expect(result.report.status).toBe("compact");
    expect(result.text).toContain("대화별 선택 적용");
  });
  it("does not truncate a long user instruction to meet its budget", () => {
    const thread = fixture();
    const result = plan({
      ...thread,
      messages: [
        message("long-user", "user", "보존해야 할 제약 ".repeat(3000)),
        ...thread.messages,
      ],
    });
    expect(result.report.reason).toBe("insufficient-savings");
    expect(result.report.savedChars).toBe(0);
  });
  it("keeps short handoffs unchanged", () => {
    const thread = {
      ...fixture(),
      messages: [message("one", "user", "hi"), message("current", "user", "continue")],
    };
    expect(plan(thread).text).toBe(buildConversationHandoff(thread.messages));
  });
  it("excludes the turn's own message and later queued messages from the history block", () => {
    const thread = fixture();
    const bounded = buildConversationHandoff(thread.messages, MessageId.make("current"))!;
    // The switching turn re-appends the current message; quoting it here too made
    // the incoming model answer as if it had already handled the request.
    expect(bounded).not.toContain("이어서 진행해. 이 메시지는 한 번만 전달해.");
    expect(bounded).not.toContain("미래 대기열 메시지: 이번 인계에 포함 금지");
    // Earlier turns still cross over.
    expect(bounded).toContain("수정: 서버 실행은 보류하고 문서 작업을 계속해.");
  });
  it("rejects missing message boundaries, streaming source and unavailable decision history", () => {
    const thread = fixture();
    expect(
      plan({ ...thread, messages: thread.messages.filter((m) => m.id !== "current") }).report
        .reason,
    ).toBe("incomplete-history");
    expect(
      plan({
        ...thread,
        messages: thread.messages.map((m) => (m.id === "recent-1" ? { ...m, streaming: true } : m)),
      }).report.reason,
    ).toBe("incomplete-history");
    expect(planCompactHandoff({ ...input(), decisions: null }, () => "unused").report.reason).toBe(
      "incomplete-history",
    );
  });
  it("keeps the legacy route for historical attachments", () => {
    const thread = fixture();
    const result = plan({
      ...thread,
      messages: thread.messages.map((m) =>
        m.id === "goal"
          ? {
              ...m,
              attachments: [
                {
                  type: "image",
                  id: "image-1",
                  name: "diagram.png",
                  mimeType: "image/png",
                  sizeBytes: 10,
                },
              ],
            }
          : m,
      ),
    });
    expect(result.report.reason).toBe("attachments-present");
  });
  it("does not revive decisions removed by a conversation revert", () => {
    const result = planCompactHandoff(
      {
        ...input(),
        decisions: [
          {
            id: EventId.make("revert"),
            kind: "thread.reverted",
            tone: "info",
            summary: "Reverted",
            turnId: null,
            createdAt: now,
            payload: { turnCount: 1 },
          },
        ],
      },
      () => "unused",
    );
    expect(result.report.reason).toBe("history-reverted");
    expect(result.source).toBeNull();
  });
  it("bounds disk snapshots and changes source hashes when the evidence changes", () => {
    const thread = fixture();
    expect(
      plan({
        ...thread,
        messages: [message("large", "assistant", "x".repeat(2_000_001)), ...thread.messages],
      }).report.reason,
    ).toBe("source-too-large");
    expect(plan({ ...thread, checkpoints: [] }).report.sourceHash).not.toBe(
      plan().report.sourceHash,
    );
  });
  effectIt.effect(
    "writes verified evidence once, repairs corrupt content and falls back on I/O failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-handoff-test-" });
          const first = yield* prepareCompactHandoff({ ...input(), stateDir: dir });
          expect(first.report.status).toBe("compact");
          const filePath = first.source!.filePath;
          expect(yield* fs.readFileString(filePath)).toBe(first.source!.text);
          const second = yield* prepareCompactHandoff({ ...input(), stateDir: dir });
          expect(second.source?.filePath).toBe(filePath);
          yield* fs.writeFileString(filePath, "corrupt");
          const repaired = yield* prepareCompactHandoff({ ...input(), stateDir: dir });
          expect(repaired.report.status).toBe("compact");
          expect(yield* fs.readFileString(filePath)).toBe(first.source!.text);
          const blocked = path.join(dir, "file-as-directory");
          yield* fs.writeFileString(blocked, "occupied");
          const fallback = yield* prepareCompactHandoff({ ...input(), stateDir: blocked });
          expect(fallback.report.reason).toBe("source-unavailable");
          expect(fallback.text).toBe(input().standardHandoff);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
