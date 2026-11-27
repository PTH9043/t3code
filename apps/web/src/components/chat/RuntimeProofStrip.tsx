import { useState } from "react";
import {
  bgProviderDisplayName,
  detectDeferredBackgroundClaim,
  UNVERIFIED_BG_RETRY_PROMPT,
  type ScopedThreadRef,
  type SpecProofSummary,
  type UnifiedBgTask,
} from "@t3tools/contracts";
import { useComposerDraftStore } from "~/composerDraftStore";
import { Button } from "../ui/button";

function SpecProofBanner({ specProof }: { readonly specProof: SpecProofSummary }) {
  const toneClass =
    specProof.outcome === "pass"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : specProof.outcome === "waived"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-destructive/40 bg-destructive/10 text-destructive";
  const badge =
    specProof.outcome === "pass"
      ? "[독립 검증 통과]"
      : specProof.outcome === "refused_self_approval"
        ? "[자기승인 차단]"
        : specProof.outcome === "refused_tampered"
          ? "[스펙 변조 감지]"
          : specProof.outcome === "waived"
            ? "[스펙 우회 기록됨]"
            : "[완료 게이트 보류]";
  return (
    <div
      data-spec-proof-strip={specProof.outcome}
      className={`mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${toneClass}`}
    >
      <span className="font-medium">{badge}</span>
      <span className="min-w-0 truncate">
        {specProof.specId} · {specProof.summary}
      </span>
    </div>
  );
}

/**
 * Tier 2 Ground-Truth Verification Strip mounted directly beneath an assistant
 * turn answer / executive advice card. Cannot be lit by LLM markdown alone:
 * binds strictly to live UnifiedBgTask entries and host PinnedSpec gate proofs.
 */
export function RuntimeProofStrip({
  text,
  turnId,
  threadRef,
  backgroundTasks,
  specProof,
  isLatestAssistantAnswer = true,
  allowUnverifiedWarning = true,
}: {
  readonly text: string;
  readonly turnId?: string | null;
  readonly threadRef?: ScopedThreadRef;
  readonly backgroundTasks?: readonly UnifiedBgTask[];
  readonly specProof?: SpecProofSummary;
  /** True only for the thread's latest settled assistant answer; prevents historical turns from inheriting live-only badges. */
  readonly isLatestAssistantAnswer?: boolean;
  /** False while a turn or live background monitor/liveness is active, or on older turns. */
  readonly allowUnverifiedWarning?: boolean;
}) {
  const warningKey = `${turnId ?? ""}::${text.length}`;
  const [dismissedWarningKey, setDismissedWarningKey] = useState<string | null>(null);
  const tasks = backgroundTasks ?? [];
  const turnMatchedTasks = turnId ? tasks.filter((task) => task.turnId === turnId) : [];
  const matched =
    turnMatchedTasks.length > 0 ? turnMatchedTasks : isLatestAssistantAnswer ? tasks : [];
  const active = matched.filter((task) => task.state !== "COMPLETED");

  if (active.length > 0) {
    const primary = active[0]!;
    const hasStalled = active.some((task) => task.state === "STALLED");
    const hasFailed = active.some((task) => task.state === "FAILED");
    const toneClass = hasFailed
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : hasStalled
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    const summary = active
      .map(
        (task) =>
          `${bgProviderDisplayName(task.provider)} · ${task.proofHandle}${
            task.state === "STALLED" ? " (지연)" : " 가동 확인"
          }${task.artifactCount !== undefined ? ` · 산출물 ${task.artifactCount}개` : ""}${
            task.watcherArmed ? " · 완료 자동보고 Hook 연결됨" : ""
          }`,
      )
      .join(" / ");
    const detailLines = active
      .map((task) => {
        const title = task.title.trim();
        const tail = task.logTail?.trim();
        if (title && tail) return `${title} — ${tail}`;
        return tail || title;
      })
      .filter((line) => line.length > 0);
    return (
      <>
        <div
          data-runtime-proof-strip={hasFailed ? "failed" : hasStalled ? "stalled" : "verified"}
          className={`mt-2 space-y-1 rounded-lg border px-2.5 py-1.5 text-xs ${toneClass}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {hasFailed ? "[실패 감지]" : hasStalled ? "[지연 감지]" : "[실증 확인]"}
            </span>
            <span className="min-w-0 truncate">{summary || primary.proofHandle}</span>
          </div>
          {detailLines.length > 0 ? (
            <p
              data-runtime-proof-detail=""
              className="line-clamp-2 break-all font-mono text-[11px] opacity-90"
            >
              현재 진행: {detailLines.join(" | ")}
            </p>
          ) : null}
        </div>
        {specProof ? <SpecProofBanner specProof={specProof} /> : null}
      </>
    );
  }

  if (
    allowUnverifiedWarning &&
    isLatestAssistantAnswer &&
    dismissedWarningKey !== warningKey &&
    detectDeferredBackgroundClaim(text)
  ) {
    return (
      <>
        <div
          data-runtime-proof-strip="unverified"
          role="status"
          className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-orange-500/50 bg-orange-500/10 px-2.5 py-1.5 text-xs text-orange-700 dark:text-orange-300"
        >
          <span>
            [미검증 경고] 백그라운드 실행 또는 자동 보고를 안내했으나, 현재 등록된 활성
            작업(PID/Job)이 0건입니다.
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {threadRef ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  useComposerDraftStore.getState().setPrompt(threadRef, UNVERIFIED_BG_RETRY_PROMPT);
                }}
              >
                실행 재요청
              </Button>
            ) : null}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setDismissedWarningKey(warningKey)}
            >
              닫기
            </Button>
          </div>
        </div>
        {specProof ? <SpecProofBanner specProof={specProof} /> : null}
      </>
    );
  }

  return specProof ? <SpecProofBanner specProof={specProof} /> : null;
}
