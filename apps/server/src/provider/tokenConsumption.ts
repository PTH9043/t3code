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

const ClaudeModelUsageEntry = Schema.Struct({
  inputTokens: Count,
  outputTokens: Count,
  cacheReadInputTokens: Count,
  cacheCreationInputTokens: Count,
  canonicalModel: Schema.optional(Schema.String),
});
const decodeClaudeModelUsageResult = Schema.decodeUnknownOption(
  Schema.Struct({
    is_error: Schema.optional(Schema.Boolean),
    uuid: Schema.String,
    session_id: Schema.String,
    modelUsage: Schema.Record(Schema.String, ClaudeModelUsageEntry),
  }),
);

/**
 * Running `modelUsage` totals last seen from one Claude `query()` process, keyed
 * by the SDK's model key. Create one per query: the SDK restarts these totals on
 * every new process (including resume), so the ledger must not outlive it.
 */
export type ClaudeModelUsageLedger = Map<string, TokenCounts>;

export const makeClaudeModelUsageLedger = (): ClaudeModelUsageLedger => new Map();

const CLAUDE_LEDGER_KEYS = ["total", "input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * `ResultMessage.usage` covers the main agent loop only, so a turn that delegates
 * to Task subagents (a conductor handing work to a worker) under-reports. The
 * result's `modelUsage` covers main loop, subagents and compaction per model, but
 * as running totals for the process. Turn them into per-turn, per-model spend by
 * diffing against the ledger. Returns undefined when `modelUsage` is unusable so
 * the caller can fall back to the main-loop usage.
 */
function claudeModelUsageConsumption(
  result: unknown,
  ledger: ClaudeModelUsageLedger,
): TokenUsageObservation[] | undefined {
  const decoded = decodeClaudeModelUsageResult(result);
  if (Option.isNone(decoded)) return undefined;
  const { uuid, session_id, modelUsage, is_error } = decoded.value;
  if (!uuid || !session_id) return undefined;
  const current = new Map<string, { readonly counts: TokenCounts; readonly model: string }>();
  for (const key of Object.keys(modelUsage).toSorted()) {
    const entry = modelUsage[key];
    if (!entry || key.trim().length === 0) continue;
    const input = entry.inputTokens + entry.cacheReadInputTokens + entry.cacheCreationInputTokens;
    const total = input + entry.outputTokens;
    if (!Number.isSafeInteger(total)) return undefined;
    current.set(key, {
      counts: {
        total,
        input,
        output: entry.outputTokens,
        cacheRead: entry.cacheReadInputTokens,
        cacheWrite: entry.cacheCreationInputTokens,
        reasoning: null,
      },
      model: entry.canonicalModel?.trim() || key,
    });
  }
  if (current.size === 0) return undefined;
  // A crashed SDK session can emit an error result with zeroed totals; that is
  // neither spend nor a counter reset, so leave the ledger alone.
  const zeroed = [...current.values()].every(({ counts }) => counts.total === 0);
  if (zeroed && is_error !== false) return [];
  // `/clear` and similar restarts reset the running totals. Any counter moving
  // backwards, or a model dropping out, means a new baseline at zero.
  const reset = [...ledger].some(([key, previous]) => {
    const next = current.get(key)?.counts;
    return !next || CLAUDE_LEDGER_KEYS.some((field) => (next[field] ?? 0) < (previous[field] ?? 0));
  });
  if (reset) ledger.clear();
  const observations: TokenUsageObservation[] = [];
  for (const [key, { counts, model }] of current) {
    const previous = ledger.get(key);
    ledger.set(key, counts);
    const delta: TokenCounts = previous
      ? {
          total: (counts.total ?? 0) - (previous.total ?? 0),
          input: (counts.input ?? 0) - (previous.input ?? 0),
          output: (counts.output ?? 0) - (previous.output ?? 0),
          cacheRead: (counts.cacheRead ?? 0) - (previous.cacheRead ?? 0),
          cacheWrite: (counts.cacheWrite ?? 0) - (previous.cacheWrite ?? 0),
          reasoning: null,
        }
      : counts;
    if (delta.total === 0) continue;
    observations.push({
      sourceId: `claude:${session_id}:${uuid}:${key}`,
      mode: "execution-total",
      provider: "claude",
      model,
      counts: delta,
      isFinal: true,
      includesNativeChildren: true,
    });
  }
  return observations;
}

export function serializeClaudeModelUsageLedger(
  ledger: ClaudeModelUsageLedger,
): Record<string, TokenCounts> {
  return Object.fromEntries(ledger.entries());
}

export function restoreClaudeModelUsageLedger(raw: unknown): ClaudeModelUsageLedger {
  const ledger = makeClaudeModelUsageLedger();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ledger;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const rec = value as Record<string, unknown>;
    const total =
      typeof rec.total === "number" && Number.isSafeInteger(rec.total) && rec.total >= 0
        ? rec.total
        : null;
    const input =
      typeof rec.input === "number" && Number.isSafeInteger(rec.input) && rec.input >= 0
        ? rec.input
        : null;
    const output =
      typeof rec.output === "number" && Number.isSafeInteger(rec.output) && rec.output >= 0
        ? rec.output
        : null;
    const cacheRead =
      typeof rec.cacheRead === "number" && Number.isSafeInteger(rec.cacheRead) && rec.cacheRead >= 0
        ? rec.cacheRead
        : null;
    const cacheWrite =
      typeof rec.cacheWrite === "number" &&
      Number.isSafeInteger(rec.cacheWrite) &&
      rec.cacheWrite >= 0
        ? rec.cacheWrite
        : null;
    if (total === null || input === null || output === null) continue;
    ledger.set(key, {
      total,
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning: null,
    });
  }
  return ledger;
}

