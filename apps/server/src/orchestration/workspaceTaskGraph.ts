import {
  WorkspaceTaskNodeId,
  type WorkspaceAgentRoleBinding,
  type WorkspaceFailureClassification,
  type WorkspaceMeetingParticipantId,
  type WorkspaceMemoryCandidate,
  type WorkspaceOrchestrationAgent,
  type WorkspaceTaskGraph,
  type WorkspaceTaskNode,
  type WorkspaceTaskNodeKind,
  type WorkspaceValidationConfidence,
  type WorkspaceValidationVerdict,
} from "@t3tools/contracts";

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PLAN_NODES = 24;
const MAX_FOLLOW_UP_NODES = 8;
// Full agent output is captured separately as searchable knowledge, so this cap
// only bounds a single model response. It stays generous rather than tight: a
// rejected payload fails the whole synthesis, and losing a run's conclusions to
// an off-by-one item is worse than storing a few more.
const MAX_MEMORY_CANDIDATES = 64;
const MAX_SHORT_TEXT = 4_000;
const MAX_CONTEXT_TEXT = 20_000;

const TASK_NODE_KINDS = ["orchestration", "research", "implementation", "debug"] as const;
const ORCHESTRATION_AGENTS = ["fable", "codex", "grok"] as const;
const VALIDATION_VERDICTS = ["pass", "fail", "inconclusive"] as const;
const VALIDATION_CONFIDENCES = ["high", "medium", "low"] as const;
const FAILURE_CLASSIFICATIONS = [
  "information",
  "implementation",
  "tool",
  "assumption",
  "validation",
] as const;
const MEMORY_CATEGORIES = [
  "project-structure",
  "architecture",
  "successful-pattern",
  "failure-pattern",
  "verified-data-source",
  "user-workflow",
  "agent-performance",
] as const;

export interface WorkspaceTaskPlanNodeProposal {
  readonly id: string;
  readonly kind: (typeof TASK_NODE_KINDS)[number];
  readonly agent: WorkspaceOrchestrationAgent;
  /** Set on meeting plans, where the roster — not the agent whitelist — assigns work. */
  readonly participantId: WorkspaceMeetingParticipantId | null;
  readonly title: string;
  readonly task: string;
  readonly goal: string;
  readonly context: string;
  readonly input: string;
  readonly constraints: ReadonlyArray<string>;
  readonly expectedOutput: string;
  readonly successCriteria: ReadonlyArray<string>;
  readonly dependsOn: ReadonlyArray<string>;
  readonly priority: number;
}

/**
 * The roster facts a meeting plan is validated against. Plain data rather than
 * the full meeting so this module stays independent of the meeting state
 * machine: parsing needs to know who is seated and who chairs, nothing else.
 */
export interface WorkspaceMeetingPlanContext {
  readonly participantIds: ReadonlyArray<WorkspaceMeetingParticipantId>;
  readonly chairParticipantId: WorkspaceMeetingParticipantId;
}

export interface WorkspaceTaskPlanProposal {
  readonly summary: string;
  readonly nextAction: string;
  readonly nodes: ReadonlyArray<WorkspaceTaskPlanNodeProposal>;
}

export interface WorkspaceValidationDecision {
  readonly verdict: WorkspaceValidationVerdict;
  readonly confidence: WorkspaceValidationConfidence;
  readonly summary: string;
  readonly evidence: ReadonlyArray<string>;
  readonly failureClassification: WorkspaceFailureClassification | null;
  readonly nextAction: string;
  readonly followUpNodes: ReadonlyArray<WorkspaceTaskPlanNodeProposal>;
}

export interface WorkspaceSynthesisPayload {
  readonly finalOutput: string;
  readonly confidence: WorkspaceValidationConfidence;
  readonly conflictDetected: boolean;
  readonly nextAction: string;
  readonly repairApproved: boolean | null;
  readonly memoryCandidates: ReadonlyArray<WorkspaceMemoryCandidate>;
}

