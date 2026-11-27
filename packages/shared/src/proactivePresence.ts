import type {
  AssistantChannelTransport,
  AssistantProactiveBriefingPayload,
  SituationMode,
  UnifiedBgTask,
} from "@t3tools/contracts";

export const DEFAULT_PROACTIVE_COOLDOWN_MS = 30 * 60_000;
export const DEFAULT_BG_STALL_BRIEF_MS = 65_000;

export interface ProactiveEventDecision {
  readonly shouldNotify: boolean;
  readonly reason:
    | "muted_incident_response"
    | "cooldown_active"
    | "disabled"
    | "bg_task_completed"
    | "bg_task_stalled"
    | "late_night_care"
    | "noop";
  readonly payload?: AssistantProactiveBriefingPayload;
  readonly suggestedSituation?: SituationMode;
}

export interface ProactivePresenceOptions {
  readonly cooldownMs?: number;
  readonly stallBriefMs?: number;
  readonly enabled?: boolean;
}

/**
 * Spam-guarded proactive presence controller (AIRI stage-tamagotchi + Warashi pattern).
 * Enforces:
 * 1) Minimum cooldown gate (default 30 min) for ambient chatter / late-night care.
 * 2) Complete mute of ambient chatter during `INCIDENT_RESPONSE`.
 * 3) Only 3 concrete triggers: background task completion, background task STALLED (>=65s),
 *    and late-night (01:00..05:00) consecutive error/rollback care.
 */
export class ProactivePresenceController {
  private readonly cooldownMs: number;
  private readonly stallBriefMs: number;
  private enabled: boolean;
  private lastAmbientAtMs = -Infinity;
  private readonly knownRunningTasks = new Map<string, { readonly title: string }>();
  private readonly notifiedStalledIds = new Set<string>();
  private readonly notifiedCompletedIds = new Set<string>();

  constructor(options?: ProactivePresenceOptions) {
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_PROACTIVE_COOLDOWN_MS;
    this.stallBriefMs = options?.stallBriefMs ?? DEFAULT_BG_STALL_BRIEF_MS;
    this.enabled = options?.enabled ?? true;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Observes current `UnifiedBgTask[]` snapshot from `OrchestrationThreadShell.backgroundTasks`
   * and returns at most one concise 1-sentence proactive briefing when a task finishes or stalls.
   */
  observeBackgroundTasks(input: {
    readonly personaId: string;
    readonly tasks: ReadonlyArray<UnifiedBgTask>;
    readonly situation: SituationMode;
    readonly nowMs: number;
  }): ProactiveEventDecision {
    if (!this.enabled) {
      return { shouldNotify: false, reason: "disabled" };
    }

    const currentIds = new Set<string>();
    let stalledCandidate: UnifiedBgTask | null = null;

    for (const task of input.tasks) {
      currentIds.add(task.taskId);
      this.knownRunningTasks.set(task.taskId, { title: task.title });
      const silentMs = Math.max(0, input.nowMs - task.lastProgressAtMs);
      if (
        (task.state === "STALLED" || silentMs >= this.stallBriefMs) &&
        !this.notifiedStalledIds.has(task.taskId)
      ) {
        stalledCandidate = task;
      }
    }

    // Detect tasks that disappeared from the live active set (= completed/settled).
    let completedCandidate: { readonly taskId: string; readonly title: string } | null = null;
    for (const [taskId, meta] of [...this.knownRunningTasks.entries()]) {
      if (!currentIds.has(taskId)) {
        this.knownRunningTasks.delete(taskId);
        this.notifiedStalledIds.delete(taskId);
        if (!this.notifiedCompletedIds.has(taskId)) {
          this.notifiedCompletedIds.add(taskId);
          completedCandidate = { taskId, title: meta.title };
        }
      }
    }

    // Background completion & STALLED alerts are operational briefings (allowed even during work,
    // except ambient chatter is still muted during INCIDENT_RESPONSE unless it's a STALLED alert).
    if (stalledCandidate) {
      this.notifiedStalledIds.add(stalledCandidate.taskId);
      const silentSec = Math.max(
        65,
        Math.floor((input.nowMs - stalledCandidate.lastProgressAtMs) / 1000),
      );
      return {
        shouldNotify: true,
        reason: "bg_task_stalled",
        payload: {
          personaId: input.personaId,
          summaryText: `백그라운드 작업 '${stalledCandidate.title}'이 ${silentSec}초째 새 출력이 없어 지연 의심 상태예요. 확인해 보실까요?`,
          speakAloud: true,
          sourceTaskId: stalledCandidate.taskId,
        },
      };
    }

    if (completedCandidate) {
      return {
        shouldNotify: true,
        reason: "bg_task_completed",
        payload: {
          personaId: input.personaId,
          summaryText: `백그라운드 작업 '${completedCandidate.title}'이 마무리되었어요. 결과를 확인해 주세요.`,
          speakAloud: true,
          sourceTaskId: completedCandidate.taskId,
        },
      };
    }

    return { shouldNotify: false, reason: "noop" };
  }

  /**
   * Evaluates late-night fatigue care (01:00~05:00 local hour + consecutive errors/rollbacks >= 2).
   * Strictly gated by `INCIDENT_RESPONSE` mute and the 30-minute ambient cooldown.
   */
  evaluateLateNightCare(input: {
    readonly personaId: string;
    readonly localHour: number;
    readonly consecutiveErrorCount: number;
    readonly situation: SituationMode;
    readonly nowMs: number;
  }): ProactiveEventDecision {
    if (!this.enabled) {
      return { shouldNotify: false, reason: "disabled" };
    }
    if (input.situation === "INCIDENT_RESPONSE") {
      return { shouldNotify: false, reason: "muted_incident_response" };
    }
    const isLateNight = input.localHour >= 1 && input.localHour < 5;
    if (!isLateNight || input.consecutiveErrorCount < 2) {
      return { shouldNotify: false, reason: "noop" };
    }
    if (input.nowMs - this.lastAmbientAtMs < this.cooldownMs) {
      return { shouldNotify: false, reason: "cooldown_active" };
    }
    this.lastAmbientAtMs = input.nowMs;
    return {
      shouldNotify: true,
      reason: "late_night_care",
      suggestedSituation: "LATE_NIGHT_CARE",
      payload: {
        personaId: input.personaId,
        summaryText:
          "새벽 시간대에 오류가 연달아 발생했어요. 잠시 숨 돌리고 체크포인트부터 안전하게 정리하실까요?",
        speakAloud: true,
      },
    };
  }
}

/** Default desktop UI channel transport implementation; future Discord/Telegram bridges share this contract. */
export class DesktopUiChannelTransport implements AssistantChannelTransport {
  readonly channelId = "desktop_ui" as const;
  private readonly handler: (payload: AssistantProactiveBriefingPayload) => void | Promise<void>;

  constructor(handler: (payload: AssistantProactiveBriefingPayload) => void | Promise<void>) {
    this.handler = handler;
  }

  async sendProactiveBriefing(payload: AssistantProactiveBriefingPayload): Promise<void> {
    await this.handler(payload);
  }
}
