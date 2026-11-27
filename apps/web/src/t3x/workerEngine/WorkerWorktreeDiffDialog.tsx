import type { WorkerTaskRecord, WorkerWorktreeDiffResult } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitMergeIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";

import {
  discardWorkerWorktree,
  getWorkerWorktreeDiff,
  mergeWorkerWorktree,
  type WorkerEngineRequestContext,
} from "./workerEngineClient";
import { classifyDiffPatch, WORKER_WORKTREE_STATE_META } from "./workerEngineUi.logic";

export interface WorkerWorktreeDiffDialogProps {
  readonly task: WorkerTaskRecord | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly requestContext: WorkerEngineRequestContext;
  readonly onMutated: () => void;
}

export function WorkerWorktreeDiffDialog({
  task,
  open,
  onOpenChange,
  requestContext,
  onMutated,
}: WorkerWorktreeDiffDialogProps) {
  const [diff, setDiff] = useState<WorkerWorktreeDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"merge" | "discard" | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadDiff = useCallback(async () => {
    if (!task) return;
    setLoading(true);
    setError(null);
    try {
      const next = await getWorkerWorktreeDiff(task.taskId, requestContext);
      setDiff(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [requestContext, task]);

  useEffect(() => {
    if (!open || !task) return;
    setDiff(null);
    void loadDiff();
  }, [loadDiff, open, task]);

  const classified = useMemo(() => classifyDiffPatch(diff?.diffPatch ?? ""), [diff?.diffPatch]);

  const worktreeState = diff?.worktreeState ?? task?.worktreeState ?? "none";
  const stateMeta = WORKER_WORKTREE_STATE_META[worktreeState];
  const canMutate = worktreeState === "review_ready" || worktreeState === "active";

  const handleConfirmAction = useCallback(async () => {
    if (!task || !confirmAction) return;
    setSubmitting(true);
    try {
      const result =
        confirmAction === "merge"
          ? await mergeWorkerWorktree(task.taskId, requestContext)
          : await discardWorkerWorktree(task.taskId, requestContext);
      toastManager.add({
        type: "success",
        title:
          confirmAction === "merge"
            ? "Worktree 변경 사항을 병합했습니다"
            : "Worktree를 폐기했습니다",
        description: result.message,
      });
      setConfirmAction(null);
      onMutated();
      onOpenChange(false);
    } catch (err) {
      toastManager.add({
        type: "error",
        title: confirmAction === "merge" ? "Worktree 병합 실패" : "Worktree 폐기 실패",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }, [confirmAction, onMutated, onOpenChange, requestContext, task]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2 pr-8">
              <FileDiffIcon aria-hidden className="size-4 text-muted-foreground" />
              <DialogTitle className="text-base">Worktree 변경 사항 검토</DialogTitle>
              <Badge size="sm" variant={stateMeta.variant}>
                {stateMeta.label}
              </Badge>
            </div>
            <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
              <span className="inline-flex items-center gap-1">
                <GitBranchIcon aria-hidden className="size-3" />
                {diff?.worktreeBranch ?? task?.worktreeBranch ?? "브랜치 없음"}
              </span>
              {(diff?.worktreeBaseRef ?? task?.worktreeBaseRef) ? (
                <span>기준: {diff?.worktreeBaseRef ?? task?.worktreeBaseRef}</span>
              ) : null}
              {task ? (
                <span>
                  작업: {task.role} ({task.taskId.slice(0, 12)})
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="space-y-3">
            {loading && !diff ? (
              <div className="rounded-md border border-border/60 bg-muted/20 p-4 text-xs text-muted-foreground">
                Worktree diff를 불러오는 중...
              </div>
            ) : error ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive-foreground">
                <AlertTriangleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</div>
              </div>
            ) : diff ? (
              <>
                {diff.worktreePath ? (
                  <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 font-mono text-[11px] text-muted-foreground break-all">
                    경로: {diff.worktreePath}
                  </div>
                ) : null}

                {diff.filesModified.length > 0 ? (
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-foreground">
                      변경된 파일 ({diff.filesModified.length}개)
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {diff.filesModified.map((filePath) => (
                        <Badge key={filePath} size="sm" variant="outline" className="font-mono">
                          {filePath}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}

                {diff.diffStat.trim() ? (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-foreground">
                      변경 통계 (`git diff --stat`)
                    </div>
                    <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/20 p-2.5 font-mono text-[11px] leading-relaxed text-foreground/90">
                      {diff.diffStat}
                    </pre>
                  </div>
                ) : null}

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs font-medium text-foreground">
                    <span>패치 미리보기</span>
                    {classified.truncated ? (
                      <span className="font-mono text-[11px] font-normal text-muted-foreground">
                        상위 {classified.lines.length} / {classified.totalLineCount}줄 표시
                      </span>
                    ) : null}
                  </div>
                  {classified.lines.length === 0 ? (
                    <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
                      표시할 diff 패치가 없습니다.
                      {diff.statusShort.trim() ? `\n\n${diff.statusShort}` : ""}
                    </div>
                  ) : (
                    <div className="max-h-[45vh] overflow-auto rounded-md border border-border/60 bg-background font-mono text-[11px] leading-5">
                      {classified.lines.map((line) => (
                        <div
                          key={line.lineNumber}
                          className={cn(
                            "whitespace-pre px-2.5",
                            line.kind === "added" && "bg-success/10 text-success-foreground",
                            line.kind === "removed" &&
                              "bg-destructive/10 text-destructive-foreground",
                            line.kind === "hunk" && "bg-info/10 text-info-foreground",
                            line.kind === "meta" && "bg-muted/40 text-muted-foreground",
                          )}
                        >
                          {line.text || " "}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </DialogPanel>

          <DialogFooter className="items-center justify-between gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loading || submitting}
              onClick={() => void loadDiff()}
            >
              <RefreshCwIcon aria-hidden className={cn("size-3.5", loading && "animate-spin")} />
              새로고침
            </Button>
            <div className="flex items-center gap-2">
              <DialogClose render={<Button size="sm" variant="outline" disabled={submitting} />}>
                닫기
              </DialogClose>
              {canMutate ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive-outline"
                    disabled={submitting || loading}
                    onClick={() => setConfirmAction("discard")}
                  >
                    <Trash2Icon aria-hidden className="size-3.5" />
                    폐기
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    disabled={submitting || loading}
                    onClick={() => setConfirmAction("merge")}
                  >
                    <GitMergeIcon aria-hidden className="size-3.5" />
                    병합
                  </Button>
                </>
              ) : null}
            </div>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !submitting) {
            setConfirmAction(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "merge"
                ? "격리 Worktree를 현재 브랜치에 병합할까요?"
                : "격리 Worktree와 변경 사항을 폐기할까요?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "merge"
                ? `브랜치 ${diff?.worktreeBranch ?? task?.worktreeBranch ?? ""}의 커밋을 작업 저장소에 병합한 뒤 격리 worktree를 정리합니다. 충돌이 발생하면 병합이 중단됩니다.`
                : `브랜치 ${diff?.worktreeBranch ?? task?.worktreeBranch ?? ""}와 격리 디렉터리의 변경 사항을 영구 삭제합니다. 이 작업은 되돌릴 수 없습니다.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={submitting} />}>
              취소
            </AlertDialogClose>
            <Button
              type="button"
              variant={confirmAction === "discard" ? "destructive" : "default"}
              disabled={submitting}
              onClick={() => void handleConfirmAction()}
            >
              {submitting ? "처리 중..." : confirmAction === "merge" ? "병합 실행" : "영구 폐기"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
