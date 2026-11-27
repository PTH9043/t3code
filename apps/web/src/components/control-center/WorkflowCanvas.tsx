import { useMemo } from "react";
import {
  extractForwardEdges,
  extractLoopBackEdges,
  resolveCanonicalWorkflowGraphV2,
  type CapabilityProfile,
  type WorkflowDefinition,
  type WorkflowEdgeV2,
  type WorkflowGraphV2Draft,
  type WorkflowNodeV2,
} from "@t3tools/contracts";
import { lintWorkflowGraphV2, type WorkflowLintSeverity } from "@t3tools/shared/workflow";

const NODE_KIND_META: Record<
  WorkflowNodeV2["kind"],
  { readonly label: string; readonly accent: string; readonly badgeBg: string }
> = {
  agent: {
    label: "에이전트",
    accent: "var(--color-primary, currentColor)",
    badgeBg: "color-mix(in srgb, var(--color-primary, currentColor) 14%, transparent)",
  },
  verifier: {
    label: "검증기",
    accent: "#16a34a",
    badgeBg: "rgba(22, 163, 74, 0.14)",
  },
  router: {
    label: "라우터",
    accent: "#d97706",
    badgeBg: "rgba(217, 119, 6, 0.14)",
  },
  human_gate: {
    label: "승인 게이트",
    accent: "#9333ea",
    badgeBg: "rgba(147, 51, 234, 0.14)",
  },
  map_fanout: {
    label: "병렬 팬아웃",
    accent: "#0284c7",
    badgeBg: "rgba(2, 132, 199, 0.14)",
  },
  reconcile_worktrees: {
    label: "워크트리 병합",
    accent: "#0d9488",
    badgeBg: "rgba(13, 148, 136, 0.14)",
  },
  subworkflow: {
    label: "하위 워크플로",
    accent: "#4f46e5",
    badgeBg: "rgba(79, 70, 229, 0.14)",
  },
};

const CAPABILITY_LABELS: Record<CapabilityProfile, string> = {
  "deep-architect": "설계",
  "code-surgeon": "구현",
  "fast-scout": "탐색",
  "adversarial-reviewer": "검토",
  "local-zero-cost": "로컬",
  custom: "커스텀",
};

const SEVERITY_STYLE: Record<WorkflowLintSeverity, string> = {
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  info: "border-border bg-muted/40 text-muted-foreground",
};

const SEVERITY_LABEL: Record<WorkflowLintSeverity, string> = {
  error: "오류",
  warning: "경고",
  info: "안내",
};

function describeNodeSubtitle(node: WorkflowNodeV2): string {
  switch (node.kind) {
    case "agent": {
      const role = node.participantId ? "지정 참가자" : CAPABILITY_LABELS[node.capability];
      return `${node.id} · ${role} · ${node.isolation === "git_worktree" ? "worktree" : node.isolation === "shared_readonly" ? "ro" : "rw"}`;
    }
    case "verifier":
      return `${node.id} · ${node.verifier.type}`;
    case "router":
      return `${node.id} · ${node.routes.length}개 경로 (${node.mode === "deterministic_rules" ? "규칙" : "분류"})`;
    case "human_gate":
      return `${node.id} · ${node.allowedActions.join("/")}`;
    case "map_fanout":
      return `${node.id} · max ${node.maxFanOut} / 동시 ${node.concurrencyLimit}`;
    case "reconcile_worktrees":
      return `${node.id} · ${node.strategy === "git_merge_tree_strict" ? "strict" : "assisted"}`;
    case "subworkflow":
      return `${node.id} · ${node.targetDefinitionId}@v${node.pinnedRevision}`;
  }
}

function edgeLabel(edge: WorkflowEdgeV2, loopMaxById: ReadonlyMap<string, number>): string | null {
  if (edge.kind === "route_match" && edge.routeKey) return edge.routeKey;
  if (edge.kind === "conditional" && edge.conditionExpr) return edge.conditionExpr.slice(0, 24);
  if (edge.kind === "loop_back") {
    const max = edge.loopId ? loopMaxById.get(edge.loopId) : undefined;
    return max !== undefined ? `루프 ≤${max}` : "루프";
  }
  return null;
}

