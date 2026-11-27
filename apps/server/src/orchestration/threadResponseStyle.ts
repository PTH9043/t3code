import type { ThreadResponseStyle } from "@t3tools/contracts/settings";

const presets: Record<ThreadResponseStyle["preset"], string> = {
  default: "",
  concise: "핵심을 먼저 간결하게 전달하되 필수 근거와 조건은 생략하지 마세요.",
  detailed: "결론에 이어 필요한 근거·과정·예시를 충분히 구체적으로 설명하세요.",
  friendly: "친근하고 자연스러운 어조로 말하세요.",
  professional: "정확하고 차분한 전문적인 어조로 설명하세요.",
};

/** Preferences affect expression only; a current request retains priority. */
export function threadResponseStylePrompt(
  style: ThreadResponseStyle | null | undefined,
): string | undefined {
  if (!style) return undefined;
  const escape = (value: string) =>
    value.trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const parts = [
    presets[style.preset],
    style.tone.trim() ? `말투: ${escape(style.tone)}` : "",
    style.length.trim() ? `답변 길이: ${escape(style.length)}` : "",
    style.explanation.trim() ? `설명 방식: ${escape(style.explanation)}` : "",
    style.instructions.trim() ? `사용자 추가 지시: ${escape(style.instructions)}` : "",
  ].filter(Boolean);
  return parts.length
    ? `<t3_response_style>사용자가 설정한 답변 스타일입니다. 현재 사용자 요청이 이 설정보다 우선합니다. 답변 스타일이 캐릭터 말투보다 우선하며 캐릭터는 충돌하지 않는 범위에서만 반영합니다. 도구 권한과 사실성 및 지정된 출력 형식은 유지합니다.\n${parts.join("\n")}\n</t3_response_style>`
    : undefined;
}
