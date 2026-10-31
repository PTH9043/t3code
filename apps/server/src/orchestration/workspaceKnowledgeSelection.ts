import * as NodeCrypto from "node:crypto";
import type {
  WorkspaceKnowledgeItem,
  WorkspacePromptComposeInput,
  WorkspacePromptDecision,
  WorkspaceRagMatch,
} from "@t3tools/contracts";
import {
  buildSearchQuery,
  chunkSearchableContent,
  termCoverage,
} from "../persistence/searchText.ts";
import { knowledgeAppliesToContext } from "./workspaceKnowledgeScope.ts";
import { MIN_SEMANTIC_SIMILARITY } from "../documents/semanticSearch.ts";
import { workspaceRetrievalQuery } from "./workspaceSearchVocabulary.ts";
import {
  isAutomaticConversationRagItem,
  knowledgeContentDigest,
} from "./workspaceConversationRag.ts";

export function knowledgeCopiesCurrentTask(
  item: WorkspaceKnowledgeItem,
  request: WorkspacePromptComposeInput,
): boolean {
  return (
    item.projectId === request.projectId &&
    isAutomaticConversationRagItem(item) &&
    request.sourceMessageId !== undefined &&
    item.tags.includes(`source-${knowledgeContentDigest(request.sourceMessageId, 16)}`)
  );
}

export const knowledgeSourceKey = (source: { projectId: string; itemId: string }) =>
  JSON.stringify([source.projectId, source.itemId]);
export const knowledgeContentHash = (content: string) =>
  NodeCrypto.createHash("sha256").update(content.replaceAll("\r\n", "\n").trim()).digest("hex");

/** Search retains all originals; automatic injection can be limited to an explicit subject. */
export function knowledgeMatchesContextTopic(
  source: Pick<WorkspaceKnowledgeItem, "research">,
  task: string,
): boolean {
  const topics = source.research?.contextTopics;
  return (
    topics === undefined ||
    topics.some((topic) =>
      task.normalize("NFKC").toLowerCase().includes(topic.normalize("NFKC").toLowerCase()),
    )
  );
}

type SelectionDecision = {
  -readonly [K in keyof WorkspacePromptDecision]: WorkspacePromptDecision[K];
};

export interface SelectedKnowledge {
  readonly source: WorkspaceKnowledgeItem | WorkspaceRagMatch;
  readonly decision: SelectionDecision;
  readonly body: string;
  readonly mandatory: boolean;
  readonly priority: number;
  readonly score: number;
}

/** Only explicit authoritative relationships can retire evidence; recency alone cannot. */
function supersededKeys(items: ReadonlyArray<WorkspaceKnowledgeItem>, now: number): Set<string> {
  const keys = new Set<string>();
  const byKey = new Map(
    items.map((item) => [knowledgeSourceKey({ projectId: item.projectId, itemId: item.id }), item]),
  );
  for (const item of items) {
    const lineage = item.research?.lineage;
    if (
      !lineage ||
      (lineage.validTo != null && Date.parse(lineage.validTo) <= now) ||
      (lineage.validFrom !== undefined && Date.parse(lineage.validFrom) > now) ||
      (item.origin !== "user" && item.research?.verification !== "verified")
    )
      continue;
    for (const id of lineage.supersedes ?? []) {
      const old = byKey.get(knowledgeSourceKey({ projectId: item.projectId, itemId: id }));
      if (!old || old.kind === "directive" || (old.origin === "user" && item.origin !== "user"))
        continue;
      if (
        old.research?.lineage &&
        (old.research.lineage.canonicalId !== lineage.canonicalId ||
          old.research.lineage.revision >= lineage.revision)
      )
        continue;
      // Circular/conflicting relationships preserve both records for inspection.
      if (old.research?.lineage?.supersedes?.includes(item.id)) continue;
      keys.add(knowledgeSourceKey({ projectId: item.projectId, itemId: id }));
    }
  }
  return keys;
}

