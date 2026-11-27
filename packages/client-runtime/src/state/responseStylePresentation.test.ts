import { resolveResponseStyle, type ThreadResponseStyle } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countFactStatusBadges,
  deriveResponseStyleUiProfile,
  findFactStatusBadges,
  resolveResponseStyleUiProfile,
  responseStyleComposerPlaceholder,
  splitStructuredStyleSections,
  summarizeAdviceLine,
} from "./responseStylePresentation.ts";

const style = (patch: Partial<ThreadResponseStyle> = {}): ThreadResponseStyle => ({
  preset: "default",
  tone: "",
  length: "",
  explanation: "",
  instructions: "",
  ...patch,
});

describe("response style UI profile", () => {
  it("maps every preset to its variant and header pill", () => {
    const profile = (preset: ThreadResponseStyle["preset"]) =>
      deriveResponseStyleUiProfile({ style: style({ preset }) }, "global");
    expect(profile("concise")).toEqual({
      variant: "compact-brief",
      scopeLabel: "전역 스타일",
      personaBadge: "간결 브리핑",
      hasStructuredSections: false,
      defaultCollapseToolGroups: true,
    });
    expect(profile("detailed")).toMatchObject({
      variant: "deep-analysis",
      personaBadge: "상세 기술 분석",
      defaultCollapseToolGroups: false,
    });
    expect(profile("friendly")).toMatchObject({
      variant: "warm-conversational",
      personaBadge: "친근한 대화",
      defaultCollapseToolGroups: false,
    });
    expect(profile("professional")).toMatchObject({
      variant: "executive-command",
      personaBadge: "전문 보고",
      defaultCollapseToolGroups: false,
    });
  });

  it("treats a missing or empty style as not configured", () => {
    const unset = {
      variant: "standard",
      scopeLabel: "미설정",
      personaBadge: undefined,
      hasStructuredSections: false,
      defaultCollapseToolGroups: false,
    };
    expect(deriveResponseStyleUiProfile({ style: null }, "global")).toEqual(unset);
    expect(deriveResponseStyleUiProfile({ style: style() }, "thread")).toEqual(unset);
    expect(deriveResponseStyleUiProfile({ style: style({ tone: "  " }) }, "thread")).toEqual(unset);
  });

  it("keeps free text without a preset on the standard look", () => {
    expect(
      deriveResponseStyleUiProfile({ style: style({ tone: "반말로 짧게" }) }, "thread"),
    ).toEqual({
      variant: "standard",
      scopeLabel: "이 방 전용",
      personaBadge: undefined,
      hasStructuredSections: false,
      defaultCollapseToolGroups: false,
    });
  });

  it("detects the executive persona from any free-text field, whatever the preset", () => {
    for (const field of ["tone", "length", "explanation", "instructions"] as const) {
      expect(
        deriveResponseStyleUiProfile(
          { style: style({ preset: "concise", [field]: "당신은 최고 비서실장입니다." }) },
          "global",
        ),
      ).toMatchObject({
        variant: "executive-command",
        personaBadge: "최고 비서실장",
        hasStructuredSections: false,
        defaultCollapseToolGroups: false,
      });
    }
    expect(
      deriveResponseStyleUiProfile(
        {
          style: style({
            preset: "professional",
            instructions: "최고 비서실장으로서 ## [보고] 와 ## [비서실장의 조언] 으로 나눠 답한다.",
          }),
        },
        "thread",
      ),
    ).toEqual({
      variant: "executive-command",
      scopeLabel: "이 방 전용",
      personaBadge: "최고 비서실장 · 전문",
      hasStructuredSections: true,
      defaultCollapseToolGroups: false,
    });
  });

  it("detects the executive structure from the report heading alone", () => {
    expect(
      deriveResponseStyleUiProfile(
        { style: style({ explanation: "항상 ## [보고] 로 시작한다." }) },
        "global",
      ),
    ).toMatchObject({
      variant: "executive-command",
      personaBadge: "전문 보고",
      hasStructuredSections: true,
    });
  });

  it("renders a preset this build does not know as standard unless the executive rule matches", () => {
    const unknown = (preset: string, instructions: string) =>
      deriveResponseStyleUiProfile(
        { style: { ...style({ instructions }), preset } as ThreadResponseStyle },
        "global",
      );
    expect(unknown("poetic", "")).toMatchObject({ variant: "standard", personaBadge: undefined });
    expect(unknown("toString", "")).toMatchObject({ variant: "standard" });
    expect(unknown("poetic", "비서실장처럼")).toMatchObject({
      variant: "executive-command",
      personaBadge: "최고 비서실장",
    });
  });

  it("labels the scope the same way the contract resolves the style", () => {
    const room = style({ preset: "detailed" });
    const global = style({ preset: "concise" });
    const settings = {
      globalResponseStyle: global,
      threadResponseStyles: { room, blank: style() },
    };
    expect(resolveResponseStyleUiProfile(settings, "room")).toEqual(
      deriveResponseStyleUiProfile({ style: room }, "thread"),
    );
    expect(resolveResponseStyleUiProfile(settings, "room").scopeLabel).toBe("이 방 전용");
    for (const threadId of ["blank", "other", null, undefined]) {
      expect(resolveResponseStyle(settings, threadId).style).toBe(global);
      expect(resolveResponseStyleUiProfile(settings, threadId)).toMatchObject({
        variant: "compact-brief",
        scopeLabel: "전역 스타일",
      });
    }
    expect(resolveResponseStyleUiProfile({ globalResponseStyle: null }, "room").scopeLabel).toBe(
      "미설정",
    );
    expect(resolveResponseStyleUiProfile({}, "room").scopeLabel).toBe("미설정");
  });
});

