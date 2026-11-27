import { useState } from "react";
import {
  WorkspaceKnowledgeKind,
  WorkspaceKnowledgeOrigin,
  WorkspaceKnowledgeStatus,
  type WorkspaceKnowledgeDashboard,
} from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { kindLabels, statusLabels } from "./dashboardPresentation";
import type { SearchFilters } from "./dashboardSelection";

export type SavedSearch = WorkspaceKnowledgeDashboard["savedSearches"][number];
const originLabels: Record<WorkspaceKnowledgeOrigin, string> = {
  user: "내 대화·지시",
  agent: "AI 작성·조사",
  imported: "가져온 원본",
};
const selectClass = "h-8 rounded border border-input bg-background px-2 text-xs";
export function KnowledgeSearch({
  filters,
  apply,
  saved,
  onSave,
  onRemove,
  busy,
}: {
  filters: SearchFilters;
  apply: (filters: SearchFilters) => void;
  saved: readonly SavedSearch[];
  onSave: (name: string, filters: SearchFilters, previous: SavedSearch | null) => Promise<boolean>;
  onRemove: (previous: SavedSearch) => Promise<boolean>;
  busy: boolean;
}) {
  const [text, setText] = useState(filters.query ?? "");
  const [kind, setKind] = useState(filters.kind ?? "");
  const [origin, setOrigin] = useState(filters.origin ?? "");
  const [status, setStatus] = useState(filters.status ?? "");
  const [usage, setUsage] = useState(filters.usage ?? "");
  const [hash, setHash] = useState(filters.contentHash);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<SavedSearch | null>(null);
  const [remove, setRemove] = useState(false);
  function conditions(): SearchFilters {
    const k = WorkspaceKnowledgeKind.literals.find((v) => v === kind);
    const o = WorkspaceKnowledgeOrigin.literals.find((v) => v === origin);
    const s = WorkspaceKnowledgeStatus.literals.find((v) => v === status);
    return {
      ...(text.trim() ? { query: text.trim() } : {}),
      ...(k ? { kind: k } : {}),
      ...(o ? { origin: o } : {}),
      ...(s ? { status: s } : {}),
      ...(usage === "used" || usage === "unused" ? { usage } : {}),
      ...(hash ? { contentHash: hash } : {}),
    };
  }
  function load(search: SavedSearch | null) {
    const f = search?.filters ?? {};
    setEditing(search);
    setName(search?.name ?? "");
    setRemove(false);
    setText(f.query ?? "");
    setKind(f.kind ?? "");
    setOrigin(f.origin ?? "");
    setStatus(f.status ?? "");
    setUsage(f.usage ?? "");
    setHash(f.contentHash);
    apply(f);
  }
  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          apply(conditions());
        }}
      >
        <label className="min-w-40 flex-1 text-xs">
          검색어
          <Input type="search" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="grid text-xs">
          종류
          <select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">전체</option>
            {WorkspaceKnowledgeKind.literals.map((v) => (
              <option key={v} value={v}>
                {kindLabels[v]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid text-xs">
          출처 구분
          <select
            className={selectClass}
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          >
            <option value="">전체</option>
            {WorkspaceKnowledgeOrigin.literals.map((v) => (
              <option key={v} value={v}>
                {originLabels[v]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid text-xs">
          상태
          <select
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">전체</option>
            {WorkspaceKnowledgeStatus.literals.map((v) => (
              <option key={v} value={v}>
                {statusLabels[v]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid text-xs">
          사용 여부
          <select className={selectClass} value={usage} onChange={(e) => setUsage(e.target.value)}>
            <option value="">전체</option>
            <option value="used">사용됨</option>
            <option value="unused">미사용</option>
          </select>
        </label>
        {hash && (
          <span className="break-all rounded border px-2 py-1 text-xs" title={hash}>
            중복 묶음 · {hash.slice(0, 12)}{" "}
            <button
              type="button"
              aria-label="중복 묶음 필터 해제"
              onClick={() => {
                setHash(undefined);
                const { contentHash: _hash, ...rest } = conditions();
                apply(rest);
              }}
            >
              ×
            </button>
          </span>
        )}
        <Button type="submit" size="sm">
          검색
        </Button>
        <Button variant="ghost" size="sm" onClick={() => load(null)}>
          초기화
        </Button>
      </form>
      <details className="rounded border border-border px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">
          프로젝트 저장 검색 ({saved.length})
        </summary>
        <fieldset disabled={busy} className="mt-2 flex flex-wrap items-end gap-2">
          <label className="grid">
            저장된 조건
            <select
              className={selectClass}
              value={editing?.id ?? ""}
              onChange={(e) => load(saved.find((s) => s.id === e.target.value) ?? null)}
            >
              <option value="">새 검색</option>
              {saved.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-36">
            검색 이름
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!name.trim()}
            onClick={async () => {
              const f = conditions();
              if (await onSave(name.trim(), f, editing)) {
                apply(f);
                setEditing(null);
                setName("");
              }
            }}
          >
            {editing ? "변경 저장" : "검색 저장"}
          </Button>
          {editing &&
            (remove ? (
              <>
                <span>‘{editing.name}’ 삭제할까요?</span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={async () => {
                    if (await onRemove(editing)) load(null);
                  }}
                >
                  삭제 확인
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRemove(false)}>
                  취소
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setRemove(true)}>
                삭제
              </Button>
            ))}
        </fieldset>
      </details>
    </div>
  );
}
