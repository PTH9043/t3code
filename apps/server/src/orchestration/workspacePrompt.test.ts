import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  type SharedLibraryMatch,
  type WorkspaceKnowledgeItem,
  type WorkspaceRagMatch,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { composeWorkspacePrompt } from "./workspacePrompt.ts";

const projectId = ProjectId.make("workspace-a");

it("composes applicable shared and folder memory without collapsing source identities", () => {
  const shared = {
    ...item({
      id: "same",
      kind: "long-term-memory",
      content: "Shared evidence",
      workspace: "workspace-b",
    }),
    scope: "environment" as const,
  };
  const local = {
    ...item({ id: "same", kind: "long-term-memory", content: "Web evidence" }),
    scope: "folder" as const,
    appliesToFolder: "apps/web",
  };
  const result = composeWorkspacePrompt({
    request: { projectId, task: "Review", contextPaths: ["apps/web/src"] },
    items: [shared, local],
    ragMatches: [],
  });
  expect(result.prompt).toContain("Shared evidence");
  expect(result.prompt).toContain("Web evidence");
  expect(result.sourceReferences).toHaveLength(2);
  const sibling = composeWorkspacePrompt({
    request: { projectId, task: "Review", contextPaths: ["apps/web-extra"], includeShared: false },
    items: [shared, local],
    ragMatches: [],
  });
  expect(sibling.sourceReferences).toEqual([]);
});

function item(input: {
  readonly id: string;
  readonly kind: WorkspaceKnowledgeItem["kind"];
  readonly content: string;
  readonly origin?: WorkspaceKnowledgeItem["origin"];
  readonly status?: WorkspaceKnowledgeItem["status"];
  readonly workspace?: string;
}): WorkspaceKnowledgeItem {
  return {
    id: WorkspaceKnowledgeItemId.make(input.id),
    projectId: ProjectId.make(input.workspace ?? "workspace-a"),
    kind: input.kind,
    title: input.id,
    content: input.content,
    status: input.status ?? "active",
    origin: input.origin ?? "agent",
    relativeFolder: null,
    tags: [],
    originalChars: null,
    storedChars: null,
    promptUses: 0,
    lastUsedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T01:00:00.000Z",
  };
}

it("puts the current user task first and filters foreign or archived memory", () => {
  const result = composeWorkspacePrompt({
    request: { projectId, task: "Ship the current user request." },
    items: [
      item({ id: "agent-rule", kind: "directive", content: "Agent suggestion" }),
      item({
        id: "user-rule",
        kind: "directive",
        content: "User-owned rule",
        origin: "user",
      }),
      item({ id: "goal", kind: "goal", content: "Workspace goal", origin: "user" }),
      item({ id: "archived", kind: "long-term-memory", content: "Old", status: "archived" }),
      item({
        id: "foreign",
        kind: "long-term-memory",
        content: "Must never leak",
        workspace: "workspace-b",
      }),
    ],
    ragMatches: [
      {
        projectId: ProjectId.make("workspace-b"),
        itemId: WorkspaceKnowledgeItemId.make("foreign-rag"),
        kind: "rag-source",
        title: "Foreign",
        snippet: "Foreign RAG must never leak",
        score: 1,
        updatedAt: "2026-08-08T01:00:00.000Z",
      },
    ],
  });

  expect(result.prompt.indexOf("Ship the current user request.")).toBeLessThan(
    result.prompt.indexOf("User-owned rule"),
  );
  expect(result.prompt.indexOf("User-owned rule")).toBeLessThan(
    result.prompt.indexOf("Agent suggestion"),
  );
  expect(result.prompt).not.toContain("Must never leak");
  expect(result.prompt).not.toContain("Foreign RAG");
  expect(result.prompt).not.toContain("Old");
  expect(result.sourceItemIds).toEqual([
    WorkspaceKnowledgeItemId.make("user-rule"),
    WorkspaceKnowledgeItemId.make("agent-rule"),
    WorkspaceKnowledgeItemId.make("goal"),
  ]);
  expect(result.ragMatches).toEqual([]);
});