describe("response style composer placeholder", () => {
  it("returns one placeholder per variant and none for standard", () => {
    expect(responseStyleComposerPlaceholder("standard")).toBeUndefined();
    expect(responseStyleComposerPlaceholder("compact-brief")).toBe(
      "핵심만 빠르게 확인할 질문을 입력하세요…",
    );
    expect(responseStyleComposerPlaceholder("deep-analysis")).toBe(
      "심층 분석·설계·원인 규명이 필요한 과제를 입력하세요…",
    );
    expect(responseStyleComposerPlaceholder("executive-command")).toBe(
      "최고 비서실장에게 분석·코드 검증·투자 판단을 지시하세요…",
    );
    expect(responseStyleComposerPlaceholder("warm-conversational")).toBe(
      "편하게 물어보세요. 무엇이든 함께 살펴볼게요…",
    );
  });
});

describe("structured style sections", () => {
  const full = [
    "## [보고]",
    "",
    "배포는 [확인 완료] 상태입니다. 😀",
    "",
    "```md",
    "## [비서실장의 조언]",
    "```",
    "",
    "> ## [비서실장의 조언]",
    "",
    "## [비서실장의 조언]",
    "",
    "**지금은** 롤백 계획부터 세우세요.",
    "",
    "## 참고",
    "",
    "부록입니다.",
    "",
  ].join("\n");

  it("returns plain text untouched", () => {
    for (const text of ["", "안녕하세요.\n\n## 제목\n본문", "## [보고] 요약\n본문", "\r\n"]) {
      expect(splitStructuredStyleSections(text)).toEqual({
        report: text,
        advice: undefined,
        hasReportHeading: false,
        trailing: undefined,
      });
    }
  });

  it("removes only the leading report heading line", () => {
    expect(splitStructuredStyleSections("## [보고]\n\n본문\n## 다음\n끝")).toEqual({
      report: "\n본문\n## 다음\n끝",
      advice: undefined,
      hasReportHeading: true,
      trailing: undefined,
    });
    expect(splitStructuredStyleSections("\n  \n##[보고]  \r\n본문").report).toBe("\n  \n본문");
    expect(splitStructuredStyleSections("서론\n## [보고]\n본문")).toMatchObject({
      report: "서론\n## [보고]\n본문",
      hasReportHeading: false,
    });
  });

  it("splits the report from the advice", () => {
    expect(
      splitStructuredStyleSections("## [보고]\n결과\n\n## [비서실장의 조언]\n\n조언\n"),
    ).toEqual({
      report: "결과\n\n",
      advice: "조언",
      hasReportHeading: true,
      trailing: undefined,
    });
    expect(
      splitStructuredStyleSections("결과\r\n##[비서실장의 조언] \r\n조언 1\r\n조언 2"),
    ).toEqual({
      report: "결과\r\n",
      advice: "조언 1\r\n조언 2",
      hasReportHeading: false,
      trailing: undefined,
    });
  });

  it("ends the advice at the next level-2 heading and keeps what follows", () => {
    expect(
      splitStructuredStyleSections("결과\n## [비서실장의 조언]\n조언\n### 세부\n더\n## 참고\n부록"),
    ).toEqual({
      report: "결과\n",
      advice: "조언\n### 세부\n더",
      hasReportHeading: false,
      trailing: "## 참고\n부록",
    });
  });

  it("ignores headings inside code fences and blockquotes", () => {
    for (const text of [
      "결과\n```md\n## [비서실장의 조언]\n조언\n```\n끝",
      "결과\n~~~\n```\n## [비서실장의 조언]\n~~~~\n끝",
      "결과\n  ```\n## [비서실장의 조언]\n",
      "결과\n> ## [비서실장의 조언]\n> 조언\n",
      "결과\n    ## [비서실장의 조언]\n",
    ]) {
      expect(splitStructuredStyleSections(text)).toMatchObject({ report: text, advice: undefined });
    }
    expect(
      splitStructuredStyleSections(
        "```\n코드\n```\n## [비서실장의 조언]\n조언\n```\n## 코드 속 제목\n```\n끝",
      ),
    ).toEqual({
      report: "```\n코드\n```\n",
      advice: "조언\n```\n## 코드 속 제목\n```\n끝",
      hasReportHeading: false,
      trailing: undefined,
    });
    expect(splitStructuredStyleSections(full)).toEqual({
      report:
        "\n배포는 [확인 완료] 상태입니다. 😀\n\n```md\n## [비서실장의 조언]\n```\n\n> ## [비서실장의 조언]\n\n",
      advice: "**지금은** 롤백 계획부터 세우세요.",
      hasReportHeading: true,
      trailing: "## 참고\n\n부록입니다.\n",
    });
  });

  it("keeps a half-typed heading in the report while streaming", () => {
    for (const text of ["결과\n## [비서실장의", "결과\n## [비서실장의 조언]", "## [보고]"]) {
      expect(splitStructuredStyleSections(text)).toEqual({
        report: text,
        advice: undefined,
        hasReportHeading: false,
        trailing: undefined,
      });
    }
    expect(splitStructuredStyleSections("결과\n## [비서실장의 조언]\n")).toMatchObject({
      report: "결과\n",
      advice: "",
    });
  });

  it("never throws on a streaming prefix and never moves a section once it appeared", () => {
    let previous = splitStructuredStyleSections("");
    for (let length = 0; length <= full.length; length += 1) {
      const prefix = full.slice(0, length);
      const current = splitStructuredStyleSections(prefix);
      if (current.advice === undefined) {
        expect(current.trailing).toBeUndefined();
        expect(current.report).toBe(
          current.hasReportHeading ? prefix.slice("## [보고]\n".length) : prefix,
        );
      }
      if (previous.hasReportHeading) expect(current.hasReportHeading).toBe(true);
      if (previous.advice !== undefined) {
        // The advice keeps its start: it only grows, except that the half-typed next
        // heading leaves it once that heading is recognisable.
        expect(current.report).toBe(previous.report);
        expect(
          current.trailing !== undefined && previous.trailing === undefined
            ? previous.advice.startsWith(current.advice ?? "\n")
            : current.advice?.startsWith(previous.advice),
        ).toBe(true);
      }
      if (previous.trailing !== undefined) {
        expect(current.advice).toBe(previous.advice);
        expect(current.trailing?.startsWith(previous.trailing)).toBe(true);
      }
      previous = current;
    }
    expect(previous).toEqual(splitStructuredStyleSections(full));
    expect(previous.trailing).toBe("## 참고\n\n부록입니다.\n");
  });
});

