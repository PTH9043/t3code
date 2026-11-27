import type { ThreadResponseStyle } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  conversationResponseStyleUiProfile,
  resolveComposerPlaceholder,
  responseStyleMessageSections,
  responseStyleResultSummary,
  responseStyleScopeShortLabel,
  responseStyleSettingLabel,
  STANDARD_RESPONSE_STYLE_UI_PROFILE,
} from "./responseStyleUi";

const style = (patch: Partial<ThreadResponseStyle> = {}): ThreadResponseStyle => ({
  preset: "default",
  tone: "",
  length: "",
  explanation: "",
  instructions: "",
  ...patch,
});
const executive = style({
  preset: "professional",
  instructions: "최고 비서실장으로서 보고하세요.",
});
const answer = [
  "## [보고]",
  "매출은 늘었습니다. [확인 완료] 다만 원가는 `[검증 필요]` 표기를 따릅니다. [검증 필요]",
  "",
  "## [비서실장의 조언]",
  "다음 분기 계약부터 검토하십시오. 그 뒤에 인력을 보강합니다.",
  "",
].join("\n");

describe("conversationResponseStyleUiProfile", () => {
  it("is the standard profile when nothing is configured", () => {
    expect(
      conversationResponseStyleUiProfile({
        globalStyle: undefined,
        roomStyle: undefined,
        threadId: "room",
      }),
    ).toEqual(STANDARD_RESPONSE_STYLE_UI_PROFILE);
    expect(STANDARD_RESPONSE_STYLE_UI_PROFILE.variant).toBe("standard");
  });

  it("always uses the global style even when a legacy room style is passed", () => {
    const profile = conversationResponseStyleUiProfile({
      globalStyle: executive,
      roomStyle: style({ preset: "concise" }),
      threadId: "room",
    });
    expect(profile).toMatchObject({ variant: "executive-command", scopeLabel: "전역 스타일" });
    expect(responseStyleSettingLabel(profile)).toBe("전역 스타일 · 최고 비서실장 · 전문");
    expect(responseStyleScopeShortLabel(profile.scopeLabel)).toBe("전역");
  });

  it("follows the global style when the conversation's style asks for nothing", () => {
    const profile = conversationResponseStyleUiProfile({
      globalStyle: executive,
      roomStyle: style(),
      threadId: "room",
    });
    expect(profile).toMatchObject({ variant: "executive-command", scopeLabel: "전역 스타일" });
    expect(responseStyleScopeShortLabel(profile.scopeLabel)).toBe("전역");
  });

  it("names an unset style and has no short scope for it", () => {
    expect(responseStyleSettingLabel(STANDARD_RESPONSE_STYLE_UI_PROFILE)).toBe("미설정");
    expect(responseStyleScopeShortLabel("미설정")).toBeUndefined();
  });
});

describe("responseStyleMessageSections", () => {
  it("splits only an executive answer that has its advice heading", () => {
    expect(responseStyleMessageSections(answer, "standard")).toEqual({
      report: answer,
      advice: undefined,
      trailing: undefined,
    });
    expect(responseStyleMessageSections("## [보고]\n요약입니다.\n", "executive-command")).toEqual({
      report: "## [보고]\n요약입니다.\n",
      advice: undefined,
      trailing: undefined,
    });
    const sections = responseStyleMessageSections(answer, "executive-command");
    expect(sections.report).toContain("매출은 늘었습니다.");
    expect(sections.report).not.toContain("비서실장의 조언");
    expect(sections.advice).toBe("다음 분기 계약부터 검토하십시오. 그 뒤에 인력을 보강합니다.");
    expect(sections.trailing).toBeUndefined();
  });

  it("keeps the report fixed once the advice appears while the answer streams", () => {
    const prefixes = Array.from({ length: answer.length + 1 }, (_, length) =>
      responseStyleMessageSections(answer.slice(0, length), "executive-command"),
    );
    const firstWithAdvice = prefixes.findIndex((sections) => sections.advice !== undefined);
    expect(firstWithAdvice).toBe(
      answer.indexOf("## [비서실장의 조언]\n") + "## [비서실장의 조언]\n".length,
    );
    const settled = prefixes.slice(firstWithAdvice);
    expect(settled.every((sections) => sections.advice !== undefined)).toBe(true);
    expect(new Set(settled.map((sections) => sections.report)).size).toBe(1);
    expect(settled[0]?.advice).toBe("");
  });
});

