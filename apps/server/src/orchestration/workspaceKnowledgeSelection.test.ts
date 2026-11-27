import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeItem,
  type WorkspaceRagMatch,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { composeWorkspacePrompt } from "./workspacePrompt.ts";
import {
  allocateDynamicWorkspaceBudget,
  compactConversationHistoryWithMasking,
} from "./workspacePromptRelevant.ts";
import {
  assessWorkspaceContextSufficiency,
  computeEntityAnchorPprBoost,
  selectWorkspaceKnowledge,
} from "./workspaceKnowledgeSelection.ts";

const projectId = ProjectId.make("lookup");
const timestamp = "2026-10-23T10:00:00.000Z";

function match(id: string, content: string, semanticSimilarity: number): WorkspaceRagMatch {
  return {
    projectId,
    itemId: WorkspaceKnowledgeItemId.make(id),
    kind: "rag-source",
    title: "Records",
    snippet: content,
    content,
    score: 1,
    semanticSimilarity,
    updatedAt: timestamp,
  };
}

it("injects a paraphrase with no common keywords at 0.56 and omits it just below", () => {
  for (const [similarity, include] of [
    [0.5599, false],
    [0.56, true],
  ] as const) {
    const evidence = match("policy", "Passengers may withdraw before departure.", similarity);
    const result = composeWorkspacePrompt({
      request: { projectId, contextMode: "relevant", task: "When can I call off my trip?" },
      items: [],
      ragMatches: [evidence],
      now: Date.parse(timestamp),
    });
    expect.soft(result.sourceItemIds, String(similarity)).toEqual(include ? [evidence.itemId] : []);
    expect.soft(result.prompt.includes(evidence.snippet), String(similarity)).toBe(include);
  }
});

