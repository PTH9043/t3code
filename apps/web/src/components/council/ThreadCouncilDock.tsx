import type {
  CouncilMode,
  CouncilSessionSnapshot,
  EnvironmentId,
  ModelTargetRef,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { memo, useCallback, useMemo, useState } from "react";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { toastManager } from "../ui/toast";
import { ChatCouncilStrip } from "./ChatCouncilStrip";
import { CouncilEvidenceDrawer } from "./CouncilEvidenceDrawer";
import { CouncilPinnedSpecCard } from "./CouncilPinnedSpecCard";

const DISMISSED_COUNCIL_STORAGE_KEY = "t3.council.dismissedIds.v1";
const COLLAPSED_COUNCIL_STORAGE_KEY = "t3.council.collapsedById.v1";
const MAX_DISMISSED_COUNCIL_IDS = 200;
export const STALE_INLINE_PINNED_IDLE_MS = 30 * 60_000;
export const STALE_GATE_REFUSED_IDLE_MS = 5 * 60_000;

export function readDismissedCouncilIds(
  storage?: Pick<Storage, "getItem"> | null,
): ReadonlySet<string> {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return new Set();
  try {
    const raw = target.getItem(DISMISSED_COUNCIL_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === "string" && item.length > 0),
    );
  } catch {
    return new Set();
  }
}

