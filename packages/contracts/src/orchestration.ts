import { ConversationHandoffMode } from "./conversationHandoff.ts";
import { UnifiedBgTask } from "./backgroundTasks.ts";
import { WorkspaceWikiLinksInput, WorkspaceWikiLinksResult } from "./workspaceWikiLinks.ts";
import { WorkflowExecutionContext, WorkflowVersion } from "./workflowGraph.ts";
import { WorkspaceDesignReference } from "./designReference.ts";
import { WorkspaceCompletionAutomation } from "./completionAutomation.ts";
import { ImportedConversation } from "./conversationTransfer.ts";
import * as Effect from "effect/Effect";
import {
  GetThreadTokenUsageInput,
  ThreadTokenUsageReport,
  TokenUsageContext,
} from "./tokenUsage.ts";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity } from "./environment.ts";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnId,
  WorkspaceKnowledgeItemId,
  WorkspaceCollaborationRunId,
  WorkspaceMeetingParticipantId,
  WorkspaceTaskNodeId,
  WorkspaceScheduleId,
  WorkspaceProgramId,
  WorkspaceProgramRunId,
  WorkspaceIncidentId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ApprovedTaskConditions } from "./taskConditions.ts";
import { ThreadCharacter } from "./threadCharacter.ts";
import { ThreadModelTeam, ThreadTeamMember } from "./threadModelTeam.ts";
import { ThreadResponseStyle } from "./threadResponseStyle.ts";

export const ORCHESTRATION_WS_METHODS = {
  getThreadTokenUsage: "orchestration.getThreadTokenUsage",
  dispatchCommand: "orchestration.dispatchCommand",
  checkTurnReceipt: "orchestration.checkTurnReceipt",
  getWorkflowScript: "orchestration.getWorkflowScript",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  searchThreads: "orchestration.searchThreads",
  getWorkspaceKnowledgeDashboard: "orchestration.getWorkspaceKnowledgeDashboard",
  listWorkspaceKnowledge: "orchestration.listWorkspaceKnowledge",
  getPdfRevisionStatus: "orchestration.getPdfRevisionStatus",
  startPdfRevision: "orchestration.startPdfRevision",
  retryPdfRevision: "orchestration.retryPdfRevision",
  readPdfRevisionSource: "orchestration.readPdfRevisionSource",
  editWorkspaceKnowledge: "orchestration.editWorkspaceKnowledge",
  restoreWorkspaceKnowledge: "orchestration.restoreWorkspaceKnowledge",
  listWorkspaceKnowledgeRevisions: "orchestration.listWorkspaceKnowledgeRevisions",
  getWorkspaceKnowledgeRevision: "orchestration.getWorkspaceKnowledgeRevision",
  getWorkspaceWikiLinks: "orchestration.getWorkspaceWikiLinks",
  searchWorkspaceRag: "orchestration.searchWorkspaceRag",
  composeWorkspacePrompt: "orchestration.composeWorkspacePrompt",
  listWorkspaceAgentRoles: "orchestration.listWorkspaceAgentRoles",
  listWorkspaceCollaborationRuns: "orchestration.listWorkspaceCollaborationRuns",
  listWorkspaceSchedules: "orchestration.listWorkspaceSchedules",
  getWorkspaceRuntime: "orchestration.getWorkspaceRuntime",
  subscribeWorkspaceRuntime: "orchestration.subscribeWorkspaceRuntime",
  discoverWorkspacePrograms: "orchestration.discoverWorkspacePrograms",
  listWorkspacePrograms: "orchestration.listWorkspacePrograms",
  listWorkspaceProgramRuns: "orchestration.listWorkspaceProgramRuns",
  listWorkspaceIncidents: "orchestration.listWorkspaceIncidents",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  cleanupWorkspaceWorktree: "orchestration.cleanupWorkspaceWorktree",
  getSharedLibraryStatus: "orchestration.getSharedLibraryStatus",
  syncSharedLibrary: "orchestration.syncSharedLibrary",
} as const;

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/**
 * `ModelSelection` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

// Source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        // Resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultInstanceIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `ProviderInstanceId`.
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          model: value.model,
          instanceId: value.instanceId,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_IMAGE_SOURCE_BYTES = 50 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS =
  Math.ceil(PROVIDER_SEND_TURN_MAX_FILE_BYTES / 3) * 4 + 256;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatResultMetadata = Schema.Struct({
  kind: Schema.Literals(["image", "text", "file"]),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sourcePath: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  language: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  width: Schema.optional(PositiveInt),
  height: Schema.optional(PositiveInt),
});
export type ChatResultMetadata = typeof ChatResultMetadata.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt,
  result: Schema.optional(ChatResultMetadata),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const QuestionImageAttachment = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  image: ChatImageAttachment,
});
export type QuestionImageAttachment = typeof QuestionImageAttachment.Type;
const UploadQuestionImageAttachment = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  image: UploadChatImageAttachment,
});

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt,
  result: Schema.optional(ChatResultMetadata),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

const UploadChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS),
  ),
});

export const ChatAttachment = Schema.Union([ChatImageAttachment, ChatFileAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment, UploadChatFileAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  /**
   * When true, runs as a declarative validation gate inside an isolated
   * worktree before merge/sign-off (Orca-style lifecycle hook).
   */
  runOnWorktreeValidate: Schema.optional(Schema.Boolean),
  /**
   * When true, runs best-effort inside a worktree immediately before removal.
   */
  runOnWorktreeCleanup: Schema.optional(Schema.Boolean),
  /**
   * URL to open in the in-app browser preview when this script runs (or
   * when the user explicitly requests a preview). Optional; only honored on
   * the desktop build.
   */
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  /**
   * When true, automatically open the preview panel pointed at `previewUrl`
   * the moment this script starts. Ignored without `previewUrl` or on web.
   */
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

/**
 * Small, shell-safe settings for a folder-owned long-running Workspace.
 *
 * Knowledge contents never live in the shell snapshot. They are keyed by
 * `ProjectId` in dedicated projections; this object only tells clients where
 * the Workspace's physical long-term-memory boundary is anchored.
 */
export const WorkspaceConversationRagSettings = Schema.Struct({
  enabled: Schema.Boolean,
  redactSensitiveData: Schema.Boolean,
  maxInputChars: Schema.Int.check(Schema.isBetween({ minimum: 2_000, maximum: 120_000 })),
});
export type WorkspaceConversationRagSettings = typeof WorkspaceConversationRagSettings.Type;

export const DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS: WorkspaceConversationRagSettings = {
  enabled: true,
  redactSensitiveData: true,
  maxInputChars: 24_000,
};

/**
 * Capture of what the agents themselves produced during a collaboration run.
 *
 * Conversation RAG stores what the user typed; this stores every graph node
 * output the agents returned, so research findings and implementation evidence
 * become searchable material instead of living only inside the run record.
 */
export const WorkspaceAgentKnowledgeSettings = Schema.Struct({
  enabled: Schema.Boolean,
  redactSensitiveData: Schema.Boolean,
  maxOutputChars: Schema.Int.check(Schema.isBetween({ minimum: 2_000, maximum: 120_000 })),
});
export type WorkspaceAgentKnowledgeSettings = typeof WorkspaceAgentKnowledgeSettings.Type;

export const DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS: WorkspaceAgentKnowledgeSettings = {
  enabled: true,
  redactSensitiveData: true,
  maxOutputChars: 24_000,
};

/**
 * 프로그램 모니터링 모드 — an always-on watch over the project's programs (and,
 * when the server is told to, over T3 Code itself) that reports into ONE
 * dedicated thread per project and asks there before acting.
 *
 * The AI writes the watch plan; the person approves it. Everything the loop
 * needs to survive a restart lives here on the project: which thread is the
 * monitoring thread, what the approved plan is, and when the last automatic
 * turns ran (the budget is computed from `turnLog`, since turn origin is not
 * persisted per turn).
 */
export const WorkspaceMonitoringAutonomy = Schema.Literals(["ask", "playbooks"]);
export type WorkspaceMonitoringAutonomy = typeof WorkspaceMonitoringAutonomy.Type;

export const WorkspaceMonitoringPlanStatus = Schema.Literals([
  "none",
  "proposed",
  "approved",
  "stale",
]);
export type WorkspaceMonitoringPlanStatus = typeof WorkspaceMonitoringPlanStatus.Type;

export const WorkspaceMonitoringTargetKind = Schema.Literals([
  "program",
  "self-server",
  "self-desktop",
  "process",
  "url",
  /** A log file the server tails for regex patterns (replaces a seat's own `tail -F | grep` loop). */
  "log",
]);
export type WorkspaceMonitoringTargetKind = typeof WorkspaceMonitoringTargetKind.Type;

export const WorkspaceMonitoringTarget = Schema.Struct({
  kind: WorkspaceMonitoringTargetKind,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  programId: Schema.optionalKey(WorkspaceProgramId),
  pid: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  startTimeMs: Schema.optionalKey(NonNegativeInt),
  url: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  /** `log` targets: absolute or workspace-relative file path. */
  path: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(1_000))),
  /** `log` targets: regular expressions; a line matching any of them counts. */
  patterns: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(8)),
  ),
});
export type WorkspaceMonitoringTarget = typeof WorkspaceMonitoringTarget.Type;

export const WorkspaceMonitoringMetricKind = Schema.Literals([
  "cpu",
  "memory",
  "latency",
  "slow-spans",
  "failed-spans",
  "health",
  "regression",
  /** Lines of a `log` target matching its patterns within the window. */
  "log-matches",
]);
export type WorkspaceMonitoringMetricKind = typeof WorkspaceMonitoringMetricKind.Type;

export const WorkspaceMonitoringTrendKind = Schema.Literals([
  "slope",
  "p95-vs-baseline",
  "threshold",
]);
export type WorkspaceMonitoringTrendKind = typeof WorkspaceMonitoringTrendKind.Type;

export const WorkspaceMonitoringMetric = Schema.Struct({
  targetIndex: NonNegativeInt,
  metric: WorkspaceMonitoringMetricKind,
  trend: WorkspaceMonitoringTrendKind,
  /** Window the trend is judged over. */
  windowMin: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  /**
   * Unit depends on `metric`+`trend`: percent for cpu threshold, bytes/min for
   * memory slope, ms for latency, count/min for slow-spans and failed-spans, consecutive
   * failures for health, non-zero exit count for regression, matching lines
   * in the window for log-matches, and a ratio (e.g. 1.5 = 50% worse) for
   * p95-vs-baseline.
   */
  limit: Schema.Number.check(Schema.isFinite()),
});
export type WorkspaceMonitoringMetric = typeof WorkspaceMonitoringMetric.Type;

export const WorkspaceMonitoringPlaybookAction = Schema.Literals([
  "notify-only",
  "restart-program",
  "stop-program",
  "start-program",
  "repair-run",
]);
export type WorkspaceMonitoringPlaybookAction = typeof WorkspaceMonitoringPlaybookAction.Type;

export const WorkspaceMonitoringPlaybook = Schema.Struct({
  /** Index into `metrics`. */
  when: NonNegativeInt,
  action: WorkspaceMonitoringPlaybookAction,
  programId: Schema.optionalKey(WorkspaceProgramId),
});
export type WorkspaceMonitoringPlaybook = typeof WorkspaceMonitoringPlaybook.Type;

export const WorkspaceMonitoringPlan = Schema.Struct({
  revision: NonNegativeInt,
  proposedAt: IsoDateTime,
  approvedAt: Schema.NullOr(IsoDateTime),
  /** One paragraph the AI wrote about why this plan; shown in the UI verbatim. */
  rationale: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  targets: Schema.Array(WorkspaceMonitoringTarget).check(Schema.isMaxLength(16)),
  metrics: Schema.Array(WorkspaceMonitoringMetric).check(Schema.isMaxLength(32)),
  playbooks: Schema.Array(WorkspaceMonitoringPlaybook).check(Schema.isMaxLength(8)),
});
export type WorkspaceMonitoringPlan = typeof WorkspaceMonitoringPlan.Type;

export const WorkspaceMonitoringTurnBudget = Schema.Struct({
  perHour: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
  perDay: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
});
export type WorkspaceMonitoringTurnBudget = typeof WorkspaceMonitoringTurnBudget.Type;

/** The part the person edits directly. */
export const WorkspaceMonitoringUserSettings = Schema.Struct({
  enabled: Schema.Boolean,
  autonomy: WorkspaceMonitoringAutonomy,
  checkIntervalSec: Schema.Int.check(Schema.isBetween({ minimum: 15, maximum: 3_600 })),
  aiTurnBudget: WorkspaceMonitoringTurnBudget,
  /**
   * The 감시 AI: which account and model run the monitoring thread's turns.
   * Null falls back to the project's operator/coordinator role binding.
   */
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type WorkspaceMonitoringUserSettings = typeof WorkspaceMonitoringUserSettings.Type;

/** The approved monitoring state a queued automatic action was based on. */
export const WorkspaceMonitoringGuard = Schema.Struct({
  proposalGeneration: NonNegativeInt,
  planRevision: NonNegativeInt,
  planApprovedAt: IsoDateTime,
});
export type WorkspaceMonitoringGuard = typeof WorkspaceMonitoringGuard.Type;

export const WorkspaceMonitoringSettings = Schema.Struct({
  ...WorkspaceMonitoringUserSettings.fields,
  threadId: Schema.NullOr(ThreadId),
  plan: Schema.NullOr(WorkspaceMonitoringPlan),
  planStatus: WorkspaceMonitoringPlanStatus,
  /** Last plan approved by the person, independent of a pending proposal. */
  activePlan: Schema.optionalKey(Schema.NullOr(WorkspaceMonitoringPlan)),
  activePlanStale: Schema.optionalKey(Schema.Boolean),
  /** Invalidates delayed proposals after another request or manual edit. */
  proposalGeneration: Schema.optionalKey(NonNegativeInt),
  /** Start times of automatic AI turns, newest last, trimmed to the last 24h. */
  turnLog: Schema.Array(IsoDateTime).check(Schema.isMaxLength(60)),
  lastCheckedAt: Schema.NullOr(IsoDateTime),
});
export type WorkspaceMonitoringSettings = typeof WorkspaceMonitoringSettings.Type;

export const DEFAULT_WORKSPACE_MONITORING_SETTINGS: WorkspaceMonitoringSettings = {
  enabled: false,
  autonomy: "ask",
  checkIntervalSec: 60,
  aiTurnBudget: { perHour: 4, perDay: 24 },
  modelSelection: null,
  threadId: null,
  plan: null,
  planStatus: "none",
  turnLog: [],
  lastCheckedAt: null,
};

/**
 * Server-stored orchestra defaults for runs no person configures at send
 * time. Schedules and the integrity loop have nobody at the keyboard to flip
 * the composer toggle, so the opt-in lives on the project; a request that
 * carries its own orchestra settings always wins.
 */
export const WorkspaceOrchestraDefaults = Schema.Struct({
  enabled: Schema.Boolean,
  maxParallel: PositiveInt.check(Schema.isLessThanOrEqualTo(6)),
  isolateWorktrees: Schema.Boolean,
});
export type WorkspaceOrchestraDefaults = typeof WorkspaceOrchestraDefaults.Type;

export const DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS: WorkspaceOrchestraDefaults = {
  enabled: false,
  maxParallel: 3,
  isolateWorktrees: false,
};

export const WorkspaceControlSettings = Schema.Struct({
  completionAutomation: Schema.optionalKey(WorkspaceCompletionAutomation),
  isolationMode: Schema.Literal("strict"),
  /** Missing settings enable automatic chat memory; an explicit opt-out is preserved. */
  contextOptimization: Schema.optionalKey(
    Schema.Struct({
      memoryMode: Schema.Literals(["standard", "relevant"]),
      compactHandoffs: Schema.Boolean,
      autoChatMemory: Schema.Boolean,
      /** Reference-token budget for the assembled workspace prompt; null disables it. */
      maxContextTokens: Schema.optionalKey(
        Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 120_000 }))),
      ),
    }),
  ),
  longTermMemoryRoot: Schema.NullOr(TrimmedNonEmptyString),
  conversationRag: WorkspaceConversationRagSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS)),
  ),
  agentKnowledge: WorkspaceAgentKnowledgeSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS)),
  ),
  monitoring: WorkspaceMonitoringSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_MONITORING_SETTINGS)),
  ),
  orchestra: WorkspaceOrchestraDefaults.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS)),
  ),
});
export type WorkspaceControlSettings = typeof WorkspaceControlSettings.Type;

export const DEFAULT_WORKSPACE_CONTROL_SETTINGS: WorkspaceControlSettings = {
  isolationMode: "strict",
  longTermMemoryRoot: null,
  conversationRag: DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
  agentKnowledge: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
  monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
  orchestra: DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
};

export const WorkspaceKnowledgeKind = Schema.Literals([
  "directive",
  "goal",
  "rag-source",
  "run-memory",
  "working-memory",
  "long-term-memory",
  "prompt",
]);
export type WorkspaceKnowledgeKind = typeof WorkspaceKnowledgeKind.Type;

export const WorkspaceKnowledgeStatus = Schema.Literals([
  "candidate",
  "active",
  "superseded",
  "archived",
]);
export type WorkspaceKnowledgeStatus = typeof WorkspaceKnowledgeStatus.Type;

export const WorkspaceKnowledgeOrigin = Schema.Literals(["user", "agent", "imported"]);
export type WorkspaceKnowledgeOrigin = typeof WorkspaceKnowledgeOrigin.Type;

