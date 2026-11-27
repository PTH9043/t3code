import * as NodeCrypto from "node:crypto";
import type { WorkspacePromptComposeInput, WorkspacePromptComposeResult } from "@t3tools/contracts";

export type WorkspaceTokenCounter = (text: string) => number;
export interface WorkspacePromptParts {
  result: WorkspacePromptComposeResult;
  sections: { task: string; instructions: string; memory: string; library: string };
}

export type QueryComplexityProfile =
  | "trivial"
  | "focused-lookup"
  | "standard-dev"
  | "deep-architectural";

export interface DynamicTokenBudgetAllocation {
  profile: QueryComplexityProfile;
  totalMaxChars: number;
  hotDirectivesMaxChars: number;
  warmMemoryMaxChars: number;
  semanticRagMaxChars: number;
  recentHistoryMaxChars: number;
  unmaskedRecentToolCalls: number;
}

/**
 * Dynamic token budget gating by query complexity profile (ACON adaptive compaction pattern).
 * Allocates context budgets across 4 tiers based on query word count, code/path anchors, and architectural intent.
 */
export function allocateDynamicWorkspaceBudget(
  query: string,
  baseMaxContextChars: number = 60_000,
): DynamicTokenBudgetAllocation {
  const trimmed = query.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/u).length : 0;
  const hasCodeOrPathAnchor =
    /[a-zA-Z0-9_-]+\.(ts|tsx|js|py|sql|md|json)|::|\/|[A-Z][a-z]+[A-Z][a-zA-Z]+/u.test(trimmed);
  const hasArchitecturalIntent =
    /(?:아키텍처|리팩터링|전체|비교|원인|분석|설계|마이그레이션|히스토리|이력|왜|architecture|refactor|root\s+cause|why|history|compare)/iu.test(
      trimmed,
    );

  // 1. Trivial greeting, short confirmation, single command
  if (wordCount <= 6 && !hasCodeOrPathAnchor && !hasArchitecturalIntent) {
    return {
      profile: "trivial",
      totalMaxChars: Math.min(12_000, baseMaxContextChars),
      hotDirectivesMaxChars: 3_000,
      warmMemoryMaxChars: 0,
      semanticRagMaxChars: 0,
      recentHistoryMaxChars: 2_500,
      unmaskedRecentToolCalls: 1,
    };
  }

  // 2. Focused file/symbol lookup
  if (hasCodeOrPathAnchor && !hasArchitecturalIntent) {
    return {
      profile: "focused-lookup",
      totalMaxChars: Math.min(36_000, baseMaxContextChars),
      hotDirectivesMaxChars: 3_000,
      warmMemoryMaxChars: 5_000,
      semanticRagMaxChars: 18_000,
      recentHistoryMaxChars: 8_000,
      unmaskedRecentToolCalls: 3,
    };
  }

  // 3. Deep architectural / multi-hop / debugging query
  if (hasArchitecturalIntent || wordCount >= 35) {
    return {
      profile: "deep-architectural",
      totalMaxChars: baseMaxContextChars,
      hotDirectivesMaxChars: 4_000,
      warmMemoryMaxChars: 14_000,
      semanticRagMaxChars: 26_000,
      recentHistoryMaxChars: 16_000,
      unmaskedRecentToolCalls: 5,
    };
  }

  // 4. Standard development dialogue
  return {
    profile: "standard-dev",
    totalMaxChars: Math.min(44_000, baseMaxContextChars),
    hotDirectivesMaxChars: 3_000,
    warmMemoryMaxChars: 8_000,
    semanticRagMaxChars: 16_000,
    recentHistoryMaxChars: 12_000,
    unmaskedRecentToolCalls: 3,
  };
}

const QUESTION_ANSWER_PREFIX_PATTERN =
  /^(?:User answers to the questions you asked:|사용자가 질문에 답변했습니다|답변:|선택:)/iu;
const MEMORY_OR_DOCS_LOOKUP_PATTERN =
  /(?:기억|메모리|지침|이전\s*대화|히스토리|이력|첨부|문서|pdf|docx|pptx|xlsx|보고서|파일\s*내용|memory|remember|directive|attachment|document|history|previous\s+conversation)/iu;
const SHORT_FOLLOWUP_CONTINUATION_PATTERN =
  /^(?:보고|중간\s*보고|현재\s*(?:상황|상태|중간\s*보고)|계속|진행|진행해\s*줘?|진행해|해\s*줘?|해줘|해봐|응|네|예|ㅇㅇ|좋아|오케이|ok|okay|yes|go|go\s*ahead|continue|proceed|status|report|update|done|확인|알겠어|알았어|고마워|감사|다음|ㄱㄱ|시작|실행해\s*줘?|실행해|적용해\s*줘?|적용해|반영해\s*줘?|반영해|재시작해\s*줘?|재시작해|테스트해\s*줘?|테스트해)[.!?~\s]*$/iu;

