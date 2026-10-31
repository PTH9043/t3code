import { NonNegativeInt, TokenUsageObservation, type TokenCounts } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Count = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const CodexTotal = Schema.Struct({
  totalTokens: Count,
  inputTokens: Count,
  outputTokens: Count,
  cachedInputTokens: Count,
  cacheWriteInputTokens: Schema.optional(Count),
  reasoningOutputTokens: Count,
});
const ClaudeResult = Schema.Struct({
  is_error: Schema.optional(Schema.Boolean),
  uuid: Schema.String,
  session_id: Schema.String,
  usage: Schema.Struct({
    input_tokens: Count,
    output_tokens: Count,
    cache_read_input_tokens: Count,
    cache_creation_input_tokens: Count,
    cache_creation: Schema.optional(Schema.Unknown),
  }),
});

const decodeCodexTotal = Schema.decodeUnknownOption(CodexTotal);
const decodeClaudeResult = Schema.decodeUnknownOption(ClaudeResult);
const decodeClaudeCacheTtl = Schema.decodeUnknownOption(
  Schema.Struct({
    ephemeral_5m_input_tokens: Schema.optional(Count),
    ephemeral_1h_input_tokens: Schema.optional(Count),
  }),
);

export function codexTokenConsumption(
  nativeThreadId: string,
  total: unknown,
): TokenUsageObservation[] {
  const decoded = decodeCodexTotal(total);
  if (Option.isNone(decoded)) return [];
  const c = decoded.value;
  if (
    c.cachedInputTokens + (c.cacheWriteInputTokens ?? 0) > c.inputTokens ||
    c.reasoningOutputTokens > c.outputTokens ||
    c.totalTokens !== c.inputTokens + c.outputTokens
  )
    return [];
  return [
    {
      sourceId: `codex:${nativeThreadId}`,
      mode: "cumulative",
      provider: "codex",
      model: null,
      counts: {
        total: c.totalTokens,
        input: c.inputTokens,
        output: c.outputTokens,
        cacheRead: c.cachedInputTokens,
        cacheWrite: c.cacheWriteInputTokens ?? null,
        reasoning: c.reasoningOutputTokens,
      },
    },
  ];
}

/** ResultMessage.usage is a turn result, not the context snapshot or modelUsage session totals. */
export function claudeTokenConsumption(result: unknown): TokenUsageObservation[] {
  const decoded = decodeClaudeResult(result);
  if (Option.isNone(decoded)) return [];
  const { uuid, session_id, usage: c } = decoded.value;
  if (!uuid || !session_id) return [];
  const input = c.input_tokens + c.cache_read_input_tokens + c.cache_creation_input_tokens;
  // A crashed SDK session can emit an error result with zeroed usage.
  if (input + c.output_tokens === 0 && decoded.value.is_error !== false) return [];
  if (!Number.isSafeInteger(input + c.output_tokens)) return [];
  const ttl = Option.getOrUndefined(decodeClaudeCacheTtl(c.cache_creation));
  const shortWrite = ttl?.ephemeral_5m_input_tokens;
  const longWrite = ttl?.ephemeral_1h_input_tokens;
  const validTtlCounts = (shortWrite ?? 0) + (longWrite ?? 0) <= c.cache_creation_input_tokens;
  const counts: TokenCounts = {
    total: input + c.output_tokens,
    input,
    output: c.output_tokens,
    cacheRead: c.cache_read_input_tokens,
    cacheWrite: c.cache_creation_input_tokens,
    ...(validTtlCounts && shortWrite !== undefined ? { cacheWrite5m: shortWrite } : {}),
    ...(validTtlCounts && longWrite !== undefined ? { cacheWrite1h: longWrite } : {}),
    reasoning: null,
  };
  return [
    {
      sourceId: `claude:${session_id}:${uuid}`,
      mode: "execution-total",
      provider: "claude",
      model: null,
      counts,
      isFinal: true,
    },
  ];
}

const decodeOpenCodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.NonEmptyString,
    sessionID: Schema.NonEmptyString,
    role: Schema.Literal("assistant"),
    providerID: Schema.NonEmptyString,
    modelID: Schema.NonEmptyString,
    time: Schema.Struct({ completed: Count }),
    tokens: Schema.Struct({
      total: Schema.optional(Count),
      input: Count,
      output: Count,
      reasoning: Count,
      cache: Schema.Struct({ read: Count, write: Count }),
    }),
  }),
);

/** OpenCode reports uncached input separately; reasoning is already part of output. */
export function openCodeTokenConsumption(message: unknown): TokenUsageObservation[] {
  const decoded = decodeOpenCodeMessage(message);
  if (Option.isNone(decoded)) return [];
  const { id, sessionID, providerID, modelID, tokens: c } = decoded.value;
  const input = c.input + c.cache.read + c.cache.write;
  const total = input + c.output;
  if (
    !Number.isSafeInteger(total) ||
    total === 0 ||
    c.reasoning > c.output ||
    (c.total !== undefined && c.total !== total)
  )
    return [];
  return [
    {
      sourceId: JSON.stringify(["opencode", sessionID, id]),
      mode: "execution-total",
      provider: "opencode",
      model: `${providerID}/${modelID}`,
      counts: {
        total,
        input,
        output: c.output,
        cacheRead: c.cache.read,
        cacheWrite: c.cache.write,
        reasoning: c.reasoning,
      },
      isFinal: true,
    },
  ];
}

const decodeAcpPromptResult = Schema.decodeUnknownOption(
  Schema.Struct({
    stopReason: Schema.String,
    usage: Schema.Struct({
      totalTokens: Count,
      inputTokens: Count,
      outputTokens: Count,
      cachedReadTokens: Schema.optional(Schema.NullOr(Count)),
      cachedWriteTokens: Schema.optional(Schema.NullOr(Count)),
      thoughtTokens: Schema.optional(Schema.NullOr(Count)),
    }),
  }),
);

/** Only prompt-result usage is consumption; ACP usage_update is context occupancy. */
export function acpPromptTokenConsumption(input: {
  provider: "gemini" | "cursor";
  requestId: string;
  model: string | null;
  result: unknown;
}): TokenUsageObservation[] {
  const decoded = decodeAcpPromptResult(input.result);
  if (Option.isNone(decoded)) return [];
  const { stopReason, usage: c } = decoded.value;
  if (
    c.totalTokens !== c.inputTokens + c.outputTokens ||
    (c.cachedReadTokens ?? 0) + (c.cachedWriteTokens ?? 0) > c.inputTokens ||
    (c.thoughtTokens ?? 0) > c.outputTokens ||
    (c.totalTokens === 0 && stopReason !== "end_turn")
  )
    return [];
  return [
    {
      sourceId: JSON.stringify([input.provider, "acp", input.requestId]),
      mode: "execution-total",
      provider: input.provider,
      model: input.model,
      counts: {
        total: c.totalTokens,
        input: c.inputTokens,
        output: c.outputTokens,
        cacheRead: c.cachedReadTokens ?? null,
        cacheWrite: c.cachedWriteTokens ?? null,
        reasoning: c.thoughtTokens ?? null,
      },
      isFinal: stopReason === "end_turn",
    },
  ];
}
