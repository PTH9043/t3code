import { useState } from "react";
import { WorkspaceKnowledgeKind, type WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { kindLabels } from "./dashboardPresentation";
import type { BulkCommand, RowSelection } from "./dashboardSelection";

type Action = BulkCommand["operation"]["type"];
const labels = { promote: "승격", archive: "보관", reclassify: "재분류", merge: "병합" } as const;
export function KnowledgeBulkActions({
  selected,
  busy,
  canApply,
  error,
  apply,
  clear,
}: {
  selected: RowSelection;
  busy: boolean;
  canApply: boolean;
  error: string | null;
  apply: (operation: BulkCommand["operation"]) => Promise<boolean>;
  clear: () => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [kind, setKind] = useState<WorkspaceKnowledgeKind | "">("");
  const [target, setTarget] = useState<WorkspaceKnowledgeItemId | null>(null);
  const rows = [...selected.values()];
  const representative = target ? selected.get(target) : null;
  const operation =
    action === "reclassify"
      ? kind
        ? ({ type: action, kind } as const)
        : null
      : action === "merge"
        ? representative && rows.length > 1
          ? ({ type: action, targetId: representative.id } as const)
          : null
        : action
          ? { type: action }
          : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium" aria-live="polite">
        {rows.length}개 선택
      </span>
      {(["promote", "archive", "reclassify", "merge"] as const).map((type) => (
        <Button
          key={type}
          variant="outline"
          size="sm"
          disabled={
            busy ||
            !canApply ||
            !rows.length ||
            (type === "merge" &&
              (rows.length < 2 || rows.some((r) => r.supersededBy || r.status === "superseded"))) ||
            (type === "promote" && rows.some((r) => r.status !== "candidate"))
          }
          onClick={() => {
            setAction(type);
            setKind("");
            setTarget(null);
          }}
        >
          {labels[type]}
        </Button>
      ))}
      <Button variant="ghost" size="sm" disabled={busy || !rows.length} onClick={clear}>
        선택 해제
      </Button>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
      >
        {action && (
          <DialogPopup showCloseButton={!busy}>
            <DialogHeader>
              <DialogTitle>선택 문서 {labels[action]}</DialogTitle>
              <DialogDescription>
                {action === "merge"
                  ? "대표 문서를 직접 선택하세요. 다른 문서는 원문을 보존하고 대표 문서에 연결합니다."
                  : `선택한 문서 ${rows.length}개에 적용합니다.`}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <fieldset disabled={busy} className="space-y-3">
                {action === "reclassify" && (
                  <label className="grid gap-1 text-sm">
                    새 종류
                    <select
                      className="rounded border bg-background p-2"
                      value={kind}
                      onChange={(e) =>
                        setKind(
                          WorkspaceKnowledgeKind.literals.find((k) => k === e.target.value) ?? "",
                        )
                      }
                    >
                      <option value="">종류 선택</option>
                      {WorkspaceKnowledgeKind.literals.map((k) => (
                        <option key={k} value={k}>
                          {kindLabels[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <ul className="max-h-60 space-y-1 overflow-auto text-sm">
                  {rows.map((r) => (
                    <li key={r.id}>
                      {action === "merge" ? (
                        <label className="flex items-baseline gap-2 py-1">
                          <input
                            type="radio"
                            name="knowledge-representative"
                            value={r.id}
                            checked={target === r.id}
                            onChange={() => setTarget(r.id)}
                          />
                          <span>
                            {r.title}{" "}
                            <small className="break-all text-muted-foreground">{r.id}</small>
                          </span>
                        </label>
                      ) : (
                        r.title
                      )}
                    </li>
                  ))}
                </ul>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </fieldset>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>
                취소
              </Button>
              <Button
                disabled={busy || !canApply || !operation || !rows.length}
                onClick={async () => {
                  if (operation && (await apply(operation))) setAction(null);
                }}
              >
                {busy ? "적용 중…" : labels[action] + " 적용"}
              </Button>
            </DialogFooter>
          </DialogPopup>
        )}
      </Dialog>
    </div>
  );
}
