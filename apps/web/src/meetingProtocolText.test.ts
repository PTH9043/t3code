import { describe, expect, it } from "vite-plus/test";

import { formatMeetingProtocolText } from "./meetingProtocolText";

describe("formatMeetingProtocolText", () => {
  it("leaves ordinary text untouched", () => {
    const text = "서버 쪽에 구현하는 편이 맞다.\n\n- 근거 1\n- 근거 2";
    expect(formatMeetingProtocolText(text)).toBe(text);
  });

  it("renders a chair verdict as readable Markdown, not raw JSON", () => {
    const verdict = {
      summary: "사용자 결정이 확정됐다: 이전 회의 기록을 확보한 뒤 재개한다.",
      consensusReached: false,
      nextSpeakerId: null,
      question: null,
    };
    const output = formatMeetingProtocolText(
      `<t3_chair_verdict>${JSON.stringify(verdict)}</t3_chair_verdict>`,
    );
    expect(output).not.toContain("<t3_chair_verdict>");
    expect(output).not.toContain("consensusReached");
    expect(output).toContain("👑 의장 정리");
    expect(output).toContain("이전 회의 기록을 확보한 뒤 재개한다");
    expect(output).toContain("합의: ❌");
  });

  it("renders a question with its options and the reply hint", () => {
    const output = formatMeetingProtocolText(
      `앞말.<t3_question>${JSON.stringify({
        question: "예산 상한이 있나요?",
        options: ["없음", "100만원"],
        context: "비용 갈림",
      })}</t3_question>뒷말.`,
    );
    expect(output).toContain("앞말.");
    expect(output).toContain("뒷말.");
    expect(output).toContain("❓ 사용자에게 질문");
    expect(output).toContain("예산 상한이 있나요?");
    expect(output).toContain("없음 · 100만원");
    expect(output).not.toContain("<t3_question>");
  });

  it("turns responds_to into a small attribution line", () => {
    const output = formatMeetingProtocolText(
      "동의한다.<t3_responds_to>claudeAgent, grok</t3_responds_to>",
    );
    expect(output).toContain("↩︎ claudeAgent, grok에게");
    expect(output).not.toContain("<t3_responds_to>");
  });

  it("summarizes a task graph by its node titles", () => {
    const output = formatMeetingProtocolText(
      `<t3_task_graph>${JSON.stringify({
        summary: "서버 구현 계획",
        nodes: [{ title: "구현" }, { title: "검증" }],
      })}</t3_task_graph>`,
    );
    expect(output).toContain("📋 실행 계획");
    expect(output).toContain("작업 2개: 구현 → 검증");
  });

  it("keeps a still-streaming tag as-is until it completes", () => {
    const streaming = '분석 중이다. <t3_chair_verdict>{"summary":"아직';
    expect(formatMeetingProtocolText(streaming)).toBe(streaming);
  });

  it("falls back to a fenced block when the payload is not JSON", () => {
    const output = formatMeetingProtocolText("<t3_synthesis>깨진 페이로드</t3_synthesis>");
    expect(output).not.toContain("<t3_synthesis>");
    expect(output).toContain("🏁 최종 결과");
    expect(output).toContain("깨진 페이로드");
  });
});
