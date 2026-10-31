import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  WorkspacePromptComposeResult,
  WorkspaceResearchRecord,
  type WorkspaceKnowledgeItem,
  type WorkspacePromptComposeInput,
  type WorkspaceRagMatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { composeWorkspacePrompt } from "./workspacePrompt.ts";
import { composeRelevantWorkspacePrompt } from "./workspacePromptRelevant.ts";

const projectId = ProjectId.make("autousage");
const decodeComposeResult = Schema.decodeUnknownSync(WorkspacePromptComposeResult);
const decodeResearch = Schema.decodeUnknownSync(WorkspaceResearchRecord);
const now = "2026-09-12T12:00:00.000Z";
const memory = (
  id: string,
  content: string,
  extra: Partial<WorkspaceKnowledgeItem> = {},
): WorkspaceKnowledgeItem => ({
  id: WorkspaceKnowledgeItemId.make(id),
  projectId,
  kind: "long-term-memory",
  title: id,
  content,
  origin: "agent",
  status: "active",
  relativeFolder: null,
  tags: [],
  createdAt: now,
  updatedAt: now,
  originalChars: null,
  storedChars: null,
  promptUses: 0,
  lastUsedAt: null,
  ...extra,
});
const research = (
  revision: number,
  extra: Partial<WorkspaceResearchRecord["lineage"]> = {},
): WorkspaceResearchRecord => ({
  query: "hub memory",
  sources: [],
  capturedAt: now,
  verification: "verified",
  lineage: { canonicalId: "hub-backend", revision, ...extra },
});
const compose = (
  items: WorkspaceKnowledgeItem[],
  request: Partial<WorkspacePromptComposeInput> = {},
  ragMatches: WorkspaceRagMatch[] = [],
) =>
  composeRelevantWorkspacePrompt({
    request: { projectId, task: "hub memory", contextMode: "relevant", ...request },
    items,
    ragMatches,
    now: Date.parse(now),
  });
const ids = (result: WorkspacePromptComposeResult) => result.sourceItemIds.map(String);
const rag = (item: WorkspaceKnowledgeItem): WorkspaceRagMatch => ({
  projectId: item.projectId,
  itemId: item.id,
  kind: "rag-source",
  title: item.title,
  content: item.content,
  snippet: item.content,
  score: 1,
  updatedAt: item.updatedAt,
});

it("does not anchor broad input, usage, or AI titles to unrelated task wording", () => {
  const notes = [
    memory("chat-log", "화면을 수정해. 입력과 코드 설명을 확인한다.", {
      title: "대화 입력 · AI 회의",
      tags: ["2026-09-12"],
    }),
    memory("counter", "토큰 입력과 출력의 누적 소비량을 계산한다.", {
      title: "실행별 토큰 사용량",
    }),
    memory("phone", "담당 AI와 모델의 상태를 메시지에 보존한다.", {
      title: "모바일 오케스트라 블록",
    }),
  ];
  expect(
    ids(compose(notes, { task: "AI로 식당 메뉴 이름을 만드는 화면의 문구를 수정해" })),
  ).toEqual([]);
  expect(ids(compose(notes, { task: "가스 사용량을 kWh로 변환하는 계산기" }))).toEqual([]);
  expect(ids(compose(notes, { task: "입력 100과 출력 20을 설명하는 문서를 작성해" }))).toEqual([]);
  expect(ids(compose(notes, { task: "휴대폰에서 담당 AI의 상태를 표시해" }))).toContain("phone");
});

it("requires a subject beyond generic user wording while keeping mandatory instructions", () => {
  const preferences = memory(
    "preferences",
    "사용자가 지휘 AI를 선택하고 오케스트라의 작업을 배정한다.",
    {
      title: "사용자 오케스트라 운영 원칙",
      tags: ["orchestra"],
    },
  );
  const required = memory("required", "필수 사용자 지침: 승인한 작업 범위를 유지한다.", {
    kind: "directive",
    origin: "user",
  });
  expect(
    ids(
      compose([preferences, required], {
        task: "사용자가 고른 언어에 맞춰 결제 완료 문구를 번역해",
      }),
    ),
  ).toEqual(["required"]);
  expect(
    ids(
      compose([preferences], {
        task: "사용자가 고른 지휘 AI로 오케스트라 작업을 배정해",
      }),
    ),
  ).toContain("preferences");
  expect(
    ids(
      compose(
        [
          memory("english", "The user selects the orchestra coordinator.", {
            title: "User orchestra preferences",
          }),
        ],
        { task: "Translate a checkout confirmation into the user selected language" },
      ),
    ),
  ).toEqual([]);
});

