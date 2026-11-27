import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  awaitComposerDraftsLoaded,
  ensureComposerDraftsLoaded,
  setComposerDraftText,
} from "./use-composer-drafts";

const disk = vi.hoisted(() => ({ contents: "{invalid", writes: 0 }));
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
      return this.name === "drafts.json";
    }
    text() {
      return Promise.resolve(disk.contents);
    }
    write(value: string) {
      disk.writes++;
      disk.contents = value;
    }
  },
}));

describe("composer draft load failure", () => {
  it("does not overwrite unreadable saved drafts while the user is typing", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ensureComposerDraftsLoaded();
      setComposerDraftText("env:thread", "새 초안");
      expect(await awaitComposerDraftsLoaded()).toBe(false);
      await vi.runAllTimersAsync();
      expect(disk.writes).toBe(0);
      expect(disk.contents).toBe("{invalid");
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });
});
