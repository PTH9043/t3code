import { expect, it } from "vite-plus/test";
import { parseStructuredTextQuestions, parseTextQuestions } from "./textQuestions.ts";

const USER_REPORTED_MESSAGE = [
  "## [보고]",
  "599종목 4년 데이터 전조 탐색 준비를 마쳤습니다.",
  "",
  "## [비서실장의 조언]",
  "이미 오른 놈을 뒤쫓거나 숏 치는 대신 '아직 안 오른 비밈 알트의 매집 전조'로 판을 완전히 바꾸신 만큼, 먼저 디스크에 있는 599종목 4년 데이터에서 급등 6시간~3일 전에 실제로 어떤 신호가 미리 뜨는지부터 확인해 주세요.",
  "",
  "아래 질문 카드에서 선택해 주세요.",
  "",
  '{"questions":[{"header":"급등 전 알트 탐색 방식","question":"\'급등하기 전 비밈 알트(+20% 목표)\' 탐색을 어떤 순서로 진행할까요?","options":[{"label":"비밈 599종목 4년치 \'급등 전 6h~3일 전조 해부\' + 미리 매수(롱) 전략 검증 (권장)","description":"추가 다운로드 없이, 하루 +20% 터진 비밈 알트들이 터지기 전에 보인 공통 신호를 뽑아 최근 1년 반 시장에서 수익 검증"},{"label":"4년 백테스트 + 실시간 \'급등 전조 레이더(OI 급증·업비트/빗썸)\' 함께 구축","description":"4년 백테스트를 먼저 끝내면서, 과거 파일이 없는 실시간 미결제약정(OI)·원화거래소 급증 포착기까지 이어서 제작"}]},{"header":"목표 수익과 보유 기간","question":"급등 전 미리 매수(롱)할 때 어떤 보유 기간과 익절 구조를 검증할까요?","options":[{"label":"1~3일 스윙 보유 · 2분할 매수(50%+50%) · 3단계 익절(+10%/+18%/+25%) · 2배 (권장)","description":"아직 조용할 때 미리 들어가 1~3일 기다리며 +20% 파동을 먹는 구조 ($100 최소주문 벽 안전)"}]}]}',
].join("\n");

it("parses bare question JSON placed right after 비서실장의 조언 for gemini and opencode", () => {
  for (const provider of ["gemini", "opencode"]) {
    const parsed = parseStructuredTextQuestions(provider, USER_REPORTED_MESSAGE);
    expect(parsed, `provider=${provider}`).not.toBeNull();
    expect(parsed).toHaveLength(2);
    expect(parsed![0]!.header).toBe("급등 전 알트 탐색 방식");
    expect(parsed![1]!.header).toBe("목표 수익과 보유 기간");
  }
  expect(parseTextQuestions("gemini", USER_REPORTED_MESSAGE)).toHaveLength(2);
});

it("parses question JSON even when 비서실장의 조언 with backticks is written AFTER the JSON block", () => {
  const reversed = [
    "아래 질문 카드에서 선택해 주세요.",
    "",
    '{"questions":[{"header":"방식","question":"어떤 방식으로 할까요?","options":[{"label":"A (권장)","description":"설명 A"}]}]}',
    "",
    "## [비서실장의 조언]",
    "`599종목` 데이터에서 전조 신호부터 먼저 확인하세요.",
  ].join("\n");
  const parsed = parseStructuredTextQuestions("gemini", reversed);
  expect(parsed).toHaveLength(1);
  expect(parsed![0]!.header).toBe("방식");
});
