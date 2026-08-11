import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeItem,
  type WorkspaceRagMatch,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { composeWorkspacePrompt } from "./workspacePrompt.ts";

const projectId = ProjectId.make("workspace-a");

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
