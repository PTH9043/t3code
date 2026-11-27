import type { CouncilSessionSnapshot, ModelTargetRef } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  FileLock2Icon,
  PlayIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface CouncilPinnedSpecCardProps {
  readonly session: CouncilSessionSnapshot;
  readonly staleWarning?: string | null;
  readonly collapsed?: boolean;
  readonly onToggleCollapse?: () => void;
  readonly onDismiss?: () => void;
  readonly onOpenEvidenceDrawer: () => void;
  readonly onApproveOverride?: (councilId: string, reason: string) => Promise<void>;
  readonly onReverifyPinnedSpec?: (pinnedSpecId: string) => Promise<void>;
  readonly onAbortCouncil?: (councilId: string) => Promise<void>;
  readonly onExecuteDelegate: (input: {
    readonly pinnedSpecId: string;
    readonly selectedWorkerOverride?: ModelTargetRef;
    readonly isolateInWorktree: boolean;
    readonly idempotencyKey: string;
  }) => Promise<void>;
}

const SHORT_ROLE_LABELS: Record<CouncilSessionSnapshot["roster"][number]["assignedRole"], string> =
  {
    CHAIR_ARBITER: "CHAIR",
    CONTRARIAN_RED: "RED",
    SYSTEM_ARCHITECT: "ARCH",
    AST_LEDGER_AUDITOR: "LEDGER",
    EDGE_PERF_CRITIC: "EDGE",
    INTENT_CONTRACT_GUARD: "GUARD",
  };

const STATE_LABELS_KO: Record<CouncilSessionSnapshot["state"], string> = {
  IDLE: "대기",
  AUTO_SEATING: "1/7 가변 하위 팀 자동 합석",
  BLIND_ROUND_1: "2/7 Round 1 블라인드 격리 탐색",
  LEDGER_COMMIT_B1: "3/7 Boundary 1 원장·AST 검증",
  ANON_CRITIQUE_ROUND_2: "4/7 Round 2 동적 익명 비평",
  LEDGER_COMMIT_B2: "5/7 Boundary 2 Flip 차단 · SL 집계",
  ARBITER_SYNTHESIS_B3: "6/7 Boundary 3 의장 합성",
  AWAITING_OVERRIDE: "미해결 P0 반론 보류 승인 대기",
  PINNED_READY: "합의 완료 · PinnedSpec 실행 대기",
  DELEGATED_RUNNING: "7/7 하위 워커 격리 실행 중",
  VERIFYING: "인수 명령 · 독립 Checker 검증 중",
  COMPLETED: "실행 및 독립 검증 통과 완료",
  ABORTED: "중단됨",
  INTERRUPTED_BY_RESTART: "재시작으로 중단됨",
};

