import type { PersonaTraitGenome } from "@t3tools/contracts";
import { sanitizeExternalPersonaText } from "@t3tools/shared/livingPersonaCompiler";
import { runBackgroundModelJob } from "../background/backgroundModelQueue.ts";

export interface DistilledRuleCandidate {
  readonly ruleText: string;
  readonly sourceEpisodes: number;
  readonly confidence: number;
}

export interface FewShotCandidate {
  readonly situation: string;
  readonly userSample: string;
  readonly assistantSample: string;
}

export interface PersonaReflectionResult {
  readonly personaId: string;
  readonly acceptedRules: ReadonlyArray<DistilledRuleCandidate>;
  readonly rejectedRules: ReadonlyArray<{ readonly ruleText: string; readonly reason: string }>;
  readonly synthesizedFewShots: ReadonlyArray<FewShotCandidate>;
}

export interface RunPersonaReflectionInput {
  readonly personaId: string;
  readonly traits: PersonaTraitGenome;
  readonly persistRule: (rule: DistilledRuleCandidate) => Promise<void> | void;
  readonly recentTurns: ReadonlyArray<{ readonly user: string; readonly assistant: string }>;
  /**
   * Optional async synthesizer backed by K-EXAONE (`k-exaone_v2.5`).
   * Falls back to deterministic local extraction when offline or omitted.
   */
  readonly synthesizeWithExaone?: (input: {
    readonly personaId: string;
    readonly recentTurns: ReadonlyArray<{ readonly user: string; readonly assistant: string }>;
  }) => Promise<{
    readonly rules: ReadonlyArray<DistilledRuleCandidate>;
    readonly fewShots: ReadonlyArray<FewShotCandidate>;
  }>;
  readonly minConfidence?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_MIN_CONFIDENCE = 0.72;

function fallbackDeterministicReflection(
  recentTurns: ReadonlyArray<{ readonly user: string; readonly assistant: string }>,
): {
  readonly rules: ReadonlyArray<DistilledRuleCandidate>;
  readonly fewShots: ReadonlyArray<FewShotCandidate>;
} {
  const rules: DistilledRuleCandidate[] = [];
  const fewShots: FewShotCandidate[] = [];

  for (const turn of recentTurns.slice(-5)) {
    const userTrim = turn.user.trim();
    const asstTrim = turn.assistant.trim();
    if (!userTrim || !asstTrim) continue;

    if (/반말|해체|편하게/.test(userTrim)) {
      rules.push({
        ruleText:
          "사용자가 반말·편한 호칭을 요청한 맥락에서는 존댓말 회귀 없이 일관된 어미를 유지한다.",
        sourceEpisodes: 1,
        confidence: 0.8,
      });
    } else if (/간결|짧게|핵심만/.test(userTrim)) {
      rules.push({
        ruleText:
          "핵심 요약을 요청할 때는 결론 1문장을 선두에 두고 근거를 불릿 3개 이내로 압축한다.",
        sourceEpisodes: 1,
        confidence: 0.78,
      });
    }

    if (fewShots.length < 2 && asstTrim.length <= 280) {
      fewShots.push({
        situation: "최근 검증된 대화 톤",
        userSample: userTrim.slice(0, 120),
        assistantSample: asstTrim.slice(0, 220),
      });
    }
  }

  return { rules, fewShots };
}

/**
 * Runs asynchronous reflection & Few-Shot synthesis on `backgroundModelQueue`,
 * filtering every distilled rule and sample through `scanPersonaSoulText` so
 * Layer 1 constitution invariants can never be weakened by learned memories.
 */
export function runPersonaReflectionJob(
  input: RunPersonaReflectionInput,
): Promise<PersonaReflectionResult> {
  const signal = input.signal ?? new AbortController().signal;
  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  return runBackgroundModelJob(signal, async () => {
    const raw = input.synthesizeWithExaone
      ? await input.synthesizeWithExaone({
          personaId: input.personaId,
          recentTurns: input.recentTurns,
        })
      : fallbackDeterministicReflection(input.recentTurns);

    const acceptedRules: DistilledRuleCandidate[] = [];
    const rejectedRules: Array<{ readonly ruleText: string; readonly reason: string }> = [];

    for (const candidate of raw.rules) {
      const text = candidate.ruleText.trim();
      if (!text) continue;
      if (candidate.confidence < minConfidence) {
        rejectedRules.push({ ruleText: text, reason: "low_confidence" });
        continue;
      }
      const scan = sanitizeExternalPersonaText(text);
      if (scan.strippedCount > 0) {
        rejectedRules.push({
          ruleText: text,
          reason: `constitution_guard:stripped_${scan.strippedCount}`,
        });
        continue;
      }
      await input.persistRule(candidate);
      acceptedRules.push(candidate);
    }

    const synthesizedFewShots = raw.fewShots.filter((shot) => {
      const scan = sanitizeExternalPersonaText(`${shot.userSample}\n${shot.assistantSample}`);
      return scan.strippedCount === 0;
    });

    return {
      personaId: input.personaId,
      acceptedRules,
      rejectedRules,
      synthesizedFewShots,
    };
  });
}
