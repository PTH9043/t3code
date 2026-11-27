import {
  BUILTIN_CHIEF_OF_STAFF_ID,
  createInitialPresenceState,
  ZERO_VISEME_WEIGHTS,
  type AssistantExpressionKey,
  type AssistantGazeTarget,
  type AssistantInteractionMode,
  type AssistantPresenceState,
  type SituationMode,
  type VisemeWeights,
} from "@t3tools/contracts";

type PresenceListener = () => void;

/**
 * Dual-channel assistant presence store:
 * - High-frequency signals (`gazeTarget`, `visemeWeights`) mutate in place and
 *   are read directly by 60fps avatar render loops with zero React re-renders.
 * - Low-frequency semantic state (`mode`, `situation`, `expression`, `isWorking`,
 *   `activeSpeechText`) triggers React subscribers via `subscribe`.
 */
export class AssistantPresenceStore {
  private state: AssistantPresenceState;
  private readonly listeners = new Set<PresenceListener>();
  private lastCursorMoveMs = 0;

  constructor(personaId: string = BUILTIN_CHIEF_OF_STAFF_ID) {
    this.state = createInitialPresenceState(personaId);
  }

  getSnapshot = (): AssistantPresenceState => this.state;

  getLastCursorMoveMs = (): number => this.lastCursorMoveMs;

  subscribe = (listener: PresenceListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Low-frequency semantic patch (triggers React UI updates). */
  setSemanticState(patch: {
    readonly personaId?: string;
    readonly isWorking?: boolean;
    readonly mode?: AssistantInteractionMode;
    readonly situation?: SituationMode;
    readonly expression?: AssistantExpressionKey;
    readonly expressionWeight?: number;
    readonly activeSpeechText?: string | null;
  }): void {
    const cur = this.state;
    const personaId = patch.personaId ?? cur.personaId;
    const isWorking = patch.isWorking ?? cur.isWorking;
    const mode = patch.mode ?? cur.mode;
    const situation = patch.situation ?? cur.situation;
    const expression = patch.expression ?? cur.expression;
    const expressionWeight =
      patch.expressionWeight !== undefined &&
      Math.abs(patch.expressionWeight - cur.expressionWeight) > 0.01
        ? patch.expressionWeight
        : cur.expressionWeight;
    const activeSpeechText =
      patch.activeSpeechText !== undefined ? patch.activeSpeechText : cur.activeSpeechText;

    if (
      personaId === cur.personaId &&
      isWorking === cur.isWorking &&
      mode === cur.mode &&
      situation === cur.situation &&
      expression === cur.expression &&
      expressionWeight === cur.expressionWeight &&
      activeSpeechText === cur.activeSpeechText
    ) {
      return;
    }

    this.state = {
      ...cur,
      personaId,
      isWorking,
      mode,
      situation,
      expression,
      expressionWeight,
      ...(activeSpeechText !== undefined ? { activeSpeechText } : {}),
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** High-frequency pointer/camera gaze update (zero React re-renders). */
  setGazeTarget(target: AssistantGazeTarget, nowMs?: number): void {
    this.state = { ...this.state, gazeTarget: target };
    if (target.source === "cursor") {
      this.lastCursorMoveMs = nowMs ?? performance.now();
    }
  }

  /** High-frequency 60fps viseme weights update from AudioWorklet or phoneme mapper (zero React re-renders). */
  setVisemeWeights(weights: VisemeWeights): void {
    this.state = { ...this.state, visemeWeights: weights };
  }

  resetViseme(): void {
    this.state = { ...this.state, visemeWeights: ZERO_VISEME_WEIGHTS };
  }
}

export function createAssistantPresenceStore(
  personaId: string = BUILTIN_CHIEF_OF_STAFF_ID,
): AssistantPresenceStore {
  return new AssistantPresenceStore(personaId);
}
