import { describe, expect, it } from "vite-plus/test";
import {
  isLightweightNativeFollowup,
  mentionsAttachmentDocumentQuery,
} from "./workspacePromptTokens.ts";

describe("workspacePromptTokens lightweight native follow-up gating", () => {
  it("classifies short continuation turns and structured Q&A replies as lightweight", () => {
    expect(isLightweightNativeFollowup("보고")).toBe(true);
    expect(isLightweightNativeFollowup("현재 중간 보고")).toBe(true);
    expect(isLightweightNativeFollowup("계속")).toBe(true);
    expect(isLightweightNativeFollowup("진행해줘")).toBe(true);
    expect(isLightweightNativeFollowup("해줘")).toBe(true);
    expect(
      isLightweightNativeFollowup(
        "User answers to the questions you asked:\n- 1번 옵션으로 진행해 주세요.",
      ),
    ).toBe(true);
  });

  it("preserves full retrieval for memory/document lookups and substantive dev prompts", () => {
    expect(isLightweightNativeFollowup("이전 대화 기억 찾아서 요약해줘")).toBe(false);
    expect(isLightweightNativeFollowup("첨부 PDF 보고서 3페이지 확인해줘")).toBe(false);
    expect(
      isLightweightNativeFollowup(
        "apps/server/src/provider/Layers/GeminiAdapter.ts의 백그라운드 작업 감지가 안 되는 원인을 분석하고 수정해줘",
      ),
    ).toBe(false);
  });

  it("detects explicit historical attachment/document mentions", () => {
    expect(mentionsAttachmentDocumentQuery("첨부한 PDF 2쪽 다시 읽어줘")).toBe(true);
    expect(mentionsAttachmentDocumentQuery("슬라이드 스크린샷 레이아웃 검토해줘")).toBe(true);
    expect(mentionsAttachmentDocumentQuery("ProviderSessionRuntime 캐시 추가해줘")).toBe(false);
  });
});
