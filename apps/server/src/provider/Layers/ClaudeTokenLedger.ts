import type { ModelUsage, SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import {
  type ModelSelection,
  type RuntimeTaskUsage,
  ThreadId,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import { resolveClaudeContextWindow } from "./ClaudeProvider.ts";

export interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

export type ClaudeContextWindowSource = "catalog" | "context_usage_api" | "model_usage_result";

const CONTEXT_WINDOW_SOURCE_PRIORITY: Record<ClaudeContextWindowSource, number> = {
  catalog: 1,
  context_usage_api: 2,
  model_usage_result: 3,
};

/**
 * Wave 2-B4: Resolves authoritative context window with strict source precedence:
 * `model_usage_result` (API response) > `context_usage_api` > `catalog` (local guess).
 * Lower-precedence sources can never downgrade an already-confirmed window (e.g. 1M -> 200k).
 */
export function resolveAuthoritativeContextWindow(input: {
  readonly currentWindow: number | undefined;
  readonly currentSource: ClaudeContextWindowSource | undefined;
  readonly incomingWindow: number | undefined;
  readonly incomingSource: ClaudeContextWindowSource;
}): {
  readonly window: number | undefined;
  readonly source: ClaudeContextWindowSource | undefined;
} {
  const incoming = finitePositiveInteger(input.incomingWindow);
  if (incoming === undefined) {
    return { window: input.currentWindow, source: input.currentSource };
  }
  const current = finitePositiveInteger(input.currentWindow);
  if (current === undefined || input.currentSource === undefined) {
    return { window: incoming, source: input.incomingSource };
  }
  const currentRank = CONTEXT_WINDOW_SOURCE_PRIORITY[input.currentSource];
  const incomingRank = CONTEXT_WINDOW_SOURCE_PRIORITY[input.incomingSource];
  if (incomingRank < currentRank) {
    return { window: current, source: input.currentSource };
  }
  return { window: incoming, source: input.incomingSource };
}

/**
 * Wave 2-B3: Builds official Claude Agent SDK prompt cache TTL environment variables
 * (`CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`) from
 * server settings without overriding explicit user environment variables.
 */
export function resolveClaudePromptCacheTtlEnv(
  settings: {
    readonly promptCacheTtl?: "inherit" | "5m" | "1h" | undefined;
    readonly subagentPromptCacheTtl?: "inherit" | "5m" | "1h" | undefined;
  },
  baseEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (
    settings.promptCacheTtl &&
    settings.promptCacheTtl !== "inherit" &&
    !baseEnv.CLAUDE_CODE_PROMPT_CACHE_TTL
  ) {
    env.CLAUDE_CODE_PROMPT_CACHE_TTL = settings.promptCacheTtl;
  }
  if (
    settings.subagentPromptCacheTtl &&
    settings.subagentPromptCacheTtl !== "inherit" &&
    !baseEnv.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL
  ) {
    env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = settings.subagentPromptCacheTtl;
  }
  return env;
}

export function maxClaudeContextWindowFromModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage)) {
    const contextWindow = value.contextWindow;
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

export function selectedClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
): number | undefined {
  switch (modelSelection?.model) {
    case "claude-opus-4-8":
    case "claude-opus-4-7":
      // Always 1M at the API; these models expose no contextWindow option.
      return 1_000_000;
  }

  switch (resolveClaudeContextWindow(modelSelection)) {
    case "1m":
      return 1_000_000;
    case "200k":
      return 200_000;
    default:
      return undefined;
  }
}

export function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function finitePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

export function claudeUsageInputTokens(usage: Record<string, unknown>): number {
  return (
    (finiteNonNegativeInteger(usage.input_tokens) ?? 0) +
    (finiteNonNegativeInteger(usage.cache_creation_input_tokens) ?? 0) +
    (finiteNonNegativeInteger(usage.cache_read_input_tokens) ?? 0)
  );
}

export function claudeUsageOutputTokens(usage: Record<string, unknown>): number {
  return finiteNonNegativeInteger(usage.output_tokens) ?? 0;
}

export function lastClaudeUsageIteration(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const iterations = Array.isArray(value.iterations) ? value.iterations : [];
  return iterations.findLast(
    (iteration): iteration is Record<string, unknown> =>
      iteration !== null && typeof iteration === "object" && !Array.isArray(iteration),
  );
}

export function claudeTotalProcessedTokens(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const explicitTotal = finiteNonNegativeInteger(usage.total_tokens);
  if (explicitTotal !== undefined && explicitTotal > 0) {
    return explicitTotal;
  }

  const total = claudeUsageInputTokens(usage) + claudeUsageOutputTokens(usage);
  return total > 0 ? total : undefined;
}

