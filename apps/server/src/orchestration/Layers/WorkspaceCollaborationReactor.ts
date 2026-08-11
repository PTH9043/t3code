import {
  CommandId,
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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as TxRef from "effect/TxRef";

import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  buildWorkspaceCollaborationStepPrompt,
  buildWorkspaceCollaborationSteps,
  buildWorkspaceTaskNodePrompt,
  formatWorkspaceCollaborationRunMemory,
} from "../workspaceCollaboration.ts";
import {
  buildInitialWorkspaceTaskGraph,
  materializeWorkspaceTaskGraphPlan,
  parseWorkspaceSynthesisPayload,
  parseWorkspaceTaskGraphProposal,
  parseWorkspaceValidationDecision,
  readyWorkspaceTaskNodes,
  refreshWorkspaceTaskGraphQueue,
  WorkspaceTaskGraphError,
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
): ReadonlyArray<WorkspaceCollaborationStep> {
  return graph.nodes
    .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((node, index) => {
      const attempt = node.attempts.at(-1);
      const binding = roleBinding(bindings, node.role);
      if (attempt === undefined && binding === undefined) {
        throw new WorkspaceTaskGraphError(`Missing enabled binding for role '${node.role}'.`);
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
        displayName: binding?.displayName ?? node.title,
        modelSelection: attempt?.modelSelection ?? binding!.modelSelection,
        runtimeMode: attempt?.runtimeMode ?? binding!.runtimeMode,
        interactionMode: attempt?.interactionMode ?? binding!.interactionMode,
        instructions: binding?.instructions ?? "",
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

  const interruptStepThread = (runRef: RunRef, step: WorkspaceCollaborationStep) =>
    step.threadId === null
      ? Effect.void
      : loadThread(runRef, step.threadId).pipe(
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
                        threadId: step.threadId!,
                        turnId: thread.latestTurn?.turnId,
                        createdAt: yield* nowIso,
                      });
                    }).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Failed to interrupt cancelled collaboration turn", {
                          projectId: runRef.projectId,
                          runId: runRef.runId,
                          threadId: step.threadId,
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
              threadId: step.threadId,
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
      let requestedAtOrAfter: string | undefined;
      if (thread.value.latestTurn === null) {
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
      return yield* awaitStepOutput(runRef, input.step.threadId, requestedAtOrAfter);
    },
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
  ) {
    const listRoles = projectionSnapshotQuery.listWorkspaceAgentRoles;
    if (listRoles === undefined) {
      return yield* executionError("Workspace role projection is unavailable.");
    }
    const result = yield* listRoles({ projectId });
    if (roleBinding(result.roles, "coordinator") === undefined) {
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
      steps: graphCompatibilitySteps(graph, bindings),
    });

  const chooseAttemptRoute = Effect.fn("WorkspaceCollaborationReactor.chooseAttemptRoute")(
    function* (node: WorkspaceTaskNode, bindings: ReadonlyArray<WorkspaceAgentRoleBinding>) {
      const binding = roleBinding(bindings, node.role);
      if (binding === undefined) {
        return yield* executionError(`Enabled role '${node.role}' is required for '${node.id}'.`);
      }
      if (node.attempts.length === 0) {
        return {
          binding,
          modelSelection: binding.modelSelection,
          strategy: "Primary role route selected by the validated task graph.",
        } as const;
      }

      const instances = yield* providerInstanceRegistry.listInstances;
      const usedInstanceIds = new Set(
        node.attempts.map((attempt) => attempt.modelSelection.instanceId),
      );
      const primary = instances.find(
        (instance) => instance.instanceId === binding.modelSelection.instanceId,
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
        binding,
        modelSelection:
          alternative === undefined
            ? binding.modelSelection
            : { ...binding.modelSelection, instanceId: alternative.instanceId },
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
      const startedNodes = yield* Effect.forEach(
        input.nodes.slice(0, MAX_PARALLEL_GRAPH_NODES),
        (node) =>
          Effect.gen(function* () {
            const route = yield* chooseAttemptRoute(node, input.bindings);
            const startedAt = yield* nowIso;
            const attempt: WorkspaceTaskAttempt = {
              number: node.attempts.length + 1,
              agent: node.agent,
              role: node.role,
              modelSelection: route.modelSelection,
              runtimeMode: route.binding.runtimeMode,
              interactionMode: route.binding.interactionMode,
              strategy: route.strategy,
              threadId: ThreadId.make(yield* randomUUID),
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
      const compatibilitySteps = graphCompatibilitySteps(graph, input.bindings);
      const availableAgents = input.bindings
        .filter(
          (binding) =>
            binding.enabled && ["coordinator", "implementer", "researcher"].includes(binding.role),
        )
        .map(
          (binding) =>
            `${binding.role}: ${binding.displayName} -> ${binding.modelSelection.instanceId} / ${binding.modelSelection.model}`,
        );
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
          const step = compatibilitySteps.find(
            (candidate) => candidate.threadId === attempt.threadId,
          );
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
            }),
            title: `${node.agent.toUpperCase()}: ${node.title}`,
            expectedAgent: node.agent,
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
            const proposal = parseWorkspaceTaskGraphProposal(result.output);
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
              occurredAt: completedAt,
              anchorNodeId: result.nodeId,
              ...(current.failureClassification === null
                ? {}
                : { changeReason: failureChangeReason(current.failureClassification) }),
            });
            continue;
          }

          if (current.kind === "validation") {
            const decision = parseWorkspaceValidationDecision(result.output);
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
      return yield* persistGraphRun(input.run, graph, input.bindings, {
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
    const bindings = yield* loadGraphBindings(run.projectId);
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
    if (run.graph === null) {
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
    const activeIndex = current.steps.findIndex(
      (step) => step.status === "running" || step.status === "queued",
    );
    const activeStep = activeIndex >= 0 ? current.steps[activeIndex] : undefined;
    if (activeStep !== undefined) yield* interruptStepThread(runRef, activeStep);
    const cancelledAt = yield* nowIso;
    const next =
      activeStep === undefined
        ? current
        : replaceStep(current, activeIndex, {
            ...activeStep,
            status: "cancelled",
            completedAt: cancelledAt,
          });
    yield* persistRun({
      ...next,
      status: "cancelled",
      error: null,
      updatedAt: cancelledAt,
    });
  });

  const finalizeFailed = Effect.fn("WorkspaceCollaborationReactor.finalizeFailed")(function* (
    runRef: RunRef,
    error: string,
  ) {
    const current = yield* getRun(runRef);
    if (current.status === "cancel-requested") {
      return yield* finalizeCancelled(runRef);
    }
    if (["cancelled", "completed", "failed"].includes(current.status)) return;
    const failedAt = yield* nowIso;
    const activeIndex = current.steps.findIndex(
      (step) => step.status === "running" || step.status === "queued",
    );
    const activeStep = activeIndex >= 0 ? current.steps[activeIndex] : undefined;
    const next =
      activeStep === undefined
        ? current
        : replaceStep(current, activeIndex, {
            ...activeStep,
            status: "failed",
            error,
            completedAt: failedAt,
          });
    yield* persistRun({
      ...next,
      status: "failed",
      finalOutput: null,
      error,
      updatedAt: failedAt,
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
    }).pipe(Effect.andThen(TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx)));

  const enqueue = Effect.fn("WorkspaceCollaborationReactor.enqueue")(function* (runRef: RunRef) {
    const key = runKey(runRef);
    const claimed = yield* SynchronizedRef.modify(claimedRunsRef, (current) => {
      if (current.has(key)) return [false, current] as const;
      const next = new Set(current);
      next.add(key);
      return [true, next] as const;
    });
    if (!claimed) return;
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

  const enqueueEvent = (event: OrchestrationEvent) =>
    event.type === "project.collaboration-run-requested"
      ? enqueueRequestedRun(event.payload.run, event.payload.preempt)
      : Effect.void;

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
    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, enqueueEvent));
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
