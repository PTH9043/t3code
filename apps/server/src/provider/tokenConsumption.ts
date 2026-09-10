import { NonNegativeInt, TokenUsageObservation, type TokenCounts } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Count = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const CodexTotal = Schema.Struct({
  totalTokens: Count,
  inputTokens: Count,
  outputTokens: Count,
  cachedInputTokens: Count,
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
  }),
});

const decodeCodexTotal = Schema.decodeUnknownOption(CodexTotal);
const decodeClaudeResult = Schema.decodeUnknownOption(ClaudeResult);

export function codexTokenConsumption(
  nativeThreadId: string,
  total: unknown,
): TokenUsageObservation[] {
  const decoded = decodeCodexTotal(total);
  if (Option.isNone(decoded)) return [];
  const c = decoded.value;
  if (
    c.cachedInputTokens > c.inputTokens ||
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
        cacheWrite: null,
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
  const counts: TokenCounts = {
    total: input + c.output_tokens,
    input,
    output: c.output_tokens,
    cacheRead: c.cache_read_input_tokens,
    cacheWrite: c.cache_creation_input_tokens,
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
