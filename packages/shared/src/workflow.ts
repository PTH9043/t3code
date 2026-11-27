import {
  collectGraphReferentialIssues,
  extractForwardEdges,
  extractLoopBackEdges,
  WorkflowGraphV2,
  type WorkflowDefinition,
  type WorkflowGraphV2Draft,
  type WorkflowIssue,
  type WorkflowPreviewResult,
  type WorkflowValues,
  type WorkflowRunSummary,
  type WorkspaceCollaborationRun,
  type WorkspaceRunControl,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export function workspaceRunControl(run: WorkspaceCollaborationRun): WorkspaceRunControl {
  if (run.runControl) return run.runControl;
  if (run.workflow)
    return {
      control: run.workflow.control,
      controlRevision: run.workflow.controlRevision,
      ...(run.workflow.executionRevision === undefined
        ? {}
        : { executionRevision: run.workflow.executionRevision }),
      updatedAt: run.workflow.updatedAt,
    };
  return { control: "active", controlRevision: 0, updatedAt: run.updatedAt };
}

export function withWorkspaceRunControl(
  run: WorkspaceCollaborationRun,
  control: WorkspaceRunControl,
): WorkspaceCollaborationRun {
  return {
    ...run,
    runControl: control,
    ...(run.workflow ? { workflow: { ...run.workflow, ...control } } : {}),
  };
}

export function summarizeWorkflowRun(
  run: Pick<
    WorkspaceCollaborationRun,
    "id" | "projectId" | "status" | "createdAt" | "updatedAt" | "error" | "workflow" | "graph"
  >,
): WorkflowRunSummary | null {
  if (!run.workflow) return null;
  const workflow = run.workflow;
  const nodes = run.graph?.nodes ?? [];
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    error: run.error,
    workflow: {
      title: workflow.title,
      definitionId: workflow.definitionId,
      definitionRevision: workflow.definitionRevision,
      definitionDigest: workflow.definitionDigest,
      control: workflow.control,
      controlRevision: workflow.controlRevision,
    },
    counts: {
      total: nodes.length,
      completed: nodes.filter((node) => node.status === "completed").length,
      running: nodes.filter((node) => node.status === "running").length,
      failed: nodes.filter((node) => node.status === "failed").length,
    },
    failedNodes: nodes
      .filter((node) => node.status === "failed" && node.attempts.length > 0)
      .map((node) => ({ id: node.id, title: node.title, attempts: node.attempts.length })),
  };
}

