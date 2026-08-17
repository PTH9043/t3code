import {
  ApprovalRequestId,
  DEFAULT_WORKSPACE_CONTROL_SETTINGS,
  type ChatAttachment,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type ProjectId,
  ThreadId,
  type WorkspaceConversationRagSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionWorkspaceKnowledgeRepository } from "../../persistence/Services/ProjectionWorkspaceKnowledge.ts";
import { ProjectionWorkspaceRagRepository } from "../../persistence/Services/ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceAgentRoleRepository } from "../../persistence/Services/ProjectionWorkspaceAgentRoles.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProjectionWorkspaceScheduleRepository } from "../../persistence/Services/ProjectionWorkspaceSchedules.ts";
import { ProjectionWorkspaceProgramRepository } from "../../persistence/Services/ProjectionWorkspacePrograms.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionWorkspaceKnowledgeRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceKnowledge.ts";
import { ProjectionWorkspaceRagRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceAgentRoleRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceAgentRoles.ts";
import { ProjectionWorkspaceCollaborationRunRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceCollaborationRuns.ts";
import { ProjectionWorkspaceScheduleRepositoryLive } from "../../persistence/Layers/ProjectionWorkspaceSchedules.ts";
import { ProjectionWorkspaceProgramRepositoryLive } from "../../persistence/Layers/ProjectionWorkspacePrograms.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import {
  conversationRagThreadItemPrefix,
  toConversationRagKnowledgeItem,
} from "../workspaceConversationRag.ts";

const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  workspaceKnowledge: "projection.workspace-knowledge-v2",
  workspaceRag: "projection.workspace-rag-v2",
  workspaceAgentRoles: "projection.workspace-agent-roles-v1",
  workspaceCollaborationRuns: "projection.workspace-collaboration-runs-v1",
  workspaceSchedules: "projection.workspace-schedules-v1",
  workspacePrograms: "projection.workspace-programs-v1",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

/**
 * Turn state to settle still-running turns with when their session leaves the
 * "running" status, or null while the session is (re)starting or running and
 * turns must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

function derivePendingUserInputCountFromActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): number {
  const openRequestIds = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  for (const activity of ordered) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      detail !== null &&
      (detail.includes("stale pending user-input request") ||
        detail.includes("unknown pending user-input request") ||
        detail.includes("unknown pending user input request") ||
        detail.includes("unknown pending codex user input request"))
    ) {
      openRequestIds.delete(requestId);
    }
  }

  return openRequestIds.size;
}

function deriveHasActionableProposedPlan(input: {
  readonly latestTurnId: string | null;
  readonly proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>;
}): boolean {
  const sorted = [...input.proposedPlans].toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.planId.localeCompare(right.planId),
  );

  let latestForTurn: ProjectionThreadProposedPlan | null = null;
  if (input.latestTurnId !== null) {
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const plan = sorted[index];
      if (plan?.turnId === input.latestTurnId) {
        latestForTurn = plan;
        break;
      }
    }
  }
  if (latestForTurn !== null) {
    return latestForTurn.implementedAt === null;
  }

  const latestPlan = sorted.at(-1) ?? null;
  return latestPlan !== null && latestPlan.implementedAt === null;
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn("runAttachmentSideEffects")(function* (
  sideEffects: AttachmentSideEffects,
) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const readAttachmentRootEntries = fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));

  const removeDeletedThreadAttachmentEntry = Effect.fn("removeDeletedThreadAttachmentEntry")(
    function* (threadSegment: string, entry: string) {
      const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
        return;
      }
      const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
      if (!attachmentId) {
        return;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        return;
      }
      yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
        force: true,
      });
    },
  );

  const deleteThreadAttachments = Effect.fn("deleteThreadAttachments")(function* (
    threadId: string,
  ) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
        threadId,
      });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneThreadAttachmentEntry = Effect.fn("pruneThreadAttachmentEntry")(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem.stat(absolutePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptThreadRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  const pruneThreadAttachments = Effect.fn("pruneThreadAttachments")(function* (
    threadId: string,
    keptThreadRelativePaths: Set<string>,
  ) {
    if (sideEffects.deletedThreadIds.has(threadId)) {
      return;
    }

    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
      { concurrency: 1 },
    );
  });

  yield* Effect.forEach(sideEffects.deletedThreadIds, deleteThreadAttachments, {
    concurrency: 1,
  });

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) =>
      pruneThreadAttachments(threadId, keptThreadRelativePaths),
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionWorkspaceKnowledgeRepository = yield* ProjectionWorkspaceKnowledgeRepository;
    const projectionWorkspaceRagRepository = yield* ProjectionWorkspaceRagRepository;
    const projectionWorkspaceAgentRoleRepository = yield* ProjectionWorkspaceAgentRoleRepository;
    const projectionWorkspaceCollaborationRunRepository =
      yield* ProjectionWorkspaceCollaborationRunRepository;
    const projectionWorkspaceScheduleRepository = yield* ProjectionWorkspaceScheduleRepository;
    const projectionWorkspaceProgramRepository = yield* ProjectionWorkspaceProgramRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

    const makeConversationProjectionState = () => ({
      projectSettings: new Map<string, WorkspaceConversationRagSettings>(),
      threads: new Map<string, { readonly projectId: ProjectId; readonly title: string }>(),
    });
    type ConversationProjectionState = ReturnType<typeof makeConversationProjectionState>;

    const trackConversationProjectionEvent = (
      state: ConversationProjectionState,
      event: OrchestrationEvent,
    ) => {
      switch (event.type) {
        case "project.created":
          state.projectSettings.set(
            event.payload.projectId,
            event.payload.workspaceControl?.conversationRag ??
              DEFAULT_WORKSPACE_CONTROL_SETTINGS.conversationRag,
          );
          return;
        case "project.workspace-control-updated":
          state.projectSettings.set(
            event.payload.projectId,
            event.payload.workspaceControl.conversationRag,
          );
          return;
        case "project.deleted":
          state.projectSettings.delete(event.payload.projectId);
          return;
        case "thread.created":
          state.threads.set(event.payload.threadId, {
            projectId: event.payload.projectId,
            title: event.payload.title,
          });
          return;
        case "thread.meta-updated": {
          const existing = state.threads.get(event.payload.threadId);
          if (existing && event.payload.title !== undefined) {
            state.threads.set(event.payload.threadId, {
              ...existing,
              title: event.payload.title,
            });
          }
          return;
        }
        default:
          return;
      }
    };

    const resolveConversationThread = Effect.fn("resolveConversationThread")(function* (
      state: ConversationProjectionState,
      threadId: ThreadId,
    ) {
      const cached = state.threads.get(threadId);
      if (cached !== undefined) return cached;
      const row = yield* projectionThreadRepository.getById({ threadId });
      if (Option.isNone(row)) return null;
      const resolved = { projectId: row.value.projectId, title: row.value.title } as const;
      state.threads.set(threadId, resolved);
      return resolved;
    });

    const resolveConversationSettings = Effect.fn("resolveConversationSettings")(function* (
      state: ConversationProjectionState,
      projectId: ProjectId,
    ) {
      const cached = state.projectSettings.get(projectId);
      if (cached !== undefined) return cached;
      const row = yield* projectionProjectRepository.getById({ projectId });
      if (Option.isNone(row)) return null;
      const settings = row.value.workspaceControl.conversationRag;
      state.projectSettings.set(projectId, settings);
      return settings;
    });

    const conversationItemForMessage = Effect.fn("conversationItemForMessage")(function* (
      state: ConversationProjectionState,
      event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
    ) {
      if (
        event.payload.role !== "user" ||
        event.payload.inputOrigin !== "user" ||
        event.payload.streaming
      ) {
        return null;
      }
      const thread = yield* resolveConversationThread(state, event.payload.threadId);
      if (thread === null) return null;
      const settings = yield* resolveConversationSettings(state, thread.projectId);
      if (settings === null || !settings.enabled) return null;
      return toConversationRagKnowledgeItem({
        projectId: thread.projectId,
        threadId: event.payload.threadId,
        threadTitle: thread.title,
        sourceId: event.payload.messageId,
        text: event.payload.text,
        attachments: event.payload.attachments ?? [],
        createdAt: event.payload.createdAt,
        settings,
      });
    });

    const conversationItemForUserInputResponse = Effect.fn("conversationItemForUserInputResponse")(
      function* (
        state: ConversationProjectionState,
        event: Extract<OrchestrationEvent, { type: "thread.user-input-response-requested" }>,
      ) {
        const thread = yield* resolveConversationThread(state, event.payload.threadId);
        if (thread === null) return null;
        const settings = yield* resolveConversationSettings(state, thread.projectId);
        if (settings === null || !settings.enabled) return null;
        const sortedAnswers = Object.fromEntries(
          Object.entries(event.payload.answers).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        );
        return toConversationRagKnowledgeItem({
          projectId: thread.projectId,
          threadId: event.payload.threadId,
          threadTitle: thread.title,
          sourceId: event.payload.requestId,
          text: encodeUnknownJsonString(sortedAnswers),
          attachments: [],
          createdAt: event.payload.createdAt,
          settings,
        });
      },
    );

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModelSelection: event.payload.defaultModelSelection,
            scripts: event.payload.scripts,
            workspaceControl: event.payload.workspaceControl ?? DEFAULT_WORKSPACE_CONTROL_SETTINGS,
            runtimeViewedThrough: event.payload.runtimeViewedThrough ?? null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.workspace-control-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            workspaceControl: event.payload.workspaceControl,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.runtime-viewed": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            runtimeViewedThrough: event.payload.viewedThrough,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const workspaceKnowledgeConversationState = makeConversationProjectionState();

    // Kept as a dedicated versioned projector so installations upgrading from
    // an older projects projection replay historical knowledge events instead
    // of inheriting the projects projector's already-advanced cursor.
    const applyWorkspaceKnowledgeProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceKnowledgeProjection",
    )(function* (event, _attachmentSideEffects) {
      trackConversationProjectionEvent(workspaceKnowledgeConversationState, event);
      switch (event.type) {
        case "project.knowledge-item-upserted":
          yield* projectionWorkspaceKnowledgeRepository.upsert({
            id: event.payload.itemId,
            projectId: event.payload.projectId,
            kind: event.payload.kind,
            title: event.payload.title,
            content: event.payload.content,
            status: event.payload.status,
            origin: event.payload.origin,
            relativeFolder: event.payload.relativeFolder,
            tags: event.payload.tags,
            originalChars: event.payload.originalChars,
            storedChars: event.payload.storedChars,
            // An upsert must not disturb the usage counters: re-registering an
            // item the agents keep producing would otherwise reset the very
            // measure of whether it is worth keeping.
            promptUses: 0,
            lastUsedAt: null,
            createdAt: event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;

        case "project.knowledge-item-archived":
          yield* projectionWorkspaceKnowledgeRepository.archive({
            projectId: event.payload.projectId,
            itemId: event.payload.itemId,
            archivedAt: event.payload.archivedAt,
          });
          return;

        case "project.knowledge-usage-recorded":
          yield* projectionWorkspaceKnowledgeRepository.recordUsage({
            projectId: event.payload.projectId,
            itemIds: event.payload.itemIds,
            usedAt: event.payload.usedAt,
          });
          return;

        case "thread.message-sent": {
          const item = yield* conversationItemForMessage(
            workspaceKnowledgeConversationState,
            event,
          );
          if (item !== null) yield* projectionWorkspaceKnowledgeRepository.upsert(item);
          return;
        }

        case "thread.user-input-response-requested": {
          const item = yield* conversationItemForUserInputResponse(
            workspaceKnowledgeConversationState,
            event,
          );
          if (item !== null) yield* projectionWorkspaceKnowledgeRepository.upsert(item);
          return;
        }

        case "thread.deleted": {
          const thread = yield* resolveConversationThread(
            workspaceKnowledgeConversationState,
            event.payload.threadId,
          );
          if (thread !== null) {
            yield* projectionWorkspaceKnowledgeRepository.removeConversationInputs({
              projectId: thread.projectId,
              itemPrefix: conversationRagThreadItemPrefix(event.payload.threadId),
            });
          }
          workspaceKnowledgeConversationState.threads.delete(event.payload.threadId);
          return;
        }

        case "project.workspace-control-updated":
          if (!event.payload.workspaceControl.conversationRag.enabled) {
            yield* projectionWorkspaceKnowledgeRepository.removeConversationInputs({
              projectId: event.payload.projectId,
            });
          }
          return;

        case "project.deleted":
          yield* projectionWorkspaceKnowledgeRepository.removeConversationInputs({
            projectId: event.payload.projectId,
          });
          return;

        default:
          return;
      }
    });

    const workspaceRagConversationState = makeConversationProjectionState();

    // RAG is a derived, rebuildable index with its own cursor. It is reconstructed
    // from Workspace knowledge plus explicitly human-originated conversation events
    // and is never queried without an explicit project id.
    const applyWorkspaceRagProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceRagProjection",
    )(function* (event, _attachmentSideEffects) {
      trackConversationProjectionEvent(workspaceRagConversationState, event);
      switch (event.type) {
        case "project.knowledge-item-upserted":
          yield* projectionWorkspaceRagRepository.replaceItem({
            id: event.payload.itemId,
            projectId: event.payload.projectId,
            kind: event.payload.kind,
            title: event.payload.title,
            content: event.payload.content,
            status: event.payload.status,
            origin: event.payload.origin,
            // The RAG index chunks text; usage counters and compaction sizes
            // live on the knowledge projection and are not part of the search.
            originalChars: null,
            storedChars: null,
            promptUses: 0,
            lastUsedAt: null,
            relativeFolder: event.payload.relativeFolder,
            tags: event.payload.tags,
            createdAt: event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;

        case "project.knowledge-item-archived":
          yield* projectionWorkspaceRagRepository.removeItem({
            projectId: event.payload.projectId,
            itemId: event.payload.itemId,
          });
          return;

        case "thread.message-sent": {
          const item = yield* conversationItemForMessage(workspaceRagConversationState, event);
          if (item !== null) yield* projectionWorkspaceRagRepository.replaceItem(item);
          return;
        }

        case "thread.user-input-response-requested": {
          const item = yield* conversationItemForUserInputResponse(
            workspaceRagConversationState,
            event,
          );
          if (item !== null) yield* projectionWorkspaceRagRepository.replaceItem(item);
          return;
        }

        case "thread.deleted": {
          const thread = yield* resolveConversationThread(
            workspaceRagConversationState,
            event.payload.threadId,
          );
          if (thread !== null) {
            yield* projectionWorkspaceRagRepository.removeConversationInputs({
              projectId: thread.projectId,
              itemPrefix: conversationRagThreadItemPrefix(event.payload.threadId),
            });
          }
          workspaceRagConversationState.threads.delete(event.payload.threadId);
          return;
        }

        case "project.workspace-control-updated":
          if (!event.payload.workspaceControl.conversationRag.enabled) {
            yield* projectionWorkspaceRagRepository.removeConversationInputs({
              projectId: event.payload.projectId,
            });
          }
          return;

        case "project.deleted":
          yield* projectionWorkspaceRagRepository.removeConversationInputs({
            projectId: event.payload.projectId,
          });
          return;

        default:
          return;
      }
    });

    const applyWorkspaceAgentRolesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceAgentRolesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.agent-role-upserted":
          yield* projectionWorkspaceAgentRoleRepository.upsert(event.payload);
          return;
        case "project.agent-role-removed":
          yield* projectionWorkspaceAgentRoleRepository.remove({
            projectId: event.payload.projectId,
            role: event.payload.role,
          });
          return;
        default:
          return;
      }
    });

    const applyWorkspaceCollaborationRunsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceCollaborationRunsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.collaboration-run-requested":
        case "project.collaboration-run-upserted":
          yield* projectionWorkspaceCollaborationRunRepository.upsert(event.payload.run);
          return;
        case "project.collaboration-run-cancel-requested":
          yield* projectionWorkspaceCollaborationRunRepository.requestCancel({
            projectId: event.payload.projectId,
            runId: event.payload.runId,
            cancelledAt: event.payload.cancelledAt,
          });
          return;
        case "project.collaboration-run-answered":
          yield* projectionWorkspaceCollaborationRunRepository.recordAnswer({
            projectId: event.payload.projectId,
            runId: event.payload.runId,
            question: event.payload.question,
            answer: event.payload.answer,
            answeredAt: event.payload.answeredAt,
          });
          return;
        case "project.collaboration-run-interjected":
          yield* projectionWorkspaceCollaborationRunRepository.recordInterjection({
            projectId: event.payload.projectId,
            runId: event.payload.runId,
            text: event.payload.text,
            interjectedAt: event.payload.interjectedAt,
          });
          return;
        default:
          return;
      }
    });

    const applyWorkspaceSchedulesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceSchedulesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.schedule-upserted":
          yield* projectionWorkspaceScheduleRepository.upsertDefinition(event.payload);
          return;
        case "project.schedule-removed":
          yield* projectionWorkspaceScheduleRepository.remove({
            projectId: event.payload.projectId,
            scheduleId: event.payload.scheduleId,
          });
          return;
        case "project.schedule-runtime-updated":
          yield* projectionWorkspaceScheduleRepository.updateRuntime(event.payload);
          return;
        case "project.deleted":
          yield* projectionWorkspaceScheduleRepository.removeByProjectId(event.payload.projectId);
          return;
        default:
          return;
      }
    });

    const applyWorkspaceProgramsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkspaceProgramsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.program-upserted":
          yield* projectionWorkspaceProgramRepository.upsertProgram(event.payload.program);
          return;
        case "project.program-removed":
          yield* projectionWorkspaceProgramRepository.removeProgram({
            projectId: event.payload.projectId,
            programId: event.payload.programId,
          });
          return;
        // Runs and incidents are children of a program row through a cascading foreign key,
        // so a late-arriving write for a program the user already deleted would abort the
        // whole dispatch transaction. The supervisor learns about the removal from the same
        // event stream and is allowed to be one dispatch behind; dropping the orphan write
        // keeps its shutdown path alive instead of stranding the OS process.
        case "project.program-run-upserted": {
          const owner = yield* projectionWorkspaceProgramRepository.getProgram({
            projectId: event.payload.run.projectId,
            programId: event.payload.run.programId,
          });
          if (Option.isNone(owner)) return;
          yield* projectionWorkspaceProgramRepository.upsertRun(event.payload.run);
          return;
        }
        case "project.program-integrity-updated":
          yield* projectionWorkspaceProgramRepository.updateIntegrity(event.payload);
          return;
        case "project.program-incident-upserted": {
          const owner = yield* projectionWorkspaceProgramRepository.getProgram({
            projectId: event.payload.incident.projectId,
            programId: event.payload.incident.programId,
          });
          if (Option.isNone(owner)) return;
          yield* projectionWorkspaceProgramRepository.upsertIncident(event.payload.incident);
          return;
        }
        case "project.deleted":
          yield* projectionWorkspaceProgramRepository.removeByProjectId(event.payload.projectId);
          return;
        default:
          return;
      }
    });

    const refreshThreadShellSummary = Effect.fn("refreshThreadShellSummary")(function* (
      threadId: ThreadId,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }

      const [messages, proposedPlans, activities, pendingApprovals] = yield* Effect.all([
        projectionThreadMessageRepository.listByThreadId({ threadId }),
        projectionThreadProposedPlanRepository.listByThreadId({ threadId }),
        projectionThreadActivityRepository.listByThreadId({ threadId }),
        projectionPendingApprovalRepository.listByThreadId({ threadId }),
      ]);

      let latestUserMessageAt: string | null = null;
      for (const message of messages) {
        if (
          message.role === "user" &&
          (latestUserMessageAt === null || message.createdAt > latestUserMessageAt)
        ) {
          latestUserMessageAt = message.createdAt;
        }
      }

      const pendingApprovalCount = pendingApprovals.filter(
        (approval) => approval.status === "pending",
      ).length;
      const pendingUserInputCount = derivePendingUserInputCountFromActivities(activities);
      const hasActionableProposedPlan = deriveHasActionableProposedPlan({
        latestTurnId: existingRow.value.latestTurnId,
        proposedPlans,
      });

      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        latestUserMessageAt,
        pendingApprovalCount,
        pendingUserInputCount,
        hasActionableProposedPlan: hasActionableProposedPlan ? 1 : 0,
      });
    });

    const applyThreadsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadsProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            deletedAt: null,
          });
          return;

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.settled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "settled",
            settledAt: event.payload.settledAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsettled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: event.payload.reason === "user" ? "active" : null,
            settledAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.snoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: event.payload.snoozedUntil,
            snoozedAt: event.payload.snoozedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsnoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: event.payload.pinnedAt,
            ...(event.payload.pinOrderKey !== undefined
              ? { pinOrderKey: event.payload.pinOrderKey }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unpinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: null,
            pinOrderKey: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pin-reordered": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinOrderKey: event.payload.orderKey,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.titleRegeneration !== undefined
              ? {
                  titleRegenerationRequestId: event.payload.titleRegeneration?.requestId ?? null,
                  titleRegenerationStartedAt: event.payload.titleRegeneration?.startedAt ?? null,
                }
              : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
          attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "thread.message-sent":
        case "thread.proposed-plan-upserted":
        case "thread.activity-appended":
        case "thread.approval-response-requested":
        case "thread.user-input-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            // activeTurnId describes current work; a terminal session must not erase history.
            latestTurnId: event.payload.session.activeTurnId ?? existingRow.value.latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }

          const retainedTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          let latestTurnId: ProjectionTurn["turnId"] = null;
          let latestCheckpointTurnCount = -1;
          for (let index = 0; index < retainedTurns.length; index += 1) {
            const turn = retainedTurns[index];
            if (
              !turn ||
              turn.turnId === null ||
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount
            ) {
              continue;
            }
            if (turn.checkpointTurnCount > latestCheckpointTurnCount) {
              latestCheckpointTurnCount = turn.checkpointTurnCount;
              latestTurnId = turn.turnId;
            }
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadMessagesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.message-sent": {
          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          const nextText = Option.match(existingMessage, {
            onNone: () => event.payload.text,
            onSome: (message) => {
              if (event.payload.streaming) {
                return `${message.text}${event.payload.text}`;
              }
              if (event.payload.text.length === 0) {
                return message.text;
              }
              return event.payload.text;
            },
          });
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : previousMessage?.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            isStreaming: event.payload.streaming,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

    const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadProposedPlansProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadActivitiesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadSessionsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type !== "thread.session-set") {
        return;
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerInstanceId: event.payload.session.providerInstanceId ?? null,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    });

    const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadTurnsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
            if (
              event.payload.session.status === "error" ||
              event.payload.session.status === "stopped" ||
              event.payload.session.status === "interrupted"
            ) {
              yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
                threadId: event.payload.threadId,
              });
            }
            // Leaving the "running" session status is the turn-end signal:
            // settle still-running turns so their duration reflects the whole
            // turn rather than the last assistant message.
            const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
            if (settledTurnState === null) {
              return;
            }
            const existingTurns = yield* projectionTurnRepository.listByThreadId({
              threadId: event.payload.threadId,
            });
            yield* Effect.forEach(
              existingTurns.filter((turn) => turn.turnId !== null && turn.state === "running"),
              (turn) =>
                turn.turnId === null
                  ? Effect.void
                  : projectionTurnRepository.upsertByTurnId({
                      ...turn,
                      turnId: turn.turnId,
                      state: settledTurnState,
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: event.payload.session.updatedAt,
                    }),
              { concurrency: 1 },
            );
            return;
          }

          // A new active turn supersedes any still-running turn on the same
          // thread — steering can open a new turn without the provider ever
          // completing the previous one.
          const otherRunningTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            otherRunningTurns.filter(
              (turn) => turn.turnId !== null && turn.turnId !== turnId && turn.state === "running",
            ),
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                    state: "completed",
                    completedAt: event.payload.session.updatedAt,
                  }),
            { concurrency: 1 },
          );

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          // A completed assistant message only settles the turn once the
          // session is no longer running it — providers may emit several
          // assistant messages per turn (commentary between tool calls), and
          // the turn must stay unsettled until the provider reports turn end
          // (projected as thread.session-set leaving the "running" status).
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const settlesTurn = !event.payload.streaming && !turnStillRunning;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: settlesTurn
                ? existingTurn.value.state === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.state === "error"
                    ? "error"
                    : "completed"
                : existingTurn.value.state,
              completedAt: settlesTurn
                ? (existingTurn.value.completedAt ?? event.payload.updatedAt)
                : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: settlesTurn ? "completed" : "running",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: settlesTurn ? event.payload.updatedAt : null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          // Mid-turn diff updates produce placeholder checkpoints; record the
          // checkpoint, but don't settle a turn its session is still running.
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state: turnStillRunning ? existingTurn.value.state : nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: turnStillRunning ? "running" : nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (event.payload.activity.kind === "provider.approval.respond.failed") {
            const payload =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null;
            const detail =
              typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
            if (isStalePendingApprovalFailureDetail(detail)) {
              if (Option.isNone(existingRow)) {
                return;
              }
              if (existingRow.value.status === "resolved") {
                return;
              }
              yield* projectionPendingApprovalRepository.upsert({
                requestId,
                threadId: existingRow.value.threadId,
                turnId: existingRow.value.turnId,
                status: "resolved",
                decision: null,
                createdAt: existingRow.value.createdAt,
                resolvedAt: event.payload.activity.createdAt,
              });
              return;
            }
            return;
          }
          // Only approval-requested activities should create pending-approval
          // rows.  Other activity kinds that happen to carry a requestId
          // (e.g. user-input.requested / user-input.resolved) must not
          // pollute this projection — they have their own accounting via
          // derivePendingUserInputCountFromActivities.
          if (event.payload.activity.kind !== "approval.requested") {
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaceKnowledge,
        apply: applyWorkspaceKnowledgeProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaceRag,
        apply: applyWorkspaceRagProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaceAgentRoles,
        apply: applyWorkspaceAgentRolesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaceCollaborationRuns,
        apply: applyWorkspaceCollaborationRunsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspaceSchedules,
        apply: applyWorkspaceSchedulesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workspacePrograms,
        apply: applyWorkspaceProgramsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        apply: applyThreadsProjection,
      },
    ];

    const runProjectorForEvent = Effect.fn("runProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
      Effect.forEach(projectors, (projector) => runProjectorForEvent(projector, event), {
        concurrency: 1,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.asVoid,
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
      projectors,
      bootstrapProjector,
      { concurrency: 1 },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      projectEvent,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceKnowledgeRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceRagRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceAgentRoleRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceCollaborationRunRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceScheduleRepositoryLive),
  Layer.provideMerge(ProjectionWorkspaceProgramRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
