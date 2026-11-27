import * as NodeCrypto from "node:crypto";
import { designReferenceText } from "@t3tools/contracts";
import { chunkAttachmentDocument } from "../documents/extractDocument.ts";
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
import { MIN_SEMANTIC_ONLY_SIMILARITY } from "../documents/semanticSearch.ts";
import {
  decomposeRetrievalSubQueries,
  workspaceRetrievalQuery,
} from "./workspaceSearchVocabulary.ts";
import {
  isAutomaticConversationRagItem,
  knowledgeContentDigest,
} from "./workspaceConversationRag.ts";
import { extractDeterministicEntitySlot } from "./WorkspaceMemory.ts";

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
  // Graphiti Issue #1728 safe slot supersession: only within identical (entityKey, predicateSlot) pairs
  const bySlot = new Map<string, WorkspaceKnowledgeItem[]>();
  for (const item of items) {
    if (item.kind === "directive") continue;
    if (item.origin !== "user" && item.research?.verification !== "verified") continue;
    const slot = extractDeterministicEntitySlot(item.content, item.title);
    if (!slot) continue;
    const slotKey = `${item.projectId}::${slot.entityKey}::${slot.predicateSlot}`;
    const group = bySlot.get(slotKey) ?? [];
    group.push(item);
    bySlot.set(slotKey, group);
  }
  for (const group of bySlot.values()) {
    if (group.length < 2) continue;
    const sorted = group.toSorted(
      (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id),
    );
    const latest = sorted[sorted.length - 1]!;
    const latestSlot = extractDeterministicEntitySlot(latest.content, latest.title);
    const latestTime = Date.parse(latest.updatedAt);
    if (!latestSlot || !Number.isFinite(latestTime)) continue;
    for (const earlier of sorted.slice(0, -1)) {
      if (earlier.origin === "user" && latest.origin !== "user") continue;
      const earlierTime = Date.parse(earlier.updatedAt);
      if (!Number.isFinite(earlierTime) || earlierTime >= latestTime) continue;
      const earlierSlot = extractDeterministicEntitySlot(earlier.content, earlier.title);
      if (
        earlierSlot &&
        (earlierSlot.normalizedValue.toLowerCase() !== latestSlot.normalizedValue.toLowerCase() ||
          earlierSlot.isNegationOrRollback !== latestSlot.isNegationOrRollback)
      ) {
        keys.add(knowledgeSourceKey({ projectId: earlier.projectId, itemId: earlier.id }));
      }
    }
  }
  return keys;
}

/**
 * HippoRAG-inspired single-step Personalized PageRank (PPR) entity-anchor propagation:
 * propagates relevance from direct entity/identifier seed hits to 1-hop connected candidates
 * sharing extracted code/clause/entity anchors.
 */