it("keeps unrelated hub detail at zero while preserving user instructions", () => {
  const result = compose(
    [
      memory("hub-native", "허브 메모리 풀 C++ 운영 구조"),
      memory("hub-benchmark", "공유 mmap 접근 지연 12ms"),
      memory("hub-json", "허브 JSON 초기 구현"),
      memory("required", "기존 사용자 데이터를 보존하세요.", { kind: "directive", origin: "user" }),
    ],
    { task: "웹 버튼 간격 수정" },
  );
  expect(ids(result)).toEqual(["required"]);
  expect(result.diagnostics?.decisions.filter((d) => d.reason === "low-relevance")).toHaveLength(3);
  expect(result.prompt).not.toContain("mmap");
  expect(result.diagnostics?.tokenCount).toBeNull();
  expect(decodeComposeResult(result)).toEqual(result);
});

it("never clips, merges, or displaces mandatory user constraints", () => {
  const instruction = "사용자 지침을 그대로 보존. ".repeat(400);
  const result = compose(
    [
      memory("constraint-a", instruction, { kind: "directive", origin: "user" }),
      memory("constraint-b", instruction, { kind: "prompt", origin: "user" }),
      memory("hub-memory", "hub memory optional evidence"),
    ],
    { maxContextChars: 2000, task: "현재 명령 원문 hub memory" },
  );
  expect(ids(result)).toEqual(["constraint-a", "constraint-b"]);
  expect(result.prompt.split(instruction)).toHaveLength(3);
  expect(result.prompt).toContain("현재 명령 원문");
  expect(result.diagnostics?.mandatoryOverflowChars).toBeGreaterThan(0);
  expect(result.diagnostics?.decisions.find((d) => d.itemId === "hub-memory")?.reason).toBe(
    "budget",
  );
});

it("selects intact optional units and still considers a smaller later item", () => {
  const long = "hub memory large evidence. ".repeat(100);
  const result = compose(
    [
      memory("a-large", long, { kind: "directive" }),
      memory("b-small", "hub memory small evidence"),
    ],
    { maxContextChars: 2000 },
  );
  expect(ids(result)).toEqual(["b-small"]);
  expect(result.prompt).not.toContain("large evidence");
  expect(result.truncated).toBe(true);
});

it("removes exact body duplicates only within the visible scope", () => {
  const body = "hub memory verified evidence";
  const result = compose([
    memory("foreign", body, { projectId: ProjectId.make("private-other") }),
    memory("a", body),
    memory("b", body.replaceAll(" ", " ") + "\r\n"),
    memory("different", body + " with unresolved findings"),
  ]);
  expect(ids(result)).toEqual(["a", "b", "different"]);
  expect(result.diagnostics?.decisions.find((d) => d.itemId === "b")?.injectedChars).toBe(0);
  expect(result.diagnostics?.decisions.some((d) => d.itemId === "foreign")).toBe(false);
  expect(result.diagnostics?.decisions.find((d) => d.itemId === "b")?.reason).toBe("duplicate");
});

