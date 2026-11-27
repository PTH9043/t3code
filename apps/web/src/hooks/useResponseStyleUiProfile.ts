import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ResponseStyleUiProfile } from "@t3tools/client-runtime/state/response-style-presentation";
import { useMemo } from "react";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { conversationResponseStyleUiProfile } from "~/responseStyleUi";
import { serverEnvironment } from "~/state/server";

/**
 * How the response style in effect for one conversation should look. Call it once per chat
 * view and hand the result to the header, timeline, turn viewer and composer so they agree.
 * `draftId` is set while the conversation is unsent: its style then lives in the composer
 * draft. The returned object keeps its identity until one of its values changes.
 */
export function useResponseStyleUiProfile(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  draftId: DraftId | null,
) {
  const globalStyle = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.globalResponseStyle;
  const savedStyle = useEnvironmentSettings(environmentId, (settings) =>
    threadId ? settings.threadResponseStyles?.[threadId] : undefined,
  );
  const draftStyle = useComposerDraftStore((store) =>
    draftId ? store.draftThreadsByThreadKey[draftId]?.responseStyle : undefined,
  );
  const { variant, scopeLabel, personaBadge, hasStructuredSections, defaultCollapseToolGroups } =
    conversationResponseStyleUiProfile({
      globalStyle,
      roomStyle: draftStyle ?? savedStyle,
      threadId,
    });
  return useMemo(
    () =>
      ({
        variant,
        scopeLabel,
        personaBadge,
        hasStructuredSections,
        defaultCollapseToolGroups,
      }) satisfies ResponseStyleUiProfile,
    [variant, scopeLabel, personaBadge, hasStructuredSections, defaultCollapseToolGroups],
  );
}
