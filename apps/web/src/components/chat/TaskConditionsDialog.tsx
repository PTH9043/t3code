import { useState } from "react";
import {
  ADDITIONAL_TASK_ACTIONS,
  TASK_CONDITION_FIELDS,
  type ApprovedTaskConditions,
} from "@t3tools/contracts";
import { approveTaskConditions, type TaskConditionsDraft } from "../../taskConditions";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function TaskConditionsDialog({
  draft,
  onChange,
  onCancel,
  onApprove,
  workOnlyReason,
}: {
  draft: TaskConditionsDraft;
  onChange: (draft: TaskConditionsDraft) => void;
  onCancel: () => void;
  onApprove: (conditions: ApprovedTaskConditions) => void;
  workOnlyReason?: string;
}) {
  const [reviewed, setReviewed] = useState(false);
  const approved = approveTaskConditions(draft, reviewed);
  const update = (next: TaskConditionsDraft) => {
    setReviewed(false);
    onChange(next);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogPopup className="max-h-[92dvh] max-w-3xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>작업 조건 확인</DialogTitle>
          <DialogDescription>
            아직 AI에 전송하지 않았습니다. 기본 초안을 수정하고 허용 행동을 직접 선택하세요. 제출한
            조건은 이번 요청과 함께 대화에 기록됩니다.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer font-medium">원래 요청 보기</summary>
            <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
              {draft.sourceText || "첨부 자료만 있는 요청"}
            </p>
          </details>
          <div className="grid gap-4 sm:grid-cols-2">
            {TASK_CONDITION_FIELDS.map(([field, label]) => (
              <label
                key={field}
                className={field === "goal" ? "grid gap-1.5 sm:col-span-2" : "grid gap-1.5"}
              >
                <span className="text-sm font-medium">{label}</span>
                <textarea
                  aria-label={label}
                  value={draft[field]}
                  maxLength={8_000}
                  rows={3}
                  className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) => update({ ...draft, [field]: event.target.value })}
                />
              </label>
            ))}
          </div>
          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">허용 행동 — 직접 선택</legend>
            {workOnlyReason ? (
              <p className="text-xs text-muted-foreground">
                {workOnlyReason} 조회 전용 작업은 일반 대화에서 보내세요.
              </p>
            ) : null}
            {[
              [
                "inspect",
                "조회·분석·답변만",
                "파일 수정, 프로그램 실행·종료 없이 결과만 확인합니다.",
              ],
              ["work", "파일 수정·명령 실행 허용", "위에 확정한 대상과 범위 안에서만 작업합니다."],
            ].map(([mode, label, description]) => (
              <label
                key={mode}
                className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-muted/40"
              >
                <input
                  type="radio"
                  name="task-condition-mode"
                  value={mode}
                  disabled={mode === "inspect" && Boolean(workOnlyReason)}
                  checked={draft.mode === mode}
                  onChange={() =>
                    update({
                      ...draft,
                      mode: mode === "inspect" ? "inspect" : "work",
                      additionalActions: [],
                    })
                  }
                  className="mt-1"
                />
                <span className="grid gap-0.5 text-sm">
                  <span>{label}</span>
                  <span className="text-xs text-muted-foreground">{description}</span>
                </span>
              </label>
            ))}
            {draft.mode === "work" ? (
              <div className="grid gap-2 border-t pt-3">
                <span className="text-xs text-muted-foreground">
                  다음 행동은 별도로 선택한 경우에만 허용합니다.
                </span>
                {ADDITIONAL_TASK_ACTIONS.map(([action, label]) => (
                  <label key={action} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.additionalActions.includes(action)}
                      onChange={(event) =>
                        update({
                          ...draft,
                          additionalActions: event.target.checked
                            ? [...draft.additionalActions, action]
                            : draft.additionalActions.filter((entry) => entry !== action),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            ) : null}
          </fieldset>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
              className="mt-1"
            />
            <span>
              목표·범위·기준·허용 행동을 확인했습니다. 이 조건으로 이번 요청을 실행합니다.
            </span>
          </label>
          {TASK_CONDITION_FIELDS.some(([field]) => draft[field].trim().length === 0) ? (
            <p role="alert" className="text-sm text-destructive">
              빈 항목을 채워 주세요. 정하지 않을 내용은 ‘AI에 위임’ 또는 ‘해당 없음’으로 명시하세요.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            취소 · 요청으로 돌아가기
          </Button>
          <Button
            disabled={approved === null}
            onClick={() => {
              if (approved) onApprove(approved);
            }}
          >
            이 조건으로 실행
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
