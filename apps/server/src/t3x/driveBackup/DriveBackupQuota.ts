// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
/**
 * Google Drive 일일 750 GB 업로드 한도 보호 모듈:
 * - Google Drive API v3는 계정당 24시간 750 GB 업로드 제한을 적용한다.
 *   (진행 중인 단일 파일은 완료까지 허용되나 이후 새 파일/요청부터 HTTP 403 반환)
 * - 본 모듈은 700 GiB/24h 안전 예산(롤링 24시간 시간별 버킷)을 추적하고,
 *   예산 도달 또는 Google 403 일일 한도 응답 시 에러(failed) 대신
 *   자동 일시정지(paused) + 재개 예정 시각(retryAfterMs)으로 전환해
 *   며칠에 걸친 750 GB+ 대용량 업로드를 무중단 자동 분할 완주한다.
 */

export const DAILY_QUOTA_WINDOW_MS = 24 * 3_600_000;
export const HOUR_MS = 3_600_000;
/** 기본 24시간 안전 업로드 예산: 700 GiB (Google 공식 750 GB 대비 안전 여유 확보) */
export const DEFAULT_DAILY_UPLOAD_BUDGET_BYTES = 700 * 1024 * 1024 * 1024;
/** 일일 한도 초과(403) 수신 시 기본 쿨다운(24시간) */
export const REMOTE_QUOTA_COOLDOWN_MS = 24 * 3_600_000;
export const DAILY_QUOTA_STATE_KEY = "gdrive_daily_upload_quota";

export interface DailyUploadBucket {
  readonly hourKey: number;
  readonly bytes: number;
}

export interface DailyUploadLedger {
  readonly schemaVersion: 1;
  readonly buckets: ReadonlyArray<DailyUploadBucket>;
  readonly pausedUntilMs: number | null;
  readonly pauseReason: string | null;
  readonly updatedAtMs: number;
}

export function createEmptyDailyUploadLedger(nowMs = Date.now()): DailyUploadLedger {
  return {
    schemaVersion: 1,
    buckets: [],
    pausedUntilMs: null,
    pauseReason: null,
    updatedAtMs: nowMs,
  };
}

export function parseDailyUploadLedger(
  rawJson: string | null | undefined,
  nowMs = Date.now(),
): DailyUploadLedger {
  if (!rawJson) return createEmptyDailyUploadLedger(nowMs);
  try {
    const parsed = JSON.parse(rawJson) as Partial<DailyUploadLedger>;
    const rawBuckets = Array.isArray(parsed.buckets) ? parsed.buckets : [];
    const buckets: DailyUploadBucket[] = [];
    for (const b of rawBuckets) {
      if (
        b &&
        typeof b === "object" &&
        typeof b.hourKey === "number" &&
        Number.isFinite(b.hourKey) &&
        typeof b.bytes === "number" &&
        Number.isFinite(b.bytes) &&
        b.bytes > 0
      ) {
        buckets.push({ hourKey: Math.floor(b.hourKey), bytes: Math.floor(b.bytes) });
      }
    }
    const pausedUntilMs =
      typeof parsed.pausedUntilMs === "number" && Number.isFinite(parsed.pausedUntilMs)
        ? parsed.pausedUntilMs
        : null;
    const pauseReason = typeof parsed.pauseReason === "string" ? parsed.pauseReason : null;
    return pruneDailyUploadLedger(
      {
        schemaVersion: 1,
        buckets,
        pausedUntilMs,
        pauseReason,
        updatedAtMs:
          typeof parsed.updatedAtMs === "number" && Number.isFinite(parsed.updatedAtMs)
            ? parsed.updatedAtMs
            : nowMs,
      },
      nowMs,
    );
  } catch {
    return createEmptyDailyUploadLedger(nowMs);
  }
}

export function pruneDailyUploadLedger(
  ledger: DailyUploadLedger,
  nowMs = Date.now(),
): DailyUploadLedger {
  const cutoffHourKey = Math.floor((nowMs - DAILY_QUOTA_WINDOW_MS) / HOUR_MS);
  const buckets = ledger.buckets
    .filter((b) => b.hourKey > cutoffHourKey && b.bytes > 0)
    .sort((a, b) => a.hourKey - b.hourKey);
  const stillPaused = ledger.pausedUntilMs !== null && ledger.pausedUntilMs > nowMs;
  return {
    schemaVersion: 1,
    buckets,
    pausedUntilMs: stillPaused ? ledger.pausedUntilMs : null,
    pauseReason: stillPaused ? ledger.pauseReason : null,
    updatedAtMs: ledger.updatedAtMs,
  };
}

export function getRolling24hUploadedBytes(ledger: DailyUploadLedger, nowMs = Date.now()): number {
  const pruned = pruneDailyUploadLedger(ledger, nowMs);
  let sum = 0;
  for (const b of pruned.buckets) {
    sum += b.bytes;
  }
  return sum;
}

