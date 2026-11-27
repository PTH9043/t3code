import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  type ChatAttachment,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  classifyTaskAgentKind,
  EventId,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { BackgroundAutoCompactorService } from "../BackgroundAutoCompactor.ts";
import {
  DEFAULT_PROACTIVE_COMPACT_THRESHOLD_TOKENS,
  evaluateProactiveCompactionDecision,
  extractCompactBoundaryTokens,
  formatCompactionSummaryLine,
  prepareCompactionMemoryCheckpoint,
} from "../ProactiveContextCompactor.ts";
import { WorkspaceMemory } from "../WorkspaceMemory.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import { activeWorkRegistry } from "../ActiveWorkTracker.ts";
import {
  DEFAULT_PERSONA_TRAIT_GENOME,
  resolveActivePersonaId,
  resolveEffectiveGlobalAssistant,
} from "@t3tools/contracts/settings";
import { auditPersonaDriftWindow } from "../../persona/PersonaDriftAuditor.ts";
import { runPersonaReflectionJob } from "../../persona/PersonaReflectionWorker.ts";
import { upsertLivingMemory } from "../../persona/LivingMemoryStore.ts";
import {
  EXAONE_QUESTION_ALREADY_SETTLED,
  matchesExaoneTextQuestions,
} from "../exaoneTextQuestions.ts";
import {
  asksThroughText,
  isTextQuestionTurn,
  parseStructuredTextQuestions,
  parseTextQuestions,
  textQuestionSummary,
} from "../textQuestions.ts";
import { compactActivityData } from "../activityDataCompaction.ts";
import { ThreadPlanProgressService } from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerConfig } from "../../config.ts";
import {
  collectGeneratedAttachments,
  nativeResultSources,
  type ResultSource,
} from "../../generatedResults.ts";
import { extractResultFileLinks } from "@t3tools/shared/generatedResults";
import { makeRecoveryDeliveryJournal } from "../recoveryDeliveryJournal.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`;

// Fallback when the in-memory description cache no longer has the task name
// (server restart, session-exit sweep, TTL/capacity eviction): earlier
// task.started/task.progress activities for the task are persisted with it.
function findTaskTitleInActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
  taskId: string,
): string | undefined {
  if (!activities) {
    return undefined;
  }
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || (activity.kind !== "task.started" && activity.kind !== "task.progress")) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as { taskId?: unknown; title?: unknown; detail?: unknown })
        : undefined;
    if (payload?.taskId !== taskId) {
      continue;
    }
    const title =
      typeof payload.title === "string"
        ? payload.title
        : activity.kind === "task.started" && typeof payload.detail === "string"
          ? payload.detail
          : undefined;
    if (title && title.trim().length > 0) {
      return title;
    }
  }
  return undefined;
}

interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000;
const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function hasAssistantMessageForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
  options?: { readonly streamingOnly?: boolean },
): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== "assistant" || message.turnId !== turnId) {
      continue;
    }
    if (options?.streamingOnly === true && !message.streaming) {
      continue;
    }
    return true;
  }
  return false;
}

function findMessageById(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): OrchestrationMessage | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.id === messageId) {
      return message;
    }
  }
  return undefined;
}

function findProposedPlanById(
  proposedPlans: ReadonlyArray<
    Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  >,
  planId: string,
):
  | Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  | undefined {
  for (let index = 0; index < proposedPlans.length; index += 1) {
    const proposedPlan = proposedPlans[index];
    if (proposedPlan?.id === planId) {
      return proposedPlan;
    }
  }
  return undefined;
}

function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }
  return false;
}

function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): number {
  let maxTurnCount = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
  }
  return maxTurnCount;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}
