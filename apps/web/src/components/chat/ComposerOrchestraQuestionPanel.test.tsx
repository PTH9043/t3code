import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerOrchestraQuestionPanel } from "./ComposerOrchestraQuestionPanel";

describe("ComposerOrchestraQuestionPanel", () => {
  it("renders the orchestra question with its options as a card", () => {
    const markup = renderToStaticMarkup(
      <ComposerOrchestraQuestionPanel
        question="세 좌석이 분담할 최우선 작업은?"
        options={["진입 전략 개발 (권장)", "미커밋 변경 정리 커밋"]}
        isAnswering={false}
        onAnswer={() => {}}
      />,
    );

    expect(markup).toContain("오케스트라 질문");
    expect(markup).toContain("세 좌석이 분담할 최우선 작업은?");
    expect(markup).toContain("진입 전략 개발 (권장)");
    expect(markup).toContain("미커밋 변경 정리 커밋");
    // Numbered shortcuts, mirroring the provider question card.
    expect(markup).toContain(">1</kbd>");
    expect(markup).toContain(">2</kbd>");
    // Options are buttons the person can click to answer directly.
    expect(markup).toContain("<button");
  });

  it("falls back to a type-your-answer hint when the question has no options", () => {
    const markup = renderToStaticMarkup(
      <ComposerOrchestraQuestionPanel
        question="자유롭게 방향을 알려주세요."
        options={[]}
        isAnswering={false}
        onAnswer={() => {}}
      />,
    );

    expect(markup).toContain("자유롭게 방향을 알려주세요.");
    expect(markup).toContain("아래 입력창에 답을 쓰거나 이미지를 첨부해 보내세요.");
    expect(markup).not.toContain("</kbd>");
  });
});
