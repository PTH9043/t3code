import {
  DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT,
  type GlobalAssistantConfig,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const mockAtomState: { globalAssistant: GlobalAssistantConfig | null } = {
  globalAssistant: null,
};

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: () => mockAtomState.globalAssistant,
  };
});

vi.mock("~/state/entities", () => ({
  useActiveEnvironmentId: () => null,
}));

let ChatMarkdown: typeof import("../ChatMarkdown").default;
let ResponseStyleMessageBody: typeof import("./ResponseStyleMessageBody").ResponseStyleMessageBody;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    location: { href: "http://localhost/" },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      offsetHeight: 0,
    },
  });

  ChatMarkdown = (await import("../ChatMarkdown")).default;
  ({ ResponseStyleMessageBody } = await import("./ResponseStyleMessageBody"));
}, 30_000);

const answer = [
  "## [보고]",
  "매출은 늘었습니다. [확인 완료] 표기는 `[검증 필요]` 형식입니다.",
  "",
  "```text",
  "[미확인] 코드 안",
  "```",
  "",
  "## [비서실장의 조언]",
  "다음 분기 계약부터 검토하십시오. [합리적 추정]",
  "",
  "## 참고",
  "부록입니다.",
  "",
].join("\n");
const adviceHeadingEnd = answer.indexOf("## [비서실장의 조언]\n") + "## [비서실장의 조언]\n".length;

// Generated element ids depend on how deep a component sits, not on what it renders.
const withoutGeneratedIds = (markup: string) => markup.replaceAll(/ id="base-ui-[^"]*"/g, "");
const plain = (text: string, isStreaming = false) =>
  withoutGeneratedIds(
    renderToStaticMarkup(<ChatMarkdown text={text} cwd={undefined} isStreaming={isStreaming} />),
  );
const body = (
  text: string,
  variant: Parameters<typeof ResponseStyleMessageBody>[0]["variant"],
  isStreaming = false,
) =>
  withoutGeneratedIds(
    renderToStaticMarkup(
      <ResponseStyleMessageBody
        text={text}
        variant={variant}
        cwd={undefined}
        isStreaming={isStreaming}
      />,
    ),
  );