const priority = {
  directive: 0,
  goal: 1,
  prompt: 2,
  "working-memory": 3,
  "run-memory": 4,
  "long-term-memory": 5,
  "rag-source": 6,
} as const;

// Verbs describe the requested operation, not the subject a memory must be about.
const TASK_OPERATION_TERMS = new Set([
  "수정",
  "변경",
  "추가",
  "삭제",
  "정리",
  "확인",
  "작업",
  "검증",
  "개선",
  "구현",
  "표시",
  "비교",
  "방법",
  "알려줘",
  "아래",
  "같은",
  "있는",
  "안",
  "과거",
  "현재",
  "최신",
  "이전",
  "이후",
  "fix",
  "change",
  "update",
  "review",
  "implement",
  "history",
  "historical",
  "previous",
  "current",
  "latest",
  "compare",
]);
const GENERIC_TITLE_TERMS = new Set([
  "windows",
  "linux",
  "macos",
  "ai",
  "인공지능",
  "사용자",
  "user",
  "모바일",
  "휴대폰",
  "스마트폰",
  "사용량",
  "화면",
  "문구",
  "입력",
  "출력",
]);
const PLATFORM_TITLE_TERMS = new Set(["windows", "linux", "macos", "모바일", "휴대폰", "스마트폰"]);
const isSubjectTerm = (term: string) =>
  term.length >= 2 && !GENERIC_TITLE_TERMS.has(term) && !/^\p{N}+$/u.test(term);

export function workspaceIncludesHistory(request: WorkspacePromptComposeInput): boolean {
  return (
    request.includeHistory ??
    /과거|이전|예전|변경\s*이력|변천|비교|history|historical|previous|compare/iu.test(request.task)
  );
}

/** Apply explicit subject/version restrictions before FTS limits, so ineligible archives cannot crowd out evidence. */
export function excludedRagSourceKeys(
  items: ReadonlyArray<WorkspaceKnowledgeItem>,
  request: WorkspacePromptComposeInput,
  now: number,
): string[] {
  const scoped = items.filter(
    (item) => item.status === "active" && knowledgeAppliesToContext(item, request),
  );
  const retired = supersededKeys(scoped, now);
  const includeHistory = workspaceIncludesHistory(request);
  return scoped
    .filter((item) => {
      if (item.origin === "user" && ["directive", "goal", "prompt"].includes(item.kind))
        return false;
      const lineage = item.research?.lineage;
      const temporalExcluded =
        request.contextMode === "relevant" &&
        ((lineage?.validFrom !== undefined && Date.parse(lineage.validFrom) > now) ||
          (!includeHistory &&
            (retired.has(knowledgeSourceKey({ projectId: item.projectId, itemId: item.id })) ||
              (lineage?.validTo != null && Date.parse(lineage.validTo) <= now))));
      return (
        knowledgeCopiesCurrentTask(item, request) ||
        !knowledgeMatchesContextTopic(item, request.task) ||
        temporalExcluded
      );
    })
    .map((item) => knowledgeSourceKey({ projectId: item.projectId, itemId: item.id }));
}