it("deduplicates retrieved memory and honors memory inclusion flags", () => {
  const longTerm = item({
    id: "memory",
    kind: "long-term-memory",
    content: "Durable Workspace fact",
    origin: "user",
  });
  const ragMatch: WorkspaceRagMatch = {
    projectId,
    itemId: longTerm.id,
    kind: "long-term-memory",
    title: longTerm.title,
    snippet: "Duplicate durable fact",
    score: 1,
    updatedAt: longTerm.updatedAt,
  };
  const included = composeWorkspacePrompt({
    request: { projectId, task: "Use memory" },
    items: [longTerm],
    ragMatches: [ragMatch],
  });
  expect(included.prompt).toContain("Durable Workspace fact");
  expect(included.prompt).not.toContain("Duplicate durable fact");
  expect(included.sourceItemIds).toEqual([longTerm.id]);

  const excluded = composeWorkspacePrompt({
    request: {
      projectId,
      task: "Do not use memory",
      includeLongTermMemory: false,
      includeRag: false,
    },
    items: [longTerm],
    ragMatches: [ragMatch],
  });
  expect(excluded.prompt).not.toContain("Durable Workspace fact");
  expect(excluded.sourceItemIds).toEqual([]);
});

const designReference = (itemId: string, content: string): SharedLibraryMatch => ({
  libraryId: "design-references",
  itemId,
  title: `채용 관리 대시보드 ${itemId}`,
  snippet: "",
  content,
  sourceUrl: `https://ref.theseeker.io/r/${itemId}`,
  author: "@vektorastudio",
  category: "dashboard",
  tags: ["dashboard"],
  score: 3,
});

it("injects the matched chunk, then the shared library after the project's own context", () => {
  const rag: WorkspaceRagMatch = {
    projectId,
    itemId: WorkspaceKnowledgeItemId.make("guide"),
    kind: "rag-source",
    title: "화면 가이드",
    snippet: "…[대시]보드…",
    content: "대시보드는 4열 카드 그리드로 배치한다.",
    score: 2,
    updatedAt: "2026-08-08T01:00:00.000Z",
  };
  const library = designReference(
    "5494",
    "밝은 배경에 파란 강조색.\n레퍼런스: https://ref.theseeker.io/r/5494",
  );
  const result = composeWorkspacePrompt({
    request: { projectId, task: "대시보드 개선" },
    items: [],
    ragMatches: [rag],
    libraryMatches: [library],
  });
  expect(result.prompt).toContain("대시보드는 4열 카드 그리드로 배치한다.");
  expect(result.prompt).not.toContain("…[대시]보드…");
  expect(result.prompt).toContain("## 공용 디자인 라이브러리");
  expect(result.prompt).toContain("레퍼런스: https://ref.theseeker.io/r/5494");
  expect(result.prompt.indexOf("## 프로젝트 전용 문맥")).toBeLessThan(
    result.prompt.indexOf("## 공용 디자인 라이브러리"),
  );
  expect(result.libraryMatches?.map((match) => match.itemId)).toEqual(["5494"]);

  const withoutLibrary = composeWorkspacePrompt({
    request: { projectId, task: "대시보드 개선", includeSharedLibrary: false },
    items: [],
    ragMatches: [rag],
    libraryMatches: [library],
  });
  expect(withoutLibrary.prompt).not.toContain("공용 디자인 라이브러리");
  expect(withoutLibrary.libraryMatches).toEqual([]);
});

it("keeps the shared library within its share of the budget", () => {
  const result = composeWorkspacePrompt({
    request: { projectId, task: "대시보드", maxContextChars: 8_000 },
    items: [],
    ragMatches: [],
    libraryMatches: Array.from({ length: 4 }, (_, index) =>
      designReference(String(index), "x".repeat(1_500)),
    ),
  });
  // A quarter of 8,000 characters holds one 1,500-character reference.
  expect(result.libraryMatches).toHaveLength(1);
  expect(result.truncated).toBe(true);
});

it("preserves the user task while bounding optional context", () => {
  const result = composeWorkspacePrompt({
    request: {
      projectId,
      task: "This task must remain intact.",
      maxContextChars: 2_000,
    },
    items: [
      item({
        id: "large-rule",
        kind: "directive",
        content: "x".repeat(4_000),
        origin: "user",
      }),
    ],
    ragMatches: [],
  });
  expect(result.prompt).toContain("This task must remain intact.");
  expect(result.truncated).toBe(true);
  expect(result.sourceItemIds).toEqual([WorkspaceKnowledgeItemId.make("large-rule")]);
});
