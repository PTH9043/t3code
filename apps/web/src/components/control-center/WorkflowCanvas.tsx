import { useMemo } from "react";
import type { WorkflowDefinition } from "@t3tools/contracts";

export default function WorkflowCanvas({
  definition,
  selectedId,
  onSelect,
  disabled = false,
}: {
  definition: WorkflowDefinition;
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const layout = useMemo(() => {
    const levels = new Map<string, number>();
    const remaining = new Set(definition.nodes.map((node) => node.id));
    while (remaining.size) {
      const ready = definition.nodes.filter(
        (node) => remaining.has(node.id) && node.dependsOn.every((id) => !remaining.has(id)),
      );
      if (!ready.length) break;
      for (const node of ready) {
        levels.set(node.id, Math.max(0, ...node.dependsOn.map((id) => (levels.get(id) ?? -1) + 1)));
        remaining.delete(node.id);
      }
    }
    const rows = new Map<number, number>();
    const nodes = definition.nodes.map((node) => {
      const level = levels.get(node.id) ?? 0;
      const row = rows.get(level) ?? 0;
      rows.set(level, row + 1);
      return { ...node, x: 24 + level * 250, y: 24 + row * 110 };
    });
    return {
      nodes,
      width: Math.max(500, ...nodes.map((node) => node.x + 230)),
      height: Math.max(160, ...nodes.map((node) => node.y + 90)),
    };
  }, [definition.nodes]);
  return (
    <div className="overflow-auto rounded-xl border bg-muted/10" aria-label="워크플로 연결 캔버스">
      <svg
        width={layout.width}
        height={layout.height}
        role="group"
        aria-label="단계를 선택하면 같은 단계 폼에서 수정합니다."
      >
        {layout.nodes.flatMap((node) =>
          node.dependsOn.map((id) => {
            const parent = layout.nodes.find((entry) => entry.id === id);
            return parent ? (
              <path
                key={`${id}:${node.id}`}
                d={`M${parent.x + 210},${parent.y + 35} C${parent.x + 240},${parent.y + 35} ${node.x - 30},${node.y + 35} ${node.x},${node.y + 35}`}
                fill="none"
                stroke="currentColor"
                opacity="0.4"
              />
            ) : null;
          }),
        )}
        {layout.nodes.map((node) => (
          <g
            key={node.id}
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={`${node.title}, ${node.agent}`}
            aria-pressed={node.id === selectedId}
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
            className={disabled ? "text-foreground opacity-60" : "cursor-pointer text-foreground"}
          >
            <rect
              x={node.x}
              y={node.y}
              width={210}
              height={72}
              rx={10}
              fill="var(--color-card)"
              stroke="currentColor"
              strokeWidth={node.id === selectedId ? 2 : 1}
            />
            <text x={node.x + 12} y={node.y + 27} fill="currentColor" fontSize={12}>
              {node.title.slice(0, 20)}
            </text>
            <text x={node.x + 12} y={node.y + 51} fill="currentColor" opacity="0.65" fontSize={11}>
              {node.id} · {node.agent}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
