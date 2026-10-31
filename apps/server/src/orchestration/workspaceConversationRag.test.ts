import {
  DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  compactConversationRagInput,
  conversationRagThreadItemPrefix,
  toConversationRagKnowledgeItem,
} from "./workspaceConversationRag.ts";

const settings = DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS;

describe("workspace conversation RAG compaction", () => {
  it("normalizes repeated blocks and masks common credentials", () => {
    const result = compactConversationRagInput(
      [
        "배포 규칙은 검증 후 적용한다.",
        "",
        "배포 규칙은 검증 후 적용한다.",
        "",
        "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz",
      ].join("\n"),
      settings,
    );

    expect(result).not.toBeNull();
    expect(result?.duplicateBlocksRemoved).toBe(1);
    expect(result?.redactionCount).toBeGreaterThan(0);
    expect(result?.content).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result?.content.match(/배포 규칙/g)).toHaveLength(1);
  });

  it("bounds oversized inputs while preserving both ends", () => {
    const result = compactConversationRagInput(`시작-${"가".repeat(2_500)}-끝`, {
      ...settings,
      maxInputChars: 2_000,
    });

    expect(result?.truncated).toBe(true);
    expect(result?.content.length).toBeLessThanOrEqual(2_000);
    expect(result?.content.startsWith("시작-")).toBe(true);
    expect(result?.content.endsWith("-끝")).toBe(true);
  });

  it("deduplicates identical input within a thread and isolates other threads", () => {
    const base = {
      projectId: ProjectId.make("project-a"),
      threadId: ThreadId.make("thread-a"),
      threadTitle: "프로젝트 대화",
      text: "반복 가능한 설계 결정",
      attachments: [],
      createdAt: "2026-08-10T00:00:00.000Z",
      settings,
    } as const;
    const first = toConversationRagKnowledgeItem({
      ...base,
      sourceId: MessageId.make("message-a"),
    });
    const duplicate = toConversationRagKnowledgeItem({
      ...base,
      sourceId: MessageId.make("message-b"),
    });
    const otherThread = toConversationRagKnowledgeItem({
      ...base,
      threadId: ThreadId.make("thread-b"),
      sourceId: MessageId.make("message-c"),
    });

    expect(first?.id).toBe(duplicate?.id);
    expect(first?.id).not.toBe(otherThread?.id);
    expect(first?.id.startsWith(conversationRagThreadItemPrefix(base.threadId))).toBe(true);
    expect(first?.tags).toContain("auto-conversation");
  });

  it("keeps captured conversation memory scoped to its worktree folder when provided", () => {
    const item = toConversationRagKnowledgeItem({
      projectId: ProjectId.make("project-a"),
      threadId: ThreadId.make("thread-folder"),
      threadTitle: "폴더 대화",
      sourceId: MessageId.make("message-folder"),
      text: "폴더별 작업 기억",
      attachments: [],
      createdAt: "2026-08-10T00:00:00.000Z",
      settings,
      relativeFolder: "apps/web",
    });
    expect(item?.relativeFolder).toBe("apps/web");
  });

  it("indexes attachment metadata and honors the project capture switch", () => {
    const input = {
      projectId: ProjectId.make("project-a"),
      threadId: ThreadId.make("thread-a"),
      threadTitle: "이미지 검토",
      sourceId: MessageId.make("message-image"),
      text: "",
      attachments: [
        {
          type: "image" as const,
          id: "image-1",
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
      ],
      createdAt: "2026-08-10T00:00:00.000Z",
      settings,
    } as const;

    expect(toConversationRagKnowledgeItem(input)?.content).toContain("diagram.png");
    expect(
      toConversationRagKnowledgeItem({
        ...input,
        settings: { ...settings, enabled: false },
      }),
    ).toBeNull();
  });
});
