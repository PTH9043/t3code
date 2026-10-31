import { buildConversationHandoff, prepareCompactHandoff } from "../conversationHandoff.ts";
import { describeInputComposition } from "../inputComposition.ts";
import { WorkspaceMemory } from "../WorkspaceMemory.ts";
import { prepareAttachmentDocumentRag } from "../../documents/attachmentDocumentRag.ts";
import { ServerConfig } from "../../config.ts";
import { prepareFileAttachmentsForProvider } from "../../provider/fileAttachments.ts";
import { withFullAccessExecutionPolicy } from "../../provider/fullAccessExecutionPolicy.ts";
import { WorkspaceDevelopment } from "../WorkspaceDevelopment.ts";
import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type MessageId,
  type OrchestrationEvent,
  ProviderDriverKind,
  WorkspaceExecutionRequestRoute,
  WorkspaceOrchestraBlock,
  type OrchestrationThread,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker, makeKeyedDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  chooseAutomaticAccount,
  isActualRateLimitFailure,
} from "../../provider/providerAccountSwitch.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadRuntimeRead,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

const isExecutionRequestRoute = Schema.is(WorkspaceExecutionRequestRoute);
const isOrchestraBlock = Schema.is(WorkspaceOrchestraBlock);
function resolveExecutionRequest(thread: OrchestrationThread, requestId: string) {
  for (const activity of thread.activities.toReversed()) {
    if (isExecutionRequestRoute(activity.payload) && activity.payload.requestId === requestId) {
      return activity.payload;
    }
  }
  return undefined;
}

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.session-set";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export { buildConversationHandoff } from "../conversationHandoff.ts";

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }
  const text = message.text.trim();
  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");
  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");
  return contents.length > 0 ? `${message.role.toUpperCase()}:\n${contents}` : undefined;
}

function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);
    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(
          ...(message.attachments ?? []).filter((attachment) => attachment.type === "image"),
        );
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(
      ...(message.attachments ?? []).filter((attachment) => attachment.type === "image"),
    );
  }

  return { context, attachments: retainedAttachments, truncated };
}

