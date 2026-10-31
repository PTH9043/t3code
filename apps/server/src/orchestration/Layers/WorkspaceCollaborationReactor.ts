import {
  graphRevisionCap,
  MAX_NODE_ATTEMPTS,
  INITIAL_PLAN_REVISION,
} from "../workspaceGraphLimits.ts";
import { compileWorkflowRun } from "../workspaceWorkflow.ts";
import { withWorkspaceRunControl, workspaceRunControl } from "@t3tools/shared/workflow";
import { WorkspaceWorkflowStore } from "../../persistence/WorkspaceWorkflowStore.ts";
import { workspaceConversationThreadId } from "../workspaceConversationContext.ts";
import { WorkspaceDevelopmentGit } from "../WorkspaceDevelopmentGit.ts";
import { WorkspaceDevelopment } from "../WorkspaceDevelopment.ts";
import { checkOrchestraDelivery } from "../WorkspaceOrchestraDelivery.ts";
import { formatWorkspaceRunSummary } from "../workspaceRunSummary.ts";
import { buildMeetingIntakePrompt, parseMeetingIntakeOutput } from "../workspaceMeetingIntake.ts";
import {
  CommandId,
  DEFAULT_WORKSPACE_CONTROL_SETTINGS,
  MessageId,
  ThreadId,
  ProviderExecutionId,
  WorkspaceKnowledgeItemId,
  WorkspaceTaskNodeId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProjectId,
  type WorkspaceAgentRoleBinding,
  type WorkspaceCollaborationRun,
  type WorkspaceCollaborationRunId,
  type WorkspaceCollaborationStep,
  type WorkspaceFailureClassification,
  type WorkspaceMeeting,
  type WorkspaceMeetingStatement,
  type WorkspaceTaskAttempt,
  type WorkspaceTaskGraph,
  type WorkspaceTaskNode,
  type WorkspaceTaskValidationReceipt,
} from "@t3tools/contracts";
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
import { planWorkspaceUsageRecovery } from "../workspaceUsageRecovery.ts";
import { WorkspaceAgentControl } from "../WorkspaceAgentControl.ts";
import { forkParked } from "../../serverActivation.ts";
import { toAgentKnowledgeCaptures } from "../workspaceAgentKnowledge.ts";
import {
  buildMeetingChairClosePrompt,
  buildMeetingPlanPrompt,
  buildMeetingStatementPrompt,
  isNodeInterventionQuestion,
  isProviderContentRefusal,
  meetingAssignmentRoute,
  nextMeetingStep,
  NODE_INTERVENTION_OPTIONS,
  nodeInterventionQuestion,
  nodeRefusalQuestion,
  parseChairVerdict,
  parseMeetingQuestion,
  parseNodeInterventionDecision,
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
  parseWorkspaceSynthesisPayload,
  parseWorkspaceTaskGraphProposal,
  parseWorkspaceValidationDecision,
  readyWorkspaceTaskNodes,
  selectGraphWaveNodes,
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
  WorkspaceAgentExecutionError,
  WorkspaceAgentExecutor,
} from "../Services/WorkspaceAgentExecutor.ts";
import {
  formatRepairDigest,
  latestFormatFailure,
  verifiedFormatRepairOutput,
  workspaceExecutionMessageId,
} from "../workspaceFormatRepair.ts";
import { orchestraWorkerCandidates, seatAssignedWorkers } from "../workspaceOrchestraRoster.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorkspaceMemory } from "../WorkspaceMemory.ts";
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
  return {
    participantIds: meeting.participants.map((participant) => participant.id),
    chairParticipantId: resolveChairParticipantId(meeting),
  };
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
      const route = resolveNodeAssignmentRoute({ node, meeting, bindings });
      if (attempt === undefined && route === null) {
        throw new WorkspaceTaskGraphError(
          node.participantId === null
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
        displayName: route?.displayName ?? node.title,
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

function conciseCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4_000);
}

export const makeWorkspaceCollaborationReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const turnWait = yield* OrchestrationTurnWait;
  const agentExecutor = yield* Effect.serviceOption(WorkspaceAgentExecutor);
  const memory = yield* Effect.serviceOption(WorkspaceMemory);
  const agentControl = yield* Effect.serviceOption(WorkspaceAgentControl);
  const development = yield* Effect.serviceOption(WorkspaceDevelopment);
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
    function* (run: WorkspaceCollaborationRun, prompt: string) {
      const unavailable =
        "<t3_memory_unavailable>사용자 필수 지침을 불러오지 못했습니다. 지침을 읽었다고 추측하지 말고 이 사실을 알리세요.</t3_memory_unavailable>";
      const folder = yield* resolveRunFolder(run);
      const directives = Option.isNone(memory)
        ? unavailable
        : yield* memory.value.context(run.projectId, run.task, true).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not prepare collaboration user directives", {
                cause,
              }).pipe(Effect.as(unavailable)),
            ),
          );
      const scopedConversation = yield* loadScopedConversation(run, folder.unavailable);
      return [
        prompt,
        directives,
        scopedConversation && !prompt.includes(scopedConversation) ? scopedConversation : "",
        folder.unavailable && !prompt.includes("<t3_folder_memory_unavailable>")
          ? folderUnavailable
          : "",
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

  const getWorkspaceSemaphore = (projectId: ProjectId) =>
    SynchronizedRef.modifyEffect(workspaceLocksRef, (current) => {
      const existing = current.get(projectId);
      if (existing !== undefined) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(projectId, semaphore);
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
      if (unavailable || Option.isNone(memory)) return folderUnavailable;
      const thread = yield* loadThread({ projectId: run.projectId, runId: run.id }, threadId);
      const message = Option.isSome(thread)
        ? thread.value.messages
            .filter(
              (entry) =>
                entry.role === "user" && !entry.streaming && entry.createdAt <= run.createdAt,
            )
            .at(-1)
        : undefined;
      if (!message) return folderUnavailable;
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
      return `${context}\n\n${unscopedWorkUnavailable}`;
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
        prompt: `${run.task}\n\n${folderUnavailable}`,
        sourceItemIds: [],
        sourceReferences: [],
        ragMatches: [],
        libraryMatches: [],
        truncated: false,
      };
    }
    const workflowContext = Option.isSome(development)
      ? yield* development.value
          .workflowContext(
            run.projectId,
            workspaceConversationThreadId(run) ?? run.runContext?.threadId ?? ThreadId.make(run.id),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not prepare the persistent workspace goal context", {
                cause,
              }).pipe(Effect.as("")),
            ),
          )
      : "";
    const task = [run.task, workflowContext]
      .filter((value) => value.trim().length > 0)
      .join("\n\n");
    const result = yield* compose({
      projectId: run.projectId,
      task,
      includeShared: false,
      includeSharedLibrary: false,
      ...(folder.unavailable || folder.paths === undefined ? {} : { contextPaths: folder.paths }),
      contextMode: "relevant",
      includeRag: true,
      includeWorkingMemory: true,
      includeLongTermMemory: true,
      ragLimit: 12,
      maxContextChars: 40_000,
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
      const instance = yield* providerInstanceRegistry.getInstance(
        input.step.modelSelection.instanceId,
      );
      if (instance === undefined || !instance.enabled) {
        return yield* executionError(
          `Provider instance '${input.step.modelSelection.instanceId}' assigned to role '${input.step.role}' is unavailable.`,
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
        const executionId = `orchestra:${input.run.id}:${nodeId}:${attempt.number}`;
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
        return yield* agentExecutor.value
          .execute({
            ...(input.run.workflow
              ? {
                  skills:
                    input.run.workflow.nodeSkills.find((entry) => entry.nodeId === nodeId)
                      ?.skills ?? [],
                  skillDriver: instance.driverKind,
                  allowAdditionalSkillWorkers: input.run.meeting?.allowAdditionalWorkers === true,
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
                        message:
                          "이전 입력의 전달·종료가 미확인입니다. 자동 재전송을 중단했습니다.",
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
              executionId: ProviderExecutionId.make(
                `orchestra:${input.run.id}:${nodeId}:${attempt.number}`,
              ),
              ownerThreadId: input.step.threadId,
              runId: input.run.id,
              nodeId,
              attempt: attempt.number,
            },
            modelSelection: input.step.modelSelection,
            ...(attempt.number > 1
              ? {
                  resumeFromSessionKey: ThreadId.make(
                    `orchestra:${input.run.id}:${nodeId}:${attempt.number - 1}`,
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
            ),
            cwd: input.worktree?.worktreePath ?? project.value.workspaceRoot,
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
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new WorkspaceCollaborationExecutionError({
                  message: error.message,
                  ...(error.interrupted === undefined ? {} : { interrupted: error.interrupted }),
                }),
            ),
          );
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

  const loadGraphBindings = Effect.fn("WorkspaceCollaborationReactor.loadGraphBindings")(function* (
    projectId: ProjectId,
    meeting: WorkspaceMeeting | null,
  ) {
    const listRoles = projectionSnapshotQuery.listWorkspaceAgentRoles;
    if (listRoles === undefined) {
      return yield* executionError("Workspace role projection is unavailable.");
    }
    const result = yield* listRoles({ projectId });
    // A meeting supplies its own chair and executors, so the project's role
    // bindings are optional there. They are still loaded: a meeting graph may
    // carry an unseated node, and that node still resolves through them.
    if (meeting === null && roleBinding(result.roles, "coordinator") === undefined) {
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
      readonly usagePhase?: import("@t3tools/contracts").TokenUsagePhase;
    }) {
      const runRef = { projectId: input.run.projectId, runId: input.run.id };
      const instance = yield* providerInstanceRegistry.getInstance(
        input.route.modelSelection.instanceId,
      );
      if (instance === undefined) {
        return yield* executionError(
          `Provider instance '${input.route.modelSelection.instanceId}' for meeting seat '${input.route.displayName}' is unavailable.`,
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
      const nodeId = WorkspaceTaskNodeId.make(`meeting-${yield* randomUUID}`);
      const output = yield* agentExecutor.value
        .execute({
          orchestraPhase: "meeting",
          execution: {
            executionId: ProviderExecutionId.make(`orchestra:${input.run.id}:${nodeId}:1`),
            ownerThreadId: threadId,
            runId: input.run.id,
            nodeId,
            attempt: 1,
          },
          modelSelection: input.route.modelSelection,
          runtimeMode: input.route.runtimeMode,
          interactionMode: input.route.interactionMode,
          cwd: project.value.workspaceRoot,
          prompt: yield* withRequiredDirectives(input.run, input.prompt),
          instruction: input.run.task,
          title:
            input.run.meeting?.phase === "clarifying"
              ? "지휘 AI · 질문 먼저"
              : input.usagePhase === "planning"
                ? "실행 계획"
                : "AI 토론",
          displayName: input.route.displayName,
          role: "coordinator",
          kind: "orchestration",
          startedAt: createdAt,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new WorkspaceCollaborationExecutionError({
                message: error.message,
                ...(error.interrupted === undefined ? {} : { interrupted: error.interrupted }),
              }),
          ),
        );
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
          if (failure && failure.count >= MAX_MEETING_TURN_ATTEMPTS) {
            return yield* executionError(failure.message);
          }
        });
      const recordTurnFailure = (key: string, message: string) =>
        Effect.gen(function* () {
          const current = yield* requireRunContinuable(input.runRef);
          const meeting = current.meeting;
          if (meeting === null) return yield* executionError("Meeting run lost its meeting state.");
          const failures = meeting.turnFailures ?? [];
          const count = (failures.find((entry) => entry.key === key)?.count ?? 0) + 1;
          yield* persistRun({
            ...current,
            meeting: {
              ...meeting,
              turnFailures: [
                ...failures.filter((entry) => entry.key !== key),
                { key, count, message },
              ],
            },
            updatedAt: yield* nowIso,
          });
          if (count >= MAX_MEETING_TURN_ATTEMPTS) {
            return yield* executionError(message);
          }
          yield* Effect.logWarning("Meeting turn failed; retrying", {
            projectId: input.runRef.projectId,
            runId: input.runRef.runId,
            step: key,
            error: message,
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
              const graph = yield* Effect.try({
                try: () => compileWorkflowRun(run),
                catch: (cause) =>
                  executionError(cause instanceof Error ? cause.message : String(cause)),
              });
              yield* persistGraphRun(
                { ...run, meeting: { ...meeting, phase: "executing" } },
                graph,
                input.bindings,
                { status: "running", updatedAt: yield* nowIso },
              );
              return true;
            }
            yield* ensureTurnBudget("plan");
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
              meeting,
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
            const route = meetingAssignmentRoute(meeting, chairId);
            const turn = yield* dispatchMeetingTurn({
              run,
              route,
              threadId: meetingThreadId,
              title: `${meeting.maxRounds === 0 ? "AI 협업" : "AI 회의"}: ${run.task}`,
              prompt: buildMeetingPlanPrompt({
                ...(yield* prepareMeetingContext(run, meeting)),
                workspacePrompt: input.workspacePrompt,
                task: run.task,
                meeting,
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
                ...meetingPlanContext(meeting),
                participantIds: [...meeting.participants, ...availableWorkers].map(
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
              { ...run, meeting: { ...assignedMeeting, phase: "executing" } },
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
          node.participantId === null
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
      const status = yield* gitWorkflow
        .localStatus({ cwd: project.workspaceRoot })
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
            projectCwd: project.workspaceRoot,
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
                  maxContextChars: needsOptionalMemory ? 40_000 : 8_000,
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
          return yield* ensureThreadAndTurn({
            run: input.run,
            step,
            node,
            prompt: buildWorkspaceTaskNodePrompt({
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
            }),
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
    const error = input.error.slice(0, 6_000);
    const consumesRevision = input.consumesRevision ?? true;
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
              : `'${node.title}' 단계가 실패해 다른 계정 또는 접근법으로 재시도합니다: ${error}`
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
              ? "독립적인 교차 검증 경로를 추가한다."
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
        // A run with no meeting has no channel to ask through and keeps the
        // old failing behaviour.
        if (
          settled === undefined ||
          (settled.status !== "failed" && !refused) ||
          meeting === null
        ) {
          return retried;
        }
        const question = refused
          ? nodeRefusalQuestion(settled.title)
          : nodeInterventionQuestion(settled.title);
        const context = failure.error.slice(0, 20_000);
        // Only one question is open at a time. A second node out of retries
        // parks its intervention on itself and is asked once the slot frees —
        // it used to fail the whole run instead, taking every sibling's
        // finished work with it.
        const slotFree = meeting.pendingQuestion === null;
        if (slotFree) {
          meeting = {
            ...meeting,
            pendingQuestion: {
              askedByParticipantId: settled.participantId,
              question,
              options: [...NODE_INTERVENTION_OPTIONS],
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
                  options: [...NODE_INTERVENTION_OPTIONS],
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
          const selection = current.attempts.at(-1)?.modelSelection;
          const instance =
            selection && input.run.orchestra?.resumeAfterLimit === true
              ? yield* providerInstanceRegistry.getInstance(selection.instanceId)
              : undefined;
          const snapshot = instance ? yield* instance.snapshot.getSnapshot : undefined;
          const recovery = planWorkspaceUsageRecovery({
            enabled: input.run.orchestra?.resumeAfterLimit === true,
            error: result.error,
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
              error: result.error!,
              completedAt,
            }));
            graph = refreshWorkspaceTaskGraphQueue({
              ...replaceGraphNode(graph, result.nodeId, {
                ...waiting,
                status: "queued",
                error: result.error,
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
            error: result.error,
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
          if (
            current.kind === "orchestration" &&
            !input.run.workflow?.definition.nodes.some((node) => node.id === current.id)
          ) {
            if (graph.revision >= revisionCap) {
              throw new WorkspaceTaskGraphError(
                `Task graph revision limit ${revisionCap - INITIAL_PLAN_REVISION} has been reached.`,
              );
            }
            const proposal = parseWorkspaceTaskGraphProposal(result.output, planContext);
            if (
              current.failureClassification === "information" &&
              !proposal.nodes.some((node) => node.kind === "research")
            ) {
              throw new WorkspaceTaskGraphError(
                "Information recovery plan requires a research node assigned to an available participant or role.",
              );
            }
            if (
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
                if (graph.revision >= revisionCap) {
                  throw new WorkspaceTaskGraphError(
                    `Task graph revision limit ${revisionCap - INITIAL_PLAN_REVISION} has been reached.`,
                  );
                }
                if (
                  classification === "information" &&
                  !decision.followUpNodes.some((node) => node.kind === "research")
                ) {
                  throw new WorkspaceTaskGraphError(
                    "Information recovery requires a research node assigned to an available participant or role.",
                  );
                }
                if (
                  classification === "implementation" &&
                  !decision.followUpNodes.some(
                    (node) => node.kind === "debug" || node.kind === "implementation",
                  )
                ) {
                  throw new WorkspaceTaskGraphError(
                    "Implementation recovery requires a debug or implementation node.",
                  );
                }
                if (
                  classification === "validation" &&
                  !decision.followUpNodes.some(
                    (node) => node.agent === "codex" || node.agent === "grok",
                  )
                ) {
                  throw new WorkspaceTaskGraphError(
                    "Validation recovery requires an independently validated research, implementation, or debug node.",
                  );
                }
                const followUpIds = new Set(decision.followUpNodes.map((node) => node.id));
                const knownNodes = new Map(graph.nodes.map((node) => [String(node.id), node]));
                for (const followUp of decision.followUpNodes) {
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
                    nodes: decision.followUpNodes,
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
            const completedNode: WorkspaceTaskNode = {
              ...withCompletedAttempt,
              status: "completed",
              output: truncateNodeOutput(synthesis.finalOutput),
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
            finalOutput = synthesis.finalOutput;
            continue;
          }

          // A meeting seat may pause its node on a question for the person. The
          // attempt itself completed; the node re-queues once the answer lands.
          if (
            meeting !== null &&
            current.participantId !== null &&
            (!STRUCTURED_NODE_KINDS.includes(current.kind) ||
              (current.kind === "orchestration" &&
                input.run.workflow?.definition.nodes.some((node) => node.id === current.id)))
          ) {
            const raised = parseMeetingQuestion(result.output);
            if (raised !== null) {
              // First asker wins the single question slot; a later asker keeps
              // its question on the node and is asked once the slot frees,
              // rather than re-running to raise it again.
              const slotFree = meeting.pendingQuestion === null;
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
                      `orchestra:${input.run.id}:${current.id}:${attempt.number}`,
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
      const status =
        graph.status === "completed"
          ? freshRun.orchestra?.completionCheck === true
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
        ? yield* checkOrchestraDelivery(current, project.value.workspaceRoot, checkedAt).pipe(
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
    return yield* persistRun({
      ...current,
      status: result.status === "passed" ? "completed" : "running",
      graph: { ...current.graph, delivery: result },
      meeting:
        current.meeting === null
          ? null
          : {
              ...current.meeting,
              phase: result.status === "passed" ? "done" : current.meeting.phase,
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
          .inspect(project.value.workspaceRoot)
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
            .inspect(project.value.workspaceRoot)
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
      readonly nodeId: string;
      readonly cause: WorkspaceCollaborationCancelled | WorkspaceCollaborationExecutionError | null;
    }>();
    const inFlight = new Set<string>();
    const resultLock = yield* Semaphore.make(1);
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
      if (run.meeting !== null && inFlight.size === 0) {
        if (run.meeting.pendingQuestion !== null) return;
        if (run.graph.nodes.some((node) => node.status === "awaiting-user")) {
          // The person answered; parked seats rejoin the queue and re-run with
          // the recorded decision in their prompt. A node parked because its
          // retries ran out (`awaiting-user` WITH an error) also takes the
          // person's verdict on what to do with it.
          const lastAnswer = run.meeting.answers.at(-1) ?? null;
          const verdict =
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
          const parkedNext =
            run.graph.nodes
              .filter((node) => node.status === "awaiting-user" && node.parkedQuestion !== null)
              .toSorted((left, right) => left.order - right.order)
              .find((node) => !answered(node)) ?? null;

          if (verdict?.kind === "stop") {
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

          const graph = refreshWorkspaceTaskGraphQueue({
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
              const nextSeat = run.meeting!.participants.find(
                (participant) => participant.id !== node.participantId,
              );
              // A new seat is a new driver: its conversation starts fresh.
              return nextSeat === undefined
                ? granted
                : { ...granted, participantId: nextSeat.id, threadId: null };
            }),
          });
          // The slot is free again: the next node waiting with a question of
          // its own is asked now, and the run parks until that answer lands.
          if (parkedNext !== null && parkedNext.parkedQuestion !== null) {
            const parked = parkedNext.parkedQuestion;
            run = yield* persistGraphRun(
              {
                ...run,
                meeting: {
                  ...run.meeting,
                  pendingQuestion: {
                    askedByParticipantId: parkedNext.participantId,
                    question: parked.question,
                    options: parked.options,
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
            return;
          }
          run = yield* persistGraphRun(run, graph, bindings, { updatedAt: answeredAt });
          continue;
        }
      }
      const scheduled = yield* resultLock.withPermit(
        Effect.gen(function* () {
          const current = yield* requireRunContinuable(runRef);
          if (
            workspaceRunControl(current).control !== "active" ||
            current.graph === null ||
            current.meeting?.pendingQuestion ||
            ["completed", "failed"].includes(current.graph.status)
          )
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
        return yield* executionError(
          "Task graph is deadlocked: no runnable task or active worker.",
        );
      }
      const settled = yield* Queue.take(finished);
      inFlight.delete(settled.nodeId);
      if (settled.cause !== null) return yield* settled.cause;
      run = yield* requireRunContinuable(runRef);
    }
    if (yield* parkPausedRun(run)) return;
    run = yield* finalizeDelivery(runRef);
    if (run.status === "completed") yield* captureRunMemory(run);
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
    executeRun(runRef).pipe(
      Effect.catchTag("WorkspaceCollaborationCancelled", () => finalizeCancelled(runRef)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const error = conciseCause(cause);
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
    );

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
      getWorkspaceSemaphore(runRef.projectId).pipe(
        Effect.flatMap((semaphore) => semaphore.withPermit(executeSafely(runRef))),
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

  const enqueueRequestedRun = (run: WorkspaceCollaborationRun, preempt: boolean) =>
    (preempt ? preemptScheduledRuns(run.projectId) : Effect.void).pipe(
      Effect.andThen(enqueue({ projectId: run.projectId, runId: run.id })),
    );

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

  const enqueueStartupRuns = runRepository.listResumable().pipe(
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
      return Effect.forEach(ordered, (run) => enqueueRequestedRun(run, run.source === "user"), {
        concurrency: 1,
        discard: true,
      });
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("Workspace collaboration startup recovery failed", {
        cause: conciseCause(cause),
      }),
    ),
  );

  const start: WorkspaceCollaborationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, enqueueEvent), {
      startImmediately: true,
    });
    yield* enqueueStartupRuns;
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
