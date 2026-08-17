import {
  CommandId,
  DEFAULT_WORKSPACE_CONTROL_SETTINGS,
  MessageId,
  ThreadId,
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
  type WorkspaceMeetingParticipantId,
  type WorkspaceMeetingStatement,
  type WorkspaceTaskAttempt,
  type WorkspaceTaskGraph,
  type WorkspaceTaskNode,
  type WorkspaceTaskValidationReceipt,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as TxRef from "effect/TxRef";

import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import { toAgentKnowledgeCaptures } from "../workspaceAgentKnowledge.ts";
import {
  buildMeetingChairClosePrompt,
  buildMeetingPlanPrompt,
  buildMeetingStatementPrompt,
  meetingAssignmentRoute,
  nextMeetingStep,
  parseChairVerdict,
  parseMeetingQuestion,
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
  materializeWorkspaceTaskGraphPlan,
  parseWorkspaceSynthesisPayload,
  parseWorkspaceTaskGraphProposal,
  parseWorkspaceValidationDecision,
  readyWorkspaceTaskNodes,
  refreshWorkspaceTaskGraphQueue,
  WorkspaceTaskGraphError,
  type WorkspaceMeetingPlanContext,
} from "../workspaceTaskGraph.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationTurnWait } from "../Services/OrchestrationTurnWait.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
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
}> {}

const MAX_PARALLEL_GRAPH_NODES = 3;
const MAX_GRAPH_REVISIONS = 8;
const MAX_AGENT_RESPONSE_CHARS = 160_000;
const MAX_NODE_HANDOFF_CHARS = 40_000;
const MAX_ATTEMPT_RECORD_CHARS = 8_000;
/** A meeting turn (statement, chair close, plan) is retried once before the run fails. */
const MAX_MEETING_TURN_ATTEMPTS = 2;
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
  | { readonly nodeId: string; readonly output?: never; readonly error: string };

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
  return text.length > 0
    ? text.slice(0, MAX_AGENT_RESPONSE_CHARS)
    : "Agent completed without a textual handoff.";
}

function conciseCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4_000);
}

export const makeWorkspaceCollaborationReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const turnWait = yield* OrchestrationTurnWait;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const runRepository = yield* ProjectionWorkspaceCollaborationRunRepository;
  const providerInstanceRegistry = yield* ProviderInstanceRegistry;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const workspaceLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const claimedRunsRef = yield* SynchronizedRef.make(new Set<string>());
  // Wake-ups that arrived while the run was claimed. A parked meeting run can
  // release its claim just after an answer or cancel event was dropped as a
  // duplicate; replaying the wake-up on release closes that window.
  const rerunRequestsRef = yield* SynchronizedRef.make(new Map<string, RunRef>());
  const outstanding = yield* TxRef.make(0);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const executionError = (message: string) => new WorkspaceCollaborationExecutionError({ message });
  const runKey = (runRef: RunRef) => `${runRef.projectId}:${runRef.runId}`;

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
    return yield* getRun({ projectId: run.projectId, runId: run.id });
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
    const result = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
    if (Option.isSome(result) && result.value.projectId !== runRef.projectId) {
      return yield* executionError("Collaboration thread crossed its Workspace boundary.");
    }
    return result;
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
      const current = yield* getRun(runRef);
      if (current.status === "cancel-requested" || current.status === "cancelled") {
        return yield* new WorkspaceCollaborationCancelled({ runRef });
      }
      return yield* executionError(`Collaboration turn '${result.turn.turnId}' was interrupted.`);
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
      if (instance === undefined) {
        return yield* executionError(
          `Provider instance '${input.step.modelSelection.instanceId}' assigned to role '${input.step.role}' is unavailable.`,
        );
      }
      const expectedDriver =
        input.expectedAgent === "codex" ? "codex" : input.expectedAgent === "grok" ? "grok" : null;
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
          commandId: CommandId.make(yield* randomUUID),
          threadId: input.step.threadId,
          projectId: input.run.projectId,
          title: `Collaboration ${input.step.role}: ${taskTitle}`,
          modelSelection: input.step.modelSelection,
          runtimeMode: input.step.runtimeMode,
          interactionMode: input.step.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt,
        });
        thread = yield* loadThread(runRef, input.step.threadId);
      }

      if (Option.isNone(thread)) {
        return yield* executionError(
          `Collaboration thread '${input.step.threadId}' was not projected after creation.`,
        );
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
  }) =>
    Effect.gen(function* () {
      if (input.sourceItemIds.length === 0) return;
      yield* orchestrationEngine.dispatch({
        type: "project.knowledge.usage.record",
        commandId: CommandId.make(yield* randomUUID),
        projectId: input.projectId,
        itemIds: input.sourceItemIds,
        usedAt: yield* nowIso,
      });
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
        "An enabled Fable coordinator role is required before a task graph can start.",
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
      } else {
        const session = existing.value.session;
        if (
          session !== null &&
          session.status !== "stopped" &&
          session.providerName !== null &&
          session.providerName !== instance.driverKind
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make(yield* randomUUID),
            threadId,
            createdAt,
          });
        }
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(yield* randomUUID),
        threadId,
        message: {
          messageId: MessageId.make(yield* randomUUID),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        inputOrigin: "automation",
        modelSelection: input.route.modelSelection,
        runtimeMode: input.route.runtimeMode,
        interactionMode: input.route.interactionMode,
        createdAt,
      });
      // A wave that collapses — a cancel, a sibling seat failing the run — must
      // not leave this seat's provider turn running unattended.
      const output = yield* awaitStepOutput(runRef, threadId, createdAt).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure" ? interruptThreadTurn(runRef, threadId) : Effect.void,
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
      // Failures are counted per seat and step, in memory only: a retry after a
      // server restart gets a fresh budget, which errs toward finishing meetings.
      const failures = new Map<string, number>();
      const recordTurnFailure = (key: string, message: string) =>
        Effect.gen(function* () {
          const count = (failures.get(key) ?? 0) + 1;
          failures.set(key, count);
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
            const results = yield* Effect.forEach(
              step.speakers,
              (participantId) =>
                Effect.gen(function* () {
                  const route = meetingAssignmentRoute(meeting, participantId);
                  // Reload between seats: an interjection the person made while
                  // the previous seat was speaking (and a cancel) must reach the
                  // very next speaker, not the next round.
                  const liveRun = yield* requireRunContinuable(input.runRef);
                  const liveMeeting = liveRun.meeting ?? meeting;
                  const turn = yield* dispatchMeetingTurn({
                    run: currentRun,
                    route,
                    threadId: meetingThreadId,
                    title: `AI 회의: ${currentRun.task}`,
                    prompt: buildMeetingStatementPrompt({
                      // Later rounds argue over the transcript; only the opening
                      // round pays for the full Workspace corpus.
                      workspacePrompt: roundIndex === 0 ? input.workspacePrompt : null,
                      task: currentRun.task,
                      meeting: { ...meeting, interjections: liveMeeting.interjections },
                      participantId,
                      roundIndex,
                    }),
                  });
                  return { kind: "spoke" as const, participantId, ...turn };
                }).pipe(
                  Effect.catchTag("WorkspaceCollaborationExecutionError", (error) =>
                    Effect.succeed({
                      kind: "failed" as const,
                      participantId,
                      message: error.message,
                    }),
                  ),
                ),
              // One shared conversation runs one turn at a time: the seats
              // speak in order, the way a table actually talks.
              { concurrency: 1 },
            );

            const recordedAt = yield* nowIso;
            const spoke = results.flatMap((result) => (result.kind === "spoke" ? [result] : []));
            const statements: WorkspaceMeetingStatement[] = spoke.map((result) => ({
              participantId: result.participantId,
              content: result.output.slice(0, MAX_MEETING_STATEMENT_CHARS),
              respondsTo: parseStatementRespondsTo(result.output, meeting, result.participantId),
              threadId: result.threadId,
              recordedAt,
            }));
            const raised = spoke
              .map((result) => ({
                participantId: result.participantId,
                question: parseMeetingQuestion(result.output),
              }))
              .find(
                (
                  candidate,
                ): candidate is {
                  participantId: WorkspaceMeetingParticipantId;
                  question: WorkspaceMeetingRaisedQuestion;
                } => candidate.question !== null,
              );
            if (statements.length > 0 || raised !== undefined) {
              run = yield* persistRun({
                ...run,
                meeting: {
                  ...meeting,
                  rounds: meeting.rounds.map((candidate) =>
                    candidate.index === roundIndex
                      ? { ...candidate, statements: [...candidate.statements, ...statements] }
                      : candidate,
                  ),
                  pendingQuestion:
                    raised === undefined
                      ? meeting.pendingQuestion
                      : {
                          askedByParticipantId: raised.participantId,
                          question: raised.question.question,
                          options: raised.question.options,
                          context: raised.question.context,
                          askedAt: recordedAt,
                        },
                },
                updatedAt: recordedAt,
              });
            }
            // Failures are counted after the successes are safely persisted, so a
            // seat that gives up cannot take the round's statements down with it.
            for (const result of results) {
              if (result.kind !== "failed") continue;
              yield* recordTurnFailure(
                `statement:${roundIndex}:${result.participantId}`,
                `Meeting statement turn for seat '${result.participantId}' failed: ${result.message}`,
              );
            }
            continue;
          }

          case "close-round": {
            const roundIndex = step.roundIndex;
            const failureKey = `close:${roundIndex}`;
            const chairId = resolveChairParticipantId(meeting);
            const route = meetingAssignmentRoute(meeting, chairId);
            const turn = yield* dispatchMeetingTurn({
              run,
              route,
              threadId: meetingThreadId,
              title: `AI 회의: ${run.task}`,
              prompt: buildMeetingChairClosePrompt({ task: run.task, meeting, roundIndex }),
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
              verdict.summary.slice(0, MAX_MEETING_SUMMARY_CHARS - nomination.length) + nomination;
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
                },
              },
              updatedAt: askedAt,
            });
            continue;
          }

          case "plan": {
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
              title: `AI 회의: ${run.task}`,
              prompt: buildMeetingPlanPrompt({
                workspacePrompt: input.workspacePrompt,
                task: run.task,
                meeting,
              }),
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
                  },
                },
                updatedAt: askedAt,
              });
              continue;
            }
            const occurredAt = yield* nowIso;
            let graph: WorkspaceTaskGraph;
            try {
              const planContext = meetingPlanContext(meeting);
              const proposal = parseWorkspaceTaskGraphProposal(turn.output, planContext);
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
              { ...run, meeting: { ...meeting, phase: "executing" } },
              graph,
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

      const instances = yield* providerInstanceRegistry.listInstances;
      const usedInstanceIds = new Set(
        node.attempts.map((attempt) => attempt.modelSelection.instanceId),
      );
      const primary = instances.find(
        (instance) => instance.instanceId === route.modelSelection.instanceId,
      );
      const expectedDriver =
        node.agent === "codex" ? "codex" : node.agent === "grok" ? "grok" : primary?.driverKind;
      const alternative = instances.find(
        (instance) =>
          instance.enabled &&
          expectedDriver !== undefined &&
          instance.driverKind === expectedDriver &&
          !usedInstanceIds.has(instance.instanceId),
      );
      const previous = node.attempts.at(-1);
      return {
        route,
        modelSelection:
          alternative === undefined
            ? route.modelSelection
            : { ...route.modelSelection, instanceId: alternative.instanceId },
        strategy:
          alternative === undefined
            ? `Previous attempt failed (${previous?.failureClassification ?? "unknown"}). Keep the configured account but use a materially different method and verify the failure cause first.`
            : `Previous route failed. Reroute to provider account '${alternative.instanceId}' and avoid repeating the prior approach.`,
      } as const;
    },
  );

  const startGraphWave = Effect.fn("WorkspaceCollaborationReactor.startGraphWave")(
    function* (input: {
      readonly run: WorkspaceCollaborationRun;
      readonly bindings: ReadonlyArray<WorkspaceAgentRoleBinding>;
      readonly nodes: ReadonlyArray<WorkspaceTaskNode>;
    }) {
      if (input.run.graph === null) return yield* executionError("Task graph is unavailable.");
      const meeting = input.run.meeting;
      // A meeting is one shared conversation, and one conversation runs one
      // turn at a time — its waves take a single node and leave the rest for
      // the next wave. Role-bound runs keep their parallel per-attempt threads.
      const waveNodes =
        meeting === null ? input.nodes.slice(0, MAX_PARALLEL_GRAPH_NODES) : input.nodes.slice(0, 1);
      const startedNodes = yield* Effect.forEach(
        waveNodes,
        (node) =>
          Effect.gen(function* () {
            const route = yield* chooseAttemptRoute(node, input.bindings, input.run.meeting);
            const startedAt = yield* nowIso;
            const meetingThreadId =
              meeting !== null && node.participantId !== null ? meeting.threadId : null;
            const attempt: WorkspaceTaskAttempt = {
              number: node.attempts.length + 1,
              agent: node.agent,
              role: node.role,
              modelSelection: route.modelSelection,
              runtimeMode: route.route.runtimeMode,
              interactionMode: route.route.interactionMode,
              strategy: route.strategy,
              threadId: meetingThreadId ?? ThreadId.make(yield* randomUUID),
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
              status: "running" as const,
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
        nodes: input.run.graph.nodes.map((node) => replacements.get(String(node.id)) ?? node),
        nextAction: `실행 중: ${startedNodes.map((node) => node.title).join(", ")}`,
      };
      return yield* persistGraphRun(input.run, graph, input.bindings, {
        status: "running",
        error: null,
        updatedAt: yield* nowIso,
      });
    },
  );

  const executeGraphWave = Effect.fn("WorkspaceCollaborationReactor.executeGraphWave")(
    function* (input: {
      readonly run: WorkspaceCollaborationRun;
      readonly bindings: ReadonlyArray<WorkspaceAgentRoleBinding>;
      readonly workspacePrompt: string;
    }) {
      if (input.run.graph === null) return yield* executionError("Task graph is unavailable.");
      const graph = input.run.graph;
      const running = graph.nodes.filter((node) => node.status === "running");
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
                  `${binding.role}: ${binding.displayName} -> ${binding.modelSelection.instanceId} / ${binding.modelSelection.model}`,
              );
      // Steps mirror the nodes in (order, id) order; matching by position keeps
      // the lookup exact even when several nodes share one seat thread.
      const sortedNodeIds = graph.nodes
        .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id))
        .map((node) => String(node.id));
      return yield* Effect.forEach(
        running,
        (node) => {
          const attempt = node.attempts.at(-1);
          if (attempt === undefined) {
            return Effect.succeed({
              nodeId: String(node.id),
              error: `Running node '${node.id}' has no attempt.`,
            });
          }
          const step = compatibilitySteps[sortedNodeIds.indexOf(String(node.id))];
          if (step === undefined) {
            return Effect.succeed({
              nodeId: String(node.id),
              error: `Running node '${node.id}' has no compatibility step.`,
            });
          }
          return ensureThreadAndTurn({
            run: input.run,
            step,
            prompt: buildWorkspaceTaskNodePrompt({
              workspacePrompt: input.workspacePrompt,
              run: input.run,
              graph,
              node,
              availableAgents,
              meeting: input.run.meeting,
            }),
            title:
              node.participantId === null
                ? `${node.agent.toUpperCase()}: ${node.title}`
                : node.title,
            // A seat's account is whatever the person picked; only role-bound
            // nodes pin the provider driver to the agent.
            ...(node.participantId === null ? { expectedAgent: node.agent } : {}),
            // Anchors this attempt's turn inside the seat's reused conversation.
            turnAfter: attempt.startedAt,
          }).pipe(
            Effect.map((output) => ({ nodeId: String(node.id), output })),
            Effect.catchTag("WorkspaceCollaborationExecutionError", (error) =>
              Effect.succeed({ nodeId: String(node.id), error: error.message }),
            ),
          );
        },
        { concurrency: MAX_PARALLEL_GRAPH_NODES },
      );
    },
  );

  const retryGraphNode = (input: {
    readonly graph: WorkspaceTaskGraph;
    readonly node: WorkspaceTaskNode;
    readonly error: string;
    readonly classification: WorkspaceFailureClassification;
    readonly completedAt: string;
  }): WorkspaceTaskGraph => {
    const error = input.error.slice(0, 6_000);
    const failedAttemptNode = updateLastAttempt(input.node, (attempt) => ({
      ...attempt,
      status: "failed",
      output: null,
      error,
      failureClassification: input.classification,
      completedAt: input.completedAt,
    }));
    const mayRetry =
      failedAttemptNode.attempts.length < failedAttemptNode.maxAttempts &&
      input.graph.revision < MAX_GRAPH_REVISIONS;
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
    const revision = Math.min(input.graph.revision + 1, MAX_GRAPH_REVISIONS);
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
            ? `${node.title} 실패를 분류하고 다른 계정 또는 접근법으로 재시도합니다: ${error}`
            : `${node.title}의 재시도 한도에 도달했습니다: ${error}`,
          addedNodeIds: [],
          supersededNodeIds: mayRetry ? [] : [node.id],
          occurredAt: input.completedAt,
        },
      ],
      nextAction: mayRetry
        ? `${node.title}을 이전과 다른 경로로 재시도합니다.`
        : `${node.title} 실패로 사용자 개입이 필요합니다.`,
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
    const revision = input.graph.revision + 1;
    if (revision > MAX_GRAPH_REVISIONS) {
      return {
        ...input.graph,
        status: "failed",
        nextAction: "동적 그래프 개정 한도에 도달해 사용자 판단이 필요합니다.",
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
        ? "정보 부족을 해소할 Grok 조사 노드를 반드시 포함한다."
        : input.classification === "implementation"
          ? "실패 원인을 수정할 Codex debug 노드를 반드시 포함한다."
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
      let meeting = input.run.meeting;
      const planContext = meeting === null ? null : meetingPlanContext(meeting);

      for (const result of input.results) {
        const current = graph.nodes.find((node) => node.id === result.nodeId);
        if (current === undefined || current.status !== "running") continue;
        const completedAt = yield* nowIso;
        if (result.error !== undefined) {
          graph = retryGraphNode({
            graph,
            node: current,
            error: result.error,
            classification: "tool",
            completedAt,
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
        try {
          if (current.kind === "orchestration") {
            if (graph.revision >= MAX_GRAPH_REVISIONS) {
              throw new WorkspaceTaskGraphError(
                `Task graph revision limit ${MAX_GRAPH_REVISIONS} has been reached.`,
              );
            }
            const proposal = parseWorkspaceTaskGraphProposal(result.output, planContext);
            if (
              current.failureClassification === "information" &&
              !proposal.nodes.some((node) => node.kind === "research")
            ) {
              throw new WorkspaceTaskGraphError(
                "Information recovery plan requires a Grok research node.",
              );
            }
            if (
              current.failureClassification === "implementation" &&
              !proposal.nodes.some(
                (node) => node.kind === "debug" || node.kind === "implementation",
              )
            ) {
              throw new WorkspaceTaskGraphError(
                "Implementation recovery plan requires a Codex debug node.",
              );
            }
            if (
              current.failureClassification === "validation" &&
              !proposal.nodes.some((node) => node.agent === "codex" || node.agent === "grok")
            ) {
              throw new WorkspaceTaskGraphError(
                "Validation recovery plan requires an independently validated Codex or Grok node.",
              );
            }
            const completedNode: WorkspaceTaskNode = {
              ...withCompletedAttempt,
              status: "completed",
              output: result.output.slice(0, MAX_NODE_HANDOFF_CHARS),
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
              output: result.output.slice(0, MAX_NODE_HANDOFF_CHARS),
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
                if (graph.revision >= MAX_GRAPH_REVISIONS) {
                  throw new WorkspaceTaskGraphError(
                    `Task graph revision limit ${MAX_GRAPH_REVISIONS} has been reached.`,
                  );
                }
                if (
                  classification === "information" &&
                  !decision.followUpNodes.some((node) => node.kind === "research")
                ) {
                  throw new WorkspaceTaskGraphError(
                    "Information recovery requires a Grok research node.",
                  );
                }
                if (
                  classification === "implementation" &&
                  !decision.followUpNodes.some(
                    (node) => node.kind === "debug" || node.kind === "implementation",
                  )
                ) {
                  throw new WorkspaceTaskGraphError(
                    "Implementation recovery requires a Codex debug node.",
                  );
                }
                if (
                  classification === "validation" &&
                  !decision.followUpNodes.some(
                    (node) => node.agent === "codex" || node.agent === "grok",
                  )
                ) {
                  throw new WorkspaceTaskGraphError(
                    "Validation recovery requires an independently validated Codex or Grok node.",
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
                output: synthesis.finalOutput.slice(0, MAX_NODE_HANDOFF_CHARS),
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
              output: synthesis.finalOutput.slice(0, MAX_NODE_HANDOFF_CHARS),
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
            !STRUCTURED_NODE_KINDS.includes(current.kind)
          ) {
            const raised = parseMeetingQuestion(result.output);
            if (raised !== null) {
              graph = replaceGraphNode(graph, result.nodeId, {
                ...withCompletedAttempt,
                status: "awaiting-user",
                output: null,
                error: null,
                completedAt: null,
              });
              // First asker wins the single question slot; later askers stay
              // parked and can re-raise on their re-run.
              if (meeting.pendingQuestion === null) {
                meeting = {
                  ...meeting,
                  pendingQuestion: {
                    askedByParticipantId: current.participantId,
                    question: raised.question,
                    options: raised.options,
                    context: raised.context,
                    askedAt: completedAt,
                  },
                };
              }
              continue;
            }
          }

          const completedNode: WorkspaceTaskNode = {
            ...withCompletedAttempt,
            status: current.agent === "fable" ? "completed" : "awaiting-validation",
            output: result.output.slice(0, MAX_NODE_HANDOFF_CHARS),
            error: null,
            completedAt: current.agent === "fable" ? completedAt : null,
          };
          graph = replaceGraphNode(graph, result.nodeId, completedNode);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          graph = retryGraphNode({
            graph: graphBeforeResult,
            node: withCompletedAttempt,
            error: message,
            classification: "validation",
            completedAt,
          });
        }
      }

      graph = refreshWorkspaceTaskGraphQueue(graph);
      if (graph.status !== "completed" && graph.status !== "failed") {
        const ready = readyWorkspaceTaskNodes(graph);
        graph = {
          ...graph,
          status: ready.some((node) => node.kind === "validation")
            ? "validating"
            : ready.some((node) => node.kind === "synthesis")
              ? "synthesizing"
              : "executing",
          nextAction:
            ready.length === 0
              ? graph.nextAction
              : `다음 실행: ${ready
                  .slice(0, MAX_PARALLEL_GRAPH_NODES)
                  .map((node) => node.title)
                  .join(", ")}`,
        };
      }
      const status =
        graph.status === "completed"
          ? "completed"
          : graph.status === "failed"
            ? "failed"
            : "running";
      if (status === "completed" && meeting !== null) {
        meeting = { ...meeting, phase: "done" };
      }
      return yield* persistGraphRun({ ...input.run, meeting }, graph, input.bindings, {
        status,
        finalOutput: status === "completed" ? finalOutput : null,
        error: status === "failed" ? graph.nextAction : null,
        updatedAt: yield* nowIso,
      });
    },
  );

  const executeGraphRun = Effect.fn("WorkspaceCollaborationReactor.executeGraphRun")(function* (
    runRef: RunRef,
  ) {
    let run = yield* getRun(runRef);
    const bindings = yield* loadGraphBindings(run.projectId, run.meeting);
    if (
      run.source === "schedule" &&
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
    const composePrompt = projectionSnapshotQuery.composeWorkspacePrompt;
    if (composePrompt === undefined) {
      return yield* executionError("Workspace prompt composition is unavailable.");
    }
    const workspacePrompt = yield* composePrompt({
      projectId: run.projectId,
      task: run.task,
      includeRag: true,
      includeWorkingMemory: true,
      includeLongTermMemory: true,
      ragLimit: 12,
      maxContextChars: 40_000,
    });
    yield* recordPromptUsage({
      projectId: run.projectId,
      sourceItemIds: workspacePrompt.sourceItemIds,
    });

    // A meeting is the run's leading phase: the seats discuss and the chair
    // plans before any graph exists. Parked means the person owes an answer;
    // the answered event re-enqueues the run.
    if (
      run.meeting !== null &&
      (run.meeting.phase === "discussing" || run.meeting.phase === "planning")
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
      const graph = buildInitialWorkspaceTaskGraph(run.task);
      run = yield* persistGraphRun(run, graph, bindings, {
        status: "running",
        finalOutput: null,
        error: null,
        updatedAt: yield* nowIso,
      });
    }

    while (run.graph !== null && !["completed", "failed"].includes(run.graph.status)) {
      yield* requireRunContinuable(runRef);
      if (run.meeting !== null) {
        if (run.meeting.pendingQuestion !== null) return;
        if (run.graph.nodes.some((node) => node.status === "awaiting-user")) {
          // The person answered; parked seats rejoin the queue and re-run with
          // the recorded decision in their prompt.
          const graph = refreshWorkspaceTaskGraphQueue({
            ...run.graph,
            nodes: run.graph.nodes.map((node) =>
              node.status === "awaiting-user" ? { ...node, status: "queued" as const } : node,
            ),
          });
          run = yield* persistGraphRun(run, graph, bindings, { updatedAt: yield* nowIso });
          continue;
        }
      }
      let running = run.graph.nodes.filter((node) => node.status === "running");
      if (running.length === 0) {
        const ready = readyWorkspaceTaskNodes(run.graph);
        if (ready.length === 0) {
          return yield* executionError(
            `Task graph is deadlocked at revision ${run.graph.revision}: ${run.graph.nextAction}`,
          );
        }
        run = yield* startGraphWave({ run, bindings, nodes: ready });
        running = run.graph?.nodes.filter((node) => node.status === "running") ?? [];
      }
      if (running.length === 0) return yield* executionError("Task graph wave did not start.");
      const results = yield* executeGraphWave({
        run,
        bindings,
        workspacePrompt: workspacePrompt.prompt,
      });
      run = yield* applyGraphWaveResults({ run, bindings, results });
    }
    if (run.status === "completed") yield* captureRunMemory(run);
  });

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
      run.source === "schedule" &&
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

    const composePrompt = projectionSnapshotQuery.composeWorkspacePrompt;
    if (composePrompt === undefined) {
      return yield* executionError("Workspace prompt composition is unavailable.");
    }
    const workspacePrompt = yield* composePrompt({
      projectId: run.projectId,
      task: run.task,
      includeRag: true,
      includeWorkingMemory: true,
      includeLongTermMemory: true,
      ragLimit: 12,
      maxContextChars: 40_000,
    });
    yield* recordPromptUsage({
      projectId: run.projectId,
      sourceItemIds: workspacePrompt.sourceItemIds,
    });

    for (let index = 0; index < run.steps.length; index += 1) {
      yield* requireRunContinuable(runRef);
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
          threadId: ThreadId.make(yield* randomUUID),
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

      const output = yield* ensureThreadAndTurn({
        run,
        step,
        prompt: buildWorkspaceCollaborationStepPrompt({
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
                return { ...node, attempts, status, completedAt: settledAt };
              }),
            };
      return { ...run, steps, graph, updatedAt: settledAt };
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
        (run) => run.source === "schedule" && run.status !== "cancel-requested",
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
    if (event.type === "project.collaboration-run-requested") {
      return enqueueRequestedRun(event.payload.run, event.payload.preempt);
    }
    if (event.type === "project.collaboration-run-answered") {
      // The projection has already folded the answer in (projections apply
      // before events are published), so re-entering the run sees it.
      return enqueue({ projectId: event.payload.projectId, runId: event.payload.runId });
    }
    if (event.type === "project.collaboration-run-cancel-requested") {
      // An actively executing run notices this through its own wait interrupts;
      // a run parked on a question has no fiber, so the event must finalize it.
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
