import { useState } from "react";
import type {
  EnvironmentId,
  WorkspaceKnowledgeItem,
  WorkspacePromptDecision,
  WorkspacePromptDiagnostics as Diagnostics,
  WorkspacePromptTokenEstimate,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { StoredKnowledgeOriginal } from "../knowledge/StoredKnowledgeOriginal";

const REASONS: Record<WorkspacePromptDecision["reason"], string> = {
  mandatory: "필수 사용자 지침",
  relevant: "작업과 관련",
  standard: "기존 방식",
  "low-relevance": "관련성 낮음",
  duplicate: "동일 본문",
  superseded: "이전 버전",
  disabled: "사용 안 함",
  budget: "문맥 예산",
  "included-history": "과거 비교 근거",
  contradicted: "모순 미해결",
  "not-yet-valid": "아직 유효하지 않음",
  "topic-mismatch": "자료 주제와 다른 작업",
  "current-task": "현재 메시지의 저장 사본",
};
const TEMPORAL: Record<WorkspacePromptDecision["temporalStatus"], string> = {
  current: "현재",
  history: "과거",
  future: "예정",
  unknown: "시점 미지정",
};
const VERIFICATION: Record<WorkspacePromptDecision["verification"], string> = {
  verified: "검증됨",
  unverified: "미검증",
  contradicted: "모순 미해결",
};

/** A preview explains selection; it never represents a provider's actual token receipt. */
export function WorkspacePromptDiagnostics({
  diagnostics,
  items,
  environmentId,
}: {
  diagnostics: Diagnostics;
  items: readonly WorkspaceKnowledgeItem[];
  environmentId: EnvironmentId;
}) {
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const selected = diagnostics.decisions.filter((decision) => decision.selected).length;
  const sourceKey = (source: { projectId: string; itemId: string }) =>
    JSON.stringify([source.projectId, source.itemId]);
  const originals = new Map(
    items.map((item) => [sourceKey({ projectId: item.projectId, itemId: item.id }), item]),
  );
  return (
    <details className="rounded-lg border border-border/60 p-3 text-xs">
      <summary className="cursor-pointer font-medium">
        문맥 선택 내역 · {selected}개 근거 포함
      </summary>
      <p className="mt-2 text-muted-foreground">
        전체 입력 {diagnostics.promptChars.toLocaleString("ko-KR")}자 · 사용자 지침{" "}
        {diagnostics.mandatoryChars.toLocaleString("ko-KR")}자 · 기억{" "}
        {diagnostics.memoryChars.toLocaleString("ko-KR")}자 · 외부 자료{" "}
        {diagnostics.libraryChars.toLocaleString("ko-KR")}자. 실제 AI 소비량은 실행 후 사용량에서
        확인합니다.
      </p>
      {diagnostics.mandatoryOverflowChars > 0 ? (
        <p className="mt-2 text-warning-foreground">
          필수 지침이 문맥 예산을 {diagnostics.mandatoryOverflowChars.toLocaleString("ko-KR")}자
          초과하여 원문을 모두 보존했습니다.
        </p>
      ) : null}
      <div className="mt-3 max-h-80 space-y-2 overflow-auto">
        {diagnostics.decisions.map((decision) => {
          const key = sourceKey(decision);
          const original = originals.get(key);
          const expandedKey = key + ":" + (decision.chunkId ?? "item");
          return (
            <div key={expandedKey} className="rounded-md bg-muted/30 p-2">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="min-w-0 break-words font-medium">
                  {decision.selected ? "포함" : "제외"} · {decision.title}
                </span>
                <span>{REASONS[decision.reason]}</span>
              </div>
              <p className="mt-1 text-muted-foreground">
                {TEMPORAL[decision.temporalStatus]} · {VERIFICATION[decision.verification]} ·
                {decision.revision === undefined ? " 버전 미지정" : " 버전 " + decision.revision} ·
                {decision.chunkId === undefined ? " 항목" : " 청크 " + decision.chunkId} ·
                {decision.injectedChars.toLocaleString("ko-KR")} /{" "}
                {decision.sourceChars.toLocaleString("ko-KR")}자
              </p>
              {original ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="mt-1"
                  onClick={() =>
                    setExpandedSource(expandedSource === expandedKey ? null : expandedKey)
                  }
                >
                  {expandedSource === expandedKey ? "원문 닫기" : "저장 원문 보기"}
                </Button>
              ) : (
                <p className="mt-1 text-muted-foreground">원문 항목: {decision.itemId}</p>
              )}
              {expandedSource === expandedKey && original ? (
                <StoredKnowledgeOriginal
                  environmentId={environmentId}
                  projectId={original.projectId}
                  itemId={original.id}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}

export function WorkspacePromptTokens({ estimate }: { estimate: WorkspacePromptTokenEstimate }) {
  const sections = [
    ["현재 작업", estimate.sections.task],
    ["필수 지침", estimate.sections.instructions],
    ["선택 기억", estimate.sections.memory],
    ["외부 자료", estimate.sections.library],
  ] as const;
  return (
    <div className="rounded-lg border border-border/60 p-3 text-xs">
      <p className="font-medium">
        프로젝트 문맥 약 {estimate.total.toLocaleString("ko-KR")} 토큰
        {estimate.limit === null ? "" : ` / 예산 ${estimate.limit.toLocaleString("ko-KR")}`}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {sections.map(([label, count]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{count.toLocaleString("ko-KR")}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-muted-foreground">
        공통 기준으로 계산한 추정치입니다. 전체는 구분 문구를 포함하며, AI의 대화 이력·도구·추론과
        실제 과금 토큰은 포함하지 않습니다. 모델별 실제 값과 차이가 있습니다.
      </p>
      {estimate.mandatoryOverflow > 0 ? (
        <p className="mt-2 text-warning-foreground" role="status">
          현재 작업·필수 지침·원문 참조 등 필수 입력을 보존하여 예산을{" "}
          {estimate.mandatoryOverflow.toLocaleString("ko-KR")} 토큰 초과했습니다. 선택 자료는
          제외했습니다.
        </p>
      ) : null}
    </div>
  );
}
