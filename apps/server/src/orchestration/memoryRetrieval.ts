// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { multiArmReciprocalRankFusion } from "../documents/semanticSearch.ts";
import { buildSearchQuery, scoreQueryDocumentInteraction } from "../persistence/searchText.ts";
import {
  computeTemporalProximityScore,
  parseKoreanTemporalRange,
  type ParsedTemporalRange,
} from "./koreanTemporalParser.ts";
import {
  computeEntityOverlapScore,
  extractMemoryEntities,
  type MemoryLayer,
} from "./memoryConsolidatorV3.ts";
import {
  classifyCognitiveMemory,
  classifyMemorySalience,
  type CognitiveMemoryType,
  type MemorySalienceTier,
} from "./memorySalience.ts";

export type { CognitiveMemoryType, MemorySalienceTier };
export type MemoryTier = "hot" | "warm" | "cold";

export interface WorkspaceMemoryRecord {
  id: string;
  workspaceId: string;
  topic: string;
  content: string;
  role: "user" | "assistant" | "system";
  salience: MemorySalienceTier;
  cognitiveType: CognitiveMemoryType;
  memoryTier: MemoryTier;
  createdAt: number;
  lastAccessedAt: number | null;
  accessCount: number;
  stabilityDays: number;
  heatScore: number;
  entityKey: string | null;
  predicateSlot: string | null;
  validFrom: number;
  validTo: number | null;
  expiredAt: number | null;
  supersededById: string | null;
  lexicalScore?: number;
  semanticScore?: number;
}

export type MemoryEvidence = {
  id: string;
  project_id: string;
  scope: string;
  text: string;
  origin: string;
  verification: string;
  status: string;
  created_at: string;
  access_count?: number;
  last_accessed_at?: number | null;
  stability_days?: number;
  heat_score?: number;
  cognitive_type?: CognitiveMemoryType;
  memory_tier?: MemoryTier;
  entity_key?: string | null;
  predicate_slot?: string | null;
  valid_from?: number;
  valid_to?: number | null;
  expired_at?: number | null;
  superseded_by_id?: string | null;
  memory_layer?: MemoryLayer;
  context_prefix?: string | null;
  rationale?: string | null;
  entities_json?: string;
  proof_fact_ids?: string;
  rrfScore?: number;
};

const MS_PER_DAY = 86_400_000;
const BASE_HALF_LIFE_DAYS = 30.0;
const FREQUENCY_ALPHA = 0.85;

const SALIENCE_MULTIPLIER: Record<MemorySalienceTier, number> = {
  "user-decision": 2.0,
  "reported-evidence": 1.25,
  ordinary: 1.0,
};

const COGNITIVE_MULTIPLIER: Record<CognitiveMemoryType, number> = {
  directive: 2.1,
  procedural: 1.75,
  semantic: 1.4,
  episodic: 1.0,
};

const historicalQuery =
  /과거|이전|당시|언제|연혁|변경\s*이력|작년|재작년|지난|어제|그때|\b(?:history|historical|previous|before|when|20\d{2})\b/iu;
const correction = /정정|이제부터|앞으로|수정한다|대신|\b(?:correction|actually|from now on)\b/iu;

export function isHistoricalMemoryQuery(query: string): boolean {
  return historicalQuery.test(query) || parseKoreanTemporalRange(query) !== null;
}