export function computeEntityAnchorPprBoost(
  task: string,
  candidates: ReadonlyArray<SelectedKnowledge>,
): Map<string, number> {
  const boostByKey = new Map<string, number>();
  if (candidates.length <= 1) return boostByKey;
  const queryAnchors = new Set(
    extractQueryIdentifiers(task).map((id) => id.normalize("NFKC").toLowerCase()),
  );
  const candidateAnchors = candidates.map((candidate) => {
    const key = `${knowledgeSourceKey(candidate.decision)}:${candidate.decision.chunkId ?? ""}`;
    const anchors = new Set(
      extractQueryIdentifiers(`${candidate.source.title} ${candidate.body}`).map((id) =>
        id.normalize("NFKC").toLowerCase(),
      ),
    );
    const slot = extractDeterministicEntitySlot(candidate.body, candidate.source.title);
    if (slot) {
      anchors.add(slot.entityKey.toLowerCase());
      anchors.add(`${slot.entityKey}::${slot.predicateSlot}`.toLowerCase());
    }
    return { candidate, key, anchors };
  });

  // Seed nodes: candidates that directly match a query anchor or have top lexical/semantic score
  const discoveredHopAnchors = new Set<string>(queryAnchors);
  for (const entry of candidateAnchors) {
    const hitsQueryAnchor = [...entry.anchors].some((a) => queryAnchors.has(a));
    if (hitsQueryAnchor || entry.candidate.score >= 6) {
      for (const a of entry.anchors) discoveredHopAnchors.add(a);
    }
  }

  if (discoveredHopAnchors.size === 0) return boostByKey;

  for (const entry of candidateAnchors) {
    let shared = 0;
    for (const a of entry.anchors) {
      if (discoveredHopAnchors.has(a)) shared++;
    }
    if (shared > 0) {
      // Single-step PPR restart propagation boost (1 - alpha = 0.15 per shared entity link, capped)
      boostByKey.set(entry.key, Math.min(1.5, shared * 0.35));
    }
  }
  return boostByKey;
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

/** Older search results can carry only a highlighted excerpt and no chunk ID. */
function localPassageForExcerpt(snippet: string, pieces: readonly string[]): string | undefined {
  const excerpt = snippet
    .trim()
    .replace(/^…|…$/gu, "")
    .trim();
  if (!excerpt) return undefined;
  const plain = excerpt.replace(/\[([^[\]]+)\]/gu, "$1");
  let found: string | undefined;
  for (const piece of pieces) {
    const flat = piece.replace(/\s+/gu, " ").trim();
    if (!flat.includes(excerpt) && (!plain || !flat.includes(plain))) continue;
    if (found !== undefined && found !== piece) return undefined;
    found = piece;
  }
  return found;
}

/** Extract code symbols, hyphenated error/product IDs (TS-999, A-2201), and Korean clause identifiers (제3조). */
export function extractQueryIdentifiers(task: string): ReadonlyArray<string> {
  const codeSymbols = [...task.matchAll(/\b[A-Za-z_$][A-Za-z0-9_.$:/-]*\b/gu)]
    .map((match) => match[0])
    .filter((token) => /[a-z][A-Z]|[_./:]|^[A-Za-z]{1,8}-\d{1,8}(?:-[A-Za-z0-9]+)?$/u.test(token));
  const clauseSymbols = [
    ...task.normalize("NFKC").matchAll(/제\s*\d+\s*(?:조(?:\s*의\s*\d+)?|항|호|장|절)/gu),
  ].map((match) => match[0].replace(/\s+/gu, ""));
  return [...new Set([...codeSymbols, ...clauseSymbols])];
}

export interface WorkspaceContextSufficiency {
  readonly status: "sufficient" | "partial" | "insufficient";
  readonly findings: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly action: "generate_answer" | "retrieve_more" | "rewrite_question";
  readonly coverageRatio: number;
}

/**
 * Google Sufficient Context Agent & Self-RAG reflection pattern:
 * audits selected evidence against required query terms, identifiers, and
 * decomposed sub-queries to output explicit Findings, Gaps, and Next Action.
 */
export function assessWorkspaceContextSufficiency(input: {
  readonly task: string;
  readonly candidates: ReadonlyArray<SelectedKnowledge>;
}): WorkspaceContextSufficiency {
  const terms = (buildSearchQuery(workspaceRetrievalQuery(input.task))?.terms ?? []).filter(
    (term) => !TASK_OPERATION_TERMS.has(term.replace(/(?:해라|해)$/u, "")),
  );
  const subjectTerms = terms.filter(isSubjectTerm);
  const identifiers = extractQueryIdentifiers(input.task);
  const required = [...new Set([...identifiers, ...(subjectTerms.length ? subjectTerms : terms)])];
  if (required.length === 0) {
    return {
      status: "sufficient",
      findings: [],
      gaps: [],
      action: "generate_answer",
      coverageRatio: 1,
    };
  }
  const combinedEvidence = input.candidates.map((c) => `${c.source.title} ${c.body}`).join("\n");
  const compactEvidence = combinedEvidence.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  const findings: string[] = [];
  const gaps: string[] = [];
  for (const item of required) {
    const compactItem = item.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
    if (
      termCoverage([item.toLowerCase()], combinedEvidence) > 0 ||
      compactEvidence.includes(compactItem)
    ) {
      findings.push(item);
    } else {
      gaps.push(item);
    }
  }
  const subQueries = decomposeRetrievalSubQueries(input.task);
  if (subQueries.length > 1) {
    for (const sub of subQueries.slice(1)) {
      const subTerms = (buildSearchQuery(sub)?.terms ?? []).filter(isSubjectTerm);
      if (subTerms.length > 0 && subTerms.every((t) => termCoverage([t], combinedEvidence) === 0)) {
        gaps.push(`하위 질문 미충족: ${sub}`);
      }
    }
  }
  const coverageRatio = findings.length / Math.max(1, required.length);
  const status =
    gaps.length === 0 || coverageRatio >= 0.8
      ? "sufficient"
      : findings.length > 0
        ? "partial"
        : "insufficient";
  const action =
    status === "sufficient"
      ? "generate_answer"
      : status === "partial"
        ? "retrieve_more"
        : "rewrite_question";
  return { status, findings, gaps, action, coverageRatio };
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
  sufficiency: WorkspaceContextSufficiency;
} {
  const request = input.request;
  const now = input.now;
  const mode = request.contextMode ?? "relevant";
  const terms = (buildSearchQuery(workspaceRetrievalQuery(request.task))?.terms ?? []).filter(
    (term) => !TASK_OPERATION_TERMS.has(term.replace(/(?:해라|해)$/u, "")),
  );
  const identifiers = extractQueryIdentifiers(request.task);
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
  const matchesByItem = Map.groupBy(relevantMatches, knowledgeSourceKey);
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
    const fullText = `${metadata} ${content}`;
    const compactFullText = fullText.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
    const matchedIdentifiers = identifiers.filter(
      (identifier) =>
        fullText.includes(identifier) ||
        compactFullText.includes(identifier.normalize("NFKC").replace(/\s+/gu, "").toLowerCase()),
    );
    const matchedTerms = terms.filter((term) => termCoverage([term], fullText) > 0);
    const titleTerms = terms.filter((term) => termCoverage([term], metadata) > 0);
    const substantive = terms.filter((term) => term.length >= 2);
    const matchedSubstantive = matchedTerms.filter((term) => term.length >= 2);
    const subjectTotal = substantive.filter(isSubjectTerm);
    const subjectMatched = matchedSubstantive.filter(isSubjectTerm);
    // Coverage uses the existing Korean-aware analyzer, plus Self-RAG/CRAG multi-term & clause grading.
    const lexicalRelevant =
      matchedTerms.length > 0 &&
      (matchedIdentifiers.length > 0 ||
        titleTerms.some(isSubjectTerm) ||
        (titleTerms.some((term) => PLATFORM_TITLE_TERMS.has(term)) &&
          matchedSubstantive.some(isSubjectTerm)) ||
        (substantive.length > 0 && matchedSubstantive.length / substantive.length >= 0.8) ||
        (subjectTotal.length >= 3 &&
          subjectMatched.length >= 3 &&
          subjectMatched.length / subjectTotal.length >= 0.6));
    // A semantic hit must survive composition even when its wording differs from the question.
    const semanticSimilarity =
      "semanticSimilarity" in source ? source.semanticSimilarity : undefined;
    const relevant = lexicalRelevant || (semanticSimilarity ?? -1) >= MIN_SEMANTIC_ONLY_SIMILARITY;
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
      return false;
    candidates.push({
      source: { ...source, ...(research ? { research } : {}) },
      decision,
      body: content,
      mandatory,
      priority: mandatory ? -1 : priority[source.kind],
      score:
        matchedIdentifiers.length * 4 +
        matchedTerms.length * 3 +
        titleTerms.length * 2 +
        (research?.verification === "verified" ? 1 : 0) +
        (semanticSimilarity ?? 0),
    });
    return true;
  };
  for (const item of items) {
    if (item.kind === "rag-source") continue;
    const key = knowledgeSourceKey({ projectId: item.projectId, itemId: item.id });
    evaluated.add(key);
    const cap = input.request.maxChunksPerItem ?? (includeHistory ? 3 : 2);
    const matches =
      mode === "relevant" && request.includeRag !== false && item.kind === "long-term-memory"
        ? (matchesByItem.get(key) ?? [])
        : [];
    // Match the stored index boundaries before merging retrieved and in-memory passages.
    const content =
      matches.length && item.research?.design
        ? item.content + "\n\n" + designReferenceText(item.research.design)
        : item.content;
    const locations = matches.length ? item.research?.attachment?.locations : undefined;
    const pieces = locations
      ? chunkAttachmentDocument(content, locations)
      : mode === "relevant" && !["directive", "goal", "prompt"].includes(item.kind)
        ? chunkSearchableContent(content)
        : [content];
    const passages: Array<{
      content: string;
      chunkId: string | undefined;
      match?: WorkspaceRagMatch;
      coverage: number;
    }> = [];
    const seenChunks = new Set<string>();
    const seenBodies = new Set<string>();
    for (const match of matches) {
      const local = match.chunkId === undefined ? undefined : pieces[Number(match.chunkId)];
      const body =
        match.content ?? local ?? localPassageForExcerpt(match.snippet, pieces) ?? match.snippet;
      if ((match.chunkId !== undefined && seenChunks.has(match.chunkId)) || seenBodies.has(body))
        continue;
      if (match.chunkId !== undefined) seenChunks.add(match.chunkId);
      seenBodies.add(body);
      passages.push({
        content: body,
        chunkId: match.chunkId,
        match,
        coverage: termCoverage(terms, body),
      });
    }
    for (const [index, body] of pieces.entries()) {
      if (seenChunks.has(String(index)) || seenBodies.has(body)) continue;
      seenBodies.add(body);
      passages.push({
        content: body,
        chunkId: pieces.length > 1 ? String(index) : undefined,
        coverage: termCoverage(terms, body),
      });
    }
    // A lexical hit can live in a sibling of a semantic hit, including one outside the search window.
    passages.sort((left, right) => right.coverage - left.coverage);
    let selected = 0;
    for (const [index, passage] of passages.entries()) {
      if (index > 0 && !passage.match && passage.coverage === 0) continue;
      const source = passage.match ? { ...passage.match, kind: "long-term-memory" as const } : item;
      if (consider(source, passage.content, passage.chunkId)) selected++;
      if (selected >= cap) break;
    }
  }
  for (const match of relevantMatches) {
    const key = knowledgeSourceKey(match);
    if (evaluated.has(key)) continue;
    const identity = key + ":" + (match.chunkId ?? "item");
    if (evaluated.has(identity)) continue;
    evaluated.add(identity);
    consider(match, match.content ?? match.snippet, match.chunkId);
  }
  const pprBoosts = computeEntityAnchorPprBoost(request.task, candidates);
  const boostedCandidates = candidates.map((candidate) => {
    const key = `${knowledgeSourceKey(candidate.decision)}:${candidate.decision.chunkId ?? ""}`;
    const boost = pprBoosts.get(key) ?? 0;
    return boost > 0 ? { ...candidate, score: candidate.score + boost } : candidate;
  });
  const sortedCandidates = boostedCandidates.toSorted(
    (a, b) =>
      a.priority - b.priority ||
      (a.mandatory && b.mandatory ? 0 : b.score - a.score) ||
      knowledgeSourceKey(a.decision).localeCompare(knowledgeSourceKey(b.decision)) ||
      (a.decision.chunkId ?? "").localeCompare(b.decision.chunkId ?? ""),
  );
  return {
    candidates: sortedCandidates,
    decisions,
    includeHistory,
    ragMatches: relevantMatches,
    sufficiency: assessWorkspaceContextSufficiency({
      task: request.task,
      candidates: sortedCandidates,
    }),
  };
}
