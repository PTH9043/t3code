import type {
  AssistantExpressionKey,
  AssistantGazeTarget,
  AssistantInteractionMode,
  SituationMode,
  VisemeWeights,
} from "@t3tools/contracts";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface ProceduralLifeFrame {
  /** Normalized eye look direction in [-1, +1] (70% gaze lead). */
  readonly eyeX: number;
  readonly eyeY: number;
  /** Normalized head/upper-body follow in [-1, +1] (30% gaze lag). */
  readonly headX: number;
  readonly headY: number;
  readonly bodyX: number;
  /** Eye openness in [0, 1] (0 = closed, 1 = fully open). */
  readonly eyeOpen: number;
  /** Breath cycle in [0, 1] (~0.25 Hz sinusoidal chest/ParamBreath). */
  readonly breath: number;
  /** Smoothed 5-vowel viseme weights for Live2D/VRM/LivLiv mouth animation. */
  readonly viseme: VisemeWeights;
  /** Live2D-friendly collapsed mouth open & form parameters in [0, 1] / [-1, 1]. */
  readonly mouthOpenY: number;
  readonly mouthForm: number;
  /** Smoothed expression weight in [0, 1] (~300ms spring settle). */
  readonly expressionWeight: number;
  /** Current gaze source after 3s idle saccade transition. */
  readonly effectiveGazeSource: AssistantGazeTarget["source"];
  /** True on frames where a blink is actively closing/opening. */
  readonly isBlinking: boolean;
}

export interface FrameBudgetInput {
  readonly hidden: boolean;
  readonly reducedMotion: boolean;
  readonly mode: AssistantInteractionMode;
  readonly idlePowerSave30Fps: boolean;
}

/**
 * Returns the minimum frame interval (ms) or `null` when rendering must pause
 * completely (`document.hidden` -> 0fps, <1% CPU).
 */
export function resolveAvatarFrameIntervalMs(input: FrameBudgetInput): number | null {
  if (input.hidden) return null;
  if (input.reducedMotion) return null;
  const active =
    input.mode === "speaking" ||
    input.mode === "listening" ||
    input.mode === "thinking" ||
    input.mode === "alert_brake";
  if (active || !input.idlePowerSave30Fps) {
    return 1000 / 60; // ~16.67ms (60fps)
  }
  return 1000 / 30; // ~33.33ms (30fps idle power-save)
}

export interface OutOfBandExpressionHint {
  readonly expression: AssistantExpressionKey;
  readonly expressionWeight: number;
  readonly mode: AssistantInteractionMode;
  readonly prosodyDelta: { readonly rate: number; readonly pitch: number };
}

