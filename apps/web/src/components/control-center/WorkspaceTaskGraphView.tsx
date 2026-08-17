import { useId, useMemo } from "react";
import type {
  ThreadId,
  WorkspaceAgentRole,
  WorkspaceFailureClassification,
  WorkspaceMemoryCategory,
  WorkspaceOrchestrationAgent,
  WorkspaceTaskAttempt,
  WorkspaceTaskAttemptStatus,
  WorkspaceTaskGraph,
  WorkspaceTaskGraphChangeReason,
  WorkspaceTaskGraphStatus,
  WorkspaceTaskNode,
  WorkspaceTaskNodeKind,
  WorkspaceTaskNodeStatus,
  WorkspaceValidationConfidence,
  WorkspaceValidationVerdict,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  DatabaseIcon,
  GitBranchIcon,
  HistoryIcon,
  ListChecksIcon,
  RouteIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  layoutWorkspaceTaskGraph,
  type WorkspaceTaskGraphLayout,
} from "./workspaceTaskGraphLayout";

type BadgeVariant = "success" | "warning" | "error" | "outline" | "info";

const AGENT_LABELS: Readonly<Record<WorkspaceOrchestrationAgent, string>> = {
  fable: "페이블 · 총괄",
  codex: "코덱스 · 구현",
  grok: "그록 · 조사",
};

const ROLE_LABELS: Readonly<Record<WorkspaceAgentRole, string>> = {
  coordinator: "총괄 조정자",
  operator: "운영·오류 진단 담당",
  planner: "계획 담당",
  researcher: "조사 담당",
  implementer: "구현 담당",
  reviewer: "검토 담당",
  verifier: "검증 담당",
};

const NODE_KIND_LABELS: Readonly<Record<WorkspaceTaskNodeKind, string>> = {
  orchestration: "목표 분석·조정",
  research: "조사",
  implementation: "구현",
  debug: "오류 수정",
  validation: "검증",
  synthesis: "결과 종합",
};

const NODE_STATUS_LABELS: Readonly<Record<WorkspaceTaskNodeStatus, string>> = {
  blocked: "선행 작업 대기",
  queued: "실행 대기",
  running: "실행 중",
  "awaiting-validation": "검증 대기",
  "awaiting-user": "내 답변 대기",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
  skipped: "건너뜀",
};

const ATTEMPT_STATUS_LABELS: Readonly<Record<WorkspaceTaskAttemptStatus, string>> = {
  running: "실행 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
};

const GRAPH_STATUS_LABELS: Readonly<Record<WorkspaceTaskGraphStatus, string>> = {
  planning: "계획 수립 중",
  executing: "작업 실행 중",
  validating: "결과 검증 중",
  synthesizing: "결과 종합 중",
  completed: "완료",
  failed: "실패",
};

const CONFIDENCE_LABELS: Readonly<Record<WorkspaceValidationConfidence, string>> = {
  high: "신뢰도 높음",
  medium: "신뢰도 보통",
  low: "신뢰도 낮음",
};

const VERDICT_LABELS: Readonly<Record<WorkspaceValidationVerdict, string>> = {
  pass: "검증 통과",
  fail: "검증 실패",
  inconclusive: "판단 보류",
};

const FAILURE_LABELS: Readonly<Record<WorkspaceFailureClassification, string>> = {
  information: "정보 부족",
  implementation: "구현 오류",
  tool: "도구 오류",
  assumption: "잘못된 가정",
  validation: "검증 실패",
};

const CHANGE_REASON_LABELS: Readonly<Record<WorkspaceTaskGraphChangeReason, string>> = {
  "initial-plan": "최초 계획",
  "new-information": "새 정보 발견",
  "information-gap": "정보 부족",
  "implementation-failure": "구현 실패",
  "tool-failure": "도구 실패",
  "result-conflict": "결과 충돌",
  "invalid-assumption": "잘못된 가정",
  "low-confidence": "낮은 신뢰도",
  "validation-failure": "검증 실패",
};

const MEMORY_CATEGORY_LABELS: Readonly<Record<WorkspaceMemoryCategory, string>> = {
  "project-structure": "프로젝트 구조",
  architecture: "구조 설계",
  "successful-pattern": "성공한 방식",
  "failure-pattern": "실패 원인",
  "verified-data-source": "검증된 자료 출처",
  "user-workflow": "사용자 작업 방식",
  "agent-performance": "에이전트 성과",
};