/**
 * Returns true when a turn in an already-active native session (`hasNativeHistory === true`)
 * is a lightweight continuation (short status/proceed command or structured Q&A reply)
 * that does not request cross-thread memory/document lookup. Skipping redundant RAG and
 * workspace memory re-injection on these turns cuts 70-90% of input token overhead.
 */
export function isLightweightNativeFollowup(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return true;
  if (MEMORY_OR_DOCS_LOOKUP_PATTERN.test(trimmed)) return false;
  if (SHORT_FOLLOWUP_CONTINUATION_PATTERN.test(trimmed)) return true;
  if (QUESTION_ANSWER_PREFIX_PATTERN.test(trimmed) && trimmed.length <= 1_500) {
    return true;
  }
  const budget = allocateDynamicWorkspaceBudget(trimmed, 16_000);
  return budget.profile === "trivial" && trimmed.length <= 80;
}

/**
 * Returns true when a follow-up turn without new file attachments explicitly asks
 * about previously attached documents/PDFs/reports and therefore still benefits from
 * historical attachment RAG search.
 */
export function mentionsAttachmentDocumentQuery(query: string): boolean {
  return /(?:첨부|문서|pdf|docx|pptx|xlsx|csv|보고서|자료|이미지|스크린샷|슬라이드|attachment|document|report|slide|screenshot)/iu.test(
    query,
  );
}

export interface AdaptiveMemoryBudget {
  readonly tier: "short" | "standard" | "deep";
  readonly maxRecentHistoryChars: number;
  readonly maxMemoryEvidenceChars: number;
  readonly maxMemoryItems: number;
  readonly compactToolOutputsOlderThanTurns: number;
}

/**
 * 3-tier adaptive context budget for `WorkspaceMemory.promptContext`:
 * - Short conversational queries: 6.6 KB (4.2 KB history + 2.4 KB memory, max 2 items) — 78% reduction vs 30 KB fixed cap.
 * - Standard coding/verification queries: 15 KB (9 KB history + 6 KB memory, max 4 items).
 * - Deep architectural / analysis / multi-agent queries: 30 KB (16 KB history + 14 KB memory, max 6 items).
 */
export function resolveAdaptiveMemoryBudget(
  userQuery: string,
  hasActiveToolChain: boolean = false,
): AdaptiveMemoryBudget {
  const normalized = userQuery.trim();
  const hasDeepIntent =
    /(?:아키텍처|전체|마스터|회의|다자간|포트폴리오|마이그레이션|설계|리팩터링|리팩토링|비교|분석|보고서|원인|architecture|refactor|migration|compare|root\s+cause)/iu.test(
      normalized,
    );
  const hasCodeOrPathAnchor =
    /[a-zA-Z0-9_-]+\.(ts|tsx|js|py|sql|md|json)|::|\/|[A-Z][a-z]+[A-Z][a-zA-Z]+/u.test(normalized);

  if (hasDeepIntent || normalized.length > 400) {
    return {
      tier: "deep",
      maxRecentHistoryChars: 16_000,
      maxMemoryEvidenceChars: 14_000,
      maxMemoryItems: 6,
      compactToolOutputsOlderThanTurns: 3,
    };
  }

  if (normalized.length < 80 && !hasActiveToolChain && !hasCodeOrPathAnchor) {
    return {
      tier: "short",
      maxRecentHistoryChars: 4_200,
      maxMemoryEvidenceChars: 2_400,
      maxMemoryItems: 2,
      compactToolOutputsOlderThanTurns: 1,
    };
  }

  return {
    tier: "standard",
    maxRecentHistoryChars: 9_000,
    maxMemoryEvidenceChars: 6_000,
    maxMemoryItems: 4,
    compactToolOutputsOlderThanTurns: 2,
  };
}

export interface ConversationTurnPayload {
  id: string;
  role: "user" | "assistant" | "tool";
  toolName?: string;
  toolArgsSummary?: string;
  content: string;
  createdAt: number;
}

/**
 * JetBrains Junie Observation Masking + ACON Verbatim Line Compaction:
 * - Preserves the last `unmaskedRecentToolCalls` tool outputs verbatim.
 * - Replaces older tool outputs (>320 bytes) with a signature placeholder while retaining up to 5 verbatim error/diagnostic lines.
 */
