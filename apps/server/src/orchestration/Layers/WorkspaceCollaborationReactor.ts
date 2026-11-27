import { unifiedExecutionLedger } from "../../t3x/executionLedger/UnifiedExecutionLedger.ts";
import { WorkerEngineService } from "../../t3x/workerEngine/WorkerEngineService.ts";
import { WorkerEngineError } from "../../t3x/workerEngine/WorkerEngineStore.ts";
import {
  graphRevisionCap,
  MAX_NODE_ATTEMPTS,
  INITIAL_PLAN_REVISION,
} from "../workspaceGraphLimits.ts";
import { compileWorkflowRun } from "../workspaceWorkflow.ts";
import { tryExecuteWorkflowV2SpecialNode } from "../workflowV2Runtime.ts";
import {
  buildWorkflowAssignmentPrompt,
  parseWorkflowAssignments,
  parkRefusedWorkflowAssignment,
  skipPendingWorkflowAssignments,
  workflowNeedsAssignment,
} from "../workspaceWorkflowAssignment.ts";
import { withWorkspaceRunControl, workspaceRunControl } from "@t3tools/shared/workflow";
import { WorkspaceWorkflowStore } from "../../persistence/WorkspaceWorkflowStore.ts";
import { workspaceConversationThreadId } from "../workspaceConversationContext.ts";
import { WorkspaceDevelopmentGit } from "../WorkspaceDevelopmentGit.ts";
import { checkOrchestraDelivery } from "../WorkspaceOrchestraDelivery.ts";
import { formatWorkspaceRunSummary } from "../workspaceRunSummary.ts";
import { orchestraExecutionId, parsePersistentVerdict } from "../workspacePersistentRun.ts";
import { buildMeetingIntakePrompt, parseMeetingIntakeOutput } from "../workspaceMeetingIntake.ts";
import {
  compactKnowledgeContent,
  redactConversationRagSensitiveData,
} from "../workspaceConversationRag.ts";
import {
  CommandId,
  DEFAULT_WORKSPACE_CONTROL_SETTINGS,
  EventId,
  MessageId,
  ThreadId,
  ProviderExecutionId,
  ProviderDriverKind,
  WorkspaceAgentControlError,
  WorkspaceKnowledgeItemId,
  WorkspaceOrchestraBlock,
  WorkspaceTaskNodeId,
  WorkspaceCollaborationRunId,
  WorkflowGraphV2,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProjectId,
  type WorkspaceAgentRoleBinding,
  type WorkspaceCollaborationRun,
  type WorkspaceCollaborationStep,
  type WorkspaceFailureClassification,
  type WorkspaceMeeting,
  type WorkspaceMeetingStatement,
  type WorkspaceTaskAttempt,
  type WorkspaceTaskGraph,
  type WorkspaceTaskNode,
  type WorkspaceTaskValidationReceipt,
} from "@t3tools/contracts";
import { resolveEffectiveGlobalAssistant, resolveResponseStyle } from "@t3tools/contracts/settings";
import {
  compileGlobalAssistantPrompts,
  GLOBAL_FACTUALITY_GUARD,
} from "@t3tools/shared/globalAssistantPrompt";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as TxRef from "effect/TxRef";

import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ServerConfig } from "../../config.ts";
import {
  boundedEvidencePreview,
  saveWorkspaceContextArtifact,
} from "../workspaceContextArtifacts.ts";
import { renderCompactMeetingContext } from "../workspaceMeetingContext.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  isWorkspaceProviderUnavailable,
  workspaceProviderUnavailableMessage,
} from "../workspaceProviderAvailability.ts";
import { windowsAgentInstructions } from "../../provider/windowsAgentInstructions.ts";
import { naturalWritingStyle } from "../naturalWritingStyle.ts";
import { threadResponseStylePrompt } from "../threadResponseStyle.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { planWorkspaceUsageRecovery } from "../workspaceUsageRecovery.ts";
import { isProviderContentRefusalOutput } from "../../provider/providerContentRefusal.ts";
import { WorkspaceAgentControl } from "../WorkspaceAgentControl.ts";
import { forkParked } from "../../serverActivation.ts";
import { toAgentKnowledgeCaptures } from "../workspaceAgentKnowledge.ts";
import {
  buildMeetingChairClosePrompt,
  buildMeetingPlanPrompt,
  buildMeetingStatementPrompt,
  isNodeInterventionQuestion,
  isNodeSeatSelectionQuestion,
  isProviderContentRefusal,
  meetingAssignmentRoute,
  nextMeetingStep,
  NODE_INTERVENTION_OPTIONS,
  NODE_REFUSAL_OPTIONS,
  nodeInterventionQuestion,
  nodeProviderUnavailableQuestion,
  nodeRequestFormatQuestion,
  nodeInputDataQuestion,
  nodeDeliveryUnconfirmedQuestion,
  nodeRefusalQuestion,
  nodeSeatSelectionOptions,
  nodeSeatSelectionQuestion,
  parseChairVerdict,
  parseMeetingQuestion,
  parseNodeInterventionDecision,
  parseNodeRefusalDecision,
  parseNodeSeatSelectionDecision,
  parseStatementRespondsTo,
  renderMeetingTranscript,
  resolveChairParticipantId,
  resolveNodeAssignmentRoute,
  type WorkspaceAssignmentRoute,
  type WorkspaceMeetingRaisedQuestion,
} from "../workspaceMeeting.ts";
import {
  buildWorkspaceCollaborationStepPrompt,
  buildWorkspaceCollaborationSteps,
  buildWorkspaceTaskNodePrompt,
  formatWorkspaceCollaborationRunMemory,
} from "../workspaceCollaboration.ts";
import {
  buildInitialWorkspaceTaskGraph,
  buildMeetingSeededTaskGraph,
  chainKeyByNodeId,
  computeWriteChains,
  dispatchableWorkspaceTaskNodes,
  grantsFreeRetryAfterInterruption,
  INTERRUPTED_TURN_ERROR_SUFFIX,
  materializeWorkspaceTaskGraphPlan,
  normalizeStoppedRecoveryPlan,
  parseWorkspaceSynthesisPayload,
  parseWorkspaceTaskGraphProposal,
  parseWorkspaceValidationDecision,
  readyWorkspaceTaskNodes,
  selectGraphWaveNodes,
  STOPPED_RECOVERY_CONSTRAINT,
  refreshWorkspaceTaskGraphQueue,
  WorkspaceTaskGraphError,
  type WorkspaceMeetingPlanContext,
  type WorkspaceWriteChain,
} from "../workspaceTaskGraph.ts";
import { buildOrchestraWorktreeBranchName } from "@t3tools/shared/git";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as WorktreeProvisionService from "../../git/WorktreeProvisionService.ts";
import { WorkspaceWorktreeCleanup } from "./WorkspaceWorktreeCleanup.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationTurnWait } from "../Services/OrchestrationTurnWait.ts";
import {
  formatBillingErrorMessage,
  isNonRetryableBillingError,
  isNonRetryableWorkerError,
} from "../../provider/workerFailurePolicy.ts";
import {
  WorkspaceAgentExecutionError,
  WorkspaceAgentExecutor,
  type WorkspaceAgentExecutionInput,
} from "../Services/WorkspaceAgentExecutor.ts";
import {
  formatRepairDigest,
  latestFormatFailure,
  verifiedFormatRepairOutput,
  workspaceExecutionMessageId,
} from "../workspaceFormatRepair.ts";
import {
  meetingWithAuthorizedSeats,
  orchestraWorkerCandidates,
  seatAssignedWorkers,
} from "../workspaceOrchestraRoster.ts";
import {
  classifyDeterministicWorkspaceFailure,
  isDeterministicWorkspaceRequestFailure,
} from "../workspaceTaskFailure.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorkspaceMemory } from "../WorkspaceMemory.ts";
import { WatchdogRuntime, cancelWatchdogsForRun } from "../WatchdogRuntime.ts";
import {
  WATCHDOG_PROJECTION_CONSUMER,
  executeDetachedWatchdog,
  resumeDetachedWatchdog,
} from "../WatchdogExecutor.ts";
import { UPGRADE_ROOM_RUN_ID } from "../UpgradeRoomTurns.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import {
  WorkspaceCollaborationReactor,
  type WorkspaceCollaborationReactorShape,
} from "../Services/WorkspaceCollaborationReactor.ts";

type RunRef = {
  readonly projectId: ProjectId;
  readonly runId: WorkspaceCollaborationRunId;
};

class WorkspaceCollaborationCancelled extends Data.TaggedError("WorkspaceCollaborationCancelled")<{
  readonly runRef: RunRef;
}> {}

class WorkspaceCollaborationExecutionError extends Data.TaggedError(
  "WorkspaceCollaborationExecutionError",
)<{
  readonly message: string;
  /** The seat's turn was cut off from outside rather than failing on its own. */
  readonly interrupted?: boolean;
}> {}

const MAX_PARALLEL_GRAPH_NODES = 3;

/**
 * How many execution nodes a wave of this run may hold. An orchestra run says
 * so itself; without one a meeting keeps its single shared conversation to one
 * turn at a time and a role-bound run keeps the server's fixed width.
 */
function graphWaveWidth(run: WorkspaceCollaborationRun): number {
  if (run.orchestra !== null) return run.orchestra.maxParallel;
  return run.meeting === null ? MAX_PARALLEL_GRAPH_NODES : 1;
}

/**
 * Whether write nodes must run alone. With `isolateWorktrees` each write
 * chain edits its own worktree, so writes may share a wave — bounded to one
 * node per chain at selection time.
 */
function soloWriteWaves(run: WorkspaceCollaborationRun): boolean {
  return !isolatesWorktrees(run);
}

function isolatesWorktrees(run: WorkspaceCollaborationRun): boolean {
  return run.orchestra?.isolateWorktrees === true;
}

const MAX_NODE_HANDOFF_CHARS = 100_000;

/**
 * Never behead a deliverable silently: past the cap the text is cut WITH a
 * visible notice, so the next seat knows it is reading a fragment instead of
 * mistaking it for the whole (which stalled executions on "the artifact cuts
 * off mid-sentence").
 */
const truncateNodeOutput = (text: string): string =>
  text.length <= MAX_NODE_HANDOFF_CHARS
    ? text
    : `${text.slice(0, MAX_NODE_HANDOFF_CHARS)}\n\n[⚠️ 출력이 ${MAX_NODE_HANDOFF_CHARS.toLocaleString()}자 한도에서 잘렸습니다. 전체 산출물이 필요하면 파일로 저장해 경로를 전달하세요.]`;
const MAX_ATTEMPT_RECORD_CHARS = 8_000;
/** A meeting turn (statement, chair close, plan) is retried once before the run fails. */
const MAX_MEETING_TURN_ATTEMPTS = 2;
/**
 * How long an interrupted turn waits for the run's own cancel to surface
 * before the interruption counts as a failure. Stop flows interrupt the
 * visible turn and cancel the run as two separate commands.
 */
const INTERRUPTED_TURN_CANCEL_GRACE_CHECKS = 4;
const INTERRUPTED_TURN_CANCEL_GRACE_INTERVAL = "250 millis" as const;
const MAX_MEETING_STATEMENT_CHARS = 20_000;
const MAX_MEETING_SUMMARY_CHARS = 20_000;

/** Kinds whose output is a structured payload with its own escalation channel. */
const STRUCTURED_NODE_KINDS: ReadonlyArray<WorkspaceTaskNode["kind"]> = [
  "orchestration",
  "validation",
  "synthesis",
];

function meetingPlanContext(meeting: WorkspaceMeeting): WorkspaceMeetingPlanContext {
  const authorized = meetingWithAuthorizedSeats(meeting);
  return {
    participantIds: authorized.participants.map((participant) => participant.id),
    chairParticipantId: resolveChairParticipantId(authorized),
  };
}

function answeredSeatSelectionNode(
  meeting: WorkspaceMeeting,
  graph: WorkspaceTaskGraph,
): WorkspaceTaskNode | undefined {
  const answer = meeting.answers.at(-1);
  if (answer === undefined || !isNodeSeatSelectionQuestion(answer.question)) return undefined;
  const matching = graph.nodes.filter(
    (node) =>
      node.status === "awaiting-user" &&
      node.parkedQuestion === null &&
      (answer.nodeId === null || node.id === answer.nodeId) &&
      answer.question === nodeSeatSelectionQuestion(node.title),
  );
  return matching.length === 1 ? matching[0] : undefined;
}

function hasPendingSeatSelectionAnswer(
  meeting: WorkspaceMeeting,
  graph: WorkspaceTaskGraph,
): boolean {
  return answeredSeatSelectionNode(meeting, graph) !== undefined;
}

function replaceStep(
  run: WorkspaceCollaborationRun,
  index: number,
  step: WorkspaceCollaborationStep,
): WorkspaceCollaborationRun {
  return {
    ...run,
    steps: run.steps.map((candidate, candidateIndex) =>
      candidateIndex === index ? step : candidate,
    ),
  };
}

function replaceGraphNode(
  graph: WorkspaceTaskGraph,
  nodeId: string,
  replacement: WorkspaceTaskNode,
): WorkspaceTaskGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? replacement : node)),
  };
}

function roleBinding(
  bindings: ReadonlyArray<WorkspaceAgentRoleBinding>,
  role: WorkspaceTaskNode["role"],
): WorkspaceAgentRoleBinding | undefined {
  return bindings.find((binding) => binding.role === role && binding.enabled);
}

function graphNodeStepStatus(
  status: WorkspaceTaskNode["status"],
): WorkspaceCollaborationStep["status"] {
  if (status === "running" || status === "awaiting-validation") return "running";
  if (status === "completed" || status === "skipped") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "queued";
}

function graphCompatibilitySteps(
  graph: WorkspaceTaskGraph,
  bindings: ReadonlyArray<WorkspaceAgentRoleBinding>,
  meeting: WorkspaceMeeting | null,
): ReadonlyArray<WorkspaceCollaborationStep> {
  return graph.nodes
    .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((node, index) => {
      const attempt = node.attempts.at(-1);
      const unassigned =
        node.participantId === null &&
        meeting !== null &&
        (graph.workflowAssignment?.pendingNodeIds.includes(node.id) === true ||
          (node.status === "skipped" && graph.workflowSkippedNodeIds?.includes(node.id) === true));
      const route = unassigned
        ? meetingAssignmentRoute(meeting, resolveChairParticipantId(meeting))
        : resolveNodeAssignmentRoute({ node, meeting, bindings });
      if (attempt === undefined && route === null) {
        throw new WorkspaceTaskGraphError(
          node.participantId === null && meeting !== null
            ? `통합 작업 단계 '${node.id}'에 선택된 참가자가 없습니다.`
            : node.participantId === null
              ? `Missing enabled binding for role '${node.role}'.`
              : `Missing meeting participant '${node.participantId}'.`,
        );
      }
      return {
        index,
        phase:
          node.kind === "synthesis"
            ? "finalization"
            : node.kind === "orchestration" && node.dependsOn.length === 0
              ? "kickoff"
              : "contribution",
        role: node.role,
        displayName: unassigned ? "담당 미정" : (route?.displayName ?? node.title),
        modelSelection: attempt?.modelSelection ?? route!.modelSelection,
        runtimeMode: attempt?.runtimeMode ?? route!.runtimeMode,
        interactionMode: attempt?.interactionMode ?? route!.interactionMode,
        instructions: route?.instructions ?? "",
        threadId: attempt?.threadId ?? null,
        status: graphNodeStepStatus(node.status),
        output: node.output,
        error: node.error,
        startedAt: node.startedAt,
        completedAt: node.completedAt,
      };
    });
}

type GraphNodeExecutionResult =
  | { readonly nodeId: string; readonly output: string; readonly error?: never }
  | {
      readonly nodeId: string;
      readonly output?: never;
      readonly error: string;
      readonly interrupted?: boolean;
    };

/** Pins a wave callback's success type so its early returns unify with the run path. */
const settledResult = (result: GraphNodeExecutionResult) => Effect.succeed(result);

function updateLastAttempt(
  node: WorkspaceTaskNode,
  update: (attempt: WorkspaceTaskAttempt) => WorkspaceTaskAttempt,
): WorkspaceTaskNode {
  const lastIndex = node.attempts.length - 1;
  if (lastIndex < 0) throw new WorkspaceTaskGraphError(`Node '${node.id}' has no active attempt.`);
  return {
    ...node,
    attempts: node.attempts.map((attempt, index) =>
      index === lastIndex ? update(attempt) : attempt,
    ),
  };
}

function failureChangeReason(
  classification: WorkspaceFailureClassification,
): WorkspaceTaskGraph["changes"][number]["reason"] {
  if (classification === "information") return "information-gap";
  if (classification === "implementation") return "implementation-failure";
  if (classification === "tool") return "tool-failure";
  if (classification === "assumption") return "invalid-assumption";
  return "validation-failure";
}

function descendantNodeIds(graph: WorkspaceTaskGraph, rootId: string): ReadonlyArray<string> {
  const descendants = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const node of graph.nodes) {
      if (!node.dependsOn.some((dependency) => dependency === current)) continue;
      if (descendants.has(String(node.id))) continue;
      descendants.add(String(node.id));
      queue.push(String(node.id));
    }
  }
  return [...descendants];
}

function terminalAssistantOutput(thread: OrchestrationThread): string {
  const assistantMessageId = thread.latestTurn?.assistantMessageId ?? null;
  const exact =
    assistantMessageId === null
      ? undefined
      : thread.messages.find((message) => message.id === assistantMessageId);
  const fallback = thread.messages.filter((message) => message.role === "assistant").at(-1);
  const text = (exact ?? fallback)?.text.trim() ?? "";
  return text.length > 0 ? text : "Agent completed without a textual handoff.";
}

const decodeMemoryReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, saved: Schema.Boolean })),
);

function conciseCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4_000);
}