export interface ClaudeTokenConsumptionOptions {
  /**
   * True when this Claude CLI process was started with `--resume`. On the first
   * turn of a resumed process where the ledger is still empty (e.g. legacy cursor
   * saved before ledger persistence), Claude's `modelUsage` carries cumulative
   * session totals from prior processes. Seed the ledger without booking the
   * cumulative history as this turn's delta, and use single-turn `ResultMessage.usage`.
   */
  readonly resumedSession?: boolean;
}

/**
 * With a ledger, Claude spend comes from `modelUsage` (main loop + subagents, per
 * model). Without one, or when `modelUsage` is unusable, ResultMessage.usage is a
 * main-loop turn result, not the context snapshot or modelUsage session totals.
 */
export function claudeTokenConsumption(
  result: unknown,
  ledger?: ClaudeModelUsageLedger,
  options?: ClaudeTokenConsumptionOptions,
): TokenUsageObservation[] {
  if (ledger) {
    const ledgerWasEmpty = ledger.size === 0;
    const perModel = claudeModelUsageConsumption(result, ledger);
    if (ledgerWasEmpty && options?.resumedSession === true) {
      // Ledger has now been seeded with the resumed session's cumulative baseline.
      // Report only this single turn's main-loop usage so historical totals (and
      // dormant helper models like haiku from earlier turns) are never double-counted.
      return claudeMainLoopConsumption(result);
    }
    if (perModel !== undefined && perModel.length > 0) return perModel;
    if (perModel !== undefined) {
      // modelUsage moved nothing: only a measured zero turn may still be reported,
      // otherwise main-loop usage would be counted again on the next delta.
      return claudeMainLoopConsumption(result).filter(
        (observation) => observation.counts.total === 0,
      );
    }
  }
  return claudeMainLoopConsumption(result);
}

