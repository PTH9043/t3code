import type { ThreadAssistantProfile } from "@t3tools/contracts/settings";

/** A saved profile supplies preferences; it does not override the current user request. */
export function threadAssistantProfilePrompt(
  profile: ThreadAssistantProfile | undefined,
): string | undefined {
  if (!profile || (!profile.name.trim() && !profile.instructions.trim())) return undefined;
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<t3_assistant_profile>이 대화의 비서 설정입니다. 최신 사용자 지시가 이 설정보다 우선하며 다른 대화의 권한은 부여되지 않습니다.\n이름: ${escape(profile.name.trim())}\n역할: ${escape(profile.instructions.trim())}\n</t3_assistant_profile>`;
}
