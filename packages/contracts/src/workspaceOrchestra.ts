import * as Schema from "effect/Schema";
import { ApprovalRequestId, MessageId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderExecutionContext } from "./providerExecution.ts";
import { TokenUsagePhase } from "./tokenUsage.ts";
import { ModelSelection, WorkspaceAgentRole, WorkspaceTaskNodeKind } from "./orchestration.ts";

/** Persisted block metadata; its streaming body is a normal message in the owning thread. */
export const WorkspaceOrchestraBlock = Schema.Struct({
  usageWorkId: Schema.optional(Schema.String),
  ...ProviderExecutionContext.fields,
  messageId: MessageId,
  title: TrimmedNonEmptyString,
  instruction: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
  displayName: TrimmedNonEmptyString,
  role: WorkspaceAgentRole,
  kind: WorkspaceTaskNodeKind,
  usagePhase: Schema.optionalKey(TokenUsagePhase),
  modelSelection: ModelSelection,
  status: Schema.Literals(["running", "completed", "failed", "cancelled", "awaiting-user"]),
});
export type WorkspaceOrchestraBlock = typeof WorkspaceOrchestraBlock.Type;

export const WorkspaceExecutionRequestRoute = Schema.Struct({
  requestId: ApprovalRequestId,
  executionId: ProviderExecutionContext.fields.executionId,
  providerRequestId: ApprovalRequestId,
});
