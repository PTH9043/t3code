// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

/**
 * Shared failure classification and pre-flight model availability policy for
 * delegated workers, council seats, orchestra meetings, and OpenCode sessions.
 *
 * Design invariants:
 * - Zero paid/billed inference probes: pre-flight checks ONLY inspect local
 *   in-memory cooldowns, read-only local `~/.antseed/{config,buyer.state}.json`,
 *   and free `GET <baseUrl>/models` metadata endpoints.
 * - Never silently substitute a user-assigned role model with another model.
 * - Never trigger top-ups, payments, or automatic retries for billing errors.
 */

export const ANTSEED_UNAVAILABLE_COOLDOWN_MS = 15 * 60_000;
const ANTSEED_MODELS_CACHE_TTL_MS = 15_000;
const ANTSEED_PROBE_TIMEOUT_MS = 1_500;

export interface ModelUnavailableEntry {
  readonly key: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly reason: string;
  readonly category: "antseed_no_peer" | "billing_insufficient_balance" | "model_unavailable";
  readonly recordedAtMs: number;
  readonly expiresAtMs: number;
}

export interface AntseedAvailabilityResult {
  readonly available: boolean;
  readonly reason?: string;
  readonly fromCooldown?: boolean;
}

const unavailableCooldowns = new Map<string, ModelUnavailableEntry>();
const antseedModelsCache = new Map<
  string,
  {
    readonly fetchedAtMs: number;
    readonly models: ReadonlySet<string> | null;
    readonly error?: string;
  }
>();

const BILLING_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /insufficient\s+balance/i,
  /insufficient[_\s-]+credits?/i,
  /insufficient[_\s-]+quota/i,
  /credit\s+balance\s+(?:is\s+)?too\s+low/i,
  /out\s+of\s+credits?/i,
  /billing[_\s-]+(?:not[_\s-]+active|hard[_\s-]+limit|limit)/i,
  /\bpayment\s+required\b/i,
  /\bhttp\s*402\b/i,
  /\bstatus(?:\s*code)?\s*[:=]\s*402\b/i,
  /잔액\s*부족/,
  /크레딧\s*부족/,
];

const ANTSEED_NO_PEER_PATTERNS: ReadonlyArray<RegExp> = [
  /no\s+policy-allowed\s+peer\s+currently\s+serves\s+model/i,
  /no\s+policy[-\s]?allowed\s+peer/i,
  /no\s+peer\s+currently\s+serves\s+model/i,
  /no\s+eligible\s+peer\s+(?:found|available)/i,
];

function normalizeModelCooldownKey(providerInstanceId: string, model: string): string {
  const inst = providerInstanceId.trim().toLowerCase();
  const normalizedModel = stripAntseedModelPrefix(model).toLowerCase();
  return `${inst}::${normalizedModel}`;
}

export function stripAntseedModelPrefix(model: string): string {
  const trimmed = model.trim();
  const idx = trimmed.indexOf("/");
  if (idx > 0) {
    const prefix = trimmed.slice(0, idx).toLowerCase();
    if (prefix === "t3_antseed" || prefix === "antseed" || prefix === "antseed_local") {
      return trimmed.slice(idx + 1).trim();
    }
  }
  return trimmed;
}

export function isAntseedTarget(input: {
  readonly providerInstanceId?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly apiProviderId?: string | null | undefined;
  readonly baseUrl?: string | null | undefined;
}): boolean {
  if (input.apiProviderId?.toLowerCase().includes("antseed")) return true;
  if (input.providerInstanceId?.toLowerCase().includes("antseed")) return true;
  if (input.model?.toLowerCase().startsWith("t3_antseed/")) return true;
  if (input.model?.toLowerCase().startsWith("antseed/")) return true;
  if (input.baseUrl && /:8379\b/i.test(input.baseUrl)) return true;
  return false;
}