it("filters private and sibling-folder records before returning diagnostic IDs or titles", () => {
  const privateItem = memory("SECRET_TITLE", "hub memory private", {
    projectId: ProjectId.make("other"),
  });
  const sibling = memory("SIBLING_TITLE", "hub memory sibling", {
    scope: "folder",
    appliesToFolder: "apps/web-extra",
  });
  const result = compose([privateItem, sibling], { contextPaths: ["apps/web/src"] }, [
    rag(privateItem),
    { ...rag(sibling), scope: "folder", appliesToFolder: "apps/web-extra" },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/SECRET_TITLE|SIBLING_TITLE/);
});

it("does not trust stale retrieval scope or resurrect an archived item", () => {
  const moved = memory("moved", "hub memory", { scope: "folder", appliesToFolder: "apps/server" });
  const archived = memory("archived", "hub memory", { status: "archived" });
  const result = compose([moved, archived], { contextPaths: ["apps/web"] }, [
    rag(moved),
    rag(archived),
  ]);
  expect(ids(result)).toEqual([]);
  expect(result.ragMatches).toEqual([]);
  expect(result.diagnostics?.decisions).toEqual([]);
});

it("shares only explicit environment records and keeps source project identities", () => {
  const result = compose(
    [
      memory("same", "hub memory local"),
      memory("same", "hub memory shared", {
        projectId: ProjectId.make("other"),
        scope: "environment",
      }),
    ],
    { includeShared: true },
  );
  expect(result.sourceReferences).toHaveLength(2);
  expect(ids(result)).toEqual(["same"]);
  const hidden = compose(
    [memory("shared", "hub memory", { projectId: ProjectId.make("other"), scope: "environment" })],
    { includeShared: false },
  );
  expect(hidden.sourceReferences).toEqual([]);
});

it("applies memory switches even to direct retrieved chunks", () => {
  const source = memory("long", "hub memory");
  for (const request of [{ includeLongTermMemory: false }, { includeRag: false }]) {
    const result = compose([], request, [{ ...rag(source), kind: "long-term-memory" }]);
    expect(ids(result)).toEqual([]);
    expect(result.diagnostics?.decisions[0]?.reason).toBe("disabled");
  }
});

it("selects the explicit current revision and restores both for historical comparison", () => {
  const items = [
    memory("old", "hub memory JSON deployment", { research: research(1) }),
    memory("current", "hub memory native deployment", {
      research: research(2, {
        supersedes: [WorkspaceKnowledgeItemId.make("old")],
        evidenceRefs: ["native-benchmark-01"],
      }),
    }),
  ];
  const current = compose(items);
  expect(ids(current)).toEqual(["current"]);
  expect(current.prompt).toContain("native-benchmark-01");
  expect(current.diagnostics?.decisions.find((d) => d.itemId === "old")?.temporalStatus).toBe(
    "history",
  );
  const history = compose(items, { task: "hub memory 과거 현재 비교" });
  expect(ids(history).sort()).toEqual(["current", "old"]);
  expect(history.prompt).toContain("과거 기록");
  expect(ids(compose(items, { task: "hub memory 과거 비교", includeHistory: false }))).toEqual([
    "current",
  ]);
});

it("never promotes an unverified rewrite or a timestamp into supersession", () => {
  const items = [
    memory("old", "hub memory verified fact", { research: research(1) }),
    memory("rewrite", "hub memory speculative fact", {
      research: {
        ...research(2, { supersedes: [WorkspaceKnowledgeItemId.make("old")] }),
        verification: "unverified",
      },
      updatedAt: "2026-09-13T00:00:00.000Z",
    }),
  ];
  expect(ids(compose(items)).sort()).toEqual(["old", "rewrite"]);
});

it("never lets agent records supersede user decisions", () => {
  const result = compose([
    memory("user", "hub memory user decision", { origin: "user", research: research(1) }),
    memory("agent", "hub memory proposed decision", {
      research: research(2, { supersedes: [WorkspaceKnowledgeItemId.make("user")] }),
    }),
  ]);
  expect(ids(result).sort()).toEqual(["agent", "user"]);
});

it("preserves conflicting lineage and labels unresolved contradictory evidence", () => {
  const result = compose([
    memory("a", "hub memory first claim", {
      research: research(1, { supersedes: [WorkspaceKnowledgeItemId.make("b")] }),
    }),
    memory("b", "hub memory conflicting claim", {
      research: {
        ...research(2, { supersedes: [WorkspaceKnowledgeItemId.make("a")] }),
        verification: "contradicted",
      },
    }),
  ]);
  expect(ids(result).sort()).toEqual(["a", "b"]);
  expect(result.prompt).toContain("모순 미해결");
});

it("honors validity instants instead of treating any future end date as expired", () => {
  const result = compose([
    memory("valid", "hub memory valid", {
      research: research(1, {
        validFrom: "2026-09-01T00:00:00.000Z",
        validTo: "2026-10-01T00:00:00.000Z",
      }),
    }),
    memory("expired", "hub memory expired", { research: research(1, { validTo: now }) }),
    memory("future", "hub memory future", {
      research: research(2, {
        validFrom: "2026-10-01T00:00:00.000Z",
        supersedes: [WorkspaceKnowledgeItemId.make("valid")],
      }),
    }),
  ]);
  expect(ids(result)).toEqual(["valid"]);
  expect(result.diagnostics?.decisions.find((d) => d.itemId === "future")?.reason).toBe(
    "not-yet-valid",
  );
});

it("carries retrieval lineage from the authoritative source and keeps the chunk reference", () => {
  const source = memory("source", "hub memory actual evidence", {
    kind: "rag-source",
    research: research(3, { evidenceRefs: ["benchmark-03"] }),
  });
  const result = compose([source], {}, [{ ...rag(source), chunkId: "4" }]);
  expect(result.prompt).toContain("revision=3");
  expect(result.prompt).toContain("benchmark-03");
  expect(result.diagnostics?.decisions[0]?.chunkId).toBe("4");
  expect(result.diagnostics?.decisions[0]?.verification).toBe("verified");
});

it("keeps ordering stable when timestamps or input enumeration change", () => {
  const items = [memory("z", "hub memory z"), memory("a", "hub memory a")];
  const before = compose(items);
  const after = compose(
    items.toReversed().map((item) => ({ ...item, updatedAt: "2026-09-13T00:00:00.000Z" })),
  );
  expect(before.prompt).toBe(after.prompt);
  expect(before.diagnostics?.contextRevision).toBe(after.diagnostics?.contextRevision);
});

it("keeps the admitted RAG prefix stable when retrieval scores swap", () => {
  const items = [
    memory("a", "hub memory first fact", { kind: "rag-source" }),
    memory("z", "hub memory second fact", { kind: "rag-source" }),
  ];
  const before = compose(
    items,
    {},
    items.map((item, i) => ({ ...rag(item), score: i + 1 })),
  );
  const after = compose(
    items,
    {},
    items.map((item, i) => ({ ...rag(item), score: 2 - i })),
  );
  expect(before.sourceItemIds).toHaveLength(2);
  expect(before.prompt).toBe(after.prompt);
});

it("keeps the established composition available until rollout is approved by the pilot", () => {
  const items = [memory("hub", "hub native memory")];
  expect(
    composeWorkspacePrompt({
      now: Date.parse("2026-09-12T12:00:00.000Z"),
      request: { projectId, task: "웹 버튼 간격 수정" },
      items,
      ragMatches: [],
    }).sourceItemIds,
  ).toHaveLength(1);
  expect(
    composeWorkspacePrompt({
      now: Date.parse("2026-09-12T12:00:00.000Z"),
      request: { projectId, task: "웹 버튼 간격 수정", contextMode: "relevant" },
      items,
      ragMatches: [],
    }).sourceItemIds,
  ).toEqual([]);
});

it("round trips explicit lineage and reads pre-lineage research unchanged", () => {
  const current = research(2, {
    supersedes: [WorkspaceKnowledgeItemId.make("old")],
    evidenceRefs: ["receipt-1"],
  });
  const json = Schema.fromJsonString(WorkspaceResearchRecord);
  expect(Schema.decodeSync(json)(Schema.encodeSync(json)(current))).toEqual(current);
  const legacy = { query: "old", sources: [], capturedAt: now, verification: "unverified" };
  expect(decodeResearch(legacy)).toEqual(legacy);
});

it("preserves two different required facts from a long source and supports the one-chunk fallback", () => {
  const source = memory(
    "benchmark",
    "latencyBefore 1.467. " + "neutral filler ".repeat(180) + "latencyAfter 5.897.",
  );
  const result = compose([source], { task: "latencyBefore latencyAfter" });
  expect(result.prompt).toContain("1.467");
  expect(result.prompt).toContain("5.897");
  expect(result.diagnostics?.decisions.filter((decision) => decision.selected)).toHaveLength(2);
  expect(ids(result)).toEqual(["benchmark"]);
  const legacyCap = compose([source], { task: "latencyBefore latencyAfter", maxChunksPerItem: 1 });
  expect(legacyCap.diagnostics?.decisions.filter((decision) => decision.selected)).toHaveLength(1);
});

it("does not inject an evaluation trace merely because it quotes the user's task", () => {
  const trace = memory("evaluation-trace", "RAG 평가: 웹 버튼 간격 수정은 무관 질의 예시입니다.", {
    title: "RAG 평가 trace",
    research: {
      query: "RAG 평가",
      sources: [],
      capturedAt: now,
      verification: "verified",
      contextTopics: ["RAG", "토큰"],
    },
  });
  const result = compose([trace], { task: "웹 버튼 간격 수정" });
  expect(ids(result)).toEqual([]);
  expect(result.diagnostics?.decisions[0]?.reason).toBe("topic-mismatch");
  expect(ids(compose([trace], { task: "RAG 평가" }))).toEqual(["evaluation-trace"]);
  expect(
    composeWorkspacePrompt({
      now: Date.parse(now),
      request: { projectId, task: "웹 버튼 간격 수정", contextMode: "standard" },
      items: [trace],
      ragMatches: [],
    }).sourceItemIds,
  ).toEqual([]);
  expect(
    ids(compose([{ ...trace, kind: "directive", origin: "user" }], { task: "웹 버튼 간격 수정" })),
  ).toEqual(["evaluation-trace"]);
});