function claudeMainLoopConsumption(result: unknown): TokenUsageObservation[] {
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

/**
 * Only prompt-result usage is consumption; ACP usage_update is context occupancy.
 * Supports both inclusive-input ACP providers (`total === input + output` with
 * cache subsets inside `input`) and Antigravity's exclusive-cache reporting
 * (`total === input + cachedRead + cachedWrite + output`, matching Claude/OpenCode).
 */
export function acpPromptTokenConsumption(input: {
  provider: "gemini" | "cursor";
  requestId: string;
  model: string | null;
  result: unknown;
}): TokenUsageObservation[] {
  const decoded = decodeAcpPromptResult(input.result);
  if (Option.isNone(decoded)) return [];
  const { stopReason, usage: c } = decoded.value;
  if (c.totalTokens === 0 && stopReason !== "end_turn") return [];

  const cacheRead = c.cachedReadTokens ?? 0;
  const cacheWrite = c.cachedWriteTokens ?? 0;
  const cacheTotal = cacheRead + cacheWrite;
  const thought = c.thoughtTokens ?? 0;

  let totalInput: number;
  let totalOutput: number;
  if (
    c.totalTokens === c.inputTokens + c.outputTokens &&
    cacheTotal <= c.inputTokens &&
    thought <= c.outputTokens
  ) {
    totalInput = c.inputTokens;
    totalOutput = c.outputTokens;
  } else if (
    cacheTotal > 0 &&
    c.totalTokens === c.inputTokens + cacheTotal + c.outputTokens &&
    thought <= c.outputTokens
  ) {
    totalInput = c.inputTokens + cacheTotal;
    totalOutput = c.outputTokens;
  } else if (
    thought > 0 &&
    c.totalTokens === c.inputTokens + c.outputTokens + thought &&
    cacheTotal <= c.inputTokens
  ) {
    totalInput = c.inputTokens;
    totalOutput = c.outputTokens + thought;
  } else if (
    cacheTotal > 0 &&
    thought > 0 &&
    c.totalTokens === c.inputTokens + cacheTotal + c.outputTokens + thought
  ) {
    totalInput = c.inputTokens + cacheTotal;
    totalOutput = c.outputTokens + thought;
  } else {
    return [];
  }

  if (!Number.isSafeInteger(totalInput) || !Number.isSafeInteger(totalOutput)) return [];

  return [
    {
      sourceId: JSON.stringify([input.provider, "acp", input.requestId]),
      mode: "execution-total",
      provider: input.provider,
      model: input.model,
      counts: {
        total: c.totalTokens,
        input: totalInput,
        output: totalOutput,
        cacheRead: c.cachedReadTokens ?? null,
        cacheWrite: c.cachedWriteTokens ?? null,
        reasoning: c.thoughtTokens ?? null,
      },
      isFinal: stopReason === "end_turn",
    },
  ];
}

/**
 * Korean/code-aware deterministic token estimator for providers that do not emit
 * native token telemetry (`muse`, `museCloud`, or `unreported` ACP/CLI turns).
 * Hangul syllables average ~0.62 tok/char under BPE; ASCII code averages ~0.28 tok/char.
 */
export function estimateWeightedTokenCount(text: string): number {
  if (!text) return 0;
  let hangul = 0;
  let whitespace = 0;
  let other = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x3131 && code <= 0x318e) ||
      (code >= 0x4e00 && code <= 0x9fff)
    ) {
      hangul += 1;
    } else if (code === 32 || code === 10 || code === 13 || code === 9) {
      whitespace += 1;
    } else {
      other += 1;
    }
  }
  return Math.max(1, Math.ceil(hangul * 0.62 + other * 0.28 + whitespace * 0.22));
}

export function estimatedTurnTokenConsumption(input: {
  readonly provider: TokenUsageObservation["provider"];
  readonly requestId: string;
  readonly model: string | null;
  readonly inputText: string;
  readonly outputText: string;
}): TokenUsageObservation {
  const inputTokens = estimateWeightedTokenCount(input.inputText);
  const outputTokens = estimateWeightedTokenCount(input.outputText);
  return {
    sourceId: JSON.stringify(["estimated", input.provider, input.requestId]),
    mode: "execution-total",
    provider: input.provider,
    model: input.model,
    counts: {
      total: inputTokens + outputTokens,
      input: inputTokens,
      output: outputTokens,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
    },
    isFinal: true,
  };
}
