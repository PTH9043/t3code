import { useEffect, useRef, type ReactNode } from "react";
import type { WorkspaceAgentRole } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BrainCircuitIcon } from "lucide-react";

import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { stackedThreadToast, toastManager } from "../ui/toast";

export const ROLE_LABELS: Readonly<Record<WorkspaceAgentRole, string>> = {
  coordinator: "페이블 · 총괄 조정",
  operator: "페이블 · 운영 진단",
  planner: "페이블 · 계획 보조",
  researcher: "그록 · 실시간 조사",
  implementer: "코덱스 · 구현",
  reviewer: "페이블 · 결과 검토",
  verifier: "페이블 · 독립 검증",
};

export function runStatusLabel(status: string): string {
  if (status === "queued") return "대기 중";
  if (status === "running") return "실행 중";
  if (status === "cancel-requested") return "취소 요청됨";
  if (status === "cancelled") return "취소됨";
  if (status === "completed") return "완료";
  if (status === "failed") return "실패";
  return status;
}

export function runBadgeVariant(
  status: string,
): "success" | "warning" | "error" | "outline" | "info" {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "running") return "info";
  if (status === "queued" || status === "cancel-requested") return "warning";
  return "outline";
}

export function notifyCommandFailure<A, E>(
  result: AtomCommandResult<A, E>,
  title: string,
): boolean {
  if (result._tag === "Success") return false;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "요청을 처리하지 못했습니다.",
    }),
  );
  return true;
}

export function notifySuccess(title: string, description?: string) {
  toastManager.add({ type: "success", title, description });
}

export function formatTimestamp(value: string | null): string {
  if (value === null) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}

export function SectionCard(props: {
  id?: string;
  icon: typeof BrainCircuitIcon;
  title: string;
  scopeLabel?: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <Card id={props.id} className="scroll-mt-24">
      <CardHeader>
        <div className="mb-1 flex items-center gap-2 text-primary">
          <Icon className="size-4" />
          <span className="text-xs font-semibold uppercase tracking-wide">
            {props.scopeLabel ?? "프로젝트 전용"}
          </span>
        </div>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription className="leading-relaxed">{props.description}</CardDescription>
        {props.action ? <CardAction>{props.action}</CardAction> : null}
      </CardHeader>
      <CardPanel>{props.children}</CardPanel>
    </Card>
  );
}

/**
 * Refresh a one-shot query whenever the workspace runtime subscription's
 * `operationsUpdatedAt` revision moves. The first observed revision is only
 * recorded — the query already holds fresh data at mount time.
 */
export function useOperationsRevisionRefresh(
  runtimeData: { readonly operationsUpdatedAt: string | null } | null | undefined,
  refresh: () => void,
) {
  const lastRevisionRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (runtimeData === null || runtimeData === undefined) return;
    const revision = runtimeData.operationsUpdatedAt;
    if (lastRevisionRef.current === undefined) {
      lastRevisionRef.current = revision;
      return;
    }
    if (lastRevisionRef.current === revision) return;
    lastRevisionRef.current = revision;
    refresh();
  }, [runtimeData, refresh]);
}