export function writeDismissedCouncilIds(
  ids: ReadonlySet<string>,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return;
  try {
    const list = Array.from(ids).slice(-MAX_DISMISSED_COUNCIL_IDS);
    target.setItem(DISMISSED_COUNCIL_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

export function readCollapsedCouncilMap(
  storage?: Pick<Storage, "getItem"> | null,
): Record<string, boolean> {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return {};
  try {
    const raw = target.getItem(COLLAPSED_COUNCIL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.length > 0 && typeof val === "boolean") {
        result[key] = val;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function writeCollapsedCouncilMap(
  map: Readonly<Record<string, boolean>>,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return;
  try {
    const entries = Object.entries(map).slice(-MAX_DISMISSED_COUNCIL_IDS);
    target.setItem(COLLAPSED_COUNCIL_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

export function resolveCouncilInlineCardVisibility(input: {
  readonly session: CouncilSessionSnapshot | null;
  readonly dismissedIds: ReadonlySet<string>;
  readonly reopenedCouncilId: string | null;
  readonly nowMs?: number;
}): { readonly showInlineCard: boolean; readonly canReopenFromStrip: boolean } {
  const { session, dismissedIds, reopenedCouncilId, nowMs } = input;
  if (!session || session.state === "IDLE") {
    return { showInlineCard: false, canReopenFromStrip: false };
  }
  const hasCardContent =
    session.pinnedSpec !== null ||
    Boolean(session.synthesisReportMarkdown) ||
    session.state === "AWAITING_OVERRIDE" ||
    session.state === "AUTO_SEATING" ||
    session.state === "BLIND_ROUND_1" ||
    session.state === "LEDGER_COMMIT_B1" ||
    session.state === "ANON_CRITIQUE_ROUND_2" ||
    session.state === "LEDGER_COMMIT_B2" ||
    session.state === "ARBITER_SYNTHESIS_B3" ||
    session.state === "DELEGATED_RUNNING" ||
    session.state === "VERIFYING";
  if (!hasCardContent) {
    return { showInlineCard: false, canReopenFromStrip: false };
  }

  const isAbortedOrInterrupted =
    session.state === "ABORTED" || session.state === "INTERRUPTED_BY_RESTART";
  const isDiscussionCompleted =
    session.state === "COMPLETED" && session.mode === "discussion" && session.pinnedSpec === null;
  const isInFlight =
    session.state === "AUTO_SEATING" ||
    session.state === "BLIND_ROUND_1" ||
    session.state === "LEDGER_COMMIT_B1" ||
    session.state === "ANON_CRITIQUE_ROUND_2" ||
    session.state === "LEDGER_COMMIT_B2" ||
    session.state === "ARBITER_SYNTHESIS_B3" ||
    session.state === "DELEGATED_RUNNING" ||
    session.state === "VERIFYING";
  const isReopened = reopenedCouncilId === session.councilId;
  const isDismissed = dismissedIds.has(session.councilId);

  // Aborted / interrupted sessions and completed discussion-only sessions (whose full report is
  // already posted to the chat timeline) stay hidden by default; users can reopen from the strip.
  if (isAbortedOrInterrupted || isDiscussionCompleted) {
    return {
      showInlineCard: isReopened && !isDismissed,
      canReopenFromStrip: !isReopened || isDismissed,
    };
  }

  // Stale PINNED_READY / AWAITING_OVERRIDE cards (e.g. gate-refused > 5m ago or untouched > 30m)
  // auto-hide to the compact top strip ("카드 보기") so they never stay permanently stuck open.
  if (
    !isInFlight &&
    (session.state === "PINNED_READY" || session.state === "AWAITING_OVERRIDE") &&
    typeof nowMs === "number" &&
    Number.isFinite(nowMs) &&
    session.updatedAtMs > 0
  ) {
    const ageMs = nowMs - session.updatedAtMs;
    const hasGateFailure = Boolean(
      session.pinnedSpec?.specGateOutcome && session.pinnedSpec.specGateOutcome !== "pass",
    );
    const isStalePending =
      ageMs >= STALE_INLINE_PINNED_IDLE_MS ||
      (hasGateFailure && ageMs >= STALE_GATE_REFUSED_IDLE_MS);
    if (isStalePending && !isReopened) {
      return { showInlineCard: false, canReopenFromStrip: true };
    }
  }

  // Explicit user dismissal hides any non-in-flight card (COMPLETED, PINNED_READY, AWAITING_OVERRIDE)
  // while keeping "카드 보기" available in the 1-line top strip.
  if (!isInFlight && isDismissed && !isReopened) {
    return { showInlineCard: false, canReopenFromStrip: true };
  }
  return { showInlineCard: true, canReopenFromStrip: false };
}

function formatCommandError(failure: unknown, fallback: string): string {
  const squashed = squashAtomCommandFailure(failure as never);
  if (squashed instanceof Error && squashed.message.trim().length > 0) {
    return squashed.message;
  }
  if (typeof squashed === "string" && squashed.trim().length > 0) {
    return squashed;
  }
  if (
    typeof squashed === "object" &&
    squashed !== null &&
    "message" in squashed &&
    typeof (squashed as { message?: unknown }).message === "string" &&
    (squashed as { message: string }).message.trim().length > 0
  ) {
    return (squashed as { message: string }).message;
  }
  return fallback;
}

export const ThreadCouncilDock = memo(function ThreadCouncilDock(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly chairLabel: string;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [staleWarning, setStaleWarning] = useState<string | null>(null);
  const [optimisticSession, setOptimisticSession] = useState<CouncilSessionSnapshot | null>(null);
  const [collapsedByCouncil, setCollapsedByCouncil] = useState<Record<string, boolean>>(() =>
    readCollapsedCouncilMap(),
  );
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() =>
    readDismissedCouncilIds(),
  );
  const [reopenedCouncilId, setReopenedCouncilId] = useState<string | null>(null);
  const [selectedCouncilId, setSelectedCouncilId] = useState<string | null>(null);

  const streamAtom = useMemo(
    () =>
      orchestrationEnvironment.councilStream({
        environmentId: props.environmentId,
        input: { threadId: props.threadId },
      }),
    [props.environmentId, props.threadId],
  );
  const streamResult = useEnvironmentQuery(streamAtom);

  const startAutoSeat = useAtomCommand(orchestrationEnvironment.startCouncilAutoSeat, {
    reportFailure: false,
  });
  const approveOverride = useAtomCommand(orchestrationEnvironment.approveCouncilOverride, {
    reportFailure: false,
  });
  const executePinnedSpec = useAtomCommand(orchestrationEnvironment.executeCouncilPinnedSpec, {
    reportFailure: false,
  });
  const reverifyPinnedSpec = useAtomCommand(orchestrationEnvironment.reverifyCouncilPinnedSpec, {
    reportFailure: false,
  });
  const abortCouncil = useAtomCommand(orchestrationEnvironment.abortCouncil, {
    reportFailure: false,
  });

  const sessions = streamResult.data?.sessions ?? (optimisticSession ? [optimisticSession] : []);
  const latestSession =
    (selectedCouncilId ? sessions.find((s) => s.councilId === selectedCouncilId) : null) ??
    sessions[0] ??
    null;

  const handleStartCouncil = useCallback(
    async (input: {
      readonly userPrompt: string;
      readonly mode?: CouncilMode;
      readonly overrideSubordinateTargets?: ReadonlyArray<ModelTargetRef>;
    }) => {
      setIsStarting(true);
      setStaleWarning(null);
      setReopenedCouncilId(null);
      setSelectedCouncilId(null);
      try {
        const res = await startAutoSeat({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            projectId: props.projectId,
            userPrompt: input.userPrompt,
            mode: input.mode ?? "auto",
            forceCouncil: true,
            ...(input.overrideSubordinateTargets
              ? { overrideSubordinateTargets: [...input.overrideSubordinateTargets] }
              : {}),
            ...(props.runtimeMode ? { runtimeMode: props.runtimeMode } : {}),
            ...(props.interactionMode ? { interactionMode: props.interactionMode } : {}),
          },
        });
        if (res._tag === "Success") {
          setOptimisticSession(res.value);
          toastManager.add({
            type: "info",
            title: `${res.value.roster.length}인 동적 위원회 소집을 시작했습니다.`,
          });
        } else {
          toastManager.add({
            type: "error",
            title: "위원회 소집에 실패했습니다",
            description: formatCommandError(res, "서버 응답을 확인해 주세요."),
          });
        }
      } finally {
        setIsStarting(false);
      }
    },
    [
      props.environmentId,
      props.interactionMode,
      props.projectId,
      props.runtimeMode,
      props.threadId,
      startAutoSeat,
    ],
  );

  const handleApproveOverride = useCallback(
    async (councilId: string, reason: string) => {
      const res = await approveOverride({
        environmentId: props.environmentId,
        input: { councilId, reason },
      });
      if (res._tag === "Success") {
        setOptimisticSession(res.value);
        toastManager.add({
          type: "info",
          title: "보류 승인을 기록하고 PinnedSpec을 잠갔습니다.",
        });
      } else {
        toastManager.add({
          type: "error",
          title: "보류 승인에 실패했습니다",
          description: formatCommandError(res, "다시 시도해 주세요."),
        });
      }
    },
    [approveOverride, props.environmentId],
  );

  const handleReverify = useCallback(
    async (pinnedSpecId: string) => {
      const res = await reverifyPinnedSpec({
        environmentId: props.environmentId,
        input: { pinnedSpecId },
      });
      if (res._tag === "Success") {
        setStaleWarning(null);
        setOptimisticSession(res.value);
        toastManager.add({
          type: "success",
          title: "대상 파일 SHA-256 잠금을 최신 디스크 상태로 재검증했습니다.",
        });
      } else {
        toastManager.add({
          type: "error",
          title: "디스크 해시 재검증에 실패했습니다",
          description: formatCommandError(res, "파일 상태를 확인해 주세요."),
        });
      }
    },
    [props.environmentId, reverifyPinnedSpec],
  );

  const handleExecuteDelegate = useCallback(
    async (input: {
      readonly pinnedSpecId: string;
      readonly selectedWorkerOverride?: ModelTargetRef;
      readonly isolateInWorktree: boolean;
      readonly idempotencyKey: string;
    }) => {
      setStaleWarning(null);
      const res = await executePinnedSpec({
        environmentId: props.environmentId,
        input,
      });
      if (res._tag === "Success") {
        toastManager.add({
          type: "success",
          title: res.value.deduplicated
            ? `이미 실행 중인 위임 작업(${res.value.delegationId})에 연결했습니다.`
            : `${res.value.executedWorker.displayName} 워커로 PinnedSpec 실행을 완료했습니다.`,
        });
      } else {
        const msg = formatCommandError(res, "PinnedSpec 실행 위임에 실패했습니다.");
        if (msg.includes("변경되어 실행을 차단") || msg.includes("STALE_PINNED_SPEC")) {
          setStaleWarning(msg);
        }
        toastManager.add({
          type: "error",
          title: "PinnedSpec 실행이 차단되었습니다",
          description: msg,
        });
      }
    },
    [executePinnedSpec, props.environmentId],
  );

  const handleAbort = useCallback(
    async (councilId: string) => {
      const res = await abortCouncil({
        environmentId: props.environmentId,
        input: { councilId },
      });
      if (res._tag === "Success") {
        setOptimisticSession(res.value);
        setReopenedCouncilId((prev) => (prev === councilId ? null : prev));
        setDismissedIds((prev) => {
          const next = new Set(prev);
          next.add(councilId);
          writeDismissedCouncilIds(next);
          return next;
        });
      }
    },
    [abortCouncil, props.environmentId],
  );

  const { showInlineCard, canReopenFromStrip } = resolveCouncilInlineCardVisibility({
    session: latestSession,
    dismissedIds,
    reopenedCouncilId,
    nowMs: Date.now(),
  });
  const defaultCollapsedForSession = Boolean(
    latestSession &&
    (latestSession.state === "ABORTED" ||
      latestSession.state === "INTERRUPTED_BY_RESTART" ||
      (latestSession.pinnedSpec?.specGateOutcome &&
        latestSession.pinnedSpec.specGateOutcome !== "pass")),
  );
  const isCardCollapsed = latestSession
    ? (collapsedByCouncil[latestSession.councilId] ?? defaultCollapsedForSession)
    : false;

  const handleToggleCollapse = useCallback(() => {
    if (!latestSession) return;
    setCollapsedByCouncil((prev) => {
      const current = prev[latestSession.councilId] ?? defaultCollapsedForSession;
      const next = {
        ...prev,
        [latestSession.councilId]: !current,
      };
      writeCollapsedCouncilMap(next);
      return next;
    });
  }, [defaultCollapsedForSession, latestSession]);

  const handleDismissCard = useCallback(() => {
    if (!latestSession) return;
    const targetId = latestSession.councilId;
    setReopenedCouncilId((prev) => (prev === targetId ? null : prev));
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(targetId);
      writeDismissedCouncilIds(next);
      return next;
    });
  }, [latestSession]);

  const handleReopenCard = useCallback(() => {
    if (!latestSession) return;
    const targetId = latestSession.councilId;
    setDismissedIds((prev) => {
      if (!prev.has(targetId)) return prev;
      const next = new Set(prev);
      next.delete(targetId);
      writeDismissedCouncilIds(next);
      return next;
    });
    setReopenedCouncilId(targetId);
    setCollapsedByCouncil((prev) => {
      const next = { ...prev, [targetId]: false };
      writeCollapsedCouncilMap(next);
      return next;
    });
  }, [latestSession]);

  return (
    <>
      <ChatCouncilStrip
        environmentId={props.environmentId}
        projectId={props.projectId}
        threadId={props.threadId}
        chairLabel={props.chairLabel}
        providerStatuses={props.providerStatuses}
        latestSession={latestSession}
        sessions={sessions}
        selectedCouncilId={latestSession?.councilId ?? null}
        onSelectCouncil={setSelectedCouncilId}
        isStarting={isStarting}
        isCardDismissed={canReopenFromStrip}
        onReopenCard={handleReopenCard}
        onStartCouncil={handleStartCouncil}
        onOpenEvidenceDrawer={() => setDrawerOpen(true)}
      />
      {showInlineCard && latestSession ? (
        <div className="shrink-0 px-3 sm:px-5">
          <CouncilPinnedSpecCard
            session={latestSession}
            staleWarning={staleWarning}
            collapsed={isCardCollapsed}
            onToggleCollapse={handleToggleCollapse}
            onDismiss={handleDismissCard}
            onOpenEvidenceDrawer={() => setDrawerOpen(true)}
            onApproveOverride={handleApproveOverride}
            onReverifyPinnedSpec={handleReverify}
            onAbortCouncil={handleAbort}
            onExecuteDelegate={handleExecuteDelegate}
          />
        </div>
      ) : null}
      <CouncilEvidenceDrawer
        session={latestSession}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    </>
  );
});
