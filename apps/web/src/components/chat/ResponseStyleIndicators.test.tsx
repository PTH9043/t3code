import { deriveResponseStyleUiProfile } from "@t3tools/client-runtime/state/response-style-presentation";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { STANDARD_RESPONSE_STYLE_UI_PROFILE } from "~/responseStyleUi";
import { ResponseStylePill, ResponseStyleResultSummary } from "./ResponseStyleIndicators";

const blank = { tone: "", length: "", explanation: "", instructions: "" };
const executive = deriveResponseStyleUiProfile(
  { style: { ...blank, preset: "professional", instructions: "최고 비서실장으로서 보고하세요." } },
  "thread",
);
const answer =
  "매출은 늘었습니다. [확인 완료]\n\n## [비서실장의 조언]\n계약부터 검토하십시오. 이후 보강합니다.\n";

describe("ResponseStylePill", () => {
  it("shows the persona with a short scope", () => {
    const markup = renderToStaticMarkup(<ResponseStylePill profile={executive} />);
    expect(markup).toContain("최고 비서실장 · 전문 · 이 방");
    expect(markup).toContain('data-response-style-pill="executive-command"');
    expect(markup).toContain('data-slot="badge"');
    expect(
      renderToStaticMarkup(
        <ResponseStylePill
          profile={deriveResponseStyleUiProfile(
            { style: { ...blank, preset: "concise" } },
            "global",
          )}
        />,
      ),
    ).toContain("간결 브리핑 · 전역");
  });

  it("renders nothing without a named style", () => {
    expect(
      renderToStaticMarkup(<ResponseStylePill profile={STANDARD_RESPONSE_STYLE_UI_PROFILE} />),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <ResponseStylePill
          profile={deriveResponseStyleUiProfile(
            { style: { ...blank, preset: "default", tone: "반말" } },
            "global",
          )}
        />,
      ),
    ).toBe("");
  });
});

describe("ResponseStyleResultSummary", () => {
  it("shows the advice teaser and the status tally for an executive answer", () => {
    const markup = renderToStaticMarkup(
      <ResponseStyleResultSummary text={answer} variant="executive-command" />,
    );
    expect(markup).toContain("비서실장의 조언 · </span>계약부터 검토하십시오.</p>");
    expect(markup).not.toContain("이후 보강합니다.");
    expect(markup).toContain(">확인 완료 1</p>");
  });

  it("hides the tally when no status tag was used", () => {
    const markup = renderToStaticMarkup(
      <ResponseStyleResultSummary
        text={"본문\n## [비서실장의 조언]\n서두르지 마십시오.\n"}
        variant="executive-command"
      />,
    );
    expect(markup).toContain("서두르지 마십시오.");
    expect(markup.match(/<p/g)).toHaveLength(1);
  });

  it("renders nothing for other styles or answers without advice", () => {
    expect(
      renderToStaticMarkup(<ResponseStyleResultSummary text={answer} variant="standard" />),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <ResponseStyleResultSummary text="결과입니다. [확인 완료]" variant="executive-command" />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <ResponseStyleResultSummary text={undefined} variant="executive-command" />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <ResponseStyleResultSummary
          text={"본문\n## [비서실장의 조언]\n"}
          variant="executive-command"
        />,
      ),
    ).toBe("");
  });
});
