import {
  CommandId,
  EventId,
  RuntimeRequestId,
  type MessageId,
  type ProviderExecutionContext,
  type ProviderRuntimeEvent,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

/** Apply provider activities with stable execution-scoped IDs for safe replay. */
export const projectWorkspaceAgentActivities = Effect.fn("projectWorkspaceAgentActivities")(
  function* (input: {
    readonly engine: OrchestrationEngineShape;
    readonly execution: ProviderExecutionContext;
    readonly messageId: MessageId;
    readonly event: ProviderRuntimeEvent;
    readonly foregroundTurnId?: TurnId;
  }) {
    const { engine, execution, event, messageId, foregroundTurnId } = input;
    const blockKey = `${execution.executionId}:${execution.attempt}`;
    const requestId = event.requestId;
    const { execution: _worker, ...foregroundEvent } = event;
    const presentationEvent = foregroundTurnId
      ? { ...foregroundEvent, turnId: foregroundTurnId }
      : event;
    const scopedEvent: ProviderRuntimeEvent =
      requestId === undefined
        ? presentationEvent
        : {
            ...presentationEvent,
            requestId: RuntimeRequestId.make(`${execution.executionId}:${requestId}`),
          };
    for (const activity of runtimeEventToActivities(scopedEvent)) {
      const payload =
        activity.payload !== null && typeof activity.payload === "object" ? activity.payload : {};
      const requestRoute =
        requestId !== undefined &&
        (activity.kind.startsWith("approval.") || activity.kind.startsWith("user-input."));
      yield* engine.dispatch({
        type: "thread.activity.append",
        threadId: execution.ownerThreadId,
        commandId: CommandId.make(`orchestra-activity:${blockKey}:${activity.id}`),
        createdAt: event.createdAt,
        activity: {
          ...activity,
          id: EventId.make(`orchestra:${blockKey}:${activity.id}`),
          turnId: foregroundTurnId ?? null,
          payload:
            foregroundTurnId && !requestRoute
              ? activity.payload
              : {
                  ...payload,
                  executionId: execution.executionId,
                  providerRequestId: requestId,
                  ...(!foregroundTurnId ? { messageId } : {}),
                },
        },
      });
    }
  },
);
