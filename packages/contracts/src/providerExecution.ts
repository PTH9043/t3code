import * as Schema from "effect/Schema";
import {
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
} from "./baseSchemas.ts";

export const ProviderExecutionId = TrimmedNonEmptyString.pipe(Schema.brand("ProviderExecutionId"));
export type ProviderExecutionId = typeof ProviderExecutionId.Type;

/** Several provider executions can contribute to one durable conversation. */
export const ProviderExecutionContext = Schema.Struct({
  executionId: ProviderExecutionId,
  ownerThreadId: ThreadId,
  runId: WorkspaceCollaborationRunId,
  nodeId: WorkspaceTaskNodeId,
  attempt: PositiveInt,
});
export type ProviderExecutionContext = typeof ProviderExecutionContext.Type;