function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  const recent = collectRecentThreadTitleContext(messages, MAX_THREAD_TITLE_CONTEXT_CHARS);
  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );
  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;
  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recent.context}`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);
  const recentContextBudget =
    MAX_THREAD_TITLE_CONTEXT_CHARS -
    pinnedSection.length -
    "\n\n".length -
    THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.find(
    (attachment) => attachment.type === "image",
  );
  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const userTurnAccounts = new Map<ThreadId, string>();

  const selectAutomaticAccount = Effect.fn("selectAutomaticAccount")(function* (
    thread: OrchestrationThread,
    selection: ModelSelection,
    createdAt: string,
  ) {
    const settings = yield* serverSettingsService.getSettings;
    if (!settings.providerAutoSwitch.codex && !settings.providerAutoSwitch.claudeAgent)
      return selection;
    const development = yield* Effect.serviceOption(WorkspaceDevelopment);
    if (Option.isSome(development)) {
      const state = yield* development.value.get(thread.projectId);
      if (state?.enabled && state.bindings.some((binding) => binding.sessionKey === thread.id))
        return selection;
    }
    const sessions = yield* providerService.listSessions();
    if (
      sessions.some(
        (session) =>
          session.threadId === thread.id &&
          (session.status === "running" || session.activeTurnId != null),
      )
    )
      return selection;
    const providers = yield* providerRegistry.getProviders;
    const current = providers.find((provider) => provider.instanceId === selection.instanceId);
    if (
      !current ||
      (current.driver !== "codex" && current.driver !== "claudeAgent") ||
      !(current.driver === "codex"
        ? settings.providerAutoSwitch.codex
        : settings.providerAutoSwitch.claudeAgent)
    )
      return selection;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const blocked = new Set<string>();
    if (
      thread.session?.providerInstanceId &&
      isActualRateLimitFailure(thread.session.lastError) &&
      nowMs - Date.parse(thread.session.updatedAt) < 5 * 60_000
    )
      blocked.add(thread.session.providerInstanceId);
    if (projectionSnapshotQuery.getRateLimitedAccountIds !== undefined) {
      const ids = yield* projectionSnapshotQuery.getRateLimitedAccountIds(
        DateTime.formatIso(DateTime.makeUnsafe(nowMs - 5 * 60_000)),
      );
      for (const instanceId of ids) blocked.add(instanceId);
    }
    // A second configured label pointing at the same account is not a fallback account.
    const currentInfo = yield* providerService.getInstanceInfo(selection.instanceId);
    const independent = yield* Effect.filter(providers, (candidate) =>
      candidate.driver !== current.driver || candidate.instanceId === current.instanceId
        ? Effect.succeed(true)
        : providerService.getInstanceInfo(candidate.instanceId).pipe(
            Effect.map(
              (info) =>
                info.continuationIdentity.continuationKey !==
                currentInfo.continuationIdentity.continuationKey,
            ),
            Effect.catch(() => Effect.succeed(false)),
          ),
    );
    const candidate = chooseAutomaticAccount({
      selection,
      providers: independent,
      settings: settings.providerAutoSwitch,
      blockedInstanceIds: blocked,
      nowMs,
    });
    if (!candidate) return selection;
    const latest = yield* resolveThread(thread.id);
    if (!latest || !Equal.equals(latest.modelSelection, selection))
      return latest?.modelSelection ?? selection;
    const latestSessions = yield* providerService.listSessions();
    if (
      latestSessions.some(
        (session) =>
          session.threadId === thread.id &&
          (session.status === "running" || session.activeTurnId != null),
      )
    )
      return selection;
    const next = { ...selection, instanceId: candidate.instanceId };
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield* serverCommandId("account-auto-switch"),
      threadId: thread.id,
      modelSelection: next,
    });
    threadModelSelections.set(thread.id, next);
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("account-auto-switch-activity"),
      threadId: thread.id,
      createdAt,
      activity: {
        id: yield* serverEventId(),
        kind: "provider.account.auto-switched",
        tone: "info",
        summary: `${current.driver === "codex" ? "Codex" : "Claude"} 계정 자동 전환: ${candidate.displayName ?? candidate.instanceId}`,
        payload: {
          previousInstanceId: selection.instanceId,
          nextInstanceId: candidate.instanceId,
          reason: blocked.has(selection.instanceId) ? "rate-limit-429" : "quota-exhausted",
          requestReplayed: false,
        },
        turnId: null,
        createdAt,
      },
    });
    return next;
  });

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    read?: ProjectionThreadRuntimeRead,
  ) {
    return yield* projectionSnapshotQuery
      .getThreadRuntimeContext(threadId, {
        activityKinds: [
          "conversation.imported",
          "orchestra.block",
          "approval.requested",
          "approval.resolved",
          "user-input.requested",
          "user-input.resolved",
        ],
        ...read,
      })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      readonly runtimeMode?: RuntimeMode;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = options?.runtimeMode ?? thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    // Only a LIVE session binds the thread to its provider — and even a live
    // binding is not a cage. Asking for a provider that cannot continue this
    // session's context (another driver, an incompatible continuation, a
    // model the provider can only serve from a new provider thread) stops the
    // session and starts fresh, the way a meeting hands one conversation from
    // seat to seat. The caller prepends a conversation handoff to the next
    // turn so the incoming model keeps the context.
    let releasedSessionForSwitch = false;
    if (activeThreadSession !== null && requestedModelSelection !== undefined) {
      const instanceChanged = requestedModelSelection.instanceId !== currentInstanceId;
      const driverChanged = instanceChanged && currentInfo.driverKind !== desiredInfo.driverKind;
      const continuationChanged =
        instanceChanged &&
        currentInfo.continuationIdentity.continuationKey !==
          desiredInfo.continuationIdentity.continuationKey;
      const currentModel = activeSession?.model ?? thread.modelSelection.model;
      const modelChanged = requestedModelSelection.model !== currentModel;
      const providers = yield* providerRegistry.getProviders;
      const requiresNewProviderThread =
        providers.find((snapshot) => snapshot.instanceId === currentInstanceId)
          ?.requiresNewThreadForModelChange === true ||
        providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
          ?.requiresNewThreadForModelChange === true;
      if (
        driverChanged ||
        continuationChanged ||
        ((modelChanged || instanceChanged) && requiresNewProviderThread)
      ) {
        yield* Effect.logInfo("provider command reactor releasing session for provider switch", {
          threadId,
          currentInstanceId,
          desiredInstanceId,
          currentDriver: currentInfo.driverKind,
          desiredDriver: desiredInfo.driverKind,
          driverChanged,
          continuationChanged,
          requiresNewProviderThread,
        });
        yield* providerService.stopSession({ threadId });
        releasedSessionForSwitch = true;
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      !releasedSessionForSwitch &&
      thread.session &&
      thread.session.status !== "stopped" &&
      activeSession
        ? thread.id
        : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = desiredRuntimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return { sessionThreadId: existingSessionThreadId, contextHandoff: false };
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return {
        sessionThreadId: restartedSession.threadId,
        contextHandoff: restartedSession.continuity === "resume-fallback",
      };
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    // A dead session's provider name still tells us who served this thread
    // last: starting a DIFFERENT driver on a thread with history is a
    // handoff even when no live session had to be released (server restart,
    // reaped session).
    const previousSessionProvider = thread.session?.providerName ?? null;
    const crossDriverFreshStart =
      previousSessionProvider !== null &&
      isProviderDriverKind(previousSessionProvider) &&
      previousSessionProvider !== desiredInfo.driverKind;
    return {
      sessionThreadId: startedSession.threadId,
      contextHandoff:
        startedSession.continuity === "resume-fallback" ||
        releasedSessionForSwitch ||
        thread.activities.some((activity) => activity.kind === "conversation.imported") ||
        crossDriverFreshStart ||
        (thread.session?.providerInstanceId !== undefined &&
          thread.session.providerInstanceId !== desiredInstanceId),
    };
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly messageId: MessageId;
    readonly beforeSequence: number;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly runtimeMode?: RuntimeMode;
    readonly createdAt: string;
    /**
     * Automation turns (meeting seats, programs) compose their own prompts
     * with the context they need — the conversation handoff is only for a
     * person's message landing on a freshly switched provider.
     */
    readonly userInitiated?: boolean;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const ensured = yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
      pendingTurnStart: true,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const memory = yield* Effect.serviceOption(WorkspaceMemory);
    const needsHandoff = ensured.contextHandoff && input.userInitiated !== false;
    const handoffThread =
      needsHandoff && Option.isNone(memory)
        ? thread.handoffMode === "compact"
          ? Option.getOrUndefined(yield* projectionSnapshotQuery.getThreadDetailById(thread.id))
          : yield* resolveThread(thread.id, { messages: true })
        : undefined;
    let handoff =
      handoffThread === undefined
        ? undefined
        : buildConversationHandoff(handoffThread.messages, input.messageId);
    if (handoff !== undefined && handoffThread?.handoffMode === "compact") {
      const prepared = yield* prepareCompactHandoff({
        thread: handoffThread,
        currentMessageId: input.messageId,
        stateDir: serverConfig.stateDir,
        standardHandoff: handoff,
        decisions:
          projectionSnapshotQuery.getThreadHandoffDecisions === undefined
            ? null
            : yield* projectionSnapshotQuery
                .getThreadHandoffDecisions({
                  threadId: thread.id,
                  beforeSequence: input.beforeSequence,
                })
                .pipe(Effect.catch(() => Effect.succeed(null))),
      });
      handoff = prepared.text;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: yield* serverCommandId("conversation-handoff"),
          threadId: thread.id,
          activity: {
            id: yield* serverEventId(),
            kind: "conversation.handoff.prepared",
            tone: "info",
            summary:
              prepared.report.status === "compact" ? "인계 문맥 축소 준비" : "기존 인계 유지",
            payload: prepared.report,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        })
        .pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Could not record conversation handoff metrics"),
          ),
        );
    }
    if (handoff !== undefined) {
      const imported = handoffThread?.activities.find(
        (item) => item.kind === "conversation.imported",
      );
      const payload = imported?.payload;
      const hash =
        payload && typeof payload === "object" && "sourceHash" in payload
          ? payload.sourceHash
          : null;
      if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) {
        handoff += `\nCLI 원본 대화·도구·할일 기록: ${serverConfig.stateDir}/conversation-imports/${hash}.txt\n필요한 이전 작업 근거는 이 원본 파일에서 확인하라.`;
      }
    }
    let taskInput = input.messageText;
    let hasRag = false;
    const development = yield* Effect.serviceOption(WorkspaceDevelopment);
    const developmentState =
      input.userInitiated === false && Option.isSome(development)
        ? yield* development.value.get(thread.projectId)
        : null;
    const documentRag = yield* prepareAttachmentDocumentRag({
      projectId: thread.projectId,
      threadId: thread.id,
      messageId: input.messageId,
      attachments: input.attachments ?? [],
      query: developmentState?.goal?.objective ?? input.messageText,
      createdAt: input.createdAt,
      stateDir: serverConfig.stateDir,
      attachmentsDir: serverConfig.attachmentsDir,
      engine: orchestrationEngine,
      queries: projectionSnapshotQuery,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not prepare attachment document RAG", { cause }).pipe(
          Effect.as({
            prompt: "",
            extracted: new Map<string, { path: string; partial: boolean }>(),
            reports: [],
          }),
        ),
      ),
    );
    let folderScopeAvailable = true;
    let composedWorkspacePrompt = false;
    if (projectionSnapshotQuery.composeWorkspacePrompt !== undefined) {
      const settings =
        projectionSnapshotQuery.getWorkspaceContextSettings !== undefined
          ? yield* projectionSnapshotQuery.getWorkspaceContextSettings(thread.projectId)
          : (yield* projectionSnapshotQuery.getCommandReadModel()).projects.find(
              (candidate) => candidate.id === thread.projectId,
            )?.workspaceControl?.contextOptimization;
      if (settings?.autoChatMemory === true) {
        const compose =
          projectionSnapshotQuery.composeWorkspacePromptForExecution ??
          projectionSnapshotQuery.composeWorkspacePrompt;
        const project = yield* resolveProject(thread.projectId);
        const cwd = resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] });
        const contextPathsResult =
          Option.isSome(memory) && cwd
            ? yield* memory.value
                .contextPaths({
                  projectId: thread.projectId,
                  threadId: thread.id,
                  messageId: input.messageId,
                  cwd,
                  recordCurrent: true,
                })
                .pipe(
                  Effect.map((paths) => ({ paths, available: true as const })),
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.failCause(cause)
                      : Effect.logWarning(
                          "Could not determine the current folder for workspace memory",
                          { cause },
                        ).pipe(
                          Effect.as({
                            paths: [] as ReadonlyArray<string>,
                            available: false as const,
                          }),
                        ),
                  ),
                )
            : { paths: [] as ReadonlyArray<string>, available: false as const };
        folderScopeAvailable = contextPathsResult.available;
        if (contextPathsResult.available) {
          const composed = yield* compose({
            projectId: thread.projectId,
            task: input.messageText,
            sourceMessageId: input.messageId,
            contextMode: settings.memoryMode,
            includeShared: false,
            includeSharedLibrary: false,
            ...(contextPathsResult.paths.length > 0
              ? { contextPaths: contextPathsResult.paths }
              : {}),
            maxContextChars: 16_000,
            includeAttachmentDocuments: false,
          });
          taskInput = composed.prompt;
          composedWorkspacePrompt = true;
          hasRag = true;
        } else {
          taskInput = `${taskInput}\n\n<t3_folder_memory_unavailable>현재 요청에 적용할 기억의 폴더 범위를 확인하지 못해 폴더 전용 기억이 누락되었을 수 있습니다. 폴더가 없다는 뜻은 아닙니다. 폴더 기억을 읽었다고 추측하지 말고 사용자에게 알리세요.</t3_folder_memory_unavailable>`;
        }
      }
    }
    if (documentRag.prompt) {
      taskInput = `${taskInput}\n\n${documentRag.prompt}`;
      hasRag = true;
    }
    if (needsHandoff && Option.isSome(memory)) {
      handoff = !folderScopeAvailable
        ? "<t3_folder_memory_unavailable>현재 요청에 적용할 기억의 폴더 범위를 확인하지 못해 이전 대화 인계를 생략했습니다. 폴더가 없다는 뜻은 아닙니다.</t3_folder_memory_unavailable>"
        : yield* memory.value
            .handoff(thread.projectId, thread.id, input.messageId, thread.handoffMode === "compact")
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not prepare bounded conversation handoff", { cause }).pipe(
                  Effect.as(
                    "<t3_folder_memory_unavailable>이전 대화 인계의 폴더 범위를 확인하지 못했습니다.</t3_folder_memory_unavailable>",
                  ),
                ),
              ),
            );
    }
    if (Option.isSome(memory)) {
      const memoryResult = yield* memory.value
        .context(thread.projectId, input.messageText, !folderScopeAvailable, {
          threadId: thread.id,
          messageId: input.messageId,
          ...(input.userInitiated === false ? { inheritFolder: true } : {}),
          ...(composedWorkspacePrompt ? { excludeDirectives: true } : {}),
          // A resumed native session already holds this conversation; the
          // composed prompt's RAG copy repeats it. Keep the recent block only
          // when a fresh session must be rehydrated.
          ...(composedWorkspacePrompt && input.userInitiated !== false && !needsHandoff
            ? { excludeRecentConversation: true }
            : {}),
        })
        .pipe(
          Effect.map((text) => ({ text, available: true as const })),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("Could not prepare workspace memory index", { cause }).pipe(
                  Effect.as({
                    text: "<t3_memory_unavailable>이전 대화 기억과 사용자 필수 지침을 불러오지 못했습니다. 기억을 읽었다고 추측하지 말고 이 사실을 사용자에게 알리세요. 가능한 경우 workspace_memory status/search/read로 복구하고, 필요한 맥락이 확인되지 않으면 임의로 채우지 마세요.</t3_memory_unavailable>",
                    available: false as const,
                  }),
                ),
          ),
        );
      if (memoryResult.text) {
        taskInput += `\n\n${memoryResult.text}`;
        hasRag ||= memoryResult.available;
      }
      if (
        !memoryResult.available ||
        !folderScopeAvailable ||
        memoryResult.text.includes("<t3_folder_memory_unavailable>")
      ) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.activity.append",
            commandId: yield* serverCommandId("workspace-memory-unavailable"),
            threadId: thread.id,
            createdAt: input.createdAt,
            activity: {
              id: yield* serverEventId(),
              kind: "workspace.memory.unavailable",
              tone: "error",
              summary: memoryResult.available
                ? "현재 요청의 기억에 적용할 폴더 범위를 확인하지 못해 AI에 알렸습니다."
                : "이전 대화 기억을 불러오지 못해 AI에 누락 사실을 알렸습니다.",
              payload: {},
              turnId: null,
              createdAt: input.createdAt,
            },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("Could not record memory preparation failure"),
            ),
          );
      }
    }
    if (Option.isSome(development))
      taskInput = yield* development.value.prepareMainInput(thread.id, taskInput, input.messageId);
    taskInput = withFullAccessExecutionPolicy(
      taskInput,
      input.runtimeMode ?? thread.runtimeMode,
      input.interactionMode ?? thread.interactionMode,
    );
    const providerAttachments = prepareFileAttachmentsForProvider({
      text: toNonEmptyProviderInput(
        handoff === undefined ? taskInput : `${handoff}\n\n${taskInput}`,
      ),
      attachments: input.attachments ?? [],
      attachmentsDir: serverConfig.attachmentsDir,
      extractedDocuments: documentRag.extracted,
    });
    const normalizedInput = providerAttachments.text;
    const normalizedAttachments = providerAttachments.attachments;
    const composition = describeInputComposition({
      prompt: normalizedInput ?? "",
      path: input.userInitiated === false ? "automation" : "chat",
      parts: [
        {
          kind: hasRag ? "rag-assembly" : input.userInitiated === false ? "assignment" : "task",
          chars: taskInput.length,
        },
        ...(handoff === undefined ? [] : [{ kind: "handoff" as const, chars: handoff.length }]),
      ],
      attachmentCount: input.attachments?.length ?? 0,
    });
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("input-composition"),
        threadId: thread.id,
        createdAt: input.createdAt,
        activity: {
          id: yield* serverEventId(),
          kind: "input.composition.prepared",
          tone: "info",
          summary: `AI 입력 준비: ${composition.promptChars.toLocaleString()}자 · 실제 토큰 미계측`,
          payload: composition,
          turnId: null,
          createdAt: input.createdAt,
        },
      })
      .pipe(Effect.catchCause(() => Effect.logWarning("Could not record input composition")));
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = (input.attachments ?? []).filter(
      (attachment) => attachment.type === "image",
    );
    yield* Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = (input.attachments ?? []).filter(
        (attachment) => attachment.type === "image",
      );
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThread(event.payload.threadId, { messages: true });
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const messageThread = yield* resolveThread(thread.id, { messages: true });
    if (!messageThread) return;
    const message = messageThread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      messageThread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const accountResult =
      event.payload.inputOrigin === "automation"
        ? Option.some(event.payload.modelSelection)
        : yield* selectAutomaticAccount(
            thread,
            event.payload.modelSelection ?? thread.modelSelection,
            event.payload.createdAt,
          ).pipe(
            Effect.map(Option.some),
            Effect.catchCause((cause) =>
              handleTurnStartFailure(cause).pipe(Effect.as(Option.none())),
            ),
          );
    if (Option.isNone(accountResult)) return;
    const selectedAccount = accountResult.value;
    const selectedModel =
      selectedAccount?.instanceId !== thread.modelSelection.instanceId
        ? selectedAccount
        : event.payload.modelSelection;
    if (event.payload.inputOrigin === "automation") userTurnAccounts.delete(thread.id);
    else
      userTurnAccounts.set(
        thread.id,
        selectedAccount?.instanceId ?? thread.modelSelection.instanceId,
      );
    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      messageId: event.payload.messageId,
      beforeSequence: event.sequence,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(selectedModel !== undefined ? { modelSelection: selectedModel } : {}),
      interactionMode: event.payload.interactionMode,
      runtimeMode: event.payload.runtimeMode,
      createdAt: event.payload.createdAt,
      userInitiated: event.payload.inputOrigin !== "automation",
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    yield* providerService
      .sendTurn(sendTurnRequest.value)
      .pipe(Effect.catchCause(recoverTurnStartFailure), Effect.forkScoped);
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const activeRuns = new Set(
      thread.activities.flatMap((activity) => {
        if (activity.kind !== "orchestra.block" || !isOrchestraBlock(activity.payload)) return [];
        return activity.payload.status === "running" || activity.payload.status === "awaiting-user"
          ? [activity.payload.runId]
          : [];
      }),
    );
    if (activeRuns.size > 0) {
      for (const runId of activeRuns)
        yield* orchestrationEngine.dispatch({
          type: "project.collaboration.run.cancel",
          commandId: CommandId.make(`orchestra-stop:${event.eventId}:${runId}`),
          projectId: thread.projectId,
          runId,
          createdAt: event.payload.createdAt,
        });
      if (event.payload.questionRequestId === undefined) return;
    }
    const session = thread.session;
    if (!session || session.status === "stopped") {
      const questionRequestId = event.payload.questionRequestId;
      const matchesQuestion = (activity: (typeof thread.activities)[number]) =>
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        "requestId" in activity.payload &&
        activity.payload.requestId === questionRequestId;
      if (
        questionRequestId?.startsWith("async:") &&
        thread.activities.some(
          (activity) => activity.kind === "user-input.requested" && matchesQuestion(activity),
        ) &&
        !thread.activities.some(
          (activity) => activity.kind === "user-input.resolved" && matchesQuestion(activity),
        )
      ) {
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`question-stop:${event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: event.payload.createdAt,
          activity: {
            id: EventId.make(`question-stop:${event.eventId}`),
            kind: "user-input.resolved",
            tone: "info",
            summary: "중지한 질문을 닫았습니다.",
            payload: { requestId: questionRequestId, answers: {}, reason: "provider-resolved" },
            turnId: null,
            createdAt: event.payload.createdAt,
          },
        });
        return;
      }
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }
    // An idle session has no turn to interrupt. Rapid repeated Stop clicks
    // queue one event each behind the first; once that one settles the turn,
    // the rest would only burn a provider round-trip apiece — skip them.
    // Only "ready" counts as idle: a "starting" session can hold a pending
    // turn the provider has not acknowledged yet (activeTurnId is still null
    // in that window), and dropping the interrupt there leaves the provider
    // running a turn the projection already recorded as interrupted.
    if (
      session.activeTurnId === null &&
      session.status === "ready" &&
      event.payload.questionRequestId === undefined
    ) {
      return;
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by
    // session. Bounded + caught: a provider that never acknowledges must not
    // wedge this reactor's serial worker (a hung claudeAgent stop once jammed
    // it, silently swallowing every queued Stop click), and the user must see
    // the failure as an activity instead of a button that does nothing.
    const failureDetail = yield* providerService
      .interruptTurn({
        threadId: event.payload.threadId,
        ...(event.payload.questionRequestId !== undefined
          ? { questionRequestId: event.payload.questionRequestId }
          : {}),
        ...(event.payload.stopBackground !== undefined
          ? { stopBackground: event.payload.stopBackground }
          : {}),
      })
      .pipe(
        Effect.as(null),
        Effect.timeoutOption("15 seconds"),
        Effect.map(
          Option.getOrElse<string | null>(
            () => "Provider did not acknowledge the interrupt within 15 seconds.",
          ),
        ),
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      );
    if (failureDetail !== null) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: failureDetail,
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // The provider acknowledged the interrupt, but codex (observed 2026-08-29)
    // can drop the turn-ended notification afterwards, leaving the session
    // "running" a turn the projection already settled as interrupted — a
    // zombie that lives until the next restart, where session recovery
    // resurrects the very turn the user stopped. Give the provider a grace
    // period to report the end itself, then settle the session.
    const interruptedTurnId = session.activeTurnId;
    yield* Effect.gen(function* () {
      yield* Effect.sleep("20 seconds");
      const current = yield* resolveThread(event.payload.threadId);
      const currentSession = current?.session;
      if (
        !currentSession ||
        currentSession.status !== "running" ||
        currentSession.activeTurnId !== interruptedTurnId
      ) {
        return;
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          ...currentSession,
          status: "ready",
          activeTurnId: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      yield* Effect.logWarning(
        "provider never reported turn end after an acknowledged interrupt; settled the session",
        { threadId: event.payload.threadId, turnId: interruptedTurnId },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("interrupt grace settle failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const executionRequest = resolveExecutionRequest(thread, event.payload.requestId);
    const hasSession =
      executionRequest !== undefined || (thread.session && thread.session.status !== "stopped");
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId:
          executionRequest === undefined
            ? event.payload.threadId
            : ThreadId.make(executionRequest.executionId),
        requestId: executionRequest?.providerRequestId ?? event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const executionRequest = resolveExecutionRequest(thread, event.payload.requestId);
      const hasSession =
        executionRequest !== undefined || (thread.session && thread.session.status !== "stopped");
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId:
            executionRequest === undefined
              ? event.payload.threadId
              : ThreadId.make(executionRequest.executionId),
          requestId: executionRequest?.providerRequestId ?? event.payload.requestId,
          answers: event.payload.answers,
          ...(event.payload.images ? { images: event.payload.images } : {}),
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      // Bounded + caught: the projection below must mark the session stopped
      // even when provider teardown hangs or fails — an unbounded await here
      // once wedged the serial worker behind a claudeAgent stop, which also
      // swallowed every turn interrupt queued after it.
      const failureDetail = yield* providerService.stopSession({ threadId: thread.id }).pipe(
        Effect.as(null),
        Effect.timeoutOption("15 seconds"),
        Effect.map(
          Option.getOrElse<string | null>(
            () => "Provider did not acknowledge the stop within 15 seconds.",
          ),
        ),
        Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
      );
      if (failureDetail !== null) {
        yield* Effect.logWarning(
          "provider session stop failed; marking the session stopped anyway",
          { threadId: thread.id, detail: failureDetail },
        );
      }
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.session-set": {
        const session = event.payload.session;
        if (
          session.status !== "error" ||
          !isActualRateLimitFailure(session.lastError) ||
          session.providerInstanceId === undefined ||
          (session.providerName !== "codex" && session.providerName !== "claudeAgent")
        )
          return;
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`provider:rate-limit-fact:${event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: session.updatedAt,
          activity: {
            id: EventId.make(`rate-limit:${event.eventId}`),
            kind: "provider.account.rate-limited",
            tone: "error",
            summary: "계정 요청 제한 확인 (HTTP 429)",
            payload: { instanceId: session.providerInstanceId, sourceEventId: event.eventId },
            turnId: null,
            createdAt: session.updatedAt,
          },
        });
        if (userTurnAccounts.get(event.payload.threadId) !== session.providerInstanceId) return;
        const thread = yield* resolveThread(event.payload.threadId);
        if (
          !thread ||
          thread.modelSelection.instanceId !== session.providerInstanceId ||
          thread.session?.status !== "error"
        )
          return;
        yield* selectAutomaticAccount(thread, thread.modelSelection, event.occurredAt);
        return;
      }
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      // NO blanket timeout here: a timeout races the handler onto a temporary
      // fiber, and adapters historically forked session-lifetime fibers as
      // children of the handler's fiber — a 60s envelope added 2026-08-29
      // silently killed every codex session's event pump the moment its
      // handler settled. Hang protection lives in the per-call bounds inside
      // the handlers (stop/interrupt 15s, adapter-level request timeouts).
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  // Keyed by thread: one thread's slow session spawn must not queue every
  // other thread's turn start behind it (a wave of parallel graph nodes, or a
  // hung spawn, previously stalled the whole server's turn starts). Events for
  // the same thread still process strictly in order, which the meeting flow's
  // stop→turn sequencing and ensureSessionForThread's binding rules rely on.
  const worker = yield* makeKeyedDrainableWorker(
    (event: ProviderIntentEvent) => event.payload.threadId,
    processDomainEventSafely,
  );

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        (event.type === "thread.session-set" &&
          event.payload.session.status === "error" &&
          isActualRateLimitFailure(event.payload.session.lastError))
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent), {
      startImmediately: true,
    });

    // The domain event stream is hot, so work pending before this reactor
    // starts cannot be resumed. Correlated completions only clear the request
    // captured here, leaving any newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
    } else {
      yield* forkParked(clearInterrupted);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
