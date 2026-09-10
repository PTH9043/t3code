import type {
  ProviderExecutionContext,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  WorkspaceOrchestraBlock,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class WorkspaceAgentExecutionError extends Data.TaggedError("WorkspaceAgentExecutionError")<{
  readonly message: string;
  readonly interrupted?: boolean;
}> {}

export interface WorkspaceAgentExecutionInput {
  readonly execution: ProviderExecutionContext;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly cwd: string;
  readonly prompt: string;
  readonly title: string;
  readonly instruction?: string;
  readonly displayName: string;
  readonly role: WorkspaceOrchestraBlock["role"];
  readonly kind: WorkspaceOrchestraBlock["kind"];
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
