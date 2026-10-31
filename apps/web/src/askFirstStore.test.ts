import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  ASK_FIRST_TASK_PREFIX,
  formatComposerRequest,
  migrateComposerRequestModes,
  readComposerRequestMode,
  setComposerRequestMode,
  toggleComposerRequestMode,
  useComposerRequestModeStore,
} from "./askFirstStore";
import { useWorkspaceTabStore, type WorkspaceTab } from "./workspaceTabStore";

const tab = (id: string, projectKey: string): WorkspaceTab => ({
  id,
  projectKey,
  view: { kind: "thread", environmentId: "env", threadId: id },
  lastActivatedAt: 0,
});

beforeEach(() => {
  useComposerRequestModeStore.setState({ modeByFolder: {} });
  useWorkspaceTabStore.setState({ tabs: [tab("a", "env:a"), tab("b", "env:b")], activeTabId: "a" });
});

describe("composer request mode", () => {
  it("keeps question, form and direct choices independent for each folder", () => {
    expect(readComposerRequestMode()).toBe("direct");
    setComposerRequestMode("ask-first");
    expect(readComposerRequestMode()).toBe("ask-first");
    useWorkspaceTabStore.setState({ activeTabId: "b" });
    expect(readComposerRequestMode()).toBe("direct");
    setComposerRequestMode("conditions");
    useWorkspaceTabStore.setState({ activeTabId: "a" });
    expect(readComposerRequestMode()).toBe("ask-first");
    setComposerRequestMode("conditions");
    useWorkspaceTabStore.setState({ activeTabId: "b" });
    expect(readComposerRequestMode()).toBe("conditions");
  });

  it("turns each toggle off on a second press and switches between toggles", () => {
    toggleComposerRequestMode("ask-first");
    expect(readComposerRequestMode()).toBe("ask-first");
    toggleComposerRequestMode("ask-first");
    expect(readComposerRequestMode()).toBe("direct");
    toggleComposerRequestMode("conditions");
    expect(readComposerRequestMode()).toBe("conditions");
    toggleComposerRequestMode("conditions");
    expect(readComposerRequestMode()).toBe("direct");
    toggleComposerRequestMode("ask-first");
    toggleComposerRequestMode("conditions");
    expect(readComposerRequestMode()).toBe("conditions");
    toggleComposerRequestMode("ask-first");
    expect(readComposerRequestMode()).toBe("ask-first");
  });

  it("migrates the existing form toggle without dropping explicit choices", () => {
    expect(
      migrateComposerRequestModes({
        enabledByFolder: { "env:a": true, "env:b": false, invalid: "yes" },
        modeByFolder: { "env:c": "ask-first", invalid: "missing" },
      }),
    ).toEqual({ modeByFolder: { "env:a": "conditions", "env:b": "direct", "env:c": "ask-first" } });
    expect(migrateComposerRequestModes(null)).toEqual({ modeByFolder: {} });
  });

  it("adds the restored question instructions only to question-mode requests", () => {
    expect(formatComposerRequest("수정해 줘", "ask-first")).toBe(
      ASK_FIRST_TASK_PREFIX + "수정해 줘",
    );
    expect(formatComposerRequest("수정해 줘", "direct")).toBe("수정해 줘");
    expect(formatComposerRequest("승인한 조건", "conditions")).toBe("승인한 조건");
    expect(ASK_FIRST_TASK_PREFIX).toContain("Codex는 request_user_input");
  });

  it.each(["멈춰", "멈춰줘!", "중지", "그만", "stop!", "cancel"])(
    "does not turn the stop command %s into a new question round",
    (command) => expect(formatComposerRequest(command, "ask-first")).toBe(command),
  );
});