const VARIABLES = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function previewWorkflow(
  definition: WorkflowDefinition,
  values: WorkflowValues,
  options?: { allowMissingRequired?: boolean },
): WorkflowPreviewResult {
  const issues: WorkflowIssue[] = [];
  const inputs = new Map(definition.inputs.map((input) => [input.name, input]));
  if (inputs.size !== definition.inputs.length)
    issues.push({ path: "inputs", message: "입력 이름이 중복되었습니다." });
  const resolved = new Map<string, string>();
  for (const input of definition.inputs) {
    const value = values[input.name] ?? input.defaultValue;
    resolved.set(input.name, value);
    if (input.required && !value.trim() && !options?.allowMissingRequired)
      issues.push({ path: `inputs.${input.name}`, message: `${input.label} 입력이 필요합니다.` });
    if (value && input.type === "number" && !Number.isFinite(Number(value)))
      issues.push({ path: `inputs.${input.name}`, message: "유한한 숫자를 입력하세요." });
    if (value && input.type === "boolean" && !["true", "false"].includes(value))
      issues.push({ path: `inputs.${input.name}`, message: "true 또는 false를 입력하세요." });
    if (
      value &&
      input.type === "path" &&
      (/^(?:[A-Za-z]:|[/\\])/.test(value) || value.split(/[/\\]/).includes(".."))
    )
      issues.push({
        path: `inputs.${input.name}`,
        message: "프로젝트 안의 상대 경로를 입력하세요.",
      });
  }
  for (const key of Object.keys(values))
    if (!inputs.has(key))
      issues.push({ path: `inputs.${key}`, message: "정의되지 않은 입력입니다." });
  const ids = new Set(definition.nodes.map((node) => node.id));
  if (ids.size !== definition.nodes.length)
    issues.push({ path: "nodes", message: "단계 ID가 중복되었습니다." });
  if (ids.has("plan"))
    issues.push({ path: "nodes", message: "plan은 기존 실행기가 사용하는 단계 이름입니다." });
  const expand = (text: string, path: string) =>
    text.replace(VARIABLES, (_, name: string) => {
      if (!inputs.has(name)) {
        issues.push({ path, message: `정의되지 않은 입력 변수: ${name}` });
        return "";
      }
      return resolved.get(name) ?? "";
    });
  const nodes = definition.nodes.map((node) => {
    const expectedAgent =
      node.kind === "research"
        ? "grok"
        : node.kind === "implementation" || node.kind === "debug"
          ? "codex"
          : "fable";
    if (node.participantId === null && node.agent !== expectedAgent)
      issues.push({
        path: `nodes.${node.id}.agent`,
        message: `기존 실행기의 ${node.kind} 작업은 ${expectedAgent === "fable" ? "총괄" : expectedAgent === "codex" ? "구현" : "조사"} 역할로 연결해야 합니다.`,
      });
    if (new Set(node.dependsOn).size !== node.dependsOn.length)
      issues.push({
        path: `nodes.${node.id}.dependsOn`,
        message: "같은 선행 단계가 중복되었습니다.",
      });
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency))
        issues.push({
          path: `nodes.${node.id}.dependsOn`,
          message: `존재하지 않는 선행 단계: ${dependency}`,
        });
      if (dependency === node.id)
        issues.push({
          path: `nodes.${node.id}.dependsOn`,
          message: "단계가 자기 자신을 기다릴 수 없습니다.",
        });
    }
    const task = expand(node.task, `nodes.${node.id}.task`);
    if (task.length > 4000)
      issues.push({
        path: `nodes.${node.id}.task`,
        message: "입력 적용 후 작업 내용이 4,000자를 초과합니다.",
      });
    const successCriteria = node.successCriteria.map((criterion) =>
      expand(criterion, `nodes.${node.id}.successCriteria`),
    );
    if (successCriteria.some((criterion) => criterion.length > 4000))
      issues.push({
        path: `nodes.${node.id}.successCriteria`,
        message: "입력 적용 후 완료 기준이 기존 단계의 4,000자 제한을 초과합니다.",
      });
    const skillArguments = node.skills.map((skill) =>
      expand(skill.arguments, `nodes.${node.id}.skills`),
    );
    return {
      id: node.id,
      title: node.title,
      task,
      dependsOn: node.dependsOn,
      successCriteria,
      skillArguments,
    };
  });
  const remaining = new Set(ids);
  while (remaining.size) {
    const ready = definition.nodes.filter(
      (node) => remaining.has(node.id) && node.dependsOn.every((id) => !remaining.has(id)),
    );
    if (!ready.length) {
      issues.push({ path: "nodes", message: "단계 연결에 순환이 있습니다." });
      break;
    }
    for (const node of ready) remaining.delete(node.id);
  }
  if (definition.graphV2 !== undefined) {
    const v2Topology = validateWorkflowGraphV2Topology(definition.graphV2);
    for (const issue of v2Topology.issues) {
      issues.push({ path: `graphV2.${issue.path}`, message: issue.message });
    }
  }
  return { valid: issues.length === 0, issues, nodes };
}

export type WorkflowLintSeverity = "error" | "warning" | "info";

export interface WorkflowLintDiagnostic {
  readonly code:
    | "v2-topology-error"
    | "unverified-advisory-criteria"
    | "parallel-shared-write-risk"
    | "worktree-missing-reconcile"
    | "loop-missing-stagnation-guard"
    | "loop-missing-exit-condition"
    | "high-fanout-missing-budget";
  readonly severity: WorkflowLintSeverity;
  readonly path: string;
  readonly nodeIds: ReadonlyArray<string>;
  readonly message: string;
}

export interface WorkflowLintReport {
  readonly valid: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly topologicalOrder: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<WorkflowLintDiagnostic>;
}

/**
 * WorkflowGraph v2 정적 린터.
 * - 오류(error): 참조 무결성 깨짐, Forward-DAG 순환, 잘못된 loop_back 연결
 * - 경고(warning): 병렬 shared_write 충돌 위험, worktree 후단 reconcile 누락, 대량 fanout 예산 미지정
 * - 안내(info): v1 자연어 성공 기준만 남아 Verifier 미연결, 루프 정체 감지/탈출 조건 미설정
 */