export const WorkspaceKnowledgeRelativeFolder = TrimmedNonEmptyString.check(
  Schema.isMaxLength(240),
  Schema.makeFilter((value) => {
    const normalized = value.replaceAll("\\", "/");
    const segments = normalized.split("/");
    return (
      !normalized.startsWith("/") &&
      !/^[A-Za-z]:/.test(normalized) &&
      segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
  }),
);
export type WorkspaceKnowledgeRelativeFolder = typeof WorkspaceKnowledgeRelativeFolder.Type;

export const WorkspaceKnowledgeScope = Schema.Literals(["environment", "project", "folder"]);
export type WorkspaceKnowledgeScope = typeof WorkspaceKnowledgeScope.Type;

/** Storage folders organize files; these fields determine where a memory applies. */
const WorkspaceKnowledgeLocationFields = {
  scope: Schema.optionalKey(WorkspaceKnowledgeScope),
  appliesToFolder: Schema.optionalKey(Schema.NullOr(WorkspaceKnowledgeRelativeFolder)),
};

/** Explicit relationships, stored with the existing research JSON and replayed with its event. */
export const WorkspaceKnowledgeLineage = Schema.Struct({
  canonicalId: TrimmedNonEmptyString,
  revision: PositiveInt,
  supersedes: Schema.optionalKey(Schema.Array(WorkspaceKnowledgeItemId)),
  validFrom: Schema.optionalKey(IsoDateTime),
  validTo: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  evidenceRefs: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type WorkspaceKnowledgeLineage = typeof WorkspaceKnowledgeLineage.Type;

export const WorkspaceResearchRecord = Schema.Struct({
  attachment: Schema.optionalKey(
    Schema.Struct({
      threadId: ThreadId,
      messageId: MessageId,
      attachmentId: Schema.String,
      name: Schema.String,
      contentHash: Schema.String,
      parserVersion: Schema.String,
      partial: Schema.Boolean,
      location: Schema.optionalKey(Schema.String),
      locations: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            start: NonNegativeInt,
            end: NonNegativeInt,
            label: Schema.String,
          }),
        ),
      ),
    }),
  ),
  query: Schema.String,
  sources: Schema.Array(Schema.String),
  capturedAt: IsoDateTime,
  verification: Schema.Literals(["unverified", "verified", "contradicted"]),
  design: Schema.optionalKey(WorkspaceDesignReference),
  lineage: Schema.optionalKey(WorkspaceKnowledgeLineage),
  /** Optional subject gate for automatic context, e.g. traces that quote unrelated tasks. */
  contextTopics: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(16)),
  ),
});
export type WorkspaceResearchRecord = typeof WorkspaceResearchRecord.Type;

/** Logical worker classes used by the Workspace task-graph orchestrator. */
export const WorkspaceOrchestrationAgent = Schema.Literals(["fable", "codex", "grok"]);
export type WorkspaceOrchestrationAgent = typeof WorkspaceOrchestrationAgent.Type;

export const WorkspaceKnowledgeActor = Schema.Literals([
  "fable",
  "codex",
  "grok",
  "user",
  "claude",
  "gemini",
  "opencode",
  "cursor",
]);
export type WorkspaceKnowledgeActor = typeof WorkspaceKnowledgeActor.Type;

export const WorkspaceValidationConfidence = Schema.Literals(["high", "medium", "low"]);
export type WorkspaceValidationConfidence = typeof WorkspaceValidationConfidence.Type;

export const WorkspaceKnowledgeSourceModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});

export const WorkspaceKnowledgeProvenance = Schema.Struct({
  /** Logical orchestra slot or capture source recorded on the knowledge item. */
  actor: Schema.optionalKey(WorkspaceKnowledgeActor),
  confidence: Schema.optionalKey(WorkspaceValidationConfidence),
  /** Explicit model and provider account on the attempt that produced the captured output. */
  modelSelection: Schema.optionalKey(WorkspaceKnowledgeSourceModel),
  runId: Schema.optionalKey(WorkspaceCollaborationRunId),
  nodeIds: Schema.optionalKey(Schema.Array(WorkspaceTaskNodeId)),
  nodeId: Schema.optionalKey(WorkspaceTaskNodeId),
  threadId: Schema.optionalKey(ThreadId),
});
const WorkspaceKnowledgeSourceFields = {
  provenance: Schema.optionalKey(Schema.NullOr(WorkspaceKnowledgeProvenance)),
  sourceItemId: Schema.optionalKey(Schema.NullOr(WorkspaceKnowledgeItemId)),
};

export const WorkspaceKnowledgeItem = Schema.Struct({
  ...WorkspaceKnowledgeSourceFields,
  supersededBy: Schema.optionalKey(Schema.NullOr(WorkspaceKnowledgeItemId)),
  id: WorkspaceKnowledgeItemId,
  projectId: ProjectId,
  kind: WorkspaceKnowledgeKind,
  title: TrimmedNonEmptyString,
  content: Schema.String,
  status: WorkspaceKnowledgeStatus,
  origin: WorkspaceKnowledgeOrigin,
  relativeFolder: Schema.NullOr(WorkspaceKnowledgeRelativeFolder),
  ...WorkspaceKnowledgeLocationFields,
  research: Schema.optionalKey(Schema.NullOr(WorkspaceResearchRecord)),
  tags: Schema.Array(TrimmedNonEmptyString),
  /**
   * How many agent prompts this item was actually composed into, and when it
   * last happened. Automatic capture makes knowledge cheap to accumulate, so
   * without this a project cannot tell durable material apart from noise that
   * has never once reached a model.
   */
  promptUses: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  lastUsedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * Characters before and after automatic compaction. Null for items a user
   * wrote directly, which were never compacted. These were previously encoded
   * as `original-chars-N` tags, which display fine but cannot be summed,
   * sorted or compared — the dashboard needs numbers.
   */
  originalChars: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  storedChars: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkspaceKnowledgeItem = typeof WorkspaceKnowledgeItem.Type;

export const WorkspaceKnowledgeDashboardFilters = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(WorkspaceKnowledgeKind),
  origin: Schema.optionalKey(WorkspaceKnowledgeOrigin),
  status: Schema.optionalKey(WorkspaceKnowledgeStatus),
  usage: Schema.optionalKey(Schema.Literals(["used", "unused"])),
  contentHash: Schema.optionalKey(Schema.String),
});
export type WorkspaceKnowledgeDashboardFilters = typeof WorkspaceKnowledgeDashboardFilters.Type;
export const WorkspaceKnowledgeDashboardInput = Schema.Struct({
  projectId: ProjectId,
  ...WorkspaceKnowledgeDashboardFilters.fields,
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
});
export type WorkspaceKnowledgeDashboardInput = typeof WorkspaceKnowledgeDashboardInput.Type;

const dashboardRow = Schema.Struct({
  revisionSequence: NonNegativeInt,
  id: WorkspaceKnowledgeItemId,
  title: Schema.String,
  kind: WorkspaceKnowledgeKind,
  status: WorkspaceKnowledgeStatus,
  promptUses: NonNegativeInt,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  contentHash: Schema.String,
  supersededBy: Schema.NullOr(WorkspaceKnowledgeItemId),
});
const dashboardPage = Schema.Struct({ total: NonNegativeInt, items: Schema.Array(dashboardRow) });
const savedSearchFields = {
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  filters: WorkspaceKnowledgeDashboardFilters,
};
export const WorkspaceKnowledgeDashboard = Schema.Struct({
  projectId: ProjectId,
  measuredAt: IsoDateTime,
  total: NonNegativeInt,
  byKind: Schema.Array(Schema.Struct({ kind: WorkspaceKnowledgeKind, count: NonNegativeInt })),
  byStatus: Schema.Array(
    Schema.Struct({ status: WorkspaceKnowledgeStatus, count: NonNegativeInt }),
  ),
  growth: Schema.Array(Schema.Struct({ day: Schema.String, count: NonNegativeInt })),
  compaction: Schema.Struct({
    measuredItems: NonNegativeInt,
    originalChars: NonNegativeInt,
    storedChars: NonNegativeInt,
    reductionRatio: Schema.NullOr(Schema.Number),
  }),
  matching: dashboardPage,
  candidates: dashboardPage,
  mostUsed: dashboardPage,
  unused: dashboardPage,
  duplicates: Schema.Struct({
    total: NonNegativeInt,
    items: Schema.Array(
      Schema.Struct({
        contentHash: Schema.String,
        count: NonNegativeInt,
      }),
    ),
  }),
  savedSearches: Schema.Array(Schema.Struct({ ...savedSearchFields, updatedAt: IsoDateTime })),
});
export type WorkspaceKnowledgeDashboard = typeof WorkspaceKnowledgeDashboard.Type;

export function isProtectedWorkspaceKnowledgeItem(item: WorkspaceKnowledgeItem): boolean {
  return (
    !item.sourceItemId &&
    (item.origin === "agent" ||
      item.tags.includes("auto-agent-output") ||
      item.tags.includes("auto-conversation") ||
      item.research?.attachment != null)
  );
}

const PublishedPdfRevision = Schema.Struct({
  version: PositiveInt,
  contentHash: TrimmedNonEmptyString,
  totalPages: NonNegativeInt,
});
export const PdfRevisionStatus = Schema.Struct({
  published: PublishedPdfRevision,
  pending: Schema.NullOr(
    Schema.Struct({
      ...PublishedPdfRevision.fields,
      status: Schema.Literals(["indexing", "failed"]),
      lastPage: NonNegativeInt,
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type PdfRevisionStatus = typeof PdfRevisionStatus.Type;

const KnowledgeDocumentKey = { projectId: ProjectId, itemId: WorkspaceKnowledgeItemId };
export const WorkspaceKnowledgeEditInput = Schema.Struct({
  ...KnowledgeDocumentKey,
  ...WorkspaceKnowledgeLocationFields,
  commandId: CommandId,
  expectedSequence: NonNegativeInt,
  title: TrimmedNonEmptyString,
  content: Schema.String,
  /** The editor opened resolved occurrences as explicit ID links. Bare titles are new or unresolved. */
  wikiLinksCanonicalized: Schema.optionalKey(Schema.Boolean),
  kind: Schema.optionalKey(WorkspaceKnowledgeKind),
  tags: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  relativeFolder: Schema.optionalKey(Schema.NullOr(WorkspaceKnowledgeRelativeFolder)),
  research: Schema.optionalKey(Schema.NullOr(WorkspaceResearchRecord)),
});
export type WorkspaceKnowledgeEditInput = typeof WorkspaceKnowledgeEditInput.Type;
const KnowledgeRevisionKey = {
  sequence: PositiveInt,
  occurredAt: IsoDateTime,
  eventType: Schema.Literals([
    "project.knowledge-item-upserted",
    "project.knowledge-item-archived",
  ]),
};
const KnowledgeDocumentWriteResult = Schema.Struct({
  itemId: WorkspaceKnowledgeItemId,
  sequence: PositiveInt,
});

export const WorkspaceKnowledgeListInput = Schema.Struct({
  /** Return item metadata with an empty content field. Fetch an individual item for its body. */
  summariesOnly: Schema.optionalKey(Schema.Boolean),
  itemId: Schema.optionalKey(WorkspaceKnowledgeItemId),
  sourceRunId: Schema.optionalKey(WorkspaceCollaborationRunId),
  sourceItemId: Schema.optionalKey(WorkspaceKnowledgeItemId),
  projectId: ProjectId,
  includeShared: Schema.optionalKey(Schema.Boolean),
  /** Include a consistent snapshot of this project’s separate memory and conversation records. */
  includeArchiveSnapshot: Schema.optionalKey(Schema.Boolean),
  kinds: Schema.optional(Schema.Array(WorkspaceKnowledgeKind)),
  statuses: Schema.optional(Schema.Array(WorkspaceKnowledgeStatus)),
});
export type WorkspaceKnowledgeListInput = typeof WorkspaceKnowledgeListInput.Type;

export const WorkspaceKnowledgeArchiveSnapshot = Schema.Struct({
  memories: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  sourceArchives: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  importedSources: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  threads: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  messages: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  activities: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  plans: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  turns: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});
export type WorkspaceKnowledgeArchiveSnapshot = typeof WorkspaceKnowledgeArchiveSnapshot.Type;
export const WorkspaceKnowledgeListResult = Schema.Struct({
  items: Schema.Array(WorkspaceKnowledgeItem),
  archiveSnapshot: Schema.optionalKey(WorkspaceKnowledgeArchiveSnapshot),
});
export type WorkspaceKnowledgeListResult = typeof WorkspaceKnowledgeListResult.Type;

export const WorkspaceRagSearchInput = Schema.Struct({
  attachmentsOnly: Schema.optionalKey(Schema.Boolean),
  projectId: ProjectId,
  includeShared: Schema.optionalKey(Schema.Boolean),
  contextPaths: Schema.optionalKey(Schema.Array(WorkspaceKnowledgeRelativeFolder)),
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  includeLongTermMemory: Schema.optionalKey(Schema.Boolean),
  /** Total result limit still applies; omitted keeps the legacy one-chunk behavior. */
  maxChunksPerItem: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  ),
});
export type WorkspaceRagSearchInput = typeof WorkspaceRagSearchInput.Type;

export const WorkspaceRagMatch = Schema.Struct({
  /** Edition of the returned passage and any replacement still awaiting publication. */
  pdfRevision: Schema.optionalKey(
    Schema.Struct({
      publishedVersion: PositiveInt,
      pending: Schema.NullOr(
        Schema.Struct({
          version: PositiveInt,
          status: Schema.Literals(["indexing", "failed"]),
        }),
      ),
    }),
  ),
  projectId: ProjectId,
  ...WorkspaceKnowledgeLocationFields,
  itemId: WorkspaceKnowledgeItemId,
  kind: Schema.Literals(["rag-source", "long-term-memory"]),
  title: TrimmedNonEmptyString,
  snippet: Schema.String,
  /**
   * The whole matched chunk, which prompt composition injects — the snippet
   * is a highlighted excerpt for display. Absent from servers predating it.
   */
  content: Schema.optionalKey(Schema.String),
  score: Schema.Number,
  /** Cosine similarity is distinct from BM25/RRF rank; omitted by keyword-only and older servers. */
  semanticSimilarity: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: -1, maximum: 1 })),
  ),
  updatedAt: IsoDateTime,
  chunkId: Schema.optionalKey(TrimmedNonEmptyString),
  research: Schema.optionalKey(Schema.NullOr(WorkspaceResearchRecord)),
});
export type WorkspaceRagMatch = typeof WorkspaceRagMatch.Type;

export function formatPdfSearchEditionLabel(revision: WorkspaceRagMatch["pdfRevision"]): string {
  if (!revision) return "";
  const published = `${revision.publishedVersion}판 공개`;
  const pending = revision.pending;
  if (!pending) return published;
  return `${published} · ${pending.version}판 ${pending.status === "indexing" ? "색인 중" : "색인 실패"}`;
}

export const WorkspaceRagSearchResult = Schema.Struct({
  matches: Schema.Array(WorkspaceRagMatch),
  retrieval: Schema.optionalKey(
    Schema.Struct({
      method: Schema.Literals(["keyword", "hybrid"]),
      indexedChunks: NonNegativeInt,
      totalChunks: NonNegativeInt,
      message: Schema.NullOr(Schema.String),
    }),
  ),
});
export type WorkspaceRagSearchResult = typeof WorkspaceRagSearchResult.Type;

/**
 * A reference from the shared library — external public material every
 * project may read, the one deliberate exception to per-project knowledge
 * isolation. Never written by a project; only a source sync fills it.
 */
export const SharedLibraryMatch = Schema.Struct({
  libraryId: TrimmedNonEmptyString,
  itemId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  snippet: Schema.String,
  content: Schema.String,
  sourceUrl: TrimmedNonEmptyString,
  author: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  score: Schema.Number,
});
export type SharedLibraryMatch = typeof SharedLibraryMatch.Type;

export const WorkspacePromptComposeInput = Schema.Struct({
  includeAttachmentDocuments: Schema.optionalKey(Schema.Boolean),
  /** Avoid re-injecting the automatic RAG copy of the message being sent. */
  sourceMessageId: Schema.optionalKey(MessageId),
  projectId: ProjectId,
  includeShared: Schema.optionalKey(Schema.Boolean),
  contextPaths: Schema.optionalKey(Schema.Array(WorkspaceKnowledgeRelativeFolder)),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  includeRag: Schema.optionalKey(Schema.Boolean),
  includeWorkingMemory: Schema.optionalKey(Schema.Boolean),
  includeLongTermMemory: Schema.optionalKey(Schema.Boolean),
  contextMode: Schema.optionalKey(Schema.Literals(["standard", "relevant"])),
  maxChunksPerItem: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  ),
  /** Include past revisions for explicit historical questions; otherwise current evidence wins. */
  includeHistory: Schema.optionalKey(Schema.Boolean),
  /** Only explicit true includes shared library references; omitted stays project-local. */
  includeSharedLibrary: Schema.optionalKey(Schema.Boolean),
  ragLimit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  maxContextChars: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 2_000, maximum: 120_000 })),
  ),
  /** Missing inherits project settings; null explicitly disables the reference-token budget. */
  maxContextTokens: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 120_000 }))),
  ),
});
export type WorkspacePromptComposeInput = typeof WorkspacePromptComposeInput.Type;

export const WorkspacePromptDecision = Schema.Struct({
  projectId: ProjectId,
  itemId: WorkspaceKnowledgeItemId,
  chunkId: Schema.optionalKey(TrimmedNonEmptyString),
  title: Schema.String,
  selected: Schema.Boolean,
  reason: Schema.Literals([
    "mandatory",
    "relevant",
    "standard",
    "low-relevance",
    "duplicate",
    "superseded",
    "disabled",
    "budget",
    "included-history",
    "contradicted",
    "not-yet-valid",
    "topic-mismatch",
    "current-task",
  ]),
  sourceChars: NonNegativeInt,
  injectedChars: NonNegativeInt,
  matchedTerms: Schema.Array(Schema.String),
  revision: Schema.optionalKey(PositiveInt),
  temporalStatus: Schema.Literals(["current", "history", "future", "unknown"]),
  verification: WorkspaceResearchRecord.fields.verification,
  contentHash: TrimmedNonEmptyString,
  sourceUpdatedAt: IsoDateTime,
});
export type WorkspacePromptDecision = typeof WorkspacePromptDecision.Type;

export const WorkspacePromptDiagnostics = Schema.Struct({
  version: Schema.Literal(1),
  mode: Schema.Literals(["standard", "relevant"]),
  contextRevision: TrimmedNonEmptyString,
  taskChars: NonNegativeInt,
  mandatoryChars: NonNegativeInt,
  memoryChars: NonNegativeInt,
  libraryChars: NonNegativeInt,
  promptChars: NonNegativeInt,
  budgetChars: NonNegativeInt,
  mandatoryOverflowChars: NonNegativeInt,
  /** No tokenizer is assumed for a provider-owned prompt. */
  tokenCount: Schema.Null,
  tokenCountStatus: Schema.Literal("unavailable"),
  decisions: Schema.Array(WorkspacePromptDecision),
});
export type WorkspacePromptDiagnostics = typeof WorkspacePromptDiagnostics.Type;

