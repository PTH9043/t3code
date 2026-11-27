import { makeKeyedLock } from "@t3tools/shared/KeyedLock";
import {
  makeProviderTurnHistoryFactory,
  type ProviderTurnHistory,
} from "../ProviderTurnHistory.ts";
import {
  ApprovalRequestId,
  type GeminiSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  type TokenUsageObservation,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { acpManagedMcpServers, makeManagedMcpResolver } from "../../mcp/ManagedMcpTools.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { activeWorkRegistry } from "../../orchestration/ActiveWorkTracker.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyGeminiAcpModelSelection,
  currentGeminiModelIdFromSessionSetup,
  extractCoreUserTaskForThoughtRouting,
  makeGeminiAcpRuntime,
  recommendGeminiTurnThoughtLevel,
  resolveGeminiAcpBaseModelId,
} from "../acp/GeminiAcpSupport.ts";
import {
  createGeminiBackgroundTaskTracker,
  type GeminiBackgroundTaskTracker,
} from "../acp/GeminiBackgroundTaskTracker.ts";
import { syncAntigravityIsolatedSkillsConfig } from "../Drivers/GeminiSkills.ts";
import { evaluatePrematureStopGuard } from "../acp/GeminiPrematureStopGuard.ts";
import {
  buildBudgetedAntigravityMcpServers,
  detectDroppedT3CodeMcpTool,
} from "../acp/GeminiMcpToolRecovery.ts";
import { buildAntigravitySystemPromptAppend } from "../t3CoreToolInstructions.ts";
import { allocateDynamicWorkspaceBudget } from "../../orchestration/workspacePromptTokens.ts";
import { type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { acpPromptTokenConsumption } from "../tokenConsumption.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("gemini");
const GEMINI_RESUME_VERSION = 2 as const;
const MAX_PREMATURE_STOP_RETRIES = 3;

function addNullableTokenCounts(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

function mergeTokenUsageObservation(
  accumulated: TokenUsageObservation | undefined,
  next: TokenUsageObservation,
): TokenUsageObservation {
  if (!accumulated) {
    return next;
  }
  return {
    ...accumulated,
    model: next.model ?? accumulated.model,
    isFinal: next.isFinal,
    counts: {
      total: addNullableTokenCounts(accumulated.counts.total, next.counts.total),
      input: addNullableTokenCounts(accumulated.counts.input, next.counts.input),
      output: addNullableTokenCounts(accumulated.counts.output, next.counts.output),
      cacheRead: addNullableTokenCounts(accumulated.counts.cacheRead, next.counts.cacheRead),
      cacheWrite: addNullableTokenCounts(accumulated.counts.cacheWrite, next.counts.cacheWrite),
      reasoning: addNullableTokenCounts(accumulated.counts.reasoning, next.counts.reasoning),
    },
  };
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface GeminiAdapterLiveOptions {
  readonly launch?: import("../Drivers/AntigravityLaunch.ts").AntigravityLaunch;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly onTurnSettled?: () => Effect.Effect<void>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface GeminiSessionContext {
  readonly httpMcp: boolean;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly globalSystemInstructions: string | undefined;
  acpSessionId: string;
  session: ProviderSession;
  scope: Scope.Closeable;
  acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  markCallbacksClosed: () => void;
  drainCallbacks: Effect.Effect<void>;
  readonly history: ProviderTurnHistory;
  lastPlanFingerprint: string | undefined;
  turnPlanStatuses: ReadonlyArray<string>;
  attemptAssistantText: string;
  lastAssistantItemId: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  /** True only after at least one live turn has been dispatched on this ACP session; prevents session/load replay events from resurrecting historical background tasks. */
  hasStartedLiveTurn: boolean;
  lastAcpActivityAtMs: number;
  currentModelId: string | undefined;
  /** Structured `t3-code` tool drops detected during the active turn. */
  readonly droppedT3ToolsThisTurn: Set<string>;
  /** Guards automatic `t3-code`-only reconnect so it fires at most once per turn. */
  mcpRecoveryAttemptedThisTurn: boolean;
  t3CodeOnlyMcp: boolean;
  nativeSystemPromptApplied: boolean;
  readonly backgroundTracker: GeminiBackgroundTaskTracker;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: GeminiSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): Effect.Effect<void, ProviderAdapterProcessError> {
  return ctx.history
    .append(turnId, { prompt: promptParts, result })
    .pipe(Effect.andThen(ctx.history.complete(turnId)));
}

const resolveNotificationTurnId = (ctx: GeminiSessionContext): TurnId | undefined =>
  ctx.activeTurnId;

const resolveCallbackTurnId = (ctx: GeminiSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, GeminiSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

const GeminiResumeCursor = Schema.Struct({
  harness: Schema.Literal("antigravity"),
  schemaVersion: Schema.Literal(GEMINI_RESUME_VERSION),
  sessionId: Schema.String,
  instanceId: ProviderInstanceId,
  profileDirectory: Schema.String,
});
const decodeGeminiResumeCursor = Schema.decodeUnknownOption(GeminiResumeCursor);

function parseGeminiResume(
  raw: unknown,
  instanceId: ProviderInstanceId,
  profileDirectory: string,
): string | undefined {
  const decoded = decodeGeminiResumeCursor(raw);
  if (
    Option.isNone(decoded) ||
    decoded.value.instanceId !== instanceId ||
    decoded.value.profileDirectory !== profileDirectory
  )
    return undefined;
  const sessionId = decoded.value.sessionId.trim();
  return sessionId || undefined;
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  return response?.stopReason ?? null;
}

export function geminiPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

export function makeGeminiAdapter(
  geminiSettings: GeminiSettings,
  options?: GeminiAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("gemini");
    const onTurnSettled = options?.onTurnSettled;
    let lastQuotaRefreshAtMs = 0;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolveManagedMcp = yield* makeManagedMcpResolver();
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const createTurnHistory = yield* makeProviderTurnHistoryFactory;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, GeminiSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Antigravity runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Antigravity ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const offerSessionEvent = (ctx: GeminiSessionContext, event: ProviderRuntimeEvent) =>
      ctx.stopped ? Effect.void : offerRuntimeEvent(event);

    const withThreadLock = makeKeyedLock().withKey;

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx || liveCtx.stopped) {
          return;
        }
        const settlementBelongsToLiveContext = geminiPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!settlementBelongsToLiveContext) {
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (options?.emitTurnCompletion !== false) {
            if (options?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: options.errorMessage,
                },
              });
            } else if (options?.completedStopReason !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId,
                turnId,
                payload: {
                  state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: options.completedStopReason ?? null,
                },
              });
            }
          }
          return;
        }
        let settleTurnId = turnId;
        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
            if (!fallbackTurnId) {
              if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
                const updatedAt = yield* nowIso;
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
                liveCtx.activeTurnId = undefined;
                liveCtx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
              return;
            }
            settleTurnId = fallbackTurnId;
          }
        } else {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          ) {
            liveCtx.promptsInFlight = remainingPrompts;
            return;
          }
          liveCtx.promptsInFlight = remainingPrompts;
        }
        const updatedAt = yield* nowIso;
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;
        const shouldEmitCompletedTurn =
          options?.completedStopReason !== undefined && canEmitTurnCompletion;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };
        yield* liveCtx.backgroundTracker.onTurnEnded(
          settleTurnId,
          shouldEmitFailedTurn
            ? "failed"
            : options?.completedStopReason === "cancelled"
              ? "stopped"
              : "completed",
        );
        if (options?.emitTurnCompletion === false) {
          return;
        }
        if (shouldEmitFailedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: options.errorMessage,
            },
          });
        } else if (shouldEmitCompletedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: options.completedStopReason ?? null,
            },
          });
        }
        if (onTurnSettled && (shouldEmitCompletedTurn || shouldEmitFailedTurn)) {
          const nowMs = yield* Clock.currentTimeMillis;
          if (nowMs - lastQuotaRefreshAtMs >= 30_000) {
            lastQuotaRefreshAtMs = nowMs;
            yield* Effect.sync(() => {
              runFork(Effect.ignore(onTurnSettled()));
            });
          }
        }
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Antigravity notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: GeminiSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerSessionEvent(
          ctx,
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GeminiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: GeminiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        if (
          ctx.promptsInFlight === 0 &&
          ctx.notificationFiber &&
          ctx.notificationFiber.pollUnsafe() === undefined
        ) {
          yield* ctx.acp.drainEvents.pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);
        }
        ctx.stopped = true;
        ctx.backgroundTracker.dispose();
        ctx.markCallbacksClosed();
        sessions.delete(ctx.threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        const notificationFiber = ctx.notificationFiber;
        ctx.notificationFiber = undefined;
        if (notificationFiber && notificationFiber.pollUnsafe() === undefined) {
          yield* Fiber.interrupt(notificationFiber).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.ignore,
          );
        }
        yield* ctx.drainCallbacks.pipe(Effect.timeoutOption("5 seconds"), Effect.ignore);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const forkNotificationFiber = (
      ctx: GeminiSessionContext,
      acp: AcpSessionRuntime.AcpSessionRuntime["Service"],
      sessionScope: Scope.Closeable,
    ) =>
      Stream.runDrain(
        Stream.mapEffect(acp.getEvents(), (event) =>
          Effect.gen(function* () {
            if (event._tag === "EventStreamBarrier") {
              yield* Deferred.succeed(event.acknowledge, undefined);
              return;
            }
            ctx.lastAcpActivityAtMs = yield* Clock.currentTimeMillis;
            if (
              event._tag === "PlanUpdated" ||
              event._tag === "ToolCallUpdated" ||
              event._tag === "ContentDelta" ||
              event._tag === "ThoughtDelta"
            ) {
              yield* logNative(ctx.threadId, "session/update", event.rawPayload);
            }

            if (
              event._tag === "ModeChanged" ||
              event._tag === "AvailableCommandsUpdated" ||
              event._tag === "ConfigOptionsUpdated"
            ) {
              return;
            }

            const notificationTurnId = resolveNotificationTurnId(ctx);
            if (
              notificationTurnId === undefined ||
              ctx.interruptedTurnIds.has(notificationTurnId)
            ) {
              // Background task tool updates can arrive asynchronously between turns
              // (e.g. subagent completion or manage_task updates). Ignore anything
              // arriving before the first live turn (e.g. tail events from session/load replay).
              if (event._tag === "ToolCallUpdated" && !ctx.stopped && ctx.hasStartedLiveTurn) {
                yield* ctx.backgroundTracker.observeToolCall(
                  event.toolCall,
                  undefined,
                  ctx.currentModelId,
                );
              }
              return;
            }
            const stamp = yield* makeEventStamp();

            switch (event._tag) {
              case "AssistantItemStarted":
                yield* offerSessionEvent(
                  ctx,
                  makeAcpAssistantItemEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.started",
                  }),
                );
                return;
              case "AssistantItemCompleted":
                yield* offerSessionEvent(
                  ctx,
                  makeAcpAssistantItemEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.completed",
                  }),
                );
                return;
              case "PlanUpdated":
                ctx.turnPlanStatuses = event.payload.plan.map((step) => step.status);
                yield* emitPlanUpdate(
                  ctx,
                  notificationTurnId,
                  stamp,
                  event.payload,
                  event.rawPayload,
                  "session/update",
                );
                return;
              case "ToolCallUpdated": {
                const droppedT3Tool = detectDroppedT3CodeMcpTool({
                  status: event.toolCall.status,
                  detail: event.toolCall.detail,
                  data: event.toolCall.data,
                });
                if (droppedT3Tool) {
                  ctx.droppedT3ToolsThisTurn.add(droppedT3Tool.toolName);
                }
                yield* offerSessionEvent(
                  ctx,
                  makeAcpToolCallEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    toolCall: event.toolCall,
                    rawPayload: event.rawPayload,
                  }),
                );
                yield* ctx.backgroundTracker.observeToolCall(
                  event.toolCall,
                  notificationTurnId,
                  ctx.currentModelId,
                );
                return;
              }
              case "ContentDelta":
                ctx.attemptAssistantText += event.text;
                if (event.itemId) {
                  ctx.lastAssistantItemId = event.itemId;
                }
                yield* offerSessionEvent(
                  ctx,
                  makeAcpContentDeltaEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    ...(event.itemId ? { itemId: event.itemId } : {}),
                    text: event.text,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "ThoughtDelta":
                yield* offerSessionEvent(
                  ctx,
                  makeAcpContentDeltaEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    text: event.text,
                    streamKind: "reasoning_text",
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "UsageUpdated":
                if (event.used > 0 && event.size > 0) {
                  yield* offerSessionEvent(ctx, {
                    type: "thread.token-usage.updated",
                    ...stamp,
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    payload: {
                      usage: {
                        usedTokens: event.used,
                        maxTokens: event.size,
                        inputTokens: event.used,
                        outputTokens: 0,
                        lastUsedTokens: event.used,
                      },
                    },
                  });
                }
                return;
            }
          }),
        ),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to process Antigravity runtime notification.", { cause }),
        ),
        Effect.forkIn(sessionScope),
      );

    const launchAcpConnection = (params: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly runtimeMode: RuntimeMode;
      readonly resumeSessionId?: string | undefined;
      readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
      readonly globalSystemInstructions?: string | undefined;
      readonly t3CodeOnly?: boolean | undefined;
    }) =>
      Effect.gen(function* () {
        let callbacksClosed = false;
        let activeCallbacks = 0;
        const callbacksDrained = yield* Deferred.make<void>();
        const markCallbacksClosed = () => {
          callbacksClosed = true;
          if (activeCallbacks === 0) {
            Deferred.doneUnsafe(callbacksDrained, Exit.void);
          }
        };
        const drainCallbacks = Effect.suspend(() =>
          activeCallbacks === 0 ? Effect.void : Deferred.await(callbacksDrained),
        );
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );

        const acpNativeLoggers = makeAcpNativeLoggers({
          nativeEventLogger,
          provider: PROVIDER,
          threadId: params.threadId,
        });

        const mcpSession = McpProviderSession.readMcpProviderSession(params.threadId);
        const managedServers = params.t3CodeOnly
          ? []
          : acpManagedMcpServers(yield* resolveManagedMcp(PROVIDER, params.cwd));
        const t3CodeServer = mcpSession
          ? {
              type: "http" as const,
              name: "t3-code",
              url: mcpSession.endpoint,
              headers: [
                {
                  name: "Authorization",
                  value: mcpSession.authorizationHeader,
                },
              ],
            }
          : undefined;
        const budgetedMcp = buildBudgetedAntigravityMcpServers({
          t3CodeServer,
          managedServers,
          ...(params.t3CodeOnly ? { t3CodeOnly: true } : {}),
        });
        if (!params.t3CodeOnly && budgetedMcp.excludedServers.length > 0) {
          yield* Effect.logWarning(
            "Excluded external MCP servers from Antigravity session to preserve t3-code tool budget.",
            {
              threadId: params.threadId,
              budget: budgetedMcp.budget,
              estimatedTotalTools: budgetedMcp.estimatedTotalTools,
              excludedServers: budgetedMcp.excludedServers,
            },
          );
        }

        const systemPromptAppend = buildAntigravitySystemPromptAppend({
          globalInstructions: params.globalSystemInstructions,
        });

        const acp = yield* makeGeminiAcpRuntime({
          geminiSettings,
          launch: options?.launch,
          runtimeMode: params.runtimeMode,
          ...(options?.environment ? { environment: options.environment } : {}),
          childProcessSpawner,
          cwd: params.cwd,
          ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
          clientInfo: { name: "t3-code", version: "0.0.0" },
          ...(budgetedMcp.mcpServers.length > 0 ? { mcpServers: budgetedMcp.mcpServers } : {}),
          systemPromptAppend,
          ...acpNativeLoggers,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: params.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        const started = yield* Effect.gen(function* () {
          yield* acp.handleRequestPermission((permissionParams) =>
            mapAcpCallbackFailure(
              Effect.gen(function* () {
                if (callbacksClosed) {
                  return {
                    outcome: { outcome: "cancelled" } as const,
                  };
                }
                activeCallbacks += 1;
                return yield* Effect.gen(function* () {
                  yield* logNative(params.threadId, "session/request_permission", permissionParams);
                  if (callbacksClosed) {
                    return { outcome: { outcome: "cancelled" } as const };
                  }
                  if (params.runtimeMode === "full-access") {
                    const autoApprovedOptionId =
                      selectAutoApprovedPermissionOption(permissionParams);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(permissionParams);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, params.threadId);
                  params.pendingApprovals.set(requestId, { decision });
                  if (callbacksClosed) {
                    params.pendingApprovals.delete(requestId);
                    return { outcome: { outcome: "cancelled" } as const };
                  }
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: params.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(permissionParams)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: permissionParams,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: permissionParams,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  params.pendingApprovals.delete(requestId);
                  if (!callbacksClosed) {
                    yield* offerRuntimeEvent(
                      makeAcpRequestResolvedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: params.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        permissionRequest,
                        decision: resolved,
                      }),
                    );
                  }
                  const selectedOptionId =
                    resolved === "cancel"
                      ? undefined
                      : selectPermissionOptionId(permissionParams, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      activeCallbacks = Math.max(0, activeCallbacks - 1);
                      if (callbacksClosed && activeCallbacks === 0) {
                        Deferred.doneUnsafe(callbacksDrained, Exit.void);
                      }
                    }),
                  ),
                );
              }),
            ),
          );
          return yield* acp.start();
        }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, params.threadId, "session/start", error),
          ),
        );

        sessionScopeTransferred = true;
        return {
          acp,
          started,
          sessionScope,
          markCallbacksClosed,
          drainCallbacks,
          budgetedMcp,
        };
      });

    const reconnectSessionWithT3CodePriority = (
      threadId: ThreadId,
      expectedAcpSessionId: string,
      modelOptions?: import("@t3tools/contracts").ModelSelection["options"],
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped || ctx.acpSessionId !== expectedAcpSessionId) {
            return undefined;
          }
          const profileDirectory = options?.launch?.profileDirectory ?? "";
          const launched = yield* launchAcpConnection({
            threadId,
            cwd: ctx.cwd,
            runtimeMode: ctx.runtimeMode,
            resumeSessionId: ctx.acpSessionId,
            pendingApprovals: ctx.pendingApprovals,
            globalSystemInstructions: ctx.globalSystemInstructions,
            t3CodeOnly: true,
          }).pipe(Effect.scoped);

          const requestedModelId = ctx.currentModelId
            ? resolveGeminiAcpBaseModelId(ctx.currentModelId)
            : undefined;
          const boundModelId = yield* applyGeminiAcpModelSelection({
            runtime: launched.acp,
            currentModelId: currentGeminiModelIdFromSessionSetup(
              launched.started.sessionSetupResult,
            ),
            requestedModelId,
            options: modelOptions,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/set_config_option", cause),
          }).pipe(
            Effect.onError(() => Effect.ignore(Scope.close(launched.sessionScope, Exit.void))),
          );

          const oldScope = ctx.scope;
          const oldNotificationFiber = ctx.notificationFiber;
          const oldMarkCallbacksClosed = ctx.markCallbacksClosed;
          const oldDrainCallbacks = ctx.drainCallbacks;

          ctx.scope = launched.sessionScope;
          ctx.acp = launched.acp;
          ctx.acpSessionId = launched.started.sessionId;
          ctx.markCallbacksClosed = launched.markCallbacksClosed;
          ctx.drainCallbacks = launched.drainCallbacks;
          ctx.currentModelId = boundModelId;
          ctx.t3CodeOnlyMcp = true;
          ctx.nativeSystemPromptApplied = launched.started.nativeSystemPromptApplied;
          ctx.session = {
            ...ctx.session,
            ...(boundModelId ? { model: resolveGeminiAcpBaseModelId(boundModelId) } : {}),
            resumeCursor: {
              harness: "antigravity",
              instanceId: boundInstanceId,
              profileDirectory,
              schemaVersion: GEMINI_RESUME_VERSION,
              sessionId: launched.started.sessionId,
            },
            updatedAt: yield* nowIso,
          };
          ctx.notificationFiber = yield* forkNotificationFiber(
            ctx,
            launched.acp,
            launched.sessionScope,
          );

          oldMarkCallbacksClosed();
          yield* Effect.ignore(Scope.close(oldScope, Exit.void));
          if (oldNotificationFiber && oldNotificationFiber.pollUnsafe() === undefined) {
            yield* Fiber.interrupt(oldNotificationFiber).pipe(
              Effect.timeoutOption("5 seconds"),
              Effect.ignore,
            );
          }
          yield* oldDrainCallbacks.pipe(Effect.timeoutOption("5 seconds"), Effect.ignore);

          return {
            acp: launched.acp,
            acpSessionId: launched.started.sessionId,
          };
        }),
      );

    const startSession: GeminiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const geminiModelSelection = input.modelSelection;
          if (geminiModelSelection && geminiModelSelection.instanceId !== boundInstanceId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The selected Antigravity model belongs to a different account.",
            });
          }
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const profileDirectory = options?.launch?.profileDirectory ?? "";
          if (options?.launch?.geminiDir) {
            syncAntigravityIsolatedSkillsConfig({ geminiDir: options.launch.geminiDir });
          }
          const resumeSessionId = parseGeminiResume(
            input.resumeCursor,
            boundInstanceId,
            profileDirectory,
          );
          const launched = yield* launchAcpConnection({
            threadId: input.threadId,
            cwd,
            runtimeMode: input.runtimeMode,
            resumeSessionId,
            pendingApprovals,
            globalSystemInstructions: input.globalSystemInstructions,
          });
          const { acp, started, sessionScope, markCallbacksClosed, drainCallbacks, budgetedMcp } =
            launched;

          const requestedStartModelId = geminiModelSelection?.model
            ? resolveGeminiAcpBaseModelId(geminiModelSelection.model)
            : undefined;
          const boundModelId = yield* applyGeminiAcpModelSelection({
            runtime: acp,
            currentModelId: currentGeminiModelIdFromSessionSetup(started.sessionSetupResult),
            requestedModelId: requestedStartModelId,
            options: geminiModelSelection?.options,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
          }).pipe(Effect.onError(() => Effect.ignore(Scope.close(sessionScope, Exit.void))));

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            continuity: resumeSessionId
              ? "resumed"
              : input.resumeCursor
                ? "resume-fallback"
                : "new",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: resolveGeminiAcpBaseModelId(boundModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              harness: "antigravity",
              instanceId: boundInstanceId,
              profileDirectory,
              schemaVersion: GEMINI_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: GeminiSessionContext = {
            threadId: input.threadId,
            cwd,
            runtimeMode: input.runtimeMode,
            globalSystemInstructions: input.globalSystemInstructions,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            markCallbacksClosed,
            drainCallbacks,
            history: yield* createTurnHistory({
              directory: path.join(serverConfig.stateDir, "provider-history", PROVIDER),
              provider: PROVIDER,
              threadId: input.threadId,
            }),
            lastPlanFingerprint: undefined,
            turnPlanStatuses: [],
            attemptAssistantText: "",
            lastAssistantItemId: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            hasStartedLiveTurn: false,
            lastAcpActivityAtMs: yield* Clock.currentTimeMillis,
            httpMcp: started.initializeResult.agentCapabilities?.mcpCapabilities?.http === true,
            currentModelId: boundModelId,
            droppedT3ToolsThisTurn: new Set(),
            mcpRecoveryAttemptedThisTurn: false,
            t3CodeOnlyMcp: false,
            nativeSystemPromptApplied: started.nativeSystemPromptApplied,
            backgroundTracker: createGeminiBackgroundTaskTracker({
              threadId: input.threadId,
              profileDirectories: [profileDirectory],
              makeEventStamp,
              emitEvent: (event) => offerRuntimeEvent(event),
            }),
            stopped: false,
          };

          ctx.notificationFiber = yield* forkNotificationFiber(ctx, acp, sessionScope);
          sessions.set(input.threadId, ctx);

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          if (budgetedMcp.excludedServers.length > 0) {
            const excludedNames = budgetedMcp.excludedServers.map((s) => s.name).join(", ");
            yield* offerSessionEvent(ctx, {
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              payload: {
                message: `t3-code 핵심 도구 보호를 위해 Antigravity 도구 예산(${budgetedMcp.budget}개)을 초과하는 외부 MCP(${excludedNames})를 이번 세션에서 제외했습니다.`,
                detail: {
                  kind: "antigravity-mcp-budget-trimmed",
                  budget: budgetedMcp.budget,
                  estimatedTotalTools: budgetedMcp.estimatedTotalTools,
                  excludedServers: budgetedMcp.excludedServers,
                },
              },
            });
          }
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Antigravity ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: GeminiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            // A sendTurn while a prompt is in flight is a steer: the agent
            // folds the new prompt into the ongoing work, so the active turn
            // id is reused instead of opening a new turn.
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            // Count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1;
            ctx.hasStartedLiveTurn = true;
            ctx.lastAcpActivityAtMs = yield* Clock.currentTimeMillis;
            // ACP stdio serializes one `session/prompt` per session. Pre-emptively
            // cancel any in-flight prompt when steering so a hung command or long
            // tool loop immediately yields the semaphore to the user's new prompt.
            if (steeringTurnId !== undefined) {
              yield* Effect.ignore(ctx.acp.cancel);
            }
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const turnModelSelection = input.modelSelection;
              if (turnModelSelection && turnModelSelection.instanceId !== boundInstanceId) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "The selected Antigravity model belongs to a different account.",
                });
              }
              if (input.interactionMode) {
                const modes = yield* ctx.acp.getConfigOptions;
                const picker = modes.find(
                  (option) => option.category === "mode" || option.id === "mode",
                );
                if (picker?.type === "select") {
                  const desired = input.interactionMode === "plan" ? "plan" : "default";
                  const reply = yield* ctx.acp
                    .setConfigOption(picker.id, desired)
                    .pipe(
                      Effect.mapError((cause) =>
                        mapAcpToAdapterError(
                          PROVIDER,
                          input.threadId,
                          "session/set_config_option",
                          cause,
                        ),
                      ),
                    );
                  if (
                    !reply.configOptions.some(
                      (option) => option.id === picker.id && option.currentValue === desired,
                    )
                  ) {
                    return yield* new ProviderAdapterValidationError({
                      provider: PROVIDER,
                      operation: "sendTurn",
                      issue: "Antigravity did not confirm the selected execution mode.",
                    });
                  }
                } else if (input.interactionMode === "plan") {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: "Antigravity did not advertise plan mode.",
                  });
                }
              }
              const requestedTurnModelId = turnModelSelection?.model
                ? resolveGeminiAcpBaseModelId(turnModelSelection.model)
                : undefined;
              const autoThoughtLevel =
                geminiSettings.autoOptimizeThoughtLevel !== false &&
                !(turnModelSelection?.options && turnModelSelection.options.length > 0)
                  ? recommendGeminiTurnThoughtLevel(
                      allocateDynamicWorkspaceBudget(
                        extractCoreUserTaskForThoughtRouting(input.input),
                      ).profile,
                      {
                        interactionMode: input.interactionMode,
                        prompt: input.input,
                      },
                    )
                  : undefined;
              const currentModelId = yield* applyGeminiAcpModelSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: requestedTurnModelId,
                options: turnModelSelection?.options,
                autoThoughtLevel,
                mapError: (cause) =>
                  mapAcpToAdapterError(
                    PROVIDER,
                    input.threadId,
                    "session/set_config_option",
                    cause,
                  ),
              });

              const text = input.input?.trim();
              const imagePromptParts = yield* Effect.forEach(
                input.attachments ?? [],
                (attachment) =>
                  Effect.gen(function* () {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });
                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }
                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    );
                    return {
                      type: "image",
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                    } satisfies EffectAcpSchema.ContentBlock;
                  }),
              );
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...imagePromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              ctx.currentModelId = currentModelId;
              const displayModel = currentModelId
                ? resolveGeminiAcpBaseModelId(currentModelId)
                : undefined;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Antigravity prompt was interrupted during preparation.",
                });
              }
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
                ctx.turnPlanStatuses = [];
                ctx.attemptAssistantText = "";
                ctx.lastAssistantItemId = undefined;
                ctx.droppedT3ToolsThisTurn.clear();
                ctx.mcpRecoveryAttemptedThisTurn = false;
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              if (steeringTurnId === undefined) {
                yield* offerSessionEvent(ctx, {
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                });
              }

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Antigravity prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);
        const usageRequestId = yield* randomUUIDv4;
        let activeAcp = prepared.acp;
        let activeAcpSessionId = prepared.acpSessionId;

        return yield* Effect.gen(function* () {
          let currentPromptParts: ReadonlyArray<EffectAcpSchema.ContentBlock> =
            prepared.promptParts;
          let retryCount = 0;
          const previousSignatures: string[] = [];
          let result: EffectAcpSchema.PromptResponse;
          let accumulatedConsumption: TokenUsageObservation | undefined;

          while (true) {
            const liveBeforePrompt = sessions.get(input.threadId);
            if (liveBeforePrompt && liveBeforePrompt.acpSessionId === activeAcpSessionId) {
              liveBeforePrompt.attemptAssistantText = "";
              liveBeforePrompt.lastAcpActivityAtMs = yield* Clock.currentTimeMillis;
            }

            const promptResult = yield* Effect.scoped(
              Effect.gen(function* () {
                const watchedSessionId = activeAcpSessionId;
                yield* Effect.gen(function* () {
                  yield* Effect.sleep("180 seconds");
                  const currentCtx = sessions.get(input.threadId);
                  if (
                    !currentCtx ||
                    currentCtx.stopped ||
                    currentCtx.acpSessionId !== watchedSessionId ||
                    currentCtx.activeTurnId !== prepared.turnId ||
                    currentCtx.pendingApprovals.size > 0
                  ) {
                    return;
                  }
                  const nowMs = yield* Clock.currentTimeMillis;
                  if (nowMs - currentCtx.lastAcpActivityAtMs >= 175_000) {
                    yield* offerSessionEvent(currentCtx, {
                      type: "runtime.warning",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      providerInstanceId: boundInstanceId,
                      threadId: input.threadId,
                      turnId: prepared.turnId,
                      payload: {
                        message:
                          "실행 중인 명령 또는 응답이 3분 이상 무응답 대기 중입니다. 대화형 인증/입력 대기 중이거나 멈춘 경우 중지 버튼이나 추가 지시로 즉시 전환할 수 있습니다.",
                        detail: { kind: "acp-prompt-stall-warning", silentSeconds: 180 },
                      },
                    });
                  }
                }).pipe(Effect.ignore, Effect.forkScoped);

                return yield* activeAcp
                  .prompt({
                    prompt: currentPromptParts,
                  })
                  .pipe(
                    Effect.tap((resolvedResult) =>
                      Effect.all([
                        Ref.set(promptRpcSucceeded, true),
                        Ref.set(promptResultRef, resolvedResult),
                      ]),
                    ),
                    Effect.tapError((error) =>
                      Ref.set(
                        promptFailureMessageRef,
                        mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error)
                          .message,
                      ).pipe(Effect.andThen(activeAcp.drainEvents)),
                    ),
                    Effect.mapError((error) =>
                      mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                    ),
                  );
              }),
            );

            result = promptResult;

            const stepConsumption = acpPromptTokenConsumption({
              provider: "gemini",
              requestId: usageRequestId,
              model: prepared.displayModel ?? null,
              result: promptResult,
            });
            if (stepConsumption.length > 0) {
              accumulatedConsumption = mergeTokenUsageObservation(
                accumulatedConsumption,
                stepConsumption[0]!,
              );
            }

            const liveBeforeDrain = sessions.get(input.threadId);
            const abortedBeforeDrain =
              promptResult.stopReason === "cancelled" ||
              !liveBeforeDrain ||
              liveBeforeDrain.stopped ||
              liveBeforeDrain.acpSessionId !== activeAcpSessionId ||
              liveBeforeDrain.interruptedTurnIds.has(prepared.turnId) ||
              liveBeforeDrain.promptsInFlight > 1 ||
              liveBeforeDrain.activeTurnId !== prepared.turnId;

            if (abortedBeforeDrain) {
              break;
            }

            // Flush streamed ContentDelta / PlanUpdated events before evaluating premature stop.
            // Guard with a timeout so a concurrent stopSession interrupting notificationFiber cannot hang.
            yield* activeAcp.drainEvents.pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);

            const liveAfterPrompt = sessions.get(input.threadId);
            const isAborted =
              !liveAfterPrompt ||
              liveAfterPrompt.stopped ||
              liveAfterPrompt.acpSessionId !== activeAcpSessionId ||
              liveAfterPrompt.interruptedTurnIds.has(prepared.turnId) ||
              liveAfterPrompt.promptsInFlight > 1 ||
              liveAfterPrompt.activeTurnId !== prepared.turnId;

            const activeDelegationCount = activeWorkRegistry
              .snapshot()
              .items.filter(
                (item) => item.kind === "delegation" && item.threadId === input.threadId,
              ).length;

            const droppedT3Tools = Array.from(liveAfterPrompt?.droppedT3ToolsThisTurn ?? []);
            const guardDecision = evaluatePrematureStopGuard({
              assistantText: liveAfterPrompt?.attemptAssistantText ?? "",
              planStatuses: liveAfterPrompt?.turnPlanStatuses ?? [],
              hasPendingApproval: (liveAfterPrompt?.pendingApprovals.size ?? 0) > 0,
              isAborted,
              retryCount,
              maxRetries: MAX_PREMATURE_STOP_RETRIES,
              previousSignatures,
              activeDelegationCount,
              activeBackgroundTaskCount:
                liveAfterPrompt?.backgroundTracker.nonDaemonActiveCount() ?? 0,
              unrecoveredT3ToolDrops: droppedT3Tools,
              alreadyAttemptedMcpRecovery: liveAfterPrompt?.mcpRecoveryAttemptedThisTurn ?? false,
            });

            if (!guardDecision.shouldContinue || !guardDecision.repairPrompt) {
              break;
            }

            if (guardDecision.reason === "t3_mcp_tool_dropped" && liveAfterPrompt) {
              liveAfterPrompt.mcpRecoveryAttemptedThisTurn = true;
              liveAfterPrompt.droppedT3ToolsThisTurn.clear();
              const reconnected = yield* reconnectSessionWithT3CodePriority(
                input.threadId,
                activeAcpSessionId,
                input.modelSelection?.options,
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    "Automatic t3-code-only ACP reconnect failed; keeping original turn result.",
                    { threadId: input.threadId, droppedT3Tools, cause },
                  ).pipe(Effect.as(undefined)),
                ),
              );
              if (!reconnected) {
                break;
              }
              activeAcp = reconnected.acp;
              activeAcpSessionId = reconnected.acpSessionId;
            }

            previousSignatures.push(guardDecision.normalizedSignature);
            retryCount += 1;

            if (
              liveAfterPrompt &&
              liveAfterPrompt.acpSessionId === activeAcpSessionId &&
              !liveAfterPrompt.stopped
            ) {
              if (guardDecision.activityLog) {
                yield* offerSessionEvent(liveAfterPrompt, {
                  type: "runtime.warning",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: {
                    message: guardDecision.activityLog,
                    detail: {
                      kind:
                        guardDecision.reason === "t3_mcp_tool_dropped"
                          ? "t3-mcp-tool-auto-recovery"
                          : "premature-stop-guard",
                      reason: guardDecision.reason,
                      ...(droppedT3Tools.length > 0 ? { droppedT3Tools } : {}),
                      retry: retryCount,
                      maxRetries: MAX_PREMATURE_STOP_RETRIES,
                      telemetry: guardDecision.telemetry,
                    },
                  },
                });
              }

              // Edge #4: Emit a clean paragraph break before the continuation response deltas.
              if (
                liveAfterPrompt.attemptAssistantText.length > 0 &&
                !liveAfterPrompt.attemptAssistantText.endsWith("\n\n")
              ) {
                const separator = liveAfterPrompt.attemptAssistantText.endsWith("\n")
                  ? "\n"
                  : "\n\n";
                yield* offerSessionEvent(
                  liveAfterPrompt,
                  makeAcpContentDeltaEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    ...(liveAfterPrompt.lastAssistantItemId
                      ? { itemId: liveAfterPrompt.lastAssistantItemId }
                      : {}),
                    text: separator,
                    rawPayload: { synthetic: "premature-stop-separator" },
                  }),
                );
              }
            }

            currentPromptParts = [{ type: "text" as const, text: guardDecision.repairPrompt }];
          }

          const liveCtx = sessions.get(input.threadId);
          if (
            accumulatedConsumption !== undefined &&
            liveCtx &&
            liveCtx.acpSessionId === activeAcpSessionId
          ) {
            yield* offerSessionEvent(liveCtx, {
              type: "thread.token-usage.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: prepared.turnId,
              payload: { consumption: [accumulatedConsumption] },
            });
          }

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = sessions.get(input.threadId);
              if (!ctx) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                };
              }
              if (ctx.acpSessionId !== activeAcpSessionId) {
                yield* settlePromptInFlight(input.threadId, prepared.turnId, activeAcpSessionId, {
                  errorMessage: "Antigravity session changed before the turn completed.",
                  settleAllPrompts: true,
                });
                yield* Ref.set(promptSettled, true);
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Antigravity session changed before the turn completed.",
                });
              }
              // Keep prompt settlement atomic with respect to Stop and steering.
              // interruptTurn marks its target before waiting for this lock, so
              // cancellation can still win while queued ACP events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              yield* activeAcp.drainEvents;
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              ) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              yield* appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };
              const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
              ctx.promptsInFlight = remainingPrompts;

              // Only the last remaining prompt settles the turn. A steer-
              // superseded prompt resolving while another is in flight or
              // pending must leave the merged turn running.
              if (
                remainingPrompts === 0 &&
                ctx.activeTurnId === prepared.turnId &&
                ctx.session.activeTurnId === prepared.turnId
              ) {
                if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                  yield* Ref.set(promptSettled, true);
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  };
                }
                const completedAt = yield* nowIso;
                const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                ctx.activeTurnId = undefined;
                ctx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt: completedAt,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                };
                const completedStopReason = completedStopReasonFromPromptResponse(result);
                ctx.interruptedTurnIds.delete(prepared.turnId);
                yield* Ref.set(promptSettled, true);
                yield* offerSessionEvent(ctx, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: {
                    state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: completedStopReason,
                  },
                });
              } else if (remainingPrompts > 0) {
                yield* Ref.set(promptSettled, true);
              }

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult === undefined) {
                  return;
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = sessions.get(input.threadId);
                    if (!ctx) {
                      return;
                    }
                    if (ctx.acpSessionId !== activeAcpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        activeAcpSessionId,
                        {
                          errorMessage: "Antigravity session changed before the turn completed.",
                          settleAllPrompts: true,
                        },
                      );
                      return;
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }
                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    ) {
                      return;
                    }
                    yield* appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      activeAcpSessionId,
                      {
                        completedStopReason: completedStopReasonFromPromptResponse(promptResult),
                      },
                    );
                  }),
                );
                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, activeAcpSessionId, {
                  errorMessage: errorMessage ?? "Antigravity prompt request failed.",
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    const interruptTurn: GeminiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          return;
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return;
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* ctx.backgroundTracker.cancelAll("stopped");
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
              ),
            );
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
          }),
        );
      });

    const respondToRequest: GeminiAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: GeminiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      _answers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/user_input",
          detail: `Antigravity ACP has no pending structured user-input request: ${requestId}`,
        });
      });

    const readThread: GeminiAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: yield* ctx.history.read };
      });

    const rollbackThread: GeminiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Antigravity ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: GeminiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: GeminiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: GeminiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: GeminiAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        workspaceDelegate: (threadId) => sessions.get(threadId)?.httpMcp === true,
        stopSessionDrainsEvents: true,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies GeminiAdapterShape;
  });
}