function safeParseStringArray(raw: string | undefined): ReadonlyArray<string> {
  if (!raw || raw === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 4-Arm Hybrid Ranker (`k = 60` RRF):
 * Arm 1: Semantic / Late-Interaction similarity (`context_prefix` + `rationale` + `text`)
 * Arm 2: Hangul 2-gram BM25 lexical order
 * Arm 3: Entity Co-occurrence graph ($\tanh(0.5 \times |\text{shared}|)$)
 * Arm 4: Bi-temporal range proximity (`parseKoreanTemporalRange`)
 */
export function rankMemoryCandidates4Arm<
  A extends MemoryEvidence & { topic?: string; lexicalRank?: number },
>(
  candidates: readonly A[],
  query: string,
  nowMs: number,
  options?: {
    readonly semanticSimilarities?: ReadonlyMap<string, number>;
    readonly explicitRange?: ParsedTemporalRange | null;
  },
): Array<A & { rrfScore: number }> {
  if (candidates.length === 0) return [];
  const parsedSearch = buildSearchQuery(query);
  const queryTerms = parsedSearch?.terms ?? [];
  const queryEntities = new Set(extractMemoryEntities(query));
  const temporalRange =
    options?.explicitRange !== undefined
      ? options.explicitRange
      : parseKoreanTemporalRange(query, nowMs);

  const byId = new Map<string, A>();
  for (const c of candidates) {
    if (!byId.has(c.id)) byId.set(c.id, c);
  }
  const uniqueList = [...byId.values()];

  // Arm 1: Semantic / Query-Document Cross-Interaction
  const semanticScored = uniqueList
    .map((row) => {
      const denseSim = options?.semanticSimilarities?.get(row.id) ?? 0;
      const interaction = scoreQueryDocumentInteraction({
        query,
        terms: queryTerms,
        title: `${row.topic ?? ""} ${row.context_prefix ?? ""}`.trim(),
        tagsText: row.rationale ?? "",
        content: row.text,
      });
      const score = denseSim > 0 ? 0.65 * denseSim + 0.35 * interaction : interaction;
      return { id: row.id, score };
    })
    .filter((entry) => entry.score > 0.05)
    .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // Arm 2: Hangul 2-gram BM25 Lexical order
  const lexicalArm = uniqueList
    .filter((row) => row.lexicalRank !== undefined)
    .toSorted(
      (a, b) => (a.lexicalRank ?? 9999) - (b.lexicalRank ?? 9999) || a.id.localeCompare(b.id),
    )
    .map((row) => row.id);

  // Arm 3: Entity Graph Co-occurrence ($\tanh(0.5 \times |\text{shared}|)$)
  const entityScored =
    queryEntities.size > 0
      ? uniqueList
          .map((row) => {
            const storedEntities = safeParseStringArray(row.entities_json);
            const rowEntities =
              storedEntities.length > 0
                ? storedEntities
                : extractMemoryEntities(row.text, row.topic ?? "", row.entity_key);
            return {
              id: row.id,
              score: computeEntityOverlapScore(queryEntities, rowEntities),
            };
          })
          .filter((entry) => entry.score > 0)
          .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      : [];

  // Arm 4: Temporal Window Proximity
  const temporalScored =
    temporalRange !== null
      ? uniqueList
          .map((row) => {
            const ts =
              row.valid_from && row.valid_from > 0 ? row.valid_from : Date.parse(row.created_at);
            return {
              id: row.id,
              score: computeTemporalProximityScore(ts, temporalRange, nowMs),
            };
          })
          .filter((entry) => entry.score >= 0.2)
          .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      : [];

  const fused = multiArmReciprocalRankFusion(
    [
      { ids: semanticScored.map((e) => e.id), weight: 1.0 },
      { ids: lexicalArm.length > 0 ? lexicalArm : uniqueList.map((r) => r.id), weight: 1.1 },
      { ids: entityScored.map((e) => e.id), weight: 1.15 },
      { ids: temporalScored.map((e) => e.id), weight: 1.2 },
    ],
    60,
    128,
  );

  return fused
    .map(([id, rrfScore]) => {
      const row = byId.get(id);
      return row ? { ...row, rrfScore } : null;
    })
    .filter((item): item is A & { rrfScore: number } => item !== null);
}

/**
 * Ebbinghaus Retention + ACT-R frequency reinforcement stability & Heat Score calculation.
 * Reference: MemoryBank (AAAI 2024), Importance-Based Memory Decay (2026), MemoryOS (2025).
 */
export function computeMemoryRetentionAndHeat(
  record: Pick<
    WorkspaceMemoryRecord,
    "createdAt" | "lastAccessedAt" | "accessCount" | "salience" | "cognitiveType"
  >,
  nowMs: number = Date.now(),
): { stabilityDays: number; retention: number; heatScore: number; recommendedTier: MemoryTier } {
  const salienceBoost = SALIENCE_MULTIPLIER[record.salience] ?? 1.0;
  const cognitiveBoost = COGNITIVE_MULTIPLIER[record.cognitiveType] ?? 1.0;
  const combinedImportance = Math.max(salienceBoost, cognitiveBoost);

  // S_i = S_0 * (1 + alpha * ln(1 + c_i)) * importance
  const stabilityDays =
    BASE_HALF_LIFE_DAYS *
    (1 + FREQUENCY_ALPHA * Math.log(1 + Math.max(0, record.accessCount))) *
    combinedImportance;

  const ageCreateDays = Math.max(0, (nowMs - record.createdAt) / MS_PER_DAY);
  const lastTouchMs = record.lastAccessedAt ?? record.createdAt;
  const ageAccessDays = Math.max(0, (nowMs - lastTouchMs) / MS_PER_DAY);

  // 65% exponential decay from last access + 35% half-life decay from creation
  const accessRetention = Math.exp(-ageAccessDays / stabilityDays);
  const creationRetention = Math.pow(2, -ageCreateDays / stabilityDays);
  const retention = 0.65 * accessRetention + 0.35 * creationRetention;

  const frequencyReinforcement = 1 + 0.3 * Math.log(1 + Math.max(0, record.accessCount));
  const heatScore = retention * frequencyReinforcement * combinedImportance;

  let recommendedTier: MemoryTier = "warm";
  if (
    (record.cognitiveType === "directive" || record.salience === "user-decision") &&
    heatScore >= 1.35
  ) {
    recommendedTier = "hot";
  } else if (heatScore < 0.25 && ageAccessDays > 45) {
    recommendedTier = "cold";
  }

  return { stabilityDays, retention, heatScore, recommendedTier };
}

function computeTokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) {
    if (b.has(tok)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenizeNormalized(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^a-z0-9가-힣_./:-]+/u)
      .filter((t) => t.length >= 2),
  );
}