export function makeClaudeTokenUsageSnapshot(input: {
  readonly activeTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly contextWindow?: number;
  readonly totalProcessedTokens?: number;
  readonly lastUsedTokens?: number;
  readonly compactsAutomatically?: boolean;
}): ThreadTokenUsageSnapshot | undefined {
  const activeTokens = finiteNonNegativeInteger(input.activeTokens);
  if (activeTokens === undefined || activeTokens <= 0) {
    return undefined;
  }

  const rawMaxTokens = finitePositiveInteger(input.contextWindow);
  // Wave 2-B4: Never clamp real token usage down to a stale/lower maxTokens guess (e.g. 262k -> 200k).
  // If observed activeTokens already exceeds rawMaxTokens, omit the stale maxTokens bound
  // rather than showing a false 100% / 200k ceiling.
  const usedTokens = activeTokens;
  const lastUsedTokens = finiteNonNegativeInteger(input.lastUsedTokens) ?? activeTokens;
  const maxTokens =
    rawMaxTokens !== undefined && activeTokens > rawMaxTokens ? undefined : rawMaxTokens;
  const totalProcessedTokens = finiteNonNegativeInteger(input.totalProcessedTokens);
  const inputTokens = finiteNonNegativeInteger(input.inputTokens);
  const outputTokens = finiteNonNegativeInteger(input.outputTokens);

  return {
    usedTokens,
    lastUsedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input.compactsAutomatically !== undefined
      ? { compactsAutomatically: input.compactsAutomatically }
      : {}),
  };
}

export function normalizeClaudeActiveTokenUsage(
  value: unknown,
  contextWindow?: number,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const activeUsage = lastClaudeUsageIteration(usage) ?? usage;
  const inputTokens = claudeUsageInputTokens(activeUsage);
  const outputTokens = claudeUsageOutputTokens(activeUsage);
  const activeTokens = claudeTotalProcessedTokens(activeUsage) ?? inputTokens + outputTokens;
  if (activeTokens <= 0) {
    return undefined;
  }

  return makeClaudeTokenUsageSnapshot({
    activeTokens,
    inputTokens,
    outputTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
  });
}

export function normalizeClaudeContextUsageApiSnapshot(
  value: SDKControlGetContextUsageResponse,
  totalProcessedTokens?: number,
  authoritativeContextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  const effectiveWindow =
    authoritativeContextWindow !== undefined && authoritativeContextWindow > value.maxTokens
      ? authoritativeContextWindow
      : value.maxTokens;
  return makeClaudeTokenUsageSnapshot({
    activeTokens: value.totalTokens,
    contextWindow: effectiveWindow,
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
    compactsAutomatically: value.isAutoCompactEnabled,
  });
}

export function compactBoundaryTokenUsageSnapshot(
  message: Record<string, unknown>,
  contextWindow?: number,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot | undefined {
  const metadata = message.compact_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const compactMetadata = metadata as Record<string, unknown>;
  const postTokens = finiteNonNegativeInteger(compactMetadata.post_tokens);
  if (postTokens === undefined || postTokens <= 0) {
    return undefined;
  }

  const preTokens = finiteNonNegativeInteger(compactMetadata.pre_tokens);
  return makeClaudeTokenUsageSnapshot({
    activeTokens: postTokens,
    ...(preTokens !== undefined ? { lastUsedTokens: preTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
  });
}

export function normalizeClaudeTaskProgressTokenUsage(
  value: unknown,
  context: {
    readonly lastKnownTokenUsage?: ThreadTokenUsageSnapshot | undefined;
    readonly lastKnownContextWindow?: number | undefined;
    readonly lastKnownTotalProcessedTokens?: number | undefined;
  },
): ThreadTokenUsageSnapshot | undefined {
  const totalTokens = claudeTotalProcessedTokens(value);
  if (totalTokens === undefined || totalTokens <= 0) {
    return undefined;
  }

  const lastUsedTokens = context.lastKnownTokenUsage?.usedTokens;
  const activeTokens =
    lastUsedTokens !== undefined ? Math.max(totalTokens, lastUsedTokens) : totalTokens;
  if (lastUsedTokens !== undefined && activeTokens === lastUsedTokens) {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const snapshot = makeClaudeTokenUsageSnapshot({
    activeTokens,
    ...(context.lastKnownContextWindow !== undefined
      ? { contextWindow: context.lastKnownContextWindow }
      : {}),
    totalProcessedTokens: Math.max(
      totalTokens,
      context.lastKnownTotalProcessedTokens ?? totalTokens,
    ),
  });
  if (!snapshot) {
    return undefined;
  }

  const toolUses = finiteNonNegativeInteger(usage.tool_uses);
  const durationMs = finiteNonNegativeInteger(usage.duration_ms);
  return {
    ...snapshot,
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.make(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

export function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * SDK task usage ({total_tokens, tool_uses, duration_ms}, sometimes with
 * input/output/cache breakdowns) → the typed contract shape. Unknown or
 * malformed input yields undefined rather than a partial guess.
 */
export function normalizeTaskUsage(usage: unknown): RuntimeTaskUsage | undefined {
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const totalTokens = nonNegativeInt(record.total_tokens);
  if (totalTokens === undefined) {
    return undefined;
  }
  const inputTokens = nonNegativeInt(record.input_tokens);
  const cachedInputTokens = nonNegativeInt(record.cache_read_input_tokens);
  const outputTokens = nonNegativeInt(record.output_tokens);
  const toolUses = nonNegativeInt(record.tool_uses);
  const durationMs = nonNegativeInt(record.duration_ms);
  return {
    totalTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