export const makeWorkspaceCollaborationReactor = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const turnWait = yield* OrchestrationTurnWait;
  const agentExecutor = yield* Effect.serviceOption(WorkspaceAgentExecutor);
  const workerEngineOpt = yield* Effect.serviceOption(WorkerEngineService);
  const memory = yield* Effect.serviceOption(WorkspaceMemory);
  const agentControl = yield* Effect.serviceOption(WorkspaceAgentControl);
  const watchdogRuntime = yield* Effect.serviceOption(WatchdogRuntime);
  const watchdogSettings = yield* Effect.serviceOption(ServerSettingsService);
  const unconfirmedInstructionNotice = (
    run: WorkspaceCollaborationRun,
    nodeId?: WorkspaceTaskNodeId,
  ) =>
    Option.isNone(agentControl)
      ? Effect.succeed("")
      : agentControl.value
          .unconfirmedInstructions({
            projectId: run.projectId,
            runId: run.id,
            ...(nodeId === undefined ? {} : { nodeId }),
          })
          .pipe(
            Effect.map((records) =>
              records.length === 0
                ? ""
                : [
                    `작업자 처리 확인이 없는 지시 ${records.length}건:`,
                    ...records.map(
                      (record) =>
                        `- 받는 작업 ${record.target} · ${record.title} · 상태 ${record.status} · 기록 ${record.id}`,
                    ),
                    "이 목록에는 원문이 포함되지 않았습니다. 메시지함의 원문과 확인 상태를 살펴봐야 하며, 제공자 수락은 작업자가 처리했다는 증거가 아닙니다.",
                  ].join("\n"),
            ),
            Effect.catch((error) =>
              Effect.logWarning("작업자 메시지 확인 상태 조회 실패", { error: error.message }).pipe(
                Effect.as(
                  "작업자 메시지 확인 상태를 조회하지 못했습니다. 처리 여부는 미확인입니다.",
                ),
              ),
            ),
          );
  const deliveryGit = yield* Effect.serviceOption(WorkspaceDevelopmentGit);
  const artifactConfig = yield* Effect.serviceOption(ServerConfig);
  const artifactFs = yield* Effect.serviceOption(FileSystem.FileSystem);
  const artifactPath = yield* Effect.serviceOption(Path.Path);
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const runRepository = yield* ProjectionWorkspaceCollaborationRunRepository;
  const providerInstanceRegistry = yield* ProviderInstanceRegistry;
  const worktreeProvision = yield* WorktreeProvisionService.WorktreeProvisionService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const worktreeCleanup = yield* WorkspaceWorktreeCleanup;
  const workflowStoreOption = yield* Effect.serviceOption(WorkspaceWorkflowStore);
  const workflowStore = Option.getOrUndefined(workflowStoreOption);
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const workspaceLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const claimedRunsRef = yield* SynchronizedRef.make(new Set<string>());
  // Wake-ups that arrived while the run was claimed. A parked meeting run can
  // release its claim just after an answer or cancel event was dropped as a
  // duplicate; replaying the wake-up on release closes that window.
  const rerunRequestsRef = yield* SynchronizedRef.make(new Map<string, RunRef>());
  const outstanding = yield* TxRef.make(0);
  const limitWakeups = new Map<string, string>();
  const reactorScope = yield* Scope.Scope;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const executionError = (message: string) => new WorkspaceCollaborationExecutionError({ message });
  const runKey = (runRef: RunRef) => `${runRef.projectId}:${runRef.runId}`;
  const folderUnavailable =
    "<t3_folder_memory_unavailable>현재 요청에 적용할 기억의 폴더 범위를 확인하지 못해 폴더 전용 기억이 누락되었을 수 있습니다. 폴더가 없다는 뜻은 아닙니다. 확인되지 않은 폴더 기억을 읽었다고 추측하지 말고 이 사실을 알리세요.</t3_folder_memory_unavailable>";
  const unscopedWorkUnavailable =
    "<t3_folder_history_unclassified>이전 협업 결과와 지속 작업 상태는 당시 폴더 범위를 확인할 수 없어 자동으로 포함하지 않았습니다. 현재 작업 폴더의 확인 여부와는 별개이며, 기존 기록은 보존됩니다. 해당 상태를 확인했다고 추측하지 마세요.</t3_folder_history_unclassified>";

  const withRequiredDirectives = Effect.fn("WorkspaceCollaborationReactor.withRequiredDirectives")(
    function* (
      run: WorkspaceCollaborationRun,
      prompt: string,
      userFacing = false,
      applyResponseStyle = false,
    ) {
      const unavailable =
        "<t3_memory_unavailable>사용자 필수 지침을 불러오지 못했습니다. 지침을 읽었다고 추측하지 말고 이 사실을 알리세요.</t3_memory_unavailable>";
      const folder = yield* resolveRunFolder(run);
      const directives = Option.isNone(memory)
        ? unavailable
        : yield* memory.value
            .context(run.projectId, run.task, true, undefined, {
              // The composed workspace prompt already carries the directives it
              // selected; repeating them only spends input tokens on every node.
              presentIn: prompt,
              ...(folder.paths !== undefined && !folder.unavailable
                ? { folderPaths: folder.paths }
                : {}),
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not prepare collaboration user directives", {
                  cause,
                }).pipe(Effect.as(unavailable)),
              ),
            );
      const scopedConversation = yield* loadScopedConversation(run, folder.unavailable);
      const workflowStyle = run.workflow?.responseStyle;
      const capturedStyle =
        workflowStyle === undefined ? run.runContext?.responseStyle : workflowStyle;
      const liveSettings = Option.isSome(watchdogSettings)
        ? yield* watchdogSettings.value.getSettings.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not load global assistant settings", { cause }).pipe(
                Effect.as(undefined),
              ),
            ),
          )
        : undefined;
      const effectiveGlobal = liveSettings
        ? resolveEffectiveGlobalAssistant(liveSettings)
        : resolveEffectiveGlobalAssistant({ globalResponseStyle: capturedStyle ?? null });
      const compiledGlobal = compileGlobalAssistantPrompts(effectiveGlobal, {
        userMessage: run.task,
      });
      const fallbackLegacyStyle =
        !compiledGlobal.active && applyResponseStyle
          ? threadResponseStylePrompt(
              capturedStyle !== undefined
                ? capturedStyle
                : liveSettings
                  ? resolveResponseStyle(liveSettings, run.meeting?.threadId).style
                  : null,
            )
          : undefined;
      const writingStyleBlock = userFacing
        ? compiledGlobal.suppressDefaultNaturalWriting
          ? GLOBAL_FACTUALITY_GUARD
          : naturalWritingStyle
        : "";
      const globalUserFacingBlocks = applyResponseStyle
        ? compiledGlobal.active
          ? [compiledGlobal.systemInstructions ?? "", compiledGlobal.playbookBlock ?? ""]
          : [fallbackLegacyStyle ?? ""]
        : [compiledGlobal.subordinatePrinciplesBlock ?? ""];
      const recencyAnchorBlock =
        applyResponseStyle && compiledGlobal.active ? (compiledGlobal.recencyAnchor ?? "") : "";
      return [
        prompt,
        writingStyleBlock,
        ...globalUserFacingBlocks,
        windowsAgentInstructions(platform),
        directives,
        scopedConversation && !prompt.includes(scopedConversation) ? scopedConversation : "",
        folder.unavailable && !prompt.includes("<t3_folder_memory_unavailable>")
          ? folderUnavailable
          : "",
        recencyAnchorBlock,
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  );

  const prepareContextSource = Effect.fn("WorkspaceCollaborationReactor.prepareContextSource")(
    function* (run: WorkspaceCollaborationRun, content: string) {
      const settings =
        projectionSnapshotQuery.getWorkspaceContextSettings !== undefined
          ? yield* projectionSnapshotQuery.getWorkspaceContextSettings(run.projectId)
          : (yield* projectionSnapshotQuery.getCommandReadModel()).projects.find(
              (project) => project.id === run.projectId,
            )?.workspaceControl?.contextOptimization;
      if (settings?.compactHandoffs !== true) return undefined;
      if (Option.isNone(artifactConfig) || Option.isNone(artifactFs) || Option.isNone(artifactPath))
        return null;
      return yield* saveWorkspaceContextArtifact({
        stateDir: artifactConfig.value.stateDir,
        projectId: run.projectId,
        runId: run.id,
        content,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, artifactFs.value),
        Effect.provideService(Path.Path, artifactPath.value),
      );
    },
  );
  const prepareMeetingContext = Effect.fn("WorkspaceCollaborationReactor.prepareMeetingContext")(
    function* (run: WorkspaceCollaborationRun, meeting: WorkspaceMeeting) {
      const content = renderMeetingTranscript(meeting);
      const source = yield* prepareContextSource(run, content);
      return source === undefined
        ? {}
        : { preparedTranscript: renderCompactMeetingContext(meeting, source) };
    },
  );

  const preserveBoundedOutput = Effect.fn("WorkspaceCollaborationReactor.preserveBoundedOutput")(
    function* (run: WorkspaceCollaborationRun, content: string, maxChars: number, legacy: string) {
      if (content.length <= maxChars) return content;
      const source = yield* prepareContextSource(run, content);
      if (source === undefined) return legacy;
      const preview = source === null ? null : boundedEvidencePreview(content, source, maxChars);
      if (preview === null)
        return yield* executionError(
          "긴 산출물의 전체 원문을 보존하지 못했습니다. 불완전한 미리보기로 완료 처리하지 않았으며 원래 대화의 산출물은 유지됩니다.",
        );
      return preview;
    },
  );

  const getWorkspaceSemaphore = (key: string) =>
    SynchronizedRef.modifyEffect(workspaceLocksRef, (current) => {
      const existing = current.get(key);
      if (existing !== undefined) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const getRun = Effect.fn("WorkspaceCollaborationReactor.getRun")(function* (runRef: RunRef) {
    const result = yield* runRepository.getById(runRef);
    if (Option.isNone(result)) {
      return yield* executionError(
        `Collaboration run '${runRef.runId}' does not exist in Workspace '${runRef.projectId}'.`,
      );
    }
    if (result.value.projectId !== runRef.projectId) {
      return yield* executionError("Collaboration run crossed its Workspace boundary.");
    }
    return result.value;
  });

  const persistRun = Effect.fn("WorkspaceCollaborationReactor.persistRun")(function* (
    run: WorkspaceCollaborationRun,
  ) {
    yield* orchestrationEngine.dispatch({
      type: "project.collaboration.run.update",
      commandId: CommandId.make(yield* randomUUID),
      run,
    });
    const stored = yield* getRun({ projectId: run.projectId, runId: run.id });
    if (
      Option.isSome(watchdogRuntime) &&
      stored.meeting?.threadId &&
      ["completed", "failed", "cancelled"].includes(stored.status)
    ) {
      const journal = watchdogRuntime.value.journal;
      const threadId = stored.meeting.threadId;
      yield* Effect.sync(() => cancelWatchdogsForRun(journal, threadId, stored.id)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("종료된 작업의 감시 중지 요청을 기록하지 못했습니다", {
                runId: stored.id,
                cause: conciseCause(cause),
              }),
        ),
      );
    }
    if (
      run.status === "completed" &&
      stored.status === "running" &&
      stored.meeting?.pendingSupervisorReview === true
    ) {
      // Publish the projected state too: the completion raced with a new
      // instruction, so subscribers must see that review is still pending.
      yield* orchestrationEngine.dispatch({
        type: "project.collaboration.run.update",
        commandId: CommandId.make(yield* randomUUID),
        run: stored,
      });
    }
    if (Option.isSome(agentControl))
      yield* agentControl.value.reports(stored).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Agent reports will reconcile on next run", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
    return stored;
  });

  const parkPausedRun = Effect.fn("WorkspaceCollaborationReactor.parkPausedRun")(function* (
    run: WorkspaceCollaborationRun,
  ) {
    const control = workspaceRunControl(run);
    if (control.control === "active") return false;
    if (control.control !== "paused") {
      const updatedAt = yield* nowIso;
      yield* persistRun(
        withWorkspaceRunControl(
          { ...run, updatedAt },
          { ...control, control: "paused", updatedAt },
        ),
      );
    }
    return true;
  });

  const requireRunContinuable = Effect.fn("WorkspaceCollaborationReactor.requireRunContinuable")(
    function* (runRef: RunRef) {
      const current = yield* getRun(runRef);
      if (current.status === "cancel-requested" || current.status === "cancelled") {
        return yield* new WorkspaceCollaborationCancelled({ runRef });
      }
      return current;
    },
  );

  const loadThread = Effect.fn("WorkspaceCollaborationReactor.loadThread")(function* (
    runRef: RunRef,
    threadId: ThreadId,
  ) {
    const result = yield* projectionSnapshotQuery.getThreadRuntimeContext(threadId, {
      messages: true,
    });
    if (Option.isSome(result) && result.value.projectId !== runRef.projectId) {
      return yield* executionError("Collaboration thread crossed its Workspace boundary.");
    }
    return result;
  });
  const runWorkspaceCwd = Effect.fn("WorkspaceCollaborationReactor.runWorkspaceCwd")(function* (
    run: WorkspaceCollaborationRun,
  ) {
    const project = yield* projectionSnapshotQuery.getProjectShellById(run.projectId);
    if (Option.isNone(project))
      return yield* executionError("오케스트라 프로젝트를 찾을 수 없습니다.");
    const threadId = workspaceConversationThreadId(run);
    if (!threadId) return project.value.workspaceRoot;
    const thread = yield* loadThread({ projectId: run.projectId, runId: run.id }, threadId);
    return Option.isSome(thread)
      ? (thread.value.worktreePath ?? project.value.workspaceRoot)
      : project.value.workspaceRoot;
  });

  const resolveRunFolder = Effect.fn("WorkspaceCollaborationReactor.resolveRunFolder")(function* (
    run: WorkspaceCollaborationRun,
  ) {
    const threadId = workspaceConversationThreadId(run);
    if (threadId === null) return { paths: undefined, unavailable: false } as const;
    if (Option.isNone(memory)) return { paths: [], unavailable: true } as const;
    const thread = yield* loadThread({ projectId: run.projectId, runId: run.id }, threadId);
    if (Option.isNone(thread)) return { paths: [], unavailable: true } as const;
    const message = thread.value.messages
      .filter(
        (entry) => entry.role === "user" && !entry.streaming && entry.createdAt <= run.createdAt,
      )
      .at(-1);
    if (!message) return { paths: undefined, unavailable: false } as const;
    const project = yield* projectionSnapshotQuery.getProjectShellById(run.projectId);
    if (Option.isNone(project)) return { paths: [], unavailable: true } as const;
    return yield* memory.value
      .contextPaths({
        projectId: run.projectId,
        threadId,
        messageId: message.id,
        cwd: thread.value.worktreePath ?? project.value.workspaceRoot,
      })
      .pipe(
        Effect.map((paths) => ({ paths, unavailable: false }) as const),
        Effect.catch((cause) =>
          Effect.logWarning("Could not determine the collaboration folder", { cause }).pipe(
            Effect.as({ paths: [], unavailable: true } as const),
          ),
        ),
      );
  });

  const loadScopedConversation = Effect.fn("WorkspaceCollaborationReactor.loadScopedConversation")(
    function* (run: WorkspaceCollaborationRun, unavailable: boolean) {
      const threadId = workspaceConversationThreadId(run);
      if (threadId === null) return "";
      const thread = yield* loadThread({ projectId: run.projectId, runId: run.id }, threadId);
      const request = Option.isSome(thread)
        ? thread.value.messages.find(
            (entry) => entry.id === `workflow-request:${run.id}` && entry.role === "user",
          )
        : undefined;
      const currentRequest = request?.text
        ? `<t3_current_user_request>\n현재 사용자가 이 작업에 직접 입력한 지시이며, 과거 기억이나 기존 작업 설명보다 우선합니다.\n${request.text}\n</t3_current_user_request>`
        : "";
      if (unavailable || Option.isNone(memory))
        return [currentRequest, folderUnavailable].filter(Boolean).join("\n\n");
      const message = Option.isSome(thread)
        ? thread.value.messages
            .filter(
              (entry) =>
                entry.role === "user" && !entry.streaming && entry.createdAt <= run.createdAt,
            )
            .at(-1)
        : undefined;
      if (!message) return [currentRequest, folderUnavailable].filter(Boolean).join("\n\n");
      const context = yield* memory.value
        .context(run.projectId, run.task, false, {
          threadId,
          messageId: message.id,
          excludeDirectives: true,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not prepare folder-scoped collaboration history", {
              cause,
            }).pipe(Effect.as(folderUnavailable)),
          ),
        );
      return [currentRequest, context, unscopedWorkUnavailable].filter(Boolean).join("\n\n");
    },
  );

  const composeRunPrompt = Effect.fn("WorkspaceCollaborationReactor.composeRunPrompt")(function* (
    run: WorkspaceCollaborationRun,
  ) {
    const compose =
      projectionSnapshotQuery.composeWorkspacePromptForExecution ??
      projectionSnapshotQuery.composeWorkspacePrompt;
    if (compose === undefined)
      return yield* executionError("Workspace prompt composition is unavailable.");
    const folder = yield* resolveRunFolder(run);
    const conversation = yield* loadScopedConversation(run, folder.unavailable);
    const composeWithoutFolder = folder.unavailable && Option.isNone(memory);
    if (folder.unavailable && !composeWithoutFolder) {
      return {
        prompt: [run.task, conversation || folderUnavailable].filter(Boolean).join("\n\n"),
        sourceItemIds: [],
        sourceReferences: [],
        ragMatches: [],
        libraryMatches: [],
        truncated: false,
      };
    }
    const result = yield* compose({
      projectId: run.projectId,
      task: run.task,
      includeShared: false,
      includeSharedLibrary: false,
      ...(folder.unavailable || folder.paths === undefined ? {} : { contextPaths: folder.paths }),
      contextMode: "relevant",
      includeRag: true,
      includeWorkingMemory: true,
      includeLongTermMemory: true,
      ragLimit: 12,
      maxContextChars: 24_000,
    });
    return conversation ? { ...result, prompt: `${result.prompt}\n\n${conversation}` } : result;
  });

  const interruptThreadTurn = (runRef: RunRef, threadId: ThreadId | null) =>
    threadId === null
      ? Effect.void
      : loadThread(runRef, threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (thread) =>
                thread.latestTurn?.state !== "running"
                  ? Effect.void
                  : Effect.gen(function* () {
                      yield* orchestrationEngine.dispatch({
                        type: "thread.turn.interrupt",
                        commandId: CommandId.make(yield* randomUUID),
                        threadId,
                        turnId: thread.latestTurn?.turnId,
                        createdAt: yield* nowIso,
                      });
                    }).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Failed to interrupt cancelled collaboration turn", {
                          projectId: runRef.projectId,
                          runId: runRef.runId,
                          threadId,
                          cause: conciseCause(cause),
                        }),
                      ),
                    ),
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to inspect cancelled collaboration turn", {
              projectId: runRef.projectId,
              runId: runRef.runId,
              threadId,
              cause: conciseCause(cause),
            }),
          ),
        );

  const awaitStepOutput = Effect.fn("WorkspaceCollaborationReactor.awaitStepOutput")(function* (
    runRef: RunRef,
    threadId: ThreadId,
    requestedAtOrAfter?: string,
  ) {
    yield* requireRunContinuable(runRef);
    const result = yield* turnWait
      .waitForSettledTurn({
        threadId,
        expectedProjectId: runRef.projectId,
        ...(requestedAtOrAfter === undefined ? {} : { requestedAtOrAfter }),
        interruptWhen: (event) =>
          (event.type === "project.collaboration-run-cancel-requested" &&
            event.payload.projectId === runRef.projectId &&
            event.payload.runId === runRef.runId) ||
          (event.type === "project.collaboration-run-upserted" &&
            event.payload.run.projectId === runRef.projectId &&
            event.payload.run.id === runRef.runId &&
            (event.payload.run.status === "cancel-requested" ||
              event.payload.run.status === "cancelled")),
      })
      .pipe(
        Effect.catchTags({
          OrchestrationTurnWaitInterruptedError: () =>
            requireRunContinuable(runRef).pipe(
              Effect.andThen(
                executionError(`Collaboration wait for thread '${threadId}' was interrupted.`),
              ),
            ),
          OrchestrationTurnWaitThreadNotFoundError: () =>
            executionError(`Collaboration thread '${threadId}' disappeared.`),
          OrchestrationTurnWaitProjectMismatchError: () =>
            executionError("Collaboration thread crossed its Workspace boundary."),
          OrchestrationTurnWaitTargetReplacedError: (error) =>
            executionError(
              `Collaboration turn '${error.expectedTurnId}' was replaced before its result was collected.`,
            ),
        }),
      );
    yield* requireRunContinuable(runRef);

    if (result.turn.state === "completed") return terminalAssistantOutput(result.thread);
    if (result.turn.state === "interrupted") {
      // A stop flow interrupts the visible turn first and cancels the run a
      // beat later; reading the run status in that gap would misfile the
      // user's stop as a seat failure. Give the cancel a short grace to land
      // before treating the interruption as an error.
      for (let attempt = 0; ; attempt++) {
        const current = yield* getRun(runRef);
        if (current.status === "cancel-requested" || current.status === "cancelled") {
          return yield* new WorkspaceCollaborationCancelled({ runRef });
        }
        if (attempt >= INTERRUPTED_TURN_CANCEL_GRACE_CHECKS) break;
        yield* Effect.sleep(INTERRUPTED_TURN_CANCEL_GRACE_INTERVAL);
      }
      return yield* new WorkspaceCollaborationExecutionError({
        message: `Collaboration turn '${result.turn.turnId}' ${INTERRUPTED_TURN_ERROR_SUFFIX}`,
        interrupted: true,
      });
    }
    return yield* executionError(
      result.thread.session?.lastError ??
        `Collaboration turn '${result.turn.turnId}' failed without an error message.`,
    );
  });

  const ensureThreadAndTurn = Effect.fn("WorkspaceCollaborationReactor.ensureThreadAndTurn")(
    function* (input: {
      readonly run: WorkspaceCollaborationRun;
      readonly step: WorkspaceCollaborationStep;
      readonly prompt: string;
      readonly title: string;
      readonly expectedAgent?: "fable" | "codex" | "grok";
      readonly node?: WorkspaceTaskNode;
      readonly usageContext?: import("@t3tools/contracts").TokenUsageContext;
      /**
       * The write-chain checkout this node works in. The thread is created
       * with it, and an existing thread whose recorded worktree drifted (a
       * cleanup nulled it, then the chain was re-provisioned) is pointed back
       * before the turn starts — the session cwd is read from the thread.
       */
      readonly worktree?: { readonly worktreePath: string; readonly branch: string | null };
      /**
       * The turn this call awaits must have been requested at or after this
       * instant. On a reused thread (a meeting seat's single conversation) it
       * separates this attempt's turn from the turns already in the window: an
       * older latest turn means ours has not started yet, a newer one is ours
       * being resumed. Absent on fresh-thread paths, where "no turn yet" is
       * the only signal needed.
       */
      readonly turnAfter?: string;
    }) {
      const runRef = { projectId: input.run.projectId, runId: input.run.id };
      if (input.step.threadId === null) {
        return yield* executionError("Running collaboration step has no thread id.");
      }
      const unavailable = yield* workspaceProviderUnavailableMessage({
        registry: providerInstanceRegistry,
        modelSelection: input.step.modelSelection,
        role: input.step.role,
      });
      if (unavailable !== null) return yield* executionError(unavailable);
      const instance = yield* providerInstanceRegistry.getInstance(
        input.step.modelSelection.instanceId,
      );
      if (instance === undefined || !instance.enabled) {
        return yield* executionError(
          "선택한 AI 연결을 사용할 수 없습니다. 작업 중 연결이 변경되었습니다. 설정에서 확인하세요.",
        );
      }
      const expectedDriver =
        input.node === undefined
          ? input.expectedAgent === "codex"
            ? "codex"
            : input.expectedAgent === "grok"
              ? "grok"
              : null
          : null;
      if (expectedDriver !== null && instance.driverKind !== expectedDriver) {
        return yield* executionError(
          `Agent '${input.expectedAgent}' requires the '${expectedDriver}' provider driver, but role '${input.step.role}' is bound to '${instance.driverKind}'.`,
        );
      }

      let thread = yield* loadThread(runRef, input.step.threadId);
      if (Option.isNone(thread)) {
        const createdAt = yield* nowIso;
        const taskTitle = input.title.replace(/\s+/g, " ").trim().slice(0, 80);
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId:
            input.node === undefined
              ? CommandId.make(yield* randomUUID)
              : CommandId.make(`orchestra-conversation:${input.run.id}`),
          threadId: input.step.threadId,
          projectId: input.run.projectId,
          title: `Collaboration ${input.step.role}: ${taskTitle}`,
          modelSelection: input.step.modelSelection,
          runtimeMode: input.step.runtimeMode,
          interactionMode: input.step.interactionMode,
          branch: input.node === undefined ? (input.worktree?.branch ?? null) : null,
          worktreePath: input.node === undefined ? (input.worktree?.worktreePath ?? null) : null,
          orchestraRunThreadId: null,
          createdAt,
        });
        thread = yield* loadThread(runRef, input.step.threadId);
      }

      if (Option.isNone(thread)) {
        return yield* executionError(
          `Collaboration thread '${input.step.threadId}' was not projected after creation.`,
        );
      }
      if (input.node !== undefined || input.run.orchestra !== null) {
        if (Option.isNone(agentExecutor))
          return yield* executionError("오케스트라 실행 서비스를 사용할 수 없습니다.");
        const project = yield* projectionSnapshotQuery.getProjectShellById(input.run.projectId);
        if (Option.isNone(project))
          return yield* executionError("오케스트라 프로젝트를 찾을 수 없습니다.");
        const nodeId =
          input.node?.id ??
          WorkspaceTaskNodeId.make(`legacy-step-${input.run.steps.indexOf(input.step)}`);
        const attempt = input.node?.attempts.at(-1) ?? {
          number: 1,
          startedAt: input.step.startedAt ?? input.run.createdAt,
        };
        let ownsDelivery = false;
        const executionId = orchestraExecutionId(input.run, nodeId, attempt.number);
        const recordDelivery = (phase: "submitting" | "accepted" | "stopped", confirmed = false) =>
          Effect.gen(function* () {
            yield* orchestrationEngine.dispatch({
              type: "project.workflow.delivery",
              commandId: CommandId.make(yield* randomUUID),
              projectId: input.run.projectId,
              runId: input.run.id,
              nodeId: String(nodeId),
              executionId,
              phase,
              confirmed,
              createdAt: yield* nowIso,
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new WorkspaceAgentExecutionError({
                  message:
                    cause instanceof Error ? cause.message : "워크플로 전달 기록에 실패했습니다.",
                }),
            ),
          );
        const executionInput: WorkspaceAgentExecutionInput = {
          ...(input.run.workflow
            ? {
                skills:
                  input.run.workflow.nodeSkills.find((entry) => entry.nodeId === nodeId)?.skills ??
                  [],
                skillDriver: instance.driverKind,
                // A provider's child agent is not an additional meeting participant.
                allowAdditionalSkillWorkers: true,
              }
            : {}),
          ...(input.run.workflow || (workflowStore && input.node !== undefined)
            ? {
                onBeforeSubmit: Effect.gen(function* () {
                  if (!workflowStore)
                    return yield* new WorkspaceAgentExecutionError({
                      message: "워크플로 전달 기록 서비스를 사용할 수 없습니다.",
                    });
                  const safe = yield* workflowStore
                    .retrySafe(
                      input.run.id,
                      String(nodeId),
                      !input.run.workflow && attempt.number > 1,
                    )
                    .pipe(
                      Effect.mapError(
                        (error) => new WorkspaceAgentExecutionError({ message: error.message }),
                      ),
                    );
                  if (!safe)
                    return yield* new WorkspaceAgentExecutionError({
                      message: "이전 입력의 전달·종료가 미확인입니다. 자동 재전송을 중단했습니다.",
                    });
                  yield* recordDelivery("submitting");
                  ownsDelivery = true;
                }),
                submitWithGate: (submit) =>
                  Effect.gen(function* () {
                    const current = yield* getRun(runRef).pipe(
                      Effect.mapError(
                        (error) => new WorkspaceAgentExecutionError({ message: error.message }),
                      ),
                    );
                    if (current.status === "cancel-requested" || current.status === "cancelled")
                      return yield* new WorkspaceAgentExecutionError({
                        message: "사용자가 실행을 중단했습니다.",
                        interrupted: true,
                      });
                    return yield* submit;
                  }),
                onInputAccepted: () => recordDelivery("accepted"),
                onSessionStopped: (confirmed) =>
                  ownsDelivery ? recordDelivery("stopped", confirmed) : Effect.void,
              }
            : {}),
          orchestraPhase: input.node === undefined ? "step" : "task",
          execution: {
            executionId: ProviderExecutionId.make(executionId),
            ownerThreadId: input.step.threadId,
            runId: input.run.id,
            nodeId,
            attempt: attempt.number,
          },
          modelSelection: input.step.modelSelection,
          ...(attempt.number > 1
            ? {
                resumeFromSessionKey: ThreadId.make(
                  orchestraExecutionId(input.run, nodeId, attempt.number - 1),
                ),
              }
            : {}),
          runtimeMode: input.step.runtimeMode,
          interactionMode: input.step.interactionMode,
          prompt: yield* withRequiredDirectives(
            input.run,
            (input.run.workflow?.requestMode ?? input.run.runContext?.requestMode) === "ask-first"
              ? `[질문 먼저] 이 작업의 현재 계획과 확인한 사실을 간단히 설명하고, 아직 승인되지 않은 조건은 기본 질문 도구(Codex request_user_input, Claude AskUserQuestion)의 카드로 물어보고 답변을 기다린다. 이미 승인된 조건은 유지하고 다시 묻지 않는다. 질문·권한·계획 모드를 바꾸지 않는다.\n\n${input.prompt}`
              : input.prompt,
            input.node?.kind === "synthesis" ||
              (input.node === undefined && input.step.phase === "finalization"),
            input.node?.kind === "synthesis" ||
              (input.node === undefined && input.step.phase === "finalization"),
          ),
          cwd:
            input.worktree?.worktreePath ??
            thread.value.worktreePath ??
            project.value.workspaceRoot,
          title: input.node?.title ?? input.title,
          displayName: input.step.displayName,
          instruction: (input.node === undefined
            ? input.run.task
            : `${input.node.handoff.task}\n\n완료 기준:\n${input.node.handoff.successCriteria.map((criterion) => `- ${criterion}`).join("\n")}`
          ).slice(0, 20_000),
          role: input.node?.role ?? input.step.role,
          kind:
            input.node?.kind ??
            (input.step.phase === "kickoff"
              ? "orchestration"
              : input.step.phase === "finalization"
                ? "synthesis"
                : "implementation"),
          ...(input.usageContext === undefined ? {} : { usagePhase: input.usageContext.phase }),
          startedAt: attempt.startedAt,
        };

        const runExecution = Option.isSome(workerEngineOpt)
          ? workerEngineOpt.value
              .runAndCollect(
                {
                  runId: input.run.id,
                  threadId: input.step.threadId,
                  callerKind: "orchestra",
                  role: executionInput.role,
                  targetInstanceId: executionInput.modelSelection.instanceId,
                  targetModel: executionInput.modelSelection.model,
                  specText: (executionInput.instruction ?? input.run.task).slice(0, 4_000),
                  cwd: executionInput.cwd,
                  worktreeMode: input.worktree ? "isolated" : "current",
                },
                {
                  dispatchId: executionId,
                  allowDuplicate: true,
                  maxRunningPerThread: 32,
                  skipLedger: true,
                  ...(input.worktree
                    ? {
                        externalWorktree: {
                          worktreePath: input.worktree.worktreePath,
                          worktreeBranch: input.worktree.branch,
                        },
                      }
                    : {}),
                  runner: (req) =>
                    agentExecutor.value
                      .execute({
                        ...executionInput,
                        onRuntimeEvent: (event) => {
                          const base = executionInput.onRuntimeEvent
                            ? executionInput.onRuntimeEvent(event)
                            : Effect.void;
                          return base.pipe(
                            Effect.andThen(req.onActivity(event.type)),
                            Effect.ignore,
                          );
                        },
                      })
                      .pipe(
                        Effect.map((resultText) => ({
                          resultText,
                          summary: resultText.slice(0, 400),
                          exitCode: 0,
                        })),
                        Effect.mapError(
                          (err) =>
                            new WorkerEngineError({
                              code: err.interrupted ? "conflict" : "invalid_state",
                              message: err.message,
                              details: { interrupted: err.interrupted === true },
                            }),
                        ),
                      ),
                },
              )
              .pipe(
                Effect.map((res) => res.resultText),
                Effect.mapError(
                  (error) =>
                    new WorkspaceCollaborationExecutionError({
                      message: error.message,
                      ...(error.details?.interrupted === true ? { interrupted: true } : {}),
                    }),
                ),
              )
          : agentExecutor.value.execute(executionInput).pipe(
              Effect.mapError(
                (error) =>
                  new WorkspaceCollaborationExecutionError({
                    message: error.message,
                    ...(error.interrupted === undefined ? {} : { interrupted: error.interrupted }),
                  }),
              ),
            );

        return yield* runExecution;
      }
      if (
        input.worktree !== undefined &&
        thread.value.worktreePath !== input.worktree.worktreePath
      ) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(yield* randomUUID),
          threadId: input.step.threadId,
          branch: input.worktree.branch,
          worktreePath: input.worktree.worktreePath,
        });
      }
      const latestTurn = thread.value.latestTurn;
      // `<=` on the boundary: a latest turn stamped in the same millisecond as
      // this attempt cannot be proven to be ours, and re-dispatching a turn is
      // recoverable while awaiting someone else's settled turn is not.
      const mustStartTurn =
        latestTurn === null ||
        (input.turnAfter !== undefined && latestTurn.requestedAt <= input.turnAfter);
      let requestedAtOrAfter = input.turnAfter;
      if (mustStartTurn) {
        const session = thread.value.session;
        if (
          session !== null &&
          session.status !== "stopped" &&
          session.providerName !== null &&
          session.providerName !== instance.driverKind
        ) {
          // The conversation is handed to a different provider: release the
          // live session so the runtime starts a fresh one for this turn.
          yield* orchestrationEngine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make(yield* randomUUID),
            threadId: input.step.threadId,
            createdAt: yield* nowIso,
          });
        }
        const createdAt = yield* nowIso;
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(yield* randomUUID),
          threadId: input.step.threadId,
          message: {
            messageId: MessageId.make(yield* randomUUID),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          inputOrigin: "automation",
          modelSelection: input.step.modelSelection,
          usageContext: input.usageContext ?? {
            workId: input.run.id,
            phase:
              input.step.phase === "kickoff"
                ? "planning"
                : input.step.phase === "finalization"
                  ? "finalization"
                  : "implementation",
            nodeId: null,
            attempt: 1,
          },
          runtimeMode: input.step.runtimeMode,
          interactionMode: input.step.interactionMode,
          createdAt,
        });
        requestedAtOrAfter = createdAt;
      }
      const threadId = input.step.threadId;
      // A collapsing wait (cancel, sibling failure) must not leave this turn
      // running unattended — doubly so now that a seat's thread is a visible
      // conversation window.
      return yield* awaitStepOutput(runRef, threadId, requestedAtOrAfter).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure" ? interruptThreadTurn(runRef, threadId) : Effect.void,
        ),
      );
    },
  );

  /**
   * Read the project's capture settings from the lightweight command read model.
   * A project that predates the setting decodes to the schema default, so an
   * unavailable or unknown project falls back to the same default rather than
   * silently dropping everything the agents produced.
   */
  const resolveAgentKnowledgeSettings = (projectId: ProjectId) =>
    projectionSnapshotQuery.getCommandReadModel().pipe(
      Effect.map((readModel) => {
        const project = readModel.projects.find((candidate) => candidate.id === projectId);
        return (
          project?.workspaceControl?.agentKnowledge ??
          DEFAULT_WORKSPACE_CONTROL_SETTINGS.agentKnowledge
        );
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Falling back to default agent knowledge capture settings", {
          projectId,
          cause: conciseCause(cause),
        }).pipe(Effect.as(DEFAULT_WORKSPACE_CONTROL_SETTINGS.agentKnowledge)),
      ),
    );

  /**
   * Register every graph node output as searchable knowledge. Memory candidates
   * above are what Fable judged worth keeping; this is the unfiltered record of
   * what the agents actually produced.
   */
  const captureAgentKnowledge = (run: WorkspaceCollaborationRun) =>
    Effect.gen(function* () {
      if (run.graph === null) return;
      const settings = yield* resolveAgentKnowledgeSettings(run.projectId);
      if (!settings.enabled) return;
      const captures = toAgentKnowledgeCaptures({
        run,
        settings,
        capturedAt: run.updatedAt,
      });
      if (captures.length === 0) return;
      yield* Effect.forEach(
        captures,
        (capture) =>
          Effect.gen(function* () {
            yield* orchestrationEngine.dispatch({
              type: "project.knowledge.item.upsert",
              commandId: CommandId.make(yield* randomUUID),
              projectId: run.projectId,
              itemId: capture.item.id,
              kind: capture.item.kind,
              title: capture.item.title,
              content: capture.item.content,
              status: capture.item.status,
              origin: capture.item.origin,
              relativeFolder: capture.item.relativeFolder,
              tags: capture.item.tags,
              ...(capture.item.provenance ? { provenance: capture.item.provenance } : {}),
              originalChars: capture.originalChars,
              storedChars: capture.storedChars,
              createdAt: capture.item.createdAt,
            });
          }),
        { concurrency: 1, discard: true },
      );
      yield* Effect.logDebug("Captured Workspace agent outputs as knowledge", {
        projectId: run.projectId,
        runId: run.id,
        capturedNodes: captures.length,
      });
    });

  /**
   * Count the knowledge that actually reached a model. `sourceItemIds` is what
   * the composer wrote into the prompt — including RAG matches it appended — so
   * it is the honest measure, unlike the candidate set the search returned.
   *
   * Failures are logged and swallowed: a run must not die because a usage
   * counter could not be written.
   */
  const recordPromptUsage = (input: {
    readonly projectId: ProjectId;
    readonly sourceItemIds: ReadonlyArray<WorkspaceKnowledgeItemId>;
    readonly sourceReferences?: ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly itemId: WorkspaceKnowledgeItemId;
    }>;
  }) =>
    Effect.gen(function* () {
      const groups = new Map<ProjectId, WorkspaceKnowledgeItemId[]>();
      for (const source of input.sourceReferences ??
        input.sourceItemIds.map((itemId) => ({ itemId, projectId: input.projectId }))) {
        const items = groups.get(source.projectId) ?? [];
        if (!items.includes(source.itemId)) items.push(source.itemId);
        groups.set(source.projectId, items);
      }
      for (const [projectId, itemIds] of groups) {
        yield* orchestrationEngine.dispatch({
          type: "project.knowledge.usage.record",
          commandId: CommandId.make(yield* randomUUID),
          projectId,
          itemIds,
          usedAt: yield* nowIso,
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to record Workspace knowledge prompt usage", {
          projectId: input.projectId,
          cause: conciseCause(cause),
        }),
      ),
    );

  const captureRunMemory = (run: WorkspaceCollaborationRun) =>
    Effect.gen(function* () {
      // Legacy runs used the knowledge index as their only durable handoff. Graph runs
      // already retain full history on the run and promote only Fable-selected memory.
      if (run.graph === null) {
        yield* orchestrationEngine.dispatch({
          type: "project.knowledge.item.upsert",
          commandId: CommandId.make(yield* randomUUID),
          projectId: run.projectId,
          itemId: WorkspaceKnowledgeItemId.make(`collaboration-run-${run.id}`),
          kind: "run-memory",
          title: `Collaboration run: ${run.task.replace(/\s+/g, " ").trim().slice(0, 100)}`,
          content: formatWorkspaceCollaborationRunMemory(run),
          status: "active",
          origin: "agent",
          relativeFolder: "collaboration-runs",
          provenance: {
            runId: run.id,
            ...(run.meeting?.threadId ? { threadId: run.meeting.threadId } : {}),
          },
          tags: ["collaboration", "run-memory"],
          createdAt: run.updatedAt,
        });
      }
      yield* Effect.forEach(
        run.graph?.memoryCandidates ?? [],
        (candidate) =>
          Effect.gen(function* () {
            yield* orchestrationEngine.dispatch({
              type: "project.knowledge.item.upsert",
              commandId: CommandId.make(yield* randomUUID),
              projectId: run.projectId,
              itemId: WorkspaceKnowledgeItemId.make(`memory-${yield* randomUUID}`),
              kind: "long-term-memory",
              title: candidate.title,
              content: candidate.content,
              status: candidate.confidence === "high" ? "active" : "candidate",
              origin: "agent",
              relativeFolder: "collaboration-memory",
              provenance: {
                runId: run.id,
                nodeIds: candidate.sourceNodeIds,
                confidence: candidate.confidence,
                ...(candidate.sourceNodeIds.length === 1
                  ? { nodeId: candidate.sourceNodeIds[0]! }
                  : {}),
              },
              tags: [
                "collaboration",
                "memory-candidate",
                candidate.category,
                `confidence-${candidate.confidence}`,
                ...candidate.tags,
              ],
              createdAt: run.updatedAt,
            });
          }),
        { concurrency: 1, discard: true },
      );
      yield* captureAgentKnowledge(run);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to capture Workspace collaboration run memory", {
          projectId: run.projectId,
          runId: run.id,
          cause: conciseCause(cause),
        }),
      ),
    );

  const recordRunProgress = (
    run: WorkspaceCollaborationRun,
    status: "continue" | "blocked" | "complete",
    summary: string,
    nextTask?: string,
  ) =>
    Effect.gen(function* () {
      const threadId = run.meeting?.threadId;
      if (!threadId) return;
      if (Option.isNone(memory))
        return yield* executionError("폴더 기억 서비스를 사용할 수 없습니다.");
      const settings = yield* resolveAgentKnowledgeSettings(run.projectId);
      if (!settings.enabled) return;
      const cycle = run.meeting?.continuation?.cycle ?? 0;
      const text = compactKnowledgeContent(
        [
          `사용자 요청: ${run.task}`,
          `작업 상태: ${status}`,
          `감독 AI의 보고(별도 확인 필요): ${summary}`,
          ...(nextTask ? [`남은 작업: ${nextTask}`] : []),
        ].join("\n"),
        {
          redactSensitiveData: settings.redactSensitiveData,
          maxChars: Math.min(8_000, settings.maxOutputChars),
        },
      );
      if (text === null) return;
      const topic = compactKnowledgeContent(`통합 작업 진행: ${run.task.slice(0, 100)}`, {
        redactSensitiveData: settings.redactSensitiveData,
        maxChars: 200,
      });
      const result = yield* memory.value.invoke(
        {
          projectId: run.projectId,
          action: "remember",
          requestId: `orchestra:${run.id}:cycle:${cycle}:${status}`,
          topic: topic?.content ?? "통합 작업 진행",
          text: text.content,
          scope: "project",
        },
        { threadId, agentReported: true },
      );
      const receipt = yield* decodeMemoryReceipt(result);
      if (!receipt.saved)
        return yield* executionError("통합 작업 기록의 저장을 확인하지 못했습니다.");
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            "통합 작업의 폴더 기억 저장에 실패했습니다. 작업은 계속합니다.",
            {
              runId: run.id,
              cause: conciseCause(cause),
            },
          );
          const threadId = run.meeting?.threadId;
          if (!threadId) return;
          const cycle = run.meeting?.continuation?.cycle ?? 0;
          const id = `orchestra-memory-save-failed:${run.id}:${cycle}:${status}`;
          const createdAt = yield* nowIso;
          yield* orchestrationEngine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(id),
              threadId,
              createdAt,
              activity: {
                id: EventId.make(id),
                kind: "workspace.memory.save-failed",
                tone: "error",
                summary: "통합 작업의 폴더 RAG 저장을 확인하지 못했습니다. 작업 기록을 확인하세요.",
                payload: { runId: run.id, cycle, status },
                turnId: null,
                createdAt,
              },
            })
            .pipe(
              Effect.catchCause((reportCause) =>
                Effect.logWarning("폴더 기억 저장 실패를 대화에 기록하지 못했습니다.", {
                  runId: run.id,
                  cause: conciseCause(reportCause),
                }),
              ),
            );
        }),
      ),
    );

  const loadGraphBindings = Effect.fn("WorkspaceCollaborationReactor.loadGraphBindings")(function* (
    projectId: ProjectId,
    meeting: WorkspaceMeeting | null,
  ) {
    if (meeting !== null) return [];
    const listRoles = projectionSnapshotQuery.listWorkspaceAgentRoles;
    if (listRoles === undefined) {
      return yield* executionError("Workspace role projection is unavailable.");
    }
    const result = yield* listRoles({ projectId });
    if (roleBinding(result.roles, "coordinator") === undefined) {
      return yield* executionError(
        "An enabled coordinator role is required before a task graph can start.",
      );
    }
    return result.roles;
  });

  const persistGraphRun = (
    run: WorkspaceCollaborationRun,
    graph: WorkspaceTaskGraph,
    bindings: ReadonlyArray<WorkspaceAgentRoleBinding>,
    update: Partial<
      Pick<WorkspaceCollaborationRun, "status" | "finalOutput" | "error" | "updatedAt">
    > = {},
  ) =>
    persistRun({
      ...run,
      ...update,
      graph,
      steps: graphCompatibilitySteps(graph, bindings, run.meeting),
    });

  /**
   * One meeting turn in the meeting's single conversation.
   *
   * Every seat speaks in the same thread; each turn runs on that seat's own
   * provider session. When the previous turn belonged to a different provider,
   * its session is released first so the runtime starts a fresh one — the
   * transcript context every prompt carries is what keeps the discussion
   * coherent across sessions.
   */
  const dispatchMeetingTurn = Effect.fn("WorkspaceCollaborationReactor.dispatchMeetingTurn")(
    function* (input: {
      readonly run: WorkspaceCollaborationRun;
      readonly route: WorkspaceAssignmentRoute;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly prompt: string;
      readonly executionNodeId?: WorkspaceTaskNodeId;
      readonly executionId?: ProviderExecutionId;
      readonly usagePhase?: import("@t3tools/contracts").TokenUsagePhase;
    }) {
      const runRef = { projectId: input.run.projectId, runId: input.run.id };
      const unavailable = yield* workspaceProviderUnavailableMessage({
        registry: providerInstanceRegistry,
        modelSelection: input.route.modelSelection,
        role: input.route.displayName,
      });
      if (unavailable !== null) return yield* executionError(unavailable);
      const instance = yield* providerInstanceRegistry.getInstance(
        input.route.modelSelection.instanceId,
      );
      if (instance === undefined || !instance.enabled) {
        return yield* executionError(
          "선택한 AI 연결을 사용할 수 없습니다. 작업 중 연결이 변경되었습니다. 설정에서 확인하세요.",
        );
      }
      const threadId = input.threadId;
      const existing = yield* loadThread(runRef, threadId);
      const createdAt = yield* nowIso;
      if (Option.isNone(existing)) {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* randomUUID),
          threadId,
          projectId: input.run.projectId,
          title: input.title.replace(/\s+/g, " ").trim().slice(0, 80),
          modelSelection: input.route.modelSelection,
          runtimeMode: input.route.runtimeMode,
          interactionMode: input.route.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }
      if (Option.isNone(agentExecutor))
        return yield* executionError("오케스트라 실행 서비스를 사용할 수 없습니다.");
      const project = yield* projectionSnapshotQuery.getProjectShellById(input.run.projectId);
      if (Option.isNone(project))
        return yield* executionError("오케스트라 프로젝트를 찾을 수 없습니다.");
      const nodeId =
        input.executionNodeId ?? WorkspaceTaskNodeId.make(`meeting-${yield* randomUUID}`);
      const workerInput: WorkspaceAgentExecutionInput = {
        orchestraPhase: "meeting",
        execution: {
          executionId:
            input.executionId ?? ProviderExecutionId.make(`orchestra:${input.run.id}:${nodeId}:1`),
          ownerThreadId: threadId,
          runId: input.run.id,
          nodeId,
          attempt: 1,
        },
        modelSelection: input.route.modelSelection,
        runtimeMode: input.route.runtimeMode,
        interactionMode: input.route.interactionMode,
        cwd:
          (Option.isSome(existing) ? existing.value.worktreePath : null) ??
          project.value.workspaceRoot,
        prompt: yield* withRequiredDirectives(input.run, input.prompt, true),
        instruction: input.run.task,
        title: input.executionNodeId?.startsWith("watchdog-")
          ? "지속 작업 감시"
          : input.run.meeting?.phase === "clarifying"
            ? "지휘 AI · 질문 먼저"
            : input.usagePhase === "planning"
              ? "실행 계획"
              : "AI 토론",
        displayName: input.route.displayName,
        role: "coordinator",
        kind: "orchestration",
        startedAt: createdAt,
      };
      const isWatchdog = input.executionNodeId?.startsWith("watchdog-") === true;
      let execute = agentExecutor.value.execute(workerInput);
      if (
        isWatchdog &&
        Option.isSome(watchdogRuntime) &&
        instance.adapter?.capabilities.stopSessionDrainsEvents === true
      ) {
        if (Option.isNone(watchdogSettings) || Option.isNone(artifactConfig))
          return yield* executionError("독립 감시 실행에 필요한 설정을 확인할 수 없습니다.");
        const settings = yield* watchdogSettings.value.getSettings.pipe(
          Effect.mapError((error) => executionError(error.message)),
        );
        const config =
          deriveProviderInstanceConfigMap(settings)[input.route.modelSelection.instanceId];
        if (!config || config.driver !== instance.driverKind)
          return yield* executionError("선택한 감시 AI의 실행 설정을 확인할 수 없습니다.");
        execute = (watchdogRuntime.value.execute ?? executeDetachedWatchdog)({
          journal: watchdogRuntime.value.journal,
          engine: orchestrationEngine,
          queries: projectionSnapshotQuery,
          serverConfig: artifactConfig.value,
          settings,
          instance: config,
          provider: instance.driverKind,
          worker: workerInput,
        }).pipe(
          Effect.mapError((error) =>
            error instanceof WorkspaceAgentExecutionError
              ? error
              : new WorkspaceAgentExecutionError({ message: error.message }),
          ),
        );
      } else if (isWatchdog && Option.isSome(watchdogRuntime)) {
        const compatibilityId = `watchdog-compat:${input.run.id}:${instance.driverKind}`;
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(compatibilityId),
          threadId,
          createdAt: input.run.createdAt,
          activity: {
            id: EventId.make(compatibilityId),
            kind: "orchestra.watchdog.compatibility",
            tone: "info",
            summary:
              "선택한 AI는 독립 감시의 종료 확인이 아직 지원되지 않아 기존 감시 세션으로 실행합니다. 서버가 재시작되면 실행 중인 감시는 이어지지 않을 수 있습니다.",
            payload: { runId: input.run.id, provider: instance.driverKind },
            turnId: null,
            createdAt: input.run.createdAt,
          },
        });
      }
      const output = yield* execute.pipe(
        Effect.mapError(
          (error) =>
            new WorkspaceCollaborationExecutionError({
              message: error.message,
              ...(error.interrupted === undefined ? {} : { interrupted: error.interrupted }),
            }),
        ),
      );
      if (isProviderContentRefusalOutput(output)) return yield* executionError(output);
      return { threadId, output } as const;
    },
  );

  /**
   * Drives a meeting run until the discussion has become an executable graph.
   *
   * `nextMeetingStep` owns every transition; this loop only performs the I/O the
   * step asks for and persists what came back, so a crash resumes by replaying
   * the same decision against the stored meeting. Returns false when the run is
   * parked on a question for the person — the answer event re-enqueues it.
   */
  const runMeetingPhase = Effect.fn("WorkspaceCollaborationReactor.runMeetingPhase")(
    function* (input: {
      readonly runRef: RunRef;
      readonly bindings: ReadonlyArray<WorkspaceAgentRoleBinding>;
      readonly workspacePrompt: string;
    }) {
      const ensureTurnBudget = (key: string) =>
        Effect.gen(function* () {
          const current = yield* requireRunContinuable(input.runRef);
          const failure = current.meeting?.turnFailures?.find((entry) => entry.key === key);
          if (
            failure &&
            (failure.count >= MAX_MEETING_TURN_ATTEMPTS ||
              isProviderContentRefusal(failure.message) ||
              isNonRetryableWorkerError(failure.message))
          ) {
            return yield* executionError(
              isNonRetryableBillingError(failure.message)
                ? formatBillingErrorMessage(failure.message)
                : failure.message,
            );
          }
        });
      const recordTurnFailure = (key: string, message: string) =>
        Effect.gen(function* () {
          const current = yield* requireRunContinuable(input.runRef);
          const meeting = current.meeting;
          if (meeting === null) return yield* executionError("Meeting run lost its meeting state.");
          const normalizedMessage = isNonRetryableBillingError(message)
            ? formatBillingErrorMessage(message)
            : message;
          const failures = meeting.turnFailures ?? [];
          const count = (failures.find((entry) => entry.key === key)?.count ?? 0) + 1;
          yield* persistRun({
            ...current,
            meeting: {
              ...meeting,
              turnFailures: [
                ...failures.filter((entry) => entry.key !== key),
                { key, count, message: normalizedMessage },
              ],
            },
            updatedAt: yield* nowIso,
          });
          if (
            count >= MAX_MEETING_TURN_ATTEMPTS ||
            isProviderContentRefusal(normalizedMessage) ||
            isNonRetryableWorkerError(normalizedMessage)
          ) {
            return yield* executionError(normalizedMessage);
          }
          yield* Effect.logWarning("Meeting turn failed; retrying", {
            projectId: input.runRef.projectId,
            runId: input.runRef.runId,
            step: key,
            error: normalizedMessage,
          });
        });

      while (true) {
        let run = yield* requireRunContinuable(input.runRef);
        if (yield* parkPausedRun(run)) return false;
        const meeting = run.meeting;
        if (meeting === null) {
          return yield* executionError("Meeting run lost its meeting state.");
        }
        if (run.status === "queued") {
          run = yield* persistRun({
            ...run,
            status: "running",
            error: null,
            updatedAt: yield* nowIso,
          });
          continue;
        }
        if (meeting.threadId === null) {
          // The id is persisted before the thread exists; creation is deferred
          // to the first turn and is idempotent, so a crash between the two
          // cannot strand an unrecorded window.
          yield* persistRun({
            ...run,
            meeting: { ...meeting, threadId: ThreadId.make(yield* randomUUID) },
            updatedAt: yield* nowIso,
          });
          continue;
        }
        const meetingThreadId = meeting.threadId;

        let step = nextMeetingStep(meeting);
        if (step.kind === "handoff" && step.phase === "planning") {
          // The run stopped between entering planning and materializing the
          // graph; the chair simply plans again.
          step = { kind: "plan" };
        }

        switch (step.kind) {
          case "clarify": {
            const chairId = resolveChairParticipantId(meeting);
            const turn = yield* dispatchMeetingTurn({
              run,
              route: meetingAssignmentRoute(meeting, chairId),
              threadId: meetingThreadId,
              title: `오케스트라: ${run.task}`,
              prompt: buildMeetingIntakePrompt({
                task: run.task,
                workspacePrompt: input.workspacePrompt,
                meeting,
              }),
            });
            const result = yield* Effect.try({
              try: () => parseMeetingIntakeOutput(turn.output, meeting.answers.length > 0),
              catch: (error) =>
                new WorkspaceCollaborationExecutionError({
                  message: error instanceof Error ? error.message : String(error),
                }),
            });
            yield* requireRunContinuable(input.runRef);
            const updatedAt = yield* nowIso;
            if (result.kind === "question") {
              yield* persistRun({
                ...run,
                meeting: {
                  ...meeting,
                  pendingQuestion: {
                    askedByParticipantId: chairId,
                    question: result.question,
                    options: result.options,
                    context: result.context,
                    askedAt: updatedAt,
                    nodeId: null,
                  },
                },
                updatedAt,
              });
              return false;
            }
            if (result.kind === "answer") {
              yield* persistRun({
                ...run,
                status: "completed",
                meeting: { ...meeting, phase: "done" },
                finalOutput: result.answer,
                updatedAt,
              });
              return false;
            }
            yield* persistRun({ ...run, meeting: { ...meeting, phase: "discussing" }, updatedAt });
            continue;
          }
          case "awaiting-user":
            return false;
          case "handoff":
            return true;

          case "open-round": {
            yield* persistRun({
              ...run,
              meeting: {
                ...meeting,
                rounds: [
                  ...meeting.rounds,
                  {
                    index: step.roundIndex,
                    statements: [],
                    chairSummary: null,
                    consensusReached: null,
                  },
                ],
              },
              updatedAt: yield* nowIso,
            });
            continue;
          }

          case "collect-statements": {
            const roundIndex = step.roundIndex;
            const currentRun = run;
            // One shared conversation runs one turn at a time — the seats
            // speak in order, the way a table actually talks — and every
            // statement is persisted THE MOMENT it lands. A later seat's
            // failure or a restart must re-prompt only seats that never
            // actually spoke; batching the round used to replay the whole
            // table again and again.
            for (const participantId of step.speakers) {
              yield* ensureTurnBudget(`statement:${roundIndex}:${participantId}`);
              const route = meetingAssignmentRoute(meeting, participantId);
              // Reload between seats: an interjection the person made while
              // the previous seat was speaking (and a cancel) must reach the
              // very next speaker, not the next round.
              const liveRun = yield* requireRunContinuable(input.runRef);
              const liveMeeting = liveRun.meeting ?? meeting;
              const result = yield* dispatchMeetingTurn({
                run: currentRun,
                route,
                threadId: meetingThreadId,
                title: `${meeting.maxRounds === 0 ? "AI 협업" : "AI 회의"}: ${currentRun.task}`,
                prompt: buildMeetingStatementPrompt({
                  ...(yield* prepareMeetingContext(currentRun, {
                    ...meeting,
                    interjections: liveMeeting.interjections,
                  })),
                  // Later rounds argue over the transcript; only the opening
                  // round pays for the full Workspace corpus.
                  workspacePrompt: roundIndex === 0 ? input.workspacePrompt : null,
                  task: currentRun.task,
                  meeting: { ...meeting, interjections: liveMeeting.interjections },
                  participantId,
                  roundIndex,
                }),
              }).pipe(
                Effect.map((turn) => ({ kind: "spoke" as const, ...turn })),
                Effect.catchTag("WorkspaceCollaborationExecutionError", (error) =>
                  Effect.succeed({ kind: "failed" as const, message: error.message }),
                ),
              );
              if (result.kind === "failed") {
                yield* recordTurnFailure(
                  `statement:${roundIndex}:${participantId}`,
                  `Meeting statement turn for seat '${participantId}' failed: ${result.message}`,
                );
                continue;
              }
              const recordedAt = yield* nowIso;
              const freshRun = yield* requireRunContinuable(input.runRef);
              const freshMeeting = freshRun.meeting;
              if (freshMeeting === null) {
                return yield* executionError("Meeting run lost its meeting state.");
              }
              const statement: WorkspaceMeetingStatement = {
                participantId,
                content: yield* preserveBoundedOutput(
                  freshRun,
                  result.output,
                  MAX_MEETING_STATEMENT_CHARS,
                  result.output.slice(0, MAX_MEETING_STATEMENT_CHARS),
                ),
                respondsTo: parseStatementRespondsTo(result.output, freshMeeting, participantId),
                threadId: result.threadId,
                recordedAt,
              };
              const raised: WorkspaceMeetingRaisedQuestion | null = parseMeetingQuestion(
                result.output,
              );
              yield* persistRun({
                ...freshRun,
                meeting: {
                  ...freshMeeting,
                  rounds: freshMeeting.rounds.map((candidate) =>
                    candidate.index === roundIndex
                      ? { ...candidate, statements: [...candidate.statements, statement] }
                      : candidate,
                  ),
                  pendingQuestion:
                    raised === null
                      ? freshMeeting.pendingQuestion
                      : {
                          askedByParticipantId: participantId,
                          question: raised.question,
                          options: raised.options,
                          context: raised.context,
                          askedAt: recordedAt,
                          nodeId: null,
                        },
                },
                updatedAt: recordedAt,
              });
              // A seat that asks the person parks the meeting right here; the
              // seats still owing a statement speak after the answer arrives.
              if (raised !== null) break;
            }
            continue;
          }

          case "close-round": {
            const roundIndex = step.roundIndex;
            const failureKey = `close:${roundIndex}`;
            yield* ensureTurnBudget(failureKey);
            const chairId = resolveChairParticipantId(meeting);
            const route = meetingAssignmentRoute(meeting, chairId);
            const turn = yield* dispatchMeetingTurn({
              run,
              route,
              threadId: meetingThreadId,
              title: `${meeting.maxRounds === 0 ? "AI 협업" : "AI 회의"}: ${run.task}`,
              prompt: buildMeetingChairClosePrompt({
                task: run.task,
                meeting,
                roundIndex,
                ...(yield* prepareMeetingContext(run, meeting)),
              }),
            }).pipe(
              Effect.map((value) => ({ ok: true as const, ...value })),
              Effect.catchTag("WorkspaceCollaborationExecutionError", (error) =>
                Effect.succeed({ ok: false as const, message: error.message }),
              ),
            );
            if (!turn.ok) {
              yield* recordTurnFailure(failureKey, `Meeting chair close failed: ${turn.message}`);
              continue;
            }
            let verdict;
            try {
              verdict = parseChairVerdict(turn.output);
            } catch (error) {
              yield* recordTurnFailure(
                failureKey,
                `Meeting chair verdict was malformed: ${error instanceof Error ? error.message : String(error)}`,
              );
              continue;
            }
            const closedAt = yield* nowIso;
            // The nomination rides inside the stored summary because
            // `plannedSpeakers` re-derives it from there on resume.
            const nomination =
              meeting.mode === "free-form" && verdict.nextSpeakerId !== null
                ? `\n\n<t3_next_speaker>${verdict.nextSpeakerId}</t3_next_speaker>`
                : "";
            const chairSummary =
              (yield* preserveBoundedOutput(
                run,
                verdict.summary,
                MAX_MEETING_SUMMARY_CHARS - nomination.length,
                verdict.summary.slice(0, MAX_MEETING_SUMMARY_CHARS - nomination.length),
              )) + nomination;
            run = yield* persistRun({
              ...run,
              meeting: {
                ...meeting,
                rounds: meeting.rounds.map((candidate) =>
                  candidate.index === roundIndex
                    ? {
                        ...candidate,
                        chairSummary,
                        consensusReached:
                          meeting.mode === "until-consensus" ? verdict.consensusReached : null,
                      }
                    : candidate,
                ),
                pendingQuestion:
                  verdict.question === null
                    ? null
                    : {
                        askedByParticipantId: chairId,
                        question: verdict.question.question,
                        options: verdict.question.options,
                        context: verdict.question.context,
                        askedAt: closedAt,
                        nodeId: null,
                      },
              },
              updatedAt: closedAt,
            });
            continue;
          }

          case "ask-round-check-in": {
            const askedAt = yield* nowIso;
            const round = meeting.rounds.find((candidate) => candidate.index === step.roundIndex);
            run = yield* persistRun({
              ...run,
              meeting: {
                ...meeting,
                pendingQuestion: {
                  askedByParticipantId: null,
                  question: step.question,
                  options: ["계속 진행", "방향 수정"],
                  context: round?.chairSummary ?? "",
                  askedAt,
                  nodeId: null,
                },
              },
              updatedAt: askedAt,
            });
            continue;
          }

          case "ask-wrap-up": {
            const askedAt = yield* nowIso;
            const finalRound = meeting.rounds.at(-1);
            const consensusNote =
              meeting.mode === "until-consensus" && finalRound?.consensusReached === false
                ? "의장 판단: 아직 합의에 도달하지 못했습니다 — 라운드 추가를 고려하세요.\n\n"
                : "";
            run = yield* persistRun({
              ...run,
              meeting: {
                ...meeting,
                pendingQuestion: {
                  askedByParticipantId: null,
                  question: step.question,
                  options: ["합의대로 실행 시작", "라운드 1회 추가", "여기서 종료 (실행 없음)"],
                  context: `${consensusNote}${finalRound?.chairSummary ?? ""}`,
                  askedAt,
                  nodeId: null,
                },
              },
              updatedAt: askedAt,
            });
            continue;
          }

          case "conclude": {
            // The person took the conclusions and declined execution: the
            // discussion itself is the deliverable.
            const concludedAt = yield* nowIso;
            const finalRound = meeting.rounds.at(-1);
            yield* persistRun({
              ...run,
              meeting: { ...meeting, phase: "done" },
              status: "completed",
              finalOutput: [
                "## 회의 결론",
                ...(finalRound?.chairSummary == null ? [] : [finalRound.chairSummary]),
                "",
                "## 회의 전문",
                renderMeetingTranscript(meeting),
              ].join("\n"),
              error: null,
              updatedAt: concludedAt,
            });
            const settled = yield* getRun(input.runRef);
            if (settled.status === "completed") yield* captureRunMemory(settled);
            return false;
          }

          case "plan": {
            if (run.workflow) {
              let assignments: ReturnType<typeof parseWorkflowAssignments> | undefined;
              if (workflowNeedsAssignment(run)) {
                yield* ensureTurnBudget("workflow-assignment");
                if (meeting.phase === "discussing") {
                  yield* persistRun({
                    ...run,
                    meeting: { ...meeting, phase: "planning" },
                    updatedAt: yield* nowIso,
                  });
                  continue;
                }
                const chairId = resolveChairParticipantId(meeting);
                const failureCount =
                  meeting.turnFailures?.find((entry) => entry.key === "workflow-assignment")
                    ?.count ?? 0;
                const turn = yield* dispatchMeetingTurn({
                  run,
                  route: meetingAssignmentRoute(meeting, chairId),
                  threadId: meetingThreadId,
                  title: `워크플로 담당자 배정: ${run.task}`,
                  executionNodeId: WorkspaceTaskNodeId.make("workflow-assignment"),
                  executionId: ProviderExecutionId.make(
                    `workflow-assignment:${run.id}:${meeting.continuation?.cycle ?? 0}:${meeting.answers.length}:${failureCount}`,
                  ),
                  prompt: buildWorkflowAssignmentPrompt(
                    run,
                    input.workspacePrompt,
                    (yield* prepareMeetingContext(run, meeting)).preparedTranscript,
                  ),
                  usagePhase: "planning",
                }).pipe(
                  Effect.map((value) => ({ ok: true as const, ...value })),
                  Effect.catchTag("WorkspaceCollaborationExecutionError", (error) =>
                    Effect.succeed({ ok: false as const, message: error.message }),
                  ),
                );
                if (!turn.ok) {
                  if (isProviderContentRefusal(turn.message)) {
                    const current = yield* requireRunContinuable(input.runRef);
                    if (yield* parkPausedRun(current)) return false;
                    const updatedAt = yield* nowIso;
                    const parked = yield* Effect.try({
                      try: () => parkRefusedWorkflowAssignment(current, turn.message, updatedAt),
                      catch: (cause) =>
                        executionError(cause instanceof Error ? cause.message : String(cause)),
                    });
                    yield* persistGraphRun(
                      {
                        ...current,
                        meeting: {
                          ...current.meeting!,
                          phase: "executing",
                          pendingQuestion: parked.question,
                        },
                      },
                      parked.graph,
                      input.bindings,
                      { status: "running", error: null, updatedAt },
                    );
                    return true;
                  }
                  yield* recordTurnFailure("workflow-assignment", turn.message);
                  continue;
                }
                run = yield* requireRunContinuable(input.runRef);
                if (yield* parkPausedRun(run)) return false;
                const latestMeeting = run.meeting;
                if (latestMeeting === null)
                  return yield* executionError("Meeting state is missing.");
                const raised = parseMeetingQuestion(turn.output);
                if (raised !== null && !turn.output.includes("<t3_workflow_assignments>")) {
                  const askedAt = yield* nowIso;
                  yield* persistRun({
                    ...run,
                    meeting: {
                      ...latestMeeting,
                      pendingQuestion: {
                        askedByParticipantId: chairId,
                        question: raised.question,
                        options: raised.options,
                        context: raised.context,
                        askedAt,
                        nodeId: null,
                      },
                    },
                    updatedAt: askedAt,
                  });
                  continue;
                }
                try {
                  assignments = parseWorkflowAssignments(run, turn.output);
                } catch (error) {
                  yield* recordTurnFailure(
                    "workflow-assignment",
                    `감독 AI의 작업자 배정을 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  continue;
                }
              }
              const graph = yield* Effect.try({
                try: () => compileWorkflowRun(run, assignments),
                catch: (cause) =>
                  executionError(cause instanceof Error ? cause.message : String(cause)),
              });
              yield* persistGraphRun(
                {
                  ...run,
                  meeting: {
                    ...run.meeting!,
                    phase: "executing",
                    supervisorReviewedInterjections: meeting.interjections.length,
                  },
                },
                graph,
                input.bindings,
                { status: "running", updatedAt: yield* nowIso },
              );
              return true;
            }
            yield* ensureTurnBudget("plan");
            const planningMeeting = meetingWithAuthorizedSeats(meeting);
            const providers = yield* Effect.forEach(
              yield* providerInstanceRegistry.listInstances,
              (instance) =>
                instance.enabled && instance.snapshot !== undefined
                  ? instance.snapshot.getSnapshot.pipe(Effect.map(Option.some))
                  : Effect.succeed(Option.none()),
              { concurrency: 4 },
            );
            const availableWorkers = orchestraWorkerCandidates(
              providers.flatMap((provider) => (Option.isSome(provider) ? [provider.value] : [])),
              planningMeeting,
            );
            if (meeting.phase === "discussing") {
              // Entering planning is persisted on its own so a crash mid-plan
              // resumes as "plan again" rather than replaying the discussion.
              run = yield* persistRun({
                ...run,
                meeting: { ...meeting, phase: "planning" },
                updatedAt: yield* nowIso,
              });
              continue;
            }
            const chairId = resolveChairParticipantId(meeting);
            if (!planningMeeting.participants.some((seat) => seat.id === chairId)) {
              yield* recordTurnFailure(
                "plan",
                "The configured conductor is not in the user-selected roster.",
              );
              continue;
            }
            const route = meetingAssignmentRoute(meeting, chairId);
            const turn = yield* dispatchMeetingTurn({
              run,
              route,
              threadId: meetingThreadId,
              title: `${meeting.maxRounds === 0 ? "AI 협업" : "AI 회의"}: ${run.task}`,
              prompt: buildMeetingPlanPrompt({
                ...(yield* prepareMeetingContext(run, planningMeeting)),
                workspacePrompt: input.workspacePrompt,
                task: run.task,
                meeting: planningMeeting,
                availableWorkers,
              }),
              usagePhase: "planning",
            }).pipe(
              Effect.map((value) => ({ ok: true as const, ...value })),
              Effect.catchTag("WorkspaceCollaborationExecutionError", (error) =>
                Effect.succeed({ ok: false as const, message: error.message }),
              ),
            );
            if (!turn.ok) {
              yield* recordTurnFailure("plan", `Meeting planning turn failed: ${turn.message}`);
              continue;
            }
            run = yield* requireRunContinuable(input.runRef);
            if (yield* parkPausedRun(run)) return false;
            const raised = parseMeetingQuestion(turn.output);
            if (raised !== null && !turn.output.includes("<t3_task_graph>")) {
              const askedAt = yield* nowIso;
              run = yield* persistRun({
                ...run,
                meeting: {
                  ...meeting,
                  pendingQuestion: {
                    askedByParticipantId: chairId,
                    question: raised.question,
                    options: raised.options,
                    context: raised.context,
                    askedAt,
                    nodeId: null,
                  },
                },
                updatedAt: askedAt,
              });
              continue;
            }
            const occurredAt = yield* nowIso;
            let graph: WorkspaceTaskGraph;
            let assignedMeeting = meeting;
            try {
              const planContext = {
                ...meetingPlanContext(planningMeeting),
                participantIds: [...planningMeeting.participants, ...availableWorkers].map(
                  (seat) => seat.id,
                ),
              };
              const proposal = parseWorkspaceTaskGraphProposal(turn.output, planContext);
              assignedMeeting = seatAssignedWorkers(meeting, availableWorkers, proposal.nodes);
              const finalRound = meeting.rounds.at(-1);
              const agreement = [
                "## 회의 합의",
                proposal.summary,
                ...(finalRound?.chairSummary == null
                  ? []
                  : ["", "## 마지막 의장 정리", finalRound.chairSummary]),
                "",
                "## 회의 전문",
                renderMeetingTranscript(meeting),
              ].join("\n");
              graph = materializeWorkspaceTaskGraphPlan({
                graph: buildMeetingSeededTaskGraph({
                  task: run.task,
                  agreement,
                  chairParticipantId: chairId,
                  occurredAt,
                }),
                proposal,
                bindings: input.bindings,
                meeting: planContext,
                occurredAt,
              });
            } catch (error) {
              yield* recordTurnFailure(
                "plan",
                `Meeting plan was rejected: ${error instanceof Error ? error.message : String(error)}`,
              );
              continue;
            }
            run = yield* persistGraphRun(
              {
                ...run,
                meeting: {
                  ...assignedMeeting,
                  phase: "executing",
                  supervisorReviewedInterjections: meeting.interjections.length,
                },
              },
              {
                ...graph,
                ...(meeting.workspaceBaseline === undefined
                  ? {}
                  : { workspaceBaseline: meeting.workspaceBaseline }),
              },
              input.bindings,
              { status: "running", error: null, updatedAt: occurredAt },
            );
            continue;
          }
        }
      }
    },
  );

  const chooseAttemptRoute = Effect.fn("WorkspaceCollaborationReactor.chooseAttemptRoute")(
    function* (
      node: WorkspaceTaskNode,
      bindings: ReadonlyArray<WorkspaceAgentRoleBinding>,
      meeting: WorkspaceMeeting | null,
    ) {
      const route = resolveNodeAssignmentRoute({ node, meeting, bindings });
      if (route === null) {
        return yield* executionError(
          node.participantId === null && meeting !== null
            ? `통합 작업 단계 '${node.id}'에 선택된 참가자가 없습니다.`
            : node.participantId === null
              ? `Enabled role '${node.role}' is required for '${node.id}'.`
              : `Meeting participant '${node.participantId}' is required for '${node.id}'.`,
        );
      }
      if (node.attempts.length === 0) {
        return {
          route,
          modelSelection: route.modelSelection,
          strategy: "Primary role route selected by the validated task graph.",
        } as const;
      }
      const formatFailure = latestFormatFailure(node);
      if (formatFailure !== undefined) {
        return {
          route,
          modelSelection:
            node.participantId === null ? formatFailure.modelSelection : route.modelSelection,
          strategy:
            "Repair only the output format on the same account and model. Preserve completed work and original evidence.",
        } as const;
      }

      // A seat is an account the person named. Retrying it on a *different*
      // account would silently execute as someone they did not pick, so a
      // meeting node re-runs on its own seat with a changed approach instead.
      if (node.participantId !== null) {
        const previous = node.attempts.at(-1);
        return {
          route,
          modelSelection: route.modelSelection,
          // A completed previous attempt means the node parked on a question
          // rather than failing; the re-run applies the person's answer.
          strategy:
            previous?.status === "completed"
              ? "Resume after the user's answer. Apply the recorded user decisions and finish the node."
              : `Previous attempt failed (${previous?.failureClassification ?? "unknown"}). Stay on this participant's account and use a materially different method, verifying the failure cause first.`,
        } as const;
      }

      const previous = node.attempts.at(-1);
      return {
        route,
        modelSelection: route.modelSelection,
        strategy: `Previous attempt failed (${previous?.failureClassification ?? "unknown"}). Keep the selected account and model, use a materially different method, and verify the failure cause first.`,
      } as const;
    },
  );

  /**
   * Ensure every write chain represented in the wave has its worktree before
   * any of its nodes start. Failures do not fail the wave here — they come
   * back as per-chain errors and surface through the nodes' normal failure
   * path, so the retry budget and the intervention question still apply.
   */
  const provisionWaveChains = Effect.fn("WorkspaceCollaborationReactor.provisionWaveChains")(
    function* (input: {
      readonly run: WorkspaceCollaborationRun;
      readonly graph: WorkspaceTaskGraph;
      readonly waveNodes: ReadonlyArray<WorkspaceTaskNode>;
      readonly chains: ReadonlyArray<WorkspaceWriteChain>;
      readonly chainIndex: ReadonlyMap<string, string>;
    }) {
      const assignments = new Map<string, { worktreePath: string; branch: string }>();
      const errors = new Map<string, string>();
      const waveChainKeys = [
        ...new Set(
          input.waveNodes
            .map((node) => input.chainIndex.get(String(node.id)))
            .filter((key): key is string => key !== undefined),
        ),
      ];
      if (waveChainKeys.length === 0) return { assignments, errors };
      const failAll = (message: string) => {
        for (const key of waveChainKeys) if (!assignments.has(key)) errors.set(key, message);
        return { assignments, errors };
      };
      const project = yield* projectionSnapshotQuery.getProjectShellById(input.run.projectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (project === null) return failAll("Workspace is unavailable for worktree provisioning.");
      const workspaceCwd = yield* runWorkspaceCwd(input.run);
      const status = yield* gitWorkflow
        .localStatus({ cwd: workspaceCwd })
        .pipe(Effect.orElseSucceed(() => null));
      const baseBranch = status?.isRepo === true ? status.refName : null;
      if (baseBranch === null) {
        return failAll(
          "Worktree isolation needs the project root on a git branch; none was found.",
        );
      }
      const nodesById = new Map(input.graph.nodes.map((node) => [String(node.id), node]));
      for (const chainKey of waveChainKeys) {
        const chain = input.chains.find((candidate) => candidate.key === chainKey);
        if (chain === undefined) continue;
        const members = chain.nodeIds
          .map((id) => nodesById.get(String(id)))
          .filter((node): node is WorkspaceTaskNode => node !== undefined);
        const existing = members.find((member) => member.worktreePath !== null) ?? null;
        const branch =
          existing?.branch ?? buildOrchestraWorktreeBranchName(String(input.run.id), chainKey);
        const provisioned = yield* worktreeProvision
          .provision({
            projectCwd: workspaceCwd,
            baseBranch,
            branch,
            existingWorktreePath: existing?.worktreePath ?? null,
            reattachExisting: true,
          })
          .pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );
        if (!provisioned.ok) {
          errors.set(chainKey, `Worktree provisioning failed: ${provisioned.error.message}`);
          continue;
        }
        if (!provisioned.result.reused) {
          const script = setupProjectScript(project.scripts);
          if (script !== null) {
            const setup = yield* worktreeProvision.runSetupGate({
              script: { id: script.id, name: script.name, command: script.command },
              worktreePath: provisioned.result.worktreePath,
              env: projectScriptRuntimeEnv({
                project: { cwd: project.workspaceRoot },
                worktreePath: provisioned.result.worktreePath,
              }),
            });
            if (setup.status === "failed") {
              errors.set(
                chainKey,
                `Worktree setup script '${script.name}' failed (${
                  setup.timedOut ? "timed out" : `exit ${setup.exitCode ?? "unknown"}`
                }): ${setup.outputTail}`,
              );
              continue;
            }
          }
        }
        assignments.set(chainKey, {
          worktreePath: provisioned.result.worktreePath,
          branch: provisioned.result.refName,
        });
      }
      return { assignments, errors };
    },
  );

  const startGraphWave = Effect.fn("WorkspaceCollaborationReactor.startGraphWave")(
    function* (input: {
      readonly run: WorkspaceCollaborationRun;
      readonly bindings: ReadonlyArray<WorkspaceAgentRoleBinding>;
      readonly nodes: ReadonlyArray<WorkspaceTaskNode>;
      readonly width?: number;
    }) {
      if (input.run.graph === null) return yield* executionError("Task graph is unavailable.");
      if (
        input.nodes.some((node) =>
          input.run.graph?.workflowAssignment?.pendingNodeIds.includes(node.id),
        )
      )
        return yield* executionError("담당자가 아직 정해지지 않은 단계는 실행할 수 없습니다.");
      // Execution sessions share one durable conversation. Writes run alone
      // unless each write chain owns a worktree.
      const isolated = isolatesWorktrees(input.run);
      const chains = isolated ? computeWriteChains(input.run.graph.nodes) : [];
      const chainIndex = chainKeyByNodeId(chains);
      const waveNodes = selectGraphWaveNodes(input.nodes, {
        width: input.width ?? graphWaveWidth(input.run),
        soloWrites: soloWriteWaves(input.run),
        chainByNodeId: chainIndex,
      });
      const provisioning = isolated
        ? yield* provisionWaveChains({
            run: input.run,
            graph: input.run.graph,
            waveNodes,
            chains,
            chainIndex,
          })
        : {
            assignments: new Map<string, { worktreePath: string; branch: string }>(),
            errors: new Map<string, string>(),
          };
      const ownerThreadId =
        input.run.meeting?.threadId ??
        input.run.workflow?.threadId ??
        input.run.runContext?.threadId ??
        input.run.steps.find((step) => step.threadId !== null)?.threadId ??
        input.run.graph.nodes.find((node) => node.threadId !== null)?.threadId ??
        ThreadId.make(yield* randomUUID);
      const owner = yield* projectionSnapshotQuery.getThreadRuntimeContext(ownerThreadId);
      if (Option.isNone(owner)) {
        const route =
          input.run.meeting === null
            ? input.bindings.find((binding) => binding.role === "coordinator" && binding.enabled)
            : meetingAssignmentRoute(
                input.run.meeting,
                resolveChairParticipantId(input.run.meeting),
              );
        if (route === undefined)
          return yield* executionError("오케스트라 지휘 AI 설정이 없습니다.");
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`orchestra-conversation:${input.run.id}`),
          threadId: ownerThreadId,
          projectId: input.run.projectId,
          title: `오케스트라: ${input.run.task.slice(0, 70)}`,
          modelSelection: route.modelSelection,
          runtimeMode: route.runtimeMode,
          interactionMode: route.interactionMode,
          branch: null,
          worktreePath: null,
          orchestraRunThreadId: null,
          createdAt: yield* nowIso,
        });
      }
      const startedNodes = yield* Effect.forEach(
        waveNodes,
        (node) =>
          Effect.gen(function* () {
            const route = yield* chooseAttemptRoute(node, input.bindings, input.run.meeting);
            const startedAt = yield* nowIso;
            const chainKey = chainIndex.get(String(node.id));
            const assignment =
              chainKey === undefined ? undefined : provisioning.assignments.get(chainKey);
            const nodeThreadId = ownerThreadId;
            const attempt: WorkspaceTaskAttempt = {
              number: node.attempts.length + 1,
              agent: node.agent,
              role: node.role,
              modelSelection: route.modelSelection,
              runtimeMode: route.route.runtimeMode,
              interactionMode: route.route.interactionMode,
              strategy: route.strategy,
              threadId: nodeThreadId,
              status: "running",
              output: null,
              error: null,
              failureClassification: null,
              confidence: null,
              startedAt,
              completedAt: null,
            };
            return {
              ...node,
              ...(assignment !== undefined
                ? { worktreePath: assignment.worktreePath, branch: assignment.branch }
                : {}),
              threadId: nodeThreadId,
              status: "running" as const,
              ...(node.usageRecovery
                ? { usageRecovery: { ...node.usageRecovery, phase: "resumed" as const } }
                : {}),
              attempts: [...node.attempts, attempt],
              output: null,
              error: null,
              startedAt: node.startedAt ?? startedAt,
              completedAt: null,
            };
          }),
        { concurrency: 1 },
      );
      const replacements = new Map(startedNodes.map((node) => [String(node.id), node]));
      const graph = {
        ...input.run.graph,
        status: startedNodes.some((node) => node.kind === "validation")
          ? ("validating" as const)
          : startedNodes.some((node) => node.kind === "synthesis")
            ? ("synthesizing" as const)
            : input.run.graph.status,
        nodes: input.run.graph.nodes.map((node) => {
          const started = replacements.get(String(node.id));
          if (started !== undefined) return started;
          if (node.status !== "queued" && node.status !== "blocked") return node;
          // Chain members outside the wave adopt the chain's worktree now, so
          // a validation gate scheduled later already knows where to run and
          // the dashboard can offer the diff before the whole chain settles.
          const chainKey = chainIndex.get(String(node.id));
          const assignment =
            chainKey === undefined ? undefined : provisioning.assignments.get(chainKey);
          if (assignment === undefined || node.worktreePath !== null)
            return { ...node, threadId: ownerThreadId };
          return {
            ...node,
            threadId: ownerThreadId,
            worktreePath: assignment.worktreePath,
            branch: assignment.branch,
          };
        }),
        nextAction: `실행 중: ${startedNodes.map((node) => node.title).join(", ")}`,
      };
      const persisted = yield* persistGraphRun(input.run, graph, input.bindings, {
        status: "running",
        error: null,
        updatedAt: yield* nowIso,
      });
      const provisionErrors = new Map<string, string>();
      for (const node of waveNodes) {
        const chainKey = chainIndex.get(String(node.id));
        const error = chainKey === undefined ? undefined : provisioning.errors.get(chainKey);
        if (error !== undefined) provisionErrors.set(String(node.id), error);
      }
      return { run: persisted, provisionErrors };
    },
  );

  const executeGraphWave = Effect.fn("WorkspaceCollaborationReactor.executeGraphWave")(
    function* (input: {
      readonly run: WorkspaceCollaborationRun;
      readonly bindings: ReadonlyArray<WorkspaceAgentRoleBinding>;
      readonly workspacePrompt: string;
      readonly provisionErrors?: ReadonlyMap<string, string>;
      readonly nodeIds?: ReadonlySet<string>;
      readonly resultLock?: Semaphore.Semaphore;
    }) {
      if (input.run.graph === null) return yield* executionError("Task graph is unavailable.");
      const graph = input.run.graph;
      const running = graph.nodes.filter(
        (node) =>
          node.status === "running" &&
          (input.nodeIds === undefined || input.nodeIds.has(String(node.id))),
      );
      const isolated = isolatesWorktrees(input.run);
      const chainIndex = isolated ? chainKeyByNodeId(computeWriteChains(graph.nodes)) : null;
      const compatibilitySteps = graphCompatibilitySteps(graph, input.bindings, input.run.meeting);
      // On a meeting run the roster is the cast; the project's role bindings are
      // not consulted and must not be advertised as available executors.
      const availableAgents =
        input.run.meeting !== null
          ? input.run.meeting.participants.map(
              (participant) =>
                `${participant.id}: ${participant.displayName} -> ${participant.modelSelection.instanceId} / ${participant.modelSelection.model}`,
            )
          : input.bindings
              .filter(
                (binding) =>
                  binding.enabled &&
                  ["coordinator", "implementer", "researcher"].includes(binding.role),
              )
              .map(
                (binding) =>
                  `${binding.role}: ${binding.modelSelection.instanceId} / ${binding.modelSelection.model}`,
              );
      // Steps mirror the nodes in (order, id) order; matching by position keeps
      // the lookup exact even when several nodes share one seat thread.
      const sortedNodeIds = graph.nodes
        .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id))
        .map((node) => String(node.id));
      const executeNode = (node: WorkspaceTaskNode) => {
        const provisionError = input.provisionErrors?.get(String(node.id));
        if (provisionError !== undefined) {
          return settledResult({ nodeId: String(node.id), error: provisionError });
        }
        // A crash between marking the wave and persisting its provisioning
        // can resume a chain node without a worktree; running it would edit
        // the project root the isolation promised to protect.
        if (isolated && chainIndex?.has(String(node.id)) === true && node.worktreePath === null) {
          return settledResult({
            nodeId: String(node.id),
            error: `Node '${node.id}' resumed without its chain worktree; it will be re-provisioned on retry.`,
          });
        }
        const attempt = node.attempts.at(-1);
        if (attempt === undefined) {
          return settledResult({
            nodeId: String(node.id),
            error: `Running node '${node.id}' has no attempt.`,
          });
        }
        const step = compatibilitySteps[sortedNodeIds.indexOf(String(node.id))];
        if (step === undefined) {
          return settledResult({
            nodeId: String(node.id),
            error: `Running node '${node.id}' has no compatibility step.`,
          });
        }
        return Effect.gen(function* () {
          const rawGraphV2 = input.run.workflow?.definition.graphV2;
          if (rawGraphV2 !== undefined) {
            const decodedGraphV2 = Schema.decodeUnknownOption(WorkflowGraphV2)(rawGraphV2);
            if (Option.isSome(decodedGraphV2)) {
              const projectShell = yield* projectionSnapshotQuery.getProjectShellById(
                input.run.projectId,
              );
              const targetCwd =
                node.worktreePath ??
                (Option.isSome(projectShell) ? projectShell.value.workspaceRoot : process.cwd());
              const special = yield* tryExecuteWorkflowV2SpecialNode({
                graphV2: decodedGraphV2.value,
                nodeId: String(node.id),
                cwd: targetCwd,
                workflowValues: input.run.workflow!.values,
                nodeOutputs: graph.nodes.map((entry) => ({
                  id: String(entry.id),
                  status: entry.status,
                  output: entry.output,
                })),
              });
              if (special.handled) {
                if (!special.passed) {
                  return yield* executionError(
                    special.error ?? `결정론적 v2 단계 "${node.id}" 검증에 실패했습니다.`,
                  );
                }
                return special.output;
              }
            }
          }
          const formatFailure = latestFormatFailure(node);
          let formatRepairOutput: string | undefined;
          if (formatFailure !== undefined) {
            formatRepairOutput = verifiedFormatRepairOutput(formatFailure, formatFailure.output);
            if (formatRepairOutput === undefined) {
              const originalThread = yield* loadThread(
                { projectId: input.run.projectId, runId: input.run.id },
                formatFailure.threadId,
              );
              const originalMessage = Option.isSome(originalThread)
                ? originalThread.value.messages.find(
                    (message) =>
                      message.id === formatFailure.formatRepair?.messageId &&
                      message.role === "assistant" &&
                      !message.streaming,
                  )
                : undefined;
              formatRepairOutput = verifiedFormatRepairOutput(formatFailure, originalMessage?.text);
            }
            if (formatRepairOutput === undefined)
              return yield* executionError(
                "형식 복구의 원본 산출물을 확인할 수 없습니다. 본 작업은 재실행하지 않았습니다.",
              );
          }
          const compose =
            projectionSnapshotQuery.composeWorkspacePromptForExecution ??
            projectionSnapshotQuery.composeWorkspacePrompt;
          const needsOptionalMemory = formatFailure === undefined;
          const runFolder = yield* resolveRunFolder(input.run);
          const nodeContext =
            compose !== undefined && !runFolder.unavailable
              ? yield* compose({
                  projectId: input.run.projectId,
                  task:
                    formatFailure === undefined
                      ? node.handoff.task
                      : "Repair only the representation of the existing output. Do not repeat the original work.",
                  ...(runFolder.paths === undefined
                    ? node.handoff.contextPaths === undefined
                      ? {}
                      : { contextPaths: node.handoff.contextPaths }
                    : { contextPaths: runFolder.paths }),
                  includeShared: false,
                  includeSharedLibrary: false,
                  contextMode: "relevant",
                  includeRag: needsOptionalMemory,
                  includeWorkingMemory: needsOptionalMemory,
                  includeLongTermMemory: needsOptionalMemory,
                  maxContextChars: !needsOptionalMemory
                    ? 8_000
                    : node.kind === "research" || node.role === "researcher"
                      ? 8_000
                      : 24_000,
                })
              : null;
          const nodePrompt = `${nodeContext?.prompt ?? input.workspacePrompt}${runFolder.unavailable ? `\n\n${folderUnavailable}` : ""}`;
          const contextSource =
            formatFailure === undefined
              ? yield* prepareContextSource(
                  input.run,
                  graph.nodes
                    .filter((dependency) => node.dependsOn.includes(dependency.id))
                    .map(
                      (dependency) =>
                        `## ${dependency.id}: ${dependency.title}\n${dependency.output ?? ""}`,
                    )
                    .join("\n\n"),
                )
              : undefined;
          if (nodeContext !== null)
            yield* recordPromptUsage({ projectId: input.run.projectId, ...nodeContext });
          const supervisorInstructions =
            input.run.meeting !== null &&
            node.participantId === resolveChairParticipantId(input.run.meeting) &&
            input.run.meeting.interjections.length > 0
              ? `\n\n사용자가 감독 AI에게 전달한 추가 지시입니다. 최신 지시가 이전 작업 계획과 충돌하면 최신 지시를 우선하여 작업을 조정하세요:\n${input.run.meeting.interjections.map((entry) => entry.text).join("\n")}`
              : "";
          const assignmentPrompt =
            graph.workflowAssignment?.gateNodeId === node.id && input.run.meeting !== null
              ? buildWorkflowAssignmentPrompt(
                  input.run,
                  nodePrompt,
                  (yield* prepareMeetingContext(input.run, input.run.meeting)).preparedTranscript,
                )
              : null;
          const unconfirmed =
            node.kind === "validation"
              ? yield* unconfirmedInstructionNotice(input.run, node.validationTargetId ?? undefined)
              : node.kind === "synthesis"
                ? yield* unconfirmedInstructionNotice(input.run)
                : "";
          return yield* ensureThreadAndTurn({
            run: input.run,
            step,
            node,
            prompt:
              (assignmentPrompt ??
                buildWorkspaceTaskNodePrompt({
                  includeWorkspaceContext: nodeContext !== null || node.kind === "orchestration",
                  ...(contextSource === undefined ? {} : { contextSource }),
                  workspacePrompt: nodePrompt,
                  run: input.run,
                  graph,
                  node,
                  availableAgents,
                  meeting: input.run.meeting,
                  ...(formatRepairOutput === undefined ? {} : { formatRepairOutput }),
                  ...(formatFailure !== undefined && nodeContext !== null
                    ? { formatRepairConstraints: nodeContext.prompt }
                    : {}),
                })) +
              supervisorInstructions +
              (unconfirmed
                ? `\n\n${unconfirmed}\n처리 확인이 없는 지시가 적용됐다고 단정하지 마세요.`
                : ""),
            title: node.participantId === null ? `${node.role}: ${node.title}` : node.title,
            // A seat's account is whatever the person picked; only role-bound
            // nodes pin the provider driver to the agent.
            ...(node.participantId === null ? { expectedAgent: node.agent } : {}),
            ...(node.worktreePath !== null
              ? { worktree: { worktreePath: node.worktreePath, branch: node.branch } }
              : {}),
            // Anchors this attempt's turn inside the seat's reused conversation.
            turnAfter: attempt.startedAt,
            usageContext: {
              workId: input.run.id,
              nodeId: node.id,
              phase:
                formatFailure !== undefined
                  ? "format-repair"
                  : node.kind === "validation"
                    ? "verification"
                    : node.kind === "orchestration" || node.kind === "research"
                      ? "planning"
                      : node.kind === "synthesis"
                        ? "finalization"
                        : "implementation",
              attempt: attempt.number,
            },
          });
        }).pipe(
          Effect.map((output) => ({ nodeId: String(node.id), output })),
          Effect.catchTag("WorkspaceCollaborationExecutionError", (error) =>
            settledResult({
              nodeId: String(node.id),
              error: error.message,
              ...(error.interrupted === true ? { interrupted: true } : {}),
            }),
          ),
        );
      };
      const resultLock = input.resultLock ?? (yield* Semaphore.make(1));
      yield* Effect.forEach(
        running,
        (node) =>
          executeNode(node).pipe(
            Effect.flatMap((result) =>
              resultLock.withPermit(
                Effect.gen(function* () {
                  const current = yield* requireRunContinuable({
                    projectId: input.run.projectId,
                    runId: input.run.id,
                  });
                  yield* applyGraphWaveResults({
                    run: current,
                    bindings: input.bindings,
                    results: [result],
                  });
                }),
              ),
            ),
          ),
        { concurrency: graphWaveWidth(input.run), discard: true },
      );
      return yield* requireRunContinuable({ projectId: input.run.projectId, runId: input.run.id });
    },
  );

  const retryGraphNode = (input: {
    readonly graph: WorkspaceTaskGraph;
    readonly node: WorkspaceTaskNode;
    readonly error: string;
    readonly classification: WorkspaceFailureClassification;
    readonly completedAt: string;
    readonly revisionCap: number;
    /**
     * A reply the parser rejected is a formatting miss, not a plan problem, so
     * it re-asks for free: charging it to the shared revision budget let a few
     * malformed blocks anywhere in the graph strand every later node on
     * "Task graph revision limit N has been reached." Defaults to charging.
     */
    readonly consumesRevision?: boolean;
  }): WorkspaceTaskGraph => {
    const error = redactConversationRagSensitiveData(input.error).content.slice(0, 6_000);
    const consumesRevision =
      !isWorkspaceProviderUnavailable(input.error) &&
      !isDeterministicWorkspaceRequestFailure(input.error) &&
      (input.consumesRevision ?? true);
    const repairSource = latestFormatFailure(input.node);
    const failedAttemptNode = updateLastAttempt(input.node, (attempt) => ({
      ...attempt,
      status: "failed",
      output: attempt.output,
      ...(input.classification === "tool" && repairSource?.formatRepair !== undefined
        ? { formatRepair: repairSource.formatRepair, output: repairSource.output }
        : {}),
      error,
      failureClassification: input.classification,
      completedAt: input.completedAt,
    }));
    const mayRetry =
      !isProviderContentRefusal(input.error) &&
      !isWorkspaceProviderUnavailable(input.error) &&
      !isDeterministicWorkspaceRequestFailure(input.error) &&
      failedAttemptNode.attempts.length < failedAttemptNode.maxAttempts &&
      (!consumesRevision || input.graph.revision < input.revisionCap);
    const node: WorkspaceTaskNode = {
      ...failedAttemptNode,
      status: mayRetry ? "queued" : "failed",
      output: null,
      error,
      failureClassification: input.classification,
      confidence: null,
      validation: null,
      completedAt: mayRetry ? null : input.completedAt,
    };
    const revision = consumesRevision
      ? Math.min(input.graph.revision + 1, input.revisionCap)
      : input.graph.revision;
    return refreshWorkspaceTaskGraphQueue({
      ...replaceGraphNode(input.graph, String(node.id), node),
      revision,
      status: mayRetry ? input.graph.status : "failed",
      changes: [
        ...input.graph.changes,
        {
          revision,
          reason: failureChangeReason(input.classification),
          summary: mayRetry
            ? latestFormatFailure(failedAttemptNode) !== undefined
              ? `'${node.title}' 단계의 산출물 형식만 복구합니다: ${error}`
              : `'${node.title}' 단계가 실패해 선택한 계정과 모델을 유지하며 원인을 확인하고 재시도합니다: ${error}`
            : isWorkspaceProviderUnavailable(error)
              ? `'${node.title}' 단계의 선택된 연결을 복구해야 합니다: ${error}`
              : isDeterministicWorkspaceRequestFailure(error)
                ? `'${node.title}' 단계의 입력 오류를 확인해야 합니다: ${error}`
                : `'${node.title}' 단계가 재시도 한도에 도달했습니다: ${error}`,
          addedNodeIds: [],
          supersededNodeIds: mayRetry ? [] : [node.id],
          occurredAt: input.completedAt,
        },
      ],
      nextAction: mayRetry
        ? latestFormatFailure(failedAttemptNode) !== undefined
          ? `'${node.title}' 단계의 원본을 보존하고 형식만 복구합니다.`
          : `'${node.title}' 단계를 이전과 다른 경로로 재시도합니다.`
        : isWorkspaceProviderUnavailable(error)
          ? error
          : `'${node.title}' 단계가 실패해 사용자 개입이 필요합니다.`,
    });
  };

  const addRecoveryPlanningNode = (input: {
    readonly run: WorkspaceCollaborationRun;
    readonly graph: WorkspaceTaskGraph;
    readonly validationNode: WorkspaceTaskNode;
    readonly targetNode: WorkspaceTaskNode;
    readonly classification: WorkspaceFailureClassification;
    readonly changeReason?: WorkspaceTaskGraph["changes"][number]["reason"];
    readonly summary: string;
    readonly nextAction: string;
    readonly occurredAt: string;
  }): WorkspaceTaskGraph => {
    const revisionCap = graphRevisionCap(input.run.meeting);
    const revision = input.graph.revision + 1;
    if (revision > revisionCap) {
      return {
        ...input.graph,
        status: "failed",
        nextAction: `그래프 수정 한도(${revisionCap}회)에 도달해 사용자 판단이 필요합니다.`,
      };
    }
    const descendants = new Set(descendantNodeIds(input.graph, String(input.validationNode.id)));
    const supersededNodeIds: WorkspaceTaskNodeId[] = [];
    const nodes = input.graph.nodes.map((node) => {
      if (!descendants.has(String(node.id))) return node;
      if (!["blocked", "queued"].includes(node.status)) return node;
      supersededNodeIds.push(node.id);
      return { ...node, status: "skipped" as const, completedAt: input.occurredAt };
    });
    const used = new Set(nodes.map((node) => String(node.id)));
    let id = `replan-${revision}`;
    let suffix = 2;
    while (used.has(id)) id = `replan-${revision}-${suffix++}`;
    const base = buildInitialWorkspaceTaskGraph(input.run.task).nodes[0]!;
    const requiredRoute =
      input.classification === "information"
        ? "정보 부족을 해소할 research 노드를 포함하고 사용 가능한 담당자에게 배정한다."
        : input.classification === "implementation"
          ? "실패 원인을 수정할 debug 또는 implementation 노드를 포함한다."
          : input.classification === "assumption"
            ? "잘못된 가정의 영향을 받은 경로를 다시 설계한다."
            : input.classification === "validation"
              ? "독립적으로 검증할 research, implementation 또는 debug 노드를 포함한다. 사용자가 추가 조사나 질문을 중단했다면 새로운 조사를 배정하지 말고 기존 근거와 미확인 사항만 기록하는 research 노드를 사용한다. 중단된 작업을 완료했다고 주장하지 않는다."
              : "동일한 도구와 접근법을 반복하지 않는 대체 경로를 설계한다.";
    const recoveryNode: WorkspaceTaskNode = {
      ...base,
      id: WorkspaceTaskNodeId.make(id),
      order: Math.max(...nodes.map((node) => node.order), 0) + 1,
      // On a meeting run the chair, not a role binding, redesigns the graph.
      participantId:
        input.run.meeting === null ? null : resolveChairParticipantId(input.run.meeting),
      title: `${input.targetNode.title} 실패 복구 그래프 설계`,
      handoff: {
        ...base.handoff,
        task: "검증 실패 원인에 맞는 새 복구 경로를 설계한다.",
        goal: input.targetNode.handoff.goal,
        context: `${input.summary}\n\n실패 분류: ${input.classification}`,
        input: input.targetNode.output ?? input.targetNode.error ?? "검증 대상 결과 없음",
        constraints: [...base.handoff.constraints, requiredRoute],
        expectedOutput: "기존 실패 경로를 반복하지 않는 구조화된 작업 그래프",
      },
      dependsOn: [input.validationNode.id],
      status: "queued",
      failureClassification: input.classification,
    };
    const graph: WorkspaceTaskGraph = {
      ...input.graph,
      revision,
      status: "executing",
      nodes: [...nodes, recoveryNode],
      changes: [
        ...input.graph.changes,
        {
          revision,
          reason: input.changeReason ?? failureChangeReason(input.classification),
          summary: input.summary,
          addedNodeIds: [recoveryNode.id],
          supersededNodeIds,
          occurredAt: input.occurredAt,
        },
      ],
      nextAction: input.nextAction,
    };
    return refreshWorkspaceTaskGraphQueue(graph);
  };

  const applyGraphWaveResults = Effect.fn("WorkspaceCollaborationReactor.applyGraphWaveResults")(
    function* (input: {
      readonly run: WorkspaceCollaborationRun;
      readonly bindings: ReadonlyArray<WorkspaceAgentRoleBinding>;
      readonly results: ReadonlyArray<GraphNodeExecutionResult>;
    }) {
      if (input.run.graph === null) return yield* executionError("Task graph is unavailable.");
      let graph = input.run.graph;
      let finalOutput = input.run.finalOutput;
      // The wave ran for minutes; the meeting recorded in that time (the
      // person's interjections and answers land outside this fiber) must not
      // be overwritten by the snapshot the wave started from.
      const freshRun = yield* getRun({ projectId: input.run.projectId, runId: input.run.id });
      let meeting = freshRun.meeting ?? input.run.meeting;
      const planContext = meeting === null ? null : meetingPlanContext(meeting);
      const revisionCap = graphRevisionCap(meeting);

      /**
       * Retry the node, and when its budget is gone stop ON the node instead of
       * tearing the run down. `retryGraphNode` marks an exhausted node — and the
       * whole graph — failed, whose `nextAction` then read "사용자 개입이
       * 필요합니다" even though the run was already dead and there was nothing
       * left to intervene in. Parking keeps every completed node, and the
       * person's answer says whether to retry, skip, or stop here.
       */
      const failOrParkNode = (failure: {
        readonly node: WorkspaceTaskNode;
        readonly graph: WorkspaceTaskGraph;
        readonly error: string;
        readonly classification: WorkspaceFailureClassification;
        readonly completedAt: string;
        readonly consumesRevision?: boolean;
      }): WorkspaceTaskGraph => {
        const completedAt = failure.completedAt;
        // A provider's policy refusal is not the account's fault and not the
        // plan's: re-running the same seat just spends minutes to be refused
        // again. Stop on it at once, and keep the budgets for real failures.
        const refused = isProviderContentRefusal(failure.error);
        const retried = retryGraphNode({
          graph: failure.graph,
          node: failure.node,
          error: failure.error,
          classification: failure.classification,
          completedAt,
          revisionCap,
          consumesRevision: refused ? false : (failure.consumesRevision ?? true),
        });
        const settled = retried.nodes.find((node) => node.id === failure.node.id);
        // Role-based runs have no question channel. Keep independent work alive
        // after a missing provider, then finish as failed with its original reason.
        if (
          meeting === null &&
          settled?.status === "failed" &&
          isWorkspaceProviderUnavailable(failure.error)
        ) {
          const canContinue =
            retried.nodes.some((node) => node.status === "running") ||
            readyWorkspaceTaskNodes(retried).length > 0;
          return canContinue ? { ...retried, status: "executing" } : retried;
        }
        if (
          settled === undefined ||
          (settled.status !== "failed" && !refused) ||
          meeting === null
        ) {
          return retried;
        }
        const question = refused
          ? nodeRefusalQuestion(settled.title)
          : isWorkspaceProviderUnavailable(failure.error)
            ? nodeProviderUnavailableQuestion(settled.title)
            : classifyDeterministicWorkspaceFailure(failure.error) === "delivery-unconfirmed"
              ? nodeDeliveryUnconfirmedQuestion(settled.title)
              : classifyDeterministicWorkspaceFailure(failure.error) === "request-format"
                ? nodeRequestFormatQuestion(settled.title)
                : isDeterministicWorkspaceRequestFailure(failure.error)
                  ? nodeInputDataQuestion(settled.title)
                  : nodeInterventionQuestion(settled.title);
        const context = redactConversationRagSensitiveData(failure.error).content.slice(0, 20_000);
        // Only one question is open at a time. A second node out of retries
        // parks its intervention on itself and is asked once the slot frees —
        // it used to fail the whole run instead, taking every sibling's
        // finished work with it.
        const slotFree =
          meeting.pendingQuestion === null && !hasPendingSeatSelectionAnswer(meeting, retried);
        if (slotFree) {
          meeting = {
            ...meeting,
            pendingQuestion: {
              askedByParticipantId: settled.participantId,
              question,
              options: [...(refused ? NODE_REFUSAL_OPTIONS : NODE_INTERVENTION_OPTIONS)],
              context,
              askedAt: completedAt,
              nodeId: settled.id,
            },
          };
        }
        return refreshWorkspaceTaskGraphQueue({
          ...replaceGraphNode(retried, String(settled.id), {
            ...settled,
            // `awaiting-user` WITH an error is what marks this park as an
            // intervention rather than a seat's own question, which parks
            // with `error: null`. The resume path reads that difference.
            status: "awaiting-user",
            completedAt: null,
            parkedQuestion: slotFree
              ? null
              : {
                  question,
                  options: [...(refused ? NODE_REFUSAL_OPTIONS : NODE_INTERVENTION_OPTIONS)],
                  context,
                  intervention: true,
                  raisedAt: completedAt,
                },
          }),
          status: "executing",
          nextAction: slotFree ? question : graph.nextAction,
        });
      };

      for (const result of input.results) {
        const current = graph.nodes.find((node) => node.id === result.nodeId);
        if (current === undefined || current.status !== "running") continue;
        const completedAt = yield* nowIso;
        if (result.error !== undefined) {
          const safeError = redactConversationRagSensitiveData(result.error).content;
          const selection = current.attempts.at(-1)?.modelSelection;
          const instance =
            selection && input.run.orchestra?.resumeAfterLimit === true
              ? yield* providerInstanceRegistry.getInstance(selection.instanceId)
              : undefined;
          const snapshot = instance ? yield* instance.snapshot.getSnapshot : undefined;
          const recovery = planWorkspaceUsageRecovery({
            enabled: input.run.orchestra?.resumeAfterLimit === true,
            error: safeError,
            providerInstanceId: selection?.instanceId ?? "",
            ...(snapshot?.usage ? { usage: snapshot.usage } : {}),
            ...(current.usageRecovery ? { previous: current.usageRecovery } : {}),
            attempts: current.attempts.length,
            nowMs: Date.parse(completedAt),
          });
          if (recovery) {
            const waiting = updateLastAttempt(current, (attempt) => ({
              ...attempt,
              status: "failed",
              error: safeError,
              completedAt,
            }));
            graph = refreshWorkspaceTaskGraphQueue({
              ...replaceGraphNode(graph, result.nodeId, {
                ...waiting,
                status: "queued",
                error: safeError,
                completedAt: null,
                usageRecovery: recovery,
                maxAttempts: Math.min(
                  MAX_NODE_ATTEMPTS,
                  Math.max(current.maxAttempts, current.attempts.length + 1),
                ),
              }),
              nextAction: "사용량 제한 대기 · " + recovery.resumeAt + " 이후 재개",
            });
            continue;
          }
          // A turn cut off from outside — the server restarted under it, or
          // a person stopped the thread without stopping the run — is not
          // the seat's failure: the retry gets the attempt back and no plan
          // revision is charged. (Observed live: a dev-server restart spent a
          // validation node's last attempt and parked the run on a question.)
          const freeRetry =
            result.interrupted === true &&
            current.maxAttempts < MAX_NODE_ATTEMPTS &&
            grantsFreeRetryAfterInterruption(current);
          graph = failOrParkNode({
            graph,
            node: freeRetry ? { ...current, maxAttempts: current.maxAttempts + 1 } : current,
            error: safeError,
            classification: "tool",
            completedAt,
            consumesRevision: !freeRetry,
          });
          continue;
        }

        const withCompletedAttempt = updateLastAttempt(current, (attempt) => ({
          ...attempt,
          status: "completed",
          output: result.output.slice(0, MAX_ATTEMPT_RECORD_CHARS),
          error: null,
          completedAt,
        }));
        const graphBeforeResult = graph;
        const storedOutput = yield* preserveBoundedOutput(
          input.run,
          result.output,
          MAX_NODE_HANDOFF_CHARS,
          truncateNodeOutput(result.output),
        );
        try {
          if (isProviderContentRefusalOutput(result.output)) throw new Error(result.output);
          const isWorkflowAssignment = graph.workflowAssignment?.gateNodeId === current.id;
          const assignmentQuestion = isWorkflowAssignment
            ? parseMeetingQuestion(result.output)
            : null;
          if (
            isWorkflowAssignment &&
            (assignmentQuestion === null || result.output.includes("<t3_workflow_assignments>"))
          ) {
            const assignments = parseWorkflowAssignments(freshRun, result.output);
            const pending = new Set(graph.workflowAssignment!.pendingNodeIds);
            const { workflowAssignment: _assignment, ...remaining } = graph;
            graph = refreshWorkspaceTaskGraphQueue({
              ...remaining,
              nodes: graph.nodes.map((node) =>
                node.id === current.id
                  ? {
                      ...withCompletedAttempt,
                      status: "completed" as const,
                      output: storedOutput,
                      error: null,
                      completedAt,
                    }
                  : pending.has(node.id)
                    ? { ...node, participantId: assignments.get(node.id)! }
                    : node,
              ),
              nextAction: "감독자가 남은 단계의 담당자를 정했습니다.",
            });
            continue;
          }
          if (
            current.kind === "orchestration" &&
            !isWorkflowAssignment &&
            !input.run.workflow?.definition.nodes.some((node) => node.id === current.id)
          ) {
            if (graph.revision >= revisionCap) {
              throw new WorkspaceTaskGraphError(
                `Task graph revision limit ${revisionCap - INITIAL_PLAN_REVISION} has been reached.`,
              );
            }
            const parsedProposal = parseWorkspaceTaskGraphProposal(result.output, planContext);
            const recordOnlyProposal =
              current.failureClassification === null
                ? null
                : normalizeStoppedRecoveryPlan({ proposal: parsedProposal, meeting });
            const proposal = recordOnlyProposal ?? parsedProposal;
            if (
              recordOnlyProposal === null &&
              current.failureClassification === "information" &&
              !proposal.nodes.some((node) => node.kind === "research")
            ) {
              throw new WorkspaceTaskGraphError(
                "Information recovery plan requires a research node assigned to an available participant or role.",
              );
            }
            if (
              recordOnlyProposal === null &&
              current.failureClassification === "implementation" &&
              !proposal.nodes.some(
                (node) => node.kind === "debug" || node.kind === "implementation",
              )
            ) {
              throw new WorkspaceTaskGraphError(
                "Implementation recovery plan requires a debug or implementation node.",
              );
            }
            if (
              current.failureClassification === "validation" &&
              !proposal.nodes.some((node) => node.agent === "codex" || node.agent === "grok")
            ) {
              throw new WorkspaceTaskGraphError(
                "Validation recovery plan requires an independently validated research, implementation, or debug node.",
              );
            }
            const completedNode: WorkspaceTaskNode = {
              ...withCompletedAttempt,
              status: "completed",
              output: storedOutput,
              error: null,
              completedAt,
            };
            graph = replaceGraphNode(graph, result.nodeId, completedNode);
            graph = materializeWorkspaceTaskGraphPlan({
              graph,
              proposal,
              bindings: input.bindings,
              meeting: planContext,
              occurredAt: completedAt,
              anchorNodeId: result.nodeId,
              ...(current.failureClassification === null
                ? {}
                : { changeReason: failureChangeReason(current.failureClassification) }),
            });
            continue;
          }

          if (current.kind === "validation") {
            const decision = parseWorkspaceValidationDecision(result.output, planContext);
            if (current.validationTargetId === null) {
              throw new WorkspaceTaskGraphError(`Validation node '${current.id}' has no target.`);
            }
            const receipt: WorkspaceTaskValidationReceipt = {
              targetNodeId: current.validationTargetId,
              verdict: decision.verdict,
              confidence: decision.confidence,
              summary: decision.summary,
              evidence: decision.evidence,
              failureClassification: decision.failureClassification,
              nextAction: decision.nextAction,
              recordedAt: completedAt,
            };
            const validationNode: WorkspaceTaskNode = {
              ...withCompletedAttempt,
              status: "completed",
              output: storedOutput,
              error: null,
              confidence: decision.confidence,
              failureClassification: decision.failureClassification,
              validation: receipt,
              completedAt,
            };
            graph = replaceGraphNode(graph, result.nodeId, validationNode);
            const target = graph.nodes.find((node) => node.id === current.validationTargetId);
            if (target === undefined) {
              throw new WorkspaceTaskGraphError(
                `Validation target '${current.validationTargetId}' disappeared.`,
              );
            }
            const accepted = decision.verdict === "pass" && decision.confidence !== "low";
            if (accepted) {
              graph = replaceGraphNode(graph, String(target.id), {
                ...target,
                status: "completed",
                confidence: decision.confidence,
                failureClassification: null,
                error: null,
                completedAt,
              });
            } else {
              const classification = decision.failureClassification ?? "validation";
              const failedTarget: WorkspaceTaskNode = {
                ...target,
                status: "failed",
                confidence: decision.confidence,
                failureClassification: classification,
                error: decision.summary,
                completedAt,
              };
              graph = replaceGraphNode(graph, String(target.id), failedTarget);
              if (decision.followUpNodes.length > 0) {
                const recordOnlyFollowUp = normalizeStoppedRecoveryPlan({
                  proposal: {
                    summary: decision.summary,
                    nextAction: decision.nextAction,
                    nodes: decision.followUpNodes,
                  },
                  meeting,
                });
                const followUpNodes = recordOnlyFollowUp?.nodes ?? decision.followUpNodes;
                if (graph.revision >= revisionCap) {
                  throw new WorkspaceTaskGraphError(
                    `Task graph revision limit ${revisionCap - INITIAL_PLAN_REVISION} has been reached.`,
                  );
                }
                if (
                  recordOnlyFollowUp === null &&
                  classification === "information" &&
                  !followUpNodes.some((node) => node.kind === "research")
                ) {
                  throw new WorkspaceTaskGraphError(
                    "Information recovery requires a research node assigned to an available participant or role.",
                  );
                }
                if (
                  recordOnlyFollowUp === null &&
                  classification === "implementation" &&
                  !followUpNodes.some(
                    (node) => node.kind === "debug" || node.kind === "implementation",
                  )
                ) {
                  throw new WorkspaceTaskGraphError(
                    "Implementation recovery requires a debug or implementation node.",
                  );
                }
                if (
                  classification === "validation" &&
                  !followUpNodes.some((node) => node.agent === "codex" || node.agent === "grok")
                ) {
                  throw new WorkspaceTaskGraphError(
                    "Validation recovery requires an independently validated research, implementation, or debug node.",
                  );
                }
                const followUpIds = new Set(followUpNodes.map((node) => node.id));
                const knownNodes = new Map(graph.nodes.map((node) => [String(node.id), node]));
                for (const followUp of followUpNodes) {
                  for (const dependencyId of followUp.dependsOn) {
                    if (followUpIds.has(dependencyId)) continue;
                    const dependency = knownNodes.get(dependencyId);
                    if (
                      dependency === undefined ||
                      !["completed", "skipped"].includes(dependency.status)
                    ) {
                      throw new WorkspaceTaskGraphError(
                        `Follow-up node '${followUp.id}' has unavailable dependency '${dependencyId}'.`,
                      );
                    }
                  }
                }
                const descendants = new Set(descendantNodeIds(graph, String(validationNode.id)));
                const supersededNodeIds: WorkspaceTaskNodeId[] = [];
                const nodes = graph.nodes.map((node) => {
                  if (
                    !descendants.has(String(node.id)) ||
                    !["blocked", "queued"].includes(node.status)
                  ) {
                    return node;
                  }
                  supersededNodeIds.push(node.id);
                  return { ...node, status: "skipped" as const, completedAt };
                });
                graph = materializeWorkspaceTaskGraphPlan({
                  graph: { ...graph, nodes },
                  proposal: {
                    summary: decision.summary,
                    nextAction: decision.nextAction,
                    nodes: followUpNodes,
                  },
                  bindings: input.bindings,
                  meeting: planContext,
                  occurredAt: completedAt,
                  anchorNodeId: String(validationNode.id),
                  changeReason: failureChangeReason(classification),
                  supersededNodeIds,
                });
              } else {
                graph = addRecoveryPlanningNode({
                  run: input.run,
                  graph,
                  validationNode,
                  targetNode: failedTarget,
                  classification,
                  summary: decision.summary,
                  nextAction: decision.nextAction,
                  occurredAt: completedAt,
                });
              }
            }
            continue;
          }

          if (current.kind === "synthesis") {
            const synthesis = parseWorkspaceSynthesisPayload(result.output);
            if (synthesis.confidence === "low" || synthesis.conflictDetected) {
              const needsValidationNode: WorkspaceTaskNode = {
                ...withCompletedAttempt,
                status: "completed",
                output: truncateNodeOutput(synthesis.finalOutput),
                error: null,
                confidence: synthesis.confidence,
                failureClassification: "validation",
                completedAt,
              };
              graph = replaceGraphNode(graph, result.nodeId, needsValidationNode);
              graph = addRecoveryPlanningNode({
                run: input.run,
                graph,
                validationNode: needsValidationNode,
                targetNode: needsValidationNode,
                classification: "validation",
                changeReason: synthesis.conflictDetected ? "result-conflict" : "low-confidence",
                summary: synthesis.conflictDetected
                  ? "검증된 결과 사이의 충돌이 남아 추가 교차 검증이 필요합니다."
                  : "최종 합성 신뢰도가 낮아 추가 교차 검증이 필요합니다.",
                nextAction: synthesis.nextAction,
                occurredAt: completedAt,
              });
              continue;
            }
            const skipped = new Set(graph.workflowSkippedNodeIds ?? []);
            const unperformed = graph.nodes.filter((node) => skipped.has(node.id));
            const workflowResult = unperformed.length
              ? [
                  synthesis.finalOutput,
                  "\n미수행 단계: 사용자가 배정을 건너뛰어 다음 단계와 종속 작업은 실행하지 않았습니다.",
                  ...unperformed.map((node) => `- ${node.title} (${node.id})`),
                ].join("\n")
              : synthesis.finalOutput;
            const recordedStop = current.dependsOn.some((id) => {
              const validation = graph.nodes.find((node) => node.id === id);
              const target = graph.nodes.find((node) => node.id === validation?.validationTargetId);
              return target?.handoff.constraints.includes(STOPPED_RECOVERY_CONSTRAINT) === true;
            });
            const unresolved = graph.nodes.filter((node) => node.status === "failed");
            const resultBeforeMailboxNotice =
              recordedStop && unresolved.length > 0
                ? [
                    workflowResult,
                    "\n사용자의 지시에 따라 추가 조사는 중단하고 기존 내용을 기록했습니다. 다음 실패 단계는 해결되지 않았습니다:",
                    ...unresolved.map((node) => `- ${node.title} (${node.id})`),
                  ].join("\n")
                : workflowResult;
            const mailboxNotice = yield* unconfirmedInstructionNotice(input.run);
            const finalResult = mailboxNotice
              ? `${resultBeforeMailboxNotice}\n\n${mailboxNotice}`
              : resultBeforeMailboxNotice;
            const completedNode: WorkspaceTaskNode = {
              ...withCompletedAttempt,
              status: "completed",
              output: truncateNodeOutput(finalResult),
              error: null,
              confidence: synthesis.confidence,
              completedAt,
            };
            graph = {
              ...replaceGraphNode(graph, result.nodeId, completedNode),
              status: "completed",
              nextAction: "검증된 결과 종합이 완료되었습니다.",
              overallConfidence: synthesis.confidence,
              repairApproved: synthesis.repairApproved,
              memoryCandidates: synthesis.memoryCandidates,
            };
            finalOutput = finalResult;
            continue;
          }

          // A meeting seat may pause its node on a question for the person. The
          // attempt itself completed; the node re-queues once the answer lands.
          if (
            meeting !== null &&
            current.participantId !== null &&
            (!STRUCTURED_NODE_KINDS.includes(current.kind) ||
              isWorkflowAssignment ||
              (current.kind === "orchestration" &&
                input.run.workflow?.definition.nodes.some((node) => node.id === current.id)))
          ) {
            const raised = parseMeetingQuestion(result.output);
            if (raised !== null) {
              // First asker wins the single question slot; a later asker keeps
              // its question on the node and is asked once the slot frees,
              // rather than re-running to raise it again.
              const slotFree =
                meeting.pendingQuestion === null && !hasPendingSeatSelectionAnswer(meeting, graph);
              graph = replaceGraphNode(graph, result.nodeId, {
                ...withCompletedAttempt,
                status: "awaiting-user",
                output: null,
                error: null,
                completedAt: null,
                parkedQuestion: slotFree
                  ? null
                  : {
                      question: raised.question,
                      options: [...raised.options],
                      context: raised.context,
                      intervention: false,
                      raisedAt: completedAt,
                    },
              });
              if (slotFree) {
                meeting = {
                  ...meeting,
                  pendingQuestion: {
                    askedByParticipantId: current.participantId,
                    question: raised.question,
                    options: raised.options,
                    context: raised.context,
                    askedAt: completedAt,
                    nodeId: current.id,
                  },
                };
              }
              continue;
            }
          }

          const completedNode: WorkspaceTaskNode = {
            ...withCompletedAttempt,
            status: current.agent === "fable" ? "completed" : "awaiting-validation",
            output: storedOutput,
            error: null,
            completedAt: current.agent === "fable" ? completedAt : null,
          };
          graph = replaceGraphNode(graph, result.nodeId, completedNode);
        } catch (error) {
          const refused = isProviderContentRefusal(result.output);
          const message = refused
            ? result.output
            : error instanceof Error
              ? error.message
              : String(error);
          const malformedOutput =
            !refused && error instanceof WorkspaceTaskGraphError && error.malformedOutput;
          const rejectedNode = malformedOutput
            ? updateLastAttempt(withCompletedAttempt, (attempt) => ({
                ...attempt,
                formatRepair: {
                  messageId: workspaceExecutionMessageId({
                    executionId: ProviderExecutionId.make(
                      orchestraExecutionId(input.run, current.id, attempt.number),
                    ),
                    attempt: attempt.number,
                  }),
                  chars: result.output.length,
                  sha256: formatRepairDigest(result.output),
                },
              }))
            : withCompletedAttempt;
          graph = failOrParkNode({
            graph: graphBeforeResult,
            node: rejectedNode,
            error: message,
            classification: "validation",
            completedAt,
            consumesRevision: !malformedOutput,
          });
        }
      }

      graph = refreshWorkspaceTaskGraphQueue(graph);
      if (graph.status !== "completed" && graph.status !== "failed") {
        const ready = readyWorkspaceTaskNodes(graph);
        graph = {
          ...graph,
          status: graph.nodes.some((node) => node.status === "running")
            ? "executing"
            : ready.some((node) => node.kind === "validation")
              ? "validating"
              : ready.some((node) => node.kind === "synthesis")
                ? "synthesizing"
                : "executing",
          nextAction:
            ready.length === 0
              ? graph.nextAction
              : `다음 실행: ${selectGraphWaveNodes(ready, {
                  width: graphWaveWidth(input.run),
                  soloWrites: soloWriteWaves(input.run),
                })
                  .map((node) => node.title)
                  .join(", ")}`,
        };
      }
      const pendingSupervisorReview =
        graph.status === "completed" &&
        meeting !== null &&
        (meeting.pendingSupervisorReview === true ||
          meeting.interjections.length > (meeting.supervisorReviewedInterjections ?? 0));
      if (pendingSupervisorReview && meeting !== null)
        meeting = { ...meeting, pendingSupervisorReview: true };
      const status =
        graph.status === "completed"
          ? freshRun.orchestra?.completionCheck === true ||
            freshRun.orchestra?.executionMode === "persistent" ||
            pendingSupervisorReview
            ? "running"
            : "completed"
          : graph.status === "failed"
            ? "failed"
            : "running";
      if (status === "completed" && meeting !== null) {
        meeting = { ...meeting, phase: "done" };
      }
      return yield* persistGraphRun({ ...freshRun, meeting }, graph, input.bindings, {
        status,
        finalOutput: graph.status === "completed" ? finalOutput : null,
        error: status === "failed" ? graph.nextAction : null,
        updatedAt: yield* nowIso,
      });
    },
  );

  const finalizeDelivery = Effect.fn("WorkspaceCollaborationReactor.finalizeDelivery")(function* (
    runRef: RunRef,
  ) {
    let current = yield* requireRunContinuable(runRef);
    if (current.graph?.status !== "completed" || current.orchestra?.completionCheck !== true)
      return current;
    if (current.graph.delivery !== undefined && current.graph.delivery.status !== "verifying")
      return current;
    current = yield* persistRun({
      ...current,
      graph: {
        ...current.graph,
        delivery: {
          status: "verifying",
          detail: "실제 검증 결과와 통합 상태를 확인합니다.",
          checkedAt: null,
          fingerprint: null,
          worktrees: [],
          commands: [],
        },
      },
      updatedAt: yield* nowIso,
    });
    const project = yield* projectionSnapshotQuery.getProjectShellById(current.projectId);
    const checkedAt = yield* nowIso;
    const cancelled = yield* Deferred.make<never, WorkspaceCollaborationCancelled>();
    yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
      (event.type === "project.collaboration-run-cancel-requested" &&
        event.payload.projectId === runRef.projectId &&
        event.payload.runId === runRef.runId) ||
      (event.type === "project.deleted" && event.payload.projectId === runRef.projectId)
        ? Deferred.fail(cancelled, new WorkspaceCollaborationCancelled({ runRef })).pipe(
            Effect.asVoid,
          )
        : Effect.void,
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* requireRunContinuable(runRef);
    const result =
      Option.isSome(project) && Option.isSome(deliveryGit)
        ? yield* checkOrchestraDelivery(current, yield* runWorkspaceCwd(current), checkedAt).pipe(
            Effect.provideService(WorkspaceDevelopmentGit, deliveryGit.value),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.catch((error) =>
              Effect.succeed({
                status: "failed" as const,
                detail: error.message,
                checkedAt,
                fingerprint: null,
                commands: [],
                worktrees: [],
              }),
            ),
            Effect.raceFirst(Deferred.await(cancelled)),
          )
        : {
            status: "needs-verification" as const,
            detail: "검증 서비스 또는 프로젝트 경로를 확인할 수 없습니다.",
            checkedAt,
            fingerprint: null,
            commands: [],
            worktrees: [],
          };
    current = yield* requireRunContinuable(runRef);
    if (current.graph === null) return current;
    const pendingSupervisorReview =
      current.meeting !== null &&
      (current.meeting.pendingSupervisorReview === true ||
        current.meeting.interjections.length >
          (current.meeting.supervisorReviewedInterjections ?? 0));
    return yield* persistRun({
      ...current,
      status:
        result.status === "passed" &&
        current.orchestra?.executionMode !== "persistent" &&
        !pendingSupervisorReview
          ? "completed"
          : "running",
      graph: { ...current.graph, delivery: result },
      meeting:
        current.meeting === null
          ? null
          : {
              ...current.meeting,
              pendingSupervisorReview,
              phase:
                result.status === "passed" &&
                current.orchestra?.executionMode !== "persistent" &&
                !pendingSupervisorReview
                  ? "done"
                  : current.meeting.phase,
            },
      updatedAt: yield* nowIso,
    });
  });

  const scheduleLimitWake = Effect.fn("WorkspaceCollaborationReactor.scheduleLimitWake")(function* (
    runRef: RunRef,
    resumeAt: string,
  ) {
    const key = runKey(runRef);
    if (limitWakeups.get(key) === resumeAt) return;
    limitWakeups.set(key, resumeAt);
    const nowMs = Date.parse(yield* nowIso);
    yield* forkParked(
      Effect.sleep(Math.max(0, Date.parse(resumeAt) - nowMs)).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            if (limitWakeups.get(key) !== resumeAt) return;
            const run = yield* getRun(runRef);
            if (run.status === "running" || run.status === "queued") yield* enqueue(runRef);
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Usage-limit resume failed", { cause: conciseCause(cause) }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (limitWakeups.get(key) === resumeAt) limitWakeups.delete(key);
          }),
        ),
      ),
    ).pipe(Effect.provideService(Scope.Scope, reactorScope));
  });

  const executeGraphRun = Effect.fn("WorkspaceCollaborationReactor.executeGraphRun")(function* (
    runRef: RunRef,
  ) {
    let run = yield* getRun(runRef);
    if (!run.graph?.nodes.some((node) => node.status === "running") && (yield* parkPausedRun(run)))
      return;
    const interval = run.orchestra?.watchdogIntervalSeconds;
    if (run.orchestra?.executionMode === "persistent" && interval !== undefined) {
      const stopWatchdog = yield* Deferred.make<void>();
      yield* forkParked(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
          (event.type === "project.collaboration-run-cancel-requested" &&
            event.payload.projectId === runRef.projectId &&
            event.payload.runId === runRef.runId) ||
          (event.type === "project.deleted" && event.payload.projectId === runRef.projectId)
            ? Effect.gen(function* () {
                if (Option.isSome(watchdogRuntime) && run.meeting?.threadId) {
                  const journal = watchdogRuntime.value.journal;
                  const threadId = run.meeting.threadId;
                  yield* Effect.sync(() =>
                    cancelWatchdogsForRun(journal, threadId, runRef.runId),
                  ).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("감시 실행 중지 요청을 기록하지 못했습니다", {
                        runId: runRef.runId,
                        cause: conciseCause(cause),
                      }),
                    ),
                  );
                }
                yield* Deferred.succeed(stopWatchdog, undefined);
              })
            : Effect.void,
        ),
        { startImmediately: true },
      );
      yield* forkParked(
        Effect.gen(function* () {
          let reportedFailure = false;
          while (true) {
            let remainingSeconds = interval;
            while (remainingSeconds > 0) {
              const chunk = Math.min(remainingSeconds, 86_400);
              yield* Effect.sleep(chunk * 1_000);
              remainingSeconds -= chunk;
            }
            const retrieved = yield* getRun(runRef).pipe(
              Effect.map(Option.some),
              Effect.catch((error) =>
                Effect.logWarning("지속 작업 감시 상태 조회 실패; 다음 주기에 다시 확인합니다", {
                  runId: runRef.runId,
                  error: error.message,
                }).pipe(Effect.as(Option.none())),
              ),
            );
            if (Option.isNone(retrieved)) continue;
            const current = retrieved.value;
            if (["completed", "failed", "cancelled", "cancel-requested"].includes(current.status))
              return;
            const meeting = current.meeting;
            if (
              current.status !== "running" ||
              workspaceRunControl(current).control !== "active" ||
              meeting === null ||
              meeting.threadId === null ||
              meeting.pendingQuestion !== null ||
              current.graph?.planReview?.status === "pending"
            )
              continue;
            if (
              Option.isSome(watchdogRuntime) &&
              (yield* Effect.sync(() =>
                watchdogRuntime.value.journal.listUnsettledForRun(
                  meeting.threadId!,
                  current.id,
                  WATCHDOG_PROJECTION_CONSUMER,
                ),
              )).length > 0
            )
              continue;
            const chairId = resolveChairParticipantId(meeting);
            const route = meetingAssignmentRoute(meeting, chairId);
            const supervisorRole = meeting.participants.find(
              (participant) => participant.id === chairId,
            )?.roleDescription;
            const nodeId = WorkspaceTaskNodeId.make(`watchdog-${yield* randomUUID}`);
            const executionId = ProviderExecutionId.make(`orchestra:${current.id}:${nodeId}:1`);
            if (Option.isSome(agentControl)) {
              const registered = yield* agentControl.value
                .beginSupervisor({
                  projectId: current.projectId,
                  runId: current.id,
                  threadId: meeting.threadId,
                  providerInstanceId: route.modelSelection.instanceId,
                  executionId,
                })
                .pipe(
                  Effect.as(true),
                  Effect.catch((error) =>
                    Effect.logWarning("지속 작업 감시 세션 준비 실패", {
                      runId: current.id,
                      error: error.message,
                    }).pipe(Effect.as(false)),
                  ),
                );
              if (!registered) continue;
            }
            const nodes = current.graph?.nodes ?? [];
            const checked = yield* dispatchMeetingTurn({
              run: current,
              route,
              threadId: meeting.threadId,
              title: "지속 작업 감시",
              executionNodeId: nodeId,
              executionId,
              prompt: [
                "당신은 이 지속 작업을 위한 별도 감시 세션입니다. 지정된 감독자와 같은 모델을 사용하지만 독립적인 실행입니다.",
                "사용자의 목표와 최신 지시, 현재 단계와 실패 근거를 확인하세요. 시간이 흘렀다는 사실만으로 멈춤이나 실패라고 단정하지 마세요.",
                "확인된 문제가 있으면 원인과 다음 조치를 설명하고, 필요한 경우 실행 중인 작업자에게 메시지함으로 지시하세요. 전달과 실제 수신·반영은 구분하세요.",
                "다른 작업자가 수정 중인 파일을 동시에 수정하지 말고, 사용자가 중지하거나 입력을 기다리는 작업을 임의로 재개하지 마세요. 안전 필터를 다른 모델이나 계정으로 우회하지 마세요.",
                ...(supervisorRole ? [`사용자가 정한 감독자 역할: ${supervisorRole}`] : []),
                `원래 목표: ${current.task}`,
                `사용자의 추가 지시:\n${meeting.interjections.map((entry) => entry.text).join("\n") || "없음"}`,
                `현재 단계: ${meeting.phase}; 실행 상태: ${current.status}; 그래프 상태: ${current.graph?.status ?? "아직 계획 중"}`,
                `작업 단계(목록은 요약이며 전체 결과의 증거가 아닙니다):\n${nodes.map((node) => `${node.id} · ${node.title} · 목표 ${node.handoff.goal} · ${node.status} · 시도 ${node.attempts.length} · 시작 ${node.startedAt ?? "미확인"} · 오류 ${node.error ?? "없음"} · 검증 ${node.validation?.summary ?? "없음"}`).join("\n") || "아직 없음"}`,
                ...(Option.isSome(agentControl)
                  ? [
                      `작업자에게 workspace_mailbox send를 사용할 수 있습니다. projectId=${current.projectId}, runId=${current.id}, toNodeId는 위 단계 ID입니다.`,
                    ]
                  : []),
              ].join("\n\n"),
            }).pipe(
              Effect.ensuring(
                Option.isSome(agentControl)
                  ? agentControl.value.endSupervisor(executionId)
                  : Effect.void,
              ),
              Effect.as(true),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning("지속 작업 감시 확인 실패", {
                    runId: current.id,
                    error: error.message,
                  });
                  if (!reportedFailure) {
                    const id = `orchestra-watchdog-failed:${yield* randomUUID}`;
                    const createdAt = yield* nowIso;
                    yield* orchestrationEngine
                      .dispatch({
                        type: "thread.activity.append",
                        commandId: CommandId.make(id),
                        threadId: meeting.threadId!,
                        createdAt,
                        activity: {
                          id: EventId.make(id),
                          kind: "orchestra.watchdog.failed",
                          tone: "error",
                          summary: `감시 AI 확인 실패: ${error.message.slice(0, 400)}`,
                          payload: { runId: current.id },
                          turnId: null,
                          createdAt,
                        },
                      })
                      .pipe(
                        Effect.catchCause((cause) =>
                          Cause.hasInterruptsOnly(cause)
                            ? Effect.failCause(cause)
                            : Effect.logWarning("감시 오류를 대화에 기록하지 못했습니다.", {
                                cause: conciseCause(cause),
                              }),
                        ),
                      );
                  }
                  return false;
                }),
              ),
            );
            reportedFailure = !checked;
          }
        }).pipe(
          Effect.raceFirst(Deferred.await(stopWatchdog)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("지속 작업 감시 중단", {
                  runId: runRef.runId,
                  cause: conciseCause(cause),
                }),
          ),
        ),
      );
    }
    if (Option.isSome(agentControl))
      yield* agentControl.value
        .reports(run)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Agent reports recovery failed", { cause: Cause.pretty(cause) }),
          ),
        );
    const bindings =
      run.workflow?.roleBindings ??
      run.runContext?.roleBindings ??
      (yield* loadGraphBindings(run.projectId, run.meeting));
    if (
      run.orchestra?.completionCheck === true &&
      run.meeting !== null &&
      run.meeting.workspaceBaseline === undefined &&
      Option.isSome(deliveryGit)
    ) {
      const project = yield* projectionSnapshotQuery.getProjectShellById(run.projectId);
      if (Option.isSome(project)) {
        const baseline = yield* deliveryGit.value
          .inspect(yield* runWorkspaceCwd(run))
          .pipe(Effect.option);
        if (Option.isSome(baseline))
          run = yield* persistRun({
            ...run,
            meeting: { ...run.meeting, workspaceBaseline: baseline.value.fingerprint },
            updatedAt: yield* nowIso,
          });
      }
    }
    if (
      (run.source === "schedule" || run.source === "automation") &&
      bindings.some(
        (binding) =>
          binding.enabled &&
          ["coordinator", "researcher", "implementer"].includes(binding.role) &&
          binding.runtimeMode === "approval-required",
      )
    ) {
      return yield* executionError(
        "Unattended scheduled runs cannot use a role configured with approval-required runtime mode.",
      );
    }
    const workspacePrompt = yield* composeRunPrompt(run);
    yield* recordPromptUsage({
      projectId: run.projectId,
      ...workspacePrompt,
    });

    // A meeting is the run's leading phase: the seats discuss and the chair
    // plans before any graph exists. Parked means the person owes an answer;
    // the answered event re-enqueues the run.
    if (
      run.meeting !== null &&
      (run.meeting.phase === "clarifying" ||
        run.meeting.phase === "discussing" ||
        run.meeting.phase === "planning")
    ) {
      const proceeded = yield* runMeetingPhase({
        runRef,
        bindings,
        workspacePrompt: workspacePrompt.prompt,
      });
      if (!proceeded) return;
      run = yield* getRun(runRef);
    }

    if (run.graph === null) {
      if (run.meeting !== null) {
        return yield* executionError("Meeting run reached execution without a task graph.");
      }
      let graph = run.workflow
        ? yield* Effect.try({
            try: () => compileWorkflowRun(run),
            catch: (cause) =>
              executionError(cause instanceof Error ? cause.message : String(cause)),
          })
        : buildInitialWorkspaceTaskGraph(run.task);
      if (run.orchestra?.completionCheck === true && Option.isSome(deliveryGit)) {
        const project = yield* projectionSnapshotQuery.getProjectShellById(run.projectId);
        if (Option.isSome(project)) {
          const baseline = yield* deliveryGit.value
            .inspect(yield* runWorkspaceCwd(run))
            .pipe(Effect.option);
          if (Option.isSome(baseline))
            graph = { ...graph, workspaceBaseline: baseline.value.fingerprint };
        }
      }
      run = yield* persistGraphRun(run, graph, bindings, {
        status: "running",
        finalOutput: null,
        error: null,
        updatedAt: yield* nowIso,
      });
    }

    const finished = yield* Queue.unbounded<{
      readonly nodeId: string | null;
      readonly cause: WorkspaceCollaborationCancelled | WorkspaceCollaborationExecutionError | null;
    }>();
    const inFlight = new Set<string>();
    const resultLock = yield* Semaphore.make(1);
    // Live reviews are advisory; the durable final review still checks every
    // instruction against the completed work. A restart may repeat a live
    // review rather than incorrectly treating an interrupted one as complete.
    let liveReviewedInterjections = run.meeting?.supervisorReviewedInterjections ?? 0;
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        (event.type === "project.collaboration-run-answered" ||
          event.type === "project.collaboration-run-interjected") &&
        event.payload.projectId === runRef.projectId &&
        event.payload.runId === runRef.runId
          ? Queue.offer(finished, { nodeId: null, cause: null }).pipe(Effect.asVoid)
          : Effect.void,
      ),
      { startImmediately: true },
    );
    const parkRefusalAnswer = (answerCount: number) =>
      resultLock.withPermit(
        Effect.gen(function* () {
          const current = yield* requireRunContinuable(runRef);
          const meeting = current.meeting;
          const answer = meeting?.answers[answerCount - 1];
          if (
            current.graph === null ||
            meeting === null ||
            meeting.pendingQuestion !== null ||
            answer === undefined ||
            meeting.answers.length !== answerCount ||
            !isNodeInterventionQuestion(answer.question) ||
            isNodeSeatSelectionQuestion(answer.question) ||
            parseNodeRefusalDecision(answer.answer) !== null
          )
            return current;
          const node = current.graph.nodes.find(
            (candidate) =>
              candidate.status === "awaiting-user" &&
              (answer.nodeId === null
                ? candidate.parkedQuestion === null
                : candidate.id === answer.nodeId) &&
              candidate.error !== null &&
              isProviderContentRefusal(candidate.error),
          );
          if (node === undefined) return current;
          const question = nodeRefusalQuestion(node.title);
          return yield* persistGraphRun(
            {
              ...current,
              meeting: {
                ...meeting,
                pendingSupervisorReview: true,
                ...(!/다른\s*(?:좌석|참가자|계정|모델|에이전트|ai)|우회|bypass|circumvent/iu.test(
                  answer.answer,
                )
                  ? { refusalInstructionReview: { answerCount, status: "pending" as const } }
                  : {}),
                pendingQuestion: {
                  askedByParticipantId: node.participantId,
                  question,
                  options: [...NODE_REFUSAL_OPTIONS],
                  context: `안전 필터를 다른 모델로 우회할 수 없습니다. 입력은 기록했으며 이 단계의 재시도·건너뛰기·종료는 명시적으로 선택해 주세요. ${node.error ?? ""}`,
                  askedAt: yield* nowIso,
                  nodeId: node.id,
                },
              },
            },
            current.graph,
            bindings,
            { updatedAt: yield* nowIso },
          );
        }),
      );
    const handleSeatSelectionAnswer = (answerCount: number) =>
      resultLock.withPermit(
        Effect.gen(function* () {
          const current = yield* requireRunContinuable(runRef);
          const meeting = current.meeting;
          const answer = meeting?.answers[answerCount - 1];
          if (
            current.graph === null ||
            meeting === null ||
            meeting.pendingQuestion !== null ||
            answer === undefined ||
            meeting.answers.length !== answerCount
          )
            return { run: current, handled: false };
          const authorized = meetingWithAuthorizedSeats(meeting);
          const node = answeredSeatSelectionNode(meeting, current.graph);
          if (node === undefined) return { run: current, handled: false };
          const decision = parseNodeSeatSelectionDecision(answer.answer, authorized.participants);
          const askedAt = yield* nowIso;
          if (decision === null) {
            const saved = yield* persistGraphRun(
              {
                ...current,
                meeting: {
                  ...meeting,
                  pendingQuestion: {
                    askedByParticipantId: null,
                    question: nodeSeatSelectionQuestion(node.title),
                    options: nodeSeatSelectionOptions(authorized.participants),
                    context:
                      "현재 허용된 좌석의 선택지 또는 정확한 좌석 ID를 선택해 주세요. 재시도나 추가 지시만으로는 배정을 변경하지 않습니다.",
                    askedAt,
                    nodeId: node.id,
                  },
                },
              },
              current.graph,
              bindings,
              { updatedAt: askedAt },
            );
            return { run: saved, handled: true };
          }
          if (decision.kind === "stop")
            return yield* new WorkspaceCollaborationCancelled({ runRef });
          let graph = refreshWorkspaceTaskGraphQueue({
            ...current.graph,
            nodes: current.graph.nodes.map((candidate) => {
              if (candidate.id !== node.id) return candidate;
              if (decision.kind === "skip")
                return {
                  ...candidate,
                  status: "completed" as const,
                  output: candidate.output ?? "(사용자가 이 단계를 건너뛰었습니다.)",
                  completedAt: askedAt,
                };
              return {
                ...candidate,
                participantId: decision.participantId,
                status: "queued" as const,
              };
            }),
          });
          if (decision.kind === "skip" && graph.workflowAssignment?.gateNodeId === node.id)
            graph = skipPendingWorkflowAssignments(graph, askedAt);
          const next = graph.nodes
            .filter(
              (candidate) =>
                candidate.status === "awaiting-user" && candidate.parkedQuestion !== null,
            )
            .toSorted((left, right) => left.order - right.order)[0];
          if (next === undefined || next.parkedQuestion === null) {
            const saved = yield* persistGraphRun(current, graph, bindings, { updatedAt: askedAt });
            return { run: saved, handled: true };
          }
          const parked = next.parkedQuestion;
          const saved = yield* persistGraphRun(
            {
              ...current,
              meeting: {
                ...meeting,
                pendingQuestion: {
                  askedByParticipantId: isNodeSeatSelectionQuestion(parked.question)
                    ? null
                    : next.participantId,
                  question: parked.question,
                  options: isNodeSeatSelectionQuestion(parked.question)
                    ? nodeSeatSelectionOptions(authorized.participants)
                    : parked.options,
                  context: parked.context,
                  askedAt,
                  nodeId: next.id,
                },
              },
            },
            {
              ...graph,
              nodes: graph.nodes.map((candidate) =>
                candidate.id === next.id ? { ...candidate, parkedQuestion: null } : candidate,
              ),
              nextAction: parked.question,
            },
            bindings,
            { updatedAt: askedAt },
          );
          return { run: saved, handled: true };
        }),
      );
    while (
      run.graph !== null &&
      (!["completed", "failed"].includes(run.graph.status) || inFlight.size > 0)
    ) {
      run = yield* requireRunContinuable(runRef);
      if (
        run.orchestra?.reviewPlan === true &&
        run.graph !== null &&
        run.graph.revision > 0 &&
        run.graph.planReview === undefined &&
        inFlight.size === 0
      ) {
        run = yield* persistRun({
          ...run,
          graph: {
            ...run.graph,
            planReview: { revision: 0, status: "pending", updatedAt: yield* nowIso },
          },
          updatedAt: yield* nowIso,
        });
      }
      if (
        inFlight.size === 0 &&
        !run.graph?.nodes.some((node) => node.status === "running") &&
        (yield* parkPausedRun(run))
      )
        return;
      if (run.graph?.planReview?.status === "pending") return;
      if (run.graph === null) return;
      if (
        run.meeting?.pendingQuestion === null &&
        hasPendingSeatSelectionAnswer(run.meeting, run.graph)
      ) {
        const selection = yield* handleSeatSelectionAnswer(run.meeting.answers.length);
        run = selection.run;
        if (selection.handled) continue;
        if (run.graph === null) return;
      }
      if (
        inFlight.size > 0 &&
        workspaceRunControl(run).control === "active" &&
        run.meeting !== null &&
        run.meeting.threadId !== null &&
        run.meeting.pendingQuestion === null &&
        run.meeting.interjections.length > liveReviewedInterjections
      ) {
        const meeting = run.meeting;
        const chairId = resolveChairParticipantId(meeting);
        const chairBusy = run.graph.nodes.some(
          (node) => node.status === "running" && node.participantId === chairId,
        );
        if (!chairBusy && meeting.threadId !== null) {
          const observed = meeting.interjections.length;
          const instructions = meeting.interjections.slice(liveReviewedInterjections, observed);
          const role = meeting.participants.find(
            (participant) => participant.id === chairId,
          )?.roleDescription;
          const route = meetingAssignmentRoute(meeting, chairId);
          const reviewNodeId = WorkspaceTaskNodeId.make(`live-review-${yield* randomUUID}`);
          const reviewExecutionId = ProviderExecutionId.make(
            `orchestra:${run.id}:${reviewNodeId}:1`,
          );
          if (Option.isSome(agentControl))
            yield* agentControl.value
              .beginSupervisor({
                projectId: run.projectId,
                runId: run.id,
                threadId: meeting.threadId,
                providerInstanceId: route.modelSelection.instanceId,
                executionId: reviewExecutionId,
              })
              .pipe(Effect.mapError((error) => executionError(error.message)));
          const review = dispatchMeetingTurn({
            run,
            route,
            threadId: meeting.threadId,
            title: "진행 중 추가 지시 검토",
            executionNodeId: reviewNodeId,
            executionId: reviewExecutionId,
            prompt: [
              "사용자가 진행 중인 통합 작업에 추가 지시를 보냈습니다. 감독자 역할에 따라 현재 작업과 지시를 검토하고 대화창에 실제 상태와 필요한 조치를 설명하세요.",
              "다른 작업자가 실행 중입니다. 같은 파일을 동시에 수정하지 말고, 전달하거나 적용하지 않은 지시는 적용했다고 말하지 마세요. 안전 필터를 다른 모델이나 계정으로 우회하지 마세요.",
              ...(role ? [`사용자가 지정한 감독자 역할: ${role}`] : []),
              `원래 목표: ${run.task}`,
              `실행 중인 단계: ${run.graph.nodes
                .filter((node) => node.status === "running")
                .map((node) => `${node.id}: ${node.title}`)
                .join(", ")}`,
              ...(Option.isSome(agentControl)
                ? [
                    `필요한 작업자에게 workspace_mailbox send로 지시를 전달하세요. projectId=${run.projectId}, runId=${run.id}, toNodeId는 위 단계 ID이며 전송마다 고유한 requestId를 쓰세요. 전송은 보관을 뜻하고 수신·반영 확인은 별개입니다.`,
                  ]
                : []),
              `사용자의 추가 지시:\n${instructions.map((entry) => entry.text).join("\n")}`,
            ].join("\n\n"),
          });
          const result = yield* review.pipe(
            Effect.ensuring(
              Option.isSome(agentControl)
                ? agentControl.value.endSupervisor(reviewExecutionId)
                : Effect.void,
            ),
            Effect.map(() => null),
            Effect.catchTag("WorkspaceCollaborationExecutionError", (error) =>
              Effect.succeed(error.message),
            ),
          );
          liveReviewedInterjections = observed;
          if (result !== null)
            yield* Effect.logWarning(
              "진행 중 감독자 지시 검토 실패; 최종 검토에서 다시 확인합니다.",
              {
                runId: run.id,
                error: result,
              },
            );
          run = yield* requireRunContinuable(runRef);
          continue;
        }
      }
      if (inFlight.size > 0 && run.meeting?.pendingQuestion === null) {
        const answer = run.meeting.answers.at(-1);
        const refusalAnswer = answer === undefined ? null : parseNodeRefusalDecision(answer.answer);
        const interventionNode =
          answer !== undefined &&
          isNodeInterventionQuestion(answer.question) &&
          !isNodeSeatSelectionQuestion(answer.question) &&
          run.graph.nodes.find(
            (node) =>
              node.status === "awaiting-user" &&
              (answer.nodeId === null ? node.parkedQuestion === null : node.id === answer.nodeId) &&
              node.error !== null,
          );
        if (interventionNode && refusalAnswer?.kind === "stop")
          return yield* new WorkspaceCollaborationCancelled({ runRef });
        if (
          answer !== undefined &&
          interventionNode &&
          interventionNode.error !== null &&
          isProviderContentRefusal(interventionNode.error) &&
          refusalAnswer === null
        ) {
          run = yield* parkRefusalAnswer(run.meeting.answers.length);
          continue;
        }
      }
      if (
        run.meeting !== null &&
        (inFlight.size === 0 || run.meeting.refusalInstructionReview?.status === "pending")
      ) {
        const pendingRefusalReview = run.meeting.refusalInstructionReview;
        if (pendingRefusalReview?.status === "pending") {
          const answer = run.meeting.answers[pendingRefusalReview.answerCount - 1];
          const threadId = run.meeting.threadId;
          const chairId = resolveChairParticipantId(run.meeting);
          const chairRole = run.meeting.participants.find(
            (participant) => participant.id === chairId,
          )?.roleDescription;
          const result =
            answer === undefined || threadId === null
              ? { _tag: "Failure" as const, failure: "추가 지시 또는 대화 기록을 찾지 못했습니다." }
              : yield* dispatchMeetingTurn({
                  run,
                  route: meetingAssignmentRoute(run.meeting, chairId),
                  threadId,
                  title: "대기 중 추가 지시 검토",
                  executionNodeId: WorkspaceTaskNodeId.make(
                    `refusal-review-${pendingRefusalReview.answerCount}`,
                  ),
                  executionId: ProviderExecutionId.make(
                    `orchestra-refusal-review:${run.id}:${pendingRefusalReview.answerCount}`,
                  ),
                  prompt: [
                    inFlight.size > 0
                      ? "사용자가 통합 작업에 추가 지시를 보냈습니다. 지정된 감독자 역할에 따라 지시를 검토하고 다른 실행 중인 작업과 충돌하지 않도록 필요한 조치를 안내하세요. 실행 중인 작업과 같은 파일을 수정하지 마세요."
                      : "사용자가 통합 작업에 추가 지시를 보냈습니다. 지정된 감독자 역할에 따라 지시를 검토하고 가능한 독립 작업을 진행하세요.",
                    ...(chairRole ? [`사용자가 지정한 감독자 역할: ${chairRole}`] : []),
                    "안전 필터가 거절한 단계는 보류 상태입니다. 다른 모델이나 계정으로 그 거절을 우회하거나 해당 단계를 다시 실행하지 마세요. 질문에 대한 선택은 사용자가 직접 합니다.",
                    `사용자의 추가 지시: ${answer.answer}`,
                    ...(answer.imageReferences ?? []).map(
                      (image) =>
                        `사용자가 첨부한 이미지: ${JSON.stringify(image.name)}; 서버 파일: ${JSON.stringify(image.path)}`,
                    ),
                  ].join("\n\n"),
                }).pipe(
                  Effect.map(() => ({ _tag: "Success" as const })),
                  Effect.catchTag("WorkspaceCollaborationExecutionError", (error) =>
                    Effect.succeed({ _tag: "Failure" as const, failure: error.message }),
                  ),
                );
          const fresh = yield* resultLock.withPermit(requireRunContinuable(runRef));
          if (
            fresh.meeting?.refusalInstructionReview?.answerCount ===
              pendingRefusalReview.answerCount &&
            fresh.meeting.refusalInstructionReview.status === "pending"
          ) {
            const failed = result._tag === "Failure";
            const failureNotice = failed
              ? `\n감독자 추가 지시 검토 실패: ${result.failure}`.slice(0, 20_000)
              : "";
            if (failed && threadId !== null) {
              const activityId = `orchestra-refusal-review-failed:${run.id}:${pendingRefusalReview.answerCount}`;
              const createdAt = yield* nowIso;
              yield* orchestrationEngine
                .dispatch({
                  type: "thread.activity.append",
                  commandId: CommandId.make(activityId),
                  threadId,
                  createdAt,
                  activity: {
                    id: EventId.make(activityId),
                    kind: "orchestra.instruction-review.failed",
                    tone: "error",
                    summary: `감독자 추가 지시 검토 실패: ${result.failure.slice(0, 400)}`,
                    payload: { runId: run.id, answerCount: pendingRefusalReview.answerCount },
                    turnId: null,
                    createdAt,
                  },
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.failCause(cause)
                      : Effect.logWarning(
                          "감독자 추가 지시 검토 실패를 대화에 표시하지 못했습니다.",
                          {
                            cause: Cause.pretty(cause),
                          },
                        ),
                  ),
                );
            }
            run = yield* resultLock.withPermit(
              Effect.gen(function* () {
                const current = yield* requireRunContinuable(runRef);
                if (
                  current.meeting?.refusalInstructionReview?.answerCount !==
                    pendingRefusalReview.answerCount ||
                  current.meeting.refusalInstructionReview.status !== "pending"
                )
                  return current;
                return yield* persistRun({
                  ...current,
                  meeting: {
                    ...current.meeting,
                    refusalInstructionReview: {
                      answerCount: pendingRefusalReview.answerCount,
                      status: failed ? "failed" : "completed",
                      ...(failed ? { error: result.failure } : {}),
                    },
                    ...(failed && current.meeting.pendingQuestion !== null
                      ? {
                          pendingQuestion: {
                            ...current.meeting.pendingQuestion,
                            context:
                              current.meeting.pendingQuestion.context.slice(
                                0,
                                20_000 - failureNotice.length,
                              ) + failureNotice,
                          },
                        }
                      : {}),
                  },
                  updatedAt: yield* nowIso,
                });
              }),
            );
          } else {
            run = fresh;
          }
          continue;
        }
        if (
          run.meeting.pendingQuestion !== null &&
          run.meeting.pendingQuestion.nodeId === null &&
          !isNodeInterventionQuestion(run.meeting.pendingQuestion.question)
        )
          return;
        if (
          run.meeting.pendingQuestion === null &&
          !isNodeSeatSelectionQuestion(run.meeting.answers.at(-1)?.question ?? "") &&
          run.graph.nodes.some((node) => node.status === "awaiting-user")
        ) {
          // The person answered; parked seats rejoin the queue and re-run with
          // the recorded decision in their prompt. A node parked because its
          // retries ran out (`awaiting-user` WITH an error) also takes the
          // person's verdict on what to do with it.
          const lastAnswer = run.meeting.answers.at(-1) ?? null;
          const authorized = meetingWithAuthorizedSeats(run.meeting);
          let verdict =
            lastAnswer !== null && isNodeInterventionQuestion(lastAnswer.question)
              ? parseNodeInterventionDecision(lastAnswer.answer)
              : null;
          const isParkedFailure = (node: WorkspaceTaskNode): boolean =>
            node.status === "awaiting-user" && node.error !== null;
          const answeredAt = yield* nowIso;
          // An answer bound to a node resumes that node alone; a sibling still
          // holding its own question stays parked until it is asked. An
          // unbound (older) answer keeps the pre-orchestra reading and resumes
          // every parked node that has nothing of its own to ask.
          const answeredNodeId = lastAnswer?.nodeId ?? null;
          const answered = (node: WorkspaceTaskNode): boolean =>
            node.status === "awaiting-user" &&
            (answeredNodeId !== null ? node.id === answeredNodeId : node.parkedQuestion === null);
          const refusedNode = run.graph.nodes.find(
            (node) => answered(node) && node.error !== null && isProviderContentRefusal(node.error),
          );
          const refusalDecision =
            refusedNode !== undefined && lastAnswer !== null
              ? parseNodeRefusalDecision(lastAnswer.answer)
              : null;
          if (refusedNode !== undefined && refusalDecision === null) {
            if (lastAnswer === null) return;
            run = yield* parkRefusalAnswer(run.meeting.answers.length);
            continue;
          }
          if (refusalDecision !== null) verdict = refusalDecision;
          const parkedNext =
            run.graph.nodes
              .filter((node) => node.status === "awaiting-user" && node.parkedQuestion !== null)
              .toSorted((left, right) => left.order - right.order)
              .find((node) => !answered(node)) ?? null;

          if (verdict?.kind === "stop") {
            if (lastAnswer !== null && parseNodeRefusalDecision(lastAnswer.answer)?.kind === "stop")
              return yield* new WorkspaceCollaborationCancelled({ runRef });
            const stopped = refreshWorkspaceTaskGraphQueue({
              ...run.graph,
              status: "failed" as const,
              nextAction: "사용자가 여기서 종료를 선택했습니다.",
              nodes: run.graph.nodes.map((node) =>
                isParkedFailure(node)
                  ? { ...node, status: "failed" as const, completedAt: answeredAt }
                  : node,
              ),
            });
            run = yield* persistGraphRun(run, stopped, bindings, {
              status: "failed",
              error: stopped.nextAction,
              updatedAt: answeredAt,
            });
            return;
          }

          let graph = refreshWorkspaceTaskGraphQueue({
            ...run.graph,
            nodes: run.graph.nodes.map((node) => {
              if (!answered(node)) return node;
              if (!isParkedFailure(node)) return { ...node, status: "queued" as const };
              if (verdict?.kind === "skip") {
                return {
                  ...node,
                  status: "completed" as const,
                  output: `(사용자가 이 단계를 건너뛰었습니다. 마지막 실패: ${node.error})`,
                  completedAt: answeredAt,
                };
              }
              // Whichever way it resumes, the automatic budget is spent, so the
              // person's answer buys exactly one more attempt.
              const granted = {
                ...node,
                status: "queued" as const,
                error: null,
                maxAttempts: Math.min(node.attempts.length + 1, MAX_NODE_ATTEMPTS),
              };
              if (verdict?.kind !== "reassign") return granted;
              // Hand it to another seat the person already picked — never to an
              // account outside the meeting, which would run as someone they
              // did not choose. With no one else seated, retry in place.
              const nextSeat = meetingWithAuthorizedSeats(run.meeting!).participants.find(
                (participant) => participant.id !== node.participantId,
              );
              // A new seat is a new driver: its conversation starts fresh.
              return nextSeat === undefined
                ? granted
                : { ...granted, participantId: nextSeat.id, threadId: null };
            }),
          });
          if (
            verdict?.kind === "skip" &&
            run.graph.workflowAssignment?.gateNodeId === answeredNodeId
          )
            graph = skipPendingWorkflowAssignments(graph, answeredAt);
          // Publish the next node's question while independent work continues.
          if (parkedNext !== null && parkedNext.parkedQuestion !== null) {
            const parked = parkedNext.parkedQuestion;
            run = yield* persistGraphRun(
              {
                ...run,
                meeting: {
                  ...run.meeting,
                  pendingQuestion: {
                    askedByParticipantId: isNodeSeatSelectionQuestion(parked.question)
                      ? null
                      : parkedNext.participantId,
                    question: parked.question,
                    options: isNodeSeatSelectionQuestion(parked.question)
                      ? nodeSeatSelectionOptions(authorized.participants)
                      : parked.options,
                    context: parked.context,
                    askedAt: answeredAt,
                    nodeId: parkedNext.id,
                  },
                },
              },
              refreshWorkspaceTaskGraphQueue({
                ...graph,
                nodes: graph.nodes.map((node) =>
                  node.id === parkedNext.id ? { ...node, parkedQuestion: null } : node,
                ),
                nextAction: parked.question,
              }),
              bindings,
              { updatedAt: answeredAt },
            );
            continue;
          }
          run = yield* persistGraphRun(run, graph, bindings, { updatedAt: answeredAt });
          continue;
        }
      }
      const scheduled = yield* resultLock.withPermit(
        Effect.gen(function* () {
          let current = yield* requireRunContinuable(runRef);
          if (
            workspaceRunControl(current).control !== "active" ||
            current.graph === null ||
            (current.meeting?.pendingQuestion &&
              current.meeting.pendingQuestion.nodeId === null &&
              !isNodeInterventionQuestion(current.meeting.pendingQuestion.question)) ||
            ["completed", "failed"].includes(current.graph.status)
          )
            return { run: current, provisionErrors: new Map<string, string>() };
          if (current.meeting !== null) {
            const authorized = meetingWithAuthorizedSeats(current.meeting);
            const authorizedIds = new Set(authorized.participants.map((seat) => seat.id));
            const unselectedIds = new Set(
              current.meeting.participants
                .filter((seat) => !authorizedIds.has(seat.id))
                .map((seat) => seat.id),
            );
            const unselected = readyWorkspaceTaskNodes(current.graph).filter(
              (node) => node.participantId !== null && unselectedIds.has(node.participantId),
            );
            if (unselected.length > 0) {
              const askedAt = yield* nowIso;
              const first = current.meeting.pendingQuestion === null ? unselected[0] : undefined;
              const options = nodeSeatSelectionOptions(authorized.participants);
              const context =
                "기존 배정과 기록은 보존됩니다. 현재 허용된 좌석을 직접 선택해야 이 단계의 다음 시도를 시작합니다.";
              const unselectedNodeIds = new Set(unselected.map((node) => node.id));
              const meeting =
                first === undefined
                  ? current.meeting
                  : {
                      ...current.meeting,
                      pendingQuestion: {
                        askedByParticipantId: null,
                        question: nodeSeatSelectionQuestion(first.title),
                        options,
                        context,
                        askedAt,
                        nodeId: first.id,
                      },
                    };
              const graph = {
                ...current.graph,
                nodes: current.graph.nodes.map((node) =>
                  !unselectedNodeIds.has(node.id)
                    ? node
                    : {
                        ...node,
                        status: "awaiting-user" as const,
                        parkedQuestion:
                          node.id === first?.id
                            ? null
                            : {
                                question: nodeSeatSelectionQuestion(node.title),
                                options,
                                context,
                                intervention: true,
                                raisedAt: askedAt,
                              },
                      },
                ),
              };
              current = yield* persistGraphRun(
                { ...current, meeting },
                refreshWorkspaceTaskGraphQueue({ ...graph, status: "executing" }),
                bindings,
                { updatedAt: askedAt },
              );
            }
          }
          if (current.graph === null)
            return { run: current, provisionErrors: new Map<string, string>() };
          const ready = dispatchableWorkspaceTaskNodes(current.graph, {
            width: graphWaveWidth(current),
            isolateWorktrees: isolatesWorktrees(current),
            inFlight,
            nowMs: Date.parse(yield* nowIso),
          });
          const remaining =
            current.orchestra?.maxWorkerTurns === undefined
              ? ready.length
              : Math.max(
                  0,
                  current.orchestra.maxWorkerTurns -
                    (current.meeting?.continuation?.workerTurns ?? 0) -
                    current.graph.nodes.reduce((count, node) => count + node.attempts.length, 0),
                );
          if (ready.length > 0 && remaining === 0 && inFlight.size === 0)
            return yield* executionError(
              "설정한 작업 AI 실행 한도에 도달했습니다. 완료된 결과는 보존됩니다.",
            );
          const selected = ready.slice(0, remaining);
          if (selected.length)
            return yield* startGraphWave({
              run: current,
              bindings,
              nodes: selected,
              width: selected.length,
            });
          return { run: current, provisionErrors: new Map<string, string>() };
        }),
      );
      run = scheduled.run;
      const running =
        run.graph?.nodes.filter(
          (node) => node.status === "running" && !inFlight.has(String(node.id)),
        ) ?? [];
      for (const node of running) {
        const nodeId = String(node.id);
        inFlight.add(nodeId);
        yield* Effect.forkScoped(
          executeGraphWave({
            run,
            bindings,
            workspacePrompt: workspacePrompt.prompt,
            nodeIds: new Set([nodeId]),
            resultLock,
            provisionErrors: scheduled.provisionErrors,
          }).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) => {
                const error = Cause.squash(cause);
                return Queue.offer(finished, {
                  nodeId,
                  cause:
                    error instanceof WorkspaceCollaborationCancelled
                      ? error
                      : executionError(conciseCause(cause)),
                });
              },
              onSuccess: () => Queue.offer(finished, { nodeId, cause: null }),
            }),
          ),
        );
      }
      if (inFlight.size === 0) {
        if (run.meeting?.pendingQuestion) return;
        if (yield* parkPausedRun(run)) return;
        const waitNowMs = Date.parse(yield* nowIso);
        const waiting = run.graph?.nodes
          .filter(
            (node) =>
              ["queued", "blocked"].includes(node.status) &&
              node.usageRecovery?.phase === "waiting" &&
              Date.parse(node.usageRecovery.resumeAt) > waitNowMs,
          )
          .map((node) => node.usageRecovery!.resumeAt)
          .toSorted()[0];
        if (waiting) {
          yield* scheduleLimitWake(runRef, waiting);
          return;
        }
        if (run.graph !== null && ["completed", "failed"].includes(run.graph.status)) break;
        const failedNode = run.graph?.nodes.find(
          (node) =>
            node.status === "failed" &&
            node.error !== null &&
            isWorkspaceProviderUnavailable(node.error),
        );
        if (run.meeting === null && run.graph !== null && failedNode?.error) {
          const finishedAt = yield* nowIso;
          yield* persistGraphRun(
            run,
            { ...run.graph, status: "failed", nextAction: failedNode.error },
            bindings,
            { status: "failed", error: failedNode.error, updatedAt: finishedAt },
          );
          return;
        }
        if (
          run.graph?.nodes.some((node) => node.status === "awaiting-user") &&
          isNodeSeatSelectionQuestion(run.meeting?.answers.at(-1)?.question ?? "")
        )
          return;
        return yield* executionError(
          "Task graph is deadlocked: no runnable task or active worker.",
        );
      }
      const settled = yield* Queue.take(finished);
      if (settled.nodeId !== null) inFlight.delete(settled.nodeId);
      if (settled.cause !== null) return yield* settled.cause;
      run = yield* requireRunContinuable(runRef);
    }
    if (yield* parkPausedRun(run)) return;
    run = yield* finalizeDelivery(runRef);
    if (
      run.status === "running" &&
      run.graph?.status === "completed" &&
      (run.orchestra?.executionMode === "persistent" ||
        run.meeting?.pendingSupervisorReview === true) &&
      run.meeting !== null
    ) {
      const chairId = resolveChairParticipantId(run.meeting);
      if (run.meeting.threadId === null)
        return yield* executionError("지속 작업의 대화창을 확인할 수 없습니다.");
      const observedInterjections = run.meeting.interjections.length;
      const mailboxNotice = yield* unconfirmedInstructionNotice(run);
      const turn = yield* dispatchMeetingTurn({
        run,
        route: meetingAssignmentRoute(run.meeting, chairId),
        threadId: run.meeting.threadId,
        title: "지속 작업 진행 판단",
        prompt: [
          "사용자가 요청한 통합 작업의 감독자입니다. 현재 목표와 조건을 기준으로 완료 여부를 판단하세요.",
          "완료되지 않았다면 확인한 결과와 남은 작업을 바탕으로 필요한 일을 계속하세요. 안전 필터를 다른 모델로 우회하지 마세요.",
          "실제 진행이 불가능하고 사용자 입력이나 외부 상태가 필요한 경우에만 blocked를 선택하세요.",
          `원래 목표: ${run.task}`,
          `이번 실행 결과: ${run.finalOutput ?? run.graph.nextAction}`,
          `검증 상태: ${run.graph.delivery ? `${run.graph.delivery.status} · ${run.graph.delivery.detail}` : "별도 검증 설정 없음"}`,
          `대화 및 추가 지시: ${renderMeetingTranscript(run.meeting)}`,
          ...(mailboxNotice
            ? [mailboxNotice, "확인이 없는 지시가 처리됐다고 단정하지 말고 남은 상태를 명시하세요."]
            : []),
          '반드시 <t3_persistent_verdict>{"decision":"complete"|"continue"|"blocked","summary":"확인한 결과와 근거","nextTask":"continue일 때 필요한 다음 작업"}</t3_persistent_verdict> 형식으로 답하세요.',
        ].join("\n\n"),
        usagePhase: "planning",
      });
      if (isProviderContentRefusal(turn.output))
        return yield* executionError(
          `감독 AI의 안전 필터로 진행 판단이 차단됐습니다: ${turn.output}`,
        );
      const verdict = yield* Effect.try({
        try: () => parsePersistentVerdict(turn.output),
        catch: (cause) => executionError(cause instanceof Error ? cause.message : String(cause)),
      });
      run = yield* requireRunContinuable(runRef);
      if (yield* parkPausedRun(run)) return;
      if (run.meeting === null || run.graph === null) return;
      if (
        verdict.decision !== "continue" &&
        run.meeting.interjections.length > observedInterjections
      ) {
        yield* enqueue(runRef);
        return;
      }
      const checkedAt = yield* nowIso;
      if (verdict.decision === "blocked") {
        yield* recordRunProgress(run, "blocked", verdict.summary);
        run = yield* requireRunContinuable(runRef);
        run = yield* persistRun({
          ...run,
          status: "failed",
          error: verdict.summary,
          updatedAt: checkedAt,
        });
      } else if (verdict.decision === "complete") {
        if (run.orchestra?.completionCheck === true && run.graph.delivery?.status !== "passed") {
          return yield* executionError(
            "감독자는 완료로 판단했지만 요청된 최종 검증이 통과하지 않았습니다.",
          );
        }
        const latestMailboxNotice = yield* unconfirmedInstructionNotice(run);
        run = yield* persistRun({
          ...run,
          status: "completed",
          meeting: {
            ...run.meeting,
            phase: "done",
            pendingSupervisorReview: false,
            supervisorReviewedInterjections: observedInterjections,
          },
          finalOutput: latestMailboxNotice
            ? `${verdict.summary}\n\n${latestMailboxNotice}`
            : verdict.summary,
          error: null,
          updatedAt: checkedAt,
        });
        if (run.status === "running" && run.meeting?.pendingSupervisorReview === true) {
          yield* enqueue(runRef);
          return;
        }
      } else {
        yield* recordRunProgress(run, "continue", verdict.summary, verdict.nextTask);
        run = yield* requireRunContinuable(runRef);
        if (run.meeting === null || run.graph === null) return;
        run = yield* persistRun({
          ...run,
          graph: null,
          steps: [],
          meeting: {
            ...run.meeting,
            phase: "planning",
            pendingSupervisorReview: false,
            supervisorReviewedInterjections: observedInterjections,
            turnFailures: [],
            continuation: {
              cycle: (run.meeting.continuation?.cycle ?? 0) + 1,
              workerTurns:
                (run.meeting.continuation?.workerTurns ?? 0) +
                run.graph.nodes.reduce((count, node) => count + node.attempts.length, 0),
              summary: verdict.summary,
              nextTask: verdict.nextTask!.trim(),
            },
          },
          finalOutput: null,
          error: null,
          updatedAt: checkedAt,
        });
        yield* enqueue(runRef);
      }
    }
    if (run.status === "completed") {
      yield* recordRunProgress(run, "complete", run.finalOutput ?? "작업 완료 보고 없음");
      yield* captureRunMemory(run);
    }
  }, Effect.scoped);

  const executeRun = Effect.fn("WorkspaceCollaborationReactor.executeRun")(function* (
    runRef: RunRef,
  ) {
    let run = yield* getRun(runRef);
    if (run.status === "cancel-requested") {
      return yield* new WorkspaceCollaborationCancelled({ runRef });
    }
    if (["cancelled", "completed", "failed"].includes(run.status)) return;

    if (run.graph !== null || run.steps.length === 0) {
      return yield* executeGraphRun(runRef);
    }
    if (yield* parkPausedRun(run)) return;

    if (run.steps.length === 0) {
      const listRoles = projectionSnapshotQuery.listWorkspaceAgentRoles;
      if (listRoles === undefined) {
        return yield* executionError("Workspace role projection is unavailable.");
      }
      const roles = yield* listRoles({ projectId: run.projectId });
      const steps = buildWorkspaceCollaborationSteps(roles.roles);
      if (steps.length === 0) {
        return yield* executionError(
          "An enabled coordinator role is required before collaboration can start.",
        );
      }
      run = { ...run, steps };
    }
    if (
      (run.source === "schedule" || run.source === "automation") &&
      run.steps.some((step) => step.runtimeMode === "approval-required")
    ) {
      return yield* executionError(
        "Unattended scheduled runs cannot use a role configured with approval-required runtime mode.",
      );
    }

    run = yield* persistRun({
      ...run,
      status: "running",
      error: null,
      updatedAt: yield* nowIso,
    });
    if (run.status === "cancel-requested" || run.status === "cancelled") {
      return yield* new WorkspaceCollaborationCancelled({ runRef });
    }

    const workspacePrompt = yield* composeRunPrompt(run);
    yield* recordPromptUsage({
      projectId: run.projectId,
      ...workspacePrompt,
    });

    for (let index = 0; index < run.steps.length; index += 1) {
      run = yield* requireRunContinuable(runRef);
      if (yield* parkPausedRun(run)) return;
      let step = run.steps[index]!;
      if (step.status === "completed") continue;
      if (step.status === "cancelled") {
        return yield* new WorkspaceCollaborationCancelled({ runRef });
      }
      if (step.status === "failed") {
        return yield* executionError(step.error ?? `Collaboration step ${index + 1} failed.`);
      }
      if (step.threadId === null) {
        const startedAt = yield* nowIso;
        step = {
          ...step,
          threadId:
            (run.orchestra === null
              ? undefined
              : run.steps.find((existing) => existing.threadId !== null)?.threadId) ??
            ThreadId.make(yield* randomUUID),
          status: "running",
          startedAt,
          completedAt: null,
          output: null,
          error: null,
        };
        run = yield* persistRun({
          ...replaceStep(run, index, step),
          status: "running",
          updatedAt: startedAt,
        });
        if (run.status === "cancel-requested" || run.status === "cancelled") {
          return yield* new WorkspaceCollaborationCancelled({ runRef });
        }
        step = run.steps[index]!;
      }

      const contextSource = yield* prepareContextSource(
        run,
        run.steps
          .slice(0, index)
          .filter((prior) => prior.status === "completed" && prior.output !== null)
          .map((prior) => `## Step ${prior.index + 1}: ${prior.displayName}\n${prior.output}`)
          .join("\n\n"),
      );
      const output = yield* ensureThreadAndTurn({
        run,
        step,
        prompt: buildWorkspaceCollaborationStepPrompt({
          ...(contextSource === undefined ? {} : { contextSource }),
          workspacePrompt: workspacePrompt.prompt,
          run,
          step,
          priorSteps: run.steps.slice(0, index),
        }),
        title: `${step.displayName}: ${run.task}`,
      });
      const completedAt = yield* nowIso;
      const completedStep: WorkspaceCollaborationStep = {
        ...step,
        status: "completed",
        output,
        error: null,
        completedAt,
      };
      const isFinal = index === run.steps.length - 1;
      run = yield* persistRun({
        ...replaceStep(run, index, completedStep),
        status: isFinal ? "completed" : "running",
        finalOutput: isFinal ? output : null,
        error: null,
        updatedAt: completedAt,
      });
      if (run.status === "cancel-requested" || run.status === "cancelled") {
        return yield* new WorkspaceCollaborationCancelled({ runRef });
      }
    }

    if (run.status === "completed") yield* captureRunMemory(run);
  });

  const finalizeCancelled = Effect.fn("WorkspaceCollaborationReactor.finalizeCancelled")(function* (
    runRef: RunRef,
  ) {
    const current = yield* getRun(runRef);
    if (current.status === "cancelled") return;
    if (current.status === "completed" || current.status === "failed") return;
    const settled = yield* settleInFlightWork(runRef, current, "cancelled", null);
    yield* persistRun({
      ...settled,
      status: "cancelled",
      error: null,
      updatedAt: settled.updatedAt,
    });
  });

  /**
   * Brings every piece of a run that is still in flight to a terminal state.
   *
   * A wave runs up to MAX_PARALLEL_GRAPH_NODES provider turns at once, so stopping only the
   * first one leaves the rest editing the working tree and spending quota under a run the
   * user already sees as finished. Folding the graph as well is what keeps a cancelled run
   * from displaying nodes as still running forever.
   */
  const settleInFlightWork = Effect.fn("WorkspaceCollaborationReactor.settleInFlightWork")(
    function* (
      runRef: RunRef,
      run: WorkspaceCollaborationRun,
      status: "cancelled" | "failed",
      error: string | null,
    ) {
      const settledAt = yield* nowIso;
      yield* Effect.forEach(
        run.steps.filter((step) => step.status === "running"),
        (step) => interruptThreadTurn(runRef, step.threadId),
        { concurrency: 1, discard: true },
      );
      const steps = run.steps.map((step) =>
        step.status === "running" || step.status === "queued"
          ? {
              ...step,
              status,
              error: status === "failed" ? error : step.error,
              completedAt: settledAt,
            }
          : step,
      );
      const graph =
        run.graph === null
          ? null
          : {
              ...run.graph,
              // The graph vocabulary has no cancelled state; a run that stopped early did
              // not converge either way.
              status: "failed" as const,
              nodes: run.graph.nodes.map((node) => {
                if (
                  node.status !== "running" &&
                  node.status !== "queued" &&
                  node.status !== "blocked" &&
                  node.status !== "awaiting-validation" &&
                  node.status !== "awaiting-user"
                ) {
                  return node;
                }
                const attempts = node.attempts.map((attempt) =>
                  attempt.status === "running"
                    ? { ...attempt, status, error, completedAt: settledAt }
                    : attempt,
                );
                return { ...node, attempts, status, parkedQuestion: null, completedAt: settledAt };
              }),
            };
      return {
        ...run,
        steps,
        graph,
        meeting: run.meeting === null ? null : { ...run.meeting, pendingQuestion: null },
        updatedAt: settledAt,
      };
    },
  );

  const finalizeFailed = Effect.fn("WorkspaceCollaborationReactor.finalizeFailed")(function* (
    runRef: RunRef,
    error: string,
  ) {
    const current = yield* getRun(runRef);
    if (current.status === "cancel-requested") {
      return yield* finalizeCancelled(runRef);
    }
    if (["cancelled", "completed", "failed"].includes(current.status)) return;
    const settled = yield* settleInFlightWork(runRef, current, "failed", error);
    yield* persistRun({
      ...settled,
      status: "failed",
      finalOutput: null,
      error,
      updatedAt: settled.updatedAt,
    });
  });

  /**
   * D7 trigger ②: a run that just settled releases the worktrees whose chains
   * hold no unmerged work; dirty ones stay for the person's diff review. A
   * parked run is not terminal and keeps its checkouts.
   */
  const cleanupTerminalRunWorktrees = (runRef: RunRef) =>
    getRun(runRef).pipe(
      Effect.flatMap((run) =>
        ["completed", "failed", "cancelled"].includes(run.status)
          ? worktreeCleanup.cleanupRunWorktrees(run)
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Workspace collaboration worktree cleanup was skipped", {
          projectId: runRef.projectId,
          runId: runRef.runId,
          cause: conciseCause(cause),
        }),
      ),
    );

  const publishRunSummary = Effect.fn("WorkspaceCollaborationReactor.publishRunSummary")(
    function* (runRef: RunRef) {
      const run = yield* getRun(runRef);
      const text = formatWorkspaceRunSummary(run);
      const threadId =
        run.meeting?.threadId ??
        run.workflow?.threadId ??
        run.runContext?.threadId ??
        (run.orchestra || run.workflow
          ? run.steps.find((step) => step.threadId !== null)?.threadId
          : null);
      if (!text || !threadId) return;
      const thread = yield* loadThread(runRef, threadId);
      if (Option.isNone(thread) || thread.value.deletedAt !== null) return;
      const messageId = MessageId.make(`orchestra-summary:${run.id}`);
      if (thread.value.messages.some((message) => message.id === messageId && !message.streaming))
        return;
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`orchestra-summary:${run.id}:text`),
        threadId,
        messageId,
        delta: text,
        createdAt: run.updatedAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`orchestra-summary:${run.id}:complete`),
        threadId,
        messageId,
        createdAt: run.updatedAt,
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Workspace collaboration summary could not be published", {
        cause: conciseCause(cause),
      }),
    ),
  );

  const executeSafely = (runRef: RunRef) =>
    Effect.gen(function* () {
      const startedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
      const initialRun = yield* getRun(runRef).pipe(Effect.option);
      const executionKind = Option.isSome(initialRun)
        ? initialRun.value.meeting !== null
          ? ("meeting" as const)
          : initialRun.value.workflow !== null
            ? ("workflow_v2" as const)
            : ("orchestra" as const)
        : ("orchestra" as const);
      const effectiveThreadId = Option.isSome(initialRun)
        ? (initialRun.value.meeting?.threadId ??
          initialRun.value.workflow?.threadId ??
          runRef.projectId)
        : runRef.projectId;
      let finalStatus: "completed" | "cancelled" | "failed" = "completed";
      let finalError: string | null = null;
      yield* unifiedExecutionLedger.beginEffect({
        executionId: runRef.runId,
        executionKind,
        threadId: effectiveThreadId,
        projectId: runRef.projectId,
        summary: `${executionKind}:${runRef.runId}`,
        startedAtMs,
      });
      yield* executeRun(runRef).pipe(
        Effect.catchTag("WorkspaceCollaborationCancelled", () => {
          finalStatus = "cancelled";
          return finalizeCancelled(runRef);
        }),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            finalStatus = "cancelled";
            return Effect.failCause(cause);
          }
          const error = conciseCause(cause);
          finalStatus = "failed";
          finalError = error;
          return finalizeFailed(runRef, error).pipe(
            Effect.catchCause((finalizeCause) =>
              Effect.logError("Workspace collaboration run failed and could not be finalized", {
                projectId: runRef.projectId,
                runId: runRef.runId,
                error,
                finalizeError: conciseCause(finalizeCause),
              }),
            ),
          );
        }),
        Effect.andThen(publishRunSummary(runRef)),
        Effect.andThen(cleanupTerminalRunWorktrees(runRef)),
        Effect.ensuring(
          Effect.sync(() => {
            unifiedExecutionLedger.finish({
              executionId: runRef.runId,
              executionKind,
              status: finalStatus,
              errorMessage: finalError,
            });
          }),
        ),
      );
    });

  const releaseClaim = (key: string) =>
    SynchronizedRef.update(claimedRunsRef, (current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    }).pipe(
      Effect.andThen(TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx)),
      Effect.andThen(
        SynchronizedRef.modify(rerunRequestsRef, (current) => {
          const requested = current.get(key);
          if (requested === undefined) return [undefined, current] as const;
          const next = new Map(current);
          next.delete(key);
          return [requested, next] as const;
        }).pipe(
          Effect.flatMap((requested) =>
            // Re-entering a settled run is a cheap no-op, so replaying is
            // always safe; dropping a wake-up is not.
            requested === undefined ? Effect.void : enqueue(requested),
          ),
        ),
      ),
    );

  const enqueue: (runRef: RunRef) => Effect.Effect<void, never, Scope.Scope> = Effect.fn(
    "WorkspaceCollaborationReactor.enqueue",
  )(function* (runRef: RunRef) {
    const key = runKey(runRef);
    const claimed = yield* SynchronizedRef.modify(claimedRunsRef, (current) => {
      if (current.has(key)) return [false, current] as const;
      const next = new Set(current);
      next.add(key);
      return [true, next] as const;
    });
    if (!claimed) {
      yield* SynchronizedRef.update(rerunRequestsRef, (current) => {
        const next = new Map(current);
        next.set(key, runRef);
        return next;
      });
      return;
    }
    yield* TxRef.update(outstanding, (count) => count + 1).pipe(Effect.tx);
    yield* forkParked(
      getRun(runRef).pipe(
        Effect.flatMap((run) => {
          const threadId = workspaceConversationThreadId(run);
          const key = run.meeting
            ? `${run.projectId}:conversation:${threadId ?? run.id}`
            : run.projectId;
          return getWorkspaceSemaphore(key);
        }),
        Effect.flatMap((semaphore) => semaphore.withPermit(executeSafely(runRef))),
        Effect.catchCause((cause) =>
          Effect.logError("Could not start workspace collaboration run", {
            runId: runRef.runId,
            cause: conciseCause(cause),
          }),
        ),
        Effect.ensuring(releaseClaim(key)),
      ),
    );
  });

  const preemptScheduledRuns = Effect.fn("WorkspaceCollaborationReactor.preemptScheduledRuns")(
    function* (projectId: ProjectId) {
      const runs = yield* runRepository.list({
        projectId,
        statuses: ["queued", "running", "cancel-requested"],
      });
      const scheduledRuns = runs.filter(
        (run) =>
          (run.source === "schedule" || run.source === "automation") &&
          // A run attached to a conversation belongs to that conversation alone.
          run.meeting?.threadId === undefined &&
          run.status !== "cancel-requested",
      );
      yield* Effect.forEach(
        scheduledRuns,
        (run) =>
          Effect.gen(function* () {
            yield* orchestrationEngine.dispatch({
              type: "project.collaboration.run.cancel",
              commandId: CommandId.make(yield* randomUUID),
              projectId,
              runId: run.id,
              createdAt: yield* nowIso,
            });
          }),
        { concurrency: 1, discard: true },
      );
    },
  );

  // Conversation runs must not preempt unrelated project automation, including on recovery.
  const enqueueRequestedRun = (run: WorkspaceCollaborationRun, preempt: boolean) =>
    (preempt && run.meeting?.threadId === undefined
      ? preemptScheduledRuns(run.projectId)
      : Effect.void
    ).pipe(Effect.andThen(enqueue({ projectId: run.projectId, runId: run.id })));

  /**
   * Deleting a project has to stop its collaboration work too. Without this the run keeps
   * going, and because a graph node that loses its thread simply retries, it creates fresh
   * threads and turns under a project the user already removed.
   */
  const cancelProjectRuns = Effect.fn("WorkspaceCollaborationReactor.cancelProjectRuns")(function* (
    projectId: ProjectId,
  ) {
    const runs = yield* runRepository.list({
      projectId,
      statuses: ["queued", "running"],
    });
    yield* Effect.forEach(
      runs,
      (run) =>
        Effect.gen(function* () {
          yield* orchestrationEngine.dispatch({
            type: "project.collaboration.run.cancel",
            commandId: CommandId.make(yield* randomUUID),
            projectId,
            runId: run.id,
            createdAt: yield* nowIso,
          });
        }),
      { concurrency: 1, discard: true },
    );
  });

  const enqueueEvent = (event: OrchestrationEvent) => {
    if (event.type === "project.collaboration-run-control-requested") {
      return enqueue({ projectId: event.payload.projectId, runId: event.payload.runId });
    }
    if (event.type === "project.collaboration-run-requested") {
      return enqueueRequestedRun(event.payload.run, event.payload.preempt);
    }
    if (event.type === "project.collaboration-run-reviewed") {
      return event.payload.approve
        ? enqueue({ projectId: event.payload.projectId, runId: event.payload.runId })
        : Effect.void;
    }
    if (event.type === "project.collaboration-verification-requested") {
      return enqueue({ projectId: event.payload.projectId, runId: event.payload.runId });
    }
    if (event.type === "project.collaboration-run-answered") {
      // The projection has already folded the answer in (projections apply
      // before events are published), so re-entering the run sees it.
      return enqueue({ projectId: event.payload.projectId, runId: event.payload.runId });
    }
    if (event.type === "project.collaboration-run-cancel-requested") {
      // An actively executing run notices this through its own wait interrupts;
      // a run parked on a question has no fiber, so the event must finalize it.
      limitWakeups.delete(
        runKey({ projectId: event.payload.projectId, runId: event.payload.runId }),
      );
      return enqueue({ projectId: event.payload.projectId, runId: event.payload.runId });
    }
    if (event.type === "project.deleted") {
      return cancelProjectRuns(event.payload.projectId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to cancel collaboration runs for a deleted project", {
            projectId: event.payload.projectId,
            cause: conciseCause(cause),
          }),
        ),
      );
    }
    return Effect.void;
  };

  const recoverInterruptedWatchdogs = Effect.fn("recoverInterruptedWatchdogs")(function* (
    run: WorkspaceCollaborationRun,
    startupSequence: number,
  ) {
    const threadId = run.meeting?.threadId;
    if (threadId && run.status === "cancel-requested" && Option.isSome(watchdogRuntime)) {
      const journal = watchdogRuntime.value.journal;
      yield* Effect.sync(() => cancelWatchdogsForRun(journal, threadId, run.id));
    }
    if (
      !threadId ||
      run.orchestra?.watchdogIntervalSeconds === undefined ||
      !projectionSnapshotQuery.getWatchdogActivitySequences
    )
      return;
    const thread = yield* projectionSnapshotQuery.getThreadRuntimeContext(threadId, {
      messages: true,
      activityKinds: ["orchestra.block"],
    });
    if (Option.isNone(thread) || thread.value.projectId !== run.projectId) return;
    const sequences = new Map(
      (yield* projectionSnapshotQuery.getWatchdogActivitySequences(threadId)).map((entry) => [
        entry.id,
        entry.sequence,
      ]),
    );
    for (const activity of thread.value.activities) {
      const sequence = sequences.get(activity.id);
      if (
        activity.kind !== "orchestra.block" ||
        sequence === undefined ||
        sequence > startupSequence ||
        !Schema.is(WorkspaceOrchestraBlock)(activity.payload)
      )
        continue;
      const block = activity.payload;
      if (
        (block.status !== "running" && block.status !== "awaiting-user") ||
        block.runId !== run.id ||
        block.ownerThreadId !== threadId ||
        !block.nodeId.startsWith("watchdog-")
      )
        continue;
      if (Option.isSome(watchdogRuntime)) {
        const journal = watchdogRuntime.value.journal;
        const detached = yield* Effect.sync(() =>
          journal.getByExecution(threadId, block.executionId),
        );
        if (detached) {
          if (run.status === "cancel-requested")
            yield* Effect.sync(() => journal.requestCancel(detached.id));
          const identity = yield* Effect.sync(() => journal.executionProvider(detached.id));
          const project = yield* projectionSnapshotQuery.getProjectShellById(run.projectId);
          if (
            identity &&
            identity.providerInstanceId === block.modelSelection.instanceId &&
            Option.isSome(project)
          ) {
            const worker = {
              execution: {
                executionId: block.executionId,
                ownerThreadId: block.ownerThreadId,
                runId: block.runId,
                nodeId: block.nodeId,
                attempt: block.attempt,
              },
              modelSelection: block.modelSelection,
              runtimeMode: thread.value.runtimeMode,
              interactionMode: thread.value.interactionMode,
              cwd: thread.value.worktreePath ?? project.value.workspaceRoot,
              prompt: "",
              title: block.title,
              displayName: block.displayName,
              role: block.role,
              kind: block.kind,
              ...(block.instruction === undefined ? {} : { instruction: block.instruction }),
              ...(block.usageWorkId === undefined ? {} : { usageWorkId: block.usageWorkId }),
              ...(block.usagePhase === undefined ? {} : { usagePhase: block.usagePhase }),
              startedAt: activity.createdAt,
            };
            const activate = Option.isSome(agentControl)
              ? agentControl.value.beginSupervisor({
                  projectId: run.projectId,
                  runId: run.id,
                  threadId,
                  providerInstanceId: block.modelSelection.instanceId,
                  executionId: block.executionId,
                })
              : Effect.fail(
                  new WorkspaceAgentControlError({
                    message: "감독자 권한 서비스를 확인할 수 없습니다.",
                  }),
                );
            const deactivate = Option.isSome(agentControl)
              ? agentControl.value.endSupervisor(block.executionId)
              : Effect.void;
            yield* forkParked(
              resumeDetachedWatchdog({
                journal,
                engine: orchestrationEngine,
                queries: projectionSnapshotQuery,
                jobId: detached.id,
                consumer: WATCHDOG_PROJECTION_CONSUMER,
                provider: ProviderDriverKind.make(identity.provider),
                providerInstanceId: block.modelSelection.instanceId,
                worker,
                activate,
                deactivate,
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("독립 감시 실행을 다시 연결하지 못했습니다", {
                        runId: run.id,
                        executionId: block.executionId,
                        cause: conciseCause(cause),
                      }),
                ),
              ),
              { startImmediately: true },
            );
          }
          // A separate worker might still be running. Its journal and proof,
          // not a server restart, determine whether it was interrupted.
          continue;
        }
      }
      // Terminal-run reconciliation only concerns jobs present in the durable
      // journal. Do not rewrite unrelated historical in-process blocks.
      if (["completed", "failed", "cancelled"].includes(run.status)) continue;
      const message = thread.value.messages.find((item) => item.id === block.messageId);
      const createdAt = yield* nowIso;
      const key = `${block.executionId}:${block.attempt}`;
      // Completing the partial message first lets a later boot retry the status
      // update if this process is interrupted between the two commands.
      if (message?.streaming && message.role === "assistant") {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(`watchdog-restart:${key}:complete`),
          threadId,
          messageId: block.messageId,
          createdAt,
        });
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`watchdog-restart:${key}:status`),
        threadId,
        createdAt,
        activity: {
          ...activity,
          tone: "error",
          summary:
            "서버 중단으로 감시 실행이 끊겼습니다. 이전 실행의 처리 결과는 확인되지 않았습니다.",
          payload: { ...block, status: "failed" },
        },
      });
    }
  });

  const enqueueStartupRuns = (startupSequence: number) =>
    runRepository.listResumable().pipe(
      Effect.flatMap((runs) => {
        const ordered = [...runs].toSorted((left, right) => {
          const priority = (left.source === "user" ? 0 : 1) - (right.source === "user" ? 0 : 1);
          return priority !== 0
            ? priority
            : left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
        });
        // The per-request `preempt` flag lives on the event, not on the run, so recovery
        // cannot read back what a particular request asked for. It falls back to the default
        // for the run's source, which finishes a preemption that a crash interrupted while
        // still leaving server-started integrity runs alone.
        return Effect.forEach(
          ordered,
          (run) =>
            recoverInterruptedWatchdogs(run, startupSequence).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("Interrupted watchdog recovery failed", {
                      runId: run.id,
                      cause: conciseCause(cause),
                    }),
              ),
              Effect.andThen(enqueueRequestedRun(run, run.source === "user")),
            ),
          {
            concurrency: 1,
            discard: true,
          },
        );
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Workspace collaboration startup recovery failed", {
          cause: conciseCause(cause),
        }),
      ),
    );

  const start: WorkspaceCollaborationReactorShape["start"] = Effect.fn("start")(function* () {
    const startupSequence = yield* orchestrationEngine.latestSequence;
    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, enqueueEvent), {
      startImmediately: true,
    });
    if (Option.isSome(watchdogRuntime)) {
      const journal = watchdogRuntime.value.journal;
      // Upgrade room turns are reattached by their own owner, never cancelled as runs.
      const active = yield* Effect.sync(() =>
        journal
          .listReconciliationContexts(WATCHDOG_PROJECTION_CONSUMER)
          .filter((entry) => entry.runId !== UPGRADE_ROOM_RUN_ID),
      );
      const reconciledTerminalRuns = new Set<string>();
      yield* Effect.forEach(
        active,
        (entry) =>
          Effect.gen(function* () {
            const owner = yield* projectionSnapshotQuery.getThreadRuntimeContext(
              ThreadId.make(entry.threadId),
            );
            if (Option.isNone(owner) || owner.value.deletedAt !== null) {
              yield* Effect.sync(() => journal.requestCancel(entry.id));
              return;
            }
            const project = yield* projectionSnapshotQuery.getProjectShellById(
              owner.value.projectId,
            );
            const run = Option.isSome(project)
              ? yield* runRepository.getById({
                  projectId: owner.value.projectId,
                  runId: WorkspaceCollaborationRunId.make(entry.runId),
                })
              : Option.none();
            if (
              Option.isNone(run) ||
              ["cancel-requested", "cancelled", "completed", "failed"].includes(run.value.status)
            )
              yield* Effect.sync(() => journal.requestCancel(entry.id));
            if (
              Option.isSome(run) &&
              ["cancelled", "completed", "failed"].includes(run.value.status) &&
              !reconciledTerminalRuns.has(`${entry.threadId}:${entry.runId}`)
            ) {
              reconciledTerminalRuns.add(`${entry.threadId}:${entry.runId}`);
              yield* recoverInterruptedWatchdogs(run.value, startupSequence);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("시작 중 감시 실행의 소속을 확인하지 못했습니다", {
                    executionId: entry.id,
                    cause: conciseCause(cause),
                  }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    }
    yield* enqueueStartupRuns(startupSequence);
    // D7 startup sweep: the live-event cleanup misses worktrees a crash left
    // behind. Deferred past boot so it never competes with startup recovery.
    yield* forkParked(
      Effect.sleep("15 seconds").pipe(Effect.andThen(worktreeCleanup.sweepOrphans())),
    );
  });

  const drain: WorkspaceCollaborationReactorShape["drain"] = TxRef.get(outstanding).pipe(
    Effect.tap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
    Effect.tx,
  );

  return { start, drain } satisfies WorkspaceCollaborationReactorShape;
});

export const WorkspaceCollaborationReactorLive = Layer.effect(
  WorkspaceCollaborationReactor,
  makeWorkspaceCollaborationReactor,
);
