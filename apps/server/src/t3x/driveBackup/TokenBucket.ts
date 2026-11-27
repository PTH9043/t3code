// @effect-diagnostics globalDate:off globalTimers:off
/**
 * 고정밀 비동기 토큰 버킷 속도 제한기 (디스크 읽기 MB/s · 네트워크 업로드 Mbps 공용).
 *
 * - `bytesPerSecond <= 0`이면 무제한(즉시 반환).
 * - `AbortSignal`을 전달하면 일시정지 시 대기 중인 타이머를 즉시 해제한다.
 */
export class TokenBucket {
  private readonly bytesPerSecond: number;
  private readonly capacityBytes: number;
  private tokens: number;
  private lastRefillMs: number;
  private totalConsumedBytes = 0;
  private readonly startedAtMs: number;

  constructor(input: { readonly bytesPerSecond: number; readonly burstBytes?: number }) {
    this.bytesPerSecond = Math.max(
      0,
      Number.isFinite(input.bytesPerSecond) ? input.bytesPerSecond : 0,
    );
    const defaultBurst = Math.max(256 * 1024, Math.floor(this.bytesPerSecond * 0.5));
    this.capacityBytes = Math.max(64 * 1024, input.burstBytes ?? defaultBurst);
    this.tokens = this.capacityBytes;
    const now = Date.now();
    this.lastRefillMs = now;
    this.startedAtMs = now;
  }

  private refill(nowMs: number): void {
    if (this.bytesPerSecond <= 0) return;
    const elapsedSec = Math.max(0, (nowMs - this.lastRefillMs) / 1_000);
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacityBytes, this.tokens + elapsedSec * this.bytesPerSecond);
      this.lastRefillMs = nowMs;
    }
  }

  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (bytes <= 0) return;
    if (signal?.aborted) {
      throw new Error("Paused or aborted while waiting for rate limit.");
    }
    this.totalConsumedBytes += bytes;
    if (this.bytesPerSecond <= 0) return;

    let remaining = bytes;
    while (remaining > 0) {
      if (signal?.aborted) {
        throw new Error("Paused or aborted while waiting for rate limit.");
      }
      const now = Date.now();
      this.refill(now);
      if (this.tokens >= remaining) {
        this.tokens -= remaining;
        return;
      }
      if (this.tokens > 0) {
        remaining -= this.tokens;
        this.tokens = 0;
      }
      const waitMs = Math.max(
        10,
        Math.min(500, Math.ceil((remaining / this.bytesPerSecond) * 1_000)),
      );
      await sleepAbortable(waitMs, signal);
    }
  }

  stats(): {
    readonly totalConsumedBytes: number;
    readonly elapsedMs: number;
    readonly averageBytesPerSec: number;
  } {
    const elapsedMs = Math.max(1, Date.now() - this.startedAtMs);
    return {
      totalConsumedBytes: this.totalConsumedBytes,
      elapsedMs,
      averageBytesPerSec: (this.totalConsumedBytes * 1_000) / elapsedMs,
    };
  }
}

export function mbpsToBytesPerSec(mbps: number): number {
  if (!Number.isFinite(mbps) || mbps <= 0) return 0;
  return Math.floor((mbps * 1_000_000) / 8);
}

export function megaBytesPerSecToBytesPerSec(mBps: number): number {
  if (!Number.isFinite(mBps) || mBps <= 0) return 0;
  return Math.floor(mBps * 1024 * 1024);
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
