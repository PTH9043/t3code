import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type ModelSelection,
  type ProjectId,
  type ThreadResponseStyle,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import type { QueuedThreadMessage } from "../state/thread-outbox-model";
import type { NewTaskModelTeam } from "./newTaskModelTeam";
import { toUploadChatImageAttachments, type DraftComposerImageAttachment } from "./composerImages";

export function buildQueuedProjectThreadStartTurnInput(
  message: QueuedThreadMessage,
  projectCwd: string,
) {
  const { creation, modelSelection } = message;
  if (!creation || !modelSelection) return null;
  const worktree =
    creation.workspaceMode === "worktree" ? message.deliveryAttemptWorktree : undefined;
  return buildProjectThreadStartTurnInput({
    projectId: creation.projectId,
    projectCwd: worktree?.projectCwd ?? projectCwd,
    threadId: message.threadId,
    commandId: message.commandId,
    messageId: message.messageId,
    createdAt: message.createdAt,
    text: message.text.trim(),
    attachments: message.attachments,
    modelSelection,
    modelTeams: creation.modelTeams,
    responseStyle: creation.responseStyle,
    runtimeMode: message.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: message.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    workspaceMode: creation.workspaceMode,
    branch: creation.branch,
    worktreePath: creation.worktreePath,
    startFromOrigin: creation.startFromOrigin ?? false,
    worktreeBranchName: worktree?.worktreeBranchName,
  });
}

export function deriveThreadTitleFromPrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "새 대화";
  }

  const compact = trimmed.replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

export interface ProjectThreadStartTurnSpec {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection: ModelSelection;
  readonly responseStyle?: ThreadResponseStyle | undefined;
  readonly modelTeams?: readonly NewTaskModelTeam[];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin: boolean;
  /** Preserve a previously attempted worktree, including legacy queued tasks. */
  readonly worktreeBranchName?: string;
}

/**
 * Single source of the `thread.turn.start` bootstrap payload used to create a
 * thread from a project draft — shared by the immediate send path and the
 * offline outbox drain so both deliver identical commands.
 */
export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  const title = deriveThreadTitleFromPrompt(spec.text);
  const isWorktree = spec.workspaceMode === "worktree";
  const threadId = ThreadId.make(spec.threadId);
  return {
    commandId: CommandId.make(spec.commandId),
    threadId,
    message: {
      messageId: MessageId.make(spec.messageId),
      role: "user" as const,
      text: spec.text,
      attachments: toUploadChatImageAttachments(spec.attachments),
    },
    modelSelection: spec.modelSelection,
    titleSeed: title,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    bootstrap: {
      createThread: {
        projectId: spec.projectId,
        title,
        ...(spec.responseStyle ? { responseStyle: spec.responseStyle } : {}),
        ...(spec.modelTeams?.length
          ? { modelTeams: spec.modelTeams.map((team) => ({ ...team, threadId })) }
          : {}),
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.branch,
        worktreePath: isWorktree ? null : spec.worktreePath,
        createdAt: spec.createdAt,
      },
      ...(isWorktree
        ? {
            prepareWorktree: {
              projectCwd: spec.projectCwd,
              baseBranch: spec.branch!,
              branch: spec.worktreeBranchName ?? buildTemporaryWorktreeBranchName(() => threadId),
              ...(spec.startFromOrigin ? { startFromOrigin: true } : {}),
            },
            runSetupScript: true,
          }
        : {}),
    },
    createdAt: spec.createdAt,
  };
}
