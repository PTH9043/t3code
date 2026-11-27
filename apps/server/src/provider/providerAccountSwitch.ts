import type {
  ModelSelection,
  ServerProvider,
  ServerProviderUsageCredits,
  ServerProviderUsageWindow,
  ServerSettings,
} from "@t3tools/contracts";
import { isProviderContentRefusal } from "./providerContentRefusal.ts";

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
  if (isProviderContentRefusal(message)) return false;
  return (
    /\b(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*429\b|\b429\s+Too Many Requests\b|\bToo Many Requests\b|^\s*429\s*$/iu.test(
      message,
    ) ||
    /(?:usage|rate|message) limit (?:reached|exceeded)|you(?:'|’)ve (?:hit|reached) your (?:usage )?limit|you(?:'|’)ve hit your [\w-]+ limit|you(?:'|’)re out of (?:usage )?credits|out of (?:usage )?credits|사용량 한도.*(?:도달|초과)|한도.*(?:도달|초과)|(?:5|다섯)\s*시간.*(?:한도|제한)|사용량 크레딧.*(?:소진|없)/iu.test(
      message,
    )
  );
}

/** A transient 429 can be a request throttle; Claude switches only on quota exhaustion. */
export function isConfirmedQuotaExhaustion(message: string | null | undefined): boolean {
  if (!message || isProviderContentRefusal(message)) return false;
  return /(?:usage|message|session|weekly|daily|5[ -]?hour) limit (?:reached|exceeded)|you(?:'|’)ve (?:hit|reached) your (?:usage |message |session |weekly |daily |5[ -]?hour )?limit|you(?:'|’)re out of (?:usage )?credits|out of (?:usage )?credits|사용량 한도.*(?:도달|초과)|(?:5|다섯)\s*시간.*(?:한도|제한)/iu.test(
    message,
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

export function requiresAutomaticAccountSwitch(
  current: ServerProvider | undefined,
  blockedInstanceIds: ReadonlySet<string>,
  nowMs: number,
): boolean {
  return (
    current === undefined ||
    blockedInstanceIds.has(current.instanceId) ||
    quotaRank(current, nowMs) >= 3
  );
}

/**
 * Only replace an exhausted, deleted, or explicitly rate-limited account.
 * Unknown quota is not exhaustion. Missing Claude accounts are never switched
 * because their authentication method and quota cannot be established.
 */
function normalizeSwitchEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function chooseAutomaticAccount(input: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings["providerAutoSwitch"];
  readonly blockedInstanceIds?: ReadonlySet<string>;
  readonly nowMs: number;
  /** Driver to use when the selected instance is no longer in the registry. */
  readonly driverHint?: "codex" | "claudeAgent" | undefined;
  readonly providerInstances?: ServerSettings["providerInstances"];
}): ServerProvider | undefined {
  const current = input.providers.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
  const currentDriver: "codex" | "claudeAgent" | null =
    current !== undefined
      ? current.driver === "codex"
        ? "codex"
        : current.driver === "claudeAgent"
          ? "claudeAgent"
          : null
      : null;
  const driver: "codex" | "claudeAgent" | null = currentDriver ?? input.driverHint ?? null;
  if (driver === null || !(driver === "codex" ? input.settings.codex : input.settings.claudeAgent))
    return undefined;
  const isClaudeApi = (
    provider: ServerProvider | undefined,
    instanceId: ModelSelection["instanceId"],
  ): boolean => {
    const config = input.providerInstances?.[instanceId]?.config;
    return (
      (typeof config === "object" &&
        config !== null &&
        "authMode" in config &&
        config.authMode === "api-key") ||
      provider?.auth.type === "apiKey" ||
      (provider === undefined && instanceId.startsWith("claude_api_"))
    );
  };
  if (driver === "claudeAgent" && isClaudeApi(current, input.selection.instanceId))
    return undefined;
  const blocked = input.blockedInstanceIds ?? new Set<string>();
  // An absent Claude account may be an API connection or have unknown quota.
  if (driver === "claudeAgent" && current === undefined) return undefined;
  if (!requiresAutomaticAccountSwitch(current, blocked, input.nowMs)) return undefined;
  const currentEmail = normalizeSwitchEmail(current?.auth.email);
  return input.providers
    .filter(
      (candidate) =>
        candidate.instanceId !== input.selection.instanceId &&
        candidate.driver === driver &&
        (driver !== "claudeAgent" || !isClaudeApi(candidate, candidate.instanceId)) &&
        candidate.enabled &&
        candidate.installed &&
        candidate.status !== "error" &&
        candidate.status !== "disabled" &&
        candidate.availability !== "unavailable" &&
        candidate.auth.status === "authenticated" &&
        (currentEmail === undefined ||
          normalizeSwitchEmail(candidate.auth.email) !== currentEmail) &&
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
