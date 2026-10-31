import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  WorkspaceMeetingParticipantId,
  type WorkspaceExecutionProfile,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import { executionProfileTask } from "./executionProfile.ts";

const profile: WorkspaceExecutionProfile = {
  id: "focused",
  name: "Focused fixes",
  revision: 999,
  instructions: "Use the smallest change.",
  verificationCommands: ["vp test run src/fix.test.ts"],
  orchestra: { maxParallel: 2, isolateWorktrees: true },
  meeting: {
    mode: "fixed-rounds",
    maxRounds: 0,
    maxRevisions: 2,
    userInLoop: false,
    chairParticipantId: null,
    threadId: ThreadId.make("old-conversation"),
    participants: ["codex", "claude"].map((id) => ({
      id: WorkspaceMeetingParticipantId.make(id),
      displayName: id,
      modelSelection: {
        instanceId: ProviderInstanceId.make(id),
        model: "model",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    })),
  },
};

describe("execution profiles", () => {
  it("assigns authoritative revisions and removes the old conversation on save", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      executionProfilesToUpsert: { focused: profile },
    });
    expect(first.executionProfiles.focused?.revision).toBe(1);
    expect(first.executionProfiles.focused?.meeting).not.toHaveProperty("threadId");
    const frozen = structuredClone(first.executionProfiles.focused!);
    const second = applyServerSettingsPatch(first, {
      executionProfilesToUpsert: { focused: { ...profile, name: "Updated", revision: 0 } },
    });
    expect(second.executionProfiles.focused?.revision).toBe(2);
    expect(frozen.name).toBe("Focused fixes");
    expect(first.executionProfiles.focused?.name).toBe("Focused fixes");
    const removed = applyServerSettingsPatch(second, { executionProfileIdsToRemove: ["focused"] });
    expect(removed.executionProfiles).toEqual({});
    expect(frozen.meeting.participants[0]?.modelSelection.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
  });
  it("merges independent profile edits without replacing the whole registry", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      executionProfilesToUpsert: { focused: profile },
    });
    const second = applyServerSettingsPatch(first, {
      executionProfilesToUpsert: { analysis: { ...profile, id: "wrong-key" } },
    });
    expect(Object.keys(second.executionProfiles)).toEqual(["focused", "analysis"]);
    expect(second.executionProfiles.analysis?.id).toBe("analysis");
    expect(second).not.toHaveProperty("executionProfilesToUpsert");
  });
  it("includes verification commands while keeping the user's task authoritative", () => {
    const task = executionProfileTask("Change only the login", profile);
    expect(task).toContain("revision 999");
    expect(task).toContain("vp test run src/fix.test.ts");
    expect(task).toMatch(/takes precedence[\s\S]+Change only the login$/);
    expect(executionProfileTask("Plain task")).toBe("Plain task");
  });
});