describe("fact status badges", () => {
  it("finds every label in order with its tone and offsets", () => {
    const text =
      "[확인 완료] a [합리적 추정] b [검증 필요] c [미확인] d [오류·반증] e [잠재력] f [현재 역량] g [검증된 성과]";
    const badges = findFactStatusBadges(text);
    expect(badges.map(({ label, tone }) => [label, tone])).toEqual([
      ["확인 완료", "success"],
      ["합리적 추정", "info"],
      ["검증 필요", "warning"],
      ["미확인", "muted"],
      ["오류·반증", "danger"],
      ["잠재력", "warning"],
      ["현재 역량", "info"],
      ["검증된 성과", "success"],
    ]);
    expect(badges.map(({ start, end }) => text.slice(start, end))).toEqual(
      badges.map(({ label }) => `[${label}]`),
    );
  });

  it("counts only the exact bracket form", () => {
    expect(
      findFactStatusBadges(
        "(`확인 완료`) 확인 완료 [확인완료] [ 확인 완료 ] [오류/반증] [완료] 【미확인】 [검증 필요",
      ),
    ).toEqual([]);
    expect(findFactStatusBadges("**[미확인]** 값")).toEqual([
      { start: 2, end: 7, label: "미확인", tone: "muted" },
    ]);
  });

  it("ignores inline code and fenced code", () => {
    const text = [
      "`[확인 완료]` 와 ``코드 ` [미확인]`` 는 코드입니다. [검증 필요]",
      "```",
      "[오류·반증]",
      "```",
      "닫히지 않은 ` 뒤의 [잠재력]",
      "~~~ts",
      "const tag = '[현재 역량]';",
    ].join("\n");
    const badges = findFactStatusBadges(text);
    expect(badges.map(({ label }) => label)).toEqual(["검증 필요", "잠재력"]);
    expect(badges.map(({ start, end }) => text.slice(start, end))).toEqual([
      "[검증 필요]",
      "[잠재력]",
    ]);
  });

  it("counts per label with a total", () => {
    expect(countFactStatusBadges("[미확인] [확인 완료] [미확인] `[미확인]`")).toEqual({
      counts: {
        "확인 완료": 1,
        "합리적 추정": 0,
        "검증 필요": 0,
        미확인: 2,
        오류·반증: 0,
        잠재력: 0,
        "현재 역량": 0,
        "검증된 성과": 0,
      },
      total: 3,
    });
    expect(countFactStatusBadges("").total).toBe(0);
  });
});

