import {
  councilRoleArchetypeLabels,
  type CouncilSessionSnapshot,
  type EvidenceVerificationStatus,
} from "@t3tools/contracts";
import { ShieldAlertIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { memo } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";

const VERIFICATION_LABELS: Record<EvidenceVerificationStatus, string> = {
  VERIFIED_EXACT: "정확 일치",
  VERIFIED_SHIFTED: "라인 이동 일치",
  REJECTED_FILE_MISSING: "파일 없음 · 격리",
  REJECTED_HASH_MISMATCH: "범위 오류 · 격리",
  REJECTED_SYMBOL_NOT_FOUND: "심볼 없음 · 격리",
};

function verificationBadgeVariant(
  status: EvidenceVerificationStatus,
): "success" | "warning" | "error" {
  if (status === "VERIFIED_EXACT") return "success";
  if (status === "VERIFIED_SHIFTED") return "warning";
  return "error";
}

export const CouncilEvidenceDrawer = memo(function CouncilEvidenceDrawer(props: {
  readonly session: CouncilSessionSnapshot | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { session, open, onOpenChange } = props;
  const seatById = new Map(session?.roster.map((s) => [s.seatId, s]) ?? []);

  return (
    <Sheet open={open && session !== null} onOpenChange={onOpenChange}>
      <SheetPopup
        side="right"
        data-council-evidence-drawer=""
        className="flex w-[min(720px,94vw)] max-w-none flex-col bg-background text-foreground"
      >
        {session ? (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <SheetTitle className="truncate text-sm font-semibold text-foreground">
                  코드 근거 원장 & 익명 대조 · #{session.councilId.slice(-6)}
                </SheetTitle>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {session.roster.length}석 합석 · 검증 근거{" "}
                  {
                    session.ledgerEntries.filter(
                      (e) =>
                        e.verificationStatus === "VERIFIED_EXACT" ||
                        e.verificationStatus === "VERIFIED_SHIFTED",
                    ).length
                  }
                  건 · 무근거 Flip 차단 {session.flipBlockedCount}건
                </p>
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="근거 원장 닫기"
                onClick={() => onOpenChange(false)}
              >
                <XIcon className="size-4" />
              </Button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4 text-xs">
              <section aria-label="동적 합석 로스터">
                <h3 className="mb-2 text-xs font-semibold text-foreground">
                  동적 합석 로스터 ({session.roster.length}석)
                </h3>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {session.roster.map((seat) => (
                    <div
                      key={seat.seatId}
                      className="rounded-lg border border-border bg-card px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-foreground">
                          {seat.targetModel.displayName}
                        </span>
                        <Badge variant="outline" size="sm">
                          {councilRoleArchetypeLabels[seat.assignedRole]}
                        </Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span>{seat.seatId}</span>
                        {seat.directoryShardHint ? (
                          <span>· 샤드: {seat.directoryShardHint}</span>
                        ) : null}
                        {seat.temperatureOffset > 0 && seat.temperatureApplied ? (
                          <span>· ΔT +{seat.temperatureOffset}</span>
                        ) : null}
                        {seat.isFallbackSubstituted ? (
                          <Badge variant="warning" size="sm">
                            폴백 치환
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {session.pinnedSpec || session.synthesisReportMarkdown ? (
                <section aria-label="의장 최종 합의 및 고유 발견">
                  <h3 className="mb-2 text-xs font-semibold text-foreground">
                    의장 최종 합의 요약
                  </h3>
                  <div className="space-y-2 rounded-lg border border-border bg-card px-3 py-2.5">
                    {session.pinnedSpec ? (
                      <>
                        <p className="font-semibold text-foreground">
                          {session.pinnedSpec.titleKo}
                        </p>
                        <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
                          {session.pinnedSpec.executiveSummaryKo}
                        </p>
                        {session.pinnedSpec.uniqueFindingsKo.length > 0 ? (
                          <div className="pt-1">
                            <p className="font-medium text-foreground">소수파 고유 발견</p>
                            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                              {session.pinnedSpec.uniqueFindingsKo.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {session.pinnedSpec.unresolvedDisagreementsKo.length > 0 ? (
                          <div className="pt-1">
                            <p className="font-medium text-warning">미해결 쟁점</p>
                            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                              {session.pinnedSpec.unresolvedDisagreementsKo.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="whitespace-pre-wrap leading-relaxed text-foreground">
                        {session.synthesisReportMarkdown}
                      </p>
                    )}
                  </div>
                </section>
              ) : null}

              <section aria-label="Append-Only 코드 근거 원장">
                <h3 className="mb-2 text-xs font-semibold text-foreground">
                  코드 근거 원장 ({session.ledgerEntries.length}건)
                </h3>
                {session.ledgerEntries.length === 0 ? (
                  <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-muted-foreground">
                    아직 기록된 코드 근거가 없습니다.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {session.ledgerEntries.map((entry) => {
                      const seat = seatById.get(entry.submittedBySeatId);
                      const isOk =
                        entry.verificationStatus === "VERIFIED_EXACT" ||
                        entry.verificationStatus === "VERIFIED_SHIFTED";
                      return (
                        <div
                          key={entry.evidenceId}
                          className="rounded-lg border border-border bg-card px-3 py-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-foreground">
                              {isOk ? (
                                <ShieldCheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                              ) : (
                                <ShieldAlertIcon className="size-3.5 shrink-0 text-destructive" />
                              )}
                              <span className="truncate">
                                {entry.filePath}:{entry.startLine}-{entry.endLine}
                              </span>
                            </span>
                            <Badge
                              variant={verificationBadgeVariant(entry.verificationStatus)}
                              size="sm"
                            >
                              {VERIFICATION_LABELS[entry.verificationStatus]}
                            </Badge>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                            <span>R{entry.roundNum}</span>
                            {entry.astSymbol ? <span>· 심볼: {entry.astSymbol}</span> : null}
                            {entry.resolvedSymbolLine ? (
                              <span>(실측 L{entry.resolvedSymbolLine})</span>
                            ) : null}
                            <span className="font-mono">
                              · sha256:{entry.excerptSha256.slice(0, 8)}
                            </span>
                            <span>
                              · 제출: {seat?.targetModel.displayName ?? entry.submittedBySeatId}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section aria-label="주장 및 Flip 방어 이력">
                <h3 className="mb-2 text-xs font-semibold text-foreground">
                  익명 비평 · Subjective Logic 가중 주장 ({session.claims.length}건)
                </h3>
                <div className="space-y-2">
                  {session.claims.map((claim) => {
                    const seat = seatById.get(claim.authorSeatId);
                    return (
                      <div
                        key={claim.claimId}
                        className="rounded-lg border border-border bg-card px-3 py-2.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" size="sm">
                              R{claim.roundNum} · {claim.anonHandle}
                            </Badge>
                            <span className="text-[11px] text-muted-foreground">
                              ({seat?.targetModel.displayName ?? claim.authorSeatId})
                            </span>
                            {claim.severity === "P0" ? (
                              <Badge variant="error" size="sm">
                                P0 반론
                              </Badge>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[11px] text-muted-foreground">
                              b={claim.subjectiveOpinion.belief.toFixed(2)} u=
                              {claim.subjectiveOpinion.uncertainty.toFixed(2)}
                            </span>
                            <Badge
                              variant={
                                claim.status === "FLIP_BLOCKED"
                                  ? "warning"
                                  : claim.status === "REJECTED_NO_EVIDENCE"
                                    ? "error"
                                    : claim.status === "ACCEPTED"
                                      ? "success"
                                      : "secondary"
                              }
                              size="sm"
                            >
                              {claim.status}
                            </Badge>
                          </div>
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                          {claim.statementKo}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </>
        ) : null}
      </SheetPopup>
    </Sheet>
  );
});