describe("responseStyleResultSummary", () => {
  it("summarizes the advice and tallies status tags outside code", () => {
    expect(responseStyleResultSummary(answer, "executive-command")).toEqual({
      adviceLine: "다음 분기 계약부터 검토하십시오.",
      tally: "확인 완료 1 · 검증 필요 1",
    });
  });

  it("omits the tally when the answer has no status tags", () => {
    expect(
      responseStyleResultSummary(
        "본문\n## [비서실장의 조언]\n서두르지 마십시오.\n",
        "executive-command",
      ),
    ).toEqual({ adviceLine: "서두르지 마십시오.", tally: undefined });
  });

  it("is empty for other styles, missing text and answers without advice", () => {
    expect(responseStyleResultSummary(answer, "standard")).toBeUndefined();
    expect(responseStyleResultSummary(answer, "deep-analysis")).toBeUndefined();
    expect(responseStyleResultSummary(undefined, "executive-command")).toBeUndefined();
    expect(
      responseStyleResultSummary("결과입니다. [확인 완료]", "executive-command"),
    ).toBeUndefined();
  });
});

describe("resolveComposerPlaceholder", () => {
  const idle = {
    approvalState: false,
    approvalDetail: undefined,
    planFollowUp: false,
    projectSelectionRequired: false,
    roomSendDisabledReason: null,
    noProviderAvailable: false,
    disconnected: false,
    responseStyleVariant: "standard",
  } as const;
  const stylePlaceholder = "최고 비서실장에게 분석·코드 검증·투자 판단을 지시하세요…";

  it("keeps the existing idle prompts without a named style", () => {
    expect(resolveComposerPlaceholder(idle)).toBe(
      "무엇이든 물어보세요. @ 파일/폴더, $ 스킬, / 명령을 사용할 수 있어요",
    );
    expect(resolveComposerPlaceholder({ ...idle, disconnected: true })).toBe(
      "후속 변경을 요청하거나 파일을 첨부하세요",
    );
  });

  it("uses the style prompt only while idle", () => {
    const styled = { ...idle, responseStyleVariant: "executive-command" } as const;
    expect(resolveComposerPlaceholder(styled)).toBe(stylePlaceholder);
    expect(resolveComposerPlaceholder({ ...styled, disconnected: true })).toBe(stylePlaceholder);
    for (const state of [
      { approvalState: true },
      { approvalState: true, approvalDetail: "명령 실행 승인" },
      { planFollowUp: true },
      { projectSelectionRequired: true },
      { roomSendDisabledReason: "모델을 선택하세요" },
      { noProviderAvailable: true },
    ]) {
      expect(resolveComposerPlaceholder({ ...styled, ...state })).toBe(
        resolveComposerPlaceholder({ ...idle, ...state }),
      );
      expect(resolveComposerPlaceholder({ ...styled, ...state })).not.toBe(stylePlaceholder);
    }
  });

  it("keeps the order of the blocking states", () => {
    expect(
      resolveComposerPlaceholder({
        ...idle,
        approvalState: true,
        approvalDetail: "명령 실행 승인",
        planFollowUp: true,
        projectSelectionRequired: true,
      }),
    ).toBe("명령 실행 승인");
    expect(resolveComposerPlaceholder({ ...idle, approvalState: true })).toBe(
      "승인 요청을 처리하면 계속할 수 있습니다",
    );
    expect(
      resolveComposerPlaceholder({
        ...idle,
        projectSelectionRequired: true,
        roomSendDisabledReason: "모델을 선택하세요",
        noProviderAvailable: true,
      }),
    ).toBe("위에서 프로젝트를 선택해 대화를 시작하세요");
    expect(
      resolveComposerPlaceholder({
        ...idle,
        roomSendDisabledReason: "모델을 선택하세요",
        noProviderAvailable: true,
      }),
    ).toBe("모델을 선택하세요");
  });
});
