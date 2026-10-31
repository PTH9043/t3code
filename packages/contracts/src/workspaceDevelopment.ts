import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection, RuntimeMode, ProviderInteractionMode } from "./orchestration.ts";
import { TokenUsageSummary } from "./tokenUsage.ts";

const Revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const TokenBudget = Schema.NullOr(
  Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
);
export const DevelopmentUsage = Schema.Struct({
  goal: Schema.NullOr(TokenUsageSummary),
  daily: Schema.NullOr(TokenUsageSummary),
  dailySince: IsoDateTime,
});
export type DevelopmentUsage = typeof DevelopmentUsage.Type;
export const DevelopmentWorkspaceId = TrimmedNonEmptyString.pipe(
  Schema.brand("DevelopmentWorkspaceId"),
);
export type DevelopmentWorkspaceId = typeof DevelopmentWorkspaceId.Type;
export const DevelopmentBindingId = TrimmedNonEmptyString.pipe(
  Schema.brand("DevelopmentBindingId"),
);
export type DevelopmentBindingId = typeof DevelopmentBindingId.Type;

export const DevelopmentVerificationCommand = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
});
export type DevelopmentVerificationCommand = typeof DevelopmentVerificationCommand.Type;

export const WORKSPACE_EVIDENCE_MAX_FILES = 8;
export const WORKSPACE_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_EVIDENCE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const DevelopmentArtifactMediaType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/html",
  "text/plain",
]);
export type DevelopmentArtifactMediaType = typeof DevelopmentArtifactMediaType.Type;
export const DevelopmentVerificationArtifact = Schema.Struct({
  relativePath: Schema.String,
  label: Schema.String,
  mediaType: Schema.NullOr(DevelopmentArtifactMediaType),
  snapshotPath: Schema.NullOr(Schema.String),
  byteLength: Schema.NullOr(Revision),
  sha256: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type DevelopmentVerificationArtifact = typeof DevelopmentVerificationArtifact.Type;
const EvidencePaths = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).check(
  Schema.isMaxLength(WORKSPACE_EVIDENCE_MAX_FILES),
);

export const WorkspaceDevelopmentConfigure = Schema.Struct({
  projectId: ProjectId,
  conversationId: ThreadId,
  commandId: CommandId,
  enabled: Schema.Boolean,
  mainModel: ModelSelection,
  ownerModels: Schema.Array(ModelSelection).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  runtimeMode: RuntimeMode,
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  maxParallelOwners: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 3 }),
  ),
  verificationCommands: Schema.Array(DevelopmentVerificationCommand).check(Schema.isMaxLength(8)),
  maxDailyTokens: Schema.optional(TokenBudget),
});
export type WorkspaceDevelopmentConfigure = typeof WorkspaceDevelopmentConfigure.Type;

export const WorkspaceDevelopmentDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projectId: ProjectId,
  policyRevision: Revision,
  ownerModels: WorkspaceDevelopmentConfigure.fields.ownerModels,
  maxParallelOwners: WorkspaceDevelopmentConfigure.fields.maxParallelOwners,
  verificationCommands: WorkspaceDevelopmentConfigure.fields.verificationCommands,
  maxDailyTokens: WorkspaceDevelopmentConfigure.fields.maxDailyTokens,
});

export const DevelopmentSessionBinding = Schema.Struct({
  id: DevelopmentBindingId,
  workspaceId: Schema.NullOr(DevelopmentWorkspaceId),
  role: Schema.Literals(["main", "architect", "owner"]),
  sessionKey: ThreadId,
  nativeSessionId: Schema.NullOr(Schema.String),
  model: ModelSelection,
  cwd: Schema.String,
  profileRevision: Revision,
  runtimeIdentity: Schema.String,
  runGeneration: Revision,
  predecessorId: Schema.NullOr(DevelopmentBindingId),
});
export type DevelopmentSessionBinding = typeof DevelopmentSessionBinding.Type;