/** Counts only text assembled by T3, not provider instructions, history, tools, or billed usage. */
export const WorkspacePromptTokenEstimate = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("estimated"),
  scope: Schema.Literal("workspace-prompt"),
  encoding: Schema.Literal("o200k_base"),
  total: NonNegativeInt,
  limit: Schema.NullOr(PositiveInt),
  mandatoryOverflow: NonNegativeInt,
  sections: Schema.Struct({
    task: NonNegativeInt,
    instructions: NonNegativeInt,
    memory: NonNegativeInt,
    library: NonNegativeInt,
  }),
});
export type WorkspacePromptTokenEstimate = typeof WorkspacePromptTokenEstimate.Type;

export const WorkspacePromptComposeResult = Schema.Struct({
  prompt: Schema.String,
  sourceItemIds: Schema.Array(WorkspaceKnowledgeItemId),
  sourceReferences: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        projectId: ProjectId,
        itemId: WorkspaceKnowledgeItemId,
      }),
    ),
  ),
  sourcePassages: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        projectId: ProjectId,
        itemId: WorkspaceKnowledgeItemId,
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  ),
  ragMatches: Schema.Array(WorkspaceRagMatch),
  /** Shared library references the prompt actually carries. */
  libraryMatches: Schema.optionalKey(Schema.Array(SharedLibraryMatch)),
  truncated: Schema.Boolean,
  diagnostics: Schema.optionalKey(WorkspacePromptDiagnostics),
  tokenEstimate: Schema.optionalKey(WorkspacePromptTokenEstimate),
});
export type WorkspacePromptComposeResult = typeof WorkspacePromptComposeResult.Type;

export const WorkspaceAgentRole = Schema.Literals([
  "coordinator",
  "operator",
  "planner",
  "researcher",
  "implementer",
  "reviewer",
  "verifier",
]);
export type WorkspaceAgentRole = typeof WorkspaceAgentRole.Type;

export const WorkspaceAgentRoleBinding = Schema.Struct({
  projectId: ProjectId,
  role: WorkspaceAgentRole,
  displayName: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  instructions: Schema.String.check(Schema.isMaxLength(20_000)),
  enabled: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type WorkspaceAgentRoleBinding = typeof WorkspaceAgentRoleBinding.Type;

export const WorkspaceAgentRoleListInput = Schema.Struct({
  projectId: ProjectId,
});
export type WorkspaceAgentRoleListInput = typeof WorkspaceAgentRoleListInput.Type;

export const WorkspaceAgentRoleListResult = Schema.Struct({
  roles: Schema.Array(WorkspaceAgentRoleBinding),
});
export type WorkspaceAgentRoleListResult = typeof WorkspaceAgentRoleListResult.Type;

export const WorkspaceTaskNodeKind = Schema.Literals([
  "orchestration",
  "research",
  "implementation",
  "debug",
  "validation",
  "synthesis",
]);
export type WorkspaceTaskNodeKind = typeof WorkspaceTaskNodeKind.Type;

export const WorkspaceTaskNodeStatus = Schema.Literals([
  "blocked",
  "queued",
  "running",
  "awaiting-validation",
  /**
   * Parked on a question only the person can settle. Distinct from `blocked`,
   * which waits on another node: nothing the graph does on its own clears this.
   */
  "awaiting-user",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
export type WorkspaceTaskNodeStatus = typeof WorkspaceTaskNodeStatus.Type;

export const WorkspaceTaskAttemptStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkspaceTaskAttemptStatus = typeof WorkspaceTaskAttemptStatus.Type;

export const WorkspaceValidationVerdict = Schema.Literals(["pass", "fail", "inconclusive"]);
export type WorkspaceValidationVerdict = typeof WorkspaceValidationVerdict.Type;

export const WorkspaceFailureClassification = Schema.Literals([
  "information",
  "implementation",
  "tool",
  "assumption",
  "validation",
]);
export type WorkspaceFailureClassification = typeof WorkspaceFailureClassification.Type;

export const WorkspaceTaskGraphStatus = Schema.Literals([
  "planning",
  "executing",
  "validating",
  "synthesizing",
  "completed",
  "failed",
]);
export type WorkspaceTaskGraphStatus = typeof WorkspaceTaskGraphStatus.Type;

export const WorkspaceTaskGraphChangeReason = Schema.Literals([
  "initial-plan",
  "new-information",
  "information-gap",
  "implementation-failure",
  "tool-failure",
  "result-conflict",
  "invalid-assumption",
  "low-confidence",
  "validation-failure",
]);
export type WorkspaceTaskGraphChangeReason = typeof WorkspaceTaskGraphChangeReason.Type;

export const WorkspaceMemoryCategory = Schema.Literals([
  "project-structure",
  "architecture",
  "successful-pattern",
  "failure-pattern",
  "verified-data-source",
  "user-workflow",
  "agent-performance",
]);
export type WorkspaceMemoryCategory = typeof WorkspaceMemoryCategory.Type;

const WorkspaceTaskShortText = Schema.String.check(Schema.isMaxLength(4_000));
const WorkspaceTaskContextText = Schema.String.check(Schema.isMaxLength(20_000));

/** Minimal sufficient context handed to one graph node. */
export const WorkspaceTaskHandoff = Schema.Struct({
  contextPaths: Schema.optionalKey(Schema.Array(WorkspaceKnowledgeRelativeFolder)),
  task: WorkspaceTaskShortText,
  goal: WorkspaceTaskShortText,
  context: WorkspaceTaskContextText,
  input: WorkspaceTaskContextText,
  constraints: Schema.Array(WorkspaceTaskShortText),
  expectedOutput: WorkspaceTaskShortText,
  successCriteria: Schema.Array(WorkspaceTaskShortText),
});
export type WorkspaceTaskHandoff = typeof WorkspaceTaskHandoff.Type;

export const WorkspaceTaskAttempt = Schema.Struct({
  number: PositiveInt,
  agent: WorkspaceOrchestrationAgent,
  role: WorkspaceAgentRole,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  strategy: WorkspaceTaskShortText,
  threadId: ThreadId,
  status: WorkspaceTaskAttemptStatus,
  output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8_000))),
  /** Full rejected output remains in its original message; this receipt verifies recovery input. */
  formatRepair: Schema.optionalKey(
    Schema.Struct({
      messageId: MessageId,
      chars: NonNegativeInt,
      sha256: TrimmedNonEmptyString,
    }),
  ),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8_000))),
  failureClassification: Schema.NullOr(WorkspaceFailureClassification),
  confidence: Schema.NullOr(WorkspaceValidationConfidence),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type WorkspaceTaskAttempt = typeof WorkspaceTaskAttempt.Type;

export const WorkspaceTaskValidationReceipt = Schema.Struct({
  targetNodeId: WorkspaceTaskNodeId,
  verdict: WorkspaceValidationVerdict,
  confidence: WorkspaceValidationConfidence,
  summary: Schema.String.check(Schema.isMaxLength(8_000)),
  evidence: Schema.Array(WorkspaceTaskShortText),
  failureClassification: Schema.NullOr(WorkspaceFailureClassification),
  nextAction: WorkspaceTaskShortText,
  recordedAt: IsoDateTime,
});
export type WorkspaceTaskValidationReceipt = typeof WorkspaceTaskValidationReceipt.Type;

/**
 * A question a node raised while the meeting's single question slot was taken
 * — its seat's own `<t3_question>`, or the intervention question for a node
 * that ran out of retries. Kept on the node so it is published once the slot
 * frees, instead of being dropped and regenerated by a re-run.
 */
export const WorkspaceTaskParkedQuestion = Schema.Struct({
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  options: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  context: Schema.String.check(Schema.isMaxLength(20_000)),
  /** True for the retries-exhausted intervention, whose answer is a verdict. */
  intervention: Schema.Boolean,
  raisedAt: IsoDateTime,
});
export type WorkspaceTaskParkedQuestion = typeof WorkspaceTaskParkedQuestion.Type;

export const WorkspaceTaskNode = Schema.Struct({
  id: WorkspaceTaskNodeId,
  order: NonNegativeInt,
  kind: WorkspaceTaskNodeKind,
  agent: WorkspaceOrchestrationAgent,
  role: WorkspaceAgentRole,
  /**
   * Set on meeting runs, where the person picked the roster and the seats —
   * not the project's role bindings — decide who executes. Null on role-bound
   * runs, including every run recorded before meetings existed, so `agent` and
   * `role` remain the assignment of record there.
   */
  participantId: Schema.NullOr(WorkspaceMeetingParticipantId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * The node's own conversation on an orchestra run, fixed across retries and
   * a resume after a question so the work-in-progress context survives the
   * park. Null on runs recorded before the orchestra and on non-orchestra
   * meeting runs, whose execution shares the meeting thread.
   */
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  parkedQuestion: Schema.NullOr(WorkspaceTaskParkedQuestion).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * The write-chain worktree this node runs in when the run isolates
   * worktrees. Stored exactly as the provisioner returned it — never
   * re-normalized, because a junctioned drive makes two spellings of the same
   * directory compare unequal and restart sessions in a loop. Null for
   * read-only nodes, non-isolating runs, and every pre-orchestra record.
   */
  worktreePath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** The write-chain branch checked out at {@link worktreePath}. */
  branch: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  handoff: WorkspaceTaskHandoff,
  dependsOn: Schema.Array(WorkspaceTaskNodeId),
  validationTargetId: Schema.NullOr(WorkspaceTaskNodeId),
  priority: NonNegativeInt,
  status: WorkspaceTaskNodeStatus,
  /**
   * The node's automatic retry budget. Headroom above the planner's default
   * exists because a person who answers the intervention question with "다시
   * 시도" grants one more attempt, and they may do that several times.
   */
  maxAttempts: PositiveInt.check(Schema.isLessThanOrEqualTo(10)),
  attempts: Schema.Array(WorkspaceTaskAttempt),
  usageRecovery: Schema.optionalKey(
    Schema.Struct({
      fingerprint: Schema.String,
      resumeAt: IsoDateTime,
      count: PositiveInt,
      phase: Schema.Literals(["waiting", "resumed"]),
      lastError: Schema.String,
    }),
  ),
  // Wide enough for real deliverables (work tables, multi-session plans);
  // 40k silently beheaded them in transit and stalled meeting executions.
  output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120_000))),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8_000))),
  failureClassification: Schema.NullOr(WorkspaceFailureClassification),
  confidence: Schema.NullOr(WorkspaceValidationConfidence),
  validation: Schema.NullOr(WorkspaceTaskValidationReceipt),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type WorkspaceTaskNode = typeof WorkspaceTaskNode.Type;

export const WorkspaceTaskGraphChange = Schema.Struct({
  // Format retries can be recorded before the first plan is accepted.
  revision: NonNegativeInt,
  reason: WorkspaceTaskGraphChangeReason,
  summary: Schema.String.check(Schema.isMaxLength(8_000)),
  addedNodeIds: Schema.Array(WorkspaceTaskNodeId),
  supersededNodeIds: Schema.Array(WorkspaceTaskNodeId),
  occurredAt: IsoDateTime,
});
export type WorkspaceTaskGraphChange = typeof WorkspaceTaskGraphChange.Type;

export const WorkspaceMemoryCandidate = Schema.Struct({
  category: WorkspaceMemoryCategory,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  content: Schema.String.check(Schema.isMaxLength(20_000)),
  tags: Schema.Array(TrimmedNonEmptyString),
  confidence: WorkspaceValidationConfidence,
  sourceNodeIds: Schema.Array(WorkspaceTaskNodeId),
});
export type WorkspaceMemoryCandidate = typeof WorkspaceMemoryCandidate.Type;

export const WorkspaceOrchestraPlanEdit = Schema.Struct({
  nodeId: WorkspaceTaskNodeId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  participantId: Schema.NullOr(WorkspaceMeetingParticipantId),
  dependsOn: Schema.Array(WorkspaceTaskNodeId).check(Schema.isMaxLength(24)),
});
export type WorkspaceOrchestraPlanEdit = typeof WorkspaceOrchestraPlanEdit.Type;

export const WorkspaceOrchestraDelivery = Schema.Struct({
  status: Schema.Literals([
    "verifying",
    "passed",
    "failed",
    "needs-verification",
    "awaiting-integration",
  ]),
  detail: Schema.String,
  checkedAt: Schema.NullOr(IsoDateTime),
  fingerprint: Schema.NullOr(Schema.String),
  worktrees: Schema.Array(Schema.String),
  commands: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      exitCode: Schema.NullOr(Schema.Number),
      timedOut: Schema.Boolean,
      logPath: Schema.String,
    }),
  ),
});
export type WorkspaceOrchestraDelivery = typeof WorkspaceOrchestraDelivery.Type;

export const WorkspaceTaskGraph = Schema.Struct({
  /** An unresolved saved-workflow assignment; pending nodes must not run. */
  workflowAssignment: Schema.optionalKey(
    Schema.Struct({
      gateNodeId: WorkspaceTaskNodeId,
      pendingNodeIds: Schema.Array(WorkspaceTaskNodeId),
    }),
  ),
  /** Saved-workflow steps left unperformed after the user skips assignment. */
  workflowSkippedNodeIds: Schema.optionalKey(Schema.Array(WorkspaceTaskNodeId)),
  workspaceBaseline: Schema.optionalKey(Schema.String),
  planReview: Schema.optionalKey(
    Schema.Struct({
      revision: NonNegativeInt,
      status: Schema.Literals(["pending", "approved"]),
      updatedAt: IsoDateTime,
    }),
  ),
  delivery: Schema.optionalKey(WorkspaceOrchestraDelivery),
  revision: NonNegativeInt,
  status: WorkspaceTaskGraphStatus,
  nodes: Schema.Array(WorkspaceTaskNode),
  changes: Schema.Array(WorkspaceTaskGraphChange),
  nextAction: WorkspaceTaskShortText,
  overallConfidence: Schema.NullOr(WorkspaceValidationConfidence),
  repairApproved: Schema.NullOr(Schema.Boolean),
  memoryCandidates: Schema.Array(WorkspaceMemoryCandidate),
});
export type WorkspaceTaskGraph = typeof WorkspaceTaskGraph.Type;

export const WorkspaceCollaborationRunStatus = Schema.Literals([
  "queued",
  "running",
  "cancel-requested",
  "cancelled",
  "completed",
  "failed",
]);
export type WorkspaceCollaborationRunStatus = typeof WorkspaceCollaborationRunStatus.Type;

export const WorkspaceCollaborationStepStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "cancelled",
  "failed",
]);
export type WorkspaceCollaborationStepStatus = typeof WorkspaceCollaborationStepStatus.Type;

export const WorkspaceCollaborationPhase = Schema.Literals([
  "kickoff",
  "contribution",
  "finalization",
]);
export type WorkspaceCollaborationPhase = typeof WorkspaceCollaborationPhase.Type;