export const CouncilPinnedSpecCard = memo(function CouncilPinnedSpecCard({
  session,
  staleWarning,
  collapsed,
  onToggleCollapse,
  onDismiss,
  onOpenEvidenceDrawer,
  onApproveOverride,
  onReverifyPinnedSpec,
  onAbortCouncil,
  onExecuteDelegate,
}: CouncilPinnedSpecCardProps) {
  const spec = session.pinnedSpec;
  const isAbortedOrInterrupted =
    session.state === "ABORTED" || session.state === "INTERRUPTED_BY_RESTART";
  const hasGateFailure = Boolean(spec?.specGateOutcome && spec.specGateOutcome !== "pass");
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState<boolean>(
    () => isAbortedOrInterrupted || hasGateFailure,
  );
  const isCollapsed = collapsed ?? uncontrolledCollapsed;
  const handleToggleCollapse = () => {
    if (onToggleCollapse) {
      onToggleCollapse();
      return;
    }
    setUncontrolledCollapsed((prev) => !prev);
  };
  const [worktreeIsolated, setWorktreeIsolated] = useState(true);
  const [selectedWorkerKey, setSelectedWorkerKey] = useState<string>(() =>
    spec ? `${spec.recommendedWorker.providerInstanceId}:${spec.recommendedWorker.modelId}` : "",
  );
  const [isLaunching, setIsLaunching] = useState(false);
  const [isReverifying, setIsReverifying] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [isApprovingOverride, setIsApprovingOverride] = useState(false);

  const effectiveWorkerKey = useMemo(() => {
    if (!spec) return "";
    const candidates = spec.availableWorkerCandidates;
    if (
      selectedWorkerKey &&
      candidates.some((c) => `${c.providerInstanceId}:${c.modelId}` === selectedWorkerKey)
    ) {
      return selectedWorkerKey;
    }
    return `${spec.recommendedWorker.providerInstanceId}:${spec.recommendedWorker.modelId}`;
  }, [selectedWorkerKey, spec]);

  const verifiedCount = useMemo(
    () =>
      session.ledgerEntries.filter(
        (e) =>
          e.verificationStatus === "VERIFIED_EXACT" || e.verificationStatus === "VERIFIED_SHIFTED",
      ).length,
    [session.ledgerEntries],
  );

  const isInFlight =
    session.state === "AUTO_SEATING" ||
    session.state === "BLIND_ROUND_1" ||
    session.state === "LEDGER_COMMIT_B1" ||
    session.state === "ANON_CRITIQUE_ROUND_2" ||
    session.state === "LEDGER_COMMIT_B2" ||
    session.state === "ARBITER_SYNTHESIS_B3" ||
    session.state === "DELEGATED_RUNNING" ||
    session.state === "VERIFYING";

  const isMultiSeatRoundInFlight =
    session.state === "AUTO_SEATING" ||
    session.state === "BLIND_ROUND_1" ||
    session.state === "LEDGER_COMMIT_B1" ||
    session.state === "ANON_CRITIQUE_ROUND_2" ||
    session.state === "LEDGER_COMMIT_B2" ||
    session.state === "ARBITER_SYNTHESIS_B3";

  const canExecute =
    spec !== null &&
    verifiedCount > 0 &&
    spec.unresolvedDisagreementsKo.length === 0 &&
    !spec.delegatedTaskId &&
    session.state === "PINNED_READY";

  const handleOneClickExecute = async () => {
    if (!spec || !canExecute || isLaunching) return;
    setIsLaunching(true);
    try {
      const override = spec.availableWorkerCandidates.find(
        (c) => `${c.providerInstanceId}:${c.modelId}` === effectiveWorkerKey,
      );
      await onExecuteDelegate({
        pinnedSpecId: spec.pinnedSpecId,
        ...(override ? { selectedWorkerOverride: override } : {}),
        isolateInWorktree: worktreeIsolated,
        idempotencyKey: `ui_${spec.pinnedSpecId}_${spec.specHashSha256.slice(0, 16)}`,
      });
    } finally {
      setIsLaunching(false);
    }
  };

  const handleReverify = async () => {
    if (!spec || !onReverifyPinnedSpec || isReverifying) return;
    setIsReverifying(true);
    try {
      await onReverifyPinnedSpec(spec.pinnedSpecId);
    } finally {
      setIsReverifying(false);
    }
  };

  const handleApproveOverride = async () => {
    if (!onApproveOverride || isApprovingOverride) return;
    setIsApprovingOverride(true);
    try {
      await onApproveOverride(
        session.councilId,
        overrideReason.trim() || "미해결 P0 반론을 확인하고 실행 명세 잠금을 보류 승인함",
      );
    } finally {
      setIsApprovingOverride(false);
    }
  };

  const executeButtonLabel =
    session.state === "COMPLETED"
      ? `완료됨 (${spec?.delegatedTaskId ?? spec?.pinnedSpecId ?? ""})`
      : session.state === "ABORTED"
        ? "중단됨"
        : session.state === "INTERRUPTED_BY_RESTART"
          ? "재시작으로 중단됨"
          : spec?.delegatedTaskId
            ? `실행 중 (${spec.delegatedTaskId})`
            : isLaunching
              ? "실행 워커 시작 중..."
              : "PinnedSpec 원클릭 실행 위임";

  return (
    <section
      aria-label="다자간 위원회 합의 실행 카드"
      data-council-pinned-card=""
      data-council-state={session.state}
      data-council-collapsed={isCollapsed ? "true" : "false"}
      className="mx-auto my-2 w-full rounded-xl border border-border bg-card p-3.5 text-foreground shadow-xs"
    >
      <div
        className={`flex flex-wrap items-center justify-between gap-2${
          isCollapsed ? "" : " border-b border-border/70 pb-2.5"
        }`}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={session.state === "COMPLETED" ? "success" : "secondary"} size="sm">
            <UsersIcon className="size-3" />
            {session.roster.length}인 동적 위원회 · {STATE_LABELS_KO[session.state]}
          </Badge>
          <Badge variant={verifiedCount > 0 ? "success" : "outline"} size="sm">
            <ShieldCheckIcon className="size-3" />
            원장 검증 근거 {verifiedCount}건
          </Badge>
          {session.flipBlockedCount > 0 ? (
            <Badge variant="warning" size="sm">
              <ShieldAlertIcon className="size-3" />
              무근거 Flip {session.flipBlockedCount}건 차단
            </Badge>
          ) : null}
          {spec?.specGateOutcome === "pass" ? (
            <Badge variant="success" size="sm">
              <CheckCircle2Icon className="size-3" />
              Zero Self-Approval 통과
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={onOpenEvidenceDrawer}>
            근거 원장 보기
          </Button>
          {(isInFlight ||
            session.state === "PINNED_READY" ||
            session.state === "AWAITING_OVERRIDE") &&
          onAbortCouncil ? (
            <Button
              size="xs"
              variant="ghost"
              data-council-abort-btn=""
              onClick={() => void onAbortCouncil(session.councilId)}
            >
              {isInFlight ? "중단" : "보류 폐기"}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            data-council-collapse-btn=""
            aria-expanded={!isCollapsed}
            onClick={handleToggleCollapse}
          >
            {isCollapsed ? (
              <>
                <ChevronDownIcon className="size-3" />
                펼치기
              </>
            ) : (
              <>
                <ChevronUpIcon className="size-3" />
                접기
              </>
            )}
          </Button>
          {!isInFlight && onDismiss ? (
            <Button
              size="xs"
              variant="ghost"
              data-council-dismiss-btn=""
              aria-label="위원회 카드 닫기"
              onClick={onDismiss}
            >
              <XIcon className="size-3" />
              닫기
            </Button>
          ) : null}
        </div>
      </div>

      {!isCollapsed ? (
        <div className="max-h-[38vh] overflow-y-auto pr-1">
          {isMultiSeatRoundInFlight && session.seatProgress && session.seatProgress.length > 0 ? (
            <div
              data-council-seat-progress=""
              className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]"
            >
              {session.roster.map((seat) => {
                const prog = session.seatProgress?.find((p) => p.seatId === seat.seatId);
                const state = prog?.state ?? "pending";
                const secs = prog ? Math.round(prog.elapsedMs / 1000) : 0;
                const statusText =
                  state === "completed"
                    ? `완료 ${secs}s`
                    : state === "timed_out"
                      ? `시간초과 ${secs}s`
                      : state === "failed"
                        ? "실패"
                        : state === "running"
                          ? "실행 중"
                          : "대기";
                const variant =
                  state === "completed"
                    ? "success"
                    : state === "timed_out" || state === "failed"
                      ? "warning"
                      : "outline";
                return (
                  <Badge key={seat.seatId} variant={variant} size="sm">
                    {SHORT_ROLE_LABELS[seat.assignedRole]} · {seat.targetModel.modelId} (
                    {statusText})
                  </Badge>
                );
              })}
            </div>
          ) : null}

          {(session.state === "DELEGATED_RUNNING" || session.state === "VERIFYING") && spec ? (
            <div
              data-council-worker-progress=""
              className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            >
              <span>
                {session.state === "VERIFYING"
                  ? `하위 워커(${spec.delegatedTaskId ?? "실행 완료"}) 작업 후 인수 검증 및 독립 Checker 판정을 진행 중입니다.`
                  : `단일 실행 워커(${spec.delegatedTaskId ?? spec.recommendedWorker.displayName})가 잠금 대상 파일 범위에서 작업을 수행 중입니다.`}
              </span>
            </div>
          ) : null}

          {session.state === "AWAITING_OVERRIDE" ? (
            <div className="mt-3 space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
              <div className="flex items-start gap-2">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-foreground">
                    의무 반론자(CONTRARIAN_RED)의 P0 반론이 해소되지 않아 출고가 차단되었습니다.
                  </p>
                  {session.errorMessage ? (
                    <p className="mt-1 text-muted-foreground">{session.errorMessage}</p>
                  ) : null}
                </div>
              </div>
              {onApproveOverride ? (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <input
                    type="text"
                    aria-label="보류 승인 사유"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="보류 승인 사유 입력 (감사 로그에 기록됨)"
                    className="h-7 min-w-[200px] flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isApprovingOverride}
                    onClick={() => void handleApproveOverride()}
                  >
                    {isApprovingOverride ? "승인 중..." : "보류 승인 후 PinnedSpec 잠금"}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {staleWarning ? (
            <div
              role="alert"
              data-council-stale-alert=""
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground"
            >
              <span>{staleWarning}</span>
              {spec && onReverifyPinnedSpec ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={isReverifying}
                  onClick={() => void handleReverify()}
                >
                  <RefreshCwIcon className="size-3" />
                  {isReverifying ? "재검증 중..." : "디스크 해시 재검증"}
                </Button>
              ) : null}
            </div>
          ) : null}

          {spec &&
          session.errorMessage &&
          session.state !== "COMPLETED" &&
          session.state !== "AWAITING_OVERRIDE" ? (
            <div
              role="alert"
              data-council-error-alert=""
              className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground"
            >
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{session.errorMessage}</span>
            </div>
          ) : null}

          {spec ? (
            <>
              <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-foreground">{spec.titleKo}</h4>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                    {spec.executiveSummaryKo}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span>실행 워커</span>
                  <select
                    aria-label="실행 위임 워커 선택"
                    data-council-worker-select=""
                    value={effectiveWorkerKey}
                    disabled={!canExecute || isLaunching}
                    onChange={(e) => setSelectedWorkerKey(e.target.value)}
                    className="h-7 max-w-[240px] rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {spec.availableWorkerCandidates.map((cand, idx) => {
                      const key = `${cand.providerInstanceId}:${cand.modelId}`;
                      return (
                        <option key={key} value={key}>
                          {idx === 0 ? `[추천 1순위] ${cand.displayName}` : cand.displayName}
                        </option>
                      );
                    })}
                  </select>
                </label>
              </div>

              <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                <div className="rounded-lg border border-border/70 bg-muted/30 p-2.5">
                  <div className="flex items-center gap-1.5 font-semibold text-foreground">
                    <FileLock2Icon className="size-3.5 text-muted-foreground" />
                    잠금 대상 파일 ({spec.targetFilesLock.length}개 · SHA-256 CAS)
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {spec.targetFilesLock.map((f) => (
                      <li
                        key={f.filePath}
                        className="truncate font-mono text-[11px] text-foreground"
                      >
                        {f.filePath}{" "}
                        <span className="text-muted-foreground">
                          [{f.expectedFileSha256.slice(0, 7)}]
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-lg border border-border/70 bg-muted/30 p-2.5">
                  <div className="font-semibold text-foreground">
                    인수 검증 게이트 ({spec.acceptanceChecks.length}건 · execFile 직접 실행)
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {spec.acceptanceChecks.map((check) => (
                      <li
                        key={check.label}
                        className="truncate font-mono text-[11px] text-foreground"
                      >
                        {check.verifySpec.command} {(check.verifySpec.args ?? []).join(" ")}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {spec.specProofSummary ? (
                <div className="mt-2.5 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">완료 게이트 판정:</span>{" "}
                  {spec.specProofSummary.summary}
                  {spec.worktreeBranch ? (
                    <span className="ml-2 font-mono text-[11px]">
                      (Worktree 브랜치: {spec.worktreeBranch})
                    </span>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={worktreeIsolated}
                    disabled={!canExecute || isLaunching}
                    onChange={(e) => setWorktreeIsolated(e.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  Git Worktree 격리 실행 후 Diff 확인 · 검증 통과 시 완료 (Git 미초기화 프로젝트는
                  현재 폴더에서 자동 실행)
                </label>
                <Button
                  size="xs"
                  data-council-execute-btn=""
                  disabled={!canExecute || isLaunching}
                  onClick={() => void handleOneClickExecute()}
                >
                  <PlayIcon className="size-3" />
                  {executeButtonLabel}
                </Button>
              </div>
            </>
          ) : (
            <div className="mt-2.5 text-xs text-muted-foreground">
              {session.synthesisReportMarkdown ? (
                <div
                  data-council-discussion-summary=""
                  className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-muted/20 p-3 text-xs leading-relaxed text-foreground"
                >
                  {session.synthesisReportMarkdown}
                </div>
              ) : (
                <p className="truncate text-foreground">{session.userPrompt}</p>
              )}
              {session.errorMessage ? (
                <p className="mt-1 text-destructive">{session.errorMessage}</p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
});
