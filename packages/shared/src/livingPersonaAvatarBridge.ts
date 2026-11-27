import type { AssistantExpressionKey, SituationMode } from "@t3tools/contracts";

export interface PadAffectSnapshot {
  readonly p: number;
  readonly a: number;
  readonly d: number;
  readonly situationMode?: SituationMode;
}

export type AvatarExpressionPreset =
  | "neutral"
  | "warm_smile"
  | "focused_firm"
  | "gentle_concern"
  | "alert_tense";

export interface AvatarAffectDirective {
  readonly expression: AvatarExpressionPreset;
  /** Canonical 6-key expression aligned with `AssistantPresenceState` / `PersonaAvatarExpressionKey`. */
  readonly canonicalExpression: AssistantExpressionKey;
  readonly live2dMotionHint: "idle" | "working" | "happy" | "firm" | "care";
  readonly livliv: {
    readonly expressionId: "smile" | "angry" | "sad" | "surprised" | null;
    readonly action: "nod" | "tilt" | "shy" | null;
    readonly smile: number;
  };
  readonly vrmBlendShapes: {
    readonly happy: number;
    readonly angry: number;
    readonly sad: number;
    readonly relaxed: number;
    readonly surprised: number;
  };
  readonly voiceProsody: {
    readonly rate: number;
    readonly pitch: number;
  };
  readonly statusLabel: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Maps current PAD affect coordinates and situation mode into deterministic
 * Live2D/VRM/LivLiv 2.5D expression weights and Web Speech API prosody bounds.
 */
export function resolveAvatarAffectDirective(affect: PadAffectSnapshot): AvatarAffectDirective {
  const { p, a, d, situationMode = "NORMAL" } = affect;

  if (situationMode === "INCIDENT_RESPONSE" || (p <= -0.35 && a >= 0.35)) {
    return {
      expression: "alert_tense",
      canonicalExpression: "urgent_focus",
      live2dMotionHint: "working",
      livliv: {
        expressionId: "surprised",
        action: "tilt",
        smile: 0,
      },
      vrmBlendShapes: {
        happy: 0,
        angry: clamp(0.25 + a * 0.25, 0, 0.55),
        sad: 0,
        relaxed: 0,
        surprised: clamp(0.3 + a * 0.3, 0, 0.7),
      },
      voiceProsody: {
        rate: clamp(1.06 + a * 0.08, 0.95, 1.18),
        pitch: clamp(0.98 - d * 0.04, 0.9, 1.05),
      },
      statusLabel: "긴급 집중",
    };
  }

  if (situationMode === "SUNK_COST_BRAKE" || (d >= 0.45 && p < 0.1)) {
    return {
      expression: "focused_firm",
      canonicalExpression: "firm_serious",
      live2dMotionHint: "firm",
      livliv: {
        expressionId: "angry",
        action: "nod",
        smile: 0,
      },
      vrmBlendShapes: {
        happy: 0,
        angry: clamp(0.2 + d * 0.2, 0, 0.45),
        sad: 0,
        relaxed: 0.1,
        surprised: 0,
      },
      voiceProsody: {
        rate: clamp(0.98 + a * 0.04, 0.92, 1.06),
        pitch: clamp(0.95 - d * 0.05, 0.88, 1.0),
      },
      statusLabel: "단호한 조언",
    };
  }

  if (situationMode === "LATE_NIGHT_CARE" || (p < 0 && a < 0)) {
    return {
      expression: "gentle_concern",
      canonicalExpression: "worried_care",
      live2dMotionHint: "care",
      livliv: {
        expressionId: "sad",
        action: "tilt",
        smile: 0.12,
      },
      vrmBlendShapes: {
        happy: 0.12,
        angry: 0,
        sad: clamp(0.2 + Math.abs(p) * 0.25, 0, 0.45),
        relaxed: 0.35,
        surprised: 0,
      },
      voiceProsody: {
        rate: clamp(0.93 + a * 0.04, 0.88, 0.98),
        pitch: clamp(0.98 + p * 0.03, 0.92, 1.02),
      },
      statusLabel: "차분한 배려",
    };
  }

  if (situationMode === "CELEBRATION" || p >= 0.3) {
    return {
      expression: "warm_smile",
      canonicalExpression: situationMode === "CELEBRATION" ? "proud_joy" : "warm_smile",
      live2dMotionHint: "happy",
      livliv: {
        expressionId: "smile",
        action: "nod",
        smile: clamp(0.45 + p * 0.45, 0.35, 0.95),
      },
      vrmBlendShapes: {
        happy: clamp(0.35 + p * 0.5, 0, 0.85),
        angry: 0,
        sad: 0,
        relaxed: clamp(0.25 + p * 0.25, 0, 0.5),
        surprised: clamp(Math.max(0, a) * 0.2, 0, 0.25),
      },
      voiceProsody: {
        rate: clamp(1.0 + a * 0.06, 0.96, 1.1),
        pitch: clamp(1.02 + p * 0.06, 0.98, 1.12),
      },
      statusLabel: situationMode === "CELEBRATION" ? "성과 축하" : "따뜻한 호응",
    };
  }

  return {
    expression: "neutral",
    canonicalExpression: "neutral",
    live2dMotionHint: "idle",
    livliv: {
      expressionId: null,
      action: null,
      smile: clamp(Math.max(0, p) * 0.3, 0, 0.25),
    },
    vrmBlendShapes: {
      happy: clamp(Math.max(0, p) * 0.3, 0, 0.25),
      angry: 0,
      sad: 0,
      relaxed: 0.3,
      surprised: 0,
    },
    voiceProsody: {
      rate: clamp(1.0 + a * 0.04, 0.95, 1.06),
      pitch: clamp(1.0 + p * 0.03, 0.95, 1.05),
    },
    statusLabel: "안정 대기",
  };
}