export const WorkspaceCollaborationStep = Schema.Struct({
  index: NonNegativeInt,
  phase: WorkspaceCollaborationPhase,
  role: WorkspaceAgentRole,
  displayName: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  instructions: Schema.String.check(Schema.isMaxLength(20_000)),
  threadId: Schema.NullOr(ThreadId),
  status: WorkspaceCollaborationStepStatus,
  output: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type WorkspaceCollaborationStep = typeof WorkspaceCollaborationStep.Type;

/**
 * Who asked for a collaboration run. This is persisted on the run and on the event log, so
 * a value here outlives the release that introduced it. `integrity` runs are started by the
 * program integrity loop rather than by a person, which is what keeps them from preempting
 * a project's scheduled runs.
 */
export const WorkspaceCollaborationRunSource = Schema.Literals([
  "user",
  "schedule",
  "automation",
  "incident",
  "integrity",
]);
export type WorkspaceCollaborationRunSource = typeof WorkspaceCollaborationRunSource.Type;

/**
 * How a meeting decides it is finished. Orthogonal to the chair and to
 * user-in-the-loop, which are settings rather than modes: every one of the
 * three can run with or without either.
 */
export const WorkspaceMeetingMode = Schema.Literals([
  /** Exactly `maxRounds` rounds, then plan. Predictable cost. */
  "fixed-rounds",
  /** Chair judges each round; stops early on agreement, capped at `maxRounds`. */
  "until-consensus",
  /** Chair nominates the next speaker instead of running everyone each round. */
  "free-form",
]);
export type WorkspaceMeetingMode = typeof WorkspaceMeetingMode.Type;

export const WorkspaceMeetingPhase = Schema.Literals([
  "clarifying",
  "discussing",
  "planning",
  "executing",
  "done",
]);
export type WorkspaceMeetingPhase = typeof WorkspaceMeetingPhase.Type;

/**
 * One seat. `modelSelection` is captured when the run starts so a meeting
 * already under way is not re-routed by a later settings change.
 */
export const WorkspaceMeetingParticipant = Schema.Struct({
  id: WorkspaceMeetingParticipantId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  modelSelection: ModelSelection,
  roleDescription: Schema.optionalKey(Schema.String),
});
export type WorkspaceMeetingParticipant = typeof WorkspaceMeetingParticipant.Type;

export const WorkspaceMeetingStatement = Schema.Struct({
  participantId: WorkspaceMeetingParticipantId,
  content: Schema.String.check(Schema.isMaxLength(20_000)),
  /** Seats this statement argues with. Empty in round 1, where nobody has spoken yet. */
  respondsTo: Schema.Array(WorkspaceMeetingParticipantId),
  threadId: Schema.NullOr(ThreadId),
  recordedAt: IsoDateTime,
});
export type WorkspaceMeetingStatement = typeof WorkspaceMeetingStatement.Type;

export const WorkspaceMeetingRound = Schema.Struct({
  index: NonNegativeInt,
  statements: Schema.Array(WorkspaceMeetingStatement),
  /** Null until the chair has closed the round. */
  chairSummary: Schema.NullOr(Schema.String.check(Schema.isMaxLength(20_000))),
  /** Only `until-consensus` sets this; the other modes leave it null. */
  consensusReached: Schema.NullOr(Schema.Boolean),
});
export type WorkspaceMeetingRound = typeof WorkspaceMeetingRound.Type;

/** Identifies the displayed question even when another node asks the same text. */
export const WorkspaceMeetingQuestionRef = Schema.Struct({
  nodeId: Schema.NullOr(WorkspaceTaskNodeId),
  askedAt: IsoDateTime,
});
export type WorkspaceMeetingQuestionRef = typeof WorkspaceMeetingQuestionRef.Type;

/**
 * A question that stops the run until the person answers. One shape serves both
 * triggers — the per-round check-in that `userInLoop` schedules, and an agent
 * hitting something it cannot settle — because the run pauses identically for
 * both and resuming is the same command.
 */
export const WorkspaceMeetingQuestion = Schema.Struct({
  /** Null when the server raised the round check-in rather than a seat asking. */
  askedByParticipantId: Schema.NullOr(WorkspaceMeetingParticipantId),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  /** Suggested answers. Free text is always allowed, so this may be empty. */
  options: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  context: Schema.String.check(Schema.isMaxLength(20_000)),
  askedAt: IsoDateTime,
  /**
   * The graph node this question belongs to, so the answer resumes that node
   * alone. Null for meeting-phase questions (round check-in, wrap-up, the
   * chair's own) and for questions recorded before nodes could run in parallel.
   */
  nodeId: Schema.NullOr(WorkspaceTaskNodeId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type WorkspaceMeetingQuestion = typeof WorkspaceMeetingQuestion.Type;

export const WorkspaceMeetingInterjection = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  /** The round that was open (or about to open) when this arrived. */
  roundIndex: NonNegativeInt,
  /** How many statements that round already had — the transcript anchor. */
  afterStatements: NonNegativeInt,
  saidAt: IsoDateTime,
});
export type WorkspaceMeetingInterjection = typeof WorkspaceMeetingInterjection.Type;

const WorkspaceQuestionImageReference = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});

export const WorkspaceMeeting = Schema.Struct({
  workspaceBaseline: Schema.optionalKey(Schema.String),
  /** Last completed cycle of an explicitly requested persistent run. */
  continuation: Schema.optionalKey(
    Schema.Struct({
      cycle: PositiveInt,
      workerTurns: NonNegativeInt,
      summary: Schema.String.check(Schema.isMaxLength(20_000)),
      nextTask: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
    }),
  ),
  /** Number of user instructions included in the supervisor's latest planning or review turn. */
  supervisorReviewedInterjections: Schema.optionalKey(NonNegativeInt),
  /** The supervisor must review instructions received after its latest planning or review turn. */
  pendingSupervisorReview: Schema.optionalKey(Schema.Boolean),
  /** Stable recovery identity for a supervisor review while a refusal question remains open. */
  refusalInstructionReview: Schema.optionalKey(
    Schema.Struct({
      answerCount: PositiveInt,
      status: Schema.Literals(["pending", "completed", "failed"]),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  mode: WorkspaceMeetingMode,
  phase: WorkspaceMeetingPhase,
  /** Server-owned failure budget, persisted with the run so restart cannot replenish retries. */
  turnFailures: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        key: TrimmedNonEmptyString,
        count: PositiveInt,
        message: Schema.String,
      }),
    ),
  ),
  /** False confines planning and recovery to the user-selected roster. */
  allowAdditionalWorkers: Schema.optionalKey(Schema.Boolean),
  participants: Schema.Array(WorkspaceMeetingParticipant).check(Schema.isMinLength(1)),
  /**
   * The one conversation window the whole meeting lives in. Every turn —
   * statements, chair duties, the seats' share of execution — runs in this
   * thread, each on its own provider session. Null decodes runs recorded
   * before the field existed; the reactor assigns it on first use.
   */
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Null means elect one — the reactor takes the first seat. */
  chairParticipantId: Schema.NullOr(WorkspaceMeetingParticipantId),
  /** 0 rounds is direct collaboration: no discussion, straight to the plan. */
  maxRounds: NonNegativeInt.check(Schema.isLessThanOrEqualTo(10)),
  /**
   * The person's cap on execution-graph revisions (retries, follow-up work,
   * replans) for this run. Absent falls back to the server ceiling.
   */
  maxRevisions: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(8))),
  userInLoop: Schema.Boolean,
  rounds: Schema.Array(WorkspaceMeetingRound),
  pendingQuestion: Schema.NullOr(WorkspaceMeetingQuestion),
  /** Answers already given, oldest first, so a resumed run keeps the person's steer. */
  answers: Schema.Array(
    Schema.Struct({
      question: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
      answer: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
      imageReferences: Schema.optionalKey(Schema.Array(WorkspaceQuestionImageReference)),
      answeredAt: IsoDateTime,
      /** Copied from the question it answered; null for meeting-phase answers. */
      nodeId: Schema.NullOr(WorkspaceTaskNodeId).pipe(
        Schema.withDecodingDefault(Effect.succeed(null)),
      ),
    }),
  ),
  /**
   * What the person said into the live discussion, outside the
   * question/answer protocol. Each entry is anchored to the transcript
   * position it arrived at — after `afterStatements` statements of round
   * `roundIndex` — so prompts replay the meeting in true speaking order.
   */
  interjections: Schema.Array(WorkspaceMeetingInterjection).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type WorkspaceMeeting = typeof WorkspaceMeeting.Type;

/**
 * What a client sends to open a meeting: the roster and the rules, with none of
 * the transcript. Everything else on `WorkspaceMeeting` is server-owned state,
 * so a client cannot inject rounds or pre-answer its own questions.
 */
export const WorkspaceMeetingSetup = Schema.Struct({
  /** The conductor asks first; no discussion or execution before the user's answer. */
  askFirst: Schema.optionalKey(Schema.Boolean),
  /** The app-selected policies for this run, including draft conversations. */
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  mode: WorkspaceMeetingMode,
  allowAdditionalWorkers: Schema.optionalKey(Schema.Boolean),
  participants: Schema.Array(WorkspaceMeetingParticipant).check(Schema.isMinLength(1)),
  chairParticipantId: Schema.NullOr(WorkspaceMeetingParticipantId),
  /** 0 rounds is direct collaboration: no discussion, straight to the plan. */
  maxRounds: NonNegativeInt.check(Schema.isLessThanOrEqualTo(10)),
  /** Caps execution-graph revisions (retries, follow-ups, replans) for the run. */
  maxRevisions: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(8))),
  userInLoop: Schema.Boolean,
  /**
   * The conversation the meeting should happen in — the thread the person was
   * looking at when they sent the topic. Omitted opens a fresh thread instead
   * (a draft composer has no thread yet, and schedules never had one).
   */
  threadId: Schema.optionalKey(ThreadId),
});
export type WorkspaceMeetingSetup = typeof WorkspaceMeetingSetup.Type;

/**
 * Orchestra nodes use independent provider sessions and append blocks in one
 * durable conversation. These run-level settings control parallel width and
 * checkout isolation, independently of conversation ownership.
 */
export const WorkspaceOrchestraSettings = Schema.Struct({
  /** Only an explicit selection enables continuation after a completed cycle. */
  executionMode: Schema.optionalKey(Schema.Literals(["once", "persistent"])),
  /** Nodes executed at once. */
  maxParallel: PositiveInt.check(Schema.isLessThanOrEqualTo(6)),
  /** Pauses once the executable plan is ready; off preserves direct execution. */
  reviewPlan: Schema.optionalKey(Schema.Boolean),
  /** Commands supplied by the user or selected execution profile. */
  verificationCommands: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(8)),
  ),
  /** Absent keeps historical runs readable. */
  completionCheck: Schema.optionalKey(Schema.Boolean),
  maxWorkerTurns: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(500))),
  /** An explicitly selected period for a separate supervisor-model watchdog session. */
  watchdogIntervalSeconds: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  ),
  /** Wait for a known provider reset and resume at most three times; absent is off. */
  resumeAfterLimit: Schema.optionalKey(Schema.Boolean),
  /**
   * Give each write chain its own worktree (Phase 2). While off, write nodes
   * run one at a time so parallel edits never collide in the project root.
   */
  isolateWorktrees: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type WorkspaceOrchestraSettings = typeof WorkspaceOrchestraSettings.Type;

/** Server-owned, reusable settings; each execution keeps its own revision. */
export const WorkspaceExecutionProfile = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  revision: NonNegativeInt,
  instructions: Schema.String.check(Schema.isMaxLength(4_000)),
  verificationCommands: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).check(
    Schema.isMaxLength(8),
  ),
  meeting: WorkspaceMeetingSetup,
  orchestra: WorkspaceOrchestraSettings,
});
export type WorkspaceExecutionProfile = typeof WorkspaceExecutionProfile.Type;

export const WorkflowRoleModels = Schema.Struct({
  coordinator: ModelSelection,
  implementer: ModelSelection,
  researcher: ModelSelection,
});
export type WorkflowRoleModels = typeof WorkflowRoleModels.Type;

export const WorkspaceProviderPreflightWarning = Schema.Struct({
  role: Schema.Literals(["implementer", "researcher"]),
  modelSelection: ModelSelection,
  message: Schema.String.check(Schema.isMaxLength(4_000)),
});
export type WorkspaceProviderPreflightWarning = typeof WorkspaceProviderPreflightWarning.Type;

/** A bootstrap style and the prior room value observed before its first request was accepted. */
export const ThreadResponseStyleSeed = Schema.Struct({
  value: ThreadResponseStyle,
  previous: Schema.NullOr(ThreadResponseStyle),
});
export type ThreadResponseStyleSeed = typeof ThreadResponseStyleSeed.Type;

const ClientWorkspaceWorkflowContext = Schema.Struct({
  responseStyle: Schema.optionalKey(Schema.NullOr(ThreadResponseStyle)),
  ...WorkflowExecutionContext.fields,
  providerWarnings: Schema.optionalKey(Schema.Array(WorkspaceProviderPreflightWarning)),
  definition: WorkflowVersion,
  roleBindings: Schema.Array(WorkspaceAgentRoleBinding),
  roleModels: Schema.optionalKey(WorkflowRoleModels),
  threadId: Schema.optionalKey(ThreadId),
});
export const WorkspaceWorkflowContext = Schema.Struct({
  ...ClientWorkspaceWorkflowContext.fields,
  customSubordinateTeam: Schema.optionalKey(Schema.Array(ThreadTeamMember)),
  initialModelTeams: Schema.optionalKey(Schema.Array(ThreadModelTeam)),
  initialResponseStyle: Schema.optionalKey(ThreadResponseStyleSeed),
});
export type WorkspaceWorkflowContext = typeof WorkspaceWorkflowContext.Type;

export const WorkspaceRunControl = Schema.Struct({
  control: WorkflowExecutionContext.fields.control,
  controlRevision: WorkflowExecutionContext.fields.controlRevision,
  executionRevision: WorkflowExecutionContext.fields.executionRevision,
  updatedAt: IsoDateTime,
});
export type WorkspaceRunControl = typeof WorkspaceRunControl.Type;

const ClientWorkspaceRunContext = Schema.Struct({
  responseStyle: Schema.optionalKey(Schema.NullOr(ThreadResponseStyle)),
  providerWarnings: Schema.optionalKey(Schema.Array(WorkspaceProviderPreflightWarning)),
  requestDigest: Schema.String,
  threadId: Schema.optionalKey(ThreadId),
  roleBindings: Schema.optionalKey(Schema.Array(WorkspaceAgentRoleBinding)),
  requestMode: Schema.optionalKey(Schema.Literals(["direct", "ask-first", "conditions"])),
});
export const WorkspaceRunContext = Schema.Struct({
  ...ClientWorkspaceRunContext.fields,
  customSubordinateTeam: Schema.optionalKey(Schema.Array(ThreadTeamMember)),
  initialModelTeams: Schema.optionalKey(Schema.Array(ThreadModelTeam)),
  initialResponseStyle: Schema.optionalKey(ThreadResponseStyleSeed),
});
export type WorkspaceRunContext = typeof WorkspaceRunContext.Type;

export const WorkspaceCollaborationRun = Schema.Struct({
  id: WorkspaceCollaborationRunId,
  projectId: ProjectId,
  source: WorkspaceCollaborationRunSource,
  scheduleId: Schema.NullOr(WorkspaceScheduleId),
  incidentId: Schema.NullOr(WorkspaceIncidentId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  status: WorkspaceCollaborationRunStatus,
  steps: Schema.Array(WorkspaceCollaborationStep),
  graph: Schema.NullOr(WorkspaceTaskGraph).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  workflow: Schema.optionalKey(Schema.NullOr(WorkspaceWorkflowContext)),
  runControl: Schema.optionalKey(Schema.NullOr(WorkspaceRunControl)),
  runContext: Schema.optionalKey(Schema.NullOr(WorkspaceRunContext)),
  /**
   * Present for a roster chosen in the model picker or a saved execution profile.
   * Null keeps the role-bound path for runs without an explicit roster.
   */
  meeting: Schema.NullOr(WorkspaceMeeting).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  orchestra: Schema.NullOr(WorkspaceOrchestraSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  finalOutput: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkspaceCollaborationRun = typeof WorkspaceCollaborationRun.Type;

export const WorkspaceCollaborationRunListInput = Schema.Struct({
  projectId: ProjectId,
  statuses: Schema.optionalKey(Schema.Array(WorkspaceCollaborationRunStatus)),
  workflowOnly: Schema.optionalKey(Schema.Boolean),
  runId: Schema.optionalKey(WorkspaceCollaborationRunId),
});
export type WorkspaceCollaborationRunListInput = typeof WorkspaceCollaborationRunListInput.Type;

export const WorkspaceCollaborationRunListResult = Schema.Struct({
  runs: Schema.Array(WorkspaceCollaborationRun),
});
export type WorkspaceCollaborationRunListResult = typeof WorkspaceCollaborationRunListResult.Type;

export const WorkspaceScheduleTaskRecipe = Schema.Struct({
  recipeId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  revision: NonNegativeInt,
  inputs: Schema.Record(TrimmedNonEmptyString, Schema.String.check(Schema.isMaxLength(4000))),
});
export type WorkspaceScheduleTaskRecipe = typeof WorkspaceScheduleTaskRecipe.Type;

export const WorkspaceScheduleTiming = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("once"),
    runAt: IsoDateTime,
    executionProfile: Schema.optionalKey(WorkspaceExecutionProfile),
    taskRecipe: Schema.optionalKey(WorkspaceScheduleTaskRecipe),
  }),
  Schema.Struct({
    kind: Schema.Literal("interval"),
    everyMinutes: PositiveInt.check(Schema.isLessThanOrEqualTo(10_080)),
    startAt: IsoDateTime,
    executionProfile: Schema.optionalKey(WorkspaceExecutionProfile),
    taskRecipe: Schema.optionalKey(WorkspaceScheduleTaskRecipe),
  }),
  Schema.Struct({
    kind: Schema.Literal("daily"),
    localTime: TrimmedNonEmptyString.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
    timeZone: TrimmedNonEmptyString,
    executionProfile: Schema.optionalKey(WorkspaceExecutionProfile),
    taskRecipe: Schema.optionalKey(WorkspaceScheduleTaskRecipe),
  }),
  Schema.Struct({
    kind: Schema.Literal("after-run"),
    runId: WorkspaceCollaborationRunId,
    condition: Schema.Literals(["completed", "verified"]),
    onFailure: Schema.Literals(["hold", "cancel"]),
    executionProfile: Schema.optionalKey(WorkspaceExecutionProfile),
    taskRecipe: Schema.optionalKey(WorkspaceScheduleTaskRecipe),
  }),
]);
export type WorkspaceScheduleTiming = typeof WorkspaceScheduleTiming.Type;

export const WorkspaceSchedule = Schema.Struct({
  id: WorkspaceScheduleId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  enabled: Schema.Boolean,
  timing: WorkspaceScheduleTiming,
  nextTriggerAt: Schema.NullOr(IsoDateTime),
  lastTriggeredAt: Schema.NullOr(IsoDateTime),
  lastRunId: Schema.NullOr(WorkspaceCollaborationRunId),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkspaceSchedule = typeof WorkspaceSchedule.Type;

export const WorkspaceScheduleListInput = Schema.Struct({ projectId: ProjectId });
export type WorkspaceScheduleListInput = typeof WorkspaceScheduleListInput.Type;

export const WorkspaceScheduleListResult = Schema.Struct({
  schedules: Schema.Array(WorkspaceSchedule),
});
export type WorkspaceScheduleListResult = typeof WorkspaceScheduleListResult.Type;

export const WorkspaceProgramStartPolicy = Schema.Literals(["manual", "server-start"]);
export type WorkspaceProgramStartPolicy = typeof WorkspaceProgramStartPolicy.Type;

export const WorkspaceProgramIntegrityStatus = Schema.Literals([
  "disabled",
  "queued",
  "running",
  "stopping",
  "stopped",
  "converged",
  "failed",
]);
export type WorkspaceProgramIntegrityStatus = typeof WorkspaceProgramIntegrityStatus.Type;

export const WorkspaceProgramIntegrity = Schema.Struct({
  enabled: Schema.Boolean,
  validationCommands: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(8_000))),
  requiredCleanPasses: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  status: WorkspaceProgramIntegrityStatus,
  cycle: NonNegativeInt,
  consecutiveCleanPasses: NonNegativeInt,
  activeRunId: Schema.NullOr(WorkspaceCollaborationRunId),
  lastRunId: Schema.NullOr(WorkspaceCollaborationRunId),
  summary: Schema.NullOr(Schema.String.check(Schema.isMaxLength(65_536))),
  startedAt: Schema.NullOr(IsoDateTime),
  convergedAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type WorkspaceProgramIntegrity = typeof WorkspaceProgramIntegrity.Type;

export const DEFAULT_WORKSPACE_PROGRAM_INTEGRITY: WorkspaceProgramIntegrity = {
  enabled: false,
  validationCommands: [],
  requiredCleanPasses: 2,
  status: "disabled",
  cycle: 0,
  consecutiveCleanPasses: 0,
  activeRunId: null,
  lastRunId: null,
  summary: null,
  startedAt: null,
  convergedAt: null,
  updatedAt: null,
};

export const WorkspaceProgramRelativeDirectory = TrimmedString.check(
  Schema.isMaxLength(240),
  Schema.makeFilter((value) => {
    const normalized = value.replaceAll("\\", "/");
    if (normalized === "" || normalized === ".") return true;
    const segments = normalized.split("/");
    return (
      !normalized.startsWith("/") &&
      !/^[A-Za-z]:/.test(normalized) &&
      segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
  }),
);
export type WorkspaceProgramRelativeDirectory = typeof WorkspaceProgramRelativeDirectory.Type;

const WorkspaceProgramHealthCheckBase = {
  intervalSeconds: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 3_600 })),
  timeoutSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  failureThreshold: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
} as const;