describe("advice summary", () => {
  it("takes the first sentence of the first line with words and strips emphasis", () => {
    expect(
      summarizeAdviceLine(
        "\n---\n- **지금은** `main` 배포를 _미루세요_. 이유는 두 가지입니다.\n- 둘째",
      ),
    ).toBe("지금은 main 배포를 미루세요.");
    expect(summarizeAdviceLine("1. ~~보류~~ 진행하세요\n2. 다음")).toBe("보류 진행하세요");
    expect(summarizeAdviceLine("> ### snake_case 값 2 * 3 은 v1.2 기준입니다!")).toBe(
      "snake_case 값 2 * 3 은 v1.2 기준입니다!",
    );
  });

  it("returns nothing when there is no advice", () => {
    expect(summarizeAdviceLine(undefined)).toBeUndefined();
    expect(summarizeAdviceLine("")).toBeUndefined();
    expect(summarizeAdviceLine(" \n---\n**")).toBeUndefined();
  });

  it("truncates long Korean text to the limit including the ellipsis", () => {
    const long = "가나다라마바사아자차카타파하".repeat(20);
    const summary = summarizeAdviceLine(long);
    expect(summary).toBe(`${long.slice(0, 119)}…`);
    expect(summarizeAdviceLine(long, 10)).toBe("가나다라마바사아자…");
    expect(summarizeAdviceLine("가나다라 마바사", 6)).toBe("가나다라…");
    expect(summarizeAdviceLine("가나다", 3)).toBe("가나다");
    expect(summarizeAdviceLine("가나다", 0)).toBe("…");
  });

  it("never cuts through an emoji", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `가나${family}😀👍🏽한글`;
    expect(summarizeAdviceLine(text, 4)).toBe(`가나${family}…`);
    expect(summarizeAdviceLine(text, 5)).toBe(`가나${family}😀…`);
    expect(summarizeAdviceLine(text, 6)).toBe(`가나${family}😀👍🏽…`);
    expect(summarizeAdviceLine(text, 3)).toBe("가나…");
  });

  it("keeps emoji whole on runtimes without Intl.Segmenter", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    try {
      const family = "👨‍👩‍👧‍👦";
      const text = `가나${family}😀👍🏽❤️한글`;
      expect(summarizeAdviceLine(text, 4)).toBe(`가나${family}…`);
      expect(summarizeAdviceLine(text, 6)).toBe(`가나${family}😀👍🏽…`);
      expect(summarizeAdviceLine(text, 7)).toBe(`가나${family}😀👍🏽❤️…`);
    } finally {
      if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
    }
  });

  it("strips trailing question card JSON even when the closing fence has a stray tokenizer suffix like ```Ble", () => {
    const raw = [
      "## [보고]",
      "설계 정리 완료",
      "",
      "## [비서실장의 조언]",
      "설계를 확인한 뒤 아래 카드에서 선택해 주세요.",
      "",
      "아래 질문 카드에서 선택해 주세요.",
      "",
      "```json",
      '{"questions":[{"header":"DB 전용 스레드 설계 승인","question":"진행할까요?","options":[{"label":"확정 (권장)","description":"구현"}]}]}',
      "```Ble",
    ].join("\n");
    const split = splitStructuredStyleSections(raw);
    expect(split.advice).toBe("설계를 확인한 뒤 아래 카드에서 선택해 주세요.");
  });
});
