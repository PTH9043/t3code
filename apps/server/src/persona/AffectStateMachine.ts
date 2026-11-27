import type { PersonaTraitGenome, SituationMode } from "@t3tools/contracts";
import { computePadBaseline, type PadVector } from "@t3tools/shared/livingPersonaCompiler";

export type DiscreteEmotionLabel =
  | "neutral"
  | "joy"
  | "pride"
  | "gratitude"
  | "relief"
  | "concern"
  | "frustration"
  | "alarm"
  | "fatigue_empathy"
  | "firm_resolve";

const EMOTION_PAD_DELTAS: Record<DiscreteEmotionLabel, PadVector> = {
  neutral: { p: 0, a: 0, d: 0 },
  joy: { p: 0.35, a: 0.18, d: 0.1 },
  pride: { p: 0.3, a: 0.15, d: 0.25 },
  gratitude: { p: 0.28, a: 0.05, d: 0.0 },
  relief: { p: 0.25, a: -0.2, d: 0.1 },
  concern: { p: -0.18, a: 0.15, d: 0.05 },
  frustration: { p: -0.28, a: 0.25, d: 0.1 },
  alarm: { p: -0.22, a: 0.35, d: 0.2 },
  fatigue_empathy: { p: 0.12, a: -0.22, d: 0.05 },
  firm_resolve: { p: -0.1, a: 0.1, d: 0.3 },
};

export interface ActiveImpulse {
  readonly label: DiscreteEmotionLabel;
  readonly intensity: number;
  readonly timestampMs: number;
}

export interface RuminationItem {
  readonly text: string;
  readonly importance: number;
  readonly turnsRemaining: number;
  readonly createdAtMs: number;
}

export interface PersonaAffectState {
  readonly personaId: string;
  readonly pad: PadVector;
  readonly activeImpulses: ReadonlyArray<ActiveImpulse>;
  readonly rumination: ReadonlyArray<RuminationItem>;
  readonly lastSituationMode: SituationMode;
  readonly lastUpdatedMs: number;
}

const HOUR_MS = 3_600_000;
const HABITUATION_WINDOW_MS = 15 * 60_000;
const SLEEP_THRESHOLD_MS = 6 * HOUR_MS;
const MAX_RUMINATION_ITEMS = 4;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function createInitialAffectState(
  personaId: string,
  ocean: PersonaTraitGenome["ocean"],
  nowMs: number,
): PersonaAffectState {
  return {
    personaId,
    pad: computePadBaseline(ocean),
    activeImpulses: [],
    rumination: [],
    lastSituationMode: "DEEP_WORK",
    lastUpdatedMs: nowMs,
  };
}

/**
 * On-demand lazy asymmetric decay + 6-hour `wake()` sleep compression (0 LLM calls).
 * Arousal decays ~4-10x faster than Pleasure and Dominance (Meng et al. 2026).
 */
export function decayAffectState(
  state: PersonaAffectState,
  ocean: PersonaTraitGenome["ocean"],
  nowMs: number,
): PersonaAffectState {
  const dtMs = Math.max(0, nowMs - state.lastUpdatedMs);
  if (dtMs === 0) return state;

  const base = computePadBaseline(ocean);
  const hours = dtMs / HOUR_MS;

  // Sleep compression when idle >= 6 hours: pull 70% toward baseline and clear short-term impulses.
  if (dtMs >= SLEEP_THRESHOLD_MS) {
    return {
      ...state,
      pad: {
        p: base.p + (state.pad.p - base.p) * 0.3,
        a: base.a + (state.pad.a - base.a) * 0.15,
        d: base.d + (state.pad.d - base.d) * 0.35,
      },
      activeImpulses: [],
      rumination: state.rumination
        .filter((item) => item.importance >= 7 && item.turnsRemaining > 0)
        .slice(0, MAX_RUMINATION_ITEMS),
      lastUpdatedMs: nowMs,
    };
  }

  const cMod = 1 + 0.25 * ocean.conscientiousness;
  const negNMod = 1 - 0.15 * Math.max(0, ocean.neuroticism);
  const lambdaA = 0.35 * cMod;
  const lambdaP = state.pad.p < base.p ? 0.08 * negNMod : 0.08;
  const lambdaD = 0.05;

  const recentImpulses = state.activeImpulses.filter(
    (imp) => nowMs - imp.timestampMs <= HABITUATION_WINDOW_MS,
  );

  return {
    ...state,
    pad: {
      p: base.p + (state.pad.p - base.p) * Math.exp(-lambdaP * hours),
      a: base.a + (state.pad.a - base.a) * Math.exp(-lambdaA * hours),
      d: base.d + (state.pad.d - base.d) * Math.exp(-lambdaD * hours),
    },
    activeImpulses: recentImpulses,
    lastUpdatedMs: nowMs,
  };
}