export const WorkspaceProgramHealthCheck = Schema.Union([
  Schema.Struct({
    ...WorkspaceProgramHealthCheckBase,
    kind: Schema.Literal("http"),
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000), Schema.isPattern(/^https?:\/\//i)),
    expectedStatusMin: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
    expectedStatusMax: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  }),
  Schema.Struct({
    ...WorkspaceProgramHealthCheckBase,
    kind: Schema.Literal("tcp"),
    host: TrimmedNonEmptyString.check(Schema.isMaxLength(253)),
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  }),
]).check(
  Schema.makeFilter(
    (check) => check.kind !== "http" || check.expectedStatusMin <= check.expectedStatusMax,
  ),
);
export type WorkspaceProgramHealthCheck = typeof WorkspaceProgramHealthCheck.Type;

/**
 * A shared dataset prepared and consumed by the program's adapter (for example,
 * an Arrow IPC mapping). The hub publishes its project-relative source as an
 * absolute `T3_HUB_DATASET_<NAME>` path; it does not convert the file itself.
 */
export const WorkspaceProgramSharedDataset = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(40), Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)),
  relativeSource: TrimmedNonEmptyString.check(
    Schema.isMaxLength(240),
    Schema.makeFilter((value) => {
      const normalized = value.replaceAll("\\", "/");
      const segments = normalized.split("/");
      return (
        normalized !== "." &&
        !normalized.startsWith("/") &&
        !/^[A-Za-z]:/.test(normalized) &&
        segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
      );
    }),
  ),
});
export type WorkspaceProgramSharedDataset = typeof WorkspaceProgramSharedDataset.Type;

/**
 * Hub memory budget for one program. `commitLimitMb` becomes a Windows Job
 * Object per-process commit cap around the program (allocation failure, never
 * a kill; file mappings are exempt). Programs sharing a `concurrencyGroup` run
 * at most `concurrencySlots` at a time per project; extra starts queue. A missing
 * slot count means one, and conflicting group settings use the strictest cap.
 */
export const WorkspaceProgramHubMemory = Schema.Struct({
  commitLimitMb: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 1_048_576 })),
  ),
  concurrencyGroup: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  concurrencySlots: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
  sharedDatasets: Schema.Array(WorkspaceProgramSharedDataset).check(Schema.isMaxLength(32)),
});
export type WorkspaceProgramHubMemory = typeof WorkspaceProgramHubMemory.Type;

export const DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY: WorkspaceProgramHubMemory = {
  commitLimitMb: null,
  concurrencyGroup: null,
  concurrencySlots: null,
  sharedDatasets: [],
};

export const WorkspaceProgram = Schema.Struct({
  id: WorkspaceProgramId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  relativeDirectory: WorkspaceProgramRelativeDirectory,
  environmentVariableNames: Schema.Array(
    TrimmedNonEmptyString.check(
      Schema.isMaxLength(128),
      Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
    ),
  ),
  startPolicy: WorkspaceProgramStartPolicy,
  healthCheck: Schema.NullOr(WorkspaceProgramHealthCheck),
  errorPatterns: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  enabled: Schema.Boolean,
  integrity: WorkspaceProgramIntegrity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_PROGRAM_INTEGRITY)),
  ),
  hubMemory: WorkspaceProgramHubMemory.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkspaceProgram = typeof WorkspaceProgram.Type;

export const WorkspaceProgramRunStatus = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "exited",
  "failed",
]);
export type WorkspaceProgramRunStatus = typeof WorkspaceProgramRunStatus.Type;
export const WorkspaceProgramHealthStatus = Schema.Literals([
  "unknown",
  "healthy",
  "degraded",
  "unhealthy",
]);
export type WorkspaceProgramHealthStatus = typeof WorkspaceProgramHealthStatus.Type;

export const WorkspaceHealthCheckFailureReason = Schema.Literals([
  /** No answer inside `timeoutSeconds`. */
  "timeout",
  /** Connection refused, reset, or otherwise failed before any answer. */
  "connection",
  /** Answered, but with an HTTP status outside the expected range. */
  "unexpected-status",
  /**
   * The probe did time out, but the watching server's own event loop was
   * stalled for longer than the limit (a dev build, a GC pause), so the program
   * may well have answered in time. Recorded, never counted toward the failure
   * threshold.
   */
  "inconclusive",
]);
export type WorkspaceHealthCheckFailureReason = typeof WorkspaceHealthCheckFailureReason.Type;

/** Why the most recent health check failed; null while healthy or never checked. */
export const WorkspaceHealthCheckFailure = Schema.Struct({
  reason: WorkspaceHealthCheckFailureReason,
  detail: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  /** Wall-clock time the probe took, from dispatch to settlement. */
  elapsedMs: NonNegativeInt,
  checkedAt: IsoDateTime,
});
export type WorkspaceHealthCheckFailure = typeof WorkspaceHealthCheckFailure.Type;

export const WorkspaceProgramRun = Schema.Struct({
  id: WorkspaceProgramRunId,
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  status: WorkspaceProgramRunStatus,
  pid: Schema.NullOr(NonNegativeInt),
  startedAt: IsoDateTime,
  stoppedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  healthStatus: WorkspaceProgramHealthStatus,
  consecutiveHealthFailures: NonNegativeInt,
  lastHealthCheckAt: Schema.NullOr(IsoDateTime),
  lastHealthFailure: Schema.NullOr(WorkspaceHealthCheckFailure).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  recentLogTail: Schema.String.check(Schema.isMaxLength(65_536)),
  updatedAt: IsoDateTime,
});
export type WorkspaceProgramRun = typeof WorkspaceProgramRun.Type;

export const WorkspaceIncidentKind = Schema.Literals([
  "spawn-failure",
  "process-exit",
  "log-pattern",
  "health-check",
]);
export type WorkspaceIncidentKind = typeof WorkspaceIncidentKind.Type;
export const WorkspaceIncidentSeverity = Schema.Literals(["warning", "error", "critical"]);
export type WorkspaceIncidentSeverity = typeof WorkspaceIncidentSeverity.Type;
export const WorkspaceIncidentStatus = Schema.Literals([
  "open",
  "diagnosing",
  "awaiting-user",
  "repairing",
  "verifying",
  "resolved",
]);
export type WorkspaceIncidentStatus = typeof WorkspaceIncidentStatus.Type;