export interface SelectMemoryEvidenceOptions {
  maxItems?: number;
  maxBytes?: number;
  mmrLambda?: number;
  includeHistoricalSuperseded?: boolean;
  nowMs?: number;
}

/**
 * Bi-temporal + Ebbinghaus Retention + ACT-R Heat Score + MMR selector for WorkspaceMemoryRecord candidates.
 */
export function selectWorkspaceMemoryRecords(
  candidates: readonly WorkspaceMemoryRecord[],
  options: SelectMemoryEvidenceOptions = {},
): WorkspaceMemoryRecord[] {
  const maxItems = options.maxItems ?? 6;
  const maxBytes = options.maxBytes ?? 14 * 1024;
  const lambda = options.mmrLambda ?? 0.7;
  const nowMs = options.nowMs ?? Date.now();

  const eligible = candidates.filter((c) => {
    if (options.includeHistoricalSuperseded) return true;
    const isCurrentlyValid = c.validTo === null || c.validTo > nowMs;
    const isNotExpired = c.expiredAt === null;
    return isCurrentlyValid && isNotExpired && !c.supersededById;
  });

  const scoredPool = eligible.map((record) => {
    const { retention, heatScore } = computeMemoryRetentionAndHeat(record, nowMs);
    const roleWeight = record.role === "user" ? 1.25 : 1.0;
    const searchSignal = 0.55 * (record.semanticScore ?? 0.5) + 0.45 * (record.lexicalScore ?? 0.5);
    const baseScore =
      searchSignal * retention * roleWeight * (0.8 + 0.2 * Math.min(2.5, heatScore));
    return {
      record,
      baseScore,
      tokens: tokenizeNormalized(record.content),
    };
  });

  const selected: Array<{ record: WorkspaceMemoryRecord; tokens: Set<string> }> = [];
  let usedBytes = 0;

  while (selected.length < maxItems && scoredPool.length > 0) {
    let bestIdx = -1;
    let bestMmrScore = -Infinity;

    for (let i = 0; i < scoredPool.length; i++) {
      const candidate = scoredPool[i]!;
      let maxRedundancy = 0;
      for (const chosen of selected) {
        const sim = computeTokenJaccard(candidate.tokens, chosen.tokens);
        if (sim > maxRedundancy) maxRedundancy = sim;
      }

      const mmrScore = lambda * candidate.baseScore - (1 - lambda) * maxRedundancy;
      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    const [winner] = scoredPool.splice(bestIdx, 1);
    if (!winner) break;
    const itemBytes = Buffer.byteLength(winner.record.content, "utf8");

    if (usedBytes + itemBytes > maxBytes) {
      continue;
    }

    selected.push({ record: winner.record, tokens: winner.tokens });
    usedBytes += itemBytes;
  }

  return selected.map((s) => s.record);
}

const followUpOnlyTerms = new Set([
  "네",
  "예",
  "응",
  "그래",
  "좋아",
  "좋아요",
  "좋습니다",
  "맞아",
  "알겠어",
  "그렇게",
  "이거",
  "다시",
  "부탁해",
  "계속",
  "계속해",
  "진행해",
  "마저",
  "자세히",
  "더",
  "그거",
  "그것",
  "이전",
  "참고해",
  "알려줘",
  "계속해서",
  "이어서",
  "방금",
  "아까",
  "저거",
  "저것",
  "위에서",
  "말한",
  "continue",
  "more",
  "details",
  "previous",
  "again",
]);

/** Detect short follow-ups that do not identify a topic by themselves. */
export function hasMemorySearchAnchor(text: string): boolean {
  const continuationText = text
    .normalize("NFKC")
    .replace(/(^|[^\p{L}\p{N}])그대로(?=$|[^\p{L}\p{N}])/gu, "$1그렇게");
  return (buildSearchQuery(continuationText)?.terms ?? []).some(
    (term) => !followUpOnlyTerms.has(term),
  );
}
const normalize = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const words = (text: string) =>
  new Set(
    normalize(text)
      .match(/[\p{L}\p{N}_./:-]+/gu)
      ?.slice(0, 256) ?? [],
  );

/** Preserve original text while centering a bounded excerpt on the most query terms. */
export function matchedMemoryExcerptRange(
  text: string,
  terms: readonly string[],
  maxChars: number,
): { text: string; start: number; end: number } {
  if (text.length <= maxChars) return { text, start: 0, end: text.length };
  const budget = Math.max(0, maxChars - 2);
  if (budget === 0) return { text: "", start: 0, end: 0 };

  let normalized: string;
  let originalOffsets: number[] | undefined;
  let originalEnds: number[] | undefined;
  let graphemes: Intl.Segments | undefined;
  if (/^[\s\x20-\x7E\uAC00-\uD7A3]*$/u.test(text)) {
    normalized = text.toLowerCase();
  } else {
    normalized = "";
    originalOffsets = [];
    originalEnds = [];
    graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
    for (const { segment, index } of graphemes) {
      const part = segment.normalize("NFKC").toLowerCase();
      normalized += part;
      for (let indexInPart = 0; indexInPart < part.length; indexInPart++) {
        originalOffsets.push(index);
        originalEnds.push(index + segment.length);
      }
    }
  }

  const hits: Array<{ start: number; end: number; term: string }> = [];
  for (const term of new Set(terms)) {
    if (!term) continue;
    let position = normalized.indexOf(term);
    while (position >= 0) {
      hits.push({
        start: originalOffsets?.[position] ?? position,
        end: originalEnds?.[position + term.length - 1] ?? position + term.length,
        term,
      });
      position = normalized.indexOf(term, position + 1);
    }
  }
  const maxStart = text.length - budget;
  const events: Array<{ position: number; term: string; change: 1 | -1 }> = [];
  for (const hit of hits) {
    const first = Math.max(0, hit.end - budget);
    const last = Math.min(hit.start, maxStart);
    if (first > last) continue;
    events.push({ position: first, term: hit.term, change: 1 });
    events.push({ position: last + 1, term: hit.term, change: -1 });
  }
  events.sort((a, b) => a.position - b.position);
  let bestStart = 0;
  let bestEnd = 0;
  let bestCoverage = 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < events.length; ) {
    const position = events[index]!.position;
    while (index < events.length && events[index]!.position === position) {
      const event = events[index++]!;
      const count = (counts.get(event.term) ?? 0) + event.change;
      if (count === 0) counts.delete(event.term);
      else counts.set(event.term, count);
    }
    const intervalEnd = Math.min(maxStart, (events[index]?.position ?? maxStart + 1) - 1);
    if (position <= maxStart && counts.size > bestCoverage) {
      bestCoverage = counts.size;
      bestStart = position;
      bestEnd = intervalEnd;
    } else if (counts.size === bestCoverage && bestEnd + 1 === position) {
      bestEnd = intervalEnd;
    }
  }
  bestStart = Math.floor((bestStart + bestEnd) / 2);
  const startCluster = graphemes?.containing(bestStart);
  if (startCluster && startCluster.index < bestStart) {
    bestStart = startCluster.index + startCluster.segment.length;
  }
  let end = Math.min(text.length, bestStart + budget);
  const endCluster = graphemes?.containing(end);
  if (endCluster && endCluster.index < end) end = endCluster.index;
  return {
    text: `${bestStart > 0 ? "…" : ""}${text.slice(bestStart, end)}${end < text.length ? "…" : ""}`,
    start: bestStart,
    end,
  };
}