/** Top-level blocks of the body, in order: the advice callout or a markdown block. */
const slots = (markup: string) =>
  [...markup.matchAll(/<(aside|div) [^>]*?(data-response-style-advice|class="chat-markdown )/g)]
    .filter((match, index, all) => match[1] === "aside" || all[index - 1]?.[1] !== "aside")
    .map((match) => (match[1] === "aside" ? "advice" : "markdown"));

describe("ResponseStyleMessageBody", () => {
  it("renders every non-executive style exactly like plain markdown", () => {
    for (const variant of [
      "standard",
      "compact-brief",
      "deep-analysis",
      "warm-conversational",
    ] as const) {
      expect(body(answer, variant)).toBe(plain(answer));
    }
  });

  it("renders an executive answer without the advice heading as one block", () => {
    const text = "## [보고]\n요약입니다.\n\n- 항목 하나\n- 항목 둘\n";
    expect(body(text, "executive-command")).toBe(plain(text));
  });

  it("puts the advice of an executive answer in its own callout between report and trailing text", () => {
    const markup = body(answer, "executive-command");
    expect(slots(markup)).toEqual(["markdown", "advice", "markdown"]);
    expect(markup.match(/data-response-style-advice/g)).toHaveLength(1);
    const [report = "", rest = ""] = markup.split("<aside");
    const [advice = "", trailing = ""] = rest.split("</aside>");
    expect(report).toContain("매출은 늘었습니다.");
    expect(report).not.toContain("비서실장의 조언");
    expect(advice).toContain('aria-label="비서실장의 조언"');
    expect(advice).toContain(">비서실장의 조언</p>");
    expect(advice).toContain("다음 분기 계약부터 검토하십시오.");
    expect(advice).not.toContain("<h2");
    expect(trailing).toContain("부록입니다.");
    expect(trailing).toContain("참고</h2>");
  });

  it("shows status tags as badges for the executive style only, never inside code", () => {
    const markup = body(answer, "executive-command");
    expect(markup).toContain('data-markdown-copy="[확인 완료]"');
    expect(markup).toContain('data-markdown-copy="[합리적 추정]"');
    expect(markup.match(/data-fact-status=/g)).toHaveLength(2);
    expect(markup).toContain("[검증 필요]");
    expect(markup).toContain("[미확인] 코드 안");
    expect(body(answer, "standard")).not.toContain("data-fact-status");
  });

  it("keeps each part in its slot from the moment the advice heading completes", () => {
    const sequences = Array.from({ length: answer.length + 1 }, (_, length) =>
      slots(body(answer.slice(0, length), "executive-command", true)),
    );
    for (const sequence of sequences.slice(0, adviceHeadingEnd)) {
      expect(sequence).toEqual(["markdown"]);
    }
    for (const sequence of sequences.slice(adviceHeadingEnd)) {
      expect(sequence.slice(0, 2)).toEqual(["markdown", "advice"]);
    }
    const reportAfterHeading = body(
      answer.slice(0, adviceHeadingEnd),
      "executive-command",
      true,
    ).split("<aside")[0];
    expect(body(answer, "executive-command", true).split("<aside")[0]).toBe(reportAfterHeading);
  });

  it("does not change layout when streaming ends", () => {
    expect(slots(body(answer, "executive-command", false))).toEqual(
      slots(body(answer, "executive-command", true)),
    );
  });

  it("returns to the plain rendering when the style is switched back", () => {
    expect(body(answer, "executive-command")).not.toBe(plain(answer));
    expect(body(answer, "standard")).toBe(plain(answer));
  });

  describe("output contract warning banner", () => {
    const executiveGlobalAssistant: GlobalAssistantConfig = {
      enabled: true,
      defaultModelSelection: null,
      personaName: "전속 비서실장",
      preset: "professional",
      voiceAndTone: "냉철하고 전문적인 어조",
      styleExamples: [],
      corePrinciples: [],
      lengthPolicy: "",
      explanationPolicy: "",
      outputSections: [
        {
          id: "section-1",
          heading: "## [보고]",
          position: "start",
          required: true,
          constraint: "핵심 결론부터 제시한다.",
        },
        {
          id: "section-2",
          heading: "## [비서실장의 조언]",
          position: "end",
          required: true,
          constraint: "모든 답변 맨 마지막에 단 한 줄로 작성한다.",
          maxLines: 1,
        },
      ],
      domainPlaybooks: [],
      extraInstructions: "",
      enforcement: DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT,
      characterOverridesVoice: false,
    };

    const questionCardJson = [
      "아래 질문 카드에서 선택해 주세요.",
      "",
      "```json",
      JSON.stringify({
        questions: [
          {
            header: "방식",
            question: "어느 방안으로 진행할까요?",
            options: [
              { label: "방안 1 (권장)", description: "빠른 수정" },
              { label: "방안 2", description: "전체 개편" },
            ],
          },
        ],
      }),
      "```",
    ].join("\n");

    const turnAnswerBody = (text: string) =>
      withoutGeneratedIds(
        renderToStaticMarkup(
          <ResponseStyleMessageBody
            text={text}
            variant="executive-command"
            cwd={undefined}
            isStreaming={false}
            isTurnAnswer={true}
          />,
        ),
      );

    afterEach(() => {
      mockAtomState.globalAssistant = null;
    });

    it("does not show a warning banner on short question-card-only confirmation turns", () => {
      mockAtomState.globalAssistant = executiveGlobalAssistant;
      expect(turnAnswerBody(questionCardJson)).not.toContain("data-output-contract-warning");
      expect(
        turnAnswerBody(`적용 범위를 먼저 확인하겠습니다.\n\n${questionCardJson}`),
      ).not.toContain("data-output-contract-warning");
    });

    it("does not show a warning banner when a trailing question card follows a valid 1-line advice section", () => {
      mockAtomState.globalAssistant = executiveGlobalAssistant;
      const reply = [
        "## [보고]",
        "분석을 완료했습니다.",
        "",
        "## [비서실장의 조언]",
        "방안 1로 진행하십시오.",
        "",
        questionCardJson,
      ].join("\n");
      expect(turnAnswerBody(reply)).not.toContain("data-output-contract-warning");
    });

    it("does not show a warning banner on API Error or safety refusal messages", () => {
      mockAtomState.globalAssistant = executiveGlobalAssistant;
      expect(
        turnAnswerBody("API Error: Opus 5.5's safeguards flagged this session."),
      ).not.toContain("data-output-contract-warning");
      expect(turnAnswerBody("Anthropic 안전장치가 이 요청을 거절했습니다 [cyber].")).not.toContain(
        "data-output-contract-warning",
      );
    });

    it("shows the warning banner when ## [비서실장의 조언] is genuinely missing from a report turn", () => {
      mockAtomState.globalAssistant = executiveGlobalAssistant;
      const missingAdvice = "## [보고]\n핵심 분석만 작성하고 조언을 빠뜨렸습니다.";
      const markup = turnAnswerBody(missingAdvice);
      expect(markup).toContain("data-output-contract-warning");
      expect(markup).toContain("전역 출력 형식 일부 누락: ## [비서실장의 조언]");
    });
  });
});