export const WorkspaceIncident = Schema.Struct({
  id: WorkspaceIncidentId,
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  runId: Schema.NullOr(WorkspaceProgramRunId),
  kind: WorkspaceIncidentKind,
  severity: WorkspaceIncidentSeverity,
  status: WorkspaceIncidentStatus,
  fingerprint: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  evidence: Schema.String.check(Schema.isMaxLength(65_536)),
  occurrenceCount: PositiveInt,
  firstOccurredAt: IsoDateTime,
  lastOccurredAt: IsoDateTime,
  diagnosisThreadId: Schema.NullOr(ThreadId),
  diagnosis: Schema.NullOr(Schema.String.check(Schema.isMaxLength(65_536))),
  repairRunId: Schema.NullOr(WorkspaceCollaborationRunId),
  resolvedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type WorkspaceIncident = typeof WorkspaceIncident.Type;

export const WorkspaceProgramCandidateSource = Schema.Literals([
  "project-script",
  "package-json",
  "docker-compose",
  "python",
  "rust",
]);
export const WorkspaceProgramCandidate = Schema.Struct({
  id: WorkspaceProgramId,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  relativeDirectory: WorkspaceProgramRelativeDirectory,
  source: WorkspaceProgramCandidateSource,
  reason: TrimmedNonEmptyString,
});
export type WorkspaceProgramCandidate = typeof WorkspaceProgramCandidate.Type;

export const WorkspaceProgramListInput = Schema.Struct({ projectId: ProjectId });
export type WorkspaceProgramListInput = typeof WorkspaceProgramListInput.Type;
export const WorkspaceProgramListResult = Schema.Struct({
  programs: Schema.Array(WorkspaceProgram),
});
export type WorkspaceProgramListResult = typeof WorkspaceProgramListResult.Type;
export const WorkspaceProgramDiscoveryResult = Schema.Struct({
  candidates: Schema.Array(WorkspaceProgramCandidate),
});
export type WorkspaceProgramDiscoveryResult = typeof WorkspaceProgramDiscoveryResult.Type;
export const WorkspaceProgramRunListInput = Schema.Struct({
  projectId: ProjectId,
  programId: Schema.optionalKey(WorkspaceProgramId),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type WorkspaceProgramRunListInput = typeof WorkspaceProgramRunListInput.Type;
export const WorkspaceProgramRunListResult = Schema.Struct({
  runs: Schema.Array(WorkspaceProgramRun),
});
export type WorkspaceProgramRunListResult = typeof WorkspaceProgramRunListResult.Type;
export const WorkspaceIncidentListInput = Schema.Struct({
  projectId: ProjectId,
  programId: Schema.optionalKey(WorkspaceProgramId),
  statuses: Schema.optionalKey(Schema.Array(WorkspaceIncidentStatus)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type WorkspaceIncidentListInput = typeof WorkspaceIncidentListInput.Type;
export const WorkspaceIncidentListResult = Schema.Struct({
  incidents: Schema.Array(WorkspaceIncident),
});
export type WorkspaceIncidentListResult = typeof WorkspaceIncidentListResult.Type;

export const WorkspaceRuntimeStatus = Schema.Literals([
  "idle",
  "working",
  "blocked",
  "failed",
  "done",
  "unknown",
]);
export type WorkspaceRuntimeStatus = typeof WorkspaceRuntimeStatus.Type;

export const WorkspaceRuntimeLifecycleStatus = Schema.Literals([
  "idle",
  "working",
  "failed",
  "unknown",
]);
export type WorkspaceRuntimeLifecycleStatus = typeof WorkspaceRuntimeLifecycleStatus.Type;

export const WorkspaceRuntimeAttention = Schema.Literals([
  "none",
  "completed-unseen",
  "needs-input",
  "error",
]);
export type WorkspaceRuntimeAttention = typeof WorkspaceRuntimeAttention.Type;

export const WorkspaceRuntimeEvidenceAuthority = Schema.Literals([
  "provider",
  "orchestration",
  "program-supervisor",
  "scheduler",
  "monitoring",
]);
export type WorkspaceRuntimeEvidenceAuthority = typeof WorkspaceRuntimeEvidenceAuthority.Type;

export const WorkspaceRuntimeEvidenceSource = Schema.Literals([
  "thread",
  "program",
  "incident",
  "collaboration",
  "schedule",
  "monitoring",
]);
export type WorkspaceRuntimeEvidenceSource = typeof WorkspaceRuntimeEvidenceSource.Type;

export const WorkspaceRuntimeEvidence = Schema.Struct({
  status: WorkspaceRuntimeStatus,
  authority: WorkspaceRuntimeEvidenceAuthority,
  source: WorkspaceRuntimeEvidenceSource,
  sourceId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  observedAt: IsoDateTime,
});
export type WorkspaceRuntimeEvidence = typeof WorkspaceRuntimeEvidence.Type;

export const WorkspaceRuntimeCounts = Schema.Struct({
  threadCount: NonNegativeInt,
  workingThreadCount: NonNegativeInt,
  blockedThreadCount: NonNegativeInt,
  failedThreadCount: NonNegativeInt,
  activeProgramCount: NonNegativeInt,
  unhealthyProgramCount: NonNegativeInt,
  openIncidentCount: NonNegativeInt,
  activeCollaborationCount: NonNegativeInt,
  failedCollaborationCount: NonNegativeInt,
  enabledScheduleCount: NonNegativeInt,
  attentionCount: NonNegativeInt,
  completedUnseenCount: NonNegativeInt,
});
export type WorkspaceRuntimeCounts = typeof WorkspaceRuntimeCounts.Type;

/** Monitoring state as the project row carries it — no reactor memory involved. */
export const WorkspaceRuntimeMonitoring = Schema.Struct({
  enabled: Schema.Boolean,
  planStatus: WorkspaceMonitoringPlanStatus,
  threadId: Schema.NullOr(ThreadId),
  /** Automatic turns still allowed this hour / today under the person's budget. */
  budgetRemainingHour: NonNegativeInt,
  budgetRemainingDay: NonNegativeInt,
  lastCheckedAt: Schema.NullOr(IsoDateTime),
});
export type WorkspaceRuntimeMonitoring = typeof WorkspaceRuntimeMonitoring.Type;

export const WorkspaceRuntimeSnapshotInput = Schema.Struct({ projectId: ProjectId });
export type WorkspaceRuntimeSnapshotInput = typeof WorkspaceRuntimeSnapshotInput.Type;

export const WorkspaceRuntimeSnapshot = Schema.Struct({
  projectId: ProjectId,
  status: WorkspaceRuntimeStatus,
  lifecycleStatus: WorkspaceRuntimeLifecycleStatus,
  attention: WorkspaceRuntimeAttention,
  counts: WorkspaceRuntimeCounts,
  evidence: Schema.Array(WorkspaceRuntimeEvidence).check(Schema.isMaxLength(50)),
  viewedThrough: Schema.NullOr(IsoDateTime),
  latestCompletionAt: Schema.NullOr(IsoDateTime),
  /** Latest program, incident, collaboration, or schedule projection change. */
  operationsUpdatedAt: Schema.NullOr(IsoDateTime),
  monitoring: WorkspaceRuntimeMonitoring,
  updatedAt: IsoDateTime,
});
export type WorkspaceRuntimeSnapshot = typeof WorkspaceRuntimeSnapshot.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  workspaceControl: Schema.optional(WorkspaceControlSettings),
  runtimeViewedThrough: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

/** Distinguishes direct human input from prompts emitted by unattended automation. */
export const OrchestrationInputOrigin = Schema.Literals(["user", "automation"]);
export type OrchestrationInputOrigin = typeof OrchestrationInputOrigin.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

/** Text and asynchronous questions can be closed even when no turn is active. */
export function isRecoverableUserInputRequestId(requestId: string | null | undefined): boolean {
  return (
    requestId?.startsWith("async:") === true || requestId?.startsWith("text-question:") === true
  );
}

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

export const EXAONE_DEFERRED_CONFIRM_PREFIX = "exaone-deferred:";
export const EXAONE_DEFERRED_CONFIRM_QUESTION = "confirm";
export const EXAONE_DEFERRED_CONFIRM_ANSWER = "이전 답변을 확인했고 이 질문을 따로 열겠습니다";

export function includeDeferredExaoneQuestions(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  pending: ReadonlyArray<{
    requestId: ApprovalRequestId;
    createdAt: string;
    questions: ReadonlyArray<import("./providerRuntime.ts").UserInputQuestion>;
  }>,
) {
  const deferred = new Map<string, OrchestrationThreadActivity>();
  const hidden = new Set<string>();
  const observedNative = new Set<string>();
  const resolvedNative = new Set<string>();
  for (const activity of activities) {
    const payload = activity.payload as {
      requestId?: unknown;
      requestIds?: unknown;
      nativeRequestId?: unknown;
      questions?: unknown;
    } | null;
    if (!payload || typeof payload !== "object") continue;
    if (
      (activity.kind === "user-input.requested" || activity.kind === "user-input.resolved") &&
      typeof payload.requestId === "string"
    )
      observedNative.add(payload.requestId);
    if (activity.kind === "user-input.resolved" && typeof payload.requestId === "string")
      resolvedNative.add(payload.requestId);
    if (
      activity.kind !== "provider.user-input.duplicate.deferred" ||
      typeof payload.nativeRequestId !== "string" ||
      !Array.isArray(payload.questions) ||
      payload.questions.length === 0
    )
      continue;
    if (typeof payload.requestId === "string") hidden.add(payload.requestId);
    if (Array.isArray(payload.requestIds)) {
      for (const requestId of payload.requestIds)
        if (typeof requestId === "string") hidden.add(requestId);
    }
    deferred.set(payload.nativeRequestId, activity);
  }
  const confirmations = [...deferred.entries()].flatMap(([nativeId, activity]) =>
    observedNative.has(nativeId)
      ? []
      : [
          {
            requestId: ApprovalRequestId.make(EXAONE_DEFERRED_CONFIRM_PREFIX + nativeId),
            createdAt: activity.createdAt,
            questions: [
              {
                id: EXAONE_DEFERRED_CONFIRM_QUESTION,
                header: "중복 질문 확인",
                question:
                  "같은 내용의 질문이 나중에 도착했습니다. 별도로 답하면 AI가 같은 작업을 다시 실행할 수 있습니다. 이전 답변의 결과를 확인한 뒤 질문을 열겠습니까?",
                options: [
                  {
                    label: EXAONE_DEFERRED_CONFIRM_ANSWER,
                    description:
                      "이전 답변은 다시 보내지 않습니다. 질문을 연 뒤 직접 새 답변을 제출할 수 있습니다.",
                  },
                ],
              },
            ],
          },
        ],
  );
  return [
    ...confirmations,
    ...pending.filter(
      (item) =>
        !hidden.has(item.requestId) &&
        !(deferred.has(item.requestId) && resolvedNative.has(item.requestId)),
    ),
  ];
}

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

/**
 * The owner of a legacy orchestra node conversation. New executions keep
 * independent provider sessions and append blocks to the owner's conversation
 * without creating node conversations. Retained for reading existing history;
 * optional so older conversations and unrelated commands still decode.
 * Read it as `?? null`.
 */
export const OrchestraRunThreadId = Schema.optional(Schema.NullOr(ThreadId));

export const OrchestrationThread = Schema.Struct({
  handoffMode: Schema.optional(ConversationHandoffMode),
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  orchestraRunThreadId: OrchestraRunThreadId,
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // Snooze is an overlay on the active lifecycle, not a fourth destination:
  // a snoozed thread stays "active" in the model and is only suppressed from
  // the inbox until snoozedUntil passes (or the thread raises its hand).
  // Optional so payloads from pre-snooze servers still decode.
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // A pin overrides the settled/snoozed lifecycle: while pinnedAt is set the
  // thread renders in the pinned block and never classifies into a shelf.
  // Optional so payloads from pre-pinning servers still decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Fractional index for user-arranged pinned order. Keyed threads sort by
  // string comparison ahead of keyless ones (which keep creation order), so
  // servers never need each other's threads to agree on the merged list.
  // Optional so payloads from pre-reorder servers still decode.
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Pending-only state. Optional so older servers remain compatible.
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  workspaceControl: Schema.optional(WorkspaceControlSettings),
  runtimeViewedThrough: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

export const OrchestrationThreadShell = Schema.Struct({
  handoffMode: Schema.optional(ConversationHandoffMode),
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  orchestraRunThreadId: OrchestraRunThreadId,
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  /**
   * Native background work alive after the turn settles: "working" while
   * subagents/workflows run, "monitoring" when watch loops are the only
   * live work. Optional so old servers/clients interop; absent = none.
   */
  backgroundLiveness: Schema.optional(Schema.NullOr(Schema.Literals(["working", "monitoring"]))),
  /**
   * Ground-truth live background tasks for the thread (local PIDs and remote
   * async jobs) used by the 3-tier verification UI. Optional for interop.
   */
  backgroundTasks: Schema.optional(Schema.Array(UnifiedBgTask)),
  /**
   * Current plan step while a turn runs, for the Working indicators
   * (sidebar row, in-chat working line). Cleared when the turn settles —
   * never persists as stale UI. Optional so old servers/clients interop.
   */
  planProgress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        step: TrimmedNonEmptyString,
        completedSteps: NonNegativeInt,
        totalSteps: NonNegativeInt,
      }),
    ),
  ),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  /**
   * When provided, the server skips the initial full shell snapshot and instead
   * replays shell events after this sequence before streaming live events.
   * Clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
   * sequence here so the subscription resumes without re-sending the entire
   * projects/threads list (overlapping events are deduped by sequence on the
   * client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * When provided, the server skips the initial snapshot frame and instead
   * replays events after this sequence before streaming live events. Clients
   * that load the snapshot over HTTP pass the snapshot's sequence here so the
   * live subscription resumes without a gap (overlapping events are deduped by
   * sequence on the client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * When provided, the fallback snapshot frame (sent when `afterSequence` is
   * missing or the catch-up gap is too large) is windowed to the last
   * `turnLimit` user-anchored turns and carries `page` metadata. Absent means
   * the fallback snapshot is the full thread, preserving pre-pagination client
   * behavior. Live events are unaffected either way.
   */
  turnLimit: Schema.optionalKey(PositiveInt),
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

/**
 * Bounds a thread detail read to a window of recent turns. `turnLimit` counts
 * turns with a user pending message (subagent/fan-out turns between them ride
 * along), so the window always contains the last N user prompts. `beforeCursor`
 * requests the disjoint page of older turns strictly before a previously
 * returned cursor. Requests without a window get the full thread; pagination is
 * strictly opt-in so older clients keep today's behavior on both HTTP and the
 * WebSocket fallback snapshot.
 */
export const OrchestrationThreadDetailWindow = Schema.Struct({
  turnLimit: Schema.optionalKey(PositiveInt),
  beforeCursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OrchestrationThreadDetailWindow = typeof OrchestrationThreadDetailWindow.Type;

/**
 * Page metadata for a windowed thread detail read. `beforeCursor` is opaque and
 * exclusive: passing it back returns the adjacent disjoint slice of older
 * turns. `null` means the thread is fully loaded below this page. The
 * `snapshotSequence` mirrors the top-level snapshot sequence so history pages
 * can be sequence-checked against live state before merging.
 */
export const OrchestrationThreadDetailPage = Schema.Struct({
  beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
  hasMore: Schema.Boolean,
  snapshotSequence: NonNegativeInt,
  /**
   * Highest event sequence applied to THIS thread at page read time. The
   * global `snapshotSequence` advances with every thread's events, so a
   * client cannot wait for it via its per-thread subscription; this
   * thread-scoped watermark is reachable. A client merging an older page
   * must first have applied live events up to it — otherwise a streaming
   * turn outside the loaded window could have deltas replayed on top of
   * page content that already includes them, duplicating text.
   */
  threadSequence: Schema.optionalKey(NonNegativeInt),
});
export type OrchestrationThreadDetailPage = typeof OrchestrationThreadDetailPage.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  // Present only on windowed responses. Absent on full snapshots (and from
  // pre-pagination servers), which clients treat as fully loaded.
  page: Schema.optional(OrchestrationThreadDetailPage),
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  longTermMemoryRoot: Schema.optional(TrimmedNonEmptyString),
  createLongTermMemoryRootIfMissing: Schema.optional(Schema.Boolean),
  conversationRag: Schema.optionalKey(WorkspaceConversationRagSettings),
  agentKnowledge: Schema.optionalKey(WorkspaceAgentKnowledgeSettings),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectWorkspaceControlUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.workspace-control.update"),
  commandId: CommandId,
  projectId: ProjectId,
  completionAutomation: Schema.optionalKey(WorkspaceCompletionAutomation),
  contextOptimization: WorkspaceControlSettings.fields.contextOptimization,
  longTermMemoryRoot: Schema.NullOr(TrimmedNonEmptyString),
  conversationRag: Schema.optionalKey(WorkspaceConversationRagSettings),
  agentKnowledge: Schema.optionalKey(WorkspaceAgentKnowledgeSettings),
  /**
   * Person-editable monitoring fields. Omitted → unchanged. The plan itself is
   * editable too: a plan the person edits is approved by definition.
   */
  monitoring: Schema.optionalKey(
    Schema.Struct({
      ...WorkspaceMonitoringUserSettings.fields,
      plan: Schema.optionalKey(Schema.NullOr(WorkspaceMonitoringPlan)),
    }),
  ),
  /** Orchestra defaults for unattended runs. Omitted → unchanged. */
  orchestra: Schema.optionalKey(WorkspaceOrchestraDefaults),
  createLongTermMemoryRootIfMissing: Schema.optional(Schema.Boolean),
});

/** Accept the plan the AI proposed into the monitoring thread. */
const ProjectMonitoringPlanApproveCommand = Schema.Struct({
  type: Schema.Literal("project.monitoring.plan.approve"),
  commandId: CommandId,
  projectId: ProjectId,
  /** Guards against approving a plan that was replaced while the card was open. */
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
});

/** Ask the AI to look at the project again and propose a fresh plan. */
const ProjectMonitoringReanalyzeCommand = Schema.Struct({
  type: Schema.Literal("project.monitoring.reanalyze"),
  commandId: CommandId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
});

const ProjectRuntimeViewCommand = Schema.Struct({
  type: Schema.Literal("project.runtime.view"),
  commandId: CommandId,
  projectId: ProjectId,
  viewedThrough: IsoDateTime,
  createdAt: IsoDateTime,
});

const ProjectKnowledgeItemUpsertCommand = Schema.Struct({
  ...WorkspaceKnowledgeSourceFields,
  documentWrite: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ mode: Schema.Literal("legacy") }),
      Schema.Struct({ mode: Schema.Literal("restore") }),
      Schema.Struct({ mode: Schema.Literal("edit"), edit: WorkspaceKnowledgeEditInput }),
    ]),
  ),
  type: Schema.Literal("project.knowledge.item.upsert"),
  ...WorkspaceKnowledgeLocationFields,
  research: Schema.optionalKey(Schema.NullOr(WorkspaceResearchRecord)),
  commandId: CommandId,
  projectId: ProjectId,
  itemId: WorkspaceKnowledgeItemId,
  kind: WorkspaceKnowledgeKind,
  title: TrimmedNonEmptyString,
  content: Schema.String,
  status: WorkspaceKnowledgeStatus,
  origin: WorkspaceKnowledgeOrigin,
  relativeFolder: Schema.NullOr(WorkspaceKnowledgeRelativeFolder),
  tags: Schema.Array(TrimmedNonEmptyString),
  /** Set by automatic capture; omitted for material a user wrote directly. */
  originalChars: Schema.optionalKey(NonNegativeInt),
  storedChars: Schema.optionalKey(NonNegativeInt),
  createdAt: IsoDateTime,
});

const knowledgeCommandFields = {
  commandId: CommandId,
  projectId: ProjectId,
  createdAt: IsoDateTime.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
};
const ProjectKnowledgeBulkCommand = Schema.Struct({
  type: Schema.Literal("project.knowledge.bulk"),
  ...knowledgeCommandFields,
  items: Schema.Array(
    Schema.Struct({
      id: WorkspaceKnowledgeItemId,
      updatedAt: IsoDateTime,
      revisionSequence: NonNegativeInt,
    }),
  ).check(Schema.isMinLength(1)),
  operation: Schema.Union([
    Schema.Struct({ type: Schema.Literal("promote") }),
    Schema.Struct({ type: Schema.Literal("archive") }),
    Schema.Struct({ type: Schema.Literal("reclassify"), kind: WorkspaceKnowledgeKind }),
    Schema.Struct({ type: Schema.Literal("merge"), targetId: WorkspaceKnowledgeItemId }),
  ]),
});
const ProjectKnowledgeSearchSaveCommand = Schema.Struct({
  type: Schema.Literal("project.knowledge.search.save"),
  ...knowledgeCommandFields,
  ...savedSearchFields,
  expectedUpdatedAt: Schema.NullOr(IsoDateTime),
});
const ProjectKnowledgeSearchRemoveCommand = Schema.Struct({
  type: Schema.Literal("project.knowledge.search.remove"),
  ...knowledgeCommandFields,
  id: TrimmedNonEmptyString,
  expectedUpdatedAt: IsoDateTime,
});

const ProjectKnowledgeItemArchiveCommand = Schema.Struct({
  type: Schema.Literal("project.knowledge.item.archive"),
  commandId: CommandId,
  projectId: ProjectId,
  itemId: WorkspaceKnowledgeItemId,
  createdAt: IsoDateTime,
});

/**
 * Recorded when knowledge is composed into a prompt an agent actually runs.
 * Deliberately not emitted for the control center's prompt preview: the point
 * is to measure what reached a model, not what a user looked at.
 */
const ProjectKnowledgeUsageRecordCommand = Schema.Struct({
  type: Schema.Literal("project.knowledge.usage.record"),
  commandId: CommandId,
  projectId: ProjectId,
  itemIds: Schema.Array(WorkspaceKnowledgeItemId),
  usedAt: IsoDateTime,
});

const ProjectAgentRoleUpsertCommand = Schema.Struct({
  type: Schema.Literal("project.agent-role.upsert"),
  commandId: CommandId,
  projectId: ProjectId,
  role: WorkspaceAgentRole,
  displayName: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  instructions: Schema.String.check(Schema.isMaxLength(20_000)),
  enabled: Schema.Boolean,
  createdAt: IsoDateTime,
});

const ProjectAgentRoleRemoveCommand = Schema.Struct({
  type: Schema.Literal("project.agent-role.remove"),
  commandId: CommandId,
  projectId: ProjectId,
  role: WorkspaceAgentRole,
  createdAt: IsoDateTime,
});

const ProjectCollaborationRunRequestCommand = Schema.Struct({
  type: Schema.Literal("project.collaboration.run.request"),
  commandId: CommandId,
  runId: WorkspaceCollaborationRunId,
  projectId: ProjectId,
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  /** Omitted by clients, which always speak for a person. */
  source: Schema.optionalKey(Schema.Literals(["user", "integrity", "automation"])),
  /**
   * Whether starting this run should cancel the project's queued scheduled runs. Defaults to
   * true for a person's request, false for anything the server starts on its own.
   */
  preempt: Schema.optionalKey(Schema.Boolean),
  /**
   * Present when the person opened this from the model picker's meeting mode.
   * Absent keeps the role-bound path, which is what schedules and the integrity
   * loop send.
   */
  meeting: Schema.optionalKey(WorkspaceMeetingSetup),
  /** Present to run the execution nodes in parallel; absent keeps the current behaviour. */
  orchestra: Schema.optionalKey(WorkspaceOrchestraSettings),
  executionProfile: Schema.optionalKey(WorkspaceExecutionProfile),
  workflow: Schema.optionalKey(WorkspaceWorkflowContext),
  runContext: Schema.optionalKey(WorkspaceRunContext),
  createdAt: IsoDateTime,
});

// Only the workflow service can attach a validated draft team to a run request.
const ClientProjectCollaborationRunRequestCommand = Schema.Struct({
  ...ProjectCollaborationRunRequestCommand.fields,
  workflow: Schema.optionalKey(ClientWorkspaceWorkflowContext),
  runContext: Schema.optionalKey(ClientWorkspaceRunContext),
});

const ProjectWorkflowRunCommand = Schema.Struct({
  ...ProjectCollaborationRunRequestCommand.fields,
  type: Schema.Literal("project.workflow.run.request"),
  workflow: WorkspaceWorkflowContext,
});

const ProjectWorkflowSaveCommand = Schema.Struct({
  type: Schema.Literal("project.workflow.save"),
  commandId: CommandId,
  projectId: ProjectId,
  definition: WorkflowVersion,
  expectedRevision: NonNegativeInt,
});
const ProjectWorkflowDeliveryCommand = Schema.Struct({
  type: Schema.Literal("project.workflow.delivery"),
  commandId: CommandId,
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  nodeId: Schema.String,
  executionId: Schema.String,
  phase: Schema.Literals(["submitting", "accepted", "stopped"]),
  confirmed: Schema.Boolean,
  createdAt: IsoDateTime,
});

const ProjectCollaborationRunControlCommand = Schema.Struct({
  type: Schema.Literal("project.collaboration.run.control"),
  commandId: CommandId,
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  expectedRevision: NonNegativeInt,
  action: Schema.Literals(["pause", "resume", "cancel", "retry"]),
  nodeId: Schema.optionalKey(Schema.String),
  createdAt: IsoDateTime,
});

/**
 * The person speaking into a live meeting outside the question/answer
 * protocol. Recorded into the transcript; the next seat to speak sees it.
 */
const ProjectCollaborationRunInterjectCommand = Schema.Struct({
  type: Schema.Literal("project.collaboration.run.interject"),
  commandId: CommandId,
  runId: WorkspaceCollaborationRunId,
  projectId: ProjectId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  createdAt: IsoDateTime,
});

/**
 * Settles the run's `pendingQuestion` and lets it continue. Carries the question
 * text and identity so a stale client cannot answer a replacement question,
 * including one with the same text. Older clients must refresh before answering.
 */
const ProjectCollaborationRunAnswerFields = {
  type: Schema.Literal("project.collaboration.run.answer"),
  commandId: CommandId,
  runId: WorkspaceCollaborationRunId,
  projectId: ProjectId,
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  questionRef: WorkspaceMeetingQuestionRef,
  answer: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  createdAt: IsoDateTime,
};
const ProjectCollaborationRunAnswerCommand = Schema.Struct({
  ...ProjectCollaborationRunAnswerFields,
  imageReferences: Schema.optionalKey(
    Schema.Array(WorkspaceQuestionImageReference).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  ),
});
const ClientProjectCollaborationRunAnswerCommand = Schema.Struct({
  ...ProjectCollaborationRunAnswerFields,
  images: Schema.optionalKey(
    Schema.Array(UploadChatImageAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  ),
});

const ProjectCollaborationRunReviewCommand = Schema.Struct({
  type: Schema.Literal("project.collaboration.run.review"),
  commandId: CommandId,
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  expectedRevision: NonNegativeInt,
  edits: Schema.Array(WorkspaceOrchestraPlanEdit).check(Schema.isMaxLength(24)),
  approve: Schema.Boolean,
  createdAt: IsoDateTime,
});
const ProjectCollaborationRunVerifyCommand = Schema.Struct({
  type: Schema.Literal("project.collaboration.run.verify"),
  commandId: CommandId,
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  verificationCommands: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).check(
    Schema.isMaxLength(8),
  ),
  createdAt: IsoDateTime,
});

const ProjectCollaborationRunCancelCommand = Schema.Struct({
  type: Schema.Literal("project.collaboration.run.cancel"),
  commandId: CommandId,
  runId: WorkspaceCollaborationRunId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
});

const ProjectScheduleUpsertCommand = Schema.Struct({
  type: Schema.Literal("project.schedule.upsert"),
  commandId: CommandId,
  scheduleId: WorkspaceScheduleId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  enabled: Schema.Boolean,
  timing: WorkspaceScheduleTiming,
  createdAt: IsoDateTime,
});

const ProjectScheduleRemoveCommand = Schema.Struct({
  type: Schema.Literal("project.schedule.remove"),
  commandId: CommandId,
  scheduleId: WorkspaceScheduleId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
});

const ProjectProgramUpsertCommand = Schema.Struct({
  type: Schema.Literal("project.program.upsert"),
  commandId: CommandId,
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  relativeDirectory: WorkspaceProgramRelativeDirectory,
  environmentVariableNames: Schema.Array(TrimmedNonEmptyString),
  startPolicy: WorkspaceProgramStartPolicy,
  healthCheck: Schema.NullOr(WorkspaceProgramHealthCheck),
  errorPatterns: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  enabled: Schema.Boolean,
  integrityEnabled: Schema.optionalKey(Schema.Boolean),
  integrityValidationCommands: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(8_000))),
  ),
  integrityRequiredCleanPasses: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  ),
  /** Omitted (older clients): the program runs with no hub budget or datasets. */
  hubMemory: Schema.optionalKey(
    WorkspaceProgramHubMemory.check(
      Schema.makeFilter(
        (budget) => budget.concurrencyGroup !== null || budget.concurrencySlots === null,
        { message: "Concurrency slots require a group name." },
      ),
      Schema.makeFilter(
        (budget) =>
          new Set(budget.sharedDatasets.map((dataset) => dataset.name)).size ===
          budget.sharedDatasets.length,
        { message: "Shared dataset names must be unique." },
      ),
    ),
  ),
  createdAt: IsoDateTime,
});

const ProjectProgramRemoveCommand = Schema.Struct({
  type: Schema.Literal("project.program.remove"),
  commandId: CommandId,
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  createdAt: IsoDateTime,
});

const ProjectProgramStartCommand = Schema.Struct({
  type: Schema.Literal("project.program.start"),
  commandId: CommandId,
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  monitoringGuard: Schema.optionalKey(WorkspaceMonitoringGuard),
  createdAt: IsoDateTime,
});

const ProjectProgramStopCommand = Schema.Struct({
  type: Schema.Literal("project.program.stop"),
  commandId: CommandId,
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  monitoringGuard: Schema.optionalKey(WorkspaceMonitoringGuard),
  createdAt: IsoDateTime,
});

const ProjectProgramRestartCommand = Schema.Struct({
  type: Schema.Literal("project.program.restart"),
  commandId: CommandId,
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  monitoringGuard: Schema.optionalKey(WorkspaceMonitoringGuard),
  createdAt: IsoDateTime,
});

