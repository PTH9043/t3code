import { TurnId, type TokenCounts, type TokenUsageObservation } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AcpProtocolLogEvent } from "effect-acp/protocol";

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const RpcId = Schema.Union([Schema.String, Count]);
const NativeCounts = Schema.Struct({
  inputTokens: Count,
  outputTokens: Count,
  totalTokens: Count,
  cachedReadTokens: Schema.optional(Count),
  cacheCreationTokens: Schema.optional(Count),
  reasoningTokens: Schema.optional(Count),
});
const NativeUsage = NativeCounts.mapFields((fields) => ({
  ...fields,
  modelUsage: Schema.optional(Schema.Record(Schema.String, NativeCounts)),
}));
export const GrokTurnCompletedNotification = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  update: Schema.Struct({
    sessionUpdate: Schema.Literal("turn_completed"),
    prompt_id: Schema.NonEmptyString,
    stop_reason: Schema.String,
    usage: NativeUsage,
  }),
});
const PromptResult = Schema.Struct({
  stopReason: Schema.String,
  _meta: Schema.Struct({
    sessionId: Schema.NonEmptyString,
    promptId: Schema.NonEmptyString,
    modelId: Schema.optional(Schema.NonEmptyString),
    usage: NativeUsage,
  }),
});
const Request = Schema.Struct({
  _tag: Schema.Literal("Request"),
  id: RpcId,
  tag: Schema.Literal("session/prompt"),
  payload: Schema.Struct({
    sessionId: Schema.NonEmptyString,
    _meta: Schema.Struct({ promptId: Schema.NonEmptyString }),
  }),
});
const Response = Schema.Struct({
  _tag: Schema.Literal("Exit"),
  requestId: RpcId,
  exit: Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.Unknown }),
});
const decodeResult = Schema.decodeUnknownOption(PromptResult);
const decodeRequest = Schema.decodeUnknownOption(Request);
const decodeResponse = Schema.decodeUnknownOption(Response);

const decodeCompletedNotification = Schema.decodeUnknownOption(GrokTurnCompletedNotification);

function counts(value: typeof NativeCounts.Type): TokenCounts | null {
  if (
    value.totalTokens !== value.inputTokens + value.outputTokens ||
    (value.cachedReadTokens ?? 0) + (value.cacheCreationTokens ?? 0) > value.inputTokens ||
    (value.reasoningTokens ?? 0) > value.outputTokens
  )
    return null;
  return {
    total: value.totalTokens,
    input: value.inputTokens,
    output: value.outputTokens,
    cacheRead: value.cachedReadTokens ?? null,
    cacheWrite: value.cacheCreationTokens ?? null,
    reasoning: value.reasoningTokens ?? null,
  };
}

/** Grok ACP includes cache reads in input, unlike its headless NDJSON format. */
export function grokTokenConsumption(result: unknown): TokenUsageObservation[] {
  const parsed = decodeResult(result);
  if (Option.isNone(parsed)) return [];
  const { stopReason, _meta: meta } = parsed.value;
  const total = counts(meta.usage);
  if (total === null || (total.total === 0 && stopReason !== "end_turn")) return [];
  const byModel = Object.entries(meta.usage.modelUsage ?? {});
  // Only trust a model breakdown when it accounts for the entire native request.
  const validBreakdown =
    byModel.length > 0 &&
    byModel.every(([, usage]) => counts(usage) !== null) &&
    byModel.reduce((n, [, usage]) => n + usage.inputTokens, 0) === total.input &&
    byModel.reduce((n, [, usage]) => n + usage.outputTokens, 0) === total.output;
  const sources = validBreakdown
    ? byModel.map(([model, usage]) => ({ model, counts: counts(usage)! }))
    : [{ model: meta.modelId ?? null, counts: total }];
  return sources.map((entry) => ({
    sourceId: JSON.stringify(["grok-acp", meta.sessionId, meta.promptId, entry.model]),
    provider: "grok",
    model: entry.model,
    mode: "execution-total",
    counts: entry.counts,
    // A cancelled request's counts are useful, but final coverage is unconfirmed.
    isFinal: stopReason === "end_turn",
  }));
}

/**
 * Observe decoded protocol responses before RPC cancellation discards them.
 * Grok's completion notification may win the fallback race before usage arrives.
 * Freeze the owning turn on send, so late usage never attaches to a later turn.
 */
export function makeGrokTokenUsageTracker() {
  const pending = new Map<string, { turnId: TurnId; sessionId: string; promptId: string }>();
  const completion = (payload: unknown) => {
    const decoded = decodeCompletedNotification(payload);
    if (Option.isNone(decoded)) return [];
    const notification = decoded.value;
    const owner = [...pending].find(
      ([, value]) =>
        value.sessionId === notification.sessionId &&
        value.promptId === notification.update.prompt_id,
    );
    if (!owner) return [];
    const consumption = grokTokenConsumption({
      stopReason: notification.update.stop_reason,
      _meta: {
        sessionId: notification.sessionId,
        promptId: notification.update.prompt_id,
        usage: notification.update.usage,
      },
    });
    if (!consumption.length) return [];
    pending.delete(owner[0]);
    return [{ turnId: owner[1].turnId, consumption }];
  };
  const observe = (event: AcpProtocolLogEvent, activeTurnId: TurnId | undefined) => {
    const observations: { turnId: TurnId; consumption: TokenUsageObservation[] }[] = [];
    if (event.stage !== "decoded") return observations;
    for (const message of Array.isArray(event.payload) ? event.payload : [event.payload]) {
      if (event.direction === "outgoing") {
        const request = decodeRequest(message);
        if (Option.isSome(request) && activeTurnId !== undefined) {
          pending.set(String(request.value.id), {
            turnId: activeTurnId,
            sessionId: request.value.payload.sessionId,
            promptId: request.value.payload._meta.promptId,
          });
          // Hung legacy calls must not grow a long-lived session indefinitely.
          if (pending.size > 256) pending.delete(pending.keys().next().value!);
        }
        continue;
      }
      const response = decodeResponse(message);
      if (Option.isNone(response)) continue;
      const owner = pending.get(String(response.value.requestId));
      if (!owner) continue;
      const parsed = decodeResult(response.value.exit.value);
      if (
        Option.isNone(parsed) ||
        parsed.value._meta.sessionId !== owner.sessionId ||
        parsed.value._meta.promptId !== owner.promptId
      )
        continue;
      const consumption = grokTokenConsumption(parsed.value);
      if (consumption.length) {
        pending.delete(String(response.value.requestId));
        observations.push({ turnId: owner.turnId, consumption });
      }
    }
    return observations;
  };
  return Object.assign(observe, { completion });
}
