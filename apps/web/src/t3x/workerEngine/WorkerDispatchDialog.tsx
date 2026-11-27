import { useAtomValue } from "@effect/atom-react";
import type { ThreadId, WorkerDecisionGateRisk, WorkerWorktreeMode } from "@t3tools/contracts";
import { PlayIcon, ShieldAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { primaryServerProvidersAtom } from "~/state/server";

import { dispatchWorker, type WorkerEngineRequestContext } from "./workerEngineClient";

const WORKER_ROLE_OPTIONS = [
  { value: "coder", label: "구현 · 수정 (coder)" },
  { value: "researcher", label: "조사 · 탐색 (researcher)" },
  { value: "tester", label: "테스트 · 검증 (tester)" },
  { value: "reviewer", label: "코드 리뷰 (reviewer)" },
  { value: "planner", label: "계획 · 설계 (planner)" },
  { value: "debugger", label: "디버깅 (debugger)" },
  { value: "verifier", label: "최종 검증 (verifier)" },
] as const;

const FALLBACK_TARGETS = [
  { instanceId: "codex", label: "Codex", models: [] as string[] },
  { instanceId: "claudeAgent", label: "Claude", models: [] as string[] },
  { instanceId: "gemini", label: "Antigravity (Gemini)", models: [] as string[] },
  { instanceId: "grok", label: "Grok", models: [] as string[] },
  { instanceId: "opencode", label: "OpenCode", models: [] as string[] },
];

export interface WorkerDispatchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadId: ThreadId | null;
  readonly defaultCwd: string | null;
  readonly requestContext: WorkerEngineRequestContext;
  readonly onDispatched: () => void;
}