export function selectWorkspaceKnowledge(input: {
  readonly request: WorkspacePromptComposeInput;
  readonly items: ReadonlyArray<WorkspaceKnowledgeItem>;
  readonly ragMatches: ReadonlyArray<WorkspaceRagMatch>;
  readonly now: number;
}): {
  candidates: SelectedKnowledge[];
  decisions: WorkspacePromptDecision[];
  includeHistory: boolean;
  ragMatches: WorkspaceRagMatch[];
} {
  const request = input.request;
  const now = input.now;
  const mode = request.contextMode ?? "relevant";
  const terms = (buildSearchQuery(workspaceRetrievalQuery(request.task))?.terms ?? []).filter(
    (term) => !TASK_OPERATION_TERMS.has(term.replace(/(?:해라|해)$/u, "")),
  );
  const identifiers = [...request.task.matchAll(/\b[A-Za-z_$][A-Za-z0-9_.$:/-]*\b/gu)]
    .map((match) => match[0])
    .filter((token) => /[a-z][A-Z]|[_./:]/u.test(token));
  const includeHistory = workspaceIncludesHistory(request);
  // Never expose foreign titles or IDs even in exclusion diagnostics.
  const items = input.items.filter(
    (item) => item.status === "active" && knowledgeAppliesToContext(item, request),
  );
  const byKey = new Map(
    items.map((item) => [knowledgeSourceKey({ projectId: item.projectId, itemId: item.id }), item]),
  );
  const allByKey = new Map(
    input.items.map((item) => [
      knowledgeSourceKey({ projectId: item.projectId, itemId: item.id }),
      item,
    ]),
  );
  const retired = supersededKeys(items, now);
  const candidates: SelectedKnowledge[] = [];
  const decisions: WorkspacePromptDecision[] = [];
  const relevantMatches = input.ragMatches.filter((match) => {
    const original = allByKey.get(knowledgeSourceKey(match));
    return (
      knowledgeAppliesToContext(match, request) &&
      (!original || (original.status === "active" && knowledgeAppliesToContext(original, request)))
    );
  });
  const semanticMatches = new Map<string, WorkspaceRagMatch[]>();
  for (const match of relevantMatches) {
    if ((match.semanticSimilarity ?? -1) >= MIN_SEMANTIC_SIMILARITY) {
      const key = knowledgeSourceKey(match);
      semanticMatches.set(key, [...(semanticMatches.get(key) ?? []), match]);
    }
  }
  const evaluated = new Set<string>();
  const consider = (
    source: WorkspaceKnowledgeItem | WorkspaceRagMatch,
    content: string,
    chunkId?: string,
  ) => {
    const itemId = "id" in source ? source.id : source.itemId;
    const key = knowledgeSourceKey({ projectId: source.projectId, itemId });
    const item = "id" in source ? source : byKey.get(key);
    const research = item?.research ?? source.research;
    const lineage = research?.lineage;
    const isCore =
      source.kind === "directive" || source.kind === "goal" || source.kind === "prompt";
    const mandatory = item?.origin === "user" && isCore;
    const disabled =
      (source.kind === "long-term-memory" && request.includeLongTermMemory === false) ||
      ((source.kind === "working-memory" || source.kind === "run-memory") &&
        request.includeWorkingMemory === false) ||
      (!("id" in source) && request.includeRag === false);
    const metadata = source.title + " " + (item?.tags.join(" ") ?? "");
    const matchedTerms = terms.filter((term) => termCoverage([term], metadata + " " + content) > 0);
    const titleTerms = terms.filter((term) => termCoverage([term], metadata) > 0);
    const substantive = terms.filter((term) => term.length >= 2);
    const matchedSubstantive = matchedTerms.filter((term) => term.length >= 2);
    // Coverage uses the existing Korean-aware analyzer, not a cross-query BM25 threshold.
    const lexicalRelevant =
      matchedTerms.length > 0 &&
      (identifiers.some((identifier) => content.includes(identifier)) ||
        titleTerms.some(isSubjectTerm) ||
        (titleTerms.some((term) => PLATFORM_TITLE_TERMS.has(term)) &&
          matchedSubstantive.some(isSubjectTerm)) ||
        (substantive.length > 0 && matchedSubstantive.length / substantive.length >= 0.8));
    // A semantic hit must survive composition even when its wording differs from the question.
    const semanticSimilarity =
      "semanticSimilarity" in source ? source.semanticSimilarity : undefined;
    const relevant = lexicalRelevant || (semanticSimilarity ?? -1) >= MIN_SEMANTIC_SIMILARITY;
    const future = lineage?.validFrom !== undefined && Date.parse(lineage.validFrom) > now;
    const historical =
      retired.has(key) || (lineage?.validTo != null && Date.parse(lineage.validTo) <= now);
    const reason: WorkspacePromptDecision["reason"] = disabled
      ? "disabled"
      : item !== undefined && knowledgeCopiesCurrentTask(item, request)
        ? "current-task"
        : mandatory
          ? "mandatory"
          : !knowledgeMatchesContextTopic(research === undefined ? {} : { research }, request.task)
            ? "topic-mismatch"
            : future
              ? "not-yet-valid"
              : historical && !includeHistory
                ? "superseded"
                : mode === "standard"
                  ? "standard"
                  : isCore || relevant
                    ? historical
                      ? "included-history"
                      : research?.verification === "contradicted"
                        ? "contradicted"
                        : "relevant"
                    : "low-relevance";
    const decision: SelectionDecision = {
      projectId: source.projectId,
      itemId,
      title: source.title,
      ...(chunkId ? { chunkId } : {}),
      selected: false,
      reason,
      sourceChars: content.length,
      injectedChars: 0,
      matchedTerms,
      temporalStatus: future ? "future" : historical ? "history" : lineage ? "current" : "unknown",
      verification: research?.verification ?? "unverified",
      contentHash: knowledgeContentHash(content),
      sourceUpdatedAt: source.updatedAt,
      ...(lineage ? { revision: lineage.revision } : {}),
    };
    decisions.push(decision);
    if (
      reason === "disabled" ||
      reason === "low-relevance" ||
      reason === "superseded" ||
      reason === "not-yet-valid" ||
      reason === "topic-mismatch" ||
      reason === "current-task"
    )
      return;
    candidates.push({
      source: { ...source, ...(research ? { research } : {}) },
      decision,
      body: content,
      mandatory,
      priority: mandatory ? -1 : priority[source.kind],
      score:
        matchedTerms.length * 3 +
        titleTerms.length * 2 +
        (research?.verification === "verified" ? 1 : 0) +
        (semanticSimilarity ?? 0),
    });
  };
  for (const item of items) {
    if (item.kind === "rag-source") continue;
    const key = knowledgeSourceKey({ projectId: item.projectId, itemId: item.id });
    evaluated.add(key);
    const cap = input.request.maxChunksPerItem ?? (includeHistory ? 3 : 2);
    const matchedChunks = semanticMatches.get(key);
    if (
      mode === "relevant" &&
      request.includeRag !== false &&
      item.kind === "long-term-memory" &&
      matchedChunks?.length
    ) {
      for (const match of matchedChunks.slice(0, cap)) {
        consider({ ...match, kind: item.kind }, match.content ?? match.snippet, match.chunkId);
      }
      continue;
    }
    const pieces =
      mode === "relevant" && !["directive", "goal", "prompt"].includes(item.kind)
        ? chunkSearchableContent(item.content)
        : [item.content];
    const ranked = pieces
      .map((content, index) => ({
        content,
        index,
        score: termCoverage(terms, content),
      }))
      .toSorted((a, b) => b.score - a.score || a.index - b.index);
    const selectedPieces = ranked
      .filter((piece, index) => index === 0 || piece.score > 0)
      .slice(0, cap);
    for (const piece of selectedPieces)
      consider(item, piece.content, pieces.length > 1 ? String(piece.index) : undefined);
  }
  for (const match of relevantMatches) {
    const key = knowledgeSourceKey(match);
    if (evaluated.has(key)) continue;
    const identity = key + ":" + (match.chunkId ?? "item");
    if (evaluated.has(identity)) continue;
    evaluated.add(identity);
    consider(match, match.content ?? match.snippet, match.chunkId);
  }
  return {
    candidates: candidates.toSorted(
      (a, b) =>
        a.priority - b.priority ||
        (a.mandatory && b.mandatory ? 0 : b.score - a.score) ||
        knowledgeSourceKey(a.decision).localeCompare(knowledgeSourceKey(b.decision)) ||
        (a.decision.chunkId ?? "").localeCompare(b.decision.chunkId ?? ""),
    ),
    decisions,
    includeHistory,
    ragMatches: relevantMatches,
  };
}