const NODE_WIDTH = 228;
const NODE_HEIGHT = 82;

export default function WorkflowCanvas({
  definition,
  graph: explicitGraph,
  selectedId,
  onSelect,
  disabled = false,
}: {
  definition: WorkflowDefinition;
  graph?: WorkflowGraphV2Draft;
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const canonicalGraph = useMemo<WorkflowGraphV2Draft>(
    () => explicitGraph ?? resolveCanonicalWorkflowGraphV2(definition),
    [explicitGraph, definition],
  );

  const lint = useMemo(() => lintWorkflowGraphV2(canonicalGraph), [canonicalGraph]);

  const layout = useMemo(() => {
    const forwardEdges = extractForwardEdges(canonicalGraph);
    const loopBackEdges = extractLoopBackEdges(canonicalGraph);
    const parentsByNode = new Map<string, string[]>();
    for (const node of canonicalGraph.nodes) {
      parentsByNode.set(node.id, []);
    }
    for (const edge of forwardEdges) {
      parentsByNode.get(edge.to)?.push(edge.from);
    }

    const levels = new Map<string, number>();
    const remaining = new Set<string>(canonicalGraph.nodes.map((node) => node.id));
    while (remaining.size > 0) {
      const ready = canonicalGraph.nodes.filter(
        (node) =>
          remaining.has(node.id) &&
          (parentsByNode.get(node.id) ?? []).every((parentId) => !remaining.has(parentId)),
      );
      if (ready.length === 0) break;
      for (const node of ready) {
        const parents = parentsByNode.get(node.id) ?? [];
        levels.set(
          node.id,
          Math.max(0, ...parents.map((parentId) => (levels.get(parentId) ?? -1) + 1)),
        );
        remaining.delete(node.id);
      }
    }

    const rows = new Map<number, number>();
    const positionedNodes = canonicalGraph.nodes.map((node) => {
      const level = levels.get(node.id) ?? 0;
      const row = rows.get(level) ?? 0;
      rows.set(level, row + 1);
      return {
        node,
        x: 24 + level * (NODE_WIDTH + 48),
        y: 28 + row * (NODE_HEIGHT + 34),
      };
    });

    const byId = new Map(positionedNodes.map((entry) => [entry.node.id, entry]));
    const hasLoopBack = loopBackEdges.length > 0;
    const width = Math.max(540, ...positionedNodes.map((entry) => entry.x + NODE_WIDTH + 32));
    const height = Math.max(
      180,
      ...positionedNodes.map((entry) => entry.y + NODE_HEIGHT + (hasLoopBack ? 64 : 32)),
    );
    const loopMaxById = new Map<string, number>(
      canonicalGraph.loops.map((loop) => [loop.loopId, loop.maxIterations]),
    );

    return {
      nodes: positionedNodes,
      byId,
      forwardEdges,
      loopBackEdges,
      loopMaxById,
      width,
      height,
    };
  }, [canonicalGraph]);

  return (
    <div className="grid gap-2" aria-label="워크플로 연결 캔버스">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          그래프 v2 · 노드 {canonicalGraph.nodes.length}개 · 엣지 {canonicalGraph.edges.length}개
          {canonicalGraph.loops.length > 0 ? ` · 루프 ${canonicalGraph.loops.length}개` : ""}
        </span>
        <span>
          정적 검사: 오류 {lint.errorCount} · 경고 {lint.warningCount} · 안내 {lint.infoCount}
        </span>
      </div>
      <div className="overflow-auto rounded-xl border bg-muted/10">
        <svg
          width={layout.width}
          height={layout.height}
          role="group"
          aria-label="단계를 선택하면 같은 단계 폼에서 수정합니다."
        >
          {layout.forwardEdges.map((edge) => {
            const from = layout.byId.get(edge.from);
            const to = layout.byId.get(edge.to);
            if (!from || !to) return null;
            const startX = from.x + NODE_WIDTH;
            const startY = from.y + NODE_HEIGHT / 2;
            const endX = to.x;
            const endY = to.y + NODE_HEIGHT / 2;
            const midX = (startX + endX) / 2;
            const midY = (startY + endY) / 2;
            const label = edgeLabel(edge, layout.loopMaxById);
            const isDashed = edge.kind === "conditional" || edge.kind === "route_match";
            return (
              <g key={edge.id}>
                <path
                  d={`M${startX},${startY} C${startX + 34},${startY} ${endX - 34},${endY} ${endX},${endY}`}
                  fill="none"
                  stroke={isDashed ? "#d97706" : "currentColor"}
                  strokeWidth={isDashed ? 1.5 : 1.25}
                  strokeDasharray={isDashed ? "5 4" : undefined}
                  opacity={isDashed ? 0.85 : 0.45}
                />
                {label ? (
                  <text x={midX} y={midY - 6} textAnchor="middle" fill="#d97706" fontSize={10}>
                    {label}
                  </text>
                ) : null}
              </g>
            );
          })}

          {layout.loopBackEdges.map((edge, idx) => {
            const from = layout.byId.get(edge.from);
            const to = layout.byId.get(edge.to);
            if (!from || !to) return null;
            const startX = from.x + NODE_WIDTH / 2;
            const startY = from.y + NODE_HEIGHT;
            const endX = to.x + NODE_WIDTH / 2;
            const endY = to.y + NODE_HEIGHT;
            const arcY = Math.max(startY, endY) + 32 + idx * 14;
            const label = edgeLabel(edge, layout.loopMaxById);
            return (
              <g key={edge.id}>
                <path
                  d={`M${startX},${startY} C${startX},${arcY} ${endX},${arcY} ${endX},${endY}`}
                  fill="none"
                  stroke="#e11d48"
                  strokeWidth={1.6}
                  strokeDasharray="4 3"
                  opacity={0.85}
                />
                {label ? (
                  <text
                    x={(startX + endX) / 2}
                    y={arcY - 4}
                    textAnchor="middle"
                    fill="#e11d48"
                    fontSize={10}
                  >
                    {label}
                  </text>
                ) : null}
              </g>
            );
          })}

          {layout.nodes.map(({ node, x, y }) => {
            const meta = NODE_KIND_META[node.kind];
            const subtitle = describeNodeSubtitle(node);
            const selected = node.id === selectedId;
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-label={`${node.title}, ${meta.label}`}
                aria-pressed={selected}
                aria-disabled={disabled}
                onClick={() => {
                  if (!disabled) onSelect(node.id);
                }}
                onKeyDown={(event) => {
                  if (disabled) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
                className={
                  disabled ? "text-foreground opacity-60" : "cursor-pointer text-foreground"
                }
              >
                <rect
                  x={x}
                  y={y}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={10}
                  fill="var(--color-card)"
                  stroke={selected ? meta.accent : "currentColor"}
                  strokeWidth={selected ? 2.2 : 1}
                  strokeOpacity={selected ? 1 : 0.35}
                />
                <rect x={x + 10} y={y + 9} width={76} height={18} rx={5} fill={meta.badgeBg} />
                <text x={x + 16} y={y + 21} fill={meta.accent} fontSize={10} fontWeight={600}>
                  {meta.label}
                </text>
                <text x={x + 12} y={y + 44} fill="currentColor" fontSize={12} fontWeight={500}>
                  {node.title.slice(0, 22)}
                </text>
                <text x={x + 12} y={y + 66} fill="currentColor" opacity="0.65" fontSize={10.5}>
                  {subtitle.slice(0, 30)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {lint.diagnostics.length > 0 ? (
        <div
          className="grid gap-1.5 rounded-xl border bg-background/60 p-2.5 text-xs"
          aria-label="워크플로 정적 린터 결과"
        >
          <p className="font-medium">정적 린터 진단 ({lint.diagnostics.length}건)</p>
          {lint.diagnostics.map((item, idx) => (
            <div
              key={`${item.code}:${item.path}:${idx}`}
              className={`rounded-lg border px-2.5 py-1.5 ${SEVERITY_STYLE[item.severity]}`}
            >
              <span className="font-semibold">[{SEVERITY_LABEL[item.severity]}]</span>{" "}
              <span>{item.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          정적 린터 검사 통과 — 구조·위상·격리 규칙에 문제가 없습니다.
        </p>
      )}
    </div>
  );
}
