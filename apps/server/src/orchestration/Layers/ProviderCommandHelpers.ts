import {
  type ChatAttachment,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThread,
  ProviderDriverKind,
  type RuntimeMode,
  WorkspaceExecutionRequestRoute,
  WorkspaceOrchestraBlock,
} from "@t3tools/contracts";
import { WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { DELEGATE_NODE_PREFIX } from "../../mcp/toolkits/workspaceDelegate.ts";
import { ProviderAdapterRequestError, type ProviderServiceError } from "../../provider/Errors.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";

export const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
export const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);
export const isProviderDriverKind = Schema.is(ProviderDriverKind);

export const isExecutionRequestRoute = Schema.is(WorkspaceExecutionRequestRoute);
export const isOrchestraBlock = Schema.is(WorkspaceOrchestraBlock);

/**
 * What a Stop press must cancel on a thread: the runs of its `orchestra.block`s
 * that are still running or waiting for the user. `delegating` is set when one
 * of them is a `workspace_delegate` run: that runs inside the thread's own
 * provider turn, so the turn has to be interrupted as well. An orchestra run
 * has no such turn and is stopped by its cancel alone.
 */
export function orchestraStopTargets(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): {
  readonly runIds: ReadonlyArray<WorkspaceOrchestraBlock["runId"]>;
  readonly delegating: boolean;
} {
  const active = activities.flatMap((activity) =>
    activity.kind === "orchestra.block" &&
    isOrchestraBlock(activity.payload) &&
    (activity.payload.status === "running" || activity.payload.status === "awaiting-user")
      ? [activity.payload]
      : [],
  );
  return {
    runIds: [...new Set(active.map((block) => block.runId))],
    delegating: active.some((block) => block.nodeId.startsWith(DELEGATE_NODE_PREFIX)),
  };
}
export const decodeRecoveredQuestions = Schema.decodeUnknownOption(
  Schema.Struct({
    questions: Schema.Array(Schema.Struct({ id: Schema.String, question: Schema.String })),
  }),
);
export const decodeDeferredNativeQuestions = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      header: Schema.String,
      question: Schema.String,
      options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
      multiSelect: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);
export const decodeQueuedQuestionRecovery = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.String,
    messageId: Schema.String,
    answers: Schema.Record(Schema.String, Schema.Unknown),
  }),
);
export function resolveExecutionRequest(thread: OrchestrationThread, requestId: string) {
  for (const activity of thread.activities.toReversed()) {
    if (isExecutionRequestRoute(activity.payload) && activity.payload.requestId === requestId) {
      return activity.payload;
    }
  }
  return undefined;
}

export type ProviderIntentEvent = Extract<
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

export function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function mapProviderSessionStatusToOrchestrationStatus(
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

export const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

export const HANDLED_TURN_START_KEY_MAX = 10_000;
export const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const DEFAULT_THREAD_TITLE = "New thread";
export const MAX_REGENERATION_ATTACHMENTS = 4;
export const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
export const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
export const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
export const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

export type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

export function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
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

export function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

export function collectRecentThreadTitleContext(
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

export function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>): {
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

export function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

export function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

export function isUnknownPendingApprovalRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): boolean {
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

export function isUnknownPendingUserInputRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): boolean {
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

export function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

export function buildGeneratedWorktreeBranchName(raw: string): string {
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