function nodeStatusVariant(status: WorkspaceTaskNodeStatus): BadgeVariant {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "info";
  if (status === "awaiting-validation" || status === "blocked") return "warning";
  return "outline";
}

function attemptStatusVariant(status: WorkspaceTaskAttemptStatus): BadgeVariant {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "info";
  return "outline";
}

function graphStatusVariant(status: WorkspaceTaskGraphStatus): BadgeVariant {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "validating" || status === "synthesizing") return "warning";
  return "info";
}

function confidenceVariant(confidence: WorkspaceValidationConfidence): BadgeVariant {
  if (confidence === "high") return "success";
  if (confidence === "low") return "error";
  return "warning";
}

function verdictVariant(verdict: WorkspaceValidationVerdict): BadgeVariant {
  if (verdict === "pass") return "success";
  if (verdict === "fail") return "error";
  return "warning";
}

function formatTimestamp(value: string | null): string {
  if (value === null) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}

function sortedAttempts(node: WorkspaceTaskNode): ReadonlyArray<WorkspaceTaskAttempt> {
  return node.attempts
    .slice()
    .sort(
      (left, right) => left.number - right.number || left.startedAt.localeCompare(right.startedAt),
    );
}

function latestAttempt(node: WorkspaceTaskNode): WorkspaceTaskAttempt | null {
  return sortedAttempts(node).at(-1) ?? null;
}

function routeChanged(previous: WorkspaceTaskAttempt, current: WorkspaceTaskAttempt): boolean {
  return (
    previous.agent !== current.agent ||
    previous.role !== current.role ||
    previous.modelSelection.instanceId !== current.modelSelection.instanceId ||
    previous.modelSelection.model !== current.modelSelection.model
  );
}

function nodeTitle(layout: WorkspaceTaskGraphLayout, nodeId: string): string {
  return layout.nodeById.get(nodeId)?.title ?? nodeId;
}

function NodeDependencies({
  node,
  layout,
}: {
  node: WorkspaceTaskNode;
  layout: WorkspaceTaskGraphLayout;
}) {
  const missing = new Set(
    layout.missingDependencies
      .filter((entry) => entry.nodeId === String(node.id))
      .map((entry) => entry.dependencyId),
  );

  return (
    <div className="grid gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">선행 작업</span>
      {node.dependsOn.length === 0 ? (
        <span className="text-xs text-muted-foreground">바로 시작할 수 있는 작업</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {node.dependsOn.map((dependencyId) => {
            const id = String(dependencyId);
            return (
              <Badge key={id} size="sm" variant={missing.has(id) ? "error" : "outline"}>
                {missing.has(id) ? "찾을 수 없음 · " : ""}
                {nodeTitle(layout, id)}
              </Badge>
            );
          })}
        </div>
      )}
      {node.validationTargetId !== null ? (
        <p className="text-[11px] text-muted-foreground">
          검증 대상 · {nodeTitle(layout, String(node.validationTargetId))}
        </p>
      ) : null}
    </div>
  );
}

function CurrentAssignment({
  node,
  attempt,
}: {
  node: WorkspaceTaskNode;
  attempt: WorkspaceTaskAttempt | null;
}) {
  return (
    <div className="rounded-lg border border-border/55 bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <BotIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <Badge size="sm" variant="info">
          {AGENT_LABELS[attempt?.agent ?? node.agent]}
        </Badge>
        <Badge size="sm" variant="outline">
          {ROLE_LABELS[attempt?.role ?? node.role]}
        </Badge>
        {attempt ? (
          <Badge size="sm" variant={attemptStatusVariant(attempt.status)}>
            {attempt.number}차 · {ATTEMPT_STATUS_LABELS[attempt.status]}
          </Badge>
        ) : null}
      </div>
      {attempt ? (
        <dl className="mt-2 grid gap-1 text-[11px] sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-muted-foreground">현재 계정</dt>
            <dd className="truncate font-mono text-foreground">
              {attempt.modelSelection.instanceId}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">현재 모델</dt>
            <dd className="truncate font-mono text-foreground">{attempt.modelSelection.model}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">
          실행이 시작되면 실제 계정과 모델이 여기에 표시됩니다.
        </p>
      )}
    </div>
  );
}