it("keeps exact identifiers and applicable user directives while omitting weak semantic noise", () => {
  const directive: WorkspaceKnowledgeItem = {
    projectId,
    id: WorkspaceKnowledgeItemId.make("local-rule"),
    kind: "directive",
    scope: "project",
    origin: "user",
    title: "Receipt handling",
    content: "Keep the original receipts.",
    status: "active",
    relativeFolder: null,
    tags: [],
    originalChars: null,
    storedChars: null,
    promptUses: 0,
    lastUsedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const foreign = {
    ...directive,
    projectId: ProjectId.make("private"),
    id: WorkspaceKnowledgeItemId.make("private-rule"),
    content: "Attach the private ledger.",
  };
  const exact = match("receipt", "Archive entry qzxvjkwpfbmq.", 0);
  const unrelated = match("unrelated", "Orders ship every Friday.", 0.552);

  const result = composeWorkspacePrompt({
    request: { projectId, contextMode: "relevant", task: "qzxvjkwpfbmq" },
    items: [directive, foreign],
    ragMatches: [unrelated, exact],
    now: Date.parse(timestamp),
  });
  expect(result.sourceItemIds.toSorted()).toEqual([directive.id, exact.itemId].toSorted());
  expect(result.prompt).toContain(directive.content);
  expect(result.prompt).toContain(exact.snippet);
  expect(result.prompt).not.toContain(unrelated.snippet);
  expect(result.prompt).not.toContain(foreign.content);
});

const eligibility = "# Eligibility\nUnused fares are reimbursable before departure.";
const accounting = "# Accounting\nRefundLedger records the original charge.";
const refundPolicy = {
  projectId,
  id: WorkspaceKnowledgeItemId.make("refund-policy"),
  kind: "long-term-memory",
  origin: "user",
  title: "Travel policy",
  content: [
    eligibility,
    accounting,
    // A full-length document is needed for the indexer to split Markdown sections.
    "# Appendix\n" + "Retain the signed paper copy. ".repeat(50),
  ].join("\n\n"),
  status: "active",
  relativeFolder: null,
  tags: [],
  originalChars: null,
  storedChars: null,
  promptUses: 0,
  lastUsedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
} satisfies WorkspaceKnowledgeItem;
const semanticChunk = {
  ...match(refundPolicy.id, eligibility, 0.56),
  kind: refundPolicy.kind,
  title: refundPolicy.title,
  chunkId: "0",
} satisfies WorkspaceRagMatch;
const exactChunk = {
  ...match(refundPolicy.id, accounting, 0.52),
  kind: refundPolicy.kind,
  title: refundPolicy.title,
  chunkId: "1",
} satisfies WorkspaceRagMatch;

it.each([
  {
    behavior: "injects the exact and semantic chunks of one long-term memory once each",
    cap: 2,
    retrieved: [semanticChunk, exactChunk],
    expected: [semanticChunk, exactChunk],
  },
  {
    behavior: "keeps the exact long-term memory chunk when only one chunk fits",
    cap: 1,
    retrieved: [semanticChunk, exactChunk],
    expected: [exactChunk],
  },
  {
    behavior: "recovers an exact in-memory sibling missing from the search results",
    cap: 2,
    retrieved: [semanticChunk],
    expected: [semanticChunk, exactChunk],
  },
])("$behavior", ({ cap, retrieved, expected }) => {
  const result = composeWorkspacePrompt({
    request: { projectId, contextMode: "relevant", task: "RefundLedger", maxChunksPerItem: cap },
    items: [refundPolicy],
    ragMatches: retrieved,
    now: Date.parse(timestamp),
  });
  const selected = result.diagnostics?.decisions.filter((decision) => decision.selected);
  expect(selected?.map((decision) => decision.chunkId).toSorted()).toEqual(
    expected.map((chunk) => chunk.chunkId).toSorted(),
  );
  const passages = result.sourcePassages?.map(({ start, end }) => result.prompt.slice(start, end));
  expect(passages?.toSorted()).toEqual(expected.map((chunk) => chunk.snippet).toSorted());
});

function expectRefundPassages(
  item: WorkspaceKnowledgeItem,
  ragMatches: readonly WorkspaceRagMatch[],
  expectedBodies: readonly string[],
) {
  const result = composeWorkspacePrompt({
    request: { projectId, contextMode: "relevant", task: "RefundLedger", maxChunksPerItem: 2 },
    items: [item],
    ragMatches,
    now: Date.parse(timestamp),
  });
  const passages = result.sourcePassages?.map(({ start, end }) => result.prompt.slice(start, end));
  expect(passages?.toSorted()).toEqual(expectedBodies.toSorted());
  expect(result.diagnostics?.decisions.filter((decision) => decision.selected)).toHaveLength(
    expectedBodies.length,
  );
}

it("uses one slot for identical local sections and the other for their retrieved semantic sibling", () => {
  const repeated = {
    ...refundPolicy,
    content: refundPolicy.content.replace(accounting, [accounting, accounting].join("\n\n")),
  };
  expectRefundPassages(repeated, [semanticChunk], [accounting, eligibility]);
});

it.each([
  {
    label: "numeric chunk ID",
    hit: { chunkId: semanticChunk.chunkId, snippet: "Unused fares are reimbursable…" },
    source: semanticChunk,
    expected: [eligibility, accounting],
  },
  {
    label: "highlighted snippet without a chunk ID",
    hit: { snippet: "# Accounting [RefundLedger] records the original charge." },
    source: exactChunk,
    expected: [accounting],
  },
  {
    label: "ellipsized snippet without a chunk ID",
    hit: { snippet: "# Eligibility Unused fares are reimbursable…" },
    source: semanticChunk,
    expected: [eligibility, accounting],
  },
])("injects the full local passage once for a legacy $label", ({ hit, source, expected }) => {
  const { content: _content, chunkId: _chunkId, ...legacy } = source;
  const item = {
    ...refundPolicy,
    // Two sections start a sentence alike. The numeric ID distinguishes their excerpts.
    content: refundPolicy.content + "\nUnused fares are reimbursable upon approval.",
  };
  expectRefundPassages(item, [{ ...legacy, ...hit }], expected);
});

it("grades Korean clause and hyphenated code identifiers and outputs Google Sufficient Context findings/gaps", () => {
  const clauseMatch = match(
    "travel-clause-3",
    "# 2026년 국내 출장 규정\n## 제3조 숙박비 한도\n본 한도는 직전 분기 대비 10% 이내로 조정한다. 에러 코드 TS-999 및 A-2201 참조.",
    0,
  );
  const noiseMatch = match(
    "travel-noise",
    "출장 신청서는 출발 3일 전까지 부서장 결재를 받아야 한다.",
    0,
  );
  const selected = selectWorkspaceKnowledge({
    request: {
      projectId,
      contextMode: "relevant",
      task: "2026년 국내 출장 시 제3조 숙박비 한도 조정과 TS-999 기준은?",
    },
    items: [],
    ragMatches: [noiseMatch, clauseMatch],
    now: Date.parse(timestamp),
  });
  expect(
    selected.candidates.map((c) => ("itemId" in c.source ? c.source.itemId : c.source.id)),
  ).toEqual([clauseMatch.itemId]);
  expect(selected.sufficiency.status).toBe("sufficient");
  expect(selected.sufficiency.action).toBe("generate_answer");
  expect(selected.sufficiency.findings).toEqual(expect.arrayContaining(["제3조", "ts-999"]));

  const insufficient = assessWorkspaceContextSufficiency({
    task: "제3조 숙박비 한도와 그리고 제9조 해외 파견 수당 기준을 알려줘",
    candidates: selected.candidates,
  });
  expect(insufficient.gaps.length).toBeGreaterThan(0);
});

it("allocates dynamic token budgets across 4 query complexity profiles and masks stale tool observations while preserving verbatim diagnostics", () => {
  const trivial = allocateDynamicWorkspaceBudget("고마워 진행해");
  expect(trivial.profile).toBe("trivial");
  expect(trivial.warmMemoryMaxChars).toBe(0);
  expect(trivial.totalMaxChars).toBe(12_000);

  const focused = allocateDynamicWorkspaceBudget("WorkspaceMemory.ts 파일의 manifest 함수 확인");
  expect(focused.profile).toBe("focused-lookup");
  expect(focused.semanticRagMaxChars).toBe(18_000);

  const deep = allocateDynamicWorkspaceBudget(
    "T3 메모리 계층화 아키텍처와 마이그레이션 전체 비교 분석",
  );
  expect(deep.profile).toBe("deep-architectural");
  expect(deep.totalMaxChars).toBe(60_000);
  expect(deep.unmaskedRecentToolCalls).toBe(5);

  const turns = [
    {
      id: "t-1",
      role: "tool" as const,
      toolName: "read_file",
      toolArgsSummary: "src/old.ts",
      content:
        "normal line\n".repeat(40) +
        "Error: ECONNREFUSED 127.0.0.1:5432\n    at connect (src/db.ts:42:11)",
      createdAt: 1000,
    },
    {
      id: "t-2",
      role: "tool" as const,
      toolName: "read_file",
      toolArgsSummary: "src/recent.ts",
      content: "recent output ".repeat(40),
      createdAt: 2000,
    },
  ];
  const compacted = compactConversationHistoryWithMasking(turns, 1);
  expect(compacted[1]?.content).toBe(turns[1]?.content);
  expect(compacted[0]?.content).toContain("[masked tool output from read_file(src/old.ts)");
  expect(compacted[0]?.content).toContain("Error: ECONNREFUSED 127.0.0.1:5432");
  expect(compacted[0]?.content).toContain("at connect (src/db.ts:42:11)");
});

it("propagates 1-hop entity-anchor PPR boost across linked candidates", () => {
  const seedHit = match(
    "seed-doc",
    "에러 코드 TS-999는 AuthGateway.validateSession에서 발생하며 해결은 TokenCacheConfig를 따른다.",
    0.72,
  );
  const hopHit = match("hop-doc", "TokenCacheConfig 설정은 만료 시간을 300초로 유지한다.", 0.58);
  const selected = selectWorkspaceKnowledge({
    request: {
      projectId,
      contextMode: "relevant",
      task: "TS-999 에러 해결 방법",
    },
    items: [],
    ragMatches: [seedHit, hopHit],
    now: Date.parse(timestamp),
  });
  const boosts = computeEntityAnchorPprBoost("TS-999 에러 해결 방법", selected.candidates);
  expect(boosts.size).toBeGreaterThanOrEqual(2);
});
