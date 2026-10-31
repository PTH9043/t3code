import { ModelSelection, ProviderExecutionContext } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";
import type { WorkspaceAgentExecutionInput } from "./Services/WorkspaceAgentExecutor.ts";

const decodePayload = Schema.decodeUnknownOption(
  Schema.Struct({
    cwd: Schema.String,
    modelSelection: ModelSelection,
    execution: ProviderExecutionContext,
  }),
);

/** Only a stopped predecessor in this exact node/account/model can supply native history. */
export function workspaceRetryResumeCursor(
  binding: ProviderRuntimeBinding | undefined,
  input: WorkspaceAgentExecutionInput,
): unknown | undefined {
  if (
    !binding ||
    binding.status !== "stopped" ||
    binding.resumeCursor == null ||
    !["codex", "claudeAgent", "grok", "gemini", "cursor", "opencode"].includes(binding.provider) ||
    binding.providerInstanceId !== input.modelSelection.instanceId ||
    binding.runtimeMode !== input.runtimeMode
  )
    return undefined;
  const decoded = decodePayload(binding.runtimePayload);
  if (Option.isNone(decoded)) return undefined;
  const previous = decoded.value;
  const execution = input.execution;
  if (
    previous.cwd !== input.cwd ||
    stableStringify(previous.modelSelection) !== stableStringify(input.modelSelection) ||
    previous.execution.ownerThreadId !== execution.ownerThreadId ||
    previous.execution.runId !== execution.runId ||
    previous.execution.nodeId !== execution.nodeId ||
    previous.execution.attempt !== execution.attempt - 1
  )
    return undefined;
  return binding.resumeCursor;
}
