import type { ThreadResponseStyle } from "@t3tools/contracts";
import {
  countFactStatusBadges,
  deriveResponseStyleUiProfile,
  resolveResponseStyleUiProfile,
  responseStyleComposerPlaceholder,
  splitStructuredStyleSections,
  summarizeAdviceLine,
  type ResponseStyleUiProfile,
  type ResponseStyleUiVariant,
} from "@t3tools/client-runtime/state/response-style-presentation";

/** The look of a conversation with no response style; the default for a surface given none. */
export const STANDARD_RESPONSE_STYLE_UI_PROFILE = deriveResponseStyleUiProfile(
  { style: null },
  "global",
);

/**
 * Profile for one conversation. `roomStyle` is the conversation's own style: the saved one,
 * or the composer draft's while the conversation is unsent. A room style that asks for
 * nothing follows the global style, as the server does when it answers.
 */
export function conversationResponseStyleUiProfile(input: {
  globalStyle: ThreadResponseStyle | null | undefined;
  roomStyle?: ThreadResponseStyle | undefined;
  threadId: string | null;
}) {
  // Unified global-only policy: per-room overrides are retired so every conversation
  // reflects the global AI profile.
  return resolveResponseStyleUiProfile(
    {
      globalResponseStyle: input.globalStyle ?? null,
    },
    input.threadId,
  );
}

/** "전역" / "이 방" for tight spots such as the header pill; `undefined` when no style is set. */
export function responseStyleScopeShortLabel(scopeLabel: ResponseStyleUiProfile["scopeLabel"]) {
  return scopeLabel === "이 방 전용" ? "이 방" : scopeLabel === "전역 스타일" ? "전역" : undefined;
}

/** One line naming the style in effect now, e.g. "이 방 전용 · 최고 비서실장", or "미설정". */
export function responseStyleSettingLabel(profile: ResponseStyleUiProfile) {
  return profile.personaBadge === undefined
    ? profile.scopeLabel
    : `${profile.scopeLabel} · ${profile.personaBadge}`;
}

/**
 * How an assistant message is laid out. Only an executive-style answer that has reached its
 * advice heading is split; anything else renders whole as `report`. Derived at render from
 * the unchanged message text, so switching the style back restores the plain layout.
 */
export function responseStyleMessageSections(text: string, variant: ResponseStyleUiVariant) {
  const sections = variant === "executive-command" ? splitStructuredStyleSections(text) : undefined;
  return sections?.advice === undefined
    ? { report: text, advice: undefined, trailing: undefined }
    : sections;
}

/**
 * Turn viewer digest of an executive-style answer: the advice teaser and a tally of its
 * status tags. `undefined` unless the answer has an advice section.
 */
export function responseStyleResultSummary(
  text: string | undefined,
  variant: ResponseStyleUiVariant,
) {
  if (variant !== "executive-command" || !text) return undefined;
  const { advice } = splitStructuredStyleSections(text);
  if (advice === undefined) return undefined;
  const { counts, total } = countFactStatusBadges(text);
  return {
    adviceLine: summarizeAdviceLine(advice),
    tally:
      total === 0
        ? undefined
        : Object.entries(counts)
            .filter(([, count]) => count > 0)
            .map(([label, count]) => `${label} ${count}`)
            .join(" · "),
  };
}

/**
 * Composer input placeholder. States that block or steer the next message keep their own
 * text; a response-style placeholder replaces only the two idle prompts.
 */
export function resolveComposerPlaceholder(input: {
  approvalState: boolean;
  approvalDetail: string | undefined;
  planFollowUp: boolean;
  projectSelectionRequired: boolean;
  roomSendDisabledReason: string | null;
  noProviderAvailable: boolean;
  disconnected: boolean;
  responseStyleVariant: ResponseStyleUiVariant;
}) {
  if (input.approvalState) {
    return input.approvalDetail ?? "승인 요청을 처리하면 계속할 수 있습니다";
  }
  if (input.planFollowUp) {
    return "계획을 다듬을 의견을 입력하거나, 바로 구현하려면 비워 두세요";
  }
  if (input.projectSelectionRequired) return "위에서 프로젝트를 선택해 대화를 시작하세요";
  if (input.roomSendDisabledReason) return input.roomSendDisabledReason;
  if (input.noProviderAvailable) return "메시지를 보내려면 설정에서 제공자를 활성화하세요";
  return (
    responseStyleComposerPlaceholder(input.responseStyleVariant) ??
    (input.disconnected
      ? "후속 변경을 요청하거나 파일을 첨부하세요"
      : "무엇이든 물어보세요. @ 파일/폴더, $ 스킬, / 명령을 사용할 수 있어요")
  );
}
