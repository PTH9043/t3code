import {
  type EnvironmentId,
  ProjectId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ApprovalRequestId,
  type ThreadId,
  type ThreadTurnStartBootstrap,
  type ThreadResponseStyle,
  type TurnId,
} from "@t3tools/contracts";
import { type ChatMessage, type SessionPhase, type Thread, type ThreadShell } from "../types";
import {
  type ComposerImageAttachment,
  type DraftId,
  type DraftThreadState,
  selectDraftModelTeams,
  useComposerDraftStore,
} from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;
export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;
// Local backend reconnects should have time to recover from a busy backend.
export const LOCAL_RECONNECT_WARNING_GRACE_MS = 15_000;

/** Matches the collaboration answer/interjection contract; never truncate user input. */
export function prepareOrchestraMessage(
  input: string,
): { readonly kind: "ready"; readonly text: string } | { readonly kind: "too-long" } {
  const text = input.trim();
  return text.length > 8_000 ? { kind: "too-long" } : { kind: "ready", text };
}
// An automatic account switch restarts the provider session, which takes a few
// seconds to reconnect. That blip is a normal failover, not a lost connection —
// suppress the warning while the switch is settling so the banner does not cry
// wolf on every failover.
export const ACCOUNT_AUTO_SWITCH_RECONNECT_SUPPRESS_MS = 15_000;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function scheduleEnvironmentReconnectWarning(
  showWarning: () => void,
  localBackend = false,
): () => void {
  const timeoutId = globalThis.setTimeout(
    showWarning,
    localBackend ? LOCAL_RECONNECT_WARNING_GRACE_MS : ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  );
  return () => globalThis.clearTimeout(timeoutId);
}

export function hasEnvironmentReconnectWarningGraceElapsed(
  activeEnvironmentId: EnvironmentId | null,
  elapsedEnvironmentId: EnvironmentId | null,
): boolean {
  return activeEnvironmentId !== null && activeEnvironmentId === elapsedEnvironmentId;
}

/** Keeps the local grace period even when a version mismatch is also displayed. */
export function suppressEnvironmentReconnectBanner(input: {
  readonly reconnecting: boolean;
  readonly localBackend: boolean;
  readonly versionSkew: boolean;
  readonly recentAccountSwitch: boolean;
  readonly updateRunning: boolean;
  readonly graceElapsed: boolean;
}): boolean {
  return (
    input.reconnecting &&
    (input.updateRunning ||
      (!input.graceElapsed &&
        (input.recentAccountSwitch || !input.versionSkew || input.localBackend)))
  );
}

/**
 * An automatic account switch restarts the provider session, which resets the
 * transport and flips the environment into `reconnecting`. That blip is a
 * normal failover, not a lost connection — suppress the warning while the
 * switch is settling so the banner does not cry wolf on every failover.
 */
export function hasRecentAccountAutoSwitch(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined | null,
  now: number,
): boolean {
  if (!activities || activities.length === 0) return false;
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (!activity || activity.kind !== "provider.account.auto-switched") continue;
    const at = Date.parse(activity.createdAt ?? "");
    return Number.isFinite(at) && now - at < ACCOUNT_AUTO_SWITCH_RECONNECT_SUPPRESS_MS;
  }
  return false;
}

export function startNewThreadForProject(
  projectRef: ScopedProjectRef | null,
  handleNewThread: (projectRef: ScopedProjectRef) => Promise<void>,
): boolean {
  if (projectRef === null) return false;
  void handleNewThread(projectRef);

  return true;
}

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;
  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }
  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function shouldWaitForActiveModelBeforeSending(input: {
  session: Pick<NonNullable<Thread["session"]>, "status" | "providerInstanceId"> | null;
  currentModelSelection: ModelSelection;
  nextModelSelection: ModelSelection;
}): boolean {
  if (input.session?.status !== "running" && input.session?.status !== "starting") return false;
  return (
    (input.session.providerInstanceId !== undefined &&
      input.session.providerInstanceId !== input.nextModelSelection.instanceId) ||
    resolveThreadMetadataUpdateForNextTurn({
      currentModelSelection: input.currentModelSelection,
      nextModelSelection: input.nextModelSelection,
      currentBranch: null,
    }) !== null
  );
}

export function buildDraftThreadCreateBootstrap(
  draft: DraftThreadState | null,
  draftId: DraftId | null,
  fields: Pick<
    NonNullable<ThreadTurnStartBootstrap["createThread"]>,
    "title" | "modelSelection" | "runtimeMode" | "interactionMode"
  >,
  legacyResponseStyle?: ThreadResponseStyle,
): Pick<ThreadTurnStartBootstrap, "createThread"> {
  if (!draft) return {};
  const store = useComposerDraftStore.getState();
  const current = draftId && store.getDraftSession(draftId);
  const sameDraft =
    current &&
    current.threadId === draft.threadId &&
    current.environmentId === draft.environmentId &&
    current.projectId === draft.projectId;
  const modelTeams = sameDraft ? selectDraftModelTeams(store, draftId) : undefined;
  const responseStyle = sameDraft ? (current.responseStyle ?? legacyResponseStyle) : undefined;
  return {
    createThread: {
      projectId: draft.projectId,
      createdAt: draft.createdAt,
      branch: draft.branch,
      worktreePath: draft.worktreePath,
      ...fields,
      ...(responseStyle ? { responseStyle } : {}),
      ...(sameDraft && current.customSubordinateTeam
        ? { customSubordinateTeam: current.customSubordinateTeam }
        : {}),
      ...(modelTeams?.length ? { modelTeams } : {}),
    },
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: Pick<
    DraftThreadState,
    | "environmentId"
    | "projectId"
    | "runtimeMode"
    | "interactionMode"
    | "createdAt"
    | "branch"
    | "worktreePath"
  >,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    projectId: draftThread.projectId,
    title: "새 대화",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    checkpoints: [],
    activities: [],
    proposedPlans: [],
  };
}