export const DevelopmentWorkspace = Schema.Struct({
  id: DevelopmentWorkspaceId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  scope: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  bindingId: DevelopmentBindingId,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.String,
  baseSha: Schema.String,
  observedFingerprint: Schema.String,
  generation: Revision,
  definitionRevision: Revision,
  stateRevision: Revision,
  requirementRevision: Revision,
  control: Schema.Literals(["managed", "human", "reconciling"]),
  takeover: Schema.Boolean,
  externalUnmanaged: Schema.Boolean,
  summaryPending: Schema.Boolean,
  status: Schema.Literals(["provisioning", "ready", "failed", "retired"]),
  error: Schema.NullOr(Schema.String),
  lastSummary: Schema.String,
});
export type DevelopmentWorkspace = typeof DevelopmentWorkspace.Type;
export const DevelopmentRecoveryStrategy = Schema.Literals([
  "retry-after-check",
  "repair-and-verify",
  "diagnose-environment",
  "clarify-requirement",
]);
export const DevelopmentFailureRecovery = Schema.Struct({
  kind: Schema.Literals([
    "transient",
    "environment",
    "verification",
    "requirement",
    "cancelled",
    "delivery-unknown",
    "unknown",
  ]),
  strategy: DevelopmentRecoveryStrategy,
  instruction: Schema.String,
  retryAllowed: Schema.Boolean,
});

export const DevelopmentTask = Schema.Struct({
  id: Schema.String,
  goalId: Schema.optional(Schema.NullOr(Schema.String)),
  commandId: CommandId,
  workspaceId: DevelopmentWorkspaceId,
  bindingId: DevelopmentBindingId,
  source: Schema.Literals(["main-dispatch", "user-direct", "architect"]),
  objective: Schema.String,
  acceptanceCriteria: Schema.Array(Schema.String),
  requirementRevision: Revision,
  mode: Schema.Literals(["followup", "queue", "replace", "takeover"]),
  status: Schema.Literals([
    "queued",
    "running",
    "completed",
    "failed",
    "superseded",
    "delivery_unknown",
  ]),
  runId: Schema.String,
  fencingGeneration: Revision,
  delivery: Schema.Literals(["pending", "submitting", "accepted", "delivery_unknown"]),
  nativeTurnId: Schema.NullOr(Schema.String),
  nativeMessageIds: Schema.Array(Schema.String),
  messageId: Schema.String,
  baseSha: Schema.String,
  candidateSha: Schema.NullOr(Schema.String),
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
  requestedAt: IsoDateTime,
  failureFingerprint: Schema.optional(Schema.String),
  failureCodeFingerprint: Schema.optional(Schema.String),
  failureRecovery: Schema.optional(DevelopmentFailureRecovery),
  recoveryStrategy: Schema.optional(DevelopmentRecoveryStrategy),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type DevelopmentTask = typeof DevelopmentTask.Type;

export const DevelopmentVerification = Schema.Struct({
  id: Schema.String,
  workspaceId: DevelopmentWorkspaceId,
  candidateSha: Schema.String,
  requirementRevision: Revision,
  generation: Revision,
  targetSha: Schema.String,
  commands: Schema.Array(
    Schema.Struct({
      ...DevelopmentVerificationCommand.fields,
      exitCode: Schema.NullOr(Schema.Number),
      timedOut: Schema.Boolean,
      logPath: Schema.String,
    }),
  ),
  status: Schema.Literals(["passed", "failed", "stale"]),
  verifiedAt: IsoDateTime,
  artifacts: Schema.optional(
    Schema.Array(DevelopmentVerificationArtifact).check(
      Schema.isMaxLength(WORKSPACE_EVIDENCE_MAX_FILES),
    ),
  ),
});
export type DevelopmentVerification = typeof DevelopmentVerification.Type;

export const DevelopmentIntegration = Schema.Struct({
  id: Schema.String,
  verificationIds: Schema.Array(Schema.String),
  candidates: Schema.Array(Schema.String),
  expectedTargetSha: Schema.String,
  resultSha: Schema.NullOr(Schema.String),
  status: Schema.Literals(["verifying", "failed", "stale", "release-ready"]),
  error: Schema.NullOr(Schema.String),
  logPaths: Schema.Array(Schema.String),
  artifacts: DevelopmentVerification.fields.artifacts,
});
export type DevelopmentIntegration = typeof DevelopmentIntegration.Type;

export const DevelopmentGoal = Schema.Struct({
  id: Schema.String,
  revision: Revision,
  objective: TrimmedNonEmptyString,
  acceptanceCriteria: Schema.Array(TrimmedNonEmptyString),
  status: Schema.Literals(["active", "paused", "blocked", "limited", "complete", "cancelled"]),
  phase: Schema.Literals(["ready", "running", "waiting"]),
  steps: Revision,
  maxSteps: Revision,
  maxMinutes: Revision,
  maxTokens: Schema.optional(TokenBudget),
  activeMilliseconds: Schema.Number,
  activatedAt: Schema.NullOr(IsoDateTime),
  pendingMessageId: Schema.NullOr(Schema.String),
  runSeen: Schema.Boolean,
  progressReported: Schema.Boolean,
  progressFingerprint: Schema.String,
  noProgressSteps: Revision,
  lastSummary: Schema.String,
  integrationId: Schema.NullOr(Schema.String),
  initialIntegrationIds: Schema.Array(Schema.String),
  startedAt: IsoDateTime,
  lastResumedAt: Schema.optional(IsoDateTime),
});
export type DevelopmentGoal = typeof DevelopmentGoal.Type;

export const WorkspaceDevelopmentGoalInput = Schema.Struct({
  projectId: ProjectId,
  conversationId: ThreadId,
  commandId: CommandId,
  action: Schema.Literals(["start", "pause", "resume", "cancel"]),
  expectedGoalRevision: Schema.optional(Revision),
  objective: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(20_000))),
  acceptanceCriteria: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(30)),
  ),
  maxSteps: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 })),
  ),
  maxMinutes: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 480 })),
  ),
  maxTokens: Schema.optional(TokenBudget),
});
export type WorkspaceDevelopmentGoalInput = typeof WorkspaceDevelopmentGoalInput.Type;