export function matchedMemoryExcerpt(
  text: string,
  terms: readonly string[],
  maxChars: number,
): string {
  return matchedMemoryExcerptRange(text, terms, maxChars).text;
}

/** Rank a bounded evidence pool; originals remain addressable and historical queries retain repetitions. */
export function selectMemoryEvidence<A extends MemoryEvidence>(
  rows: readonly A[],
  query: string,
  limit: number,
  now: number,
  options?: {
    readonly includeSuperseded?: boolean | undefined;
  },
) {
  const parsedTemporal = parseKoreanTemporalRange(query, now);
  const historical =
    options?.includeSuperseded === true || historicalQuery.test(query) || parsedTemporal !== null;
  const activeRows = historical
    ? rows
    : rows.filter((row) => {
        const isCurrentlyValid = row.valid_to == null || row.valid_to > now;
        const isNotExpired = row.expired_at == null;
        const isNotSuperseded = !row.superseded_by_id;
        return isCurrentlyValid && isNotExpired && isNotSuperseded;
      });
  const unique = new Map<
    string,
    { row: A; rank: number; supportingIds: string[]; additionalSources: number }
  >();
  activeRows.slice(0, 64).forEach((row, rank) => {
    const key = historical
      ? row.id
      : JSON.stringify([
          row.project_id,
          row.scope,
          row.origin,
          row.verification,
          row.memory_layer ?? "fact",
          row.status === "observed" ? "session" : "curated",
          normalize(row.text),
        ]);
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, { row, rank, supportingIds: [], additionalSources: 0 });
    } else {
      previous.rank = Math.min(previous.rank, rank);
      previous.additionalSources++;
      if (row.created_at > previous.row.created_at) {
        if (previous.supportingIds.length < 4) previous.supportingIds.push(previous.row.id);
        previous.row = row;
      } else if (previous.supportingIds.length < 4) previous.supportingIds.push(row.id);
    }
  });
  const candidates = [...unique.values()].map((entry) => {
    const timestamp = Date.parse(entry.row.created_at);
    const createdAtMs =
      entry.row.valid_from && entry.row.valid_from > 0
        ? entry.row.valid_from
        : Number.isFinite(timestamp)
          ? timestamp
          : now;
    const accessCount = Math.max(0, entry.row.access_count ?? 0);
    const importance = classifyMemorySalience(entry.row.origin, entry.row.text);
    const cognitiveType =
      entry.row.cognitive_type ??
      classifyCognitiveMemory(entry.row.text, entry.row.origin).cognitiveType;
    const metrics = computeMemoryRetentionAndHeat(
      {
        createdAt: createdAtMs,
        lastAccessedAt: entry.row.last_accessed_at ?? null,
        accessCount,
        salience: importance,
        cognitiveType,
      },
      now,
    );
    // Curated permanent rules do not decay with time when unaccessed, while observed session
    // memories decay with Ebbinghaus stability S_i (which strengthens as access_count grows).
    const recency =
      !historical && entry.row.status === "observed"
        ? 0.5 + 0.5 * metrics.retention
        : 1 + 0.15 * Math.log(1 + accessCount);
    const userStatement = entry.row.origin === "user" || entry.row.origin === "user-requested";
    const authority = userStatement ? 1.25 : 1;
    const corrected = !historical && userStatement && correction.test(entry.row.text) ? 1.15 : 1;
    const relevanceBoost =
      importance === "user-decision" ? 1.2 : importance === "reported-evidence" ? 1.1 : 1;
    const proofIds = safeParseStringArray(entry.row.proof_fact_ids);
    const proofBoost =
      proofIds.length > 0 ? 1 + Math.min(0.35, 0.12 * Math.log(1 + proofIds.length)) : 1;
    const observationBoost =
      entry.row.memory_layer === "observation" && entry.row.rationale ? 1.18 : 1;
    const temporalBoost =
      parsedTemporal !== null
        ? 0.75 + 0.55 * computeTemporalProximityScore(createdAtMs, parsedTemporal, now)
        : 1;
    const rankSignal =
      entry.row.rrfScore !== undefined && entry.row.rrfScore > 0
        ? entry.row.rrfScore * 30
        : 1 / (1 + entry.rank * 0.1);
    return {
      ...entry,
      tokens: words(entry.row.text),
      score:
        rankSignal *
        recency *
        authority *
        corrected *
        relevanceBoost *
        proofBoost *
        observationBoost *
        temporalBoost,
    };
  });
  const selected: typeof candidates = [];
  while (candidates.length && selected.length < Math.min(limit, 64)) {
    const score = (candidate: (typeof candidates)[number]) => {
      let redundancy = 0;
      for (const previous of selected) {
        let intersection = 0;
        for (const token of candidate.tokens) if (previous.tokens.has(token)) intersection++;
        const union = candidate.tokens.size + previous.tokens.size - intersection;
        redundancy = Math.max(redundancy, union ? intersection / union : 0);
      }
      return 0.7 * candidate.score - 0.3 * redundancy;
    };
    candidates.sort(
      (left, right) =>
        score(right) - score(left) ||
        left.rank - right.rank ||
        left.row.id.localeCompare(right.row.id),
    );
    selected.push(candidates.shift()!);
  }
  return selected.map(({ row, supportingIds, additionalSources }) => ({
    ...row,
    ...(additionalSources ? { supportingIds, additionalSources } : {}),
  }));
}

