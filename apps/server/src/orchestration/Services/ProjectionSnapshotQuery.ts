/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRef,
  OrchestrationCheckpointSummary,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadDetailWindow,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  WorkspaceKnowledgeDashboardInput,
  WorkspaceKnowledgeDashboard,
  WorkspaceWikiLinksInput,
  WorkspaceWikiLinksResult,
  WorkspaceKnowledgeListInput,
  WorkspaceKnowledgeListResult,
  WorkspacePromptComposeInput,
  WorkspacePromptComposeResult,
  WorkspaceControlSettings,
  WorkspaceRagSearchInput,
  WorkspaceRagSearchResult,
  WorkspaceAgentRoleListInput,
  WorkspaceAgentRoleListResult,
  WorkspaceCollaborationRunListInput,
  WorkspaceCollaborationRunListResult,
  WorkspaceScheduleListInput,
  WorkspaceScheduleListResult,
  WorkspaceProgramListInput,
  WorkspaceProgramListResult,
  WorkspaceProgramRunListInput,
  WorkspaceProgramRunListResult,
  WorkspaceIncidentListInput,
  WorkspaceIncidentListResult,
  WorkspaceRuntimeSnapshot,
  WorkspaceRuntimeSnapshotInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

/** Bodies requested by a server worker; omitted collections are not hydrated. */
export interface ProjectionThreadRuntimeRead {
  readonly messages?: boolean;
  readonly activityKinds?: ReadonlyArray<string>;
  readonly proposedPlans?: boolean;
  readonly checkpoints?: boolean;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
type DocumentQueries = ReturnType<
  typeof import("../knowledgeDocuments.ts").makeKnowledgeDocumentQueries
>;

export interface ProjectionSnapshotQueryShape {
  readonly listWorkspaceKnowledgeRevisions?: DocumentQueries["listWorkspaceKnowledgeRevisions"];
  readonly getWorkspaceKnowledgeRevision?: DocumentQueries["getWorkspaceKnowledgeRevision"];
  readonly knowledgeWriteResult?: DocumentQueries["knowledgeWriteResult"];
  /** Event-store ordering for watchdog activity recovery; UI activity sequence is not authoritative. */
  readonly getWatchdogActivitySequences?: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<{ id: string; sequence: number }>, ProjectionRepositoryError>;
  /**
   * `orchestra.block` rows of `workspace_delegate` runs still marked running or
   * awaiting the user, across all threads. Read once at server start to close
   * the blocks a restart left behind. `payload` is the stored JSON text.
   */
  readonly getUnfinishedDelegationBlocks?: () => Effect.Effect<
    ReadonlyArray<{ threadId: string; createdAt: string; payload: string }>,
    ProjectionRepositoryError
  >;
  /** Message IDs whose search memory the user explicitly excluded. */
  readonly getForgottenThreadMessageIds?: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<string>, ProjectionRepositoryError>;
  /** Out-of-folder or unclassified message IDs, or null when the current folder is unknown. */
  readonly getHandoffOutOfScopeMessageIds?: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly messageId: string;
  }) => Effect.Effect<ReadonlyArray<string> | null, ProjectionRepositoryError>;
  /** Recent immutable account failures, retained when a thread changes native sessions. */
  readonly getRateLimitedAccountIds?: (
    since: string,
    quotaExhaustionOnly?: boolean,
  ) => Effect.Effect<ReadonlyArray<string>, ProjectionRepositoryError>;
  /** Explicit user choices before a handoff, even when the provider emitted no acknowledgement. */
  readonly getThreadHandoffDecisions?: (input: {
    readonly threadId: ThreadId;
    readonly beforeSequence: number;
  }) => Effect.Effect<
    ReadonlyArray<import("@t3tools/contracts").OrchestrationThreadActivity>,
    ProjectionRepositoryError
  >;
  readonly getThreadTokenUsage?: (
    input: import("@t3tools/contracts").GetThreadTokenUsageInput,
  ) => Effect.Effect<
    import("@t3tools/contracts").ThreadTokenUsageReport,
    ProjectionRepositoryError
  >;
  readonly getProjectTokenUsage?: (input: {
    readonly projectId: ProjectId;
    readonly since: string;
  }) => Effect.Effect<import("@t3tools/contracts").TokenUsageSummary, ProjectionRepositoryError>;
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Search active thread navigation metadata, user messages, and canonical
   * assistant outputs without hydrating thread detail snapshots.
   */
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, ProjectionRepositoryError>;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /** List knowledge owned by exactly one Workspace; no cross-project query exists. */
  readonly getWorkspaceKnowledgeDashboard?: (
    input: WorkspaceKnowledgeDashboardInput,
  ) => Effect.Effect<WorkspaceKnowledgeDashboard, ProjectionRepositoryError>;
  readonly getWorkspaceWikiLinks?: (
    input: WorkspaceWikiLinksInput,
  ) => Effect.Effect<WorkspaceWikiLinksResult, ProjectionRepositoryError>;
  readonly listWorkspaceKnowledge?: (
    input: WorkspaceKnowledgeListInput,
  ) => Effect.Effect<WorkspaceKnowledgeListResult, ProjectionRepositoryError>;

  /** Search the derived RAG index for exactly one Workspace. */
  readonly searchWorkspaceRag?: (
    input: WorkspaceRagSearchInput,
  ) => Effect.Effect<WorkspaceRagSearchResult, ProjectionRepositoryError>;

  /** Compose directives, goals, prompts, memory, and RAG for one Workspace. */
  readonly composeWorkspacePrompt?: (
    input: WorkspacePromptComposeInput,
  ) => Effect.Effect<WorkspacePromptComposeResult, ProjectionRepositoryError>;
  /** Actual execution additionally saves selected source originals for native file/range lookup. */
  readonly composeWorkspacePromptForExecution?: (
    input: WorkspacePromptComposeInput,
  ) => Effect.Effect<WorkspacePromptComposeResult, ProjectionRepositoryError>;
  /** Read only one project's input policy, without threads or repository identity discovery. */
  readonly getWorkspaceContextSettings?: (
    projectId: ProjectId,
  ) => Effect.Effect<WorkspaceControlSettings["contextOptimization"], ProjectionRepositoryError>;

  /** List role-to-provider-instance bindings for one Workspace. */
  readonly listWorkspaceAgentRoles?: (
    input: WorkspaceAgentRoleListInput,
  ) => Effect.Effect<WorkspaceAgentRoleListResult, ProjectionRepositoryError>;

  /** List collaboration runs owned by one Workspace. */
  readonly listWorkspaceCollaborationRuns?: (
    input: WorkspaceCollaborationRunListInput,
  ) => Effect.Effect<WorkspaceCollaborationRunListResult, ProjectionRepositoryError>;

  /** List unattended schedules owned by one Workspace. */
  readonly listWorkspaceSchedules?: (
    input: WorkspaceScheduleListInput,
  ) => Effect.Effect<WorkspaceScheduleListResult, ProjectionRepositoryError>;

  readonly listWorkspacePrograms?: (
    input: WorkspaceProgramListInput,
  ) => Effect.Effect<WorkspaceProgramListResult, ProjectionRepositoryError>;

  readonly listWorkspaceProgramRuns?: (
    input: WorkspaceProgramRunListInput,
  ) => Effect.Effect<WorkspaceProgramRunListResult, ProjectionRepositoryError>;

  readonly listWorkspaceIncidents?: (
    input: WorkspaceIncidentListInput,
  ) => Effect.Effect<WorkspaceIncidentListResult, ProjectionRepositoryError>;

  /** Derive one Workspace's agent, program, incident, collaboration, and schedule status. */
  readonly getWorkspaceRuntime?: (
    input: WorkspaceRuntimeSnapshotInput,
  ) => Effect.Effect<WorkspaceRuntimeSnapshot, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read current thread metadata and only the body collections a worker needs.
   * Other collections are empty. Full history remains available through the
   * detail APIs; this method never changes or prunes persisted history.
   */
  readonly getThreadRuntimeContext: (
    threadId: ThreadId,
    read?: ProjectionThreadRuntimeRead,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail together with the projection snapshot
   * sequence in one consistent transaction, so the returned `snapshotSequence`
   * exactly matches the state reflected in `thread` (no interleaving projector
   * update between the two reads).
   *
   * When `window` is provided, the thread's messages, activities, proposed
   * plans, and checkpoints are bounded to a page of recent turns and the
   * response carries `page` metadata (see `OrchestrationThreadDetailWindow`).
   * Without a window the full thread is returned with no `page` field —
   * pagination is strictly opt-in.
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
    window?: OrchestrationThreadDetailWindow,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