export function lintWorkflowGraphV2(graph: WorkflowGraphV2Draft): WorkflowLintReport {
  const topology = validateWorkflowGraphV2Topology(graph);
  const diagnostics: WorkflowLintDiagnostic[] = topology.issues.map((issue) => ({
    code: "v2-topology-error",
    severity: "error",
    path: issue.path,
    nodeIds: [],
    message: issue.message,
  }));

  const forwardEdges = extractForwardEdges(graph);
  const incomingByNode = new Map<string, string[]>();
  const outgoingByNode = new Map<string, string[]>();
  for (const node of graph.nodes) {
    incomingByNode.set(node.id, []);
    outgoingByNode.set(node.id, []);
  }
  for (const edge of forwardEdges) {
    outgoingByNode.get(edge.from)?.push(edge.to);
    incomingByNode.get(edge.to)?.push(edge.from);
  }

  // Compute reachability to detect truly concurrent (incomparable) sibling nodes
  const ancestorsByNode = new Map<string, Set<string>>();
  for (const nodeId of topology.topologicalOrder) {
    const ancestors = new Set<string>();
    for (const parentId of incomingByNode.get(nodeId) ?? []) {
      ancestors.add(parentId);
      for (const grand of ancestorsByNode.get(parentId) ?? []) {
        ancestors.add(grand);
      }
    }
    ancestorsByNode.set(nodeId, ancestors);
  }

  // 1. Parallel shared_write conflict risk
  const sharedWriteNodes = graph.nodes.filter(
    (node) =>
      (node.kind === "agent" || node.kind === "subworkflow") && node.isolation === "shared_write",
  );
  const conflictedPairKeys = new Set<string>();
  for (let i = 0; i < sharedWriteNodes.length; i += 1) {
    for (let j = i + 1; j < sharedWriteNodes.length; j += 1) {
      const a = sharedWriteNodes[i]!;
      const b = sharedWriteNodes[j]!;
      const aAnc = ancestorsByNode.get(a.id);
      const bAnc = ancestorsByNode.get(b.id);
      if (aAnc && bAnc && !aAnc.has(b.id) && !bAnc.has(a.id)) {
        const pairKey = [a.id, b.id].toSorted().join("::");
        if (!conflictedPairKeys.has(pairKey)) {
          conflictedPairKeys.add(pairKey);
          diagnostics.push({
            code: "parallel-shared-write-risk",
            severity: "warning",
            path: `nodes.${a.id}`,
            nodeIds: [a.id, b.id],
            message: `병렬 실행 가능한 쓰기 노드 "${a.id}"와 "${b.id}"가 모두 shared_write입니다. 파일 충돌을 막으려면 git_worktree 격리와 reconcile_worktrees 노드를 사용하세요.`,
          });
        }
      }
    }
  }

  // 2. git_worktree nodes without downstream reconcile_worktrees
  const hasReconcileNode = graph.nodes.some((node) => node.kind === "reconcile_worktrees");
  const worktreeNodes = graph.nodes.filter(
    (node) =>
      (node.kind === "agent" && node.isolation === "git_worktree") ||
      (node.kind === "subworkflow" && node.isolation === "git_worktree") ||
      (node.kind === "map_fanout" && node.isolationPerItem === "git_worktree"),
  );
  if (worktreeNodes.length > 0 && !hasReconcileNode) {
    diagnostics.push({
      code: "worktree-missing-reconcile",
      severity: "warning",
      path: "nodes",
      nodeIds: worktreeNodes.map((node) => node.id),
      message: `git_worktree 격리 노드(${worktreeNodes.map((n) => n.id).join(", ")})가 있지만 후속 reconcile_worktrees 병합 노드가 없습니다.`,
    });
  }

  // 3. Unverified advisory criteria from v1 upcast (or agent nodes with advisoryCriteria but no verifier downstream)
  const verifierIds = new Set<string>(
    graph.nodes.filter((node) => node.kind === "verifier").map((node) => node.id),
  );
  const unverifiedIds = new Set<string>(graph.migrationProvenance?.unverifiedCriteriaNodeIds ?? []);
  for (const node of graph.nodes) {
    if (node.kind === "agent" && node.advisoryCriteria.length > 0) {
      const hasDirectVerifier = (outgoingByNode.get(node.id) ?? []).some((nextId) =>
        verifierIds.has(nextId),
      );
      if (!hasDirectVerifier && (unverifiedIds.has(node.id) || verifierIds.size === 0)) {
        diagnostics.push({
          code: "unverified-advisory-criteria",
          severity: "info",
          path: `nodes.${node.id}.advisoryCriteria`,
          nodeIds: [node.id],
          message: `"${node.id}" 단계는 자연어 완료 기준(${node.advisoryCriteria.length}개)만 있습니다. 결정론적 Verifier 노드를 연결하면 기계적 합격 판정이 가능합니다.`,
        });
      }
    }
  }

  // 4. Loop safety checks
  for (const loop of graph.loops) {
    if (!loop.stagnationDetection.enabled) {
      diagnostics.push({
        code: "loop-missing-stagnation-guard",
        severity: "warning",
        path: `loops.${loop.loopId}.stagnationDetection`,
        nodeIds: [loop.entryNodeId, loop.exitNodeId],
        message: `루프 "${loop.loopId}"에 정체 감지(stagnationDetection)가 꺼져 있습니다. 동일 오류 반복 시 조기 중단을 위해 활성화를 권장합니다.`,
      });
    }
    if (!loop.exitConditionExpr || loop.exitConditionExpr.trim().length === 0) {
      diagnostics.push({
        code: "loop-missing-exit-condition",
        severity: "info",
        path: `loops.${loop.loopId}.exitConditionExpr`,
        nodeIds: [loop.exitNodeId],
        message: `루프 "${loop.loopId}"에 명시적 exitConditionExpr이 없습니다. Verifier 결과를 기준으로 탈출 조건을 지정하는 것을 권장합니다.`,
      });
    }
  }

  // 5. Large dynamic map_fanout without runBudget
  if (graph.runBudget === undefined) {
    for (const node of graph.nodes) {
      if (node.kind === "map_fanout" && node.maxFanOut >= 16) {
        diagnostics.push({
          code: "high-fanout-missing-budget",
          severity: "warning",
          path: `nodes.${node.id}.maxFanOut`,
          nodeIds: [node.id],
          message: `병렬 팬아웃 노드 "${node.id}"(최대 ${node.maxFanOut}개)에 그래프 전역 runBudget이 설정되지 않았습니다.`,
        });
      }
    }
  }

  const errorCount = diagnostics.filter((item) => item.severity === "error").length;
  const warningCount = diagnostics.filter((item) => item.severity === "warning").length;
  const infoCount = diagnostics.filter((item) => item.severity === "info").length;
  return {
    valid: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    topologicalOrder: topology.topologicalOrder,
    diagnostics,
  };
}