function tokenJaccard(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const sa = tok(a);
  const sb = tok(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Applies a discrete appraised emotion label with 15-min habituation (0.7^k),
 * elastic half-life damping, log10 compression, and 3-layer rumination circuit breaker.
 */
export function applyAffectImpulse(input: {
  readonly state: PersonaAffectState;
  readonly ocean: PersonaTraitGenome["ocean"];
  readonly label: DiscreteEmotionLabel;
  readonly intensity?: number;
  readonly situationMode: SituationMode;
  readonly ruminationCandidate?: { readonly text: string; readonly importance: number };
  readonly topicShift?: boolean;
  readonly nowMs: number;
}): PersonaAffectState {
  const decayed = decayAffectState(input.state, input.ocean, input.nowMs);
  const base = computePadBaseline(input.ocean);

  // Emotional firewall: during INCIDENT_RESPONSE, dampen emotional carryover & mute rumination.
  if (input.situationMode === "INCIDENT_RESPONSE") {
    return {
      ...decayed,
      pad: {
        p: base.p,
        a: clamp(base.a + 0.15, -0.8, 0.8),
        d: clamp(base.d + 0.2, -0.8, 0.8),
      },
      rumination: [],
      lastSituationMode: input.situationMode,
      lastUpdatedMs: input.nowMs,
    };
  }

  // Topic shift to neutral work dampens residual delta by 0.25x.
  const currentPad: PadVector = input.topicShift
    ? {
        p: base.p + (decayed.pad.p - base.p) * 0.25,
        a: base.a + (decayed.pad.a - base.a) * 0.25,
        d: base.d + (decayed.pad.d - base.d) * 0.25,
      }
    : decayed.pad;

  const sameRecentCount = decayed.activeImpulses.filter(
    (imp) => imp.label === input.label && input.nowMs - imp.timestampMs <= HABITUATION_WINDOW_MS,
  ).length;
  const habituation = Math.pow(0.7, sameRecentCount);
  const rawIntensity = clamp(input.intensity ?? 1.0, 0, 1);
  const compressed = Math.log10(1 + rawIntensity * 9) * habituation;
  const delta = EMOTION_PAD_DELTAS[input.label];

  const nextPad: PadVector = {
    p: clamp(currentPad.p + delta.p * compressed * (1 - Math.abs(currentPad.p)), -0.95, 0.95),
    a: clamp(currentPad.a + delta.a * compressed * (1 - Math.abs(currentPad.a)), -0.95, 0.95),
    d: clamp(currentPad.d + delta.d * compressed * (1 - Math.abs(currentPad.d)), -0.95, 0.95),
  };

  // Update rumination queue with 3-layer circuit breaker (max 4, >0.85 similarity dedup, decrement).
  let nextRumination = decayed.rumination
    .map((item) => ({ ...item, turnsRemaining: item.turnsRemaining - 1 }))
    .filter((item) => item.turnsRemaining > 0);

  if (
    input.ruminationCandidate &&
    input.ruminationCandidate.importance >= 7 &&
    input.ruminationCandidate.text.trim().length > 0
  ) {
    const candText = input.ruminationCandidate.text.trim();
    const isDuplicate = nextRumination.some((item) => tokenJaccard(item.text, candText) > 0.85);
    if (!isDuplicate) {
      nextRumination = [
        {
          text: candText,
          importance: input.ruminationCandidate.importance,
          turnsRemaining: MAX_RUMINATION_ITEMS,
          createdAtMs: input.nowMs,
        },
        ...nextRumination,
      ].slice(0, MAX_RUMINATION_ITEMS);
    }
  }

  return {
    personaId: decayed.personaId,
    pad: nextPad,
    activeImpulses: [
      ...decayed.activeImpulses,
      ...(input.label === "neutral"
        ? []
        : [{ label: input.label, intensity: rawIntensity, timestampMs: input.nowMs }]),
    ].slice(-20),
    rumination: nextRumination,
    lastSituationMode: input.situationMode,
    lastUpdatedMs: input.nowMs,
  };
}

export function padDeltaFromBaseline(
  pad: PadVector,
  ocean: PersonaTraitGenome["ocean"],
): PadVector {
  const base = computePadBaseline(ocean);
  return {
    p: pad.p - base.p,
    a: pad.a - base.a,
    d: pad.d - base.d,
  };
}