export function buildLoadingThreadFromShell(shell: ThreadShell): Thread {
  return {
    ...shell,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    deletedAt: null,
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  activeServerThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.activeServerThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.activeServerThread.environmentId === input.routeThreadRef.environmentId &&
    input.activeServerThread.id === input.targetThreadId,
  );
}

/**
 * Which error the thread banner shows.
 *
 * The banner's X only ever cleared the LOCAL entry, and the fallback then read
 * `local ?? session.lastError` — so a dismissed local error fell straight back
 * through to the server's still-set `lastError` and the banner never closed.
 * A provider refusal, which sticks on the session until the next turn, was
 * impossible to get rid of. Dismissal is therefore recorded against the server
 * message itself: that exact text stays hidden, while a different error — or
 * the same one after the session cleared it — shows again.
 */
export function resolveVisibleThreadError(input: {
  readonly isServerThread: boolean;
  readonly localDraftError: string | null;
  readonly localServerError: string | null;
  readonly sessionError: string | null;
  readonly dismissedSessionError: string | null;
}): string | null {
  if (!input.isServerThread) return input.localDraftError;
  if (input.localServerError !== null) return input.localServerError;
  if (input.sessionError === null) return null;
  return input.sessionError === input.dismissedSessionError ? null : input.sessionError;
}

/**
 * The composer's stop ends the reply and the agent work it spawned; only the
 * background banner's 중지 passes `stopBackground` to take standing watch
 * loops down too. Stopping a conversation is not stopping the watch.
 */
export function buildThreadTurnInterruptInput(
  thread: Pick<Thread, "id" | "session">,
  options?: { readonly stopBackground?: boolean; readonly questionRequestId?: ApprovalRequestId },
): {
  threadId: ThreadId;
  turnId?: TurnId;
  questionRequestId?: ApprovalRequestId;
  stopBackground?: boolean;
} {
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  return {
    threadId: thread.id,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
    ...(options?.questionRequestId ? { questionRequestId: options.questionRequestId } : {}),
    ...(options?.stopBackground === true ? { stopBackground: true } : {}),
  };
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  return reconcileRetainedMountedThreadIds({
    currentThreadIds: input.currentThreadIds,
    openThreadIds: input.openThreadIds,
    activeThreadId: input.activeThreadId,
    activeThreadOpen: input.activeThreadTerminalOpen,
    maxHiddenThreadCount: input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
}

export function reconcileRetainedMountedThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadOpen: boolean;
  maxHiddenThreadCount: number;
  retainInactiveActiveThread?: boolean;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      (threadId !== input.activeThreadId || input.retainInactiveActiveThread === true) &&
      openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(0, input.maxHiddenThreadCount);
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("이미지 데이터를 읽지 못했습니다."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("이미지를 읽지 못했습니다."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const subject = count === 1 ? "만료된 터미널 컨텍스트는" : `만료된 터미널 컨텍스트 ${count}개는`;
  if (variant === "empty") {
    return {
      title: `${subject} 전송되지 않습니다`,
      description: "삭제하거나 다시 추가하면 터미널 출력을 포함할 수 있습니다.",
    };
  }
  return {
    title: `${subject} 메시지에서 제외되었습니다`,
    description: "터미널 출력을 포함하려면 다시 추가하세요.",
  };
}

export function branchMismatchKey(
  threadId: string | null,
  mismatch: { threadBranch: string; currentBranch: string } | null,
): string | null {
  if (!threadId || !mismatch) {
    return null;
  }
  return `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

// The mismatch banner only matters when the user is about to send: passive
// reading of an old thread carries no risk (the branch picker tint already
// covers ambient awareness). Draft content is the intent signal — composer
// focus is useless here because ChatView autofocuses the composer on every
// thread open. `wasShownForCurrentMismatch` keeps the banner mounted once
// revealed so it doesn't flicker away when the draft is cleared.
export function shouldShowBranchMismatchBanner(input: {
  hasMismatch: boolean;
  isDismissed: boolean;
  composerHasContent: boolean;
  wasShownForCurrentMismatch: boolean;
}): boolean {
  if (!input.hasMismatch || input.isDismissed) {
    return false;
  }
  return input.composerHasContent || input.wasShownForCurrentMismatch;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes). Durable cross-device dismissal is planned as a server-side ack.
const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const getThread = () => appAtomRegistry.get(threadAtom);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (!threadHasStarted(thread)) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestUserMessageId: ChatMessage["id"] | null;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionStatus: NonNullable<Thread["session"]>["status"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  const latestUserMessage = activeThread?.messages.findLast((message) => message.role === "user");
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestUserMessageId: latestUserMessage?.id ?? null,
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionStatus: session?.status ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  latestUserMessageId: ChatMessage["id"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestUserMessageChanged =
    input.localDispatch.latestUserMessageId !== input.latestUserMessageId;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    // Steering adds a user message to the current running turn without
    // necessarily changing any of the turn timestamps. Treat that projected
    // message as the server acknowledgment so the composer does not remain
    // stuck in its local "Sending" state until the turn settles.
    if (latestUserMessageChanged) {
      return true;
    }
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== null &&
      session?.activeTurnId !== undefined &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionStatus !== (session?.status ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
