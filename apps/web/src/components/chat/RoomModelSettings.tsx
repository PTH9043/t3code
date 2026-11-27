import type { EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import type { Ref } from "react";
import type { DraftId } from "~/composerDraftStore";
import { GlobalAssistantStudio } from "./GlobalAssistantStudio";
import { GlobalSubordinateTeamEditor } from "./ThreadModelTeamSettings";

/** Kept for caller compatibility; per-room style and subordinate overrides are retired in favor of global AI settings. */
export type RoomModelSettingsRoom = {
  threadId: ThreadId;
  modelSelection: ModelSelection | null;
  draftId: DraftId | null;
};

/**
 * Unified Global AI profile and global subordinate team.
 * Per-conversation style/team overrides have been retired so every model and room
 * consistently follows the single global AI contract.
 */
export function RoomModelSettings({
  environmentId,
  addModelRef,
  room,
  showMonitorControls = false,
}: {
  environmentId: EnvironmentId;
  addModelRef?: Ref<HTMLSelectElement>;
  room?: RoomModelSettingsRoom | undefined;
  showMonitorControls?: boolean;
}) {
  return (
    <>
      <GlobalAssistantStudio
        environmentId={environmentId}
        compact={room !== undefined}
        showMonitorControls={showMonitorControls}
      />
      <GlobalSubordinateTeamEditor
        environmentId={environmentId}
        {...(addModelRef ? { addModelRef } : {})}
      />
    </>
  );
}
