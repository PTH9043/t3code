/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import { makeManagedMcpResolver, claudeManagedMcpServers } from "../../mcp/ManagedMcpTools.ts";
import { unifiedExecutionLedger } from "../../t3x/executionLedger/UnifiedExecutionLedger.ts";
import {
  type CanUseTool,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKControlGetContextUsageResponse,
  type SDKResultMessage,
  type SettingSource,
  type SDKUserMessage,
  type ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import {
  claudeTokenConsumption,
  type ClaudeModelUsageLedger,
  makeClaudeModelUsageLedger,
  restoreClaudeModelUsageLedger,
  serializeClaudeModelUsageLedger,
} from "../tokenConsumption.ts";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ClaudeSettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type TokenUsageObservation,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeTaskStatus,
  type RuntimeTaskUsage,
  type TaskAgentLinkage,
  type TaskRunHandles,
  ThreadId,
  TurnId,
  WorkspaceWorkflowError,
  type UserInputQuestion,
  MONITOR_TASK_TYPES,
  classifyTaskAgentKind,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  buildClaudeConductorAgents,
  buildClaudeDeveloperInstructions,
  resolveClaudeConductorWorker,
} from "../ClaudeDeveloperInstructions.ts";
import { readAgentsMdForClaude } from "../projectAgentInstructions.ts";
import { isSafeguardBlock } from "../providerContentRefusal.ts";
import {
  buildSubordinateRoster,
  resolveConductorWorkerForModel,
  subordinatesForModel,
  type SubordinateRow,
} from "../subagentSelection.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { restrictNativeSubagents } from "../nativeSubagents.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { claudeChatWatchHooks, isClaudeWatchTask } from "../claudeChatWatch.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { isClaudeConsoleApiAccount } from "../Drivers/ClaudeApiEnvironment.ts";
import { makeClaudeChatSkillPlugin } from "../ClaudeChatSkills.ts";
import {
  getClaudeModelCapabilities,
  isClaudeUltracodeEffort,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeContextWindow,
  resolveClaudeEffort,
} from "./ClaudeProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import {
  makeProviderTurnHistoryFactory,
  type ProviderTurnHistory,
} from "../ProviderTurnHistory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  maxClaudeContextWindowFromModelUsage,
  selectedClaudeContextWindow,
  claudeUsageInputTokens,
  claudeUsageOutputTokens,
  lastClaudeUsageIteration,
  claudeTotalProcessedTokens,
  normalizeClaudeActiveTokenUsage,
  normalizeClaudeContextUsageApiSnapshot,
  compactBoundaryTokenUsageSnapshot,
  normalizeClaudeTaskProgressTokenUsage,
  readClaudeResumeState,
  trimmedString,
  normalizeTaskUsage,
} from "./ClaudeTokenLedger.ts";
import {
  PROVIDER,
  isWorkspaceWorkflowError,
  encodeJsonStringForDiagnostics,
  hasDurableClaudeSessionId,
  getEffectiveClaudeAgentEffort,
  isClaudeInterruptedCause,
  formatClaudeSafeguardError,
  resultUserFacingError,
  asRuntimeItemId,
  asCanonicalTurnId,
  asRuntimeRequestId,
  classifyToolItemType,
  classifyRequestType,
  isTodoTool,
  extractPlanStepsFromTodoInput,
  readClaudeToolUseResult,
  applyClaudeTaskToolResult,
  planStepsFromClaudeTasks,
  sanitizeSessionUrl,
  CLAUDE_TASK_PATCH_STATUS,
  agentIdForParentToolUse,
  taskLinkageFor,
  parseWorkflowProgress,
  workflowAgentStatus,
  summarizeToolRequest,
  titleForTool,
  CLAUDE_SETTING_SOURCES,
  buildUserMessageEffect,
  turnStatusFromResult,
  streamKindFromDeltaType,
  nativeProviderRefs,
  extractAssistantTextBlocks,
  extractContentBlockText,
  extractExitPlanModePlan,
  exitPlanCaptureKey,
  tryParseJsonRecord,
  toolInputFingerprint,
  toolResultStreamKind,
  toolResultBlocksFromUserMessage,
  toRequestError,
  sdkNativeMethod,
  describeUnknownSdkMessage,
  sdkNativeItemId,
  withoutCanUseToolShadowWarning,
  type PromptQueueItem,
  type ClaudeTurnState,
  type AssistantTextBlockState,
  type PendingApproval,
  type PendingUserInput,
  type ToolInFlight,
  type ClaudeTaskState,
  type ClaudeTaskAgentState,
  type ClaudeSessionContext,
  type ClaudeQueryRuntime,
} from "./ClaudeEventHelpers.ts";

export interface ClaudeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Models the user placed under this account (server settings), read when a session starts. */
  readonly subordinates?: Effect.Effect<ReadonlyArray<SubordinateRow>>;
}