export function WorkerDispatchDialog({
  open,
  onOpenChange,
  threadId,
  defaultCwd,
  requestContext,
  onDispatched,
}: WorkerDispatchDialogProps) {
  const serverProviders = useAtomValue(primaryServerProvidersAtom);

  const targetOptions = useMemo(() => {
    const enabled = serverProviders
      .filter((provider) => provider.enabled)
      .map((provider) => ({
        instanceId: provider.instanceId ?? provider.driver,
        label: provider.displayName?.trim() || provider.instanceId || provider.driver,
        models: provider.models.map((m) => m.slug),
      }));
    return enabled.length > 0 ? enabled : FALLBACK_TARGETS;
  }, [serverProviders]);

  const [role, setRole] = useState<string>("coder");
  const [targetInstanceId, setTargetInstanceId] = useState<string>(
    () => targetOptions[0]?.instanceId ?? "codex",
  );
  const [targetModel, setTargetModel] = useState<string>("");
  const [cwd, setCwd] = useState<string>(defaultCwd ?? "");
  const [specText, setSpecText] = useState<string>("");
  const [worktreeMode, setWorktreeMode] = useState<WorkerWorktreeMode>("isolated");
  const [requireApproval, setRequireApproval] = useState<boolean>(false);
  const [approvalRiskLevel, setApprovalRiskLevel] = useState<WorkerDecisionGateRisk>("high");
  const [approvalQuestion, setApprovalQuestion] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (!open) return;
    if (defaultCwd && !cwd.trim()) {
      setCwd(defaultCwd);
    }
    if (
      targetOptions.length > 0 &&
      !targetOptions.some((option) => option.instanceId === targetInstanceId)
    ) {
      setTargetInstanceId(targetOptions[0]!.instanceId);
    }
  }, [cwd, defaultCwd, open, targetInstanceId, targetOptions]);

  const selectedTarget = useMemo(
    () => targetOptions.find((option) => option.instanceId === targetInstanceId) ?? null,
    [targetInstanceId, targetOptions],
  );

  const handleSubmit = useCallback(async () => {
    const trimmedSpec = specText.trim();
    const trimmedCwd = cwd.trim();
    if (!trimmedSpec) {
      toastManager.add({ type: "warning", title: "작업 지시를 입력하세요" });
      return;
    }
    if (!trimmedCwd) {
      toastManager.add({ type: "warning", title: "작업 폴더 경로(cwd)를 입력하세요" });
      return;
    }

    setSubmitting(true);
    try {
      const receipt = await dispatchWorker(
        {
          threadId: threadId ?? "global-worker-board",
          callerKind: "cli",
          role,
          targetInstanceId,
          ...(targetModel.trim() ? { targetModel: targetModel.trim() } : {}),
          specText: trimmedSpec,
          cwd: trimmedCwd,
          worktreeMode,
          ...(requireApproval
            ? {
                requireApproval: true,
                approvalRiskLevel,
                ...(approvalQuestion.trim() ? { approvalQuestion: approvalQuestion.trim() } : {}),
              }
            : {}),
        },
        requestContext,
      );
      toastManager.add({
        type: "success",
        title: receipt.gateId
          ? "승인 대기 상태로 작업자를 등록했습니다"
          : receipt.deduplicated
            ? "이미 실행 중인 동일 작업에 연결했습니다"
            : "새 작업자를 파견했습니다",
        description: `${role} · ${targetInstanceId} (${receipt.taskId.slice(0, 12)})`,
      });
      setSpecText("");
      setApprovalQuestion("");
      setRequireApproval(false);
      onDispatched();
      onOpenChange(false);
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "작업자 파견에 실패했습니다",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    approvalQuestion,
    approvalRiskLevel,
    cwd,
    onDispatched,
    onOpenChange,
    requestContext,
    requireApproval,
    role,
    specText,
    targetInstanceId,
    targetModel,
    threadId,
    worktreeMode,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">새 작업자 파견</DialogTitle>
          <DialogDescription>
            T3 작업자 엔진을 통해 격리 Worktree 또는 현재 폴더에서 독립 작업자를 실행합니다.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-foreground">역할</span>
              <select
                value={role}
                onChange={(event) => setRole(event.currentTarget.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                {WORKER_ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-foreground">AI 공급자</span>
              <select
                value={targetInstanceId}
                onChange={(event) => {
                  setTargetInstanceId(event.currentTarget.value);
                  setTargetModel("");
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                {targetOptions.map((option) => (
                  <option key={option.instanceId} value={option.instanceId}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-foreground">모델 (선택)</span>
              <input
                type="text"
                list="worker-dispatch-models"
                value={targetModel}
                onChange={(event) => setTargetModel(event.currentTarget.value)}
                placeholder="비워두면 공급자 기본 모델 사용"
                className="h-8 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
              {selectedTarget && selectedTarget.models.length > 0 ? (
                <datalist id="worker-dispatch-models">
                  {selectedTarget.models.map((slug) => (
                    <option key={slug} value={slug} />
                  ))}
                </datalist>
              ) : null}
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-foreground">작업 격리 모드</span>
              <select
                value={worktreeMode}
                onChange={(event) =>
                  setWorktreeMode(event.currentTarget.value as WorkerWorktreeMode)
                }
                className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="isolated">격리 Worktree (Diff 검토 후 병합/폐기)</option>
                <option value="current">현재 폴더 직접 실행 (읽기·조사 권장)</option>
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-foreground">작업 폴더 (cwd)</span>
            <input
              type="text"
              value={cwd}
              onChange={(event) => setCwd(event.currentTarget.value)}
              placeholder="예: D:\__NewAutoUsage"
              className="h-8 rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-foreground">작업 지시</span>
            <textarea
              rows={4}
              value={specText}
              onChange={(event) => setSpecText(event.currentTarget.value)}
              placeholder="작업자에게 맡길 구체적인 목표, 검증 기준, 수정 범위를 입력하세요."
              className="rounded-md border border-input bg-background p-2.5 text-xs leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          </label>

          <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
              <input
                type="checkbox"
                checked={requireApproval}
                onChange={(event) => setRequireApproval(event.currentTarget.checked)}
                className="size-3.5 rounded border-input accent-primary"
              />
              <ShieldAlertIcon aria-hidden className="size-3.5 text-warning-foreground" />
              <span>실행 전 승인 게이트(Decision Gate) 먼저 생성</span>
            </label>
            {requireApproval ? (
              <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                <select
                  aria-label="승인 위험도"
                  value={approvalRiskLevel}
                  onChange={(event) =>
                    setApprovalRiskLevel(event.currentTarget.value as WorkerDecisionGateRisk)
                  }
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="medium">주의 (medium)</option>
                  <option value="high">높음 (high)</option>
                  <option value="critical">위험 (critical)</option>
                </select>
                <input
                  type="text"
                  value={approvalQuestion}
                  onChange={(event) => setApprovalQuestion(event.currentTarget.value)}
                  placeholder="승인 요청 질문 (비워두면 기본 질문 생성)"
                  className="h-8 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" disabled={submitting} />}>
            취소
          </DialogClose>
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={submitting || !specText.trim() || !cwd.trim()}
            onClick={() => void handleSubmit()}
          >
            <PlayIcon aria-hidden className="size-3.5" />
            {submitting ? "파견 중..." : "작업자 파견"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
