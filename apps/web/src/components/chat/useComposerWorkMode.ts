import { updateMeetingComposerConfig } from "../../meetingComposerStore";
import type { WorkspaceDevelopmentPanelProps } from "./WorkspaceDevelopmentPanel";

export type ComposerWorkMode = "models" | "meeting" | "development";

/** Change the orchestra preference without disabling a persistent workspace. */
export function useComposerWorkMode(_development: WorkspaceDevelopmentPanelProps | null) {
  const selectMode = async (mode: ComposerWorkMode) => {
    if (mode !== "development") {
      updateMeetingComposerConfig((current) => ({ ...current, enabled: mode === "meeting" }));
    }
    return true;
  };
  return { changingMode: false, modeError: null, selectMode };
}