export const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  claudeSettings: ClaudeSettings,
  options?: ClaudeAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("claudeAgent");
  const fileSystem = yield* FileSystem.FileSystem;
  const resolveManagedMcp = yield* makeManagedMcpResolver();
  const settingsService = yield* Effect.serviceOption(ServerSettingsService);
  const watchEnabled = (threadId: ThreadId) =>
    Option.isNone(settingsService)
      ? Effect.succeed(false)
      : settingsService.value.getSettings.pipe(
          Effect.map((settings) => settings.backgroundWatchThreadIds.includes(threadId)),
          Effect.orElseSucceed(() => false),
        );
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const createTurnHistory = yield* makeProviderTurnHistoryFactory;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, options?.environment).pipe(
    Effect.provideService(Path.Path, path),
  );
  const claudeSdkExecutablePath = yield* resolveClaudeSdkExecutablePath(
    claudeSettings.binaryPath,
    claudeEnvironment,
  );
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) =>
      (input.options.permissionMode === "bypassPermissions"
        ? withoutCanUseToolShadowWarning(() =>
            query({ prompt: input.prompt, options: input.options }),
          )
        : query({
            prompt: input.prompt,
            options: input.options,
          })) as ClaudeQueryRuntime);

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Claude runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const logNativeSdkMessage = Effect.fnUntraced(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    const observedAt = yield* nowIso;
    const itemId = sdkNativeItemId(message);

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : yield* randomUUIDv4,
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          ...(itemId ? { itemId: ProviderItemId.make(itemId) } : {}),
          payload: message,
        },
      },
      context.session.threadId,
    );
  });

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: ClaudeSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return {
      threadId,
      turns: yield* context.history.read,
    };
  });

  const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
    context: ClaudeSessionContext,
  ) {
    const threadId = context.session.threadId;
    if (!threadId) return;

    const resumeCursor = {
      threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
      turnCount: context.history.count(),
      ...(context.modelUsageLedger.size > 0
        ? { modelUsageLedger: serializeClaudeModelUsageLedger(context.modelUsageLedger) }
        : {}),
    };

    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: yield* nowIso,
    };
  });

  const ensureAssistantTextBlock = Effect.fn("ensureAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }

    const existing = turnState.assistantTextBlocks.get(blockIndex);
    if (existing && !existing.completionEmitted) {
      if (existing.fallbackText.length === 0 && options?.fallbackText) {
        existing.fallbackText = options.fallbackText;
      }
      if (options?.streamClosed) {
        existing.streamClosed = true;
      }
      return { blockIndex, block: existing };
    }

    const block: AssistantTextBlockState = {
      itemId: yield* randomUUIDv4,
      blockIndex,
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    };
    turnState.assistantTextBlocks.set(blockIndex, block);
    turnState.assistantTextBlockOrder.push(block);
    return { blockIndex, block };
  });

  const createSyntheticAssistantTextBlock = Effect.fn("createSyntheticAssistantTextBlock")(
    function* (context: ClaudeSessionContext, fallbackText: string) {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    },
  );

  const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || block.completionEmitted) {
      return;
    }

    if (!options?.force && !block.streamClosed) {
      return;
    }

    if (!block.emittedTextDelta && block.fallbackText.length > 0) {
      const deltaStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "content.delta",
        eventId: deltaStamp.eventId,
        provider: PROVIDER,
        createdAt: deltaStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          streamKind: "assistant_text",
          delta: block.fallbackText,
        },
        providerRefs: nativeProviderRefs(context),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    }

    block.completionEmitted = true;
    if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
      turnState.assistantTextBlocks.delete(block.blockIndex);
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      itemId: asRuntimeItemId(block.itemId),
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options?.rawPayload,
            },
          }
        : {}),
    });
  });

  const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
    "backfillAssistantTextBlocksFromSnapshot",
  )(function* (context: ClaudeSessionContext, message: SDKMessage) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    const snapshotTextBlocks = extractAssistantTextBlocks(message);
    if (snapshotTextBlocks.length === 0) {
      return;
    }

    const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
      blockIndex: block.blockIndex,
      block,
    }));

    for (const [position, text] of snapshotTextBlocks.entries()) {
      const existingEntry = orderedBlocks[position];
      const entry =
        existingEntry ??
        (yield* createSyntheticAssistantTextBlock(context, text).pipe(
          Effect.map((created) => {
            if (!created) {
              return undefined;
            }
            orderedBlocks.push(created);
            return created;
          }),
        ));
      if (!entry) {
        continue;
      }

      if (entry.block.fallbackText.length === 0) {
        entry.block.fallbackText = text;
      }

      if (entry.block.streamClosed && !entry.block.completionEmitted) {
        yield* completeAssistantTextBlock(context, entry.block, {
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }
  });

  const ensureThreadId = Effect.fn("ensureThreadId")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (typeof message.session_id !== "string" || message.session_id.length === 0) {
      return;
    }
    if (!hasDurableClaudeSessionId(message)) {
      return;
    }
    const nextThreadId = message.session_id;
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) {
    if (cause !== undefined) {
      void cause;
    }
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitThreadTokenUsage = Effect.fn("emitThreadTokenUsage")(function* (
    context: ClaudeSessionContext,
    usage: ThreadTokenUsageSnapshot | undefined,
    options?: {
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
      readonly consumption?: ReadonlyArray<TokenUsageObservation>;
    },
  ) {
    if (!usage && !options?.consumption?.length) {
      return;
    }

    context.lastKnownTokenUsage = usage ?? context.lastKnownTokenUsage;
    context.lastKnownTotalProcessedTokens =
      usage?.totalProcessedTokens ?? context.lastKnownTotalProcessedTokens;

    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: turnState.turnId } : {}),
      payload: {
        usage: usage ?? { usedTokens: 0 },
        ...(options?.consumption?.length ? { consumption: options.consumption } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options.rawPayload,
            },
          }
        : {}),
    });
  });

  const queryCurrentContextUsage = Effect.fn("queryCurrentContextUsage")(function* (
    context: ClaudeSessionContext,
    totalProcessedTokens?: number,
  ) {
    if (!context.query.getContextUsage) {
      return undefined;
    }

    // Bounded: getContextUsage is a control request to the child process, and
    // a busy or wedged child may never answer it (Effect.promise itself has no
    // timeout). This runs inside completeTurn on the session-stop path, where
    // an unbounded await wedged the provider command reactor's serial worker —
    // every later Stop click queued behind it forever.
    const usage = yield* Effect.promise(async () => {
      try {
        return await context.query.getContextUsage?.();
      } catch {
        return undefined;
      }
    }).pipe(Effect.timeoutOption("3 seconds"), Effect.map(Option.getOrUndefined));
    if (!usage) {
      return undefined;
    }

    context.lastKnownContextWindow = usage.maxTokens;
    return normalizeClaudeContextUsageApiSnapshot(usage, totalProcessedTokens);
  });

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();
    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const emitClaudeTaskPlanUpdated = Effect.fn("emitClaudeTaskPlanUpdated")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly toolUseId: string;
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const plan = planStepsFromClaudeTasks(context.claudeTasks);
    if (plan.length === 0) {
      return;
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.plan.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        explanation: "Claude Tasks",
        plan,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: "claude.sdk.message",
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ) {
    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
    if (resultContextWindow !== undefined) {
      context.lastKnownContextWindow = resultContextWindow;
    }

    const maxTokens = resultContextWindow ?? context.lastKnownContextWindow;
    const accumulatedTotalProcessedTokens = claudeTotalProcessedTokens(result?.usage);
    if (accumulatedTotalProcessedTokens !== undefined) {
      context.lastKnownTotalProcessedTokens = accumulatedTotalProcessedTokens;
    }

    const contextUsageSnapshot = yield* queryCurrentContextUsage(
      context,
      accumulatedTotalProcessedTokens ?? context.lastKnownTotalProcessedTokens,
    );
    const resultUsageRecord =
      result?.usage && typeof result.usage === "object" && !Array.isArray(result.usage)
        ? (result.usage as Record<string, unknown>)
        : undefined;
    const hasResultUsageIteration =
      resultUsageRecord !== undefined && lastClaudeUsageIteration(resultUsageRecord) !== undefined;
    const resultHasActiveUsage =
      resultUsageRecord !== undefined &&
      (hasResultUsageIteration ||
        claudeUsageInputTokens(resultUsageRecord) + claudeUsageOutputTokens(resultUsageRecord) > 0);
    const resultTotalOnly =
      resultUsageRecord !== undefined &&
      !resultHasActiveUsage &&
      claudeTotalProcessedTokens(resultUsageRecord) !== undefined;
    const resultIterationSnapshot = resultUsageRecord
      ? normalizeClaudeActiveTokenUsage(
          resultUsageRecord,
          maxTokens,
          accumulatedTotalProcessedTokens ?? context.lastKnownTotalProcessedTokens,
        )
      : undefined;
    const lastGoodUsage = context.lastKnownTokenUsage;
    const usageSnapshot: ThreadTokenUsageSnapshot | undefined =
      contextUsageSnapshot ??
      (resultTotalOnly && lastGoodUsage
        ? {
            ...lastGoodUsage,
            ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
              ? { maxTokens }
              : {}),
            ...(typeof accumulatedTotalProcessedTokens === "number" &&
            Number.isFinite(accumulatedTotalProcessedTokens) &&
            accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
              ? {
                  totalProcessedTokens: accumulatedTotalProcessedTokens,
                }
              : {}),
          }
        : resultIterationSnapshot) ??
      (lastGoodUsage
        ? {
            ...lastGoodUsage,
            ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
              ? { maxTokens }
              : {}),
            ...(typeof accumulatedTotalProcessedTokens === "number" &&
            Number.isFinite(accumulatedTotalProcessedTokens) &&
            accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
              ? {
                  totalProcessedTokens: accumulatedTotalProcessedTokens,
                }
              : {}),
          }
        : undefined);

    const turnState = context.turnState;
    if (!turnState) {
      yield* emitThreadTokenUsage(context, usageSnapshot, {
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
        consumption: claudeTokenConsumption(result, context.modelUsageLedger, {
          resumedSession: context.startedFromResume,
        }),
      });

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          state: status,
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        providerRefs: {},
      });
      return;
    }

    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          ...(tool.reportedModel ? { reportedModel: tool.reportedModel } : {}),
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: tool.input,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      context.inFlightTools.delete(index);
    }
    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }

    yield* context.history.complete(turnState.turnId);

    yield* emitThreadTokenUsage(context, usageSnapshot, {
      rawMethod: "claude/result",
      rawPayload: result ?? { status },
      consumption: claudeTokenConsumption(result, context.modelUsageLedger, {
        resumedSession: context.startedFromResume,
      }),
    });

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: status,
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
        ...(typeof result?.total_cost_usd === "number"
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });

    const updatedAt = yield* nowIso;
    context.turnState = undefined;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt,
      ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
    };
    yield* updateResumeCursor(context);
  });

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "stream_event") {
      return;
    }

    const { event } = message;

    // Subagent-owned stream traffic (parent_tool_use_id set) must not write
    // into the parent transcript: with forwardSubagentText off the SDK still
    // forwards subagent tool_use/tool_result blocks and their wrapping
    // text/thinking deltas, and emitting them interleaved N subagents'
    // narration into the chat (live-test finding). Their results reach the
    // UI via the task.* lifecycle; their tool blocks are attributed and
    // re-homed by the quiet-timeline filter.
    const streamParentToolUseId = (message as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    if (streamParentToolUseId !== null && streamParentToolUseId !== undefined) {
      // Drop only the subagent's narration (text/thinking); tool_use blocks
      // and their input_json_delta frames must flow so attributed tool items
      // keep their inputs (review finding: dropping deltas emptied inputs).
      const dropStart =
        event.type === "content_block_start" &&
        event.content_block.type !== "tool_use" &&
        event.content_block.type !== "server_tool_use" &&
        event.content_block.type !== "mcp_tool_use";
      const dropDelta =
        event.type === "content_block_delta" &&
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta");
      if (dropStart || dropDelta) {
        return;
      }
    }

    if (event.type === "message_delta") {
      if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) {
        return;
      }

      const snapshot = normalizeClaudeActiveTokenUsage(
        event.usage,
        context.lastKnownContextWindow,
        context.lastKnownTotalProcessedTokens,
      );
      yield* emitThreadTokenUsage(context, snapshot, {
        rawMethod: "claude/stream_event/message_delta",
        rawPayload: message,
      });
      return;
    }

    if (event.type === "content_block_delta") {
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
        const deltaText =
          event.delta.type === "text_delta"
            ? event.delta.text
            : typeof event.delta.thinking === "string"
              ? event.delta.thinking
              : "";
        if (deltaText.length === 0) {
          return;
        }
        const streamKind = streamKindFromDeltaType(event.delta.type);
        const assistantBlockEntry =
          event.delta.type === "text_delta"
            ? yield* ensureAssistantTextBlock(context, event.index)
            : context.turnState.assistantTextBlocks.get(event.index)
              ? {
                  blockIndex: event.index,
                  block: context.turnState.assistantTextBlocks.get(
                    event.index,
                  ) as AssistantTextBlockState,
                }
              : undefined;
        if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
          assistantBlockEntry.block.emittedTextDelta = true;
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(assistantBlockEntry?.block
            ? {
                itemId: asRuntimeItemId(assistantBlockEntry.block.itemId),
              }
            : {}),
          payload: {
            streamKind,
            delta: deltaText,
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta",
            payload: message,
          },
        });
        return;
      }

      if (event.delta.type === "input_json_delta") {
        const tool = context.inFlightTools.get(event.index);
        if (!tool || typeof event.delta.partial_json !== "string") {
          return;
        }

        const partialInputJson = tool.partialInputJson + event.delta.partial_json;
        const parsedInput = tryParseJsonRecord(partialInputJson);
        const detail = parsedInput ? summarizeToolRequest(tool.toolName, parsedInput) : tool.detail;
        let nextTool: ToolInFlight = {
          ...tool,
          partialInputJson,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
        };

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined;
        context.inFlightTools.set(event.index, nextTool);

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        ) {
          return;
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        };
        context.inFlightTools.set(event.index, nextTool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            ...(nextTool.reportedModel ? { reportedModel: nextTool.reportedModel } : {}),
            status: "inProgress",
            title: nextTool.title,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            ...(nextTool.agentId ? { agentId: nextTool.agentId } : {}),
            ...(nextTool.parentToolUseId ? { parentToolUseId: nextTool.parentToolUseId } : {}),
            data: {
              toolName: nextTool.toolName,
              input: nextTool.input,
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: nextTool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message,
          },
        });

        // Emit plan update when TodoWrite input is parsed
        if (parsedInput && isTodoTool(nextTool.toolName)) {
          const planSteps = extractPlanStepsFromTodoInput(parsedInput);
          if (planSteps && planSteps.length > 0) {
            const planStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "turn.plan.updated",
              eventId: planStamp.eventId,
              provider: PROVIDER,
              createdAt: planStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState
                ? {
                    turnId: asCanonicalTurnId(context.turnState.turnId),
                  }
                : {}),
              payload: {
                plan: planSteps,
              },
              providerRefs: nativeProviderRefs(context),
            });
          }
        }
      }
      return;
    }

    if (event.type === "content_block_start") {
      const { index, content_block: block } = event;
      if (block.type === "text") {
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: extractContentBlockText(block),
        });
        return;
      }
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        return;
      }

      const toolName = block.name;
      const itemType = classifyToolItemType(toolName);
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemId = block.id;
      const detail = summarizeToolRequest(toolName, toolInput);
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

      // Attribute tools that ran inside a subagent to their owning agent so
      // clients can re-home them out of the main timeline (quiet-timeline
      // guarantee): the SDK forwards subagent tool_use blocks tagged with the
      // spawning Task tool's id as parent_tool_use_id.
      const parentToolUseId =
        (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;
      const owningAgentId = agentIdForParentToolUse(context.taskAgents, parentToolUseId);

      const tool: ToolInFlight = {
        itemId,
        itemType,
        toolName,
        title: titleForTool(itemType),
        detail,
        input: toolInput,
        partialInputJson: "",
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
        ...(owningAgentId ? { agentId: owningAgentId } : {}),
        ...(parentToolUseId ? { parentToolUseId } : {}),
      };
      context.inFlightTools.set(index, tool);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          ...(tool.reportedModel ? { reportedModel: tool.reportedModel } : {}),
          status: "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: {
            toolName: tool.toolName,
            input: toolInput,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/stream_event/content_block_start",
          payload: message,
        },
      });
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(index);
      if (!tool) {
        return;
      }
    }
  });

  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    if (context.turnState) {
      yield* context.history.append(context.turnState.turnId, message.message);
    }

    for (const toolResult of toolResultBlocksFromUserMessage(message)) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        continue;
      }

      const [index, tool] = toolEntry;
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const toolUseResult = readClaudeToolUseResult(message);
      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: toolResult.block,
      };

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          ...(tool.reportedModel ? { reportedModel: tool.reportedModel } : {}),
          status: toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: tool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          ...(tool.reportedModel ? { reportedModel: tool.reportedModel } : {}),
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          ...(tool.agentId ? { agentId: tool.agentId } : {}),
          ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      // The Workflow tool's result carries the run handles (runId, scriptPath,
      // transcriptDir, sessionUrl). Attach them to the workflow's task agent so
      // the next task.* payload advertises them to clients.
      if (!toolResult.isError && tool.toolName.toLowerCase() === "workflow" && toolUseResult) {
        const workflowTaskId = trimmedString(toolUseResult.taskId);
        if (workflowTaskId) {
          const runHandles: TaskRunHandles = {
            ...(trimmedString(toolUseResult.runId)
              ? { runId: trimmedString(toolUseResult.runId) }
              : {}),
            ...(trimmedString(toolUseResult.scriptPath)
              ? { scriptPath: trimmedString(toolUseResult.scriptPath) }
              : {}),
            ...(trimmedString(toolUseResult.transcriptDir)
              ? { transcriptDir: trimmedString(toolUseResult.transcriptDir) }
              : {}),
            ...(sanitizeSessionUrl(toolUseResult.sessionUrl)
              ? { sessionUrl: sanitizeSessionUrl(toolUseResult.sessionUrl) }
              : {}),
          };
          const existing = context.taskAgents.get(workflowTaskId);
          context.taskAgents.set(workflowTaskId, {
            taskId: workflowTaskId,
            toolUseId: existing?.toolUseId ?? tool.itemId,
            description: existing?.description,
            subagentType: existing?.subagentType,
            taskType: existing?.taskType ?? "local_workflow",
            workflowName: existing?.workflowName,
            skipTranscript: existing?.skipTranscript ?? false,
            runHandles,
            owningAgentId: existing?.owningAgentId,
            model: existing?.model,
            effort: existing?.effort,
          });
        }
      }

      if (
        !toolResult.isError &&
        applyClaudeTaskToolResult(context.claudeTasks, tool, toolUseResult)
      ) {
        yield* emitClaudeTaskPlanUpdated(context, {
          toolUseId: tool.itemId,
          rawMethod: "claude/user",
          rawPayload: message,
        });
      }

      context.inFlightTools.delete(index);
    }
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }

    // Subagent-owned assistant snapshots (parent_tool_use_id set) are the
    // subagent's own conversation, not the parent's. Emitting them created
    // interleaved "Agent N done"-adjacent leak messages and spawned synthetic
    // turns per subagent completion (which also reset the Working timer).
    const assistantParentToolUseId = (message as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    const snapshotModel = trimmedString(message.message.model);
    if (snapshotModel && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (
          block.type !== "tool_use" &&
          block.type !== "server_tool_use" &&
          block.type !== "mcp_tool_use"
        )
          continue;
        const matches = Array.from(context.inFlightTools.values()).filter(
          (tool) =>
            tool.itemId === block.id &&
            tool.parentToolUseId === (assistantParentToolUseId ?? undefined),
        );
        if (matches.length === 1) {
          const tool = matches[0]!;
          if (tool.reportedModel === undefined) tool.reportedModel = snapshotModel;
          else if (tool.reportedModel !== snapshotModel) tool.reportedModel = null;
        }
      }
    }
    if (assistantParentToolUseId !== null && assistantParentToolUseId !== undefined) {
      // The snapshot's message.model is the authoritative API model the
      // subagent actually ran on — refine the seeded launch-time value.
      const owningTaskId = agentIdForParentToolUse(context.taskAgents, assistantParentToolUseId);
      const owningAgent = owningTaskId ? context.taskAgents.get(owningTaskId) : undefined;
      if (owningAgent && snapshotModel) {
        owningAgent.model = snapshotModel;
      }
      context.lastAssistantUuid = message.uuid;
      yield* updateResumeCursor(context);
      return;
    }

    // Auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState) {
      const turnId = TurnId.make(yield* randomUUIDv4);
      const startedAt = yield* nowIso;
      context.turnState = {
        turnId,
        startedAt,
        synthetic: true,
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        nextSyntheticAssistantBlockIndex: -1,
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(context),
          providerTurnId: turnId,
        },
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic-turn-start",
          payload: {},
        },
      });
    }

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const toolUse = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
          continue;
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (!planMarkdown) {
          continue;
        }
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }

    if (context.turnState) {
      yield* context.history.append(context.turnState.turnId, message.message);
      yield* backfillAssistantTextBlocksFromSnapshot(context, message);
    }

    context.lastAssistantUuid = message.uuid;
    yield* updateResumeCursor(context);
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "result") {
      return;
    }

    const status = turnStatusFromResult(message);
    const rawErrorMessage = resultUserFacingError(message);
    const errorMessage =
      status === "failed" && rawErrorMessage && isSafeguardBlock(rawErrorMessage)
        ? formatClaudeSafeguardError(rawErrorMessage)
        : rawErrorMessage;

    if (status === "failed") {
      yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
    }

    yield* completeTurn(context, status, errorMessage, message);
  });

  /**
   * Synthesizes per-member task.progress rows from the coordinator's
   * workflow_progress array. Member identity is the stable slot
   * `<coordinatorTaskId>:wf:<index>` (never the per-attempt agent id, which
   * changes on retry and would split one member into duplicate rows).
   * timelineBypass keeps these out of the parent chat; the Agents surface and
   * workflow card consume them.
   */
  const emitWorkflowMemberProgress = Effect.fn("emitWorkflowMemberProgress")(function* (
    context: ClaudeSessionContext,
    base: Omit<ProviderRuntimeEvent, "type" | "payload">,
    message: Extract<SDKMessage, { type: "system"; subtype: "task_progress" }>,
  ) {
    const progress = parseWorkflowProgress(
      (message as unknown as Record<string, unknown>).workflow_progress,
    );
    if (!progress) {
      return;
    }
    const coordinatorId = message.task_id;
    for (const entry of progress.agents) {
      const memberTaskId = `${coordinatorId}:wf:${entry.index}`;
      const status = workflowAgentStatus(entry);
      // Material-transition filter: the wire repeats every member each tick.
      // Emit only when something the client renders actually changed, so a
      // 100-agent fleet costs ~1 event per changed member instead of 100
      // per tick (review finding: unbounded event amplification).
      const fingerprint = [
        status,
        entry.label ?? "",
        entry.model ?? "",
        entry.lastToolName ?? "",
        entry.error ?? "",
        entry.tokens ?? "",
        entry.toolCalls ?? "",
        entry.phaseIndex ?? "",
        entry.phaseTitle ?? "",
        entry.attempt ?? "",
      ].join("\u001f");
      if (context.workflowMemberFingerprints.get(memberTaskId) === fingerprint) {
        continue;
      }
      context.workflowMemberFingerprints.set(memberTaskId, fingerprint);
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...base,
        eventId: stamp.eventId,
        createdAt: stamp.createdAt,
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(memberTaskId),
          description: entry.label ?? `agent ${entry.index}`,
          status,
          ...(entry.error ? { error: entry.error } : {}),
          ...(entry.label ? { title: entry.label } : {}),
          ...(entry.model ? { model: entry.model } : {}),
          ...(entry.lastToolName ? { lastToolName: entry.lastToolName } : {}),
          ...(entry.tokens !== undefined
            ? {
                typedUsage: {
                  totalTokens: entry.tokens,
                  ...(entry.toolCalls !== undefined ? { toolUses: entry.toolCalls } : {}),
                },
              }
            : {}),
          parentAgentId: coordinatorId,
          agentIndex: entry.index,
          ...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
          ...(entry.phaseTitle ? { phaseTitle: entry.phaseTitle } : {}),
          ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
          timelineBypass: true,
        },
      });
    }
  });

  const stopTrackedTask = Effect.fn("stopTrackedTask")(function* (
    context: ClaudeSessionContext,
    taskId: string,
  ) {
    if (!context.liveTaskIds.has(taskId)) return;
    const stop = context.query.stopTask;
    const threadId = context.session.threadId;
    if (!stop)
      return yield* toRequestError(threadId, "task/stop", "Provider cannot stop this task.");
    const acknowledged = yield* Effect.tryPromise({
      try: () => stop.call(context.query, taskId),
      catch: (cause) => toRequestError(threadId, "task/stop", cause),
    }).pipe(Effect.timeoutOption("3 seconds"));
    if (Option.isNone(acknowledged))
      return yield* toRequestError(threadId, "task/stop", "Provider did not acknowledge the stop.");
    if (!context.liveTaskIds.delete(taskId)) return;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "task.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        taskId: RuntimeTaskId.make(taskId),
        status: "stopped",
        ...taskLinkageFor(context.taskAgents, taskId),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const stopBackgroundWatches = Effect.fn("stopBackgroundWatches")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (!context || context.stopped) return;
    context.watchStopRequested = true;
    const watches = [...context.liveTaskIds].filter((id) =>
      isClaudeWatchTask(context.taskAgents.get(id)?.taskType),
    );
    const results = yield* Effect.forEach(
      watches,
      (id) => stopTrackedTask(context, id).pipe(Effect.exit),
      { concurrency: 8 },
    );
    for (const result of results)
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
  });

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") {
      return;
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };

    // Undeclared-but-real subtypes (absent from the SDK's union, so they can't
    // be switch cases): consumed intentionally without emitting, otherwise
    // they fall through to the unknown-subtype warning and surface as spurious
    // error rows in client work logs. `vcs_state_changed`
    // ({kind: commit|push|rebase}) and `code_change_published`
    // ({provider, url, repo}) are informational CLI notices; the work log
    // already shows the underlying git/gh tool calls.
    switch (message.subtype as string) {
      case "vcs_state_changed":
      case "code_change_published":
        return;
    }

    switch (message.subtype) {
      case "init":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.configured",
          payload: {
            config: message as Record<string, unknown>,
          },
        });
        return;
      case "status":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: `status:${message.status ?? "active"}`,
            detail: message,
          },
        });
        return;
      case "compact_boundary":
        yield* emitThreadTokenUsage(
          context,
          compactBoundaryTokenUsageSnapshot(
            message as unknown as Record<string, unknown>,
            context.lastKnownContextWindow,
            context.lastKnownTotalProcessedTokens,
          ),
          {
            rawMethod: "claude/system/compact_boundary",
            rawPayload: message,
          },
        );
        yield* offerRuntimeEvent({
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: message,
          },
        });
        return;
      case "hook_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      case "hook_response":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      case "task_started": {
        // A task launched by a tool that itself ran inside a subagent (the
        // in-flight tool carries agentId from parent_tool_use_id) is
        // agent-internal: a subagent's background shell, not parent work.
        const launchingTool = message.tool_use_id
          ? Array.from(context.inFlightTools.values()).find(
              (tool) => tool.itemId === message.tool_use_id,
            )
          : undefined;
        const owningAgentId = launchingTool?.agentId;
        const taskType = launchingTool?.toolName === "Monitor" ? "monitor" : message.task_type;
        // Model/effort: the Agent tool's input carries explicit overrides;
        // absent ones inherit the session's selection (SDK behavior).
        // Subagent assistant snapshots later refine model with the
        // authoritative API id. AgentInput.effort may be a named level or an
        // integer.
        const launchInput = launchingTool?.input;
        const model =
          trimmedString(launchInput?.model) ?? trimmedString(context.session.model ?? undefined);
        const rawLaunchEffort = launchInput?.effort;
        const effort =
          trimmedString(rawLaunchEffort) ??
          (typeof rawLaunchEffort === "number" && Number.isFinite(rawLaunchEffort)
            ? String(rawLaunchEffort)
            : context.currentEffort);
        // Remember the agent identity so every later task.* payload for this
        // taskId is self-describing (identity must survive activity retention).
        context.taskAgents.set(message.task_id, {
          taskId: message.task_id,
          toolUseId: message.tool_use_id,
          description: message.description,
          subagentType: message.subagent_type,
          taskType,
          workflowName: message.workflow_name,
          skipTranscript: message.skip_transcript === true,
          runHandles: context.taskAgents.get(message.task_id)?.runHandles,
          owningAgentId,
          model,
          effort,
        });
        context.liveTaskIds.add(message.task_id);
        unifiedExecutionLedger.begin({
          executionId: `claude-task:${context.session.threadId}:${message.task_id}`,
          executionKind: "claude_subagent",
          threadId: context.session.threadId,
          parentRunId: context.turnState?.turnId ?? null,
          summary: `Claude 서브에이전트 (${message.subagent_type ?? taskType ?? "task"}): ${(message.description ?? message.task_id).slice(0, 80)}`,
          provider: PROVIDER,
          model: model ?? null,
        });
        yield* offerRuntimeEvent({
          ...base,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(taskType ? { taskType } : {}),
            ...(owningAgentId ? { agentId: owningAgentId } : {}),
            ...(message.description ? { title: message.description } : {}),
            ...(message.subagent_type ? { role: message.subagent_type } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.workflow_name ? { workflowName: message.workflow_name } : {}),
          },
        });
        // A start already in flight can register its handle just after the room was switched off.
        if (
          context.watchStopRequested &&
          isClaudeWatchTask(taskType) &&
          !(yield* watchEnabled(context.session.threadId))
        ) {
          yield* stopTrackedTask(context, message.task_id).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Late monitor stop was not acknowledged", {
                taskId: message.task_id,
                cause,
              }),
            ),
          );
        }
        return;
      }
      case "task_progress": {
        yield* emitThreadTokenUsage(
          context,
          normalizeClaudeTaskProgressTokenUsage(message.usage, context),
          {
            rawMethod: "claude/system/task_progress",
            rawPayload: message,
          },
        );
        const linkage = taskLinkageFor(context.taskAgents, message.task_id);
        const typedUsage = normalizeTaskUsage(message.usage);
        // Phases ride on the coordinator's ONE progress row per tick. A
        // separate phases-only row shared the stable ingestion activity id
        // with this full row, and the thinner upsert overwrote usage and
        // progress text (review finding).
        const workflowPhases = parseWorkflowProgress(
          (message as unknown as Record<string, unknown>).workflow_progress,
        )?.phases;
        yield* offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            ...(workflowPhases && workflowPhases.length > 0 ? { phases: workflowPhases } : {}),
            ...linkage,
            ...(message.subagent_type ? { role: message.subagent_type } : {}),
          },
        });
        yield* emitWorkflowMemberProgress(context, base, message);
        return;
      }
      case "task_updated": {
        // Status patch (killed/paused/backgrounded/end_time/error) — main
        // previously dropped this on the floor, losing all transitions.
        const patch = message.patch;
        const status =
          patch.status !== undefined ? CLAUDE_TASK_PATCH_STATUS[patch.status] : undefined;
        if (status === "completed" || status === "failed" || status === "cancelled") {
          context.liveTaskIds.delete(message.task_id);
          unifiedExecutionLedger.finish({
            executionId: `claude-task:${context.session.threadId}:${message.task_id}`,
            executionKind: "claude_subagent",
            status,
            errorMessage: patch.error ?? null,
          });
        }
        const endedAt =
          typeof patch.end_time === "number" && Number.isFinite(patch.end_time)
            ? DateTime.formatIso(DateTime.makeUnsafe(patch.end_time))
            : undefined;
        yield* offerRuntimeEvent({
          ...base,
          type: "task.updated",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            ...(status ? { status } : {}),
            ...(patch.description ? { description: patch.description } : {}),
            ...(patch.error ? { error: patch.error } : {}),
            ...(endedAt ? { endedAt } : {}),
            ...(patch.is_backgrounded !== undefined
              ? { isBackgrounded: patch.is_backgrounded }
              : {}),
            ...taskLinkageFor(context.taskAgents, message.task_id),
          },
        });
        return;
      }
      case "task_notification": {
        context.liveTaskIds.delete(message.task_id);
        unifiedExecutionLedger.finish({
          executionId: `claude-task:${context.session.threadId}:${message.task_id}`,
          executionKind: "claude_subagent",
          status:
            message.status === "completed"
              ? "completed"
              : message.status === "stopped"
                ? "cancelled"
                : "failed",
        });
        yield* emitThreadTokenUsage(
          context,
          normalizeClaudeTaskProgressTokenUsage(message.usage, context),
          {
            rawMethod: "claude/system/task_notification",
            rawPayload: message,
          },
        );
        const typedUsage = normalizeTaskUsage(message.usage);
        yield* offerRuntimeEvent({
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...(message.output_file ? { outputFile: message.output_file } : {}),
            ...taskLinkageFor(context.taskAgents, message.task_id),
          },
        });
        return;
      }
      case "files_persisted":
        yield* offerRuntimeEvent({
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });
        return;
      case "thinking_tokens":
        return;
      case "api_retry":
        // Transport-level retry heartbeat. Surfacing each attempt as a
        // warning row spammed the work log (10 rows during a 502 storm);
        // the terminal result/error path reports the actual failure. Keep
        // the session visibly alive instead.
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: "running",
            reason: `api_retry:${message.attempt}/${message.max_retries}`,
          },
        });
        return;
      case "session_state_changed":
        // Authoritative turn-over signal from the CLI.
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state:
              message.state === "running"
                ? "running"
                : message.state === "requires_action"
                  ? "waiting"
                  : "ready",
            reason: `session_state:${message.state}`,
          },
        });
        return;
      case "notification":
        // User-facing CLI notification (e.g. context-limit warnings). Only
        // high-priority ones warrant a work-log row.
        if (message.priority === "high" || message.priority === "immediate") {
          yield* emitRuntimeWarning(context, message.text, message);
        }
        return;
      case "informational":
        // Transcript-style CLI notice. Same bar as `notification`: only the
        // prominent level earns a work-log row.
        if (message.level === "warning") {
          yield* emitRuntimeWarning(context, message.content, message);
        }
        return;
      // Inner protocol/UX details with no T3 surface today — consumed
      // deliberately so they don't masquerade as unknown-subtype warnings.
      // `background_tasks_changed` is a roster snapshot ({tasks: [...]}) —
      // the task_* lifecycle events carry the authoritative per-agent data.
      // `model_refusal_no_fallback` (no fallback could run) is already reported by the turn's
      // result/error path; `control_request_progress` is a transport retry
      // heartbeat (see api_retry); `worker_shutting_down` is followed by the
      // stream ending, which the session teardown path reports.
      case "model_refusal_fallback":
        yield* emitRuntimeWarning(
          context,
          `${message.original_model} 모델의 안전 필터가 응답을 막아 ${message.fallback_model} 모델로 이어서 진행했습니다.`,
          message,
        );
        return;
      case "model_refusal_no_fallback":
      case "local_command_output":
      case "plugin_install":
      case "commands_changed":
      case "memory_recall":
      case "elicitation_complete":
      case "background_tasks_changed":
      case "control_request_progress":
      case "worker_shutting_down":
        return;
      case "permission_denied":
        yield* offerRuntimeEvent({
          ...base,
          type: "tool.denied",
          payload: {
            toolName: message.tool_name,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.decision_reason ? { reason: message.decision_reason } : {}),
            ...(message.agent_id ? { agentId: message.agent_id } : {}),
          },
        });
        return;
      case "mirror_error":
        yield* emitRuntimeError(
          context,
          `Claude workspace mirror error: ${message.error}`,
          message,
        );
        return;
      default: {
        // Exhaustiveness guard: every subtype in the SDK's typed union is
        // handled above, so `message` narrows to never here — a new SDK
        // release adding a subtype fails this typecheck instead of silently
        // warning at runtime. The runtime fallback still catches undeclared
        // wire-only subtypes (like background_tasks_changed used to be).
        message satisfies never;
        const unknownMessage = message as never as { subtype: string };
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude system message '${unknownMessage.subtype}'`, message),
          message,
        );
        return;
      }
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { taskId: RuntimeTaskId.make(message.task_id) } : {}),
          ...(message.parent_tool_use_id !== null
            ? { parentToolUseId: message.parent_tool_use_id }
            : {}),
        },
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? {
                precedingToolUseIds: message.preceding_tool_use_ids,
              }
            : {}),
        },
      });
      return;
    }

    if (message.type === "auth_status") {
      yield* offerRuntimeEvent({
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.type === "rate_limit_event") {
      yield* offerRuntimeEvent({
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
        },
      });
      return;
    }
  });

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* logNativeSdkMessage(context, message);
    yield* ensureThreadId(context, message);

    // Undeclared-but-real top-level types (absent from the SDK's SDKMessage
    // union, so they can't be typed switch cases — same story as the
    // unknown-subtype pre-switch in handleSystemMessage):
    // `command_lifecycle` ({command_uuid, state: started|completed}) brackets
    // each slash-command run; the command's own output rows already show in
    // the transcript, so it earns no work-log row.
    switch (message.type as string) {
      case "command_lifecycle":
        return;
    }

    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);
        return;
      case "user":
        yield* handleUserMessage(context, message);
        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);
        return;
      case "result":
        yield* handleResultMessage(context, message);
        return;
      case "system":
        yield* handleSystemMessage(context, message);
        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* handleSdkTelemetryMessage(context, message);
        return;
      // Composer prompt suggestions have no T3 surface; consumed deliberately.
      case "prompt_suggestion":
        return;
      // /clear inside the CLI session. T3 never drives it, and the CLI keeps
      // the same session_id, so there is nothing to re-key; consumed.
      case "conversation_reset":
        return;
      default: {
        // Exhaustiveness guard (see handleSystemMessage): new SDK top-level
        // message types fail typecheck here instead of warning at runtime.
        message satisfies never;
        const unknownMessage = message as never as { type: string };
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude SDK message '${unknownMessage.type}'`, message),
          message,
        );
        return;
      }
    }
  });

  const runSdkStream = (
    context: ClaudeSessionContext,
  ): Effect.Effect<void, ProviderAdapterProcessError> =>
    Stream.fromAsyncIterable(
      context.query,
      (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: "Claude runtime stream failed.",
          cause,
        }),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) =>
        handleSdkMessage(context, message).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: context.session.threadId,
                detail: "Failed to process Claude runtime event.",
                cause,
              }),
          ),
        ),
      ),
    );

  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, ProviderAdapterProcessError>,
  ) {
    if (context.stopped) {
      return;
    }

    if (Exit.isFailure(exit)) {
      if (isClaudeInterruptedCause(exit.cause)) {
        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Claude runtime interrupted.");
        }
      } else {
        const failures = exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [reason.error] : [],
        );
        const message = failures[0]?.detail ?? "Claude runtime stream failed.";
        yield* emitRuntimeError(context, message, {
          failureCount: failures.length,
          failureTags: failures.map((failure) => failure._tag),
        });
        yield* completeTurn(context, "failed", message);
      }
    } else if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    });
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;

    context.stopped = true;
    for (const liveTaskId of context.liveTaskIds) {
      unifiedExecutionLedger.finish({
        executionId: `claude-task:${context.session.threadId}:${liveTaskId}`,
        executionKind: "claude_subagent",
        status: "cancelled",
        errorMessage: "Claude 세션 종료로 인해 서브에이전트 작업이 중단되었습니다.",
      });
    }
    context.liveTaskIds.clear();
    context.closeToolCallbacks();

    for (const pending of context.pendingApprovals.values()) {
      yield* Deferred.succeed(pending.decision, "cancel");
    }

    for (const pending of context.pendingUserInputs.values()) {
      pending.cancel();
    }

    yield* Queue.shutdown(context.promptQueue);

    const closeResult = yield* Effect.try({
      try: () => context.query.close(),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: "Failed to close Claude runtime query.",
          cause,
        }),
    }).pipe(Effect.result);

    const streamFiber = context.streamFiber;
    context.streamFiber = undefined;
    let streamDrained = true;
    if (streamFiber && streamFiber.pollUnsafe() === undefined) {
      const interrupted = yield* Fiber.interrupt(streamFiber).pipe(
        Effect.timeoutOption("5 seconds"),
      );
      streamDrained = Option.isSome(interrupted);
    }

    const callbacksDrained = yield* Effect.promise(context.drainToolCallbacks).pipe(
      Effect.timeoutOption("5 seconds"),
    );
    const drained =
      closeResult._tag === "Success" && streamDrained && Option.isSome(callbacksDrained);

    if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Session stopped.");
    }

    yield* context.chatSkillPlugin.dispose.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove Claude session skill files", { cause }),
      ),
    );

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (drained && options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: "Session stopped",
          exitKind: "graceful",
        },
        providerRefs: {},
      });
    }

    if (sessions.get(context.session.threadId) === context) {
      sessions.delete(context.session.threadId);
    }
    if (!drained) {
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: context.session.threadId,
        detail: "Claude session stopped without confirming that all event producers drained.",
        cause: closeResult._tag === "Failure" ? closeResult.failure : undefined,
      });
    }
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  const startSession: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (claudeSettings.authMode === "api-key" && !claudeEnvironment.ANTHROPIC_API_KEY?.trim()) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue:
            "Claude API 키가 없거나 서버에서 읽을 수 없습니다. 연결 설정과 서버 계정을 확인하세요.",
        });
      }
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      if (input.cwd) {
        const folder = yield* fileSystem.stat(input.cwd).pipe(Effect.option);
        if (Option.isNone(folder) || folder.value.type !== "Directory") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `프로젝트 폴더를 열 수 없습니다. / Project folder unavailable (${input.cwd})`,
          });
        }
      }

      const existingContext = sessions.get(input.threadId);
      if (existingContext) {
        yield* Effect.logWarning("claude.session.replacing", {
          threadId: input.threadId,
          existingSessionStatus: existingContext.session.status,
          reason: "startSession called with existing active session",
        });
        yield* stopSessionInternal(existingContext, {
          emitExitEvent: false,
        }).pipe(
          // Replacement cleanup is best-effort: never block the new session on
          // either typed failures or unexpected defects from tearing down the old one.
          Effect.catchCause((cause) =>
            Effect.logWarning("claude.session.replace.stop-failed", {
              threadId: input.threadId,
              cause,
            }),
          ),
        );
      }

      const chatSkillPlugin = yield* makeClaudeChatSkillPlugin(serverConfig.stateDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.mapError((cause) => toRequestError(input.threadId, "skills/create", cause)),
      );
      let pendingQuery: ClaudeQueryRuntime | undefined;
      return yield* Effect.gen(function* () {
        const startedAt = yield* nowIso;
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const threadId = input.threadId;
        const existingResumeSessionId = resumeState?.resume;
        const newSessionId =
          existingResumeSessionId === undefined ? yield* randomUUIDv4 : undefined;
        const sessionId = existingResumeSessionId ?? newSessionId;

        const runtimeContext = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(runtimeContext);
        const runPromise = Effect.runPromiseWith(runtimeContext);

        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.filter((item) => item.type === "message"),
          Stream.map((item) => item.message),
          Stream.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
          ),
          Stream.toAsyncIterable,
        );

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const inFlightTools = new Map<number, ToolInFlight>();
        const claudeTasks = new Map<string, ClaudeTaskState>();
        const taskAgents = new Map<string, ClaudeTaskAgentState>();
        const workflowMemberFingerprints = new Map<string, string>();
        const liveTaskIds = new Set<string>();

        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);
        const activeToolCallbacks = new Set<Promise<PermissionResult>>();
        const activeControlOperations = new Set<Promise<void>>();
        let acceptingToolCallbacks = true;
        const closeToolCallbacks = () => {
          acceptingToolCallbacks = false;
        };
        const drainToolCallbacks = async () => {
          await Promise.allSettled([...activeToolCallbacks, ...activeControlOperations]);
        };
        const beginControlOperation = () => {
          if (!acceptingToolCallbacks) return undefined;
          let resolve!: () => void;
          const completion = new Promise<void>((done) => {
            resolve = done;
          });
          activeControlOperations.add(completion);
          return () => {
            activeControlOperations.delete(completion);
            resolve();
          };
        };

        /**
         * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
         * runtime event and waiting for the user to respond via `respondToUserInput`.
         */
        const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
          context: ClaudeSessionContext,
          toolInput: Record<string, unknown>,
          callbackOptions: {
            readonly signal: AbortSignal;
            readonly toolUseID?: string;
          },
        ) {
          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);

          // Parse questions from the SDK's AskUserQuestion input.
          // `id` MUST equal the full question text — Claude SDK >= 2.1.121 looks
          // up answers by question text in `mapToolResultToToolResultBlockParam`,
          // so the key the UI uses to keep its draft answer must match the SDK's
          // expected lookup key. See https://github.com/pingdotgg/t3code/issues/2388
          const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
          const questions: Array<UserInputQuestion> = rawQuestions.map(
            (q: Record<string, unknown>, idx: number) => ({
              id: typeof q.question === "string" && q.question.length > 0 ? q.question : `q-${idx}`,
              header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
              question: typeof q.question === "string" ? q.question : "",
              options: Array.isArray(q.options)
                ? q.options.map((opt: Record<string, unknown>) => ({
                    label: typeof opt.label === "string" ? opt.label : "",
                    description: typeof opt.description === "string" ? opt.description : "",
                  }))
                : [],
              multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
            }),
          );

          const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
          if (context.stopped) {
            return {
              behavior: "deny",
              message: "Claude session has stopped.",
            } satisfies PermissionResult;
          }
          let aborted = false;
          const onAbort = () => {
            if (!pendingUserInputs.has(requestId)) return;
            aborted = true;
            pendingUserInputs.delete(requestId);
            runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
          };
          pendingUserInputs.set(requestId, {
            questions,
            answers: answersDeferred,
            cancel: onAbort,
          });
          callbackOptions.signal.addEventListener("abort", onAbort, { once: true });
          if (callbackOptions.signal.aborted) onAbort();

          const answers = yield* Effect.gen(function* () {
            const requestedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "user-input.requested",
              eventId: requestedStamp.eventId,
              provider: PROVIDER,
              createdAt: requestedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState
                ? {
                    turnId: asCanonicalTurnId(context.turnState.turnId),
                  }
                : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: { questions },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callbackOptions.toolUseID,
              }),
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/AskUserQuestion",
                payload: {
                  toolName: "AskUserQuestion",
                  input: toolInput,
                },
              },
            });
            return yield* Deferred.await(answersDeferred);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                callbackOptions.signal.removeEventListener("abort", onAbort);
                pendingUserInputs.delete(requestId);
              }),
            ),
          );

          // Emit user-input.resolved so the UI knows the interaction completed.
          const resolvedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "user-input.resolved",
            eventId: resolvedStamp.eventId,
            provider: PROVIDER,
            createdAt: resolvedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState
              ? {
                  turnId: asCanonicalTurnId(context.turnState.turnId),
                }
              : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: { answers, ...(aborted ? { reason: "cancelled" } : {}) },
            providerRefs: nativeProviderRefs(context, {
              providerItemId: callbackOptions.toolUseID,
            }),
            raw: {
              source: "claude.sdk.permission",
              method: "canUseTool/AskUserQuestion/resolved",
              payload: { answers },
            },
          });

          if (aborted) {
            return {
              behavior: "deny",
              message: "User cancelled tool execution.",
            } satisfies PermissionResult;
          }

          // Return the answers to the SDK in the expected format:
          // { questions: [...], answers: { questionText: selectedLabel } }.
          // The SDK contract types every answer as a STRING and documents
          // multi-select answers as comma-separated — the UI's string[] for a
          // multiSelect question must be joined here or the model never sees
          // the selections (multi-select looked broken end-to-end).
          const sdkAnswers = Object.fromEntries(
            Object.entries(answers).map(([questionText, answer]) => [
              questionText,
              Array.isArray(answer) ? answer.join(", ") : answer,
            ]),
          );
          return {
            behavior: "allow",
            updatedInput: {
              questions: toolInput.questions,
              answers: sdkAnswers,
            },
          } satisfies PermissionResult;
        });

        const canUseToolEffect = Effect.fn("canUseTool")(function* (
          toolName: Parameters<CanUseTool>[0],
          toolInput: Parameters<CanUseTool>[1],
          callbackOptions: Parameters<CanUseTool>[2],
        ) {
          const context = yield* Ref.get(contextRef);
          if (!context) {
            return {
              behavior: "deny",
              message: "Claude session context is unavailable.",
            } satisfies PermissionResult;
          }
          if (context.stopped) {
            return {
              behavior: "deny",
              message: "Claude session has stopped.",
            } satisfies PermissionResult;
          }

          // Handle AskUserQuestion: surface clarifying questions to the
          // user via the user-input runtime event channel, regardless of
          // runtime mode (plan mode relies on this heavily).
          if (toolName === "AskUserQuestion") {
            return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
          }

          if (toolName === "ExitPlanMode") {
            const planMarkdown = extractExitPlanModePlan(toolInput);
            if (planMarkdown) {
              yield* emitProposedPlanCompleted(context, {
                planMarkdown,
                toolUseId: callbackOptions.toolUseID,
                rawSource: "claude.sdk.permission",
                rawMethod: "canUseTool/ExitPlanMode",
                rawPayload: {
                  toolName,
                  input: toolInput,
                },
              });
            }

            return {
              behavior: "deny",
              message:
                "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
            } satisfies PermissionResult;
          }

          const runtimeMode = input.runtimeMode ?? "full-access";
          if (runtimeMode === "full-access") {
            return {
              behavior: "allow",
              updatedInput: toolInput,
            } satisfies PermissionResult;
          }

          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
          const requestType = classifyRequestType(toolName);
          const detail = summarizeToolRequest(toolName, toolInput);
          const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
          if (context.stopped) {
            return {
              behavior: "deny",
              message: "Claude session has stopped.",
            } satisfies PermissionResult;
          }
          const pendingApproval: PendingApproval = {
            requestType,
            detail,
            decision: decisionDeferred,
            ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
          };

          pendingApprovals.set(requestId, pendingApproval);
          const onAbort = () => {
            if (!pendingApprovals.has(requestId)) return;
            pendingApprovals.delete(requestId);
            runFork(Deferred.succeed(decisionDeferred, "cancel"));
          };
          callbackOptions.signal.addEventListener("abort", onAbort, { once: true });
          if (callbackOptions.signal.aborted) onAbort();

          const decision = yield* Effect.gen(function* () {
            const requestedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "request.opened",
              eventId: requestedStamp.eventId,
              provider: PROVIDER,
              createdAt: requestedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: {
                requestType,
                detail,
                args: {
                  toolName,
                  input: toolInput,
                  ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
                },
              },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callbackOptions.toolUseID,
              }),
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/request",
                payload: {
                  toolName,
                  input: toolInput,
                },
              },
            });
            return yield* Deferred.await(decisionDeferred);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                callbackOptions.signal.removeEventListener("abort", onAbort);
                pendingApprovals.delete(requestId);
              }),
            ),
          );

          const resolvedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "request.resolved",
            eventId: resolvedStamp.eventId,
            provider: PROVIDER,
            createdAt: resolvedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType,
              decision,
            },
            providerRefs: nativeProviderRefs(context, {
              providerItemId: callbackOptions.toolUseID,
            }),
            raw: {
              source: "claude.sdk.permission",
              method: "canUseTool/decision",
              payload: {
                decision,
              },
            },
          });

          if (decision === "accept" || decision === "acceptForSession") {
            return {
              behavior: "allow",
              updatedInput: toolInput,
              ...(decision === "acceptForSession" && pendingApproval.suggestions
                ? {
                    updatedPermissions: [...pendingApproval.suggestions],
                  }
                : {}),
            } satisfies PermissionResult;
          }

          return {
            behavior: "deny",
            message:
              decision === "cancel"
                ? "User cancelled tool execution."
                : "User declined tool execution.",
          } satisfies PermissionResult;
        });

        const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) => {
          if (!acceptingToolCallbacks) {
            return Promise.resolve({
              behavior: "deny",
              message: "Claude session has stopped.",
            } satisfies PermissionResult);
          }
          const pending = runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));
          activeToolCallbacks.add(pending);
          void pending.then(
            () => activeToolCallbacks.delete(pending),
            () => activeToolCallbacks.delete(pending),
          );
          return pending;
        };

        const claudeBinaryPath = claudeSdkExecutablePath;
        const nativeSubagentsRestricted = restrictNativeSubagents(input);
        const extraArgs = parseCliArgs(claudeSettings.launchArgs).flags;
        const disallowedTools = ["Agent", "Task", "Workflow", "TeamCreate", "SendMessage"];
        if (nativeSubagentsRestricted) {
          // The SDK appends extraArgs after its own flags. Keep the account's deny rules
          // in the same flag so a second --disallowedTools cannot replace the room's list.
          for (const flag of ["disallowedTools", "disallowed-tools"]) {
            const configured = extraArgs[flag];
            if (configured) disallowedTools.push(configured);
            delete extraArgs[flag];
          }
        }
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const caps = getClaudeModelCapabilities(modelSelection?.model);
        const descriptors = getProviderOptionDescriptors({ caps });
        const apiModelId = modelSelection ? resolveClaudeApiModelId(modelSelection) : undefined;
        const initialContextWindow = selectedClaudeContextWindow(modelSelection);
        const rawEffort = getModelSelectionStringOptionValue(modelSelection, "effort");
        const effort = resolveClaudeEffort(caps, rawEffort) ?? null;
        const fastModeSupported = descriptors.some(
          (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
        );
        const thinkingSupported = descriptors.some(
          (descriptor) => descriptor.type === "boolean" && descriptor.id === "thinking",
        );
        const fastMode =
          getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true &&
          fastModeSupported;
        const thinking = thinkingSupported
          ? getModelSelectionBooleanOptionValue(modelSelection, "thinking")
          : undefined;
        const ultracode = isClaudeUltracodeEffort(effort);
        const effectiveEffort = getEffectiveClaudeAgentEffort(effort, modelSelection?.model);
        const runtimeModeToPermission: Record<string, PermissionMode> = {
          "auto-accept-edits": "acceptEdits",
          auto: "auto",
          "full-access": "bypassPermissions",
        };
        const permissionMode = runtimeModeToPermission[input.runtimeMode];
        const settings = {
          ...(claudeSettings.promptCacheTtl && claudeSettings.promptCacheTtl !== "inherit"
            ? { promptCacheTtl: claudeSettings.promptCacheTtl }
            : {}),
          ...(claudeSettings.subagentPromptCacheTtl &&
          claudeSettings.subagentPromptCacheTtl !== "inherit"
            ? { subagentPromptCacheTtl: claudeSettings.subagentPromptCacheTtl }
            : {}),
          ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
          ...(fastMode ? { fastMode: true } : {}),
          ...(ultracode ? { ultracode: true } : {}),
          // A session can change models between turns; never retry a refusal on another model.
          switchModelsOnFlag: false,
        };
        // Whatever model the person picked conducts; the worker is the one they
        // assigned to that answering model, otherwise the account's default.
        const conductorWorker = nativeSubagentsRestricted
          ? undefined
          : resolveClaudeConductorWorker(
              resolveConductorWorkerForModel({
                fallback: claudeSettings.conductorWorkerModel,
                byModel: claudeSettings.conductorWorkerByModel,
                model: modelSelection?.model,
              }),
            );
        // Models the user placed under the session's model. An execution session
        // is itself a subordinate or orchestra participant and never gets a roster.
        const subordinateRoster =
          nativeSubagentsRestricted || input.execution !== undefined || !options?.subordinates
            ? undefined
            : buildSubordinateRoster(
                subordinatesForModel(yield* options.subordinates, modelSelection?.model),
              );
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const managedServers = claudeManagedMcpServers([
          ...(yield* resolveManagedMcp(PROVIDER, input.cwd)),
          ...(mcpSession
            ? [
                {
                  name: "t3-code",
                  transport: "http" as const,
                  url: mcpSession.endpoint,
                  headers: { Authorization: mcpSession.authorizationHeader },
                },
              ]
            : []),
        ]);
        const queryOptions: ClaudeQueryOptions = {
          ...(input.execution
            ? {}
            : { hooks: claudeChatWatchHooks(() => runPromise(watchEnabled(input.threadId))) }),
          ...(nativeSubagentsRestricted ? { disallowedTools } : {}),
          plugins: [...(input.workflowSkillPlugins ?? []), chatSkillPlugin.root].map((plugin) => ({
            type: "local" as const,
            path: plugin,
          })),
          ...(Object.keys(managedServers.servers).length > 0
            ? { mcpServers: managedServers.servers }
            : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(apiModelId ? { model: apiModelId } : {}),
          pathToClaudeCodeExecutable: claudeBinaryPath,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: buildClaudeDeveloperInstructions({
              conductorWorker,
              subordinateRoster,
              projectInstructions: readAgentsMdForClaude(input.cwd),
              globalInstructions: input.globalSystemInstructions,
            }),
          },
          ...(conductorWorker ? { agents: buildClaudeConductorAgents(conductorWorker) } : {}),
          settingSources: [...CLAUDE_SETTING_SOURCES],
          // `ultracode` is a Claude Code setting, not an API effort level. It is
          // normalized to `xhigh` above and paired with `settings.ultracode`.
          ...(effectiveEffort
            ? {
                effort: effectiveEffort as unknown as NonNullable<ClaudeQueryOptions["effort"]>,
              }
            : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
          ...(newSessionId ? { sessionId: newSessionId } : {}),
          includePartialMessages: true,
          canUseTool,
          // The CLI gives up on an MCP tool call that stays silent for 60 s
          // (measured on 0.3.251). `workspace_delegate` holds a call for up to
          // four minutes while another agent works; a value the user set wins.
          env: {
            MCP_TOOL_TIMEOUT: "300000",
            ...claudeEnvironment,
            ...managedServers.environment,
          },
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
          ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
        };

        yield* Effect.annotateCurrentSpan({
          "provider.kind": PROVIDER,
          "provider.thread_id": threadId,
          "provider.runtime_mode": input.runtimeMode,
          "claude.resume.source":
            existingResumeSessionId !== undefined ? "resume-session" : "generated-session",
          "claude.resume.thread_id": resumeState?.threadId ?? "",
          "claude.resume.session_id": existingResumeSessionId ?? "",
          "claude.resume.session_at": resumeState?.resumeSessionAt ?? "",
          "claude.resume.turn_count": resumeState?.turnCount ?? -1,
          "claude.query.cwd": input.cwd ?? "",
          "claude.query.model": apiModelId ?? "",
          "claude.query.effort": effectiveEffort ?? "",
          "claude.query.permission_mode": permissionMode ?? "",
          "claude.query.allow_dangerously_skip_permissions": permissionMode === "bypassPermissions",
          "claude.query.resume": existingResumeSessionId ?? "",
          "claude.query.session_id": newSessionId ?? "",
          "claude.query.include_partial_messages": true,
          "claude.query.additional_directories": input.cwd ? [input.cwd] : [],
          "claude.query.setting_sources": [...CLAUDE_SETTING_SOURCES],
          "claude.query.conductor_worker": conductorWorker ?? "off",
          "claude.query.settings_json": encodeJsonStringForDiagnostics(settings) ?? "",
          "claude.query.extra_args_json": encodeJsonStringForDiagnostics(extraArgs) ?? "",
          "claude.query.path_to_executable": claudeBinaryPath,
        });

        const queryRuntime = yield* Effect.try({
          try: () =>
            createQuery({
              prompt,
              options: queryOptions,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: "Failed to start Claude runtime session.",
              cause,
            }),
        });
        pendingQuery = queryRuntime;
        if (claudeSettings.authMode === "api-key") {
          const initialized = yield* Effect.tryPromise({
            try: () =>
              queryRuntime.initializationResult?.() ??
              Promise.reject(new Error("initialization unavailable")),
            catch: () =>
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: "Claude API 인증 출처를 확인하지 못했습니다.",
              }),
          }).pipe(Effect.timeoutOption("25 seconds"));
          if (Option.isNone(initialized) || !isClaudeConsoleApiAccount(initialized.value.account)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "Claude Console API 키 인증을 확인하지 못했습니다. 구독 계정으로 전환하지 않습니다.",
            });
          }
        }

        const session: ProviderSession = {
          continuity: existingResumeSessionId ? "resumed" : "new",
          threadId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          ...(threadId ? { threadId } : {}),
          resumeCursor: {
            ...(threadId ? { threadId } : {}),
            ...(sessionId ? { resume: sessionId } : {}),
            ...(resumeState?.resumeSessionAt
              ? { resumeSessionAt: resumeState.resumeSessionAt }
              : {}),
            turnCount: resumeState?.turnCount ?? 0,
          },
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        const context: ClaudeSessionContext = {
          nativeSubagentsRestricted,
          session,
          chatSkillPlugin,
          promptQueue,
          query: queryRuntime,
          streamFiber: undefined,
          startedAt,
          basePermissionMode: permissionMode,
          currentPermissionMode: permissionMode,
          currentApiModelId: apiModelId,
          currentEffort: effectiveEffort ?? undefined,
          resumeSessionId: sessionId,
          pendingApprovals,
          pendingUserInputs,
          closeToolCallbacks,
          drainToolCallbacks,
          beginControlOperation,
          history: yield* createTurnHistory({
            directory: path.join(serverConfig.stateDir, "provider-history", PROVIDER),
            provider: PROVIDER,
            threadId,
          }),
          inFlightTools,
          claudeTasks,
          taskAgents,
          workflowMemberFingerprints,
          liveTaskIds,
          watchStopRequested: false,
          turnState: undefined,
          lastKnownContextWindow: initialContextWindow,
          lastKnownTokenUsage: undefined,
          lastKnownTotalProcessedTokens: undefined,
          modelUsageLedger:
            existingResumeSessionId !== undefined &&
            typeof input.resumeCursor === "object" &&
            input.resumeCursor !== null &&
            "modelUsageLedger" in input.resumeCursor
              ? restoreClaudeModelUsageLedger(
                  (input.resumeCursor as { readonly modelUsageLedger?: unknown }).modelUsageLedger,
                )
              : makeClaudeModelUsageLedger(),
          startedFromResume: existingResumeSessionId !== undefined,
          lastAssistantUuid: resumeState?.resumeSessionAt,
          lastThreadStartedId: undefined,
          stopped: false,
        };
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const finishStartup = beginControlOperation();
            if (!finishStartup) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId,
              });
            }
            yield* Ref.set(contextRef, context);
            sessions.set(threadId, context);
            return yield* restore(
              Effect.gen(function* () {
                const sessionStartedStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "session.started",
                  eventId: sessionStartedStamp.eventId,
                  provider: PROVIDER,
                  createdAt: sessionStartedStamp.createdAt,
                  threadId,
                  payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
                  providerRefs: {},
                });

                const configuredStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "session.configured",
                  eventId: configuredStamp.eventId,
                  provider: PROVIDER,
                  createdAt: configuredStamp.createdAt,
                  threadId,
                  payload: {
                    config: {
                      ...(apiModelId ? { model: apiModelId } : {}),
                      ...(input.cwd ? { cwd: input.cwd } : {}),
                      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
                      ...(permissionMode ? { permissionMode } : {}),
                      ...(fastMode ? { fastMode: true } : {}),
                    },
                  },
                  providerRefs: {},
                });

                const readyStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "session.state.changed",
                  eventId: readyStamp.eventId,
                  provider: PROVIDER,
                  createdAt: readyStamp.createdAt,
                  threadId,
                  payload: {
                    state: "ready",
                  },
                  providerRefs: {},
                });

                if (context.stopped) {
                  return yield* new ProviderAdapterSessionNotFoundError({
                    provider: PROVIDER,
                    threadId,
                  });
                }
                let streamFiber: Fiber.Fiber<void, never>;
                streamFiber = runFork(
                  Effect.exit(runSdkStream(context)).pipe(
                    Effect.flatMap((exit) => {
                      if (context.stopped) {
                        return Effect.void;
                      }
                      if (context.streamFiber === streamFiber) {
                        context.streamFiber = undefined;
                      }
                      return handleStreamExit(context, exit).pipe(
                        Effect.catch((cause) =>
                          Effect.logError("Failed to close Claude runtime stream.", { cause }),
                        ),
                      );
                    }),
                  ),
                );
                context.streamFiber = streamFiber;
                streamFiber.addObserver(() => {
                  if (context.streamFiber === streamFiber) {
                    context.streamFiber = undefined;
                  }
                });

                return {
                  ...session,
                };
              }),
            ).pipe(Effect.ensuring(Effect.sync(finishStartup)));
          }),
        );
      }).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            const context = sessions.get(input.threadId);
            if (context?.chatSkillPlugin === chatSkillPlugin) {
              yield* stopSessionInternal(context, { emitExitEvent: false }).pipe(Effect.ignore);
            } else {
              yield* Effect.try(() => pendingQuery?.close()).pipe(Effect.ignore);
              yield* chatSkillPlugin.dispose.pipe(Effect.ignore);
            }
          }),
        ),
      );
    },
  );

  const sendTurn = Effect.fn("sendTurn")(function* (
    context: ClaudeSessionContext,
    input: Parameters<ClaudeAdapterShape["sendTurn"]>[0],
  ) {
    let sendInput = input;
    if (input.workflowSkills?.length) {
      if (!context.query.reloadSkills)
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "skills/reload",
          detail: "현재 Claude SDK는 실행 중인 스킬 새로고침을 지원하지 않습니다.",
        });
      const prepared = yield* context.chatSkillPlugin
        .install(
          input.workflowSkills,
          {
            runtimeMode:
              input.interactionMode === "plan" ||
              (input.interactionMode === undefined && context.currentPermissionMode === "plan")
                ? "plan"
                : context.session.runtimeMode,
            model: input.modelSelection?.model ?? context.session.model ?? "",
            allowAdditionalWorkers: true,
          },
          !context.turnState || context.turnState.synthetic === true,
        )
        .pipe(
          Effect.mapError((cause) =>
            isWorkspaceWorkflowError(cause)
              ? new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "skills/install",
                  detail: cause.message,
                  cause,
                })
              : toRequestError(input.threadId, "skills/install", cause),
          ),
        );
      if (prepared.slice(1).some((skill) => skill.manualOnly))
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "skills/invoke",
          detail: "수동 전용 스킬은 한 요청에서 첫 번째로 선택해야 합니다.",
        });
      const reloaded = yield* Effect.tryPromise({
        try: () => context.query.reloadSkills!(),
        catch: (cause) => toRequestError(input.threadId, "skills/reload", cause),
      });
      if (
        prepared.some((skill) => !reloaded.skills.some((item) => item.name === skill.qualifiedName))
      )
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "skills/reload",
          detail: "선택한 Claude 스킬을 세션에 등록하지 못했습니다.",
        });
      const remaining = prepared
        .slice(1)
        .map((skill) => `/${skill.qualifiedName}`)
        .join(" ");
      sendInput = {
        ...input,
        input: `/${prepared[0]!.qualifiedName} ${input.input ?? ""}${remaining ? `\n\nAlso use the selected skills: ${remaining}` : ""}`,
      };
    }
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;

    // A sendTurn while a real turn is running is a steer: the message is
    // queued into the live SDK agent loop and the work continues as the same
    // turn — no synthetic turn boundary. Stale synthetic turns (from
    // background agent responses between user prompts) are auto-closed
    // instead, so they don't block the user's next turn.
    const steeringTurnState =
      context.turnState && context.turnState.synthetic !== true ? context.turnState : null;
    if (
      input.nativePolicySteerTurnId &&
      steeringTurnState?.turnId !== input.nativePolicySteerTurnId
    ) {
      return yield* toRequestError(input.threadId, "turn/steer", "The original turn has ended.");
    }
    if (context.turnState && steeringTurnState === null) {
      yield* completeTurn(context, "completed");
    }

    if (modelSelection?.model) {
      const apiModelId = resolveClaudeApiModelId(modelSelection);
      if (context.currentApiModelId !== apiModelId) {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
        });
        context.currentApiModelId = apiModelId;
      }
      context.session = {
        ...context.session,
        model: modelSelection.model,
      };
      const turnCaps = getClaudeModelCapabilities(modelSelection.model);
      const turnEffort = resolveClaudeEffort(
        turnCaps,
        getModelSelectionStringOptionValue(modelSelection, "effort"),
      );
      context.currentEffort =
        getEffectiveClaudeAgentEffort(turnEffort ?? null, modelSelection.model) ?? undefined;
    }

    // Apply interaction mode by switching the SDK's permission mode.
    // "plan" maps directly to the SDK's "plan" permission mode;
    // "default" restores the session's original permission mode.
    // When interactionMode is absent we leave the current mode unchanged.
    if (input.interactionMode === "plan") {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode("plan"),
        catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
      });
      context.currentPermissionMode = "plan";
    } else if (input.interactionMode === "default") {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode(context.basePermissionMode ?? "default"),
        catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
      });
      context.currentPermissionMode = context.basePermissionMode ?? "default";
    }

    const turnId = steeringTurnState?.turnId ?? TurnId.make(yield* randomUUIDv4);
    if (steeringTurnState === null) {
      const turnState: ClaudeTurnState = {
        turnId,
        startedAt: yield* nowIso,
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        nextSyntheticAssistantBlockIndex: -1,
      };

      const updatedAt = yield* nowIso;
      context.turnState = turnState;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt,
      };

      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: modelSelection?.model ? { model: modelSelection.model } : {},
        providerRefs: {},
      });
    }

    const preparedMessage = yield* buildUserMessageEffect(sendInput, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      boundInstanceId,
    });
    const message: SDKUserMessage = {
      ...preparedMessage,
      uuid: (yield* randomUUIDv4) as NonNullable<SDKUserMessage["uuid"]>,
    };

    if (
      input.nativePolicySteerTurnId &&
      context.turnState?.turnId !== input.nativePolicySteerTurnId
    ) {
      return yield* toRequestError(input.threadId, "turn/steer", "The original turn has ended.");
    }
    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

    return {
      threadId: context.session.threadId,
      turnId,
      nativeMessageId: message.uuid,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn = Effect.fn("interruptTurn")(function* (
    context: ClaudeSessionContext,
    threadId: ThreadId,
    _turnId: Parameters<ClaudeAdapterShape["interruptTurn"]>[1],
    options: Parameters<ClaudeAdapterShape["interruptTurn"]>[2],
  ) {
    // Users reach for Stop when a fleet ran away: interrupt() alone only
    // ends the parent turn, so live agent tasks are stopped first
    // (best-effort per task: one refusal must not strand the rest or block
    // the turn interrupt). Watch loops the seat keeps for the person
    // (monitor tasks, background shells) survive a plain stop; only an
    // explicit stop-everything takes them down.
    const stopBackground = options?.stopBackground === true;
    if (context.query.stopTask && context.liveTaskIds.size > 0) {
      const liveIds = Array.from(context.liveTaskIds).filter((taskId) => {
        if (stopBackground) return true;
        const agent = context.taskAgents.get(taskId);
        // Plain Stop terminates both subagents and turn-spawned background shells
        // (`local_bash`); only explicit standing `monitor` watch loops survive unless
        // `stopBackground` is requested.
        if (agent?.taskType !== undefined && MONITOR_TASK_TYPES.has(agent.taskType)) {
          return false;
        }
        return (
          agent?.taskType === "local_bash" ||
          agent?.taskType === "shell" ||
          classifyTaskAgentKind({
            taskType: agent?.taskType,
            agentId: agent?.owningAgentId,
          }) === "agent"
        );
      });
      // Bounded: a wedged child's stopTask promise may never settle
      // (Effect.ignore handles rejection, not non-resolution), and the
      // parent interrupt below MUST still run — Stop matters most during
      // runaway fleets (review finding). Per-task timeout keeps one hung
      // child from consuming the whole budget.
      yield* Effect.forEach(
        liveIds,
        (taskId) => stopTrackedTask(context, taskId).pipe(Effect.ignore),
        {
          concurrency: 8,
          discard: true,
        },
      ).pipe(Effect.timeoutOption("10 seconds"), Effect.ignore);
    }
    // Bounded like the stopTask fan-out above: a wedged child never answers
    // the control request, and an unbounded await here turns one stuck
    // session into a permanently jammed interrupt path.
    const acknowledged = yield* Effect.tryPromise({
      try: () => context.query.interrupt(),
      catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
    }).pipe(Effect.timeoutOption("10 seconds"));
    if (Option.isNone(acknowledged)) {
      return yield* toRequestError(
        threadId,
        "turn/interrupt",
        new Error("Claude runtime did not acknowledge the interrupt within 10 seconds."),
      );
    }
  });

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return yield* snapshotThread(context);
    },
  );

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      yield* context.history.rollback(numTurns);
      yield* updateResumeCursor(context);
      return yield* snapshotThread(context);
    },
  );

  const respondToRequest = Effect.fn("respondToRequest")(function* (
    context: ClaudeSessionContext,
    requestId: Parameters<ClaudeAdapterShape["respondToRequest"]>[1],
    decision: Parameters<ClaudeAdapterShape["respondToRequest"]>[2],
  ) {
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/requestApproval/decision",
        detail: `Unknown pending approval request: ${requestId}`,
      });
    }

    context.pendingApprovals.delete(requestId);
    yield* Deferred.succeed(pending.decision, decision);
  });

  const respondToUserInput = Effect.fn("respondToUserInput")(function* (
    context: ClaudeSessionContext,
    requestId: Parameters<ClaudeAdapterShape["respondToUserInput"]>[1],
    answers: Parameters<ClaudeAdapterShape["respondToUserInput"]>[2],
  ) {
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: true,
        }),
      { discard: true },
    );

  const withTrackedControl = <A, E>(
    threadId: ThreadId,
    action: (context: ClaudeSessionContext) => Effect.Effect<A, E>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const release = context.beginControlOperation();
        if (!release) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        return yield* restore(action(context)).pipe(Effect.ensuring(Effect.sync(release)));
      }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: false,
        }),
      { discard: true },
    ).pipe(
      Effect.catch((cause) =>
        Effect.logError("Failed to emit Claude session shutdown event.", { cause }),
      ),
      Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
      Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      workspaceDelegate: () => true,
      nativeSubagentPolicy: (threadId) => {
        const context = sessions.get(threadId);
        return (
          context && {
            restricted: context.nativeSubagentsRestricted,
            syntheticTurn: context.turnState?.synthetic === true,
          }
        );
      },
      stopSessionDrainsEvents: true,
    },
    startSession,
    sendTurn: (input) => withTrackedControl(input.threadId, (context) => sendTurn(context, input)),
    interruptTurn: (threadId, turnId, options) =>
      withTrackedControl(threadId, (context) => interruptTurn(context, threadId, turnId, options)),
    stopBackgroundWatches,
    readThread,
    rollbackThread,
    respondToRequest: (threadId, requestId, decision) =>
      withTrackedControl(threadId, (context) => respondToRequest(context, requestId, decision)),
    respondToUserInput: (threadId, requestId, answers) =>
      withTrackedControl(threadId, (context) => respondToUserInput(context, requestId, answers)),
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies ClaudeAdapterShape;
});
