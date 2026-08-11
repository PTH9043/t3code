import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    approval.requestKind === "command"
      ? "명령 승인이 요청됨"
      : approval.requestKind === "file-read"
        ? "파일 읽기 승인이 요청됨"
        : "파일 변경 승인이 요청됨";
  const detailLabel =
    approval.requestKind === "command"
      ? "명령"
      : approval.requestKind === "file-read"
        ? "읽을 파일"
        : "파일 변경";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm tracking-[0.2em]">승인 대기</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.detail ? (
        <div className="mt-3 rounded-lg border border-border/65 bg-background/70 p-3">
          <p className="text-xs font-medium text-muted-foreground">{detailLabel}</p>
          <pre
            aria-label={detailLabel}
            className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground"
            data-approval-detail="complete"
          >
            {approval.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