export class WorkspaceTaskGraphError extends Error {
  override readonly name = "WorkspaceTaskGraphError";
}

function fail(message: string): never {
  throw new WorkspaceTaskGraphError(message);
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${path} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, path: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) return fail(`${path} must be an array.`);
  return value;
}

function text(value: unknown, path: string, maximum = MAX_SHORT_TEXT): string {
  if (typeof value !== "string") return fail(`${path} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail(`${path} must not be empty.`);
  if (trimmed.length > maximum) return fail(`${path} exceeds ${maximum} characters.`);
  return trimmed;
}

function optionalText(value: unknown, path: string, maximum: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return fail(`${path} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > maximum) return fail(`${path} exceeds ${maximum} characters.`);
  return trimmed;
}

function stringArray(value: unknown, path: string, maximumItems = 32): ReadonlyArray<string> {
  const values = array(value, path);
  if (values.length > maximumItems) return fail(`${path} has too many entries.`);
  return values.map((item, index) => text(item, `${path}[${index}]`));
}

function oneOf<const Values extends ReadonlyArray<string>>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    return fail(`${path} must be one of: ${values.join(", ")}.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    return fail(`${path} must be a non-negative integer.`);
  }
  return value;
}

function nullableFailureClassification(
  value: unknown,
  path: string,
): WorkspaceFailureClassification | null {
  if (value === null) return null;
  return oneOf(value, FAILURE_CLASSIFICATIONS, path);
}

function extractTaggedJson(output: string, tag: string): unknown {
  const startToken = `<${tag}>`;
  const endToken = `</${tag}>`;
  const start = output.indexOf(startToken);
  const end = output.indexOf(endToken, start + startToken.length);
  if (start < 0 || end < 0) return fail(`Missing ${startToken} JSON payload.`);
  const body = output.slice(start + startToken.length, end).trim();
  if (body.length === 0) return fail(`${startToken} payload is empty.`);
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    return fail(`${startToken} payload is invalid JSON: ${String(error)}`);
  }
}

function expectedAgentForKind(
  kind: WorkspaceTaskPlanNodeProposal["kind"],
): WorkspaceOrchestrationAgent {
  if (kind === "research") return "grok";
  if (kind === "implementation" || kind === "debug") return "codex";
  return "fable";
}

function parsePlanNode(
  value: unknown,
  path: string,
  meeting: WorkspaceMeetingPlanContext | null,
): WorkspaceTaskPlanNodeProposal {
  const source = record(value, path);
  const id = text(source.id, `${path}.id`, 64);
  if (!NODE_ID_PATTERN.test(id)) return fail(`${path}.id is not a valid node slug.`);
  const kind = oneOf(source.kind, TASK_NODE_KINDS, `${path}.kind`);
  let agent: WorkspaceOrchestrationAgent;
  let participantId: WorkspaceMeetingParticipantId | null;
  if (meeting === null) {
    agent = oneOf(source.agent, ORCHESTRATION_AGENTS, `${path}.agent`);
    const expectedAgent = expectedAgentForKind(kind);
    if (agent !== expectedAgent) {
      return fail(`${path} routes ${kind} to ${agent}; it must route to ${expectedAgent}.`);
    }
    participantId = null;
  } else {
    // On a meeting plan the roster is the whitelist. `agent` is derived from the
    // kind rather than read, so downstream kind-based recovery rules keep their
    // meaning while the seat alone decides which account executes.
    const raw = text(source.participantId, `${path}.participantId`, 64);
    const seated = meeting.participantIds.find((candidate) => candidate === raw);
    if (seated === undefined) {
      return fail(`${path}.participantId '${raw}' is not a meeting seat.`);
    }
    agent = expectedAgentForKind(kind);
    participantId = seated;
  }
  return {
    id,
    kind,
    agent,
    participantId,
    title: text(source.title, `${path}.title`, 200),
    task: text(source.task, `${path}.task`),
    goal: text(source.goal, `${path}.goal`),
    context: optionalText(source.context, `${path}.context`, MAX_CONTEXT_TEXT),
    input: optionalText(source.input, `${path}.input`, MAX_CONTEXT_TEXT),
    constraints: stringArray(source.constraints ?? [], `${path}.constraints`),
    expectedOutput: text(source.expectedOutput, `${path}.expectedOutput`),
    successCriteria: stringArray(source.successCriteria, `${path}.successCriteria`),
    dependsOn: stringArray(source.dependsOn ?? [], `${path}.dependsOn`).map((dependency) => {
      if (!NODE_ID_PATTERN.test(dependency)) {
        return fail(`${path}.dependsOn contains an invalid node slug.`);
      }
      return dependency;
    }),
    priority: nonNegativeInteger(source.priority ?? 0, `${path}.priority`),
  };
}

function validateNodeIdsAndDependencies(
  nodes: ReadonlyArray<WorkspaceTaskPlanNodeProposal>,
  allowExternalDependencies: boolean,
): void {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return fail(`Duplicate task node id '${node.id}'.`);
    ids.add(node.id);
  }
  for (const node of nodes) {
    const dependencies = new Set<string>();
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) return fail(`Task node '${node.id}' depends on itself.`);
      if (dependencies.has(dependency)) {
        return fail(`Task node '${node.id}' repeats dependency '${dependency}'.`);
      }
      dependencies.add(dependency);
      if (!allowExternalDependencies && !ids.has(dependency)) {
        return fail(`Task node '${node.id}' depends on missing node '${dependency}'.`);
      }
    }
  }
  const indegree = new Map(
    nodes.map((node) => [
      node.id,
      node.dependsOn.filter((dependency) => ids.has(dependency)).length,
    ]),
  );
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) continue;
      const next = dependents.get(dependency) ?? [];
      next.push(node.id);
      dependents.set(dependency, next);
    }
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.shift()!;
    visited += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const degree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, degree);
      if (degree === 0) ready.push(dependent);
    }
  }
  if (visited !== nodes.length) return fail("Task graph contains a dependency cycle.");
}

function parsePlanNodes(
  value: unknown,
  path: string,
  maximum: number,
  allowExternalDependencies: boolean,
  meeting: WorkspaceMeetingPlanContext | null,
): ReadonlyArray<WorkspaceTaskPlanNodeProposal> {
  const values = array(value, path);
  if (values.length === 0) return fail(`${path} must contain at least one node.`);
  if (values.length > maximum) return fail(`${path} exceeds the ${maximum}-node limit.`);
  const nodes = values.map((node, index) => parsePlanNode(node, `${path}[${index}]`, meeting));
  validateNodeIdsAndDependencies(nodes, allowExternalDependencies);
  return nodes;
}

/** Decode and validate one graph proposal — Fable's, or the meeting chair's when `meeting` is set. */
export function parseWorkspaceTaskGraphProposal(
  output: string,
  meeting: WorkspaceMeetingPlanContext | null = null,
): WorkspaceTaskPlanProposal {
  const source = record(extractTaggedJson(output, "t3_task_graph"), "taskGraph");
  return {
    summary: text(source.summary, "taskGraph.summary", 8_000),
    nextAction: text(source.nextAction, "taskGraph.nextAction"),
    nodes: parsePlanNodes(source.nodes, "taskGraph.nodes", MAX_PLAN_NODES, false, meeting),
  };
}

/** Decode one independent validation receipt. */
export function parseWorkspaceValidationDecision(
  output: string,
  meeting: WorkspaceMeetingPlanContext | null = null,
): WorkspaceValidationDecision {
  const source = record(extractTaggedJson(output, "t3_validation"), "validation");
  return {
    verdict: oneOf(source.verdict, VALIDATION_VERDICTS, "validation.verdict"),
    confidence: oneOf(source.confidence, VALIDATION_CONFIDENCES, "validation.confidence"),
    summary: text(source.summary, "validation.summary", 8_000),
    evidence: stringArray(source.evidence ?? [], "validation.evidence", 32),
    failureClassification: nullableFailureClassification(
      source.failureClassification ?? null,
      "validation.failureClassification",
    ),
    nextAction: text(source.nextAction, "validation.nextAction"),
    followUpNodes:
      source.followUpNodes === undefined ||
      (Array.isArray(source.followUpNodes) && source.followUpNodes.length === 0)
        ? []
        : parsePlanNodes(
            source.followUpNodes,
            "validation.followUpNodes",
            MAX_FOLLOW_UP_NODES,
            true,
            meeting,
          ),
  };
}

/** Decode one Fable synthesis payload and bounded durable-memory candidates. */
export function parseWorkspaceSynthesisPayload(output: string): WorkspaceSynthesisPayload {
  const source = record(extractTaggedJson(output, "t3_synthesis"), "synthesis");
  const candidates = array(source.memoryCandidates ?? [], "synthesis.memoryCandidates");
  if (candidates.length > MAX_MEMORY_CANDIDATES) {
    return fail(`synthesis.memoryCandidates exceeds the ${MAX_MEMORY_CANDIDATES}-item limit.`);
  }
  const memoryCandidates = candidates.map((candidate, index): WorkspaceMemoryCandidate => {
    const item = record(candidate, `synthesis.memoryCandidates[${index}]`);
    return {
      category: oneOf(
        item.category,
        MEMORY_CATEGORIES,
        `synthesis.memoryCandidates[${index}].category`,
      ),
      title: text(item.title, `synthesis.memoryCandidates[${index}].title`, 200),
      content: text(item.content, `synthesis.memoryCandidates[${index}].content`, 20_000),
      tags: stringArray(item.tags ?? [], `synthesis.memoryCandidates[${index}].tags`, 16),
      confidence: oneOf(
        item.confidence,
        VALIDATION_CONFIDENCES,
        `synthesis.memoryCandidates[${index}].confidence`,
      ),
      sourceNodeIds: stringArray(
        item.sourceNodeIds ?? [],
        `synthesis.memoryCandidates[${index}].sourceNodeIds`,
        24,
      ).map((id) => {
        if (!NODE_ID_PATTERN.test(id)) return fail(`Memory candidate has invalid source node id.`);
        return WorkspaceTaskNodeId.make(id);
      }),
    };
  });
  const repairApproved = source.repairApproved;
  if (repairApproved !== null && typeof repairApproved !== "boolean") {
    return fail("synthesis.repairApproved must be boolean or null.");
  }
  if (typeof source.conflictDetected !== "boolean") {
    return fail("synthesis.conflictDetected must be boolean.");
  }
  return {
    finalOutput: text(source.finalOutput, "synthesis.finalOutput", 120_000),
    confidence: oneOf(source.confidence, VALIDATION_CONFIDENCES, "synthesis.confidence"),
    conflictDetected: source.conflictDetected,
    nextAction: text(source.nextAction, "synthesis.nextAction", 2_000),
    repairApproved,
    memoryCandidates,
  };
}

function emptyNode(input: {
  readonly id: string;
  readonly order: number;
  readonly kind: WorkspaceTaskNodeKind;
  readonly agent: WorkspaceOrchestrationAgent;
  readonly role: WorkspaceTaskNode["role"];
  readonly title: string;
  readonly task: string;
  readonly goal: string;
  readonly context: string;
  readonly input: string;
  readonly constraints: ReadonlyArray<string>;
  readonly expectedOutput: string;
  readonly successCriteria: ReadonlyArray<string>;
  readonly dependsOn: ReadonlyArray<string>;
  readonly validationTargetId?: string | null;
  readonly priority: number;
  readonly status: WorkspaceTaskNode["status"];
  readonly participantId?: WorkspaceMeetingParticipantId | null;
}): WorkspaceTaskNode {
  return {
    id: WorkspaceTaskNodeId.make(input.id),
    order: input.order,
    kind: input.kind,
    agent: input.agent,
    role: input.role,
    participantId: input.participantId ?? null,
    title: input.title,
    handoff: {
      task: input.task,
      goal: input.goal,
      context: input.context,
      input: input.input,
      constraints: input.constraints,
      expectedOutput: input.expectedOutput,
      successCriteria: input.successCriteria,
    },
    dependsOn: input.dependsOn.map((dependency) => WorkspaceTaskNodeId.make(dependency)),
    validationTargetId:
      input.validationTargetId === undefined || input.validationTargetId === null
        ? null
        : WorkspaceTaskNodeId.make(input.validationTargetId),
    priority: input.priority,
    status: input.status,
    maxAttempts: 2,
    attempts: [],
    output: null,
    error: null,
    failureClassification: null,
    confidence: null,
    validation: null,
    startedAt: null,
    completedAt: null,
  };
}

/** Create the first Fable node before any model-authored graph exists. */
export function buildInitialWorkspaceTaskGraph(task: string): WorkspaceTaskGraph {
  return {
    revision: 0,
    status: "planning",
    nodes: [
      emptyNode({
        id: "plan",
        order: 0,
        kind: "orchestration",
        agent: "fable",
        role: "coordinator",
        title: "목표 분석과 작업 그래프 설계",
        task: "사용자의 최종 목표를 실행 가능한 작업 그래프로 분해한다.",
        goal: task,
        context: "관련 워크스페이스 기억과 현재 상태를 확인하고 필요한 문맥만 노드별로 배분한다.",
        input: task,
        constraints: [
          "실제 의존성만 연결한다.",
          "독립 작업은 병렬 경로로 둔다.",
          "최신 정보는 Grok, 구현과 실행은 Codex, 판단과 종합은 Fable에 배정한다.",
        ],
        expectedOutput: "서버가 검증할 수 있는 구조화된 작업 그래프",
        successCriteria: [
          "중복 노드와 순환 의존성이 없다.",
          "모든 노드에 성공 기준과 최소 충분 컨텍스트가 있다.",
        ],
        dependsOn: [],
        priority: 100,
        status: "queued",
      }),
    ],
    changes: [],
    nextAction: "Fable이 목표를 분석하고 작업 그래프를 설계합니다.",
    overallConfidence: null,
    repairApproved: null,
    memoryCandidates: [],
  };
}

/**
 * The completed root a meeting graph anchors on.
 *
 * A role-bound run earns its "plan" node by executing the coordinator; a
 * meeting earns it by discussing. The agreement is stored as the node's output
 * so every root node the chair proposes inherits it as dependency context,
 * exactly the way a coordinator's plan hands off.
 */
export function buildMeetingSeededTaskGraph(input: {
  readonly task: string;
  readonly agreement: string;
  readonly chairParticipantId: WorkspaceMeetingParticipantId;
  readonly occurredAt: string;
}): WorkspaceTaskGraph {
  const base = buildInitialWorkspaceTaskGraph(input.task);
  const plan = base.nodes[0]!;
  return {
    ...base,
    nodes: [
      {
        ...plan,
        title: "회의 합의 계획",
        participantId: input.chairParticipantId,
        handoff: {
          ...plan.handoff,
          task: "회의에서 합의한 계획을 실행 가능한 작업 그래프로 확정한다.",
          context: "참가자들이 회의에서 직접 합의한 내용이다.",
          constraints: [],
        },
        status: "completed",
        output: input.agreement.slice(0, 40_000),
        startedAt: input.occurredAt,
        completedAt: input.occurredAt,
      },
    ],
    nextAction: "회의 합의를 작업 그래프로 실행합니다.",
  };
}

function roleForAgent(agent: WorkspaceOrchestrationAgent): WorkspaceTaskNode["role"] {
  if (agent === "codex") return "implementer";
  if (agent === "grok") return "researcher";
  return "coordinator";
}

function requireBinding(
  bindings: ReadonlyArray<WorkspaceAgentRoleBinding>,
  agent: WorkspaceOrchestrationAgent,
): WorkspaceAgentRoleBinding {
  const role = roleForAgent(agent);
  const binding = bindings.find((candidate) => candidate.role === role && candidate.enabled);
  if (binding === undefined) return fail(`Enabled ${role} binding is required for ${agent}.`);
  return binding;
}

function uniqueNodeId(preferred: string, used: Set<string>): string {
  const base = preferred.slice(0, 64);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return fail(`Could not allocate a unique node id for '${preferred}'.`);
}

/** Materialize a validated proposal, inserting validation gates and one terminal synthesis node. */
export function materializeWorkspaceTaskGraphPlan(input: {
  readonly graph: WorkspaceTaskGraph;
  readonly proposal: WorkspaceTaskPlanProposal;
  readonly bindings: ReadonlyArray<WorkspaceAgentRoleBinding>;
  /** Set on meeting runs, whose gates and synthesis run on the chair's seat, not role bindings. */
  readonly meeting?: WorkspaceMeetingPlanContext | null;
  readonly occurredAt: string;
  readonly anchorNodeId?: string;
  readonly changeReason?: WorkspaceTaskGraph["changes"][number]["reason"];
  readonly supersededNodeIds?: ReadonlyArray<WorkspaceTaskNodeId>;
}): WorkspaceTaskGraph {
  const meeting = input.meeting ?? null;
  if (meeting === null) {
    for (const agent of new Set(input.proposal.nodes.map((node) => node.agent))) {
      requireBinding(input.bindings, agent);
    }
    requireBinding(input.bindings, "fable");
  }

  const existingIds = new Set(input.graph.nodes.map((node) => String(node.id)));
  const collidingId = input.proposal.nodes.find((node) => existingIds.has(node.id));
  if (collidingId !== undefined) {
    return fail(`Task graph node '${collidingId.id}' already exists in this run.`);
  }
  const allocationIds = new Set([...existingIds, ...input.proposal.nodes.map((node) => node.id)]);
  const validationIds = new Map<string, string>();
  for (const proposal of input.proposal.nodes) {
    if (proposal.agent === "fable") continue;
    validationIds.set(proposal.id, uniqueNodeId(`validate-${proposal.id}`, allocationIds));
  }
  const used = allocationIds;

  let order = Math.max(-1, ...input.graph.nodes.map((node) => node.order)) + 1;
  const anchorNodeId = input.anchorNodeId ?? "plan";
  if (!existingIds.has(anchorNodeId)) {
    return fail(`Task graph anchor node '${anchorNodeId}' does not exist.`);
  }
  const nodes: WorkspaceTaskNode[] = [];
  for (const proposal of input.proposal.nodes) {
    const dependencies =
      proposal.dependsOn.length === 0
        ? [anchorNodeId]
        : proposal.dependsOn.map((dependency) => validationIds.get(dependency) ?? dependency);
    nodes.push(
      emptyNode({
        ...proposal,
        order: order++,
        role: roleForAgent(proposal.agent),
        dependsOn: dependencies,
        status: "blocked",
      }),
    );
    const validationId = validationIds.get(proposal.id);
    if (validationId === undefined) continue;
    nodes.push(
      emptyNode({
        id: validationId,
        order: order++,
        kind: "validation",
        agent: "fable",
        role: "coordinator",
        participantId: meeting?.chairParticipantId ?? null,
        title: `${proposal.title} 검증`,
        task: `${proposal.title}의 결과를 독립적으로 검증한다.`,
        goal: proposal.goal,
        context: proposal.context,
        input: `검증 대상 노드: ${proposal.id}`,
        constraints: [
          "생성자의 주장을 그대로 신뢰하지 않는다.",
          "근거와 성공 기준을 직접 대조한다.",
        ],
        expectedOutput: "신뢰도와 실패 분류가 포함된 구조화된 검증 영수증",
        successCriteria: proposal.successCriteria,
        dependsOn: [proposal.id],
        validationTargetId: proposal.id,
        priority: proposal.priority,
        status: "blocked",
      }),
    );
  }

  const combinedBeforeSynthesis = [...input.graph.nodes, ...nodes];
  const activeBeforeSynthesis = combinedBeforeSynthesis.filter(
    (node) => !["cancelled", "failed", "skipped"].includes(node.status),
  );
  const dependencyIds = new Set(
    activeBeforeSynthesis.flatMap((node) => node.dependsOn.map(String)),
  );
  const leafIds = activeBeforeSynthesis
    .filter((node) => node.id !== "plan" && !dependencyIds.has(String(node.id)))
    .map((node) => String(node.id));
  const synthesisId = uniqueNodeId("synthesize", used);
  const synthesis = emptyNode({
    id: synthesisId,
    order: order++,
    kind: "synthesis",
    agent: "fable",
    role: "coordinator",
    participantId: meeting?.chairParticipantId ?? null,
    title: "검증 결과 종합과 다음 행동 결정",
    task: "검증을 통과한 결과만 하나의 최종 응답으로 종합한다.",
    goal: input.graph.nodes[0]?.handoff.goal ?? "사용자 목표 달성",
    context: "서로 충돌하는 결과는 숨기지 말고 증거에 따라 해결한다.",
    input: "모든 말단 검증 결과",
    constraints: ["낮은 신뢰도 결과를 확정 사실로 사용하지 않는다."],
    expectedOutput: "최종 응답, 전체 신뢰도, 선택적 장기 기억 후보",
    successCriteria: ["모든 필수 말단 노드가 검증되었다.", "남은 불확실성과 다음 행동이 명확하다."],
    dependsOn: leafIds,
    priority: 0,
    status: "blocked",
  });
  const revision = input.graph.revision + 1;
  const nextGraph: WorkspaceTaskGraph = {
    ...input.graph,
    revision,
    status: "executing",
    nodes: [...input.graph.nodes, ...nodes, synthesis],
    changes: [
      ...input.graph.changes,
      {
        revision,
        reason:
          input.changeReason ??
          (input.graph.changes.length === 0 ? "initial-plan" : "invalid-assumption"),
        summary: input.proposal.summary,
        addedNodeIds: [...nodes, synthesis].map((node) => node.id),
        supersededNodeIds: input.supersededNodeIds ?? [],
        occurredAt: input.occurredAt,
      },
    ],
    nextAction: input.proposal.nextAction,
  };
  return refreshWorkspaceTaskGraphQueue(nextGraph);
}

function dependencySatisfied(node: WorkspaceTaskNode, dependency: WorkspaceTaskNode): boolean {
  if (node.kind === "validation" && node.validationTargetId === dependency.id) {
    return dependency.status === "awaiting-validation" || dependency.status === "completed";
  }
  return dependency.status === "completed" || dependency.status === "skipped";
}

/** Return the bounded-concurrency wave whose dependencies are satisfied now. */
export function readyWorkspaceTaskNodes(
  graph: WorkspaceTaskGraph,
): ReadonlyArray<WorkspaceTaskNode> {
  const nodes = new Map(graph.nodes.map((node) => [String(node.id), node]));
  return graph.nodes
    .filter((node) => {
      if (node.status !== "queued" && node.status !== "blocked") return false;
      return node.dependsOn.every((dependencyId) => {
        const dependency = nodes.get(String(dependencyId));
        return dependency !== undefined && dependencySatisfied(node, dependency);
      });
    })
    .toSorted(
      (left, right) =>
        right.priority - left.priority ||
        left.order - right.order ||
        left.id.localeCompare(right.id),
    );
}

/** Keep queued/blocked presentation in sync with the current dependency frontier. */
export function refreshWorkspaceTaskGraphQueue(graph: WorkspaceTaskGraph): WorkspaceTaskGraph {
  const ready = new Set(readyWorkspaceTaskNodes(graph).map((node) => String(node.id)));
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.status !== "queued" && node.status !== "blocked") return node;
      return { ...node, status: ready.has(String(node.id)) ? "queued" : "blocked" };
    }),
  };
}
