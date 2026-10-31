import type {
  ModelSelection,
  ServerProvider,
  ServerProviderUsageCredits,
  ServerProviderUsageWindow,
  ServerSettings,
} from "@t3tools/contracts";

export function hasSpendableCredits(credits: ServerProviderUsageCredits | undefined): boolean {
  if (!credits) return false;
  if (credits.unlimited === true) return true;
  if (credits.hasCredits === false) return false;
  if (credits.balance !== undefined) {
    const balance = Number(credits.balance.replaceAll(",", ""));
    if (Number.isFinite(balance)) return balance > 0;
  }
  return credits.hasCredits === true;
}

export function isActualRateLimitFailure(message: string | null | undefined): boolean {
  if (message === null || message === undefined) return false;
  return (
    /\b(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*429\b|\b429\s+Too Many Requests\b|\bToo Many Requests\b|^\s*429\s*$/iu.test(
      message,
    ) ||
    /(?:usage|rate|message) limit (?:reached|exceeded)|you(?:'|’)ve (?:hit|reached) your (?:usage )?limit|사용량 한도.*(?:도달|초과)|한도.*(?:도달|초과)|(?:5|다섯)\s*시간.*(?:한도|제한)/iu.test(
      message,
    )
  );
}

function usedPercent(
  window: ServerProviderUsageWindow | undefined,
  nowMs: number,
): number | undefined {
  if (!window) return undefined;
  return window.resetsAt !== undefined && window.resetsAt * 1_000 <= nowMs ? 0 : window.usedPercent;
}

function quotaRank(provider: ServerProvider, nowMs: number): number {
  const usage = provider.usage;
  if (provider.driver === "codex") {
    const weekly =
      usage?.secondary ??
      (usage?.primary?.windowDurationMinutes === 10_080 ? usage.primary : undefined);
    const used = usedPercent(weekly, nowMs);
    if (used !== undefined && used < 100) return 0;
    if (hasSpendableCredits(usage?.credits)) return 1;
    return used === undefined ? 2 : 3;
  }
  return [usage?.primary, usage?.secondary].some(
    (window) => (usedPercent(window, nowMs) ?? 0) >= 100,
  )
    ? 3
    : 0;
}

/** Only replace an exhausted or explicitly rate-limited account. Unknown quota is not exhaustion. */
export function chooseAutomaticAccount(input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings["providerAutoSwitch"];
  readonly blockedInstanceIds?: ReadonlySet<string>;
  readonly nowMs: number;
}): ServerProvider | undefined {
  const current = input.providers.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
  if (
    !current ||
    (current.driver !== "codex" && current.driver !== "claudeAgent") ||
    !(current.driver === "codex" ? input.settings.codex : input.settings.claudeAgent)
  )
    return undefined;
  const blocked = input.blockedInstanceIds ?? new Set<string>();
  if (!blocked.has(current.instanceId) && quotaRank(current, input.nowMs) < 3) return undefined;
  return input.providers
    .filter(
      (candidate) =>
        candidate.instanceId !== current.instanceId &&
        candidate.driver === current.driver &&
        candidate.enabled &&
        candidate.installed &&
        candidate.status !== "error" &&
        candidate.status !== "disabled" &&
        candidate.availability !== "unavailable" &&
        candidate.auth.status === "authenticated" &&
        !blocked.has(candidate.instanceId) &&
        candidate.models.some((model) => model.slug === input.selection.model) &&
        quotaRank(candidate, input.nowMs) < 3,
    )
    .sort(
      (a, b) =>
        quotaRank(a, input.nowMs) - quotaRank(b, input.nowMs) ||
        a.instanceId.localeCompare(b.instanceId),
    )[0];
}