export function compactConversationHistoryWithMasking(
  turns: readonly ConversationTurnPayload[],
  unmaskedRecentToolCalls: number = 3,
): ConversationTurnPayload[] {
  let toolCallSeenFromEnd = 0;
  const compacted = [...turns];

  for (let i = compacted.length - 1; i >= 0; i--) {
    const turn = compacted[i]!;
    if (turn.role !== "tool") continue;

    toolCallSeenFromEnd++;
    const originalByteLen = Buffer.byteLength(turn.content, "utf8");

    if (toolCallSeenFromEnd > unmaskedRecentToolCalls && originalByteLen > 320) {
      const digest = NodeCrypto.createHash("sha256")
        .update(turn.content)
        .digest("hex")
        .slice(0, 12);
      const nonEmptyLines = turn.content
        .split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
      const errorLines = nonEmptyLines
        .filter((line) =>
          /(?:error|exception|fail|ENOENT|ECONNREFUSED|at\s+[^\s]+\s+\([^)]+:\d+:\d+\))/iu.test(
            line,
          ),
        )
        .slice(0, 5);
      const summaryLines =
        errorLines.length > 0
          ? errorLines
          : nonEmptyLines
              .slice(0, 3)
              .map((line) => (line.length > 160 ? `${line.slice(0, 157)}...` : line));

      const preservedSnippet =
        errorLines.length > 0
          ? `\nPreserved verbatim diagnostics:\n${errorLines.join("\n")}`
          : summaryLines.length > 0
            ? `\nSummary:\n${summaryLines.join("\n")}`
            : "";

      compacted[i] = {
        ...turn,
        content: `[Tool Output Compacted: sha256:${digest} | masked tool output from ${turn.toolName ?? "tool"}(${turn.toolArgsSummary ?? ""}) — ${originalByteLen} bytes freed; re-run tool if full content is needed]${preservedSnippet}`,
      };
    }
  }

  return compacted;
}

let counterPromise: Promise<WorkspaceTokenCounter> | undefined;

/** Load the reference vocabulary on first use. Cache hashes/counts, never retained prompt text. */
export function loadWorkspaceTokenCounter(): Promise<WorkspaceTokenCounter> {
  counterPromise ??= import("gpt-tokenizer/encoding/o200k_base")
    .then(({ countTokens, setMergeCacheSize }) => {
      setMergeCacheSize(4096);
      const cache = new Map<string, number>();
      const options = { disallowedSpecial: new Set<string>() };
      return (text: string) => {
        const key = NodeCrypto.createHash("sha256").update(text).digest("hex");
        const cached = cache.get(key);
        if (cached !== undefined) {
          cache.delete(key);
          cache.set(key, cached);
          return cached;
        }
        const count = countTokens(text, options);
        cache.set(key, count);
        if (cache.size > 512) cache.delete(cache.keys().next().value!);
        return count;
      };
    })
    .catch((cause: unknown) => {
      counterPromise = undefined;
      throw cause;
    });
  return counterPromise;
}

/** Recompose whole optional evidence units, then verify the complete serialized prompt. */
export function composeWithTokenBudget(
  request: WorkspacePromptComposeInput,
  counter: WorkspaceTokenCounter | undefined,
  compose: (budgetChars: number) => WorkspacePromptParts,
  requiredSuffix = "",
): WorkspacePromptComposeResult {
  const composeComplete = (budget: number): WorkspacePromptParts => {
    const parts = compose(budget);
    if (!requiredSuffix) return parts;
    const prompt = parts.result.prompt + requiredSuffix;
    return {
      ...parts,
      result: {
        ...parts.result,
        prompt,
        ...(parts.result.diagnostics
          ? {
              diagnostics: {
                ...parts.result.diagnostics,
                promptChars: prompt.length,
                contextRevision: NodeCrypto.createHash("sha256").update(prompt).digest("hex"),
              },
            }
          : {}),
      },
    };
  };
  const budgetChars = request.maxContextChars ?? 60_000;
  const limit = request.maxContextTokens ?? null;
  if (!counter) {
    if (limit !== null) throw new Error("문맥 토큰 예산을 확인할 토크나이저를 사용할 수 없습니다.");
    return composeComplete(budgetChars).result;
  }
  let selected = composeComplete(budgetChars);
  let total = counter(selected.result.prompt);
  if (limit !== null && total > limit) {
    const minimum = composeComplete(0);
    const minimumTokens = counter(minimum.result.prompt);
    if (minimumTokens >= limit) {
      selected = minimum;
      total = minimumTokens;
    } else {
      let low = 0;
      let high = budgetChars;
      selected = minimum;
      total = minimumTokens;
      // Selection is discrete; always retain a measured fitting result even if BPE boundaries
      // make counts non-monotone. Bounded work also limits latency on very large memories.
      for (let attempt = 0; attempt < 12 && high - low > 1; attempt++) {
        const middle = Math.floor((low + high) / 2);
        const candidate = composeComplete(middle);
        const count = counter(candidate.result.prompt);
        if (count <= limit) {
          selected = candidate;
          total = count;
          low = middle;
        } else {
          high = middle;
        }
      }
    }
  }
  return {
    ...selected.result,
    tokenEstimate: {
      version: 1,
      status: "estimated",
      scope: "workspace-prompt",
      encoding: "o200k_base",
      total,
      limit,
      mandatoryOverflow: limit === null ? 0 : Math.max(0, total - limit),
      sections: {
        task: counter(selected.sections.task),
        instructions: counter(selected.sections.instructions),
        memory: counter(selected.sections.memory),
        library: counter(selected.sections.library),
      },
    },
  };
}
