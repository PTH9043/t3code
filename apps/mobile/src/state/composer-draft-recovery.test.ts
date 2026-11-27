import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  WorkspaceCollaborationRunId,
} from "@t3tools/contracts";

const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  partialWrite: "none" as "none" | "silent" | "throw",
}));

vi.mock("expo-file-system", () => ({
  Paths: { document: "document" },
  Directory: class {
    create() {}
  },
  File: class {
    constructor(
      _directory: unknown,
      private readonly name: string,
    ) {}
    get exists() {
      return disk.files.has(this.name);
    }
    create() {
      disk.files.set(this.name, "");
    }
    text() {
      return Promise.resolve(disk.files.get(this.name) ?? "");
    }
    write(value: string) {
      if (disk.partialWrite !== "none") {
        disk.files.set(this.name, value.slice(0, 20));
        if (disk.partialWrite === "throw") throw new Error("synthetic interrupted write");
        return;
      }
      disk.files.set(this.name, value);
    }
  },
}));

describe("composer draft recovery", () => {
  it("persists a first-request custom team and one first-send identity until the draft is discarded", async () => {
    disk.files.clear();
    vi.resetModules();
    const key = "new-task:env:project";
    const member = {
      instanceId: ProviderInstanceId.make("b"),
      model: "worker",
      role: "advisor" as const,
      instructions: "Research",
    };
    const create = vi.fn(() => ({
      threadId: "12345678-room",
      commandId: "cmd",
      messageId: "message",
      createdAt: "2026-11-02T00:00:00Z",
    }));
    const first = await import("./use-composer-drafts");
    // An explicit empty team is kept apart from following the global team (null).
    await first.saveDraftSubordinateTeam(key, []);
    expect(first.getComposerDraftSnapshot(key).customSubordinateTeam).toEqual([]);
    await first.saveDraftSubordinateTeam(key, null);
    expect(first.getComposerDraftSnapshot(key).customSubordinateTeam).toBeUndefined();
    await first.saveDraftSubordinateTeam(key, [member]);
    expect(first.getComposerDraftSnapshot(key).firstTurnMetadata).toBeUndefined();
    const [identity, duplicate] = await Promise.all([
      first.reserveNewTaskTurnMetadata(key, create),
      first.reserveNewTaskTurnMetadata(key, create),
    ]);
    expect(duplicate).toEqual(identity);
    vi.resetModules();
    const resumed = await import("./use-composer-drafts");
    // A user can type before asynchronous hydration finishes.
    resumed.setComposerDraftText(key, "hello");
    expect(await resumed.awaitComposerDraftsLoaded()).toBe(true);
    const snapshot = resumed.getComposerDraftSnapshot(key);
    expect(snapshot.text).toBe("hello");
    expect(snapshot.customSubordinateTeam).toEqual([member]);
    expect(snapshot.modelTeams).toBeUndefined();
    expect(await resumed.reserveNewTaskTurnMetadata(key, create)).toEqual(identity);
    expect(create).toHaveBeenCalledTimes(1);
    const sent = resumed.clearComposerDraftContentState({ [key]: snapshot }, key);
    expect(sent[key]?.customSubordinateTeam).toBeUndefined();
    expect(sent[key]?.modelTeams).toBeUndefined();
    expect(sent[key]?.firstTurnMetadata).toBeUndefined();
    await resumed.restoreComposerDraftSnapshot(key, { text: "", attachments: [] });
    vi.resetModules();
    const fresh = await import("./use-composer-drafts");
    expect(await fresh.awaitComposerDraftsLoaded()).toBe(true);
    expect(fresh.getComposerDraftSnapshot(key)).toEqual({ text: "", attachments: [] });
  });

  it("imports selected draft settings once, retains unrelated edits and restores the prior model for a fresh draft", async () => {
    disk.files.clear();
    vi.resetModules();
    const key = "new-task:env:project";
    const existing = { instanceId: ProviderInstanceId.make("old"), model: "Same" };
    const imported = {
      instanceId: ProviderInstanceId.make("exact"),
      model: "Same",
      options: [{ id: "reasoning", value: "high" }],
    };
    const responseStyle = {
      preset: "professional" as const,
      tone: "brief",
      length: "",
      explanation: "",
      instructions: "Only this conversation",
    };
    const teamUpdate = {
      threadId: ThreadId.make("draft"),
      members: [
        {
          instanceId: existing.instanceId,
          model: "worker",
          role: "advisor" as const,
          instructions: "Review",
        },
      ],
    };
    const first = await import("./use-composer-drafts");
    await first.restoreComposerDraftSnapshot(key, {
      text: "unsent notes",
      attachments: [],
      modelSelection: existing,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    await first.saveDraftSubordinateTeam(key, []);
    await first.saveImportedDraftSettings(key, { ok: true, modelSelection: imported });
    expect(first.getComposerDraftSnapshot(key).customSubordinateTeam).toEqual([]);
    await first.saveImportedDraftSettings(key, { ok: true, teamUpdate, responseStyle });
    vi.resetModules();
    const resumed = await import("./use-composer-drafts");
    expect(await resumed.awaitComposerDraftsLoaded()).toBe(true);
    const snapshot = resumed.getComposerDraftSnapshot(key);
    expect(snapshot).toMatchObject({
      text: "unsent notes",
      modelSelection: imported,
      responseStyle,
      requireExactModel: true,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    expect(snapshot.customSubordinateTeam).toEqual(teamUpdate.members);
    const cleared = resumed.clearComposerDraftContentState({ [key]: snapshot }, key)[key];
    expect(cleared?.modelSelection).toEqual(existing);
    expect(cleared?.responseStyle).toBeUndefined();
    expect(cleared?.customSubordinateTeam).toBeUndefined();
    expect(cleared?.modelTeams).toBeUndefined();
  });

  it("keeps a valid slot across interrupted writes and restores the request after restart", async () => {
    disk.files.clear();
    vi.resetModules();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const key = "env:thread";
      const previous = JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        drafts: { [key]: { text: "원래 요청", attachments: [] } },
      });
      disk.files.set("drafts.json", previous);
      disk.files.set("drafts-alternate.json", "{partial");
      const first = await import("./use-composer-drafts");
      expect(await first.awaitComposerDraftsLoaded()).toBe(true);
      expect(first.getComposerDraftSnapshot(key).text).toBe("원래 요청");
      const attempt = {
        threadKey: key,
        projectId: ProjectId.make("project"),
        runId: WorkspaceCollaborationRunId.make("run"),
        commandId: CommandId.make("original-command"),
        createdAt: "2026-11-02T00:00:00Z",
        originalText: "원래 요청",
        originalAttachments: [],
        prepared: { kind: "interject" as const, text: "원래 요청" },
      };
      expect(await first.persistComposerOrchestraAttempt(key, attempt)).toBe(true);
      expect(disk.files.get("drafts.json")).toBe(previous);
      const completed = disk.files.get("drafts-alternate.json");
      expect(JSON.parse(completed!).generation).toBe(2);
      vi.resetModules();
      const resumed = await import("./use-composer-drafts");
      expect(await resumed.awaitComposerDraftsLoaded()).toBe(true);
      expect(resumed.getComposerDraftSnapshot(key).orchestraAttempt).toEqual(attempt);
      disk.partialWrite = "silent";
      await expect(
        resumed.mergeComposerDraftContent(key, { text: "새 초안", attachments: [] }),
      ).rejects.toThrow();
      expect(disk.files.get("drafts-alternate.json")).toBe(completed);
      disk.partialWrite = "throw";
      await expect(
        resumed.mergeComposerDraftContent(key, { text: "새 초안", attachments: [] }),
      ).rejects.toThrow();
      expect(disk.files.get("drafts-alternate.json")).toBe(completed);

      disk.partialWrite = "none";
      vi.resetModules();
      const restarted = await import("./use-composer-drafts");
      expect(await restarted.awaitComposerDraftsLoaded()).toBe(true);
      expect(restarted.getComposerDraftSnapshot(key)).toMatchObject({
        text: "원래 요청",
        orchestraAttempt: attempt,
      });
    } finally {
      warning.mockRestore();
    }
  });
});
