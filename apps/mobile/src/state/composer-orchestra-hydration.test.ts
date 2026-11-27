import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { appAtomRegistry } from "./atom-registry";
import {
  awaitComposerDraftsLoaded,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  setComposerDraftText,
} from "./use-composer-drafts";

const disk = vi.hoisted(() => {
  let finishRead!: (value: string) => void;
  return {
    contents: "",
    files: new Map<string, string>(),
    read: new Promise<string>((resolve) => {
      finishRead = resolve;
    }),
    finishRead: (value: string) => finishRead(value),
  };
});

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
      return this.name === "drafts.json" || disk.files.has(this.name);
    }
    text() {
      return this.name === "drafts.json"
        ? disk.read
        : Promise.resolve(disk.files.get(this.name) ?? "");
    }
    create() {
      disk.files.set(this.name, "");
    }
    write(value: string) {
      disk.contents = value;
      disk.files.set(this.name, value);
    }
  },
}));

describe("composer draft hydration", () => {
  it("preserves a pending request when typing overlaps an unfinished read", async () => {
    vi.useFakeTimers();
    try {
      ensureComposerDraftsLoaded();
      setComposerDraftText("env:thread", "새 초안");
      await vi.advanceTimersByTimeAsync(200);
      const attempt = {
        threadKey: "env:thread",
        projectId: "project",
        runId: "run",
        commandId: "original-command",
        createdAt: "2026-11-02T00:00:00Z",
        originalText: "원래 답변",
        originalAttachments: [],
        prepared: { kind: "interject", text: "원래 답변" },
      };
      disk.finishRead(
        JSON.stringify({
          schemaVersion: 1,
          drafts: {
            "env:thread": { text: "원래 답변", attachments: [], orchestraAttempt: attempt },
          },
        }),
      );
      expect(await awaitComposerDraftsLoaded()).toBe(true);
      await vi.runAllTimersAsync();
      expect(appAtomRegistry.get(composerDraftsAtom)["env:thread"]).toMatchObject({
        text: "새 초안",
        orchestraAttempt: attempt,
      });
      expect(JSON.parse(disk.contents).drafts["env:thread"]).toMatchObject({
        text: "새 초안",
        orchestraAttempt: attempt,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