export function isNonRetryableBillingError(message: string | null | undefined): boolean {
  if (!message) return false;
  return BILLING_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function isAntseedPeerUnavailableError(message: string | null | undefined): boolean {
  if (!message) return false;
  return ANTSEED_NO_PEER_PATTERNS.some((pattern) => pattern.test(message));
}

export function isNonRetryableWorkerError(message: string | null | undefined): boolean {
  return isNonRetryableBillingError(message) || isAntseedPeerUnavailableError(message);
}

export function formatBillingErrorMessage(rawMessage: string): string {
  const clean = rawMessage.trim();
  if (clean.startsWith("[과금 오류")) {
    return clean;
  }
  return `[과금 오류 · 재시도 안 함] 잔액 또는 크레딧이 부족해 요청이 거부되었습니다(${clean}). 자동 재시도·충전을 수행하지 않으므로 제공자 계정 잔액을 확인하세요.`;
}

export function formatUnavailableModelMessage(model: string, reason: string): string {
  const clean = reason.trim();
  if (clean.startsWith("사용 불가")) {
    return clean;
  }
  return `사용 불가(${model}): ${clean}`;
}

export function recordUnavailableModel(input: {
  readonly providerInstanceId: string;
  readonly model: string;
  readonly reason: string;
  readonly category?: ModelUnavailableEntry["category"];
  readonly cooldownMs?: number;
  readonly nowMs?: number;
}): ModelUnavailableEntry {
  const nowMs = input.nowMs ?? Date.now();
  const cooldownMs = Math.max(1_000, input.cooldownMs ?? ANTSEED_UNAVAILABLE_COOLDOWN_MS);
  const key = normalizeModelCooldownKey(input.providerInstanceId, input.model);
  const entry: ModelUnavailableEntry = {
    key,
    providerInstanceId: input.providerInstanceId,
    model: input.model,
    reason: input.reason.trim(),
    category: input.category ?? "antseed_no_peer",
    recordedAtMs: nowMs,
    expiresAtMs: nowMs + cooldownMs,
  };
  unavailableCooldowns.set(key, entry);
  return entry;
}

/**
 * Inspects a runtime failure message and records a cooldown when the error is
 * an Antseed peer/policy unavailability or non-retryable billing exhaustion.
 */
export function recordUnavailableModelFromError(input: {
  readonly providerInstanceId: string;
  readonly model: string | null | undefined;
  readonly errorMessage: string | null | undefined;
  readonly nowMs?: number;
}): ModelUnavailableEntry | null {
  const model = input.model?.trim();
  const msg = input.errorMessage?.trim();
  if (!model || !msg) return null;

  if (isAntseedPeerUnavailableError(msg)) {
    return recordUnavailableModel({
      providerInstanceId: input.providerInstanceId,
      model,
      reason: `Antseed 정책 허용 피어가 모델 '${stripAntseedModelPrefix(model)}'을(를) 현재 제공하지 않습니다 (${msg})`,
      category: "antseed_no_peer",
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
  }

  if (isNonRetryableBillingError(msg)) {
    return recordUnavailableModel({
      providerInstanceId: input.providerInstanceId,
      model,
      reason: formatBillingErrorMessage(msg),
      category: "billing_insufficient_balance",
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
  }

  return null;
}

export function getUnavailableModelEntry(
  providerInstanceId: string,
  model: string | null | undefined,
  nowMs = Date.now(),
): ModelUnavailableEntry | null {
  if (!model?.trim()) return null;
  const key = normalizeModelCooldownKey(providerInstanceId, model);
  const entry = unavailableCooldowns.get(key);
  if (!entry) return null;
  if (nowMs >= entry.expiresAtMs) {
    unavailableCooldowns.delete(key);
    return null;
  }
  return entry;
}

export function getUnavailableModelReason(
  providerInstanceId: string,
  model: string | null | undefined,
  nowMs = Date.now(),
): string | null {
  const entry = getUnavailableModelEntry(providerInstanceId, model, nowMs);
  if (!entry) return null;
  const remainMin = Math.max(1, Math.ceil((entry.expiresAtMs - nowMs) / 60_000));
  return `사용 불가(쿨다운 ${remainMin}분 남음): ${entry.reason}`;
}

export function clearUnavailableModelCooldownsForTest(): void {
  unavailableCooldowns.clear();
  antseedModelsCache.clear();
}

interface LocalAntseedPolicySnapshot {
  readonly allowedModels?: ReadonlySet<string> | null;
  readonly blockedModels?: ReadonlySet<string>;
  readonly peerCount?: number | null;
}

function readLocalAntseedPolicySnapshot(antseedDir?: string): LocalAntseedPolicySnapshot | null {
  try {
    const baseDir = antseedDir ?? NodePath.join(NodeOs.homedir(), ".antseed");
    const configPath = NodePath.join(baseDir, "config.json");
    const buyerStatePath = NodePath.join(baseDir, "buyer.state.json");
    const blockedModels = new Set<string>();
    let allowedModels: Set<string> | null = null;
    let peerCount: number | null = null;
    let foundAny = false;

    if (NodeFs.existsSync(configPath)) {
      foundAny = true;
      const raw = JSON.parse(NodeFs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      const policy = (raw.policy ?? raw.buyerPolicy ?? raw.routingPolicy) as
        | Record<string, unknown>
        | undefined;
      if (policy && typeof policy === "object") {
        const deny = policy.blockedModels ?? policy.deniedModels ?? policy.denyModels;
        if (Array.isArray(deny)) {
          for (const item of deny) {
            if (typeof item === "string" && item.trim()) {
              blockedModels.add(stripAntseedModelPrefix(item).toLowerCase());
            }
          }
        }
        const allow = policy.allowedModels ?? policy.allowModels;
        if (Array.isArray(allow) && allow.length > 0) {
          allowedModels = new Set(
            allow
              .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
              .map((item) => stripAntseedModelPrefix(item).toLowerCase()),
          );
        }
      }
    }

    if (NodeFs.existsSync(buyerStatePath)) {
      foundAny = true;
      const raw = JSON.parse(NodeFs.readFileSync(buyerStatePath, "utf8")) as Record<
        string,
        unknown
      >;
      if (Array.isArray(raw.peers)) {
        peerCount = raw.peers.length;
      } else if (raw.peers && typeof raw.peers === "object") {
        peerCount = Object.keys(raw.peers as Record<string, unknown>).length;
      }
    }

    return foundAny ? { allowedModels, blockedModels, peerCount } : null;
  } catch {
    return null;
  }
}

async function fetchAntseedAvailableModels(
  baseUrl: string,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<{ readonly models: ReadonlySet<string> | null; readonly error?: string }> {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  const modelsUrl = normalizedBase.endsWith("/v1")
    ? `${normalizedBase}/models`
    : `${normalizedBase}/v1/models`;

  const cached = antseedModelsCache.get(modelsUrl);
  if (cached && nowMs - cached.fetchedAtMs < ANTSEED_MODELS_CACHE_TTL_MS) {
    return {
      models: cached.models,
      ...(cached.error !== undefined ? { error: cached.error } : {}),
    };
  }

  try {
    const response = await fetchImpl(modelsUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(ANTSEED_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = `Antseed 게이트웨이 모델 목록 조회 실패 (HTTP ${response.status})`;
      antseedModelsCache.set(modelsUrl, { fetchedAtMs: nowMs, models: null, error });
      return { models: null, error };
    }
    const body = (await response.json()) as { data?: ReadonlyArray<{ id?: unknown }> };
    const list = Array.isArray(body?.data) ? body.data : [];
    const models = new Set<string>();
    for (const item of list) {
      if (typeof item?.id === "string" && item.id.trim()) {
        const clean = item.id.trim().toLowerCase();
        models.add(clean);
        models.add(stripAntseedModelPrefix(clean).toLowerCase());
      }
    }
    antseedModelsCache.set(modelsUrl, { fetchedAtMs: nowMs, models });
    return { models };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const error = `Antseed 게이트웨이 연결 불가 (${detail})`;
    antseedModelsCache.set(modelsUrl, { fetchedAtMs: nowMs, models: null, error });
    return { models: null, error };
  }
}

/**
 * Pre-flight availability check before dispatching work to a model.
 * - Always checks the in-memory unavailable cooldown first (applies to any provider).
 * - For Antseed targets, also verifies local policy (`~/.antseed/config.json`)
 *   and free read-only `GET <baseUrl>/models` peer availability without sending
 *   any paid inference request.
 */
export async function probeModelAvailabilityBeforeDispatch(input: {
  readonly providerInstanceId: string;
  readonly model: string;
  readonly apiProviderId?: string | null | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly antseedDir?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly nowMs?: number | undefined;
}): Promise<AntseedAvailabilityResult> {
  const nowMs = input.nowMs ?? Date.now();
  const cooldownReason = getUnavailableModelReason(input.providerInstanceId, input.model, nowMs);
  if (cooldownReason) {
    return { available: false, reason: cooldownReason, fromCooldown: true };
  }

  if (
    !isAntseedTarget({
      providerInstanceId: input.providerInstanceId,
      model: input.model,
      apiProviderId: input.apiProviderId,
      baseUrl: input.baseUrl,
    })
  ) {
    return { available: true };
  }

  const normalizedModel = stripAntseedModelPrefix(input.model).toLowerCase();

  // 1) Local policy check (read-only)
  const localPolicy = readLocalAntseedPolicySnapshot(input.antseedDir);
  if (localPolicy) {
    if (localPolicy.blockedModels?.has(normalizedModel)) {
      const reason = `Antseed 로컬 정책에서 모델 '${stripAntseedModelPrefix(input.model)}'이(가) 차단되어 있습니다.`;
      recordUnavailableModel({
        providerInstanceId: input.providerInstanceId,
        model: input.model,
        reason,
        category: "antseed_no_peer",
        nowMs,
      });
      return { available: false, reason: formatUnavailableModelMessage(input.model, reason) };
    }
    if (localPolicy.allowedModels && !localPolicy.allowedModels.has(normalizedModel)) {
      const reason = `Antseed 로컬 허용 정책 목록에 모델 '${stripAntseedModelPrefix(input.model)}'이(가) 포함되어 있지 않습니다.`;
      recordUnavailableModel({
        providerInstanceId: input.providerInstanceId,
        model: input.model,
        reason,
        category: "antseed_no_peer",
        nowMs,
      });
      return { available: false, reason: formatUnavailableModelMessage(input.model, reason) };
    }
  }

  // 2) Free metadata probe (`GET /v1/models`) when gateway URL is configured
  const gatewayUrl = input.baseUrl?.trim();
  if (gatewayUrl) {
    const probed = await fetchAntseedAvailableModels(gatewayUrl, input.fetchImpl ?? fetch, nowMs);
    if (probed.models === null) {
      const reason = probed.error ?? "Antseed 게이트웨이 응답 없음";
      recordUnavailableModel({
        providerInstanceId: input.providerInstanceId,
        model: input.model,
        reason,
        category: "antseed_no_peer",
        cooldownMs: 3 * 60_000,
        nowMs,
      });
      return { available: false, reason: formatUnavailableModelMessage(input.model, reason) };
    }
    if (
      probed.models.size === 0 ||
      (!probed.models.has(normalizedModel) && !probed.models.has(input.model.trim().toLowerCase()))
    ) {
      const reason =
        probed.models.size === 0
          ? "Antseed 게이트웨이에 현재 정책 허용 피어가 제공하는 모델이 없습니다."
          : `Antseed 정책 허용 피어가 모델 '${stripAntseedModelPrefix(input.model)}'을(를) 현재 제공하지 않습니다.`;
      recordUnavailableModel({
        providerInstanceId: input.providerInstanceId,
        model: input.model,
        reason,
        category: "antseed_no_peer",
        nowMs,
      });
      return { available: false, reason: formatUnavailableModelMessage(input.model, reason) };
    }
  }

  return { available: true };
}