export const DevelopmentArchitectReview = Schema.Struct({
  commandId: CommandId,
  bindingId: DevelopmentBindingId,
  runGeneration: Revision,
  output: Schema.String,
  completedAt: IsoDateTime,
});
export type DevelopmentArchitectReview = typeof DevelopmentArchitectReview.Type;

export const WorkspaceDevelopmentState = Schema.Struct({
  projectId: ProjectId,
  conversationId: ThreadId,
  enabled: Schema.Boolean,
  policyRevision: Revision,
  revision: Revision,
  mainObservedRevision: Revision,
  mainActedRevision: Revision,
  pendingMainNotification: Schema.Boolean,
  ownerModels: Schema.Array(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  maxParallelOwners: Schema.Number,
  verificationCommands: Schema.Array(DevelopmentVerificationCommand),
  maxDailyTokens: Schema.optional(TokenBudget),
  usage: Schema.optional(DevelopmentUsage),
  bindings: Schema.Array(DevelopmentSessionBinding),
  workspaces: Schema.Array(DevelopmentWorkspace),
  tasks: Schema.Array(DevelopmentTask),
  verifications: Schema.Array(DevelopmentVerification),
  integrations: Schema.Array(DevelopmentIntegration),
  goal: Schema.optional(Schema.NullOr(DevelopmentGoal)),
  architectReview: Schema.optional(Schema.NullOr(DevelopmentArchitectReview)),
});
export type WorkspaceDevelopmentState = typeof WorkspaceDevelopmentState.Type;

const { output: _taskOutput, ...taskSummaryFields } = DevelopmentTask.fields;
export const WorkspaceDevelopmentToolSummary = Schema.Struct({
  usage: Schema.optional(Schema.NullOr(DevelopmentUsage)),
  maxDailyTokens: Schema.optional(TokenBudget),
  revision: Revision,
  policyRevision: Revision,
  goal: Schema.NullOr(DevelopmentGoal),
  architectReview: Schema.optional(Schema.NullOr(DevelopmentArchitectReview)),
  mainObservedRevision: Revision,
  mainActedRevision: Revision,
  ownerModels: Schema.Array(ModelSelection),
  workspaces: Schema.Array(DevelopmentWorkspace),
  bindings: Schema.Array(
    Schema.Struct({
      id: DevelopmentSessionBinding.fields.id,
      workspaceId: DevelopmentSessionBinding.fields.workspaceId,
      role: DevelopmentSessionBinding.fields.role,
      nativeSessionId: DevelopmentSessionBinding.fields.nativeSessionId,
      model: DevelopmentSessionBinding.fields.model,
      cwd: DevelopmentSessionBinding.fields.cwd,
    }),
  ),
  tasks: Schema.Array(
    Schema.Struct({
      ...taskSummaryFields,
      summary: Schema.String.check(Schema.isMaxLength(1_500)),
    }),
  ).check(Schema.isMaxLength(30)),
  verifications: Schema.Array(DevelopmentVerification).check(Schema.isMaxLength(15)),
  integrations: Schema.Array(DevelopmentIntegration).check(Schema.isMaxLength(10)),
});
export type WorkspaceDevelopmentToolSummary = typeof WorkspaceDevelopmentToolSummary.Type;

export const WorkspaceDevelopmentLookup = Schema.Struct({ projectId: ProjectId });
export const WorkspaceDevelopmentSnapshot = Schema.Struct({
  state: Schema.NullOr(WorkspaceDevelopmentState),
});
export const WorkspaceDevelopmentDirectInput = Schema.Struct({
  projectId: ProjectId,
  conversationId: ThreadId,
  workspaceId: DevelopmentWorkspaceId,
  commandId: CommandId,
  expectedRevision: Revision,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  mode: Schema.Literals(["followup", "queue", "replace", "takeover"]),
  requirementChange: Schema.Boolean,
});
export type WorkspaceDevelopmentDirectInput = typeof WorkspaceDevelopmentDirectInput.Type;
export const WorkspaceDevelopmentReturnControl = Schema.Struct({
  projectId: ProjectId,
  workspaceId: DevelopmentWorkspaceId,
  commandId: CommandId,
  expectedRevision: Revision,
});
export type WorkspaceDevelopmentReturnControl = typeof WorkspaceDevelopmentReturnControl.Type;

export class WorkspaceDevelopmentError extends Schema.TaggedErrorClass<WorkspaceDevelopmentError>()(
  "WorkspaceDevelopmentError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const WORKSPACE_DEVELOPMENT_WS_METHODS = {
  get: "workspaceDevelopment.get",
  subscribe: "workspaceDevelopment.subscribe",
  configure: "workspaceDevelopment.configure",
  directInput: "workspaceDevelopment.directInput",
  returnControl: "workspaceDevelopment.returnControl",
  goal: "workspaceDevelopment.goal",
} as const;

export const WorkspaceDevelopmentAction = Schema.Struct({
  recoveryStrategy: Schema.optional(DevelopmentRecoveryStrategy),
  action: Schema.Literals([
    "status",
    "create",
    "dispatch",
    "reconcile",
    "verify",
    "integrate",
    "architect",
    "goal-progress",
  ]),
  commandId: CommandId,
  workspaceId: Schema.optional(DevelopmentWorkspaceId),
  name: Schema.optional(TrimmedNonEmptyString),
  scope: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  modelIndex: Schema.optional(Revision),
  objective: Schema.optional(TrimmedNonEmptyString),
  acceptanceCriteria: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  expectedRevision: Schema.optional(Revision),
  candidateSha: Schema.optional(TrimmedNonEmptyString),
  evidencePaths: Schema.optional(EvidencePaths),
  verificationIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  goalId: Schema.optional(TrimmedNonEmptyString),
  expectedGoalRevision: Schema.optional(Revision),
  outcome: Schema.optional(Schema.Literals(["continue", "wait", "blocked", "complete"])),
  integrationId: Schema.optional(TrimmedNonEmptyString),
});
export type WorkspaceDevelopmentAction = typeof WorkspaceDevelopmentAction.Type;

export const WorkspaceDevelopmentToolResult = Schema.Struct({
  ...WorkspaceDevelopmentToolSummary.fields,
  receipt: Schema.Struct({
    commandId: CommandId,
    action: WorkspaceDevelopmentAction.fields.action,
  }),
});
export type WorkspaceDevelopmentToolResult = typeof WorkspaceDevelopmentToolResult.Type;
