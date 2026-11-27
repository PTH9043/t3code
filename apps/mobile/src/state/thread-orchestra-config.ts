import {
  WorkspaceMeetingParticipant,
  WorkspaceMeetingParticipantId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type WorkflowStart,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const MobileOrchestraConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  activationId: Schema.optional(Schema.String),
  executionMode: Schema.Literals(["once", "persistent"]),
  watchdogIntervalSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
  style: Schema.Literals(["collaboration", "meeting"]),
  askFirst: Schema.Boolean,
  reviewPlan: Schema.Boolean,
  participants: Schema.Array(WorkspaceMeetingParticipant),
  chairParticipantId: Schema.NullOr(WorkspaceMeetingParticipantId),
});
export type MobileOrchestraConfig = typeof MobileOrchestraConfigSchema.Type;

export const DEFAULT_MOBILE_ORCHESTRA_CONFIG: MobileOrchestraConfig = {
  enabled: false,
  executionMode: "once",
  style: "collaboration",
  askFirst: false,
  reviewPlan: false,
  participants: [],
  chairParticipantId: null,
};

export function createMobileOrchestraStart(input: {
  readonly config: MobileOrchestraConfig;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly currentModel: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly task: string;
  readonly requestId: string;
  readonly availableModels: ReadonlyArray<ModelSelection>;
}): { readonly start: WorkflowStart | null; readonly error: string | null } {
  const task = input.task.trim();
  if (!task || task.length > 20_000)
    return { start: null, error: "통합 작업 목표를 1~20,000자로 입력하세요." };
  const { config } = input;
  const chair = config.participants.find(
    (participant) => participant.id === config.chairParticipantId,
  );
  if (!chair) return { start: null, error: "통합 작업의 감독 AI를 지정하세요." };
  if (
    config.participants.some(
      (participant) =>
        !input.availableModels.some(
          (available) =>
            available.instanceId === participant.modelSelection.instanceId &&
            available.model === participant.modelSelection.model,
        ),
    )
  )
    return { start: null, error: "선택한 AI를 사용할 수 없습니다. 참가자 설정을 확인하세요." };
  if (
    new Set(config.participants.map((participant) => participant.id)).size !==
    config.participants.length
  )
    return { start: null, error: "참가자 구성이 중복되었습니다. 설정을 확인하세요." };
  const requestMode = config.askFirst ? "ask-first" : "direct";
  return {
    error: null,
    start: {
      projectId: input.projectId,
      threadId: input.threadId,
      task,
      userMessage: task,
      requestId: input.requestId,
      requestMode,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      meeting: {
        askFirst: config.askFirst,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        mode: "fixed-rounds",
        allowAdditionalWorkers: false,
        participants: config.participants,
        chairParticipantId: config.chairParticipantId,
        maxRounds: config.style === "collaboration" ? 0 : 2,
        maxRevisions: 1,
        userInLoop: false,
        threadId: input.threadId,
      },
      orchestra: {
        executionMode: config.executionMode,
        maxParallel: 3,
        isolateWorktrees: false,
        reviewPlan: config.reviewPlan,
        ...(config.executionMode === "persistent" && config.watchdogIntervalSeconds !== undefined
          ? { watchdogIntervalSeconds: config.watchdogIntervalSeconds }
          : {}),
        resumeAfterLimit: false,
        verificationCommands: [],
      },
    },
  };
}