const ProjectProgramIntegrityStartCommand = Schema.Struct({
  type: Schema.Literal("project.program.integrity.start"),
  commandId: CommandId,
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  createdAt: IsoDateTime,
});

const ProjectProgramIntegrityStopCommand = Schema.Struct({
  type: Schema.Literal("project.program.integrity.stop"),
  commandId: CommandId,
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  createdAt: IsoDateTime,
});

const ProjectIncidentRepairRequestCommand = Schema.Struct({
  type: Schema.Literal("project.program.incident.repair.request"),
  commandId: CommandId,
  projectId: ProjectId,
  incidentId: WorkspaceIncidentId,
  monitoringGuard: Schema.optionalKey(WorkspaceMonitoringGuard),
  instruction: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  createdAt: IsoDateTime,
});

const ProjectIncidentResolveCommand = Schema.Struct({
  type: Schema.Literal("project.program.incident.resolve"),
  commandId: CommandId,
  projectId: ProjectId,
  incidentId: WorkspaceIncidentId,
  createdAt: IsoDateTime,
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  importedConversation: Schema.optionalKey(Schema.suspend(() => ImportedConversation)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  orchestraRunThreadId: OrchestraRunThreadId,
  createdAt: IsoDateTime,
});

const ClientThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});
const ThreadDeleteCommand = Schema.Struct({
  ...ClientThreadDeleteCommand.fields,
  expectedCreationCommandId: Schema.optionalKey(CommandId),
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal("user"),
});

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // The wake time. Event-based wake conditions (PR merged, review posted)
  // will arrive as an optional condition field alongside this; time-based
  // snooze is just the first kind of condition.
  snoozedUntil: IsoDateTime,
});

const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity wakes are decided server-side (the
  // decider emits thread.unsnoozed(reason: "activity") directly), and timer
  // wakes need no event at all — clients derive visibility from snoozedUntil,
  // so a passed wake time simply stops classifying as snoozed.
  reason: Schema.Literal("user"),
});

const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
  // Initial slot in the user-arranged pinned order (see ThreadPinReorderCommand).
  // Optional: clients on pre-reorder servers omit it, and the pinned block
  // falls back to creation order for keyless threads.
  orderKey: Schema.optional(TrimmedNonEmptyString),
});

const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal("thread.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadPinReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.pin.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  // Fractional index key: pinned threads sort by plain string comparison of
  // these keys, so a drag writes one key to one thread — neighbors (possibly
  // on other servers) are never touched. Clients compute a key that sorts
  // between the dropped position's neighbors.
  orderKey: TrimmedNonEmptyString,
});

const ThreadMetaUpdateFields = {
  handoffMode: Schema.optional(ConversationHandoffMode),
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
};
const ClientThreadMetaUpdateCommand = Schema.Struct(ThreadMetaUpdateFields).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);
const ThreadMetaUpdateCommand = Schema.Struct({
  ...ThreadMetaUpdateFields,
  bootstrapCreateClaim: Schema.optionalKey(CommandId),
  bootstrapExpectedBranch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  bootstrapExpectedWorktreePath: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  responseStyle: Schema.optionalKey(ThreadResponseStyle),
  customSubordinateTeam: Schema.optionalKey(Schema.Array(ThreadTeamMember)),
  modelTeams: Schema.optionalKey(Schema.Array(ThreadModelTeam)),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

export const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  /** The server binds these draft teams to the initial accepted turn. */
  customSubordinateTeam: Schema.optionalKey(Schema.Array(ThreadTeamMember)),
  initialModelTeams: Schema.optionalKey(Schema.Array(ThreadModelTeam)),
  initialResponseStyle: Schema.optionalKey(ThreadResponseStyleSeed),
  /** Present only for a turn sent from the desktop assistant window. */
  desktopAssistantCharacter: Schema.optionalKey(ThreadCharacter),
  /** Server-computed identity for safe retry after temporary contention. */
  requestFingerprint: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  bootstrapCreateClaim: Schema.optionalKey(CommandId),
  bootstrapExpectedBranch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  bootstrapExpectedWorktreePath: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  requireTaskConditions: Schema.optional(Schema.Boolean),
  taskConditions: Schema.optional(ApprovedTaskConditions),
  usageContext: Schema.optional(TokenUsageContext),
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  }),
  inputOrigin: Schema.optionalKey(OrchestrationInputOrigin),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  // Legacy internal commands may omit these fields. Keeping absence distinct
  // prevents a decoder default from overriding the thread's selected policy.
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  desktopAssistantCharacter: Schema.optionalKey(ThreadCharacter),
  requireTaskConditions: Schema.optional(Schema.Boolean),
  taskConditions: Schema.optional(ApprovedTaskConditions),
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
      Schema.makeFilter(
        (attachments) =>
          attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0) <=
            PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES ||
          "Attachments exceed the 50 MB combined limit.",
      ),
    ),
  }),
  inputOrigin: Schema.optionalKey(OrchestrationInputOrigin),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  questionRequestId: Schema.optional(ApprovalRequestId),
  /**
   * Stop scope. Absent/false: end the turn and the agent work it spawned,
   * but leave standing background watch loops (Monitor loops, background
   * shells) running — stopping a reply must not stop what the seat is
   * watching for the person. True: stop everything, the banner's 중지.
   */
  stopBackground: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  images: Schema.optionalKey(
    Schema.Array(QuestionImageAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  ),
  createdAt: IsoDateTime,
});

const ClientThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  images: Schema.optionalKey(
    Schema.Array(UploadQuestionImageAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  ),
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectWorkspaceControlUpdateCommand,
  ProjectRuntimeViewCommand,
  ProjectMonitoringPlanApproveCommand,
  ProjectMonitoringReanalyzeCommand,
  ProjectKnowledgeItemUpsertCommand,
  ProjectKnowledgeBulkCommand,
  ProjectKnowledgeSearchSaveCommand,
  ProjectKnowledgeSearchRemoveCommand,
  ProjectKnowledgeItemArchiveCommand,
  ProjectKnowledgeUsageRecordCommand,
  ProjectAgentRoleUpsertCommand,
  ProjectAgentRoleRemoveCommand,
  ProjectCollaborationRunRequestCommand,
  ProjectCollaborationRunControlCommand,
  ProjectCollaborationRunCancelCommand,
  ProjectCollaborationRunAnswerCommand,
  ProjectCollaborationRunReviewCommand,
  ProjectCollaborationRunVerifyCommand,
  ProjectCollaborationRunInterjectCommand,
  ProjectScheduleUpsertCommand,
  ProjectScheduleRemoveCommand,
  ProjectProgramUpsertCommand,
  ProjectProgramRemoveCommand,
  ProjectProgramStartCommand,
  ProjectProgramStopCommand,
  ProjectProgramRestartCommand,
  ProjectProgramIntegrityStartCommand,
  ProjectProgramIntegrityStopCommand,
  ProjectIncidentRepairRequestCommand,
  ProjectIncidentResolveCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectWorkspaceControlUpdateCommand,
  ProjectRuntimeViewCommand,
  ProjectMonitoringPlanApproveCommand,
  ProjectMonitoringReanalyzeCommand,
  ProjectKnowledgeItemUpsertCommand,
  ProjectKnowledgeBulkCommand,
  ProjectKnowledgeSearchSaveCommand,
  ProjectKnowledgeSearchRemoveCommand,
  ProjectKnowledgeItemArchiveCommand,
  ProjectKnowledgeUsageRecordCommand,
  ProjectAgentRoleUpsertCommand,
  ProjectAgentRoleRemoveCommand,
  ClientProjectCollaborationRunRequestCommand,
  ProjectCollaborationRunControlCommand,
  ProjectCollaborationRunCancelCommand,
  ClientProjectCollaborationRunAnswerCommand,
  ProjectCollaborationRunReviewCommand,
  ProjectCollaborationRunVerifyCommand,
  ProjectCollaborationRunInterjectCommand,
  ProjectScheduleUpsertCommand,
  ProjectScheduleRemoveCommand,
  ProjectProgramUpsertCommand,
  ProjectProgramRemoveCommand,
  ProjectProgramStartCommand,
  ProjectProgramStopCommand,
  ProjectProgramRestartCommand,
  ProjectProgramIntegrityStartCommand,
  ProjectProgramIntegrityStopCommand,
  ProjectIncidentRepairRequestCommand,
  ProjectIncidentResolveCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ClientThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ClientThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ClientThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

/** Background-capable foreground turns can start after newer messages have been queued. */
const SessionTurnRequest = Schema.Struct({
  messageId: MessageId,
  requestedAt: IsoDateTime,
});

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  turnRequest: Schema.optional(SessionTurnRequest),
  preservePendingTurnStart: Schema.optional(Schema.Boolean),
  expectedCurrent: Schema.optionalKey(
    Schema.Struct({
      threadUpdatedAt: IsoDateTime,
      sessionUpdatedAt: IsoDateTime,
      status: OrchestrationSessionStatus,
      activeTurnId: Schema.NullOr(TurnId),
    }),
  ),
  createdAt: IsoDateTime,
});

/** Internal startup recovery; not accepted by client command schemas. */
const ThreadBackgroundRecoveryCommand = Schema.Struct({
  type: Schema.Literal("thread.background-recovery.start"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedSessionStatus: OrchestrationSessionStatus,
  expectedSessionUpdatedAt: IsoDateTime,
  expectedThreadUpdatedAt: IsoDateTime,
  activities: Schema.Array(OrchestrationThreadActivity),
  turn: ThreadTurnStartCommand,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageUserAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.message.user.append"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadTitleRegenerationCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  title: Schema.optional(TrimmedNonEmptyString),
});

const ProjectCollaborationRunUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.collaboration.run.update"),
  commandId: CommandId,
  run: WorkspaceCollaborationRun,
});

const ProjectScheduledCollaborationRunRequestCommand = Schema.Struct({
  type: Schema.Literal("project.collaboration.run.schedule"),
  commandId: CommandId,
  runId: WorkspaceCollaborationRunId,
  scheduleId: WorkspaceScheduleId,
  projectId: ProjectId,
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  executionProfile: Schema.optionalKey(WorkspaceExecutionProfile),
  createdAt: IsoDateTime,
});

const ProjectScheduleRuntimeUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.schedule.runtime.update"),
  commandId: CommandId,
  scheduleId: WorkspaceScheduleId,
  projectId: ProjectId,
  nextTriggerAt: Schema.NullOr(IsoDateTime),
  lastTriggeredAt: Schema.NullOr(IsoDateTime),
  lastRunId: Schema.NullOr(WorkspaceCollaborationRunId),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});

const ProjectProgramRunUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.program.run.update"),
  commandId: CommandId,
  run: WorkspaceProgramRun,
});

const ProjectProgramIntegrityUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.program.integrity.update"),
  commandId: CommandId,
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  integrity: WorkspaceProgramIntegrity,
});

const ProjectIncidentUpsertCommand = Schema.Struct({
  type: Schema.Literal("project.program.incident.upsert"),
  commandId: CommandId,
  incident: WorkspaceIncident,
});

const ProjectIncidentCollaborationRunRequestCommand = Schema.Struct({
  type: Schema.Literal("project.collaboration.run.incident"),
  commandId: CommandId,
  runId: WorkspaceCollaborationRunId,
  incidentId: WorkspaceIncidentId,
  projectId: ProjectId,
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  createdAt: IsoDateTime,
});

/** Server-only: the AI's parsed plan lands as "proposed". */
const ProjectMonitoringPlanProposeCommand = Schema.Struct({
  type: Schema.Literal("project.monitoring.plan.propose"),
  commandId: CommandId,
  projectId: ProjectId,
  plan: WorkspaceMonitoringPlan,
  expectedGeneration: Schema.optionalKey(NonNegativeInt),
});

/** Server-only: bookkeeping the reactor writes back (thread, budget log, last check). */
const ProjectMonitoringRuntimeUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.monitoring.runtime.update"),
  commandId: CommandId,
  projectId: ProjectId,
  threadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  turnLog: Schema.optionalKey(Schema.Array(IsoDateTime).check(Schema.isMaxLength(60))),
  lastCheckedAt: Schema.optionalKey(IsoDateTime),
  /** Only "stale" is written here: the program set changed under an approved plan. */
  planStatus: Schema.optionalKey(Schema.Literal("stale")),
});

const InternalOrchestrationCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project.pdf-revision.publish"),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: ThreadId,
    messageId: MessageId,
    attachmentId: TrimmedNonEmptyString,
    version: NonNegativeInt,
    contentHash: TrimmedNonEmptyString,
    createdAt: IsoDateTime,
  }),
  ThreadBackgroundRecoveryCommand,
  ThreadMessageUserAppendCommand,
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
  ThreadTitleRegenerationCompleteCommand,
  ProjectCollaborationRunUpdateCommand,
  ProjectScheduledCollaborationRunRequestCommand,
  ProjectScheduleRuntimeUpdateCommand,
  ProjectProgramRunUpdateCommand,
  ProjectProgramIntegrityUpdateCommand,
  ProjectIncidentUpsertCommand,
  ProjectIncidentCollaborationRunRequestCommand,
  ProjectMonitoringPlanProposeCommand,
  ProjectMonitoringRuntimeUpdateCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  ProjectWorkflowRunCommand,
  ProjectWorkflowSaveCommand,
  ProjectWorkflowDeliveryCommand,
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.workspace-control-updated",
  "project.runtime-viewed",
  "project.knowledge-item-upserted",
  "project.knowledge-search-saved",
  "project.knowledge-search-removed",
  "project.knowledge-item-archived",
  "project.knowledge-usage-recorded",
  "project.agent-role-upserted",
  "project.agent-role-removed",
  "project.collaboration-run-requested",
  "project.collaboration-run-cancel-requested",
  "project.collaboration-run-control-requested",
  "project.workflow-saved",
  "project.workflow-delivery-recorded",
  "project.collaboration-run-upserted",
  "project.collaboration-run-answered",
  "project.collaboration-run-reviewed",
  "project.collaboration-verification-requested",
  "project.collaboration-run-interjected",
  "project.schedule-upserted",
  "project.schedule-removed",
  "project.schedule-runtime-updated",
  "project.program-upserted",
  "project.program-removed",
  "project.program-start-requested",
  "project.program-stop-requested",
  "project.program-restart-requested",
  "project.program-integrity-start-requested",
  "project.program-integrity-stop-requested",
  "project.program-integrity-updated",
  "project.program-run-upserted",
  "project.program-incident-upserted",
  "project.program-incident-repair-requested",
  "project.program-incident-resolve-requested",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  workspaceControl: Schema.optional(WorkspaceControlSettings),
  runtimeViewedThrough: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectWorkspaceControlUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  workspaceControl: WorkspaceControlSettings,
  updatedAt: IsoDateTime,
});

export const ProjectRuntimeViewedPayload = Schema.Struct({
  projectId: ProjectId,
  viewedThrough: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectKnowledgeItemUpsertedPayload = Schema.Struct({
  wikiLinkBindings: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        start: NonNegativeInt,
        targetItemId: Schema.NullOr(WorkspaceKnowledgeItemId),
        needsChoice: Schema.Boolean,
      }),
    ),
  ),
  ...WorkspaceKnowledgeSourceFields,
  supersededBy: Schema.optionalKey(Schema.NullOr(WorkspaceKnowledgeItemId)),
  ...WorkspaceKnowledgeLocationFields,
  research: Schema.optionalKey(Schema.NullOr(WorkspaceResearchRecord)),
  projectId: ProjectId,
  itemId: WorkspaceKnowledgeItemId,
  kind: WorkspaceKnowledgeKind,
  title: TrimmedNonEmptyString,
  content: Schema.String,
  status: WorkspaceKnowledgeStatus,
  origin: WorkspaceKnowledgeOrigin,
  relativeFolder: Schema.NullOr(WorkspaceKnowledgeRelativeFolder),
  tags: Schema.Array(TrimmedNonEmptyString),
  originalChars: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  storedChars: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  updatedAt: IsoDateTime,
});

export const ProjectKnowledgeItemArchivedPayload = Schema.Struct({
  projectId: ProjectId,
  itemId: WorkspaceKnowledgeItemId,
  archivedAt: IsoDateTime,
});

export const ProjectKnowledgeUsageRecordedPayload = Schema.Struct({
  projectId: ProjectId,
  itemIds: Schema.Array(WorkspaceKnowledgeItemId),
  usedAt: IsoDateTime,
});

export const ProjectAgentRoleUpsertedPayload = WorkspaceAgentRoleBinding;

export const ProjectAgentRoleRemovedPayload = Schema.Struct({
  projectId: ProjectId,
  role: WorkspaceAgentRole,
  removedAt: IsoDateTime,
});

export const ProjectCollaborationRunRequestedPayload = Schema.Struct({
  run: WorkspaceCollaborationRun,
  /**
   * Carried on the event rather than on the run: it decides what happens at the moment the
   * run starts and is not part of the run's own state. Older events decode as false so a
   * replay never cancels a schedule after the fact.
   */
  preempt: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});

export const ProjectCollaborationRunCancelRequestedPayload = Schema.Struct({
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  cancelledAt: IsoDateTime,
});

export const ProjectCollaborationRunUpsertedPayload = Schema.Struct({
  run: WorkspaceCollaborationRun,
});

export const ProjectCollaborationRunAnsweredPayload = Schema.Struct({
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  // Absent on persisted events from clients predating question identity.
  questionRef: Schema.optionalKey(WorkspaceMeetingQuestionRef),
  answer: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  imageReferences: Schema.optionalKey(Schema.Array(WorkspaceQuestionImageReference)),
  answeredAt: IsoDateTime,
});

export const ProjectCollaborationRunInterjectedPayload = Schema.Struct({
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  interjectedAt: IsoDateTime,
});

export const ProjectScheduleUpsertedPayload = Schema.Struct({
  scheduleId: WorkspaceScheduleId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  enabled: Schema.Boolean,
  timing: WorkspaceScheduleTiming,
  updatedAt: IsoDateTime,
});
export type ProjectScheduleUpsertedPayload = typeof ProjectScheduleUpsertedPayload.Type;

export const ProjectScheduleRemovedPayload = Schema.Struct({
  scheduleId: WorkspaceScheduleId,
  projectId: ProjectId,
  removedAt: IsoDateTime,
});