const ERROR_OR_REFUTATION_HEADER_RE =
  /(?:^|\n)\s*(?:#{1,4}\s*)?\[?(?:오류[·•/\s]*반증|경고|차단|장애|리스크\s*경고|FAIL|ERROR)\]?/iu;
const ADVICE_HEADER_RE = /(?:^|\n)\s*#{1,4}\s*\[?(?:비서실장의\s*조언|조언|권고)\]?/iu;
const REPORT_HEADER_RE = /(?:^|\n)\s*#{1,4}\s*\[?(?:보고|요약|결론|완료)\]?/iu;
const CELEBRATION_END_RE = /(?:성공|완료했습니다|통과했습니다|축하|해결했습니다)[!.~\s]*$/u;

/**
 * Non-invasive Out-of-Band expression inference (JChan2787/spindl & AIRI pattern).
 * Reads only structural Markdown headers, situation mode, and punctuation cadence —
 * never requires inline `[joy]`/`[anger]` bracket tags inside LLM output.
 */
export function inferOutOfBandExpression(input: {
  readonly situation: SituationMode;
  readonly mode: AssistantInteractionMode;
  readonly streamingText: string;
  readonly baseExpression?: AssistantExpressionKey;
}): OutOfBandExpressionHint {
  const { situation, mode } = input;
  const text = input.streamingText;

  if (situation === "INCIDENT_RESPONSE" || mode === "alert_brake") {
    return {
      expression: "urgent_focus",
      expressionWeight: 0.9,
      mode: mode === "idle" ? "alert_brake" : mode,
      prosodyDelta: { rate: 1.08, pitch: 0.96 },
    };
  }
  if (situation === "SUNK_COST_BRAKE") {
    return {
      expression: "firm_serious",
      expressionWeight: 0.85,
      mode,
      prosodyDelta: { rate: 0.97, pitch: 0.94 },
    };
  }
  if (situation === "LATE_NIGHT_CARE") {
    return {
      expression: "worried_care",
      expressionWeight: 0.78,
      mode,
      prosodyDelta: { rate: 0.92, pitch: 0.98 },
    };
  }
  if (situation === "CELEBRATION") {
    return {
      expression: "proud_joy",
      expressionWeight: 0.88,
      mode,
      prosodyDelta: { rate: 1.04, pitch: 1.06 },
    };
  }

  // Inspect only outside fenced code blocks so code comments never hijack expressions.
  const outsideCode = text.replace(/```[\s\S]*?(?:```|$)/gu, " ");

  if (ERROR_OR_REFUTATION_HEADER_RE.test(outsideCode)) {
    return {
      expression: "firm_serious",
      expressionWeight: 0.8,
      mode,
      prosodyDelta: { rate: 0.98, pitch: 0.95 },
    };
  }

  // Tail of stream enters closing advice -> warm attentive tone.
  const tailWindow = outsideCode.slice(-320);
  if (ADVICE_HEADER_RE.test(tailWindow)) {
    return {
      expression: "warm_smile",
      expressionWeight: 0.76,
      mode,
      prosodyDelta: { rate: 0.99, pitch: 1.02 },
    };
  }

  if (CELEBRATION_END_RE.test(tailWindow.trim())) {
    return {
      expression: "proud_joy",
      expressionWeight: 0.74,
      mode,
      prosodyDelta: { rate: 1.02, pitch: 1.04 },
    };
  }

  if (REPORT_HEADER_RE.test(outsideCode) && mode === "speaking") {
    return {
      expression: "neutral",
      expressionWeight: 0.65,
      mode,
      prosodyDelta: { rate: 1.0, pitch: 1.0 },
    };
  }

  return {
    expression: input.baseExpression ?? (mode === "listening" ? "warm_smile" : "neutral"),
    expressionWeight: mode === "listening" ? 0.68 : 0.6,
    mode,
    prosodyDelta: { rate: 1.0, pitch: 1.0 },
  };
}

export interface ProceduralLifeOptions {
  readonly stiffness?: number;
  readonly damping?: number;
  readonly cursorIdleMs?: number;
  readonly rng?: () => number;
}

const DEFAULT_STIFFNESS = 120;
const DEFAULT_DAMPING = 18;
const DEFAULT_CURSOR_IDLE_MS = 3_000;
const BLINK_DURATION_MS = 160;
const DOUBLE_BLINK_GAP_MS = 110;
const DOUBLE_BLINK_PROBABILITY = 0.12;
const GAZE_SHIFT_BLINK_THRESHOLD = 0.45;

/**
 * Deterministic-capable procedural life controller (Poisson/Gamma eye blink,
 * spring-damped gaze with 70% eye / 30% head-body parallax, 3s idle micro-saccade,
 * breathing oscillation, and 60fps viseme/expression smoothing).
 */
export class ProceduralLifeController {
  private readonly stiffness: number;
  private readonly damping: number;
  private readonly cursorIdleMs: number;
  private readonly rng: () => number;

  // Spring state for gaze (normalized [-1, 1])
  private gazeX = 0;
  private gazeY = 0;
  private velX = 0;
  private velY = 0;
  private headX = 0;
  private headY = 0;

  // Cursor / saccade tracking
  private lastCursorMoveMs = -10_000;
  private lastTargetX = 0;
  private lastTargetY = 0;
  private saccadeX = 0;
  private saccadeY = 0;
  private nextSaccadeAtMs = 1_400;

  // Blink state machine
  private nextBlinkAtMs: number;
  private blinkPhaseMs = -1;
  private pendingDoubleBlink = false;

  // Expression & viseme smoothing
  private currentExpressionWeight = 0.5;
  private lastExpression: AssistantExpressionKey = "neutral";
  private smoothedViseme: VisemeWeights = { a: 0, i: 0, u: 0, e: 0, o: 0, silence: 1 };

  // Elapsed time for breath cycle
  private elapsedSec = 0;