function ValidationReceipt({ node }: { node: WorkspaceTaskNode }) {
  const receipt = node.validation;
  if (receipt === null) return null;

  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-background/55 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <ShieldCheckIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-xs font-semibold">검증 결과</span>
        <Badge size="sm" variant={verdictVariant(receipt.verdict)}>
          {VERDICT_LABELS[receipt.verdict]}
        </Badge>
        <Badge size="sm" variant={confidenceVariant(receipt.confidence)}>
          {CONFIDENCE_LABELS[receipt.confidence]}
        </Badge>
        {receipt.failureClassification ? (
          <Badge size="sm" variant="error">
            {FAILURE_LABELS[receipt.failureClassification]}
          </Badge>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-xs leading-relaxed">{receipt.summary}</p>
      {receipt.evidence.length > 0 ? (
        <div>
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">검증 근거</p>
          <ul className="grid list-disc gap-1 pl-4 text-xs leading-relaxed">
            {receipt.evidence.map((evidence, index) => (
              <li key={`${index}:${evidence}`}>{evidence}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {receipt.nextAction.trim() ? (
        <p className="rounded-md bg-muted/35 px-2.5 py-2 text-xs leading-relaxed">
          <span className="font-semibold">검증 후 행동 · </span>
          {receipt.nextAction}
        </p>
      ) : null}
    </div>
  );
}

function AttemptHistory({
  node,
  onOpenThread,
}: {
  node: WorkspaceTaskNode;
  onOpenThread?:
    | ((input: {
        readonly threadId: ThreadId;
        readonly node: WorkspaceTaskNode;
        readonly attempt: WorkspaceTaskAttempt;
      }) => void)
    | undefined;
}) {
  const attempts = sortedAttempts(node);
  if (attempts.length === 0) return null;
  const reroutes = attempts.reduce((count, attempt, index) => {
    const previous = attempts[index - 1];
    return previous && routeChanged(previous, attempt) ? count + 1 : count;
  }, 0);

  return (
    <details className="rounded-lg border border-border/55 bg-background/40">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold marker:hidden">
        <HistoryIcon className="size-3.5 text-muted-foreground" aria-hidden />
        재라우팅·시도 이력
        <span className="ml-auto font-normal text-muted-foreground">
          시도 {attempts.length}회 · 경로 변경 {reroutes}회
        </span>
      </summary>
      <ol className="grid gap-2 border-t border-border/50 p-2.5">
        {attempts.map((attempt, index) => {
          const previous = attempts[index - 1];
          const changed = previous ? routeChanged(previous, attempt) : false;
          return (
            <li
              key={`${attempt.number}:${attempt.threadId}`}
              className="rounded-md bg-muted/25 p-2.5"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold">{attempt.number}차 시도</span>
                <Badge size="sm" variant={attemptStatusVariant(attempt.status)}>
                  {ATTEMPT_STATUS_LABELS[attempt.status]}
                </Badge>
                <Badge size="sm" variant="info">
                  {AGENT_LABELS[attempt.agent]}
                </Badge>
                {changed ? (
                  <Badge size="sm" variant="warning">
                    실행 경로 변경
                  </Badge>
                ) : null}
                {attempt.failureClassification ? (
                  <Badge size="sm" variant="error">
                    {FAILURE_LABELS[attempt.failureClassification]}
                  </Badge>
                ) : null}
                {attempt.confidence ? (
                  <Badge size="sm" variant={confidenceVariant(attempt.confidence)}>
                    {CONFIDENCE_LABELS[attempt.confidence]}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                {attempt.modelSelection.instanceId} · {attempt.modelSelection.model}
              </p>
              {attempt.strategy.trim() ? (
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed">
                  <span className="font-medium">실행 전략 · </span>
                  {attempt.strategy}
                </p>
              ) : null}
              {attempt.output ? (
                <div className="mt-2 max-h-36 overflow-auto rounded-md bg-muted/35 p-2 text-xs leading-relaxed">
                  <ChatMarkdown text={attempt.output} cwd={undefined} />
                </div>
              ) : null}
              {attempt.error ? (
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-destructive-foreground">
                  {attempt.error}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span>
                  {formatTimestamp(attempt.startedAt)} → {formatTimestamp(attempt.completedAt)}
                </span>
                {onOpenThread ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onOpenThread({ threadId: attempt.threadId, node, attempt })}
                  >
                    대화 열기
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function NodeResult({
  node,
  attempt,
}: {
  node: WorkspaceTaskNode;
  attempt: WorkspaceTaskAttempt | null;
}) {
  const output = node.output ?? attempt?.output ?? null;
  const error = node.error ?? attempt?.error ?? null;
  if (output === null && error === null) return null;

  return (
    <details className="rounded-lg border border-border/55 bg-background/40">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold marker:hidden">
        <ListChecksIcon className="size-3.5 text-muted-foreground" aria-hidden />
        결과와 오류
      </summary>
      <div className="grid gap-2 border-t border-border/50 p-2.5">
        {output ? (
          <div className="max-h-64 overflow-auto rounded-md bg-muted/30 p-2 text-xs leading-relaxed">
            <ChatMarkdown text={output} cwd={undefined} />
          </div>
        ) : null}
        {error ? (
          <p className="whitespace-pre-wrap rounded-md bg-destructive/6 p-2 text-xs leading-relaxed text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function TaskNodeCard({
  node,
  idPrefix,
  laneIndex,
  laneCount,
  unresolved,
  layout,
  onOpenThread,
}: {
  node: WorkspaceTaskNode;
  idPrefix: string;
  laneIndex: number;
  laneCount: number;
  unresolved: boolean;
  layout: WorkspaceTaskGraphLayout;
  onOpenThread?:
    | ((input: {
        readonly threadId: ThreadId;
        readonly node: WorkspaceTaskNode;
        readonly attempt: WorkspaceTaskAttempt;
      }) => void)
    | undefined;
}) {
  const attempt = latestAttempt(node);
  const confidence = node.validation?.confidence ?? node.confidence ?? attempt?.confidence ?? null;
  const failureClassification =
    node.validation?.failureClassification ??
    node.failureClassification ??
    attempt?.failureClassification ??
    null;
  const titleId = `${idPrefix}-workspace-task-node-${String(node.id).replaceAll(
    /[^A-Za-z0-9_-]/g,
    "-",
  )}`;

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        "grid gap-3 rounded-xl border bg-card/65 p-3 shadow-xs",
        unresolved
          ? "border-destructive/45"
          : node.status === "running"
            ? "border-info/45"
            : node.status === "failed"
              ? "border-destructive/45"
              : "border-border/65",
      )}
    >
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {laneCount > 1 ? (
            <Badge size="sm" variant="outline">
              병렬 경로 {laneIndex + 1}
            </Badge>
          ) : null}
          <Badge size="sm" variant="outline">
            {NODE_KIND_LABELS[node.kind]}
          </Badge>
          <Badge size="sm" variant={nodeStatusVariant(node.status)}>
            {NODE_STATUS_LABELS[node.status]}
          </Badge>
          {confidence ? (
            <Badge size="sm" variant={confidenceVariant(confidence)}>
              {CONFIDENCE_LABELS[confidence]}
            </Badge>
          ) : null}
          {failureClassification ? (
            <Badge size="sm" variant="error">
              {FAILURE_LABELS[failureClassification]}
            </Badge>
          ) : null}
        </div>
        <div>
          <h4 id={titleId} className="text-sm font-semibold leading-snug">
            {node.title}
          </h4>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {node.handoff.goal || node.handoff.task}
          </p>
        </div>
      </header>

      <NodeDependencies node={node} layout={layout} />
      <CurrentAssignment node={node} attempt={attempt} />
      <ValidationReceipt node={node} />
      <NodeResult node={node} attempt={attempt} />
      <AttemptHistory node={node} onOpenThread={onOpenThread} />

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/45 pt-2 text-[10px] text-muted-foreground">
        <span>최대 시도 {node.maxAttempts}회</span>
        <span>
          {formatTimestamp(node.startedAt)} → {formatTimestamp(node.completedAt)}
        </span>
      </footer>
    </article>
  );
}

function StructuralIssueBanner({ layout }: { layout: WorkspaceTaskGraphLayout }) {
  if (!layout.hasStructuralIssues) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-destructive/35 bg-destructive/6 p-3 text-xs text-destructive-foreground"
    >
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>
        <p className="font-semibold">그래프 구조의 일부를 안전하게 분리했습니다.</p>
        <p className="mt-1 leading-relaxed">
          중복 노드 {layout.duplicateNodeIds.length}개 · 찾을 수 없는 선행 작업{" "}
          {layout.missingDependencies.length}개 · 순환 또는 해결 불가 노드{" "}
          {layout.unresolvedNodeIds.length}개
        </p>
      </div>
    </div>
  );
}

function GraphChangeHistory({
  graph,
  layout,
}: {
  graph: WorkspaceTaskGraph;
  layout: WorkspaceTaskGraphLayout;
}) {
  if (graph.changes.length === 0) return null;
  const changes = graph.changes.slice().sort((left, right) => right.revision - left.revision);
  return (
    <details className="rounded-xl border border-border/60 bg-card/45">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold marker:hidden">
        <RouteIcon className="size-4 text-muted-foreground" aria-hidden />
        그래프 변경 이력
        <Badge className="ml-auto" size="sm" variant="outline">
          {changes.length}건
        </Badge>
      </summary>
      <ol className="grid gap-2 border-t border-border/50 p-3">
        {changes.map((change) => (
          <li
            key={`${change.revision}:${change.occurredAt}`}
            className="rounded-lg bg-muted/25 p-3"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge size="sm" variant="outline">
                개정 {change.revision}
              </Badge>
              <Badge size="sm" variant="warning">
                {CHANGE_REASON_LABELS[change.reason]}
              </Badge>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {formatTimestamp(change.occurredAt)}
              </span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed">{change.summary}</p>
            {change.addedNodeIds.length > 0 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                추가 · {change.addedNodeIds.map((id) => nodeTitle(layout, String(id))).join(", ")}
              </p>
            ) : null}
            {change.supersededNodeIds.length > 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                대체됨 ·{" "}
                {change.supersededNodeIds.map((id) => nodeTitle(layout, String(id))).join(", ")}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function MemoryCandidates({
  graph,
  layout,
}: {
  graph: WorkspaceTaskGraph;
  layout: WorkspaceTaskGraphLayout;
}) {
  if (graph.memoryCandidates.length === 0) return null;
  return (
    <details className="rounded-xl border border-border/60 bg-card/45">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold marker:hidden">
        <DatabaseIcon className="size-4 text-muted-foreground" aria-hidden />
        장기 재사용 기억 후보
        <Badge className="ml-auto" size="sm" variant="outline">
          {graph.memoryCandidates.length}개
        </Badge>
      </summary>
      <div className="grid gap-2 border-t border-border/50 p-3 md:grid-cols-2">
        {graph.memoryCandidates.map((candidate, index) => (
          <article key={`${index}:${candidate.title}`} className="rounded-lg bg-muted/25 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge size="sm" variant="outline">
                {MEMORY_CATEGORY_LABELS[candidate.category]}
              </Badge>
              <Badge size="sm" variant={confidenceVariant(candidate.confidence)}>
                {CONFIDENCE_LABELS[candidate.confidence]}
              </Badge>
            </div>
            <h4 className="mt-2 text-sm font-semibold">{candidate.title}</h4>
            <p className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {candidate.content}
            </p>
            {candidate.sourceNodeIds.length > 0 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                근거 작업 ·{" "}
                {candidate.sourceNodeIds.map((id) => nodeTitle(layout, String(id))).join(", ")}
              </p>
            ) : null}
            {candidate.tags.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {candidate.tags.map((tag) => (
                  <Badge key={tag} size="sm" variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </details>
  );
}

export interface WorkspaceTaskGraphViewProps {
  readonly graph: WorkspaceTaskGraph;
  readonly className?: string | undefined;
  readonly onOpenThread?:
    | ((input: {
        readonly threadId: ThreadId;
        readonly node: WorkspaceTaskNode;
        readonly attempt: WorkspaceTaskAttempt;
      }) => void)
    | undefined;
}

/** Static, read-only Workspace task graph shared by web and desktop. */
export function WorkspaceTaskGraphView({
  graph,
  className,
  onOpenThread,
}: WorkspaceTaskGraphViewProps) {
  const headingId = useId();
  const layout = useMemo(() => layoutWorkspaceTaskGraph(graph.nodes), [graph.nodes]);
  const counts = useMemo(() => {
    let active = 0;
    let completed = 0;
    let failedOrBlocked = 0;
    let waiting = 0;
    for (const node of layout.nodeById.values()) {
      if (node.status === "running" || node.status === "awaiting-validation") active += 1;
      else if (node.status === "completed") completed += 1;
      else if (node.status === "failed" || node.status === "blocked") failedOrBlocked += 1;
      else waiting += 1;
    }
    return { active, completed, failedOrBlocked, waiting, total: layout.nodeById.size };
  }, [layout]);

  return (
    <section aria-labelledby={headingId} className={cn("grid gap-4", className)}>
      <header className="grid gap-3 rounded-xl border border-border/65 bg-card/55 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
            <GitBranchIcon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 id={headingId} className="mr-1 text-base font-semibold">
                작업 의존성 그래프
              </h3>
              <Badge size="sm" variant={graphStatusVariant(graph.status)}>
                {GRAPH_STATUS_LABELS[graph.status]}
              </Badge>
              <Badge size="sm" variant="outline">
                개정 {graph.revision}
              </Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              왼쪽에서 오른쪽으로 선행 작업이 완료되며, 같은 열의 작업은 서로 독립적으로 병렬 실행할
              수 있습니다.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">전체 {counts.total}</Badge>
            <Badge variant="info">진행 {counts.active}</Badge>
            <Badge variant="success">완료 {counts.completed}</Badge>
            <Badge variant="warning">대기 {counts.waiting}</Badge>
            <Badge variant={counts.failedOrBlocked > 0 ? "error" : "outline"}>
              실패·차단 {counts.failedOrBlocked}
            </Badge>
          </div>
        </div>
        <div className="flex items-start gap-2 rounded-lg bg-muted/30 px-3 py-2.5">
          <CircleDotIcon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
          <p className="text-xs leading-relaxed">
            <span className="font-semibold">다음 행동 · </span>
            {graph.nextAction.trim() || "다음 행동을 결정하는 중입니다."}
          </p>
        </div>
      </header>

      <StructuralIssueBanner layout={layout} />

      {layout.columns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-10 text-center">
          <CheckCircle2Icon className="mx-auto size-6 text-muted-foreground/60" aria-hidden />
          <p className="mt-2 text-sm font-medium">표시할 작업 노드가 없습니다.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            총괄 에이전트가 작업 그래프를 만드는 중입니다.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto pb-2" aria-label="작업 그래프 열">
          <div className="flex min-w-max items-start gap-3">
            {layout.columns.map((column, columnIndex) => (
              <div key={`${column.depth}:${column.unresolved}`} className="flex items-start gap-3">
                {columnIndex > 0 ? (
                  <span className="mt-12 flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground">
                    <ArrowRightIcon className="size-3.5" aria-hidden />
                    <span className="sr-only">다음 의존성 단계</span>
                  </span>
                ) : null}
                <section
                  aria-label={
                    column.unresolved ? "구조 확인 필요" : `의존성 단계 ${column.depth + 1}`
                  }
                  className="grid w-[20rem] shrink-0 gap-2.5"
                >
                  <header className="flex items-center gap-2 px-1">
                    {column.unresolved ? (
                      <AlertTriangleIcon className="size-3.5 text-destructive" aria-hidden />
                    ) : (
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary/8 font-mono text-[10px] font-semibold text-primary">
                        {column.depth + 1}
                      </span>
                    )}
                    <h4 className="text-xs font-semibold">
                      {column.unresolved ? "구조 확인 필요" : `${column.depth + 1}단계`}
                    </h4>
                    <Badge
                      className="ml-auto"
                      size="sm"
                      variant={column.unresolved ? "error" : "outline"}
                    >
                      {column.unresolved
                        ? `노드 ${column.nodes.length}개`
                        : column.nodes.length > 1
                          ? `병렬 ${column.nodes.length}개`
                          : "단일 작업"}
                    </Badge>
                  </header>
                  {column.nodes.map((node, laneIndex) => (
                    <TaskNodeCard
                      key={String(node.id)}
                      node={node}
                      idPrefix={headingId}
                      laneIndex={laneIndex}
                      laneCount={column.nodes.length}
                      unresolved={column.unresolved}
                      layout={layout}
                      onOpenThread={onOpenThread}
                    />
                  ))}
                </section>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-2">
        <GraphChangeHistory graph={graph} layout={layout} />
        <MemoryCandidates graph={graph} layout={layout} />
      </div>
    </section>
  );
}
