import type {
  WorkflowDefinition,
  WorkflowIssue,
  WorkflowPreviewResult,
  WorkflowValues,
  WorkflowRunSummary,
  WorkspaceCollaborationRun,
  WorkspaceRunControl,
} from "@t3tools/contracts";

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
  return { valid: issues.length === 0, issues, nodes };
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
