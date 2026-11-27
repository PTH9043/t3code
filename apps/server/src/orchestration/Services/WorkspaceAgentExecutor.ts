import type {
  ProviderExecutionContext,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  WorkspaceOrchestraBlock,
  TokenUsagePhase,
  ProviderRuntimeEvent,
  ProviderTurnStartResult,
  ProviderSession,
  ThreadId,
  TurnId,
  SkillBinding,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class WorkspaceAgentExecutionError extends Data.TaggedError("WorkspaceAgentExecutionError")<{
  readonly message: string;
  readonly interrupted?: boolean;
  readonly timedOut?: boolean;
  readonly partialOutput?: string;
  readonly nonRetryable?: boolean;
  readonly errorCategory?: "timeout" | "billing" | "model_unavailable";
}> {}

export interface WorkspaceAgentExecutionInput {
  /** A workspace_delegate assignment owned by this ordinary-chat provider turn. */
  readonly delegatingTurnId?: TurnId;
  /** Only materialized graph tasks participate in the node-addressed mailbox. */
  readonly orchestraPhase?: "meeting" | "task" | "step";
  readonly usageWorkId?: string;
  readonly persistentSessionKey?: ThreadId;
  readonly resumeFromSessionKey?: ThreadId;
  readonly onBeforeSubmit?: Effect.Effect<void, WorkspaceAgentExecutionError>;
  readonly submitWithGate?: (
    submit: Effect.Effect<ProviderTurnStartResult, WorkspaceAgentExecutionError>,
  ) => Effect.Effect<ProviderTurnStartResult, WorkspaceAgentExecutionError>;
  readonly onSessionStarted?: (
    session: ProviderSession,
  ) => Effect.Effect<void, WorkspaceAgentExecutionError>;
  readonly onSessionStopped?: (
    confirmed: boolean,
  ) => Effect.Effect<void, WorkspaceAgentExecutionError>;
  readonly onInputAccepted?: (
    receipt: ProviderTurnStartResult,
  ) => Effect.Effect<void, WorkspaceAgentExecutionError>;
  readonly onRuntimeEvent?: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, WorkspaceAgentExecutionError>;
  /** Invoked whenever assistant output text grows so callers can preserve partial output on timeout. */
  readonly onPartialOutput?: (fullOutput: string) => void;
  readonly execution: ProviderExecutionContext;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly cwd: string;
  readonly prompt: string;
  readonly skills?: readonly SkillBinding[];
  readonly skillDriver?: string;
  readonly allowAdditionalSkillWorkers?: boolean;
  readonly title: string;
  readonly instruction?: string;
  readonly displayName: string;
  readonly role: WorkspaceOrchestraBlock["role"];
  readonly kind: WorkspaceOrchestraBlock["kind"];
  readonly usagePhase?: TokenUsagePhase;
  readonly startedAt: string;
}

export class WorkspaceAgentExecutor extends Context.Service<
  WorkspaceAgentExecutor,
  {
    readonly execute: (
      input: WorkspaceAgentExecutionInput,
    ) => Effect.Effect<string, WorkspaceAgentExecutionError>;
  }
>()("t3/orchestration/Services/WorkspaceAgentExecutor") {}
