/** Use only usage reported for the current turn and exact selected model. */
export function pdfModelBudget(input: {
  requestedBytes?: number | undefined;
  model: string;
  currentTurnId: string | null;
  activities: readonly { kind: string; turnId?: string | null | undefined; payload?: unknown }[];
}) {
  const requested = Math.min(8192, Math.max(128, input.requestedBytes ?? 4096));
  const current = [...input.activities].reverse().find((activity) => {
    if (
      activity.kind !== "context-window.updated" ||
      !input.currentTurnId ||
      activity.turnId !== input.currentTurnId ||
      !activity.payload ||
      typeof activity.payload !== "object"
    )
      return false;
    const p = activity.payload as {
      usedTokens?: unknown;
      maxTokens?: unknown;
      consumption?: unknown;
    };
    return (
      typeof p.usedTokens === "number" &&
      Number.isSafeInteger(p.usedTokens) &&
      p.usedTokens >= 0 &&
      typeof p.maxTokens === "number" &&
      Number.isSafeInteger(p.maxTokens) &&
      p.maxTokens > 0 &&
      Array.isArray(p.consumption) &&
      p.consumption.some(
        (entry) => entry && typeof entry === "object" && entry.model === input.model,
      )
    );
  });
  if (!current)
    return {
      maxBytes: Math.min(requested, 2048),
      source: "unknown" as const,
      remainingTokens: null,
    };
  const p = current.payload as { usedTokens: number; maxTokens: number };
  const remaining = Math.max(0, p.maxTokens - p.usedTokens);
  // Preserve room for the tool envelope, prior messages and the model's response.
  const available = remaining - 2048;
  return {
    maxBytes: available < 128 ? 0 : Math.min(requested, available),
    source: "provider" as const,
    remainingTokens: remaining,
  };
}
