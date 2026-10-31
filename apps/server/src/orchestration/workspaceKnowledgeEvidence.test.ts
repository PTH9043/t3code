import { expect, it } from "vite-plus/test";
import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeItem,
  type WorkspaceRagMatch,
} from "@t3tools/contracts";
import { composeWorkspacePrompt } from "./workspacePrompt.ts";

const projectId = ProjectId.make("evidence-project");
const now = "2026-10-23T10:00:00.000Z";
const item = (extra: Partial<WorkspaceKnowledgeItem> = {}): WorkspaceKnowledgeItem => ({
  projectId,
  id: WorkspaceKnowledgeItemId.make("source"),
  kind: "rag-source",
  origin: "user",
  title: "실행 멱등성",
  content: "고유 commandId로 동일 요청의 중복 수락을 막는다.",
  status: "active",
  scope: "project",
  relativeFolder: null,
  tags: [],
  originalChars: null,
  storedChars: null,
  promptUses: 0,
  lastUsedAt: null,
  createdAt: now,
  updatedAt: now,
  ...extra,
});
const match = (source: WorkspaceKnowledgeItem, similarity?: number): WorkspaceRagMatch => ({
  projectId: source.projectId,
  itemId: source.id,
  kind: "rag-source",
  title: source.title,
  content: source.content,
  snippet: source.content,
  score: 9999,
  updatedAt: now,
  ...(similarity === undefined ? {} : { semanticSimilarity: similarity }),
});
const compose = (source: WorkspaceKnowledgeItem, similarity?: number) =>
  composeWorkspacePrompt({
    now: Date.parse(now),
    request: {
      projectId,
      contextMode: "relevant",
      task: "똑같은 명령이 두 번 돌아가지 않게 하려면?",
    },
    items: [source],
    ragMatches: [match(source, similarity)],
  });

it("keeps a high-confidence semantic paraphrase through final context composition without confusing BM25 with similarity", () => {
  const source = item();
  expect(compose(source).sourceItemIds).toEqual([]);
  expect(compose(source, 0.47).sourceItemIds).toEqual([]);
  expect(compose(source, 0.88).sourceItemIds).toEqual([source.id]);
});
it("never admits inactive or foreign evidence through a semantic score", () => {
  expect(compose(item({ status: "archived" }), 0.99).sourceItemIds).toEqual([]);
  expect(compose(item({ projectId: ProjectId.make("foreign") }), 0.99).sourceItemIds).toEqual([]);
  expect(
    compose(item({ scope: "folder", appliesToFolder: "private" }), 0.99).sourceItemIds,
  ).toEqual([]);
});
it("injects the semantic hit's actual long-memory chunk instead of an unrelated first page", () => {
  const source = item({ kind: "long-term-memory", content: "관계없는 식당 회의록.\n".repeat(500) });
  const evidence = "고유 commandId로 동일 요청의 중복 수락을 막는다.";
  const result = composeWorkspacePrompt({
    now: Date.parse(now),
    request: {
      projectId,
      contextMode: "relevant",
      task: "똑같은 명령이 두 번 돌아가지 않게 하려면?",
    },
    items: [source],
    ragMatches: [
      {
        ...match(source, 0.88),
        kind: "long-term-memory",
        content: evidence,
        snippet: evidence,
        chunkId: "7",
      },
    ],
  });
  expect(result.prompt).toContain(evidence);
  expect(result.prompt).toContain("청크 7");
  expect(result.prompt).not.toContain("식당 회의록");
});
it("retains original URLs, observation time and revision evidence and distinguishes plans from completed facts", () => {
  const source = item({
    research: {
      query: "duplicate commands",
      sources: ["https://example.test/original"],
      capturedAt: "2026-10-20T01:00:00.000Z",
      verification: "verified",
      lineage: {
        canonicalId: "execution",
        revision: 2,
        evidenceRefs: ["repo://source/command.ts#v2", "https://example.test/original"],
      },
    },
  });
  const result = compose(source, 0.88);
  expect(result.prompt).toContain("https://example.test/original");
  expect(result.prompt.match(/https:\/\/example.test\/original/gu)).toHaveLength(1);
  expect(result.prompt).toContain("기록 기준=2026-10-20T01:00:00.000Z");
  expect(result.prompt).toContain("repo://source/command.ts#v2");
  expect(result.prompt).toContain("예정·계획을 완료 사실로 바꾸지");
});
it("does not resurrect a superseded correction or a future effective record through semantic retrieval", () => {
  const old = item();
  const corrected = item({
    id: WorkspaceKnowledgeItemId.make("new"),
    research: {
      query: "execution",
      sources: [],
      capturedAt: now,
      verification: "verified",
      lineage: { canonicalId: "execution", revision: 2, supersedes: [old.id] },
    },
  });
  const result = composeWorkspacePrompt({
    now: Date.parse(now),
    request: {
      projectId,
      task: "똑같은 명령이 두 번 돌아가지 않게 하려면?",
      contextMode: "relevant",
    },
    items: [old, corrected],
    ragMatches: [match(old, 0.99), match(corrected, 0.9)],
  });
  expect(result.sourceItemIds).toEqual([corrected.id]);
  const future = item({
    research: {
      query: "execution",
      sources: [],
      capturedAt: now,
      verification: "verified",
      lineage: { canonicalId: "execution", revision: 2, validFrom: "2026-11-01T00:00:00.000Z" },
    },
  });
  expect(compose(future, 0.99).sourceItemIds).toEqual([]);
});
