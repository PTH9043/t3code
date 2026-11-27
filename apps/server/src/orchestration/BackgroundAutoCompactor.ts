// @effect-diagnostics globalDate:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { runBackgroundModelJob } from "../background/backgroundModelQueue.ts";

export const DEFAULT_AUTO_COMPACT_ABSOLUTE_TOKENS = 260_000;

export interface PrecomputedCompactionSnapshot {
  readonly threadId: string;
  readonly coveredTurnCount: number;
  readonly summaryText: string;
  readonly computedAtMs: number;
  readonly usedTokens?: number | undefined;
}

export interface AutoCompactionScheduleInput {
  readonly threadId: string;
  readonly turnCount: number;
  readonly estimatedContextRatio: number;
  readonly usedTokens?: number | undefined;
  readonly recentTurns: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly summarize?: (
    turns: ReadonlyArray<{ readonly role: string; readonly text: string }>,
  ) => Promise<string>;
  readonly minTurns?: number;
  readonly minContextRatio?: number;
  readonly minAbsoluteTokens?: number;
  readonly signal?: AbortSignal;
}

/**
 * Shizuku-Duplex-inspired Background Auto-Compactor:
 * Pre-computes structured thread compaction snapshots asynchronously on
 * `backgroundModelQueue` during idle intervals so live turn handoffs experience
 * ~0ms compaction stall when the context budget threshold is reached.
 */
export class BackgroundAutoCompactor {
  private readonly cache = new Map<string, PrecomputedCompactionSnapshot>();
  private readonly inFlight = new Set<string>();

  shouldPrecompute(input: {
    readonly threadId: string;
    readonly turnCount: number;
    readonly estimatedContextRatio: number;
    readonly usedTokens?: number | undefined;
    readonly minTurns?: number;
    readonly minContextRatio?: number;
    readonly minAbsoluteTokens?: number;
  }): boolean {
    const minTurns = input.minTurns ?? 12;
    const minRatio = input.minContextRatio ?? 0.65;
    const minAbsoluteTokens = input.minAbsoluteTokens ?? DEFAULT_AUTO_COMPACT_ABSOLUTE_TOKENS;
    const exceedsAbsoluteTokens =
      typeof input.usedTokens === "number" &&
      Number.isFinite(input.usedTokens) &&
      input.usedTokens >= minAbsoluteTokens;
    if (
      input.turnCount < minTurns &&
      input.estimatedContextRatio < minRatio &&
      !exceedsAbsoluteTokens
    ) {
      return false;
    }
    const existing = this.cache.get(input.threadId);
    if (existing && existing.coveredTurnCount >= input.turnCount) {
      return false;
    }
    return !this.inFlight.has(input.threadId);
  }

  getCachedSnapshot(threadId: string): PrecomputedCompactionSnapshot | undefined {
    return this.cache.get(threadId);
  }

  consumeSnapshot(threadId: string): PrecomputedCompactionSnapshot | undefined {
    const snapshot = this.cache.get(threadId);
    if (snapshot) this.cache.delete(threadId);
    return snapshot;
  }

  schedulePrecompute(
    input: AutoCompactionScheduleInput,
  ): Promise<PrecomputedCompactionSnapshot | null> {
    if (!this.shouldPrecompute(input)) {
      return Promise.resolve(this.cache.get(input.threadId) ?? null);
    }
    this.inFlight.add(input.threadId);
    const signal = input.signal ?? new AbortController().signal;
    return runBackgroundModelJob(signal, async () => {
      try {
        const summaryText = input.summarize
          ? await input.summarize(input.recentTurns)
          : buildStructuredWorkingCompaction(input.recentTurns);
        const snapshot: PrecomputedCompactionSnapshot = {
          threadId: input.threadId,
          coveredTurnCount: input.turnCount,
          summaryText: summaryText.trim(),
          computedAtMs: Date.now(),
          ...(input.usedTokens !== undefined ? { usedTokens: input.usedTokens } : {}),
        };
        this.cache.set(input.threadId, snapshot);
        return snapshot;
      } finally {
        this.inFlight.delete(input.threadId);
      }
    });
  }
}

export class BackgroundAutoCompactorService extends Context.Service<
  BackgroundAutoCompactorService,
  BackgroundAutoCompactor
>()("t3/orchestration/BackgroundAutoCompactor/BackgroundAutoCompactorService") {}

export const layer = Layer.effect(
  BackgroundAutoCompactorService,
  Effect.sync(() => new BackgroundAutoCompactor()),
);

const DECISION_CUE =
  /(?:때문에|이유로|사유로|문제로|덕분에|위해서|채택|결정|전환|고정|제한한다|정했다|하기로\s*했|선택했)/u;
const CONSTRAINT_OR_REJECTION_CUE =
  /(?:기각|제외하기로|보류|금지|하지\s*마|사용하지\s*않|절대\s*[^\s]+|안\s*하기로|불가)/u;
const OPEN_TASK_CUE = /(?:미해결|남은\s*작업|다음\s*단계|TODO|FIXME|확인\s*필요|진행\s*예정)/iu;

function capLine(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > maxChars ? `${single.slice(0, maxChars - 1)}…` : single;
}

/**
 * Context-preserving Working Memory Compactor:
 * Retains early user decisions + rationales, rejected alternatives/constraints,
 * and unresolved items across all turns before appending recent turn flow.
 */
export function buildStructuredWorkingCompaction(
  turns: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string {
  const decisions: string[] = [];
  const constraints: string[] = [];
  const openTasks: string[] = [];
  const seen = new Set<string>();

  for (const turn of turns) {
    const sentences = turn.text
      .split(/\n+|(?<=[.!?다요])\s+/u)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6);
    for (const sentence of sentences) {
      const normKey = sentence.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(normKey)) continue;
      if (CONSTRAINT_OR_REJECTION_CUE.test(sentence) && constraints.length < 6) {
        seen.add(normKey);
        constraints.push(`- [${turn.role}] ${capLine(sentence, 220)}`);
      } else if (DECISION_CUE.test(sentence) && decisions.length < 8) {
        seen.add(normKey);
        decisions.push(`- [${turn.role}] ${capLine(sentence, 240)}`);
      } else if (OPEN_TASK_CUE.test(sentence) && openTasks.length < 5) {
        seen.add(normKey);
        openTasks.push(`- [${turn.role}] ${capLine(sentence, 200)}`);
      }
    }
  }

  const recentBullets = turns
    .slice(-8)
    .map((turn) => `- [${turn.role}] ${capLine(turn.text, 160)}`);
  const sections: string[] = ["[사전 압축 맥락 요약]"];
  if (decisions.length > 0) {
    sections.push(`[확정 결정 및 이유]\n${decisions.join("\n")}`);
  }
  if (constraints.length > 0) {
    sections.push(`[기각된 대안 및 제약 조건]\n${constraints.join("\n")}`);
  }
  if (openTasks.length > 0) {
    sections.push(`[미해결 과제]\n${openTasks.join("\n")}`);
  }
  if (recentBullets.length > 0) {
    sections.push(`[최근 대화 흐름]\n${recentBullets.join("\n")}`);
  }
  return sections.join("\n\n");
}
