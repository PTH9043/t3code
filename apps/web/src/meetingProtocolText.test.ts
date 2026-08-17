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

  it("renders every task-graph node with assignee, task, and dependencies", () => {
    const output = formatMeetingProtocolText(
      `<t3_task_graph>${JSON.stringify({
        summary: "서버 구현 계획",
        nextAction: "구현 노드부터 실행",
        nodes: [
          { id: "impl", title: "구현", participantId: "codex", task: "핸들러를 작성한다." },
          { id: "verify", title: "검증", agent: "fable", dependsOn: ["impl"] },
        ],
      })}</t3_task_graph>`,
    );
    expect(output).toContain("📋 실행 계획");
    expect(output).toContain("작업 2개:");
    expect(output).toContain("1. **구현** — codex");
    expect(output).toContain("핸들러를 작성한다.");
    expect(output).toContain("2. **검증** — fable (의존: impl)");
    expect(output).toContain("다음: 구현 노드부터 실행");
  });

  it("keeps validation evidence, confidence, and follow-ups visible", () => {
    const output = formatMeetingProtocolText(
      `<t3_validation>${JSON.stringify({
        verdict: "pass",
        confidence: "high",
        summary: "생성자 판정을 독립 재검증으로 확인했다.",
        evidence: ["ruff 버전 동일성 재확인", "master 트리는 해당 파일에서 클린"],
        failureClassification: null,
        nextAction: "확정 판정을 보고 노드에 반영",
        followUpNodes: [],
      })}</t3_validation>`,
    );
    expect(output).toContain("✅ 검증 · pass · 신뢰도 high");
    expect(output).toContain("증거:");
    expect(output).toContain("- ruff 버전 동일성 재확인");
    expect(output).toContain("- master 트리는 해당 파일에서 클린");
    expect(output).toContain("다음: 확정 판정을 보고 노드에 반영");
  });

  it("shows the question embedded in a chair verdict with the reply hint", () => {
    const output = formatMeetingProtocolText(
      `<t3_chair_verdict>${JSON.stringify({
        summary: "사용자 결정이 필요하다.",
        consensusReached: null,
        nextSpeakerId: null,
        question: {
          question: "이전 기록을 붙여넣어 줄래요?",
          options: ["예", "아니오"],
          context: "",
        },
      })}</t3_chair_verdict>`,
    );
    expect(output).toContain("❓ 이전 기록을 붙여넣어 줄래요?");
    expect(output).toContain("선택지: 예 · 아니오");
    expect(output).toContain("답장을 보내면 회의가 이어집니다");
  });

  it("shows synthesis confidence, conflicts, and memory candidates", () => {
    const output = formatMeetingProtocolText(
      `<t3_synthesis>${JSON.stringify({
        finalOutput: "CI는 이 코드를 본 적이 없다.",
        confidence: "high",
        conflictDetected: true,
        nextAction: "교차 검증 노드 실행",
        repairApproved: null,
        memoryCandidates: [{ title: "ruff 핀 확인 절차" }],
      })}</t3_synthesis>`,
    );
    expect(output).toContain("🏁 최종 결과 · 신뢰도 high");
    expect(output).toContain("충돌이 남아");
    expect(output).toContain("메모리 후보: ruff 핀 확인 절차");
    expect(output).toContain("다음: 교차 검증 노드 실행");
  });

  it("renders a still-streaming tag as a live block instead of raw JSON", () => {
    const streaming =
      '분석 중이다. <t3_chair_verdict>{"summary":"아직 정리 중인 합의안이며 \\"인용\\"도 섞';
    const output = formatMeetingProtocolText(streaming);
    expect(output).toContain("분석 중이다.");
    expect(output).not.toContain("<t3_chair_verdict>");
    expect(output).not.toContain('"summary"');
    expect(output).toContain("👑 의장 정리");
    expect(output).toContain("작성 중");
    expect(output).toContain('아직 정리 중인 합의안이며 "인용"도 섞');
  });

  it("shows a bare streaming block before any payload text arrives", () => {
    const output = formatMeetingProtocolText('<t3_validation>{"verd');
    expect(output).not.toContain("<t3_validation>");
    expect(output).toContain("🔍 검증");
    expect(output).toContain("작성 중");
  });

  it("falls back to a fenced block when the payload is not JSON", () => {
    const output = formatMeetingProtocolText("<t3_synthesis>깨진 페이로드</t3_synthesis>");
    expect(output).not.toContain("<t3_synthesis>");
    expect(output).toContain("🏁 최종 결과");
    expect(output).toContain("깨진 페이로드");
  });
});