function buildContextWindowActivityPayload(event: ProviderRuntimeEvent):
  | (Partial<ThreadTokenUsageSnapshot> & {
      consumption?: import("@t3tools/contracts").TokenUsageObservation[];
    })
  | undefined {
  if (
    event.type !== "thread.token-usage.updated" ||
    ((event.payload.usage?.usedTokens ?? 0) <= 0 && !event.payload.consumption?.length)
  ) {
    return undefined;
  }
  return {
    ...event.payload.usage,
    ...(event.payload.consumption ? { consumption: [...event.payload.consumption] } : {}),
  };
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function sessionStatusAllowsActiveTurn(
  status: ReturnType<typeof orchestrationSessionStatusFromRuntimeState>,
): boolean {
  return status === "starting" || status === "running";
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

/**
 * Copies the optional TaskAgentLinkage bundle from a task.* runtime payload
 * into the persisted activity payload. Identity fields ride on every row so
 * client folds survive activity retention; absent fields stay absent.
 */
function taskLinkageActivityFields(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    // Server-stamped classification: persisted rows are self-describing, so
    // clients trust the stamp instead of re-deriving agent-vs-background
    // from taskType denylists and marker heuristics (legacy rows without a
    // stamp keep the client fallback).
    agentKind: classifyTaskAgentKind({
      taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    }),
  };
  for (const key of [
    "taskType",
    "agentId",
    "title",
    "role",
    "model",
    "effort",
    "toolUseId",
    "parentAgentId",
    "workflowName",
    "agentIndex",
    "phaseIndex",
    "phaseTitle",
    "phases",
    "attempt",
    "runHandles",
    "outputFile",
    "agentPath",
    "timelineBypass",
    "typedUsage",
    "status",
    "error",
  ] as const) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  return fields;
}

function toolActivityIdentity(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
) {
  return {
    provider: event.provider,
    ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
    ...(event.itemId ? { toolCallId: event.itemId } : {}),
    ...(event.payload.reportedModel ? { reportedModel: event.payload.reportedModel } : {}),
    ...(event.payload.status ? { status: event.payload.status } : {}),
    ...(event.execution
      ? { executionId: event.execution.executionId, attempt: event.execution.attempt }
      : {}),
  };
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskTitle?: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: truncateDetail(event.payload.message.trim(), 120) || "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.denied": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "tool.denied",
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.reason ? { detail: truncateDetail(event.payload.reason) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          // Use the adapter-supplied message as the row label so the work log
          // shows what the warning was about, not a generic "Runtime warning".
          summary: truncateDetail(event.payload.message, 120),
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: event.payload.reason ? "User input request closed" : "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
            ...(event.payload.reason ? { reason: event.payload.reason } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const linkage = taskLinkageActivityFields(event.payload as Record<string, unknown>);
      // Usage and activity are independent latest-state streams. Keeping them
      // under separate stable ids prevents a command/reasoning update from
      // replacing the last known token count (and prevents a usage-only tick
      // from blanking the last meaningful activity).
      const identityLinkage = { ...linkage };
      delete identityLinkage.typedUsage;
      delete identityLinkage.status;
      delete identityLinkage.error;
      const title =
        event.payload.description.trim().length > 0
          ? { title: truncateDetail(event.payload.description, 120) }
          : {};
      const hasProgressState =
        event.payload.typedUsage === undefined ||
        event.payload.summary !== undefined ||
        event.payload.lastToolName !== undefined ||
        event.payload.status !== undefined ||
        event.payload.error !== undefined;
      return [
        ...(hasProgressState
          ? [
              {
                // Stable per-task id: activity is "latest state", not
                // history, so each meaningful tick replaces the last. This
                // bounds a large fleet to one activity row per task.
                id: EventId.make(`task-progress:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary:
                  event.payload.description.trim().length > 0
                    ? truncateDetail(event.payload.description, 120)
                    : "Reasoning update",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  detail: truncateDetail(event.payload.summary ?? event.payload.description),
                  ...(event.payload.summary
                    ? { summary: truncateDetail(event.payload.summary) }
                    : {}),
                  ...(event.payload.lastToolName
                    ? { lastToolName: event.payload.lastToolName }
                    : {}),
                  ...(event.payload.status ? { status: event.payload.status } : {}),
                  ...(event.payload.error ? { error: event.payload.error } : {}),
                  ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
                  ...identityLinkage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
        ...(event.payload.typedUsage !== undefined
          ? [
              {
                id: EventId.make(`task-usage:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary: "Task usage updated",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  ...identityLinkage,
                  usageSnapshot: true,
                  typedUsage: event.payload.typedUsage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
      ];
    }

    case "task.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status
                ? `Task ${event.payload.status}`
                : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.endedAt ? { endedAt: event.payload.endedAt } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      // Only agent-owned heartbeats are persisted: they feed the owning
      // agent's activity line. Parent-conversation tool progress stays
      // ephemeral (item lifecycle already covers it).
      if (event.payload.taskId === undefined) {
        return [];
      }
      return [
        {
          // Same stable-id treatment as task.progress: a heartbeat is
          // "what is this agent doing right now", so one row per task
          // (thread-scoped for the same global-PK collision reason).
          id: EventId.make(`tool-progress:${event.threadId}:${event.payload.taskId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: "tool.progress",
          summary: event.payload.toolName ?? "Tool progress",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(taskTitle ? { title: truncateDetail(taskTitle, 120) } : {}),
            // summary + detail mirror task.progress: clients label the row from
            // summary and keep detail for the preview/expanded body.
            ...(event.payload.summary
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary),
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }
      const { preTokens, postTokens } = extractCompactBoundaryTokens(event.payload.detail);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: formatCompactionSummaryLine(preTokens, postTokens),
          payload: {
            state: event.payload.state,
            ...(preTokens !== undefined ? { preTokens } : {}),
            ...(postTokens !== undefined ? { postTokens } : {}),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            ...toolActivityIdentity(event),
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: compactActivityData(event.payload.data) }
              : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            ...toolActivityIdentity(event),
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined
              ? { data: compactActivityData(event.payload.data) }
              : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            ...toolActivityIdentity(event),
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.gen(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const threadPlanProgress = yield* ThreadPlanProgressService;
  const autoCompactorOpt = yield* Effect.serviceOption(BackgroundAutoCompactorService);
  const workspaceMemoryOpt = yield* Effect.serviceOption(WorkspaceMemory);
  const lastContextUsageByThreadId = new Map<
    ThreadId,
    {
      readonly usedTokens: number;
      readonly inputTokens: number | undefined;
      readonly maxTokens: number | undefined;
    }
  >();
  const lastProactiveCompactedTurnByThreadId = new Map<ThreadId, TurnId>();
  const lastDriftAuditedTurnCount = new Map<ThreadId, number>();
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const sql = yield* SqlClient.SqlClient;
  const recoveryDelivery = makeRecoveryDeliveryJournal(sql);
  const serverSettingsService = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const providerCommandId = (event: ProviderRuntimeEvent, tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`provider:${event.eventId}:${tag}:${uuid}`)),
    );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  // Task names arrive on task.started/task.progress but not on task.completed,
  // so remember them per task to title the completion activity.
  const taskDescriptionByTaskKey = yield* Cache.make<string, string>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () => Effect.succeed(""),
  });

  const rememberTaskDescription = (threadId: ThreadId, taskId: string, description: string) =>
    Cache.set(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId), description);

  // Entries are left in place after completion so replayed or duplicate
  // terminal events stay titled; TTL, capacity, and the session-exit sweep
  // bound the cache.
  const lookupTaskDescription = (threadId: ThreadId, taskId: string) =>
    Cache.getOption(taskDescriptionByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.map((description) =>
        Option.filter(description, (value) => value.length > 0).pipe(Option.getOrUndefined),
      ),
    );

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadRuntimeContext(threadId, {
        messages: true,
        proposedPlans: true,
        activityKinds: ["task.started", "task.progress"],
      })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadShell = Effect.fn("resolveThreadShell")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
  ) => Cache.set(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId), state);

  const clearAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const getActiveAssistantMessageIdForTurn = (threadId: ThreadId, turnId: TurnId) =>
    getAssistantSegmentStateForTurn(threadId, turnId).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
  }) =>
    getAssistantSegmentStateForTurn(input.threadId, input.turnId).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0),
            }),
            onSome: (state) => {
              const segmentIndex = state.baseKey === input.baseKey ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: state.baseKey === input.baseKey ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState);
          return nextState.activeMessageId!;
        }),
      ),
    );

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(input.event), 0);
      }

      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isSome(activeMessageId)) {
        return activeMessageId.value;
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: assistantSegmentBaseKeyFromEvent(input.event),
      });
    });

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const flushBufferedAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: yield* providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      const flushedMessageIds = new Set<MessageId>();
      yield* Effect.forEach(
        assistantMessageIds,
        (messageId) =>
          flushBufferedAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
          }).pipe(
            Effect.tap((flushed) =>
              flushed ? Effect.sync(() => flushedMessageIds.add(messageId)) : Effect.void,
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      return flushedMessageIds;
    });

  const collectMessageResults = Effect.fn("collectMessageResults")(function* (input: {
    threadId: ThreadId;
    messageId: MessageId;
    turnId: string;
    text?: string;
    sources?: ReadonlyArray<ResultSource>;
  }) {
    if (!input.sources?.length && extractResultFileLinks(input.text ?? "").length === 0)
      return undefined;
    const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(input.threadId);
    if (Option.isNone(context)) return undefined;
    const collected = yield* Effect.tryPromise(() =>
      collectGeneratedAttachments({
        ...input,
        workspaceRoot: context.value.worktreePath ?? context.value.workspaceRoot,
        attachmentsDir: serverConfig.attachmentsDir,
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not collect generated results", { cause }).pipe(
          Effect.as({ attachments: [] as ChatAttachment[], failures: [] as string[] }),
        ),
      ),
    );
    if (collected.failures.length > 0)
      yield* Effect.logWarning("Some generated results could not be collected", {
        failures: collected.failures,
      });
    if (collected.attachments.length === 0) return undefined;
    const detail = yield* resolveThreadDetail(input.threadId);
    const existing =
      detail?.messages.find((message) => message.id === input.messageId)?.attachments ?? [];
    const merged = [...existing];
    for (const attachment of collected.attachments) {
      if (!merged.some((entry) => entry.id === attachment.id)) merged.push(attachment);
    }
    return merged.length > 0 ? merged : undefined;
  });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    previousText?: string | undefined;
    hasProjectedMessage?: boolean;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";
      const hasRenderableText = hasRenderableAssistantText(text);

      if (hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: yield* providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      const attachments = yield* collectMessageResults({
        threadId: input.threadId,
        messageId: input.messageId,
        turnId: input.turnId ?? String(input.messageId),
        text: (input.previousText ?? "") + text,
      });
      if (input.hasProjectedMessage || hasRenderableText || attachments?.length) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* providerCommandId(input.event, input.commandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(attachments ? { attachments } : {}),
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveAssistantSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
  }) =>
    Effect.gen(function* () {
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      const segmentThread = yield* resolveThreadDetail(input.threadId);
      yield* finalizeAssistantMessage({
        previousText: segmentThread?.messages.find(
          (message) => message.id === activeMessageId.value,
        )?.text,
        event: input.event,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage:
          input.hasProjectedMessage ||
          (input.flushedMessageIds?.has(activeMessageId.value) ?? false),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, {
          ...state.value,
          activeMessageId: null,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = findProposedPlanById(input.threadProposedPlans, input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: yield* providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      const taskDescriptionKeys = Array.from(yield* Cache.keys(taskDescriptionByTaskKey));
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        taskDescriptionKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(taskDescriptionByTaskKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const sourceThread = yield* resolveThreadDetail(sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      const commandUuid = yield* crypto.randomUUIDv4;
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${commandUuid}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadShell(event.threadId);
      if (!thread) return;

      let loadedThreadDetail: OrchestrationThread | null | undefined;
      const getLoadedThreadDetail = () =>
        Effect.gen(function* () {
          if (loadedThreadDetail !== undefined) {
            return loadedThreadDetail;
          }
          loadedThreadDetail = (yield* resolveThreadDetail(thread.id)) ?? null;
          return loadedThreadDetail;
        });

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
        threadId: thread.id,
      });
      const hasPendingTurnStart =
        Option.isSome(pendingTurnStart) && thread.session?.status === "starting";

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      // A turn.started that conflicts with the active turn is legitimate when
      // the server itself has a turn start pending for this thread AND the
      // provider session already tracks the event's turn as its active turn:
      // steering a running turn makes some providers (e.g. opencode) open a
      // new turn without ever completing the superseded one. A stale
      // turn.started for some other turn id still gets rejected.
      const conflictingTurnStartIsPendingTurnStart =
        event.type === "turn.started" && conflictsWithActiveTurn
          ? sameId(yield* getExpectedProviderTurnIdForThread(thread.id), eventTurnId) &&
            Option.isSome(pendingTurnStart)
          : false;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn || conflictingTurnStartIsPendingTurnStart;
          case "turn.completed":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const status = (() => {
          switch (event.type) {
            case "session.state.changed": {
              const runtimeStatus = orchestrationSessionStatusFromRuntimeState(event.payload.state);
              return hasPendingTurnStart && runtimeStatus === "ready" ? "starting" : runtimeStatus;
            }
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active or pending turn; preserve that lifecycle state.
              return activeTurnId !== null ? "running" : hasPendingTurnStart ? "starting" : "ready";
          }
        })();
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : event.type === "session.state.changed" &&
                  !sessionStatusAllowsActiveTurn(
                    orchestrationSessionStatusFromRuntimeState(event.payload.state),
                  )
                ? null
                : activeTurnId;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });

          if (event.type === "turn.started" && eventTurnId) {
            const startedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
            activeWorkRegistry.register({
              kind: "turn",
              id: thread.id,
              threadId: thread.id,
              summary: `${event.provider}:${eventTurnId}`,
              startedAtMs,
            });
            const pendingMessageId = Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.messageId
              : null;
            // Blocking adapters (e.g. Antigravity ACP `session/prompt`) emit
            // `turn.started` right after accepting the prompt but do not return
            // from `sendTurn()` until the entire turn finishes. Confirm delivery
            // immediately so a restart mid-turn never strands the journal row in
            // `'sending'` -> `'unknown'`.
            yield* recoveryDelivery
              .acceptForStartedTurn({
                threadId: thread.id,
                turnId: eventTurnId,
                messageId: pendingMessageId,
                now,
              })
              .pipe(Effect.ignoreCause({ log: true }));
            if (pendingMessageId?.startsWith("recovered-question-")) {
              // Providers whose `sendTurn()` blocks until the whole turn finishes
              // (e.g. Antigravity ACP `session/prompt`) emit `turn.started` right
              // after accepting the prompt. Settle the recovered text-question card
              // immediately using the same deterministic command IDs that
              // ProviderCommandReactor uses after `sendTurn()` returns so the card
              // closes right away without duplicating events.
              yield* Effect.gen(function* () {
                const snapshot = yield* projectionSnapshotQuery.getThreadRuntimeContext(thread.id, {
                  activityKinds: [
                    "provider.user-input.recovery.queued",
                    "provider.user-input.delivery.started",
                    "provider.user-input.delivery.finished",
                    "user-input.resolved",
                  ],
                });
                if (Option.isNone(snapshot)) return;
                const activities = snapshot.value.activities;
                const queued = activities.findLast((activity) => {
                  const payload = activity.payload as {
                    messageId?: unknown;
                    requestId?: unknown;
                    answers?: unknown;
                  } | null;
                  return (
                    activity.kind === "provider.user-input.recovery.queued" &&
                    payload?.messageId === pendingMessageId &&
                    typeof payload.requestId === "string" &&
                    payload.answers !== null &&
                    typeof payload.answers === "object"
                  );
                });
                if (!queued) return;
                const queuedPayload = queued.payload as {
                  requestId: string;
                  answers: Record<string, unknown>;
                };
                const requestId = queuedPayload.requestId;
                const finishedAttempts = new Set(
                  activities
                    .filter((activity) => {
                      const payload = activity.payload as {
                        requestId?: unknown;
                        attemptId?: unknown;
                      } | null;
                      return (
                        activity.kind === "provider.user-input.delivery.finished" &&
                        payload?.requestId === requestId &&
                        typeof payload.attemptId === "string"
                      );
                    })
                    .map((activity) => (activity.payload as { attemptId: string }).attemptId),
                );
                const openDelivery = activities.findLast((activity) => {
                  const payload = activity.payload as {
                    requestId?: unknown;
                    attemptId?: unknown;
                  } | null;
                  return (
                    activity.kind === "provider.user-input.delivery.started" &&
                    payload?.requestId === requestId &&
                    typeof payload.attemptId === "string" &&
                    !finishedAttempts.has(payload.attemptId)
                  );
                });
                if (openDelivery) {
                  const attemptId = (openDelivery.payload as { attemptId: string }).attemptId;
                  yield* orchestrationEngine.dispatch({
                    type: "thread.activity.append",
                    commandId: CommandId.make(`recovered-delivery-accepted:${attemptId}`),
                    threadId: thread.id,
                    createdAt: now,
                    activity: {
                      id: EventId.make(`recovered-delivery-accepted:${attemptId}`),
                      kind: "provider.user-input.delivery.finished",
                      tone: "info",
                      summary: "복구한 질문 답변 전송 확인",
                      payload: {
                        requestId,
                        attemptId,
                        outcome: "accepted",
                      },
                      turnId: null,
                      createdAt: now,
                    },
                  });
                }
                const alreadyResolved = activities.some((activity) => {
                  const payload = activity.payload as { requestId?: unknown } | null;
                  return (
                    activity.kind === "user-input.resolved" && payload?.requestId === requestId
                  );
                });
                if (!alreadyResolved) {
                  yield* orchestrationEngine.dispatch({
                    type: "thread.activity.append",
                    commandId: CommandId.make(`recover-question-resolved:${pendingMessageId}`),
                    threadId: thread.id,
                    createdAt: now,
                    activity: {
                      id: EventId.make(`recover-question-resolved:${pendingMessageId}`),
                      kind: "user-input.resolved",
                      tone: "info",
                      summary: "재연결 후 질문 답변을 전달했습니다",
                      payload: {
                        requestId,
                        answers: queuedPayload.answers,
                        recovered: true,
                      },
                      turnId: null,
                      createdAt: now,
                    },
                  });
                }
              }).pipe(Effect.ignoreCause({ log: true }));
            }

            const startedModel = event.payload?.model?.trim();
            const startedInstanceId =
              event.providerInstanceId ?? thread.session?.providerInstanceId;
            if (startedModel) {
              yield* orchestrationEngine
                .dispatch({
                  type: "thread.activity.append",
                  commandId: yield* providerCommandId(event, "turn-assigned"),
                  threadId: thread.id,
                  createdAt: now,
                  activity: {
                    id: EventId.make(`turn-assigned:${eventTurnId}`),
                    kind: "conversation.turn-assigned",
                    tone: "info",
                    summary: "이번 요청에 지정한 모델",
                    payload: {
                      ...(startedInstanceId ? { instanceId: startedInstanceId } : {}),
                      model: startedModel,
                    },
                    turnId: eventTurnId,
                    createdAt: now,
                  },
                })
                .pipe(Effect.ignoreCause({ log: true }));
            }
          }
        }
      }

      if (event.type === "item.completed" && event.payload.status !== "failed") {
        const sources = nativeResultSources(event.payload.data);
        if (sources.length > 0) {
          const messageId = MessageId.make(
            "assistant:result:" +
              (event.turnId ?? event.eventId) +
              ":" +
              (event.itemId ?? event.eventId),
          );
          const attachments = yield* collectMessageResults({
            threadId: thread.id,
            messageId,
            turnId: String(event.turnId ?? event.eventId),
            sources,
          });
          if (attachments?.length)
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.complete",
              commandId: yield* providerCommandId(event, "generated-results"),
              threadId: thread.id,
              messageId,
              attachments,
              ...(eventTurnId ? { turnId: eventTurnId } : {}),
              createdAt: now,
            });
        }
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableLegacyTokenStreaming ? "streaming" : "buffered"),
        );
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: yield* providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: yield* providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" || event.type === "user-input.requested"
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        const detailedThread = yield* getLoadedThreadDetail();
        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableLegacyTokenStreaming ? "streaming" : "buffered"),
        );
        const flushedMessageIds =
          assistantDeliveryMode === "buffered"
            ? yield* flushBufferedAssistantMessagesForTurn({
                event,
                threadId: thread.id,
                turnId: pauseForUserTurnId,
                createdAt: now,
                commandTag:
                  event.type === "request.opened"
                    ? "assistant-delta-flush-on-request-opened"
                    : "assistant-delta-flush-on-user-input-requested",
              })
            : new Set<MessageId>();
        yield* finalizeActiveAssistantSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage:
            detailedThread !== null &&
            hasAssistantMessageForTurn(detailedThread.messages, pauseForUserTurnId, {
              streamingOnly: true,
            }),
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const turnId = toTurnId(event.turnId);
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const hasAssistantMessagesForTurn =
          turnId !== undefined ? hasAssistantMessageForTurn(messages, turnId) : false;
        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );
        const existingAssistantMessage = findMessageById(messages, assistantMessageId);
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;

        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          hasAssistantMessagesForTurn &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

        if (!shouldSkipRedundantCompletion) {
          if (turnId && Option.isNone(activeAssistantMessageId)) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            hasProjectedMessage: existingAssistantMessage !== undefined,
            previousText: existingAssistantMessage?.text,
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });

          if (turnId) {
            yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
        }

        if (turnId) {
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        }
      }

      if (proposedPlanCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: detailedThread?.proposedPlans ?? [],
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed") {
        activeWorkRegistry.unregister("turn", thread.id);
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const proposedPlans = detailedThread?.proposedPlans ?? [];
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                hasProjectedMessage: findMessageById(messages, assistantMessageId) !== undefined,
                previousText: findMessageById(messages, assistantMessageId)?.text,
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          const normalizedTurnState = normalizeRuntimeTurnState(event.payload.state);
          const isCompletedTurn = normalizedTurnState === "completed";
          const isInterruptedTurn =
            normalizedTurnState === "interrupted" || normalizedTurnState === "cancelled";
          const completedTurn =
            event.provider === "opencode" &&
            shouldApplyThreadLifecycle &&
            (isCompletedTurn || isInterruptedTurn)
              ? yield* projectionTurnRepository.getByTurnId({ threadId: thread.id, turnId })
              : Option.none();
          // Antigravity asks through text on every model; OpenCode only on the EXAONE models.
          let wasTextQuestionTurn = isTextQuestionTurn(event.provider, undefined);
          if (
            event.provider === "opencode" &&
            Option.isSome(completedTurn) &&
            completedTurn.value.pendingMessageId
          ) {
            const selections = yield* sql<{ model: string | null }>`
              SELECT json_extract(payload_json, ${"$.modelSelection.model"}) AS model
              FROM orchestration_events
              WHERE aggregate_kind = ${"thread"} AND stream_id = ${thread.id} AND event_type = ${"thread.turn-start-requested"}
                AND json_extract(payload_json, ${"$.messageId"}) = ${completedTurn.value.pendingMessageId}
              ORDER BY sequence DESC LIMIT 1
            `;
            wasTextQuestionTurn = isTextQuestionTurn(event.provider, selections[0]?.model);
          }
          if (
            shouldApplyThreadLifecycle &&
            (isCompletedTurn || isInterruptedTurn) &&
            wasTextQuestionTurn
          ) {
            const snapshot = yield* projectionSnapshotQuery.getThreadRuntimeContext(thread.id, {
              messages: true,
              activityKinds: ["user-input.requested"],
            });
            if (Option.isSome(snapshot)) {
              const detail = snapshot.value;
              const nativeQuestion = detail.activities.some(
                (activity) =>
                  activity.kind === "user-input.requested" && sameId(activity.turnId, turnId),
              );
              const message = detail.messages.findLast(
                (entry) => entry.role === "assistant" && sameId(entry.turnId, turnId),
              );
              const isLatestThreadMessage =
                message !== undefined && detail.messages.at(-1)?.id === message.id;
              const questions =
                message && !nativeQuestion
                  ? isCompletedTurn
                    ? parseTextQuestions(event.provider, message.text)
                    : isLatestThreadMessage
                      ? parseStructuredTextQuestions(event.provider, message.text)
                      : null
                  : null;
              if (questions) {
                const requestId = "text-question:" + turnId;
                yield* orchestrationEngine.dispatch({
                  type: "thread.activity.append",
                  commandId: CommandId.make("text-question-open:" + thread.id + ":" + turnId),
                  threadId: thread.id,
                  createdAt: now,
                  activity: {
                    id: EventId.make("text-question-open:" + thread.id + ":" + turnId),
                    kind: "user-input.requested",
                    tone: "info",
                    summary: textQuestionSummary(event.provider),
                    payload: { requestId, questions },
                    turnId,
                    createdAt: now,
                  },
                });
              }
            }
          }
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });

          // Background Auto-Compaction (Track 2) & Living Persona Drift/Reflection (Track 4)
          // Both run asynchronously off the hot path via `backgroundModelQueue` (0ms turn stall).
          if (isCompletedTurn && shouldApplyThreadLifecycle && messages.length > 0) {
            if (Option.isSome(autoCompactorOpt)) {
              const ctxUsage = lastContextUsageByThreadId.get(thread.id);
              const usedTokens = ctxUsage?.usedTokens;
              const actualInputTokens = ctxUsage?.inputTokens ?? usedTokens;
              const maxTokens = ctxUsage?.maxTokens;
              const estimatedContextRatio =
                usedTokens !== undefined && maxTokens !== undefined && maxTokens > 0
                  ? usedTokens / maxTokens
                  : 0;
              const turnCount = messages.filter((m) => m.role === "user").length;
              const recentTurns = messages.slice(-16).map((m) => ({ role: m.role, text: m.text }));

              // Wave 3-B2: Turn-boundary proactive compaction (never mid-turn, actual inputTokens).
              if (event.provider === "claudeAgent") {
                const currentSettings = yield* serverSettingsService.getSettings.pipe(
                  Effect.orElseSucceed(() => undefined),
                );
                const claudeCfg = currentSettings?.providers?.claudeAgent;
                const decision = evaluateProactiveCompactionDecision({
                  turnId,
                  turnStatus: normalizedTurnState,
                  actualInputTokens,
                  enabled: claudeCfg?.proactiveCompactEnabled !== false,
                  threadDisabled:
                    currentSettings?.threadProactiveCompactDisabled?.[thread.id] === true,
                  thresholdTokens:
                    claudeCfg?.proactiveCompactThresholdTokens ??
                    DEFAULT_PROACTIVE_COMPACT_THRESHOLD_TOKENS,
                  lastCompactedTurnId: lastProactiveCompactedTurnByThreadId.get(thread.id),
                });
                if (decision.shouldCompact) {
                  lastProactiveCompactedTurnByThreadId.set(thread.id, turnId);
                  const checkpoint = prepareCompactionMemoryCheckpoint({
                    threadId: thread.id,
                    turns: recentTurns,
                    actualInputTokens: decision.actualInputTokens,
                  });
                  // 1. Pre-save key decisions/constraints/open tasks into WorkspaceMemory
                  if (Option.isSome(workspaceMemoryOpt)) {
                    yield* workspaceMemoryOpt.value
                      .invoke(
                        {
                          projectId: thread.projectId,
                          action: "remember",
                          requestId: `compact-${turnId}`,
                          topic: "proactive-compaction-checkpoint",
                          text: checkpoint.memoryNote.slice(0, 8_000),
                        },
                        { threadId: thread.id },
                      )
                      .pipe(Effect.ignore);
                  }
                  // 2. Prime BackgroundAutoCompactor snapshot for 0ms clean handoff on next turn
                  autoCompactorOpt.value.setSnapshot({
                    threadId: thread.id,
                    coveredTurnCount: turnCount,
                    summaryText: checkpoint.summaryText,
                    computedAtMs: Date.parse(now) || 0,
                    usedTokens: decision.actualInputTokens,
                  });
                  // 3. Reset session cleanly at the completed turn boundary so the next turn
                  //    starts fresh with the preserved checkpoint (zero mid-turn disruption).
                  yield* providerService.stopSession({ threadId: thread.id }).pipe(Effect.ignore);
                  // 4. Emit single-line Korean record in thread timeline (no popups/focus theft)
                  yield* orchestrationEngine
                    .dispatch({
                      type: "thread.activity.append",
                      commandId: yield* providerCommandId(event, "proactive-context-compacted"),
                      threadId: thread.id,
                      activity: {
                        id: EventId.make(yield* crypto.randomUUIDv4),
                        tone: "info",
                        kind: "context-compaction",
                        summary: formatCompactionSummaryLine(
                          decision.actualInputTokens,
                          checkpoint.estimatedPostTokens,
                        ),
                        payload: {
                          state: "compacted",
                          trigger: "proactive_turn_boundary",
                          preTokens: decision.actualInputTokens,
                          postTokens: checkpoint.estimatedPostTokens,
                          thresholdTokens: decision.thresholdTokens,
                          savedToMemory: Option.isSome(workspaceMemoryOpt),
                        },
                        turnId,
                        createdAt: now,
                      },
                      createdAt: now,
                    })
                    .pipe(Effect.ignore);
                }
              }

              if (
                autoCompactorOpt.value.shouldPrecompute({
                  threadId: thread.id,
                  turnCount,
                  estimatedContextRatio,
                  usedTokens: actualInputTokens,
                })
              ) {
                void autoCompactorOpt.value
                  .schedulePrecompute({
                    threadId: thread.id,
                    turnCount,
                    estimatedContextRatio,
                    usedTokens: actualInputTokens,
                    recentTurns,
                  })
                  .catch(() => undefined);
              }
            }

            const assistantMsgs = messages.filter(
              (m) => m.role === "assistant" && m.text.trim().length > 0,
            );
            const auditedCount = lastDriftAuditedTurnCount.get(thread.id) ?? 0;
            if (assistantMsgs.length >= 5 && assistantMsgs.length - auditedCount >= 5) {
              const currentSettings = yield* serverSettingsService.getSettings.pipe(
                Effect.orElseSucceed(() => undefined),
              );
              const effectiveGlobal = currentSettings
                ? resolveEffectiveGlobalAssistant(currentSettings)
                : undefined;
              if (effectiveGlobal?.enabled && effectiveGlobal.enableLivingAffectEngine !== false) {
                lastDriftAuditedTurnCount.set(thread.id, assistantMsgs.length);
                const personaId = resolveActivePersonaId(effectiveGlobal);
                const traits = effectiveGlobal.traitGenome ?? DEFAULT_PERSONA_TRAIT_GENOME;
                const voiceText = effectiveGlobal.voiceAndTone ?? "";
                const primaryLevel = /반말|해체/u.test(voiceText)
                  ? ("casual_banmal" as const)
                  : /하십시오체|격식체/u.test(voiceText) && !/해요체/u.test(voiceText)
                    ? ("formal_hapsipsio" as const)
                    : ("polite_haeyo" as const);
                const forbiddenEndings =
                  primaryLevel === "polite_haeyo" && /관료체|군대식|하십시오/u.test(voiceText)
                    ? ["하십시오", "사료됩니다", "권고드립니다"]
                    : [];
                const driftReport = auditPersonaDriftWindow({
                  personaId,
                  register: {
                    primaryLevel,
                    userTitle: "",
                    selfReference: "",
                    preferredEndings: [],
                    forbiddenEndings,
                  },
                  turns: assistantMsgs.slice(-5).map((m) => ({
                    turnId: m.turnId ?? m.id,
                    assistantText: m.text,
                  })),
                });
                const recentPairs: Array<{ readonly user: string; readonly assistant: string }> =
                  [];
                for (let i = Math.max(0, messages.length - 10); i < messages.length - 1; i += 1) {
                  const u = messages[i];
                  const a = messages[i + 1];
                  if (u?.role === "user" && a?.role === "assistant") {
                    recentPairs.push({ user: u.text, assistant: a.text });
                  }
                }
                if (!driftReport.healthy && driftReport.correctiveHint) {
                  void Effect.runPromise(
                    upsertLivingMemory({
                      scope: "persona_isolated",
                      personaId,
                      memoryKind: "discriminative_rule",
                      contentDistilled: driftReport.correctiveHint,
                      importance: 7,
                    }).pipe(
                      Effect.provideService(SqlClient.SqlClient, sql),
                      Effect.orElseSucceed(() => undefined),
                    ),
                  ).catch(() => undefined);
                }
                if (recentPairs.length > 0) {
                  void runPersonaReflectionJob({
                    personaId,
                    traits,
                    recentTurns: recentPairs,
                    persistRule: (rule) =>
                      Effect.runPromise(
                        upsertLivingMemory({
                          scope: "persona_isolated",
                          personaId,
                          memoryKind: "discriminative_rule",
                          contentDistilled: rule.ruleText,
                          importance: Math.round(Math.max(5, Math.min(9, rule.confidence * 10))),
                        }).pipe(
                          Effect.provideService(SqlClient.SqlClient, sql),
                          Effect.orElseSucceed(() => undefined),
                        ),
                      ).then(() => undefined),
                  }).catch(() => undefined);
                }
              }
            }
          }
        }
      }

      if (event.type === "thread.token-usage.updated" && event.payload.usage) {
        const usedTokens = event.payload.usage.usedTokens;
        const inputTokens =
          typeof event.payload.usage.inputTokens === "number" &&
          Number.isFinite(event.payload.usage.inputTokens) &&
          event.payload.usage.inputTokens > 0
            ? event.payload.usage.inputTokens
            : undefined;
        if (typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens > 0) {
          lastContextUsageByThreadId.set(thread.id, {
            usedTokens,
            inputTokens,
            maxTokens:
              typeof event.payload.usage.maxTokens === "number" &&
              Number.isFinite(event.payload.usage.maxTokens)
                ? event.payload.usage.maxTokens
                : undefined,
          });
        }
      }

      if (event.type === "session.exited") {
        lastContextUsageByThreadId.delete(thread.id);
        lastDriftAuditedTurnCount.delete(thread.id);
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;
        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
        if (turnId && checkpointContext && workspaceCwd && isGitRepository(workspaceCwd)) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) {
            // Already tracked; no-op.
          } else {
            const assistantMessageId = MessageId.make(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: yield* providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
              status: "missing",
              files: [],
              assistantMessageId,
              checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
              createdAt: now,
            });
          }
        }
      }

      if (event.type === "task.started" || event.type === "task.progress") {
        const description = event.payload.description?.trim();
        if (description) {
          yield* rememberTaskDescription(thread.id, event.payload.taskId, description);
        }
      }
      // Working-indicator plan progress: current step while the turn runs,
      // cleared on settle so a finished plan never lingers as stale UI.
      // Events carrying a turn id that conflicts with the active turn are
      // stale (superseded turn) and must neither overwrite nor clear the
      // active turn's progress; session.exited always clears.
      if (event.type === "session.exited") {
        threadPlanProgress.clearThreadPlanProgress(thread.id);
      } else if (!conflictsWithActiveTurn) {
        if (event.type === "turn.plan.updated") {
          threadPlanProgress.recordPlanProgress(thread.id, event.payload.plan);
        } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
          threadPlanProgress.clearThreadPlanProgress(thread.id);
        }
      }

      // Sidebar background liveness: fed from the same lifecycle stream,
      // read by the shell query at mapping time (no persistence).
      switch (event.type) {
        case "task.started":
        case "task.progress":
        case "task.updated":
        case "task.completed": {
          const payload = event.payload as {
            taskId: string;
            taskType?: string;
            status?: string;
            agentId?: string;
            title?: string;
            description?: string;
            summary?: string;
            lastToolName?: string;
          };
          const summaryText = payload.summary?.trim() ?? "";
          const descriptionText = payload.description?.trim() ?? "";
          const explicitTitle = payload.title?.trim() ?? "";
          const toolName = payload.lastToolName?.trim() ?? "";
          const effectiveTitle =
            explicitTitle || (event.type === "task.started" ? descriptionText : "");
          const logSource = summaryText || (event.type !== "task.started" ? descriptionText : "");
          const logTail =
            toolName && logSource
              ? `[${toolName}] ${logSource}`.slice(0, 240)
              : logSource
                ? logSource.slice(0, 240)
                : toolName
                  ? `[${toolName}] 실행 중`
                  : undefined;
          const proofPrefix =
            payload.taskType === "local_bash" || payload.taskType === "shell"
              ? "shell"
              : payload.taskType === "monitor"
                ? "monitor"
                : payload.agentId
                  ? "agent"
                  : "task";
          threadBackgroundLiveness.recordTaskLiveness({
            threadId: thread.id,
            taskId: payload.taskId,
            taskType: payload.taskType,
            status: payload.status,
            agentId: payload.agentId,
            provider: event.provider,
            turnId: eventTurnId ?? null,
            proofHandle: `${proofPrefix}:${payload.taskId}`,
            ...(effectiveTitle ? { title: effectiveTitle } : {}),
            ...(logTail !== undefined ? { logTail } : {}),
            kind:
              event.type === "task.started"
                ? "started"
                : event.type === "task.progress"
                  ? "progress"
                  : event.type === "task.updated"
                    ? "updated"
                    : "completed",
          });
          break;
        }
        case "session.exited":
          activeWorkRegistry.unregister("turn", thread.id);
          threadBackgroundLiveness.clearThreadLiveness(thread.id);
          break;
        default:
          break;
      }

      let taskTitle: string | undefined;
      if (event.type === "task.completed") {
        taskTitle = yield* lookupTaskDescription(thread.id, event.payload.taskId);
        if (!taskTitle) {
          const threadDetail = yield* getLoadedThreadDetail();
          taskTitle = findTaskTitleInActivities(threadDetail?.activities, event.payload.taskId);
        }
      }

      let deferNativeQuestion = false;
      if (
        event.type === "user-input.requested" &&
        asksThroughText(event.provider) &&
        !eventTurnId
      ) {
        const detail = yield* projectionSnapshotQuery
          .getThreadRuntimeContext(thread.id, {
            activityKinds: ["user-input.requested", "provider.user-input.duplicate.deferred"],
          })
          .pipe(Effect.map(Option.getOrUndefined));
        const requestIds = [
          ...new Set(
            (detail?.activities ?? []).flatMap((activity) => {
              const payload = activity.payload as { requestId?: unknown } | null;
              const requestId = payload?.requestId;
              return activity.kind === "user-input.requested" &&
                typeof requestId === "string" &&
                requestId.startsWith("text-question:") &&
                matchesExaoneTextQuestions(activity.payload, requestId, event.payload.questions)
                ? [requestId]
                : [];
            }),
          ),
        ];
        if (requestIds.length > 0) {
          const alreadyRecorded =
            event.requestId !== undefined &&
            detail?.activities.some(
              (activity) =>
                activity.kind === "provider.user-input.duplicate.deferred" &&
                (activity.payload as { nativeRequestId?: unknown } | null)?.nativeRequestId ===
                  event.requestId,
            );
          if (!alreadyRecorded) {
            yield* orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: yield* providerCommandId(event, "defer-turnless-native-question"),
              threadId: thread.id,
              createdAt: now,
              activity: {
                id: EventId.make("defer-turnless-native-question:" + event.eventId),
                kind: "provider.user-input.duplicate.deferred",
                tone: "info",
                summary: "기존 질문과 같은 네이티브 질문의 출처를 확인하지 못했습니다",
                payload: {
                  requestId: requestIds[0],
                  requestIds,
                  nativeRequestId: event.requestId ?? null,
                  questions: event.payload.questions,
                  detail:
                    "질문의 턴을 확인할 수 없어 중복 답변을 보내지 않았습니다. 기존 답변과 실행 상태를 확인해 주세요.",
                },
                turnId: null,
                createdAt: now,
              },
            });
          }
          deferNativeQuestion = true;
        }
      }
      if (event.type === "user-input.requested" && asksThroughText(event.provider) && eventTurnId) {
        const fallbackId = "text-question:" + eventTurnId;
        const detail = yield* projectionSnapshotQuery
          .getThreadRuntimeContext(thread.id, {
            activityKinds: [
              "user-input.requested",
              "user-input.resolved",
              "provider.user-input.recovery.queued",
              "provider.user-input.delivery.started",
              "provider.user-input.duplicate.deferred",
            ],
          })
          .pipe(Effect.map(Option.getOrUndefined));
        const fallback = detail?.activities.find(
          (activity) =>
            activity.kind === "user-input.requested" &&
            sameId(activity.turnId, eventTurnId) &&
            matchesExaoneTextQuestions(activity.payload, fallbackId, event.payload.questions),
        );
        const markers =
          detail?.activities.filter((activity) => {
            const payload = activity.payload as { requestId?: unknown; reason?: unknown } | null;
            return (
              payload?.requestId === fallbackId &&
              (activity.kind === "provider.user-input.recovery.queued" ||
                activity.kind === "provider.user-input.delivery.started" ||
                (activity.kind === "user-input.resolved" && payload.reason !== "superseded"))
            );
          }) ?? [];
        const alreadyRecorded =
          event.requestId !== undefined &&
          detail?.activities.some((activity) => {
            const payload = activity.payload as {
              requestId?: unknown;
              nativeRequestId?: unknown;
            } | null;
            return (
              (activity.kind === "user-input.requested" &&
                payload?.requestId === event.requestId) ||
              (activity.kind === "provider.user-input.duplicate.deferred" &&
                payload?.nativeRequestId === event.requestId)
            );
          });
        let shouldDefer = markers.length > 0;
        if (fallback && !alreadyRecorded && !shouldDefer) {
          const closedAt = fallback.createdAt > now ? fallback.createdAt : now;
          const superseded = yield* orchestrationEngine
            .dispatch({
              type: "thread.activity.append",
              commandId: yield* providerCommandId(event, "supersede-text-question"),
              threadId: thread.id,
              createdAt: closedAt,
              activity: {
                id: EventId.make("supersede-text-question:" + event.eventId),
                kind: "user-input.resolved",
                tone: "info",
                summary: "네이티브 질문으로 전환",
                payload: { requestId: fallbackId, answers: {}, reason: "superseded" },
                turnId: eventTurnId,
                createdAt: closedAt,
              },
            })
            .pipe(
              Effect.as(true),
              Effect.catch((error) => {
                const expected =
                  (error._tag === "OrchestrationCommandInvariantError" &&
                    error.detail === EXAONE_QUESTION_ALREADY_SETTLED) ||
                  (error._tag === "OrchestrationCommandPreviouslyRejectedError" &&
                    error.detail.endsWith(EXAONE_QUESTION_ALREADY_SETTLED));
                return expected ? Effect.succeed(false) : Effect.fail(error);
              }),
            );
          shouldDefer = !superseded;
        }
        if (fallback && alreadyRecorded) {
          deferNativeQuestion = true;
        } else if (fallback && shouldDefer) {
          const deferredAt = fallback.createdAt > now ? fallback.createdAt : now;
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(event, "defer-duplicate-native-question"),
            threadId: thread.id,
            createdAt: deferredAt,
            activity: {
              id: EventId.make("defer-duplicate-native-question:" + event.eventId),
              kind: "provider.user-input.duplicate.deferred",
              tone: "info",
              summary: "제출된 답변과 같은 네이티브 질문이 보류됐습니다",
              payload: {
                requestId: fallbackId,
                nativeRequestId: event.requestId ?? null,
                questions: event.payload.questions,
                detail: "중복 답변을 보내지 않았습니다. 기존 답변과 실행 상태를 확인해 주세요.",
              },
              turnId: eventTurnId,
              createdAt: deferredAt,
            },
          });
          deferNativeQuestion = true;
        }
      }

      const activities = deferNativeQuestion ? [] : runtimeEventToActivities(event, taskTitle);
      yield* Effect.forEach(activities, (activity) =>
        providerCommandId(event, "thread-activity-append").pipe(
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: thread.id,
              activity,
              createdAt: activity.createdAt,
            }),
          ),
        ),
      ).pipe(Effect.asVoid);
    });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  // Restore unanswered text questions produced before this compatibility path existed.
  const restoreExaoneTextQuestions = Effect.fn("restoreExaoneTextQuestions")(function* () {
    const rows = yield* sql<{
      thread_id: string;
      turn_id: string;
      text: string;
      turn_state: string;
      provider: string | null;
    }>`
      SELECT t.thread_id, m.turn_id, m.text, u.state AS turn_state,
        (SELECT s.provider_name FROM projection_thread_sessions s
         WHERE s.thread_id = t.thread_id) AS provider
      FROM projection_threads t
      JOIN projection_thread_messages m ON m.message_id = (
        SELECT x.message_id FROM projection_thread_messages x
        WHERE x.thread_id = t.thread_id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1
      )
      JOIN projection_turns u ON u.thread_id = t.thread_id AND u.turn_id = m.turn_id
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
        AND t.pending_user_input_count = 0
        AND m.role = ${"assistant"} AND m.is_streaming = 0 AND m.turn_id IS NOT NULL
        AND u.state IN (${"completed"}, ${"interrupted"})
        AND EXISTS (
          SELECT 1 FROM orchestration_events e
          WHERE e.aggregate_kind = ${"thread"} AND e.stream_id = t.thread_id
            AND e.event_type = ${"thread.turn-start-requested"}
            AND json_extract(e.payload_json, ${"$.messageId"}) = u.pending_message_id
            AND (json_extract(e.payload_json, ${"$.modelSelection.model"}) LIKE ${"t3_exaone/%"}
              OR EXISTS (
                SELECT 1 FROM projection_thread_sessions s
                WHERE s.thread_id = t.thread_id AND s.provider_name = ${"gemini"}
              ))
        )
        AND (instr(m.text, ${'"questions"'}) > 0 OR instr(m.text, ${"[1]"}) > 0)
        AND NOT EXISTS (
          SELECT 1 FROM projection_thread_activities a
          WHERE a.thread_id = t.thread_id AND a.turn_id = m.turn_id
            AND a.kind = ${"user-input.requested"}
        )
    `;
    for (const row of rows) {
      // The query matches an EXAONE turn by its model; any other row is an Antigravity thread.
      const provider = row.provider === "gemini" ? "gemini" : "opencode";
      const questions =
        row.turn_state === "completed"
          ? parseTextQuestions(provider, row.text)
          : parseStructuredTextQuestions(provider, row.text);
      if (!questions) continue;
      const threadId = ThreadId.make(row.thread_id);
      const turnId = TurnId.make(row.turn_id);
      const requestId = "text-question:" + turnId;
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("text-question-open:" + threadId + ":" + turnId),
        threadId,
        createdAt,
        activity: {
          id: EventId.make("text-question-open:" + threadId + ":" + turnId),
          kind: "user-input.requested",
          tone: "info",
          summary: textQuestionSummary(provider),
          payload: { requestId, questions },
          turnId,
          createdAt,
        },
      });
    }
  });

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* restoreExaoneTextQuestions().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not restore EXAONE text questions", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      // Subscriptions must exist before start() returns, or events published
      // in the gap are lost to this consumer.
      yield* forkParked(
        Stream.runForEach(providerService.streamEvents, (event) =>
          event.execution === undefined
            ? worker.enqueue({ source: "runtime", event })
            : Effect.void,
        ),
        { startImmediately: true },
      );
      yield* forkParked(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.turn-start-requested") {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
        { startImmediately: true },
      );
    });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
