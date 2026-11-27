import type { PersonaTraitGenome, SituationMode } from "@t3tools/contracts";
import { runBackgroundModelJob } from "../background/backgroundModelQueue.ts";
import {
  applyAffectImpulse,
  createInitialAffectState,
  type DiscreteEmotionLabel,
  type PersonaAffectState,
} from "./AffectStateMachine.ts";

export interface PostTurnPersonaJobInput {
  readonly personaId: string;
  readonly ocean: PersonaTraitGenome["ocean"];
  readonly situationMode: SituationMode;
  readonly userText: string;
  readonly assistantText: string;
  readonly loadState: () => Promise<PersonaAffectState | null>;
  readonly saveState: (next: PersonaAffectState) => Promise<void>;
  readonly appraiseEmotion?: (input: {
    readonly userText: string;
    readonly assistantText: string;
  }) => Promise<{ readonly label: DiscreteEmotionLabel; readonly intensity: number }>;
  readonly extractMemories?: (input: {
    readonly userText: string;
    readonly assistantText: string;
  }) => Promise<void>;
  readonly signal?: AbortSignal;
}

function fallbackDiscreteAppraisal(mode: SituationMode): {
  readonly label: DiscreteEmotionLabel;
  readonly intensity: number;
} {
  switch (mode) {
    case "CELEBRATION":
      return { label: "joy", intensity: 0.7 };
    case "SUNK_COST_BRAKE":
      return { label: "firm_resolve", intensity: 0.8 };
    case "LATE_NIGHT_CARE":
      return { label: "fatigue_empathy", intensity: 0.6 };
    case "INCIDENT_RESPONSE":
      return { label: "alarm", intensity: 0.9 };
    default:
      return { label: "neutral", intensity: 0 };
  }
}

/**
 * Schedules post-turn PAD appraisal and atomic memory extraction onto the server's
 * serial `backgroundModelQueue`, keeping hot-path TTFT impact strictly 0ms.
 */
export function enqueuePostTurnPersonaUpdate(
  input: PostTurnPersonaJobInput,
): Promise<PersonaAffectState> {
  const signal = input.signal ?? new AbortController().signal;
  return runBackgroundModelJob(signal, async () => {
    const nowMs = Date.now();
    const current =
      (await input.loadState()) ?? createInitialAffectState(input.personaId, input.ocean, nowMs);
    const appraisal = input.appraiseEmotion
      ? await input.appraiseEmotion({
          userText: input.userText,
          assistantText: input.assistantText,
        })
      : fallbackDiscreteAppraisal(input.situationMode);

    const next = applyAffectImpulse({
      state: current,
      ocean: input.ocean,
      label: appraisal.label,
      intensity: appraisal.intensity,
      situationMode: input.situationMode,
      nowMs,
    });
    await input.saveState(next);
    if (input.extractMemories) {
      await input.extractMemories({
        userText: input.userText,
        assistantText: input.assistantText,
      });
    }
    return next;
  });
}