/**
 * Reinforce access_count, last_accessed_at, stability_days, heat_score, and memory_tier
 * in SQLite for records selected and injected into the prompt context.
 */
export const recordMemoryAccessReinforcementEffect = Effect.fn(
  "WorkspaceMemory.recordMemoryAccessReinforcement",
)(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
  accessedRows: ReadonlyArray<MemoryEvidence>,
  nowMs: number = Date.now(),
) {
  if (accessedRows.length === 0) return;
  for (const row of accessedRows) {
    const createdAtMs = Number.isFinite(Date.parse(row.created_at))
      ? Date.parse(row.created_at)
      : nowMs;
    const nextCount = Math.max(0, row.access_count ?? 0) + 1;
    const salience = classifyMemorySalience(row.origin, row.text);
    const cognitiveType =
      row.cognitive_type ?? classifyCognitiveMemory(row.text, row.origin).cognitiveType;
    const metrics = computeMemoryRetentionAndHeat(
      {
        createdAt: createdAtMs,
        lastAccessedAt: nowMs,
        accessCount: nextCount,
        salience,
        cognitiveType,
      },
      nowMs,
    );
    yield* sql`UPDATE workspace_memory_v2
      SET access_count = coalesce(access_count, 0) + 1,
          last_accessed_at = ${nowMs},
          stability_days = ${metrics.stabilityDays},
          heat_score = ${metrics.heatScore},
          memory_tier = ${metrics.recommendedTier}
      WHERE id = ${row.id} AND (project_id = ${projectId} OR scope = 'global')`;
  }
});
