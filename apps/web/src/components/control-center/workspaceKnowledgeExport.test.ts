import { WorkspaceKnowledgeItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  renderWorkspaceKnowledgePrintView,
  serializeWorkspaceKnowledgeExport,
  serializeWorkspaceKnowledgeMarkdown,
} from "./workspaceKnowledgeExport";

describe("workspace knowledge export", () => {
  it("preserves every record, full Korean text and metadata in valid JSON", () => {
    const decode = Schema.decodeUnknownSync(WorkspaceKnowledgeItem);
    const items = Array.from({ length: 45 }, (_, index) =>
      decode({
        id: `item-${index}`,
        projectId: "project-a",
        kind: "rag-source",
        title: `제목 ${index}`,
        content: `한글 원문 ${index}\n두 번째 줄`,
        status: index === 44 ? "archived" : "active",
        origin: "user",
        relativeFolder: null,
        scope: "folder",
        appliesToFolder: "문서",
        tags: ["출처"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    const output = JSON.parse(
      serializeWorkspaceKnowledgeExport({
        projectId: "project-a",
        projectTitle: "프로젝트",
        exportedAt: "2026-11-06T00:00:00.000Z",
        items,
        archiveSnapshot: {
          memories: [{ id: "기억", text: "결정" }],
          sourceArchives: [],
          importedSources: [],
          threads: [{ thread_id: "t" }],
          messages: [{ text: "대화 원문" }],
          activities: [],
          plans: [],
          turns: [],
        },
      }),
    );
    expect(output.count).toBe(45);
    expect(output.version).toBe(2);
    expect(output.exportScope).toBe("all");
    expect(output.archiveSnapshot.memories[0].text).toBe("결정");
    expect(output.archiveSnapshot.messages[0].text).toBe("대화 원문");
    expect(output.items).toEqual(items);
    expect(output.items[44]).toMatchObject({
      status: "archived",
      content: "한글 원문 44\n두 번째 줄",
      appliesToFolder: "문서",
    });
    expect(output.separatedCorpora).toBeDefined();
  });

  it("separates user utterances & speech style from AI outputs across JSON and Markdown scopes", () => {
    const decode = Schema.decodeUnknownSync(WorkspaceKnowledgeItem);
    const userItem = decode({
      id: "item-user",
      projectId: "project-a",
      kind: "directive",
      title: "사용자 직접 지침",
      content: "항상 최신 결과를 먼저 보여줘",
      status: "active",
      origin: "user",
      relativeFolder: null,
      scope: "project",
      appliesToFolder: null,
      tags: [],
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    });
    const aiItem = decode({
      id: "item-ai",
      projectId: "project-a",
      kind: "run-memory",
      title: "6인 위원회 분석 보고서",
      content: "언락 숏 C1 진단 결과입니다.",
      status: "active",
      origin: "agent",
      relativeFolder: null,
      scope: "project",
      appliesToFolder: null,
      tags: [],
      createdAt: "2026-11-24T01:00:00.000Z",
      updatedAt: "2026-11-24T01:00:00.000Z",
    });
    const baseInput = {
      projectId: "project-a",
      projectTitle: "분리 테스트",
      exportedAt: "2026-11-24T09:30:00.000Z",
      items: [userItem, aiItem],
      archiveSnapshot: {
        memories: [
          { id: "m-user", origin: "user", text: "내 말투 기억" },
          { id: "m-ai", origin: "assistant", text: "AI 조사 요약" },
        ],
        sourceArchives: [],
        importedSources: [],
        threads: [{ thread_id: "t-1", title: "언락 전략 회의" }],
        messages: [
          {
            message_id: "msg-u1",
            thread_id: "t-1",
            role: "user",
            text: "진단: 매우 긴 AI 보고서 본문\n1. 항목 A\n2. 항목 B\n3. 항목 C\n4. 항목 D -> 이런 에러 뜬다.. 뭐야 이겡 (내 말투도 따로 저장했으면 해서)",
            created_at: "2026-11-24T09:00:00.000Z",
          },
          {
            message_id: "msg-a1",
            thread_id: "t-1",
            role: "assistant",
            text: "원인을 확인하여 수정했습니다.",
            created_at: "2026-11-24T09:05:00.000Z",
          },
        ],
        activities: [{ id: "act-1" }],
        plans: [{ id: "plan-1", plan_markdown: "계획 본문" }],
        turns: [{ turn_id: "turn-1" }],
      },
    };

    const userOnlyJson = JSON.parse(
      serializeWorkspaceKnowledgeExport({ ...baseInput, scope: "user_only" }),
    );
    expect(userOnlyJson.exportScope).toBe("user_only");
    expect(userOnlyJson.items).toHaveLength(1);
    expect(userOnlyJson.items[0].id).toBe("item-user");
    expect(userOnlyJson.archiveSnapshot.messages).toHaveLength(1);
    expect(userOnlyJson.archiveSnapshot.messages[0].message_id).toBe("msg-u1");
    expect(userOnlyJson.separatedCorpora.aiResearchAndOutputs).toBeNull();
    expect(
      userOnlyJson.separatedCorpora.userDialogueAndStyle.speechProfile.analyzedVoiceSegmentCount,
    ).toBeGreaterThan(0);

    const aiOnlyJson = JSON.parse(
      serializeWorkspaceKnowledgeExport({ ...baseInput, scope: "ai_only" }),
    );
    expect(aiOnlyJson.exportScope).toBe("ai_only");
    expect(aiOnlyJson.items).toHaveLength(1);
    expect(aiOnlyJson.items[0].id).toBe("item-ai");
    expect(aiOnlyJson.archiveSnapshot.messages).toHaveLength(1);
    expect(aiOnlyJson.archiveSnapshot.messages[0].message_id).toBe("msg-a1");
    expect(aiOnlyJson.separatedCorpora.userDialogueAndStyle).toBeNull();

    const userMarkdown = serializeWorkspaceKnowledgeMarkdown({
      ...baseInput,
      scope: "user_only",
    });
    expect(userMarkdown).toContain("사용자 발화·말투 프로파일");
    expect(userMarkdown).toContain("뭐야 이겡");
    expect(userMarkdown).not.toContain("원인을 확인하여 수정했습니다.");

    const aiMarkdown = serializeWorkspaceKnowledgeMarkdown({
      ...baseInput,
      scope: "ai_only",
    });
    expect(aiMarkdown).toContain("원인을 확인하여 수정했습니다.");
    expect(aiMarkdown).toContain("언락 숏 C1 진단 결과입니다.");
    expect(aiMarkdown).not.toContain("뭐야 이겡");
  });

  it("escapes untrusted content in the printable view and preserves all sections", () => {
    const html = renderWorkspaceKnowledgePrintView({
      projectId: "p",
      projectTitle: "한글 프로젝트",
      exportedAt: "2026-11-06T00:00:00.000Z",
      items: [],
      archiveSnapshot: {
        memories: [{ text: "<script>alert(1)</script>" }],
        sourceArchives: [],
        importedSources: [],
        threads: [],
        messages: [{ text: "대화 원문" }],
        activities: [],
        plans: [],
        turns: [],
      },
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("대화 원문");
    expect(html).toContain("한글 프로젝트");
  });
});