  constructor(options?: ProceduralLifeOptions) {
    this.stiffness = options?.stiffness ?? DEFAULT_STIFFNESS;
    this.damping = options?.damping ?? DEFAULT_DAMPING;
    this.cursorIdleMs = options?.cursorIdleMs ?? DEFAULT_CURSOR_IDLE_MS;
    this.rng = options?.rng ?? Math.random;
    this.nextBlinkAtMs = this.sampleNextBlinkIntervalMs();
  }

  /**
   * Samples an exponential/gamma-like blink interval centered around 3.8s,
   * clamped strictly to [1.8s, 6.5s].
   */
  sampleNextBlinkIntervalMs(): number {
    const u1 = Math.max(1e-6, this.rng());
    const u2 = Math.max(1e-6, this.rng());
    // Erlang(k=2) with mean 3.8s -> shape=2, scale=1.9s -> natural non-periodic feel.
    const rawSec = -1.9 * (Math.log(u1) + Math.log(u2));
    return clamp(rawSec, 1.8, 6.5) * 1_000;
  }

  /** Notify controller when the user actively moves the pointer. */
  notifyCursorMove(x: number, y: number, nowMs: number): void {
    const nx = clamp(x, -1, 1);
    const ny = clamp(y, -1, 1);
    const jump = Math.hypot(nx - this.lastTargetX, ny - this.lastTargetY);
    this.lastCursorMoveMs = nowMs;
    this.lastTargetX = nx;
    this.lastTargetY = ny;
    if (jump >= GAZE_SHIFT_BLINK_THRESHOLD && this.blinkPhaseMs < 0) {
      this.triggerBlink(false);
    }
  }

  private triggerBlink(allowDouble: boolean): void {
    this.blinkPhaseMs = 0;
    this.pendingDoubleBlink = allowDouble && this.rng() < DOUBLE_BLINK_PROBABILITY;
  }

