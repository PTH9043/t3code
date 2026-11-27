import { Fragment, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { KnowledgeDocLink } from "./KnowledgeDocLink";
import { kindLabels, statusLabels, number, type DashboardScope } from "./dashboardPresentation";
import type { DashboardRow, RowSelection } from "./dashboardSelection";

export interface KnowledgeRowGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly DashboardRow[];
}

const CONVERSATION_ITEM_PREFIX_RE = /^(conversation-[0-9a-f]{16})-/i;

export function knowledgeSourceGroupKey(row: DashboardRow): { key: string; label: string } {
  const convMatch = CONVERSATION_ITEM_PREFIX_RE.exec(row.id);
  if (convMatch?.[1]) {
    const normalizedTitle = row.title.replace(/^대화 입력\s*·\s*/, "").trim() || row.title;
    return {
      key: `thread:${convMatch[1]}`,
      label: `대화 출처 · ${normalizedTitle}`,
    };
  }
  const normalizedTitle = row.title.trim();
  if (normalizedTitle.length > 0) {
    return {
      key: `title:${row.kind}:${normalizedTitle.toLowerCase()}`,
      label: normalizedTitle,
    };
  }
  return {
    key: `item:${row.id}`,
    label: row.id,
  };
}

export function groupKnowledgeRowsBySource(
  rows: readonly DashboardRow[],
): ReadonlyArray<KnowledgeRowGroup> {
  const groups = new Map<string, { label: string; items: DashboardRow[] }>();
  const order: string[] = [];
  for (const row of rows) {
    const { key, label } = knowledgeSourceGroupKey(row);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(row);
    } else {
      groups.set(key, { label, items: [row] });
      order.push(key);
    }
  }
  return order.map((key) => {
    const entry = groups.get(key)!;
    return { key, label: entry.label, items: entry.items };
  });
}

export function KnowledgeRows({
  scope,
  rows,
  selected,
  onToggle,
  groupBySource = true,
}: {
  scope: DashboardScope;
  rows: readonly DashboardRow[];
  selected: RowSelection;
  onToggle: (rows: readonly DashboardRow[], include: boolean) => void;
  groupBySource?: boolean;
}) {
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const all = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const seenTitles = new Set<string>();
  const ambiguousTitles = new Set<string>();
  for (const row of rows) {
    if (seenTitles.has(row.title)) ambiguousTitles.add(row.title);
    seenTitles.add(row.title);
  }
  const groups = useMemo(
    () => (groupBySource ? groupKnowledgeRowsBySource(rows) : null),
    [groupBySource, rows],
  );
  const toggleGroupExpanded = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const renderRow = (row: DashboardRow, indented = false) => (
    <tr key={row.id} className={indented ? "bg-muted/20" : undefined}>
      <td className="p-2">
        <input
          type="checkbox"
          aria-label={`${row.title} (${row.id}) 선택`}
          checked={selected.has(row.id)}
          onChange={(e) => onToggle([row], e.target.checked)}
        />
      </td>
      <td className={indented ? "min-w-32 py-2 pl-6 pr-3" : "min-w-32 py-2 pr-3"}>
        <KnowledgeDocLink {...scope} itemId={row.id}>
          {row.title}
        </KnowledgeDocLink>
        {(indented || ambiguousTitles.has(row.title)) && (
          <small className="block break-all text-muted-foreground">{row.id}</small>
        )}
        {row.supersededBy && (
          <small className="ml-2">
            <KnowledgeDocLink {...scope} itemId={row.supersededBy}>
              대표 문서
            </KnowledgeDocLink>
          </small>
        )}
      </td>
      <td className="whitespace-nowrap pr-2 text-xs">{kindLabels[row.kind]}</td>
      <td className="whitespace-nowrap pr-2 text-xs">{statusLabels[row.status]}</td>
      <td className="text-right tabular-nums">{number.format(row.promptUses)}</td>
    </tr>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b text-xs text-muted-foreground">
          <tr>
            <th className="w-9 p-2">
              <input
                type="checkbox"
                aria-label="이 페이지 문서 전체 선택"
                ref={(node) => {
                  if (node) node.indeterminate = !all && rows.some((row) => selected.has(row.id));
                }}
                checked={all}
                disabled={!rows.length}
                onChange={(e) => onToggle(rows, e.target.checked)}
              />
            </th>
            <th scope="col" className="py-2">
              문서
            </th>
            <th scope="col">종류</th>
            <th scope="col">상태</th>
            <th scope="col" className="text-right">
              사용 횟수
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {groups
            ? groups.map((group) => {
                if (group.items.length === 1) {
                  return renderRow(group.items[0]!);
                }
                const isExpanded = expandedGroups.has(group.key);
                const allGroupSelected = group.items.every((item) => selected.has(item.id));
                const someGroupSelected =
                  !allGroupSelected && group.items.some((item) => selected.has(item.id));
                const totalUses = group.items.reduce((sum, item) => sum + item.promptUses, 0);
                const lead = group.items[0]!;
                return (
                  <Fragment key={group.key}>
                    <tr className="bg-muted/10">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={`${group.label} 묶음 ${group.items.length}개 전체 선택`}
                          ref={(node) => {
                            if (node) node.indeterminate = someGroupSelected;
                          }}
                          checked={allGroupSelected}
                          onChange={(e) => onToggle(group.items, e.target.checked)}
                        />
                      </td>
                      <td className="min-w-32 py-2 pr-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            onClick={() => toggleGroupExpanded(group.key)}
                            className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-left font-medium text-foreground hover:bg-accent"
                          >
                            {isExpanded ? (
                              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span>{group.label}</span>
                          </button>
                          <span className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                            {number.format(group.items.length)}개 묶음
                          </span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap pr-2 text-xs">{kindLabels[lead.kind]}</td>
                      <td className="whitespace-nowrap pr-2 text-xs">
                        {statusLabels[lead.status]}
                      </td>
                      <td className="text-right tabular-nums">{number.format(totalUses)}</td>
                    </tr>
                    {isExpanded && group.items.map((item) => renderRow(item, true))}
                  </Fragment>
                );
              })
            : rows.map((row) => renderRow(row))}
        </tbody>
      </table>
    </div>
  );
}
