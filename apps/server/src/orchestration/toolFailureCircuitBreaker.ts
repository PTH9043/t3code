// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

export interface ToolFailureCircuitStatus {
  readonly tripped: boolean;
  readonly streak: number;
  readonly signature: string;
  readonly directive: string | null;
}

interface StreakRecord {
  readonly signature: string;
  readonly streak: number;
  readonly lastSample: string;
}

function normalizeErrorForSignature(rawError: string): string {
  return rawError
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<TS>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/gi, "<TIME>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

/**
 * 3-Strike Identical-Error Circuit Breaker:
 * detects 3 consecutive identical tool failures within a thread and emits a
 * stop-and-pivot directive so an agent never burns 30-60 loop turns repeating
 * the exact same broken command or assertion failure.
 */
export class ToolFailureCircuitBreaker {
  private readonly streaks = new Map<string, StreakRecord>();
  private readonly threshold: number;

  constructor(threshold = 3) {
    this.threshold = Math.max(2, threshold);
  }

  recordSuccess(threadId: string): void {
    this.streaks.delete(threadId);
  }

  recordFailure(input: {
    readonly threadId: string;
    readonly toolName: string;
    readonly errorText: string;
  }): ToolFailureCircuitStatus {
    const normalized = `${input.toolName.toLowerCase()}:${normalizeErrorForSignature(input.errorText)}`;
    const signature = NodeCrypto.createHash("sha256")
      .update(normalized, "utf8")
      .digest("hex")
      .slice(0, 12);
    const prev = this.streaks.get(input.threadId);
    const nextStreak = prev && prev.signature === signature ? prev.streak + 1 : 1;
    const sample = input.errorText.replace(/\s+/g, " ").trim().slice(0, 180);
    this.streaks.set(input.threadId, { signature, streak: nextStreak, lastSample: sample });

    if (nextStreak >= this.threshold) {
      return {
        tripped: true,
        streak: nextStreak,
        signature,
        directive: `[T3-CIRCUIT-BREAKER streak=${nextStreak} sig=${signature}] 동일 도구(${input.toolName})에서 같은 오류가 ${nextStreak}회 연속 반복되었습니다("${sample}"). 같은 명령 재시도를 중단하고 원인 파일을 직접 검증하거나 다른 접근법으로 전환하세요.`,
      };
    }
    return {
      tripped: false,
      streak: nextStreak,
      signature,
      directive: null,
    };
  }

  clearThread(threadId: string): void {
    this.streaks.delete(threadId);
  }
}
