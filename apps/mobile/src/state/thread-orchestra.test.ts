import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type WorkspaceCollaborationRun } from "@t3tools/contracts";
import {
  activeThreadOrchestra,
  prepareThreadOrchestraMessage,
  selectThreadOrchestraOption,
} from "./thread-orchestra";

const threadId = ThreadId.make("this-conversation");
const run = {
  id: "run",
  status: "running",
  meeting: { threadId, pendingQuestion: null },
} as WorkspaceCollaborationRun;

describe("conversation orchestra routing", () => {
  it("replaces a prior choice while preserving the user's own answer text", () => {
    const options = ["첫째", "둘째"];
    expect(selectThreadOrchestraOption("", options, "첫째")).toBe("첫째");
    expect(selectThreadOrchestraOption("첫째", options, "둘째")).toBe("둘째");
    expect(selectThreadOrchestraOption("추가 설명", options, "첫째")).toBe("추가 설명\n첫째");
    expect(selectThreadOrchestraOption("추가 설명\n첫째", options, "둘째")).toBe("추가 설명\n둘째");
  });
  it("only selects active work for the current conversation", () => {
    const other = { ...run, meeting: { ...run.meeting!, threadId: ThreadId.make("other") } };
    const finished = { ...run, status: "completed" as const };
    expect(activeThreadOrchestra([other, finished], threadId)).toBeUndefined();
    expect(activeThreadOrchestra([other, finished, run], threadId)).toBe(run);
  });

  it("sends normal text as a supervisor instruction but holds unsupported attachments", () => {
    expect(
      prepareThreadOrchestraMessage(run, { text: "  추가 지시  ", attachmentCount: 0 }),
    ).toEqual({
      kind: "interject",
      text: "추가 지시",
    });
    expect(prepareThreadOrchestraMessage(run, { text: "내용", attachmentCount: 1 }).kind).toBe(
      "hold",
    );
    expect(
      prepareThreadOrchestraMessage(run, { text: "가".repeat(8_001), attachmentCount: 0 }).kind,
    ).toBe("hold");
  });

  it("answers the exact pending question, including an image-only answer", () => {
    const question = {
      question: "어느 쪽인가요?",
      nodeId: null,
      askedAt: "2026-11-02T00:00:00Z",
      options: ["첫째", "둘째"],
      context: "",
      askedByParticipantId: null,
    };
    const asking = { ...run, meeting: { ...run.meeting!, pendingQuestion: question } };
    expect(prepareThreadOrchestraMessage(asking, { text: " 둘째 ", attachmentCount: 0 })).toEqual({
      kind: "answer",
      text: "둘째",
      question: question.question,
      questionRef: { nodeId: null, askedAt: question.askedAt },
    });
    expect(prepareThreadOrchestraMessage(asking, { text: "", attachmentCount: 1 })).toMatchObject({
      kind: "answer",
      text: "첨부한 이미지를 참고하세요.",
    });
  });

  it("keeps a draft while cancellation is pending", () => {
    expect(
      prepareThreadOrchestraMessage(
        { ...run, status: "cancel-requested" },
        { text: "다음 지시", attachmentCount: 0 },
      ).kind,
    ).toBe("hold");
  });

  it("treats an explicit stop as cancellation without discarding attachments", () => {
    expect(prepareThreadOrchestraMessage(run, { text: "중지해줘!", attachmentCount: 0 })).toEqual({
      kind: "stop",
    });
    expect(prepareThreadOrchestraMessage(run, { text: "중지해줘!", attachmentCount: 1 }).kind).toBe(
      "hold",
    );
  });
});