export const ProjectScheduleRuntimeUpdatedPayload = Schema.Struct({
  scheduleId: WorkspaceScheduleId,
  projectId: ProjectId,
  nextTriggerAt: Schema.NullOr(IsoDateTime),
  lastTriggeredAt: Schema.NullOr(IsoDateTime),
  lastRunId: Schema.NullOr(WorkspaceCollaborationRunId),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type ProjectScheduleRuntimeUpdatedPayload = typeof ProjectScheduleRuntimeUpdatedPayload.Type;

export const ProjectProgramUpsertedPayload = Schema.Struct({
  program: WorkspaceProgram,
});
export type ProjectProgramUpsertedPayload = typeof ProjectProgramUpsertedPayload.Type;

export const ProjectProgramRemovedPayload = Schema.Struct({
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  removedAt: IsoDateTime,
});

export const ProjectProgramActionRequestedPayload = Schema.Struct({
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  requestedAt: IsoDateTime,
});
export type ProjectProgramActionRequestedPayload = typeof ProjectProgramActionRequestedPayload.Type;

export const ProjectProgramIntegrityUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  integrity: WorkspaceProgramIntegrity,
});
export type ProjectProgramIntegrityUpdatedPayload =
  typeof ProjectProgramIntegrityUpdatedPayload.Type;

export const ProjectProgramRunUpsertedPayload = Schema.Struct({
  run: WorkspaceProgramRun,
});
export type ProjectProgramRunUpsertedPayload = typeof ProjectProgramRunUpsertedPayload.Type;

export const ProjectProgramIncidentUpsertedPayload = Schema.Struct({
  incident: WorkspaceIncident,
});
export type ProjectProgramIncidentUpsertedPayload =
  typeof ProjectProgramIncidentUpsertedPayload.Type;

export const ProjectProgramIncidentRepairRequestedPayload = Schema.Struct({
  projectId: ProjectId,
  incidentId: WorkspaceIncidentId,
  instruction: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  requestedAt: IsoDateTime,
});
export type ProjectProgramIncidentRepairRequestedPayload =
  typeof ProjectProgramIncidentRepairRequestedPayload.Type;

export const ProjectProgramIncidentResolveRequestedPayload = Schema.Struct({
  projectId: ProjectId,
  incidentId: WorkspaceIncidentId,
  requestedAt: IsoDateTime,
});
export type ProjectProgramIncidentResolveRequestedPayload =
  typeof ProjectProgramIncidentResolveRequestedPayload.Type;

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  importedConversation: Schema.optionalKey(Schema.suspend(() => ImportedConversation)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  orchestraRunThreadId: OrchestraRunThreadId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  // user: explicit "wake now". activity: real work arrived (user message /
  // session coming alive) and the decider cleared the snooze — mirrors
  // thread.unsettled's activity resets. Timer wakes emit no event: clients
  // derive them from snoozedUntil passing.
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
  // Absent on re-pins of an already-pinned thread (the existing key wins)
  // and on pins from clients that predate reordering.
  pinOrderKey: Schema.optional(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadUnpinnedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadPinReorderedPayload = Schema.Struct({
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  handoffMode: Schema.optional(ConversationHandoffMode),
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  /** Intent marker consumed by the title-generation reactor. Keeping this on
      the existing event lets older clients safely ignore the new field. */
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  /** Title at request time, used to avoid overwriting a later manual rename. */
  previousTitle: Schema.optional(TrimmedNonEmptyString),
  /** Pending state shared with clients. Null clears a matching request. */
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  inputOrigin: Schema.optionalKey(OrchestrationInputOrigin),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  customSubordinateTeam: Schema.optionalKey(Schema.Array(ThreadTeamMember)),
  initialModelTeams: Schema.optionalKey(Schema.Array(ThreadModelTeam)),
  initialResponseStyle: Schema.optionalKey(ThreadResponseStyleSeed),
  desktopAssistantCharacter: Schema.optionalKey(ThreadCharacter),
  usageContext: Schema.optional(TokenUsageContext),
  threadId: ThreadId,
  messageId: MessageId,
  inputOrigin: Schema.optionalKey(OrchestrationInputOrigin),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  questionRequestId: Schema.optional(ApprovalRequestId),
  stopBackground: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  images: Schema.optionalKey(
    Schema.Array(QuestionImageAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  ),
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
  turnRequest: Schema.optional(SessionTurnRequest),
  preservePendingTurnStart: Schema.optional(Schema.Boolean),
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.workflow-saved"),
    payload: Schema.Struct({
      projectId: ProjectId,
      definition: WorkflowVersion,
      expectedRevision: NonNegativeInt,
    }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.workflow-delivery-recorded"),
    payload: Schema.Struct({
      projectId: ProjectId,
      runId: WorkspaceCollaborationRunId,
      nodeId: Schema.String,
      executionId: Schema.String,
      phase: Schema.Literals(["submitting", "accepted", "stopped"]),
      confirmed: Schema.Boolean,
      createdAt: IsoDateTime,
    }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.workspace-control-updated"),
    payload: ProjectWorkspaceControlUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.runtime-viewed"),
    payload: ProjectRuntimeViewedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.knowledge-item-upserted"),
    payload: ProjectKnowledgeItemUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.knowledge-search-saved"),
    payload: Schema.Struct({ projectId: ProjectId, ...savedSearchFields, updatedAt: IsoDateTime }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.knowledge-search-removed"),
    payload: Schema.Struct({ projectId: ProjectId, id: TrimmedNonEmptyString }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.knowledge-item-archived"),
    payload: ProjectKnowledgeItemArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.knowledge-usage-recorded"),
    payload: ProjectKnowledgeUsageRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.agent-role-upserted"),
    payload: ProjectAgentRoleUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.agent-role-removed"),
    payload: ProjectAgentRoleRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.collaboration-run-requested"),
    payload: ProjectCollaborationRunRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.collaboration-run-cancel-requested"),
    payload: ProjectCollaborationRunCancelRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.collaboration-run-control-requested"),
    payload: Schema.Struct({
      projectId: ProjectId,
      runId: WorkspaceCollaborationRunId,
      expectedRevision: NonNegativeInt,
      action: Schema.Literals(["pause", "resume", "cancel", "retry"]),
      nodeId: Schema.optionalKey(Schema.String),
      createdAt: IsoDateTime,
    }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.collaboration-run-upserted"),
    payload: ProjectCollaborationRunUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.collaboration-run-answered"),
    payload: ProjectCollaborationRunAnsweredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.collaboration-run-reviewed"),
    payload: Schema.Struct({
      projectId: ProjectId,
      runId: WorkspaceCollaborationRunId,
      expectedRevision: NonNegativeInt,
      edits: Schema.Array(WorkspaceOrchestraPlanEdit),
      approve: Schema.Boolean,
      reviewedAt: IsoDateTime,
    }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.collaboration-verification-requested"),
    payload: Schema.Struct({
      projectId: ProjectId,
      runId: WorkspaceCollaborationRunId,
      verificationCommands: Schema.Array(Schema.String),
      requestedAt: IsoDateTime,
    }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.collaboration-run-interjected"),
    payload: ProjectCollaborationRunInterjectedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.schedule-upserted"),
    payload: ProjectScheduleUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.schedule-removed"),
    payload: ProjectScheduleRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.schedule-runtime-updated"),
    payload: ProjectScheduleRuntimeUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-upserted"),
    payload: ProjectProgramUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-removed"),
    payload: ProjectProgramRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-start-requested"),
    payload: ProjectProgramActionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-stop-requested"),
    payload: ProjectProgramActionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-restart-requested"),
    payload: ProjectProgramActionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-integrity-start-requested"),
    payload: ProjectProgramActionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-integrity-stop-requested"),
    payload: ProjectProgramActionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-integrity-updated"),
    payload: ProjectProgramIntegrityUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-run-upserted"),
    payload: ProjectProgramRunUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-incident-upserted"),
    payload: ProjectProgramIncidentUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-incident-repair-requested"),
    payload: ProjectProgramIncidentRepairRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.program-incident-resolve-requested"),
    payload: ProjectProgramIncidentResolveRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pin-reordered"),
    payload: ThreadPinReorderedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue({
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export const OrchestrationGetWorkflowScriptInput = Schema.Struct({
  threadId: ThreadId,
  /** Absolute path from the workflow's runHandles.scriptPath. The server
   * re-derives containment; the client value is a hint, never trusted. */
  scriptPath: TrimmedNonEmptyString,
});
export type OrchestrationGetWorkflowScriptInput = typeof OrchestrationGetWorkflowScriptInput.Type;

export const OrchestrationGetWorkflowScriptResult = Schema.Struct({
  scriptPath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type OrchestrationGetWorkflowScriptResult = typeof OrchestrationGetWorkflowScriptResult.Type;

const WORKFLOW_SCRIPT_ERROR_MESSAGES = {
  "invalid-path": "Workflow scripts must be absolute .js paths.",
  "root-unavailable": "Script root unavailable.",
  "not-found": "Script not found.",
  "outside-root": "Script path is outside the workflow scripts root.",
  "not-js": "Resolved script is not a .js file.",
  "not-regular-file": "Script is not a regular file.",
  "changed-during-read": "Script changed between resolution and open.",
  "read-failed": "Script read failed.",
} as const;

export class OrchestrationGetWorkflowScriptError extends Schema.TaggedErrorClass<OrchestrationGetWorkflowScriptError>()(
  "OrchestrationGetWorkflowScriptError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "not-js",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    scriptPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_SCRIPT_ERROR_MESSAGES[this.reason];
  }
}

export const WorkspaceWorktreeCleanupInput = Schema.Struct({
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  /** The worktree to clean, spelled exactly as stored on the run's graph nodes. */
  worktreePath: TrimmedNonEmptyString,
  /** Remove even when the worktree still differs from its base branch. */
  force: Schema.optionalKey(Schema.Boolean),
});
export type WorkspaceWorktreeCleanupInput = typeof WorkspaceWorktreeCleanupInput.Type;

export const WorkspaceWorktreeCleanupResult = Schema.Struct({
  /**
   * `kept-dirty` means the worktree still holds unmerged work, so it was left
   * in place for review instead of being deleted — not an error.
   */
  status: Schema.Literals(["removed", "kept-dirty"]),
  detail: Schema.NullOr(Schema.String),
});
export type WorkspaceWorktreeCleanupResult = typeof WorkspaceWorktreeCleanupResult.Type;

export class OrchestrationWorktreeCleanupError extends Schema.TaggedErrorClass<OrchestrationWorktreeCleanupError>()(
  "OrchestrationWorktreeCleanupError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const SharedLibrarySourceStatus = Schema.Struct({
  source: TrimmedNonEmptyString,
  origin: TrimmedNonEmptyString,
  libraryId: TrimmedNonEmptyString,
  /** Highest source reference stored. */
  maxRef: NonNegativeInt,
  /** Where an unfinished first scan resumes. */
  scanCursor: NonNegativeInt,
  fullScanCompletedAt: Schema.NullOr(IsoDateTime),
  lastSyncAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
});
export type SharedLibrarySourceStatus = typeof SharedLibrarySourceStatus.Type;

export const SharedLibraryStatus = Schema.Struct({
  libraries: Schema.Array(
    Schema.Struct({
      libraryId: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
      itemCount: NonNegativeInt,
    }),
  ),
  sources: Schema.Array(SharedLibrarySourceStatus),
});
export type SharedLibraryStatus = typeof SharedLibraryStatus.Type;

export const SharedLibrarySyncResult = Schema.Struct({
  /** False when a sync was already running — the status shows its progress. */
  started: Schema.Boolean,
  status: SharedLibraryStatus,
});
export type SharedLibrarySyncResult = typeof SharedLibrarySyncResult.Type;

export class OrchestrationSharedLibraryError extends Schema.TaggedErrorClass<OrchestrationSharedLibraryError>()(
  "OrchestrationSharedLibraryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const OrchestrationRpcSchemas = {
  checkTurnReceipt: {
    input: Schema.Struct({
      commandId: CommandId,
      threadId: ThreadId,
      requestFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
    output: Schema.Struct({
      status: Schema.Literals(["accepted", "unconfirmed", "mismatch", "rejected"]),
      safeBootstrapReplay: Schema.optional(Schema.Boolean),
      safeBootstrapResume: Schema.optional(Schema.Boolean),
      safeWorktreeBootstrapResume: Schema.optional(Schema.Boolean),
    }),
  },
  getThreadTokenUsage: {
    input: GetThreadTokenUsageInput,
    output: ThreadTokenUsageReport,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getWorkflowScript: {
    input: OrchestrationGetWorkflowScriptInput,
    output: OrchestrationGetWorkflowScriptResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  searchThreads: {
    input: OrchestrationSearchThreadsInput,
    output: OrchestrationSearchThreadsResult,
  },
  getWorkspaceKnowledgeDashboard: {
    input: WorkspaceKnowledgeDashboardInput,
    output: WorkspaceKnowledgeDashboard,
  },
  getPdfRevisionStatus: { input: Schema.Struct(KnowledgeDocumentKey), output: PdfRevisionStatus },
  startPdfRevision: {
    input: Schema.Struct({
      ...KnowledgeDocumentKey,
      expectedVersion: PositiveInt,
      requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      file: Schema.Struct({
        ...UploadChatFileAttachment.fields,
        mimeType: Schema.Literal("application/pdf"),
      }),
    }),
    output: PdfRevisionStatus,
  },
  retryPdfRevision: { input: Schema.Struct(KnowledgeDocumentKey), output: PdfRevisionStatus },
  readPdfRevisionSource: {
    input: Schema.Struct({ ...KnowledgeDocumentKey, version: PositiveInt }),
    output: Schema.Struct({ dataUrl: Schema.String }),
  },
  editWorkspaceKnowledge: {
    input: WorkspaceKnowledgeEditInput,
    output: KnowledgeDocumentWriteResult,
  },
  restoreWorkspaceKnowledge: {
    input: Schema.Struct({ ...KnowledgeDocumentKey, commandId: CommandId }),
    output: KnowledgeDocumentWriteResult,
  },
  listWorkspaceKnowledgeRevisions: {
    input: Schema.Struct({
      ...KnowledgeDocumentKey,
      beforeSequence: Schema.optionalKey(PositiveInt),
      limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
    }),
    output: Schema.Struct({
      revisions: Schema.Array(Schema.Struct(KnowledgeRevisionKey)),
      nextBeforeSequence: Schema.NullOr(PositiveInt),
    }),
  },
  getWorkspaceKnowledgeRevision: {
    input: Schema.Struct({ ...KnowledgeDocumentKey, sequence: PositiveInt }),
    output: Schema.Struct({
      revision: Schema.NullOr(
        Schema.Struct({
          ...KnowledgeRevisionKey,
          title: Schema.NullOr(Schema.String),
          content: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  },
  listWorkspaceKnowledge: {
    input: WorkspaceKnowledgeListInput,
    output: WorkspaceKnowledgeListResult,
  },
  getWorkspaceWikiLinks: {
    input: WorkspaceWikiLinksInput,
    output: WorkspaceWikiLinksResult,
  },
  searchWorkspaceRag: {
    input: WorkspaceRagSearchInput,
    output: WorkspaceRagSearchResult,
  },
  composeWorkspacePrompt: {
    input: WorkspacePromptComposeInput,
    output: WorkspacePromptComposeResult,
  },
  listWorkspaceAgentRoles: {
    input: WorkspaceAgentRoleListInput,
    output: WorkspaceAgentRoleListResult,
  },
  listWorkspaceCollaborationRuns: {
    input: WorkspaceCollaborationRunListInput,
    output: WorkspaceCollaborationRunListResult,
  },
  listWorkspaceSchedules: {
    input: WorkspaceScheduleListInput,
    output: WorkspaceScheduleListResult,
  },
  getWorkspaceRuntime: {
    input: WorkspaceRuntimeSnapshotInput,
    output: WorkspaceRuntimeSnapshot,
  },
  subscribeWorkspaceRuntime: {
    input: WorkspaceRuntimeSnapshotInput,
    output: WorkspaceRuntimeSnapshot,
  },
  discoverWorkspacePrograms: {
    input: WorkspaceProgramListInput,
    output: WorkspaceProgramDiscoveryResult,
  },
  listWorkspacePrograms: {
    input: WorkspaceProgramListInput,
    output: WorkspaceProgramListResult,
  },
  listWorkspaceProgramRuns: {
    input: WorkspaceProgramRunListInput,
    output: WorkspaceProgramRunListResult,
  },
  listWorkspaceIncidents: {
    input: WorkspaceIncidentListInput,
    output: WorkspaceIncidentListResult,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationShellSnapshot,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: OrchestrationShellStreamItem,
  },
  cleanupWorkspaceWorktree: {
    input: WorkspaceWorktreeCleanupInput,
    output: WorkspaceWorktreeCleanupResult,
  },
  getSharedLibraryStatus: {
    input: Schema.Struct({}),
    output: SharedLibraryStatus,
  },
  syncSharedLibrary: {
    input: Schema.Struct({}),
    output: SharedLibrarySyncResult,
  },
} as const;

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationWorkspaceKnowledgeError extends Schema.TaggedErrorClass<OrchestrationWorkspaceKnowledgeError>()(
  "OrchestrationWorkspaceKnowledgeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationWorkspaceAgentRolesError extends Schema.TaggedErrorClass<OrchestrationWorkspaceAgentRolesError>()(
  "OrchestrationWorkspaceAgentRolesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationWorkspaceCollaborationError extends Schema.TaggedErrorClass<OrchestrationWorkspaceCollaborationError>()(
  "OrchestrationWorkspaceCollaborationError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationWorkspaceScheduleError extends Schema.TaggedErrorClass<OrchestrationWorkspaceScheduleError>()(
  "OrchestrationWorkspaceScheduleError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationWorkspaceProgramError extends Schema.TaggedErrorClass<OrchestrationWorkspaceProgramError>()(
  "OrchestrationWorkspaceProgramError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationWorkspaceRuntimeError extends Schema.TaggedErrorClass<OrchestrationWorkspaceRuntimeError>()(
  "OrchestrationWorkspaceRuntimeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    reason: Schema.optionalKey(
      Schema.Literals([
        "active-turn-settings",
        "turn-request-id-conflict",
        "bootstrap-precommit-rejected",
        "bootstrap-state-unknown",
      ]),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationSearchThreadsError extends Schema.TaggedErrorClass<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
