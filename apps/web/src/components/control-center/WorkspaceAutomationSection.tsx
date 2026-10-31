import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ActivityIcon, RefreshCcwIcon } from "lucide-react";
import type { WorkspaceAutomationEvidenceRef, WorkspaceAutomationRow } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { WorkspaceAutomationEvidencePreview } from "./WorkspaceAutomationEvidencePreview";
import { WorkspaceTaskInboxSection } from "./WorkspaceTaskInboxSection";
import {
  SectionCard,
  formatTimestamp,
  runStatusLabel,
  runBadgeVariant,
  useOperationsRevisionRefresh,
} from "./controlCenterShared";

const VERIFICATION: Record<WorkspaceAutomationRow["verification"], string> = {
  unverified: "검증 기록 없음",
  "reported-pass": "에이전트 통과 보고",
  "reported-fail": "에이전트 검증 보류·실패",
  passed: "명령 검증 통과",
  failed: "명령 검증 실패",
  stale: "검증 갱신 필요",
};
function elapsed(ms: number | null) {
  if (ms === null) return "미확정";
  const seconds = Math.round(ms / 1_000);
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}
function EvidenceDialog({
  project,
  evidence,
  close,
}: {
  project: EnvironmentProject;
  evidence: WorkspaceAutomationEvidenceRef;
  close: () => void;
}) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workspaceAutomationEvidence({
      environmentId: project.environmentId,
      input: { projectId: project.id, ...evidence },
    }),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="w-full max-w-4xl">
        <DialogHeader>
          <DialogTitle>검증 실행 자료</DialogTitle>
          <DialogDescription className="break-all">{evidence.label}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-auto px-6 pb-6">
          {result.error ? (
            <p role="alert" className="text-destructive">
              {result.error}
            </p>
          ) : null}
          {!result.data && !result.error ? <p>검증 자료를 불러오는 중…</p> : null}
          {result.data ? <WorkspaceAutomationEvidencePreview evidence={result.data} /> : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
export function WorkspaceAutomationSection({ project }: { project: EnvironmentProject }) {
  const navigate = useNavigate();
  const [evidence, setEvidence] = useState<WorkspaceAutomationEvidenceRef | null>(null);
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workspaceAutomation({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const runtime = useEnvironmentQuery(
    orchestrationEnvironment.workspaceRuntime({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  useOperationsRevisionRefresh(runtime.data, result.refresh);
  const overview = result.data;
  const metrics = overview?.metrics;
  return (
    <>
      <WorkspaceTaskInboxSection key={project.id} project={project} />
      <SectionCard
        id="project-automation-results"
        icon={ActivityIcon}
        title="자동 작업 성과"
        description="협업·예약 실행과 지속 작업실의 기록을 함께 봅니다. 작업 완료와 실제 검증 통과를 따로 집계합니다."
        action={
          <Button variant="outline" size="sm" onClick={result.refresh}>
            <RefreshCcwIcon className="size-3.5" />
            새로고침
          </Button>
        }
      >
        {result.error ? (
          <p role="alert" className="text-sm text-destructive">
            {result.error}
          </p>
        ) : null}
        {!overview && !result.error ? (
          <p className="text-sm text-muted-foreground">성과 기록을 불러오는 중…</p>
        ) : null}
        {overview && metrics ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["작업 완료", metrics.completed],
                ["명령 검증 통과", metrics.verified],
                ["진행·대기", metrics.active],
                ["작업 실패", metrics.failed],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              최근 {overview.rows.length}건 / 전체 {overview.totalRows}건 · 재시도 없이 완료{" "}
              {metrics.firstAttemptCompleted}건 · 재시도 발생 {metrics.retried}건 (기록 있는{" "}
              {metrics.knownAttemptRows}건 기준) · 수집 토큰{" "}
              {metrics.measuredTokens?.toLocaleString() ?? "수집 없음"} ({metrics.measuredRows}건
              수집, 부분 집계 포함) · {formatTimestamp(overview.generatedAt)} 집계
            </p>
            {overview.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">기록된 자동 작업이 없습니다.</p>
            ) : null}
            <div className="space-y-2">
              {overview.rows.map((row) => (
                <details key={row.id} className="rounded-lg border border-border p-3">
                  <summary className="cursor-pointer text-sm">
                    <span className="mr-2">
                      <Badge variant={runBadgeVariant(row.status)}>
                        {runStatusLabel(row.status)}
                      </Badge>
                    </span>
                    {row.title}
                  </summary>
                  <div className="mt-3 space-y-2 text-xs">
                    <p>
                      {row.source === "development" ? "지속 작업실" : "협업·예약 실행"} ·{" "}
                      {VERIFICATION[row.verification]} · 경과 {elapsed(row.durationMs)}
                    </p>
                    <p>
                      시도 {row.attempts ?? "기록 없음"} · 재시도 {row.retries ?? "기록 없음"} ·
                      토큰 {row.measuredTokens?.toLocaleString() ?? "수집 없음"} (
                      {row.tokenCoverage})
                    </p>
                    <p className="text-muted-foreground">{formatTimestamp(row.requestedAt)} 시작</p>
                    <div className="flex flex-wrap gap-2">
                      {row.threadId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void navigate({
                              to: "/$environmentId/$threadId",
                              params: {
                                environmentId: project.environmentId,
                                threadId: row.threadId!,
                              },
                            })
                          }
                        >
                          작업 대화 열기
                        </Button>
                      ) : null}
                      {row.evidence.map((item) => (
                        <Button
                          key={`${item.kind}:${item.recordId}:${item.index}`}
                          size="sm"
                          variant="outline"
                          className="h-auto max-w-full whitespace-normal break-all text-left"
                          onClick={() => setEvidence(item)}
                        >
                          {item.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </details>
              ))}
            </div>
            <div className="rounded-lg bg-muted/40 p-3 text-xs">
              <p className="font-medium">예약 자동화 {overview.totalSchedules}개</p>
              {overview.schedules.map((schedule) => (
                <p key={schedule.id} className="mt-2">
                  {schedule.title} ·{" "}
                  {schedule.enabled ? `다음 ${formatTimestamp(schedule.nextTriggerAt)}` : "중지"}
                  {schedule.lastError ? ` · 오류: ${schedule.lastError}` : ""}
                </p>
              ))}
              {overview.totalSchedules > overview.schedules.length ? (
                <p>최근 목록은 최대 50개까지 표시합니다.</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </SectionCard>
      {evidence ? (
        <EvidenceDialog
          key={`${project.id}:${evidence.kind}:${evidence.recordId}:${evidence.index}`}
          project={project}
          evidence={evidence}
          close={() => setEvidence(null)}
        />
      ) : null}
    </>
  );
}
