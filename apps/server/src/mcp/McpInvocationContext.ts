import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { TurnDelegateTeam } from "../provider/subagentSelection.ts";

export type McpCapability = "preview";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sessionKey?: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly delegateTeam?: TurnDelegateTeam | undefined;
  /** Re-check the adapter's active turn before dispatching from a session-lifetime credential. */
  readonly activeDelegateTurnId?: Effect.Effect<TurnId | undefined> | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly executionCwd?: string;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