  /**
   * Advances simulation by `dtMs` (clamped <= 50ms for numerical stability).
   * Designed to execute in < 0.05ms on the main thread (well inside 6.0ms budget).
   */
  step(input: {
    readonly dtMs: number;
    readonly nowMs: number;
    readonly mode: AssistantInteractionMode;
    readonly expression: AssistantExpressionKey;
    readonly expressionWeight: number;
    readonly gazeTarget: AssistantGazeTarget;
    readonly visemeWeights: VisemeWeights;
  }): ProceduralLifeFrame {
    const dtMs = clamp(input.dtMs, 0, 50);
    const dt = dtMs / 1_000;
    this.elapsedSec += dt;

    // 1. Trigger gaze-shift / expression-transition blink on major state change.
    if (input.expression !== this.lastExpression) {
      this.lastExpression = input.expression;
      if (this.blinkPhaseMs < 0) {
        this.triggerBlink(false);
      }
    }

    // 2. Determine target gaze: listening locks centered; active cursor tracks pointer;
    //    >= 3s stationary cursor switches smoothly to micro-saccade idle drift.
    let targetX = clamp(input.gazeTarget.x, -1, 1);
    let targetY = clamp(input.gazeTarget.y, -1, 1);
    let effectiveGazeSource: AssistantGazeTarget["source"] = input.gazeTarget.source;

    if (input.mode === "listening") {
      // Eye contact locked to center with subtle attentive nod offset.
      targetX = 0;
      targetY = 0.04 * Math.sin(this.elapsedSec * 4.2);
      effectiveGazeSource = "scripted";
    } else if (
      input.gazeTarget.source === "cursor" &&
      input.nowMs - this.lastCursorMoveMs >= this.cursorIdleMs
    ) {
      effectiveGazeSource = "saccade_idle";
    }

    if (effectiveGazeSource === "saccade_idle") {
      if (input.nowMs >= this.nextSaccadeAtMs) {
        this.saccadeX = (this.rng() * 2 - 1) * 0.28;
        this.saccadeY = (this.rng() * 2 - 1) * 0.16;
        this.nextSaccadeAtMs = input.nowMs + 1_200 + this.rng() * 2_400;
      }
      targetX = this.saccadeX;
      targetY = this.saccadeY;
    }

    // 3. Critically-damped spring integration (stiffness=120, damping=18) for gaze.
    const accX = this.stiffness * (targetX - this.gazeX) - this.damping * this.velX;
    const accY = this.stiffness * (targetY - this.gazeY) - this.damping * this.velY;
    this.velX += accX * dt;
    this.velY += accY * dt;
    this.gazeX = clamp(this.gazeX + this.velX * dt, -1, 1);
    this.gazeY = clamp(this.gazeY + this.velY * dt, -1, 1);

    // 70% immediate eye lead, 30% delayed head & upper-body follow.
    const headLerp = 1 - Math.exp(-5.5 * dt);
    this.headX += (this.gazeX - this.headX) * headLerp;
    this.headY += (this.gazeY - this.headY) * headLerp;

    const eyeX = clamp(this.gazeX * 0.7 + (this.gazeX - this.headX) * 0.3, -1, 1);
    const eyeY = clamp(this.gazeY * 0.7 + (this.gazeY - this.headY) * 0.3, -1, 1);
    const headX = clamp(this.headX * 0.3, -1, 1);
    const headY = clamp(this.headY * 0.3, -1, 1);
    const bodyX = clamp(this.headX * 0.18, -1, 1);

    // 4. Blink state machine (smooth ease-in/out over 160ms + 12% double blink).
    if (this.blinkPhaseMs < 0 && input.nowMs >= this.nextBlinkAtMs) {
      this.triggerBlink(true);
    }

    let eyeOpen = 1;
    let isBlinking = false;
    if (this.blinkPhaseMs >= 0) {
      this.blinkPhaseMs += dtMs;
      if (this.blinkPhaseMs < BLINK_DURATION_MS) {
        isBlinking = true;
        const progress = this.blinkPhaseMs / BLINK_DURATION_MS;
        // Fast close (0..0.42), softer open (0.42..1.0)
        eyeOpen = progress < 0.42 ? 1 - progress / 0.42 : (progress - 0.42) / 0.58;
        eyeOpen = clamp(eyeOpen, 0, 1);
      } else if (this.pendingDoubleBlink) {
        if (this.blinkPhaseMs >= BLINK_DURATION_MS + DOUBLE_BLINK_GAP_MS) {
          this.pendingDoubleBlink = false;
          this.blinkPhaseMs = 0;
        }
      } else {
        this.blinkPhaseMs = -1;
        this.nextBlinkAtMs = input.nowMs + this.sampleNextBlinkIntervalMs();
      }
    }

    // 5. Breathing oscillation (~0.24 Hz = ~4.2s per breath cycle)
    const breath = 0.5 + 0.5 * Math.sin(this.elapsedSec * Math.PI * 0.48);

    // 6. Expression weight smoothing (~300ms settle -> rate ~10/s)
    const exprLerp = 1 - Math.exp(-10 * dt);
    this.currentExpressionWeight +=
      (clamp(input.expressionWeight, 0, 1) - this.currentExpressionWeight) * exprLerp;

    // 7. 5-vowel viseme smoothing (snappy attack 28/s, smooth release 18/s)
    const vIn = input.visemeWeights;
    const smoothV = (cur: number, next: number) => {
      const rate = next > cur ? 28 : 18;
      return clamp(cur + (clamp(next, 0, 1) - cur) * (1 - Math.exp(-rate * dt)), 0, 1);
    };
    this.smoothedViseme = {
      a: smoothV(this.smoothedViseme.a, vIn.a),
      i: smoothV(this.smoothedViseme.i, vIn.i),
      u: smoothV(this.smoothedViseme.u, vIn.u),
      e: smoothV(this.smoothedViseme.e, vIn.e),
      o: smoothV(this.smoothedViseme.o, vIn.o),
      silence: smoothV(this.smoothedViseme.silence, vIn.silence),
    };

    const mouthOpenY = clamp(
      this.smoothedViseme.a * 1.0 +
        this.smoothedViseme.o * 0.78 +
        this.smoothedViseme.e * 0.58 +
        this.smoothedViseme.i * 0.34 +
        this.smoothedViseme.u * 0.3,
      0,
      1,
    );
    const mouthForm = clamp(
      this.smoothedViseme.i * 0.8 +
        this.smoothedViseme.e * 0.45 -
        this.smoothedViseme.u * 0.7 -
        this.smoothedViseme.o * 0.45,
      -1,
      1,
    );

    return {
      eyeX,
      eyeY,
      headX,
      headY,
      bodyX,
      eyeOpen,
      breath,
      viseme: this.smoothedViseme,
      mouthOpenY,
      mouthForm,
      expressionWeight: this.currentExpressionWeight,
      effectiveGazeSource,
      isBlinking,
    };
  }
}