/**
 * Validates referential integrity and Forward-DAG acyclicity for WorkflowGraph v2.
 * `loop_back` edges are excluded from topological sorting and verified against their
 * declared `LoopSpecV2` entry/exit nodes instead.
 */
export function validateWorkflowGraphV2Topology(graph: WorkflowGraphV2Draft): {
  readonly valid: boolean;
  readonly issues: ReadonlyArray<WorkflowIssue>;
  readonly topologicalOrder: ReadonlyArray<string>;
} {
  const issues: WorkflowIssue[] = collectGraphReferentialIssues(graph).map((message) => ({
    path: "graph",
    message,
  }));
  const nodeIds = new Set<string>(graph.nodes.map((node) => node.id));
  const forwardEdges = extractForwardEdges(graph);
  const incomingCount = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    incomingCount.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of forwardEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const node of graph.nodes) {
    if ((incomingCount.get(node.id) ?? 0) === 0 && !queue.includes(node.id)) {
      queue.push(node.id);
    }
  }
  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    topologicalOrder.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const nextCount = (incomingCount.get(next) ?? 1) - 1;
      incomingCount.set(next, nextCount);
      if (nextCount === 0) queue.push(next);
    }
  }
  if (topologicalOrder.length !== nodeIds.size) {
    issues.push({
      path: "edges",
      message:
        "Forward-DAG 연결에 순환이 있습니다. 의도된 반복은 loop_back 엣지와 LoopSpec으로 선언하세요.",
    });
  }

  const loopById = new Map(graph.loops.map((loop) => [loop.loopId, loop]));
  for (const backEdge of extractLoopBackEdges(graph)) {
    const spec = backEdge.loopId ? loopById.get(backEdge.loopId) : undefined;
    if (!spec) continue;
    if (backEdge.from !== spec.exitNodeId || backEdge.to !== spec.entryNodeId) {
      issues.push({
        path: `edges.${backEdge.id}`,
        message: `loop_back 엣지 "${backEdge.id}"는 루프 "${spec.loopId}"의 exitNodeId("${spec.exitNodeId}")에서 entryNodeId("${spec.entryNodeId}")로 연결되어야 합니다.`,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    topologicalOrder,
  };
}

export function workflowDefaults(): WorkflowDefinition[] {
  const templates = [
    [
      "feature",
      "기능 개발",
      "요구와 현재 코드를 분석하고 구현 범위를 정한다.",
      "기능을 구현하고 변경 범위의 테스트·타입 검사·lint를 수행한다.",
    ],
    [
      "bugfix",
      "오류 수정",
      "증상을 재현하고 원본 로그·코드로 원인 가설을 검증한다.",
      "확인한 원인을 수정하고 원래 재현 조건과 회귀 검사를 수행한다.",
    ],
    [
      "research",
      "외부 자료 조사",
      "요청과 관련된 원문 자료를 찾고 URL·버전·확인 범위를 기록한다.",
      "근거를 대조하고 사실·추정·미확인을 구별해 결과를 정리한다.",
    ],
    [
      "review",
      "변경 검토",
      "요구·변경 파일·검증 기준을 확인한다.",
      "실제 결함과 개선 제안을 구별해 위치·재현 조건·근거를 보고한다.",
    ],
    [
      "workflow",
      "워크플로 작성·복구",
      "현재 환경·계약·단계 연결과 원본 오류를 확인한다.",
      "단계를 구성하거나 수정하고 구조·연결·실제 출력값을 각각 검증한다.",
    ],
    [
      "skill-eval",
      "스킬 비교·개선",
      "원본 스킬과 후보·평가 입력을 고정하고 호출해야 할 요청과 유사한 부정 사례를 준비한다.",
      "같은 조건의 결과·사용량·지연을 비교하고 개선안·남은 한계를 기록한다. 공용 원본은 자동 덮어쓰지 않는다.",
    ],
  ];
  return templates.map(([id, title, first, second]) => ({
    schemaVersion: 1,
    id: id!,
    title: title!,
    description: "분석·실행·검증 근거를 남기는 재사용 작업 흐름",
    inputs: [
      { name: "goal", label: "작업 목표", type: "string", required: true, defaultValue: "" },
    ],
    nodes: [
      {
        id: "analyze",
        title: "요구와 근거 확인",
        kind: "orchestration",
        agent: "fable",
        participantId: null,
        task: `${first}\n목표: {{goal}}`,
        dependsOn: [],
        successCriteria: ["범위와 성공 기준이 명확하다."],
        skills: [],
      },
      {
        id: "execute",
        title: "작업 수행과 증거 확인",
        kind: id === "research" || id === "review" ? "research" : "implementation",
        agent: id === "research" || id === "review" ? "grok" : "codex",
        participantId: null,
        task: `${second}\n목표: {{goal}}`,
        dependsOn: ["analyze"],
        successCriteria: [
          "실행한 명령·원문·산출물로 결과를 확인한다.",
          "현재 권한·질문·조건·계획 모드를 유지한다.",
        ],
        skills: [],
      },
    ],
  }));
}

export interface BuiltinWorkflowV2PresetEntry {
  readonly id: string;
  readonly badge: string;
  readonly title: string;
  readonly summary: string;
  readonly build: () => WorkflowGraphV2;
}

/**
 * Shared WorkflowGraphV2 preset catalog surfaced in the Control Center UI.
 * Keeps `graph-pr-review`, `graph-simplify-3way`, and the opt-in
 * `graph-job-application-drafter-reviewer` (built on existing `hiring-*` + `docx`/`pdf` skills)
 * selectable in 1 click without polluting T3 core runtime logic.
 */
export function buildBuiltinWorkflowV2Presets(): ReadonlyArray<BuiltinWorkflowV2PresetEntry> {
  return [
    {
      id: "graph-pr-review",
      badge: "PR 리뷰 · 최대 3라운드",
      title: "교차 모델 PR 리뷰 · 적대적 검증 루프",
      summary:
        "보안·로직 병렬 리뷰 → 적대적 검증(UNVERIFIED_ERROR 보존) → 최소 수정 + 테스트/Diff 가드",
      build: () =>
        Schema.decodeUnknownSync(WorkflowGraphV2)({
          schemaVersion: 2,
          id: "graph-pr-review",
          title: "교차 모델 PR 리뷰 · 적대적 검증 · 자동 수정 루프",
          description:
            "서로 다른 모델 계열 2종이 병렬 리뷰 후 적대적 검증(UNVERIFIED_ERROR 비기각)과 중복 제거를 거쳐 최대 3라운드 내 최소 수정 및 결정론적 테스트/Diff 가드를 통과시킵니다.",
          inputs: [
            {
              key: "targetRef",
              label: "검토 대상 범위 (git diff / 파일)",
              valueType: "string",
              required: false,
              defaultValue: "HEAD",
            },
          ],
          nodes: [
            {
              id: "review_security",
              kind: "agent",
              title: "보안·경계 병렬 리뷰",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Read-only security and boundary review for {{targetRef}}. Return structured findings with {file, line, severity, category, title, detail}. Never edit files.",
              capability: "adversarial-reviewer",
              routing: { requiresStructuredOutput: true, excludeProviderFamilies: ["openai"] },
              isolation: "shared_readonly",
              sideEffectPolicy: "pure_readonly",
              inputBindings: { targetRef: "{{inputs.targetRef}}" },
              advisoryCriteria: [],
              cleanContext: true,
              cacheable: true,
            },
            {
              id: "review_logic",
              kind: "agent",
              title: "정확성·회귀 병렬 리뷰",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Read-only correctness, edge-case, and performance regression review for {{targetRef}}. Return structured findings with {file, line, severity, category, title, detail}. Never edit files.",
              capability: "adversarial-reviewer",
              routing: { requiresStructuredOutput: true, excludeProviderFamilies: ["anthropic"] },
              isolation: "shared_readonly",
              sideEffectPolicy: "pure_readonly",
              inputBindings: { targetRef: "{{inputs.targetRef}}" },
              advisoryCriteria: [],
              cleanContext: true,
              cacheable: true,
            },
            {
              id: "verify_findings",
              kind: "agent",
              title: "적대적 검증 및 중복 병합",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Deduplicate overlapping findings within ±3 lines from review_security and review_logic. Verify independently as CONFIRM, REJECT, or UNVERIFIED_ERROR.",
              capability: "adversarial-reviewer",
              routing: { requiresStructuredOutput: true },
              isolation: "shared_readonly",
              sideEffectPolicy: "pure_readonly",
              inputBindings: {
                securityFindings: "$.nodes.review_security.output",
                logicFindings: "$.nodes.review_logic.output",
              },
              advisoryCriteria: [],
              cleanContext: true,
              cacheable: true,
            },
            {
              id: "fix_verified",
              kind: "agent",
              title: "검증 결함 최소 수정",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Apply minimal, surgical fixes only for CONFIRM findings from verify_findings. Do not refactor unrelated code.",
              capability: "code-surgeon",
              isolation: "shared_write",
              sideEffectPolicy: "workspace_mutation",
              inputBindings: { verifiedFindings: "$.nodes.verify_findings.output" },
              advisoryCriteria: [],
              cleanContext: false,
              cacheable: false,
            },
            {
              id: "verify_tests",
              kind: "verifier",
              title: "결정론적 테스트 게이트",
              joinPolicy: "all_succeeded",
              isolation: "shared_readonly",
              verifier: {
                type: "command_exit",
                command: "vp",
                args: ["test", "run"],
                expectedExitCodes: [0],
                timeoutMs: 120_000,
              },
            },
            {
              id: "guard_diff",
              kind: "verifier",
              title: "클린 Diff·비밀키 가드",
              joinPolicy: "all_succeeded",
              isolation: "shared_readonly",
              verifier: {
                type: "git_diff_guard",
                forbiddenPathGlobs: [".env", "**/.env", "**/*.pem", "**/*.key"],
                blockPotentialSecrets: true,
              },
            },
          ],
          edges: [
            {
              id: "e_sec_verify",
              from: "review_security",
              to: "verify_findings",
              kind: "unconditional",
            },
            {
              id: "e_logic_verify",
              from: "review_logic",
              to: "verify_findings",
              kind: "unconditional",
            },
            {
              id: "e_verify_fix",
              from: "verify_findings",
              to: "fix_verified",
              kind: "unconditional",
            },
            { id: "e_fix_tests", from: "fix_verified", to: "verify_tests", kind: "unconditional" },
            { id: "e_tests_guard", from: "verify_tests", to: "guard_diff", kind: "unconditional" },
            {
              id: "e_loop_retry_fix",
              from: "verify_tests",
              to: "fix_verified",
              kind: "loop_back",
              loopId: "pr_fix_verify_loop",
            },
          ],
          loops: [
            {
              loopId: "pr_fix_verify_loop",
              entryNodeId: "fix_verified",
              exitNodeId: "verify_tests",
              maxIterations: 3,
              exitConditionExpr: "$.nodes.verify_tests.output.passed == true",
              stagnationDetection: { enabled: true, historyWindowSize: 3 },
              onExhausted: "interrupt_for_human",
            },
          ],
          runBudget: {
            maxTotalTokens: 400_000,
            softThresholdRatio: 0.8,
            onSoftThreshold: "downgrade_capability",
            onHardExceeded: "pause_run",
          },
        }),
    },
    {
      id: "graph-simplify-3way",
      badge: "3-Way 병렬 정리",
      title: "3-Way 병렬 코드 정리 (재사용·품질·효율)",
      summary:
        "재사용·품질(`// shortcut:` 집계)·효율 3관점 병렬 검토 → 동작 보존 최소 정리 → 테스트·Diff 가드",
      build: () =>
        Schema.decodeUnknownSync(WorkflowGraphV2)({
          schemaVersion: 2,
          id: "graph-simplify-3way",
          title: "3-Way 병렬 코드 정리 (재사용·품질·효율)",
          description:
            "Reuse·Quality·Efficiency 3개 읽기 전용 관점으로 변경분을 병렬 검토하고, ±3줄 중복을 병합한 뒤 동작을 유지하며 최소 정리 및 결정론적 검증을 수행합니다.",
          inputs: [
            {
              key: "scope",
              label: "정리 대상 파일/범위",
              valueType: "string",
              required: false,
              defaultValue: "git diff",
            },
          ],
          nodes: [
            {
              id: "review_reuse",
              kind: "agent",
              title: "관점 A: 재사용·중복 검토",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Read-only review of {{scope}} for code reuse and duplication against packages/shared and packages/contracts.",
              capability: "fast-scout",
              isolation: "shared_readonly",
              sideEffectPolicy: "pure_readonly",
              inputBindings: { scope: "{{inputs.scope}}" },
              advisoryCriteria: [],
              cleanContext: true,
              cacheable: true,
            },
            {
              id: "review_quality",
              kind: "agent",
              title: "관점 B: 명확성·과잉설계·// shortcut: 검토",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Read-only review of {{scope}} for dead code, over-engineering, type safety violations, and Ponytail `// shortcut:` technical-debt markers.",
              capability: "adversarial-reviewer",
              isolation: "shared_readonly",
              sideEffectPolicy: "pure_readonly",
              inputBindings: { scope: "{{inputs.scope}}" },
              advisoryCriteria: [],
              cleanContext: true,
              cacheable: true,
            },
            {
              id: "review_efficiency",
              kind: "agent",
              title: "관점 C: 효율성·운영 안전성 검토",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Read-only review of {{scope}} for O(N^2) loops, unbounded caches, payload bloat, and Windows handle/path cleanup bugs.",
              capability: "adversarial-reviewer",
              isolation: "shared_readonly",
              sideEffectPolicy: "pure_readonly",
              inputBindings: { scope: "{{inputs.scope}}" },
              advisoryCriteria: [],
              cleanContext: true,
              cacheable: true,
            },
            {
              id: "consolidate_fix",
              kind: "agent",
              title: "중복 병합 및 동작 보존 최소 정리",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Merge findings within ±3 lines from review_reuse, review_quality, and review_efficiency. Apply only behavior-preserving high/medium cleanups.",
              capability: "code-surgeon",
              isolation: "shared_write",
              sideEffectPolicy: "workspace_mutation",
              inputBindings: {
                reuse: "$.nodes.review_reuse.output",
                quality: "$.nodes.review_quality.output",
                efficiency: "$.nodes.review_efficiency.output",
              },
              advisoryCriteria: [],
              cleanContext: false,
              cacheable: false,
            },
            {
              id: "verify_simplify",
              kind: "verifier",
              title: "회귀 테스트 검증",
              joinPolicy: "all_succeeded",
              isolation: "shared_readonly",
              verifier: {
                type: "command_exit",
                command: "vp",
                args: ["test", "run"],
                expectedExitCodes: [0],
                timeoutMs: 120_000,
              },
            },
            {
              id: "guard_diff",
              kind: "verifier",
              title: "Diff 범위·비밀키 가드",
              joinPolicy: "all_succeeded",
              isolation: "shared_readonly",
              verifier: {
                type: "git_diff_guard",
                forbiddenPathGlobs: [".env", "**/.env", "**/*.pem", "**/*.key"],
                blockPotentialSecrets: true,
              },
            },
          ],
          edges: [
            {
              id: "e_reuse_fix",
              from: "review_reuse",
              to: "consolidate_fix",
              kind: "unconditional",
            },
            {
              id: "e_quality_fix",
              from: "review_quality",
              to: "consolidate_fix",
              kind: "unconditional",
            },
            {
              id: "e_efficiency_fix",
              from: "review_efficiency",
              to: "consolidate_fix",
              kind: "unconditional",
            },
            {
              id: "e_fix_verify",
              from: "consolidate_fix",
              to: "verify_simplify",
              kind: "unconditional",
            },
            {
              id: "e_verify_guard",
              from: "verify_simplify",
              to: "guard_diff",
              kind: "unconditional",
            },
          ],
          loops: [],
          runBudget: {
            maxTotalTokens: 300_000,
            softThresholdRatio: 0.8,
            onSoftThreshold: "downgrade_capability",
            onHardExceeded: "pause_run",
          },
        }),
    },
    {
      id: "graph-job-application-drafter-reviewer",
      badge: "지원서 이중 검토 · 최대 3라운드",
      title: "채용 공고 적합도 · CV/커버레터 레드팀 루프",
      summary:
        "공고 적합도 채점 → 맞춤형 초안 작성 → hiring-sim-resume-redteam 적대적 검토(최대 3라운드) → PDF/DOCX·트래커 기록",
      build: () =>
        Schema.decodeUnknownSync(WorkflowGraphV2)({
          schemaVersion: 2,
          id: "graph-job-application-drafter-reviewer",
          title: "채용 공고 적합도 분석 · CV/커버레터 작성-레드팀 이중 검토 루프",
          description:
            "채용 공고 요구사항과 지원자 이력을 대조해 적합도를 채점하고, 기존 hiring-prep-doc-feedback / hiring-sim-resume-redteam / docx·pdf 스킬을 활용해 최대 3라운드 이중 검토 후 맞춤형 지원서와 로컬 지원 트래커 항목을 생성합니다.",
          inputs: [
            {
              key: "jobPosting",
              label: "채용 공고 전문 또는 파일 경로",
              valueType: "string",
              required: true,
              defaultValue: "",
            },
            {
              key: "candidateProfile",
              label: "지원자 기준 이력서/경력 요약 경로",
              valueType: "string",
              required: true,
              defaultValue: "",
            },
            {
              key: "trackerPath",
              label: "로컬 지원 현황 트래커 파일 경로",
              valueType: "string",
              required: false,
              defaultValue: "applications-tracker.md",
            },
          ],
          nodes: [
            {
              id: "analyze_fit",
              kind: "agent",
              title: "공고 요구사항 분해 및 적합도 채점",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Read-only job fit analysis comparing {{jobPosting}} against {{candidateProfile}}. Extract must-have requirements, concrete gaps, and a 0-100 rubric score. Never fabricate candidate experience.",
              capability: "fast-scout",
              routing: { requiresStructuredOutput: true },
              isolation: "shared_readonly",
              sideEffectPolicy: "pure_readonly",
              inputBindings: {
                jobPosting: "{{inputs.jobPosting}}",
                candidateProfile: "{{inputs.candidateProfile}}",
              },
              advisoryCriteria: [],
              cleanContext: true,
              cacheable: true,
            },
            {
              id: "draft_application",
              kind: "agent",
              title: "맞춤형 이력서·커버레터 초안 작성 (Drafter)",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Using verified facts only from {{candidateProfile}} and analyze_fit (plus any redteam_review defects on retry), draft a tailored CV delta and cover letter following hiring-prep-doc-feedback.",
              capability: "code-surgeon",
              isolation: "shared_write",
              sideEffectPolicy: "workspace_mutation",
              inputBindings: {
                fitAnalysis: "$.nodes.analyze_fit.output",
                candidateProfile: "{{inputs.candidateProfile}}",
              },
              advisoryCriteria: [],
              cleanContext: false,
              cacheable: false,
            },
            {
              id: "redteam_review",
              kind: "agent",
              title: "채용담당자 레드팀 적대적 검토 (Reviewer)",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Act as a skeptical hiring manager using hiring-sim-resume-redteam. Audit draft_application against {{jobPosting}} and {{candidateProfile}} for unsupported claims, vague metrics, and ATS gaps. Return JSON { passed, score, defects }.",
              capability: "adversarial-reviewer",
              routing: { requiresStructuredOutput: true },
              isolation: "shared_readonly",
              sideEffectPolicy: "pure_readonly",
              inputBindings: {
                draft: "$.nodes.draft_application.output",
                jobPosting: "{{inputs.jobPosting}}",
                candidateProfile: "{{inputs.candidateProfile}}",
              },
              advisoryCriteria: [],
              cleanContext: true,
              cacheable: false,
            },
            {
              id: "export_and_track",
              kind: "agent",
              title: "문서 내보내기(PDF/DOCX) 및 로컬 트래커 기록",
              joinPolicy: "all_succeeded",
              promptTemplate:
                "Finalize the approved application package compatible with pdf/docx skills and append a dated status entry to {{trackerPath}}.",
              capability: "code-surgeon",
              isolation: "shared_write",
              sideEffectPolicy: "workspace_mutation",
              inputBindings: {
                approvedDraft: "$.nodes.draft_application.output",
                reviewSummary: "$.nodes.redteam_review.output",
                trackerPath: "{{inputs.trackerPath}}",
              },
              advisoryCriteria: [],
              cleanContext: false,
              cacheable: false,
            },
          ],
          edges: [
            {
              id: "e_fit_draft",
              from: "analyze_fit",
              to: "draft_application",
              kind: "unconditional",
            },
            {
              id: "e_draft_review",
              from: "draft_application",
              to: "redteam_review",
              kind: "unconditional",
            },
            {
              id: "e_review_export",
              from: "redteam_review",
              to: "export_and_track",
              kind: "unconditional",
            },
            {
              id: "e_loop_revise_draft",
              from: "redteam_review",
              to: "draft_application",
              kind: "loop_back",
              loopId: "job_draft_review_loop",
            },
          ],
          loops: [
            {
              loopId: "job_draft_review_loop",
              entryNodeId: "draft_application",
              exitNodeId: "redteam_review",
              maxIterations: 3,
              exitConditionExpr: "$.nodes.redteam_review.output.passed == true",
              stagnationDetection: { enabled: true, historyWindowSize: 3 },
              onExhausted: "interrupt_for_human",
            },
          ],
          runBudget: {
            maxTotalTokens: 200_000,
            softThresholdRatio: 0.8,
            onSoftThreshold: "downgrade_capability",
            onHardExceeded: "pause_run",
          },
        }),
    },
  ];
}
