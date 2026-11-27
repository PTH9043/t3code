import { useAtomValue } from "@effect/atom-react";
import type { ResponseStyleUiVariant } from "@t3tools/client-runtime/state/response-style-presentation";
import { verifyGlobalOutputContract, type UnifiedBgTask } from "@t3tools/contracts";
import { buildOutputContractRepairPrompt } from "@t3tools/shared/globalAssistantPrompt";
import { memo, useMemo, type ComponentProps } from "react";
import { useComposerDraftStore } from "~/composerDraftStore";
import { responseStyleMessageSections } from "~/responseStyleUi";
import { useActiveEnvironmentId } from "~/state/entities";
import { globalAssistantForEnvironmentAtom } from "~/state/server";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { RuntimeProofStrip } from "./RuntimeProofStrip";

type MarkdownProps = Omit<ComponentProps<typeof ChatMarkdown>, "className" | "factStatusBadges">;

/**
 * Assistant message body laid out for the unified global AI profile.
 * Renders executive callouts when present and runs a 0ms deterministic
 * output-contract check to surface a 1-click format repair button. Pass
 * `isTurnAnswer` for the message that ends a settled turn: notes written
 * between tool calls are not answers and are not held to the contract.
 */
export const ResponseStyleMessageBody = memo(function ResponseStyleMessageBody({
  variant,
  text,
  isTurnAnswer = false,
  isLatestAssistantAnswer = false,
  hasActiveBackgroundWork = false,
  turnId,
  backgroundTasks,
  ...markdown
}: MarkdownProps & {
  variant: ResponseStyleUiVariant;
  isTurnAnswer?: boolean;
  isLatestAssistantAnswer?: boolean;
  hasActiveBackgroundWork?: boolean;
  turnId?: string | null;
  backgroundTasks?: readonly UnifiedBgTask[];
}) {
  const executive = variant === "executive-command";
  const sections = useMemo(() => responseStyleMessageSections(text, variant), [text, variant]);
  const activeEnvironmentId = useActiveEnvironmentId();
  const effectiveEnvironmentId = markdown.threadRef?.environmentId ?? activeEnvironmentId;
  const globalAssistantAtom = useMemo(
    () => globalAssistantForEnvironmentAtom(effectiveEnvironmentId),
    [effectiveEnvironmentId],
  );
  const globalAssistant = useAtomValue(globalAssistantAtom);
  const contractVerification = useMemo(
    () =>
      markdown.isStreaming || !isTurnAnswer
        ? null
        : verifyGlobalOutputContract(globalAssistant, text),
    [globalAssistant, isTurnAnswer, markdown.isStreaming, text],
  );

  return (
    <>
      <ChatMarkdown
        key="report"
        {...markdown}
        detailsScopeKey={
          markdown.detailsScopeKey ? `${markdown.detailsScopeKey}:report` : undefined
        }
        text={sections.report}
        factStatusBadges={executive}
      />
      {sections.advice !== undefined ? (
        <aside
          key="advice"
          aria-label="비서실장의 조언"
          data-response-style-advice=""
          className="mt-3 border-l-2 border-primary/40 bg-muted/40 px-3 py-2"
        >
          <p className="mb-1 text-xs font-medium text-muted-foreground">비서실장의 조언</p>
          <ChatMarkdown
            {...markdown}
            detailsScopeKey={
              markdown.detailsScopeKey ? `${markdown.detailsScopeKey}:advice` : undefined
            }
            text={sections.advice}
            factStatusBadges
          />
        </aside>
      ) : null}
      {sections.trailing !== undefined ? (
        <ChatMarkdown
          key="trailing"
          {...markdown}
          detailsScopeKey={
            markdown.detailsScopeKey ? `${markdown.detailsScopeKey}:trailing` : undefined
          }
          text={sections.trailing}
          className="mt-3"
          factStatusBadges
        />
      ) : null}
      {!markdown.isStreaming && isTurnAnswer ? (
        <RuntimeProofStrip
          text={text}
          isLatestAssistantAnswer={isLatestAssistantAnswer}
          allowUnverifiedWarning={isLatestAssistantAnswer && !hasActiveBackgroundWork}
          {...(turnId !== undefined ? { turnId } : {})}
          {...(markdown.threadRef ? { threadRef: markdown.threadRef } : {})}
          {...(backgroundTasks ? { backgroundTasks } : {})}
        />
      ) : null}
      {contractVerification?.checked && !contractVerification.passed && globalAssistant ? (
        <div
          data-output-contract-warning=""
          className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          <span>
            전역 출력 형식 일부 누락:{" "}
            {contractVerification.violations.map((v) => v.heading).join(", ")}
          </span>
          {markdown.threadRef ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                if (!markdown.threadRef) return;
                useComposerDraftStore
                  .getState()
                  .setPrompt(
                    markdown.threadRef,
                    buildOutputContractRepairPrompt(globalAssistant, contractVerification),
                  );
              }}
            >
              형식 보정 입력
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
});