export function recordUploadedBytesInLedger(
  ledger: DailyUploadLedger,
  bytes: number,
  nowMs = Date.now(),
): DailyUploadLedger {
  const cleanBytes = Math.max(0, Math.floor(bytes));
  const pruned = pruneDailyUploadLedger(ledger, nowMs);
  if (cleanBytes <= 0) return pruned;
  const currentHourKey = Math.floor(nowMs / HOUR_MS);
  const merged = new Map<number, number>();
  for (const b of pruned.buckets) {
    merged.set(b.hourKey, (merged.get(b.hourKey) ?? 0) + b.bytes);
  }
  merged.set(currentHourKey, (merged.get(currentHourKey) ?? 0) + cleanBytes);
  const buckets: DailyUploadBucket[] = [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hourKey, total]) => ({ hourKey, bytes: total }));
  return {
    schemaVersion: 1,
    buckets,
    pausedUntilMs: pruned.pausedUntilMs,
    pauseReason: pruned.pauseReason,
    updatedAtMs: nowMs,
  };
}

/**
 * 롤링 24시간 버킷 기준으로 예산 아래로 내려오는 가장 이른 시각(UTC epoch ms)을 계산한다.
 * 가장 오래된 버킷이 24시간 창 밖으로 빠져나가는 정각(hourKey + 25)을 기준으로 삼는다.
 */
export function computeNextQuotaResumeAtMs(
  ledger: DailyUploadLedger,
  budgetBytes: number,
  nowMs = Date.now(),
): number {
  const pruned = pruneDailyUploadLedger(ledger, nowMs);
  let remaining = getRolling24hUploadedBytes(pruned, nowMs);
  if (remaining < budgetBytes) return nowMs;
  for (const b of pruned.buckets) {
    remaining -= b.bytes;
    const expireAtMs = (b.hourKey + 25) * HOUR_MS;
    if (remaining < budgetBytes) {
      return Math.max(nowMs + 60_000, expireAtMs);
    }
  }
  return nowMs + REMOTE_QUOTA_COOLDOWN_MS;
}

export function markLedgerQuotaPaused(
  ledger: DailyUploadLedger,
  pausedUntilMs: number,
  reason: string,
  nowMs = Date.now(),
): DailyUploadLedger {
  const pruned = pruneDailyUploadLedger(ledger, nowMs);
  return {
    ...pruned,
    pausedUntilMs: Math.max(nowMs + 60_000, Math.floor(pausedUntilMs)),
    pauseReason: reason,
    updatedAtMs: nowMs,
  };
}

export function formatResumeTimeKst(epochMs: number): string {
  const d = new Date(epochMs + 9 * HOUR_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} KST`;
}

export function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export type DriveUploadQuotaErrorKind = "daily_budget_reached" | "remote_quota_exceeded";

export class DriveUploadQuotaExceededError extends Error {
  readonly kind: DriveUploadQuotaErrorKind;
  readonly retryAfterMs: number;
  readonly uploadedBytesInWindow: number;
  readonly sessionUri: string | null;
  readonly offsetBytes: number | null;
  readonly totalBytes: number | null;

  constructor(input: {
    readonly kind: DriveUploadQuotaErrorKind;
    readonly retryAfterMs: number;
    readonly uploadedBytesInWindow?: number;
    readonly sessionUri?: string | null;
    readonly offsetBytes?: number | null;
    readonly totalBytes?: number | null;
    readonly detail?: string;
  }) {
    const resumeLabel = formatResumeTimeKst(input.retryAfterMs);
    const message =
      input.kind === "daily_budget_reached"
        ? `일일 안전 업로드 한도 도달 (${formatGiB(input.uploadedBytesInWindow ?? 0)} / 24시간) — ${resumeLabel} 이후 남은 지점부터 자동 이어올리기 대기`
        : `Google Drive 일일 업로드 한도(750 GB) 도달 — ${resumeLabel} 이후 남은 지점부터 자동 이어올리기 대기${input.detail ? ` (${input.detail.slice(0, 120)})` : ""}`;
    super(message);
    this.name = "DriveUploadQuotaExceededError";
    this.kind = input.kind;
    this.retryAfterMs = input.retryAfterMs;
    this.uploadedBytesInWindow = input.uploadedBytesInWindow ?? 0;
    this.sessionUri = input.sessionUri ?? null;
    this.offsetBytes = input.offsetBytes ?? null;
    this.totalBytes = input.totalBytes ?? null;
  }
}

/**
 * Google Drive API v3 응답이 계정 일일 업로드 한도(750 GB) 또는 일일 API 한도 초과인지 판별한다.
 * 주의: `storageQuotaExceeded`(드라이브 디스크 용량 자체가 가득 참)는 24시간 대기로 풀리지 않으므로 제외한다.
 */
export function isGoogleDriveDailyUploadQuotaResponse(status: number, bodyText: string): boolean {
  if (status !== 403 && status !== 429) return false;
  if (/storageQuotaExceeded/i.test(bodyText)) return false;
  return /(?:userRateLimitExceeded|dailyLimitExceeded|uploadLimitExceeded|rateLimitExceeded|quotaExceeded|sharingRateLimitExceeded|daily.*limit|750\s*GB)/i.test(
    bodyText,
  );
}
