import { ProjectId, WorkspaceKnowledgeItemId, type WorkspaceRagMatch } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  compressRagText,
  formatRagIndexPointer,
  isNearDuplicateRagText,
} from "./ragContextCompression.ts";
import { composeWorkspacePrompt } from "./workspacePrompt.ts";

const projectId = ProjectId.make("proj_rag_opt");

function makeMatch(id: string, title: string, content: string): WorkspaceRagMatch {
  return {
    projectId,
    itemId: WorkspaceKnowledgeItemId.make(id),
    kind: "rag-source",
    title,
    snippet: content.slice(0, 80),
    content,
    score: 1,
    updatedAt: "2026-11-26T00:00:00.000Z",
  };
}

describe("RAG 토큰·압축 최적화 및 인덱스 포인터 강등", () => {
  it("장식 구분선·연속 빈줄·중복 라인을 제거하되 짧은 원문은 무손실 보존한다", () => {
    expect(compressRagText("The coolant reading is 30.")).toBe("The coolant reading is 30.");

    const noisy = [
      "==================",
      "크라임 코인 백테스팅 핵심 규칙: 승률 50% 이상 유지",
      "",
      "",
      "",
      "크라임 코인 백테스팅 핵심 규칙: 승률 50% 이상 유지",
      "------------------",
      "최대 낙폭 15% 제한 및 재투자 복리 적용",
    ].join("\n");
    const compressed = compressRagText(noisy);
    expect(compressed).not.toContain("==================");
    expect(compressed).not.toContain("------------------");
    expect(compressed.match(/승률 50% 이상 유지/g)).toHaveLength(1);
    expect(compressed).toContain("최대 낙폭 15% 제한");
    expect(compressed.length).toBeLessThan(noisy.length * 0.7);
  });

  it("유사 중복 장문 RAG 청크를 Jaccard 기준으로 걸러낸다", () => {
    const base =
      "크라임 코인 백테스팅 전략에서 1년 기간 100달러를 1000달러로 불리기 위해서는 변동성 돌파 진입과 ATR 손절, 수수료 슬리피지 반영 및 승률 50퍼센트 이상 구간 필터링이 반드시 필요합니다.";
    const nearDup =
      "크라임 코인 백테스팅 전략에서 1년 기간 100달러를 1000달러로 불리기 위해서는 변동성 돌파 진입과 ATR 손절, 수수료 슬리피지 반영 및 승률 50퍼센트 이상 구간 필터링이 필요합니다.";
    const first = isNearDuplicateRagText(base, []);
    expect(first.duplicate).toBe(false);
    const second = isNearDuplicateRagText(nearDup, [first.tokenSet]);
    expect(second.duplicate).toBe(true);
  });

  it("상위 2개 RAG 매치는 압축 본문을 유지하고 3순위 이후 장문은 1줄 인덱스 포인터로 강등해 토큰을 절감한다", () => {
    const makeDistinctBody = (label: string, theme: string) =>
      `${label} 백테스팅 전략 분석 — ${theme}. `.repeat(10);

    const matches = [
      makeMatch(
        "rag-1",
        "1순위 전략",
        makeDistinctBody("전략Alpha", "일봉 거래량 급증 돌파와 ATR 동적 트레일링 손절 조합"),
      ),
      makeMatch(
        "rag-2",
        "2순위 전략",
        makeDistinctBody("전략Beta", "펀딩비 역추세 숏 스퀴즈 포착 및 레버리지 1배 현물 복리"),
      ),
      makeMatch(
        "rag-3",
        "3순위 참고",
        makeDistinctBody("전략Gamma", "비트코인 도미넌스 레짐 필터와 주간 리밸런싱 비중 조절"),
      ),
      makeMatch(
        "rag-4",
        "4순위 참고",
        makeDistinctBody("전략Delta", "호가창 슬리피지 모델링과 메이커 수수료 리베이트 정산"),
      ),
    ];

    const pointer = formatRagIndexPointer({
      itemId: "rag-3",
      title: "3순위 참고",
      text: matches[2]!.content!,
    });
    expect(pointer).toContain("[RAG 인덱스 #rag-3]");
    expect(pointer.length).toBeLessThan(260);

    const standard = composeWorkspacePrompt({
      now: Date.parse("2026-11-26T01:00:00.000Z"),
      request: { projectId, task: "백테스팅 전략 분석", contextMode: "standard" },
      items: [],
      ragMatches: matches,
    });
    expect(standard.prompt).toContain("전략Alpha 백테스팅 전략 분석");
    expect(standard.prompt).toContain("전략Beta 백테스팅 전략 분석");
    expect(standard.prompt).toContain("[RAG 인덱스 #rag-3]");
    expect(standard.prompt).toContain("[RAG 인덱스 #rag-4]");
    // 3·4순위가 풀 본문 대신 인덱스 포인터(~180자)로 압축됨
    const rawTotal = matches.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    expect(standard.prompt.length).toBeLessThan(rawTotal + 600);
  });
});
