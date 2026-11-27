import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ThreadResponseStyle,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type ProjectId as ProjectIdType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DraftComposerImageAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { NewTaskModelTeam } from "../lib/newTaskModelTeam";
import { scopedThreadKey } from "../lib/scopedEntities";

const THREAD_OUTBOX_SCHEMA_VERSION = 4;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  modelTeams: Schema.optional(Schema.Array(NewTaskModelTeam)),
  responseStyle: Schema.optional(ThreadResponseStyle),
  requireExactModel: Schema.optional(Schema.Boolean),
  // Snapshot of the project's display metadata so a pending task stays
  // presentable in the thread list even when the project shell is not loaded.
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, 3, THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  // Present when the queued item creates a brand-new thread (pending task)
  // instead of appending a turn to an existing one.
  creation: Schema.optional(QueuedThreadCreationSchema),
  deliveryAttemptFingerprint: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ),
  deliveryAttemptWorktree: Schema.optional(
    Schema.Struct({ projectCwd: Schema.String, worktreeBranchName: Schema.String }),
  ),
  deliveryReceiptChecked: Schema.optional(Schema.Boolean),
  deliveryFailure: Schema.optional(
    Schema.Struct({
      stage: Schema.Literals(["settings-sync", "start-turn"]),
      message: Schema.String,
    }),
  ),
  createdAt: IsoDateTime,
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);

export interface QueuedThreadCreation {
  readonly projectId: ProjectIdType;
  readonly requireExactModel?: boolean;
  readonly responseStyle?: ThreadResponseStyle;
  readonly modelTeams?: readonly NewTaskModelTeam[];
  readonly projectTitle?: string;
  readonly projectCwd?: string;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection?: ModelSelectionType;
  readonly runtimeMode?: RuntimeModeType;
  readonly interactionMode?: ProviderInteractionModeType;
  readonly creation?: QueuedThreadCreation;
  readonly deliveryAttemptFingerprint?: string;
  readonly deliveryAttemptWorktree?: {
    readonly projectCwd: string;
    readonly worktreeBranchName: string;
  };
  readonly deliveryReceiptChecked?: boolean;
  readonly deliveryFailure?: {
    readonly stage: "settings-sync" | "start-turn";
    readonly message: string;
  };
  readonly createdAt: string;
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
): ThreadSettingsSnapshot {
  return {
    modelSelection: message.modelSelection ?? thread.modelSelection,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: message.interactionMode ?? thread.interactionMode,
  };
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return message;
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageId, QueuedThreadMessage>();
  for (const message of messages) {
    deduplicated.set(message.messageId, message);
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedThreadKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDeliveryAction = "wait" | "hold" | "send" | "verify";

export function shouldHoldUnconfirmedFailedAttempt(message: QueuedThreadMessage): boolean {
  return message.deliveryFailure !== undefined && message.deliveryReceiptChecked === undefined;
}

/** Local bootstrap has no worktree or setup script side effects to repeat. */
export function canRetryUnconfirmedCreation(input: {
  readonly creation: QueuedThreadCreation;
  readonly threadExists: boolean;
  readonly projectCwd: string | null;
  readonly safeBootstrapReplay: boolean;
  readonly safeBootstrapResume?: boolean;
  readonly safeWorktreeBootstrapResume?: boolean;
  readonly attemptWorktree?: QueuedThreadMessage["deliveryAttemptWorktree"];
}): boolean {
  if (!input.safeBootstrapReplay) return false;
  if (input.creation.workspaceMode === "local")
    return (!input.threadExists || input.safeBootstrapResume === true) && input.projectCwd !== null;
  return (
    input.safeWorktreeBootstrapResume === true &&
    Boolean(input.attemptWorktree?.projectCwd && input.attemptWorktree.worktreeBranchName)
  );
}

export function resolveThreadOutboxDeliveryAction(input: {
  readonly isCreation: boolean;
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadBusy: boolean;
  readonly hasDeliveryFailure?: boolean;
  readonly hasAttemptFingerprint?: boolean;
  readonly receiptChecked?: boolean;
}): ThreadOutboxDeliveryAction {
  if (input.isCreation && input.hasAttemptFingerprint && !input.receiptChecked)
    return input.environmentConnected && input.shellStatus === "live" ? "verify" : "wait";
  if (input.hasDeliveryFailure) return "wait";
  if (input.isCreation && input.threadExists)
    return input.environmentConnected && input.shellStatus === "live" ? "hold" : "wait";
  if (input.isCreation) {
    // A pending task creates its thread before its first message is accepted.
    // Wait for the shell to be live before sending: until the thread list has
    // synchronized, a previously delivered creation whose cleanup failed would
    // look missing and get re-issued, duplicating the thread.
    return input.environmentConnected && input.shellStatus === "live" ? "send" : "wait";
  }
  if (!input.threadExists) {
    // A live shell may still omit a temporarily unavailable thread. The
    // absence alone does not prove that a queued message can be discarded.
    return "wait";
  }
  return input.environmentConnected && !input.threadBusy ? "send" : "wait";
}

/**
 * A queued creation can only be dispatched once its payload would pass server
 * validation; incomplete payloads stay pending until the user edits them.
 */
export function isQueuedThreadCreationSendable(message: QueuedThreadMessage): boolean {
  if (!message.creation) {
    return false;
  }
  if (message.text.trim().length === 0 || message.modelSelection === undefined) {
    return false;
  }
  return message.creation.workspaceMode !== "worktree" || Boolean(message.creation.branch);
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "OrchestrationDispatchCommandError" &&
    "reason" in error &&
    error.reason === "active-turn-settings"
  )
    return true;
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ConnectionTransientError"
  ) {
    return true;
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "hold";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  if (input.interrupted || shouldRetryThreadOutboxDelivery(input.error)) {
    return "retry";
  }
  return "hold";
}
