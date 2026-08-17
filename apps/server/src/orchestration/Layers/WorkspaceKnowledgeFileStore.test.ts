import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeItem,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  WorkspaceKnowledgeFileStoreLive,
  renderWorkspaceKnowledgeMarkdown,
} from "./WorkspaceKnowledgeFileStore.ts";
import { WorkspaceKnowledgeFileStore } from "../Services/WorkspaceKnowledgeFileStore.ts";

const testLayer = WorkspaceKnowledgeFileStoreLive.pipe(Layer.provideMerge(NodeServices.layer));
const decodeUnknownJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function memoryItem(input: {
  readonly projectId: string;
  readonly itemId?: string;
  readonly content: string;
  readonly relativeFolder?: string | null;
  readonly status?: WorkspaceKnowledgeItem["status"];
  readonly updatedAt?: string;
}): WorkspaceKnowledgeItem {
  return {
    id: WorkspaceKnowledgeItemId.make(input.itemId ?? "memory-1"),
    projectId: ProjectId.make(input.projectId),
    kind: "long-term-memory",
    title: `${input.projectId} memory`,
    content: input.content,
    status: input.status ?? "active",
    origin: "user",
    relativeFolder: input.relativeFolder ?? null,
    tags: ["workspace-only"],
    originalChars: null,
    storedChars: null,
    promptUses: 0,
    lastUsedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-08T01:00:00.000Z",
  };
}

it.layer(testLayer)("WorkspaceKnowledgeFileStore", (it) => {
  it.effect("writes same-id memories into separate Workspace roots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* WorkspaceKnowledgeFileStore;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "workspace-memory-" });
        const rootA = path.join(parent, "workspace-a");
        const rootB = path.join(parent, "workspace-b");
        const itemA = memoryItem({ projectId: "workspace-a", content: "Only A" });
        const itemB = memoryItem({ projectId: "workspace-b", content: "Only B" });

        yield* store.syncItem({ root: rootA, item: itemA });
        yield* store.syncItem({ root: rootB, item: itemB });

        const recordA = yield* fileSystem.readFileString(
          path.join(rootA, "entries", "_root", "memory-1.md"),
        );
        const recordB = yield* fileSystem.readFileString(
          path.join(rootB, "entries", "_root", "memory-1.md"),
        );
        expect(recordA).toContain("Only A");
        expect(recordA).not.toContain("Only B");
        expect(recordB).toContain("Only B");
        expect(recordB).not.toContain("Only A");

        const manifestA = decodeUnknownJsonString(
          yield* fileSystem.readFileString(path.join(rootA, ".newautousage", "index.json")),
        );
        const manifestB = decodeUnknownJsonString(
          yield* fileSystem.readFileString(path.join(rootB, ".newautousage", "index.json")),
        );
        expect(manifestA).toMatchObject({ projectId: "workspace-a" });
        expect(manifestB).toMatchObject({ projectId: "workspace-b" });
      }),
    ),
  );

  it.effect("moves a logical-folder record and preserves the previous revision", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* WorkspaceKnowledgeFileStore;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "workspace-memory-" });
        const original = memoryItem({
          projectId: "workspace-a",
          content: "Initial",
          relativeFolder: "research/decisions",
        });
        const archived = memoryItem({
          projectId: "workspace-a",
          content: "Revised",
          relativeFolder: "approved",
          status: "archived",
          updatedAt: "2026-08-08T02:00:00.000Z",
        });

        yield* store.syncItem({ root, item: original });
        yield* store.syncItem({ root, item: archived });

        expect(
          yield* fileSystem.exists(
            path.join(root, "entries", "research", "decisions", "memory-1.md"),
          ),
        ).toBe(false);
        expect(
          yield* fileSystem.readFileString(
            path.join(root, ".newautousage", "history", "memory-1", "2026-08-08T01-00-00.000Z.md"),
          ),
        ).toBe(renderWorkspaceKnowledgeMarkdown(original));
        const current = yield* fileSystem.readFileString(
          path.join(root, "entries", "approved", "memory-1.md"),
        );
        expect(current).toBe(renderWorkspaceKnowledgeMarkdown(archived));
        expect(current).toContain('"status":"archived"');
      }),
    ),
  );

  it.effect("rejects traversal even if a caller bypasses contract decoding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* WorkspaceKnowledgeFileStore;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "workspace-memory-" });
        const root = path.join(parent, "workspace-a");
        const unsafe = {
          ...memoryItem({ projectId: "workspace-a", content: "Must stay isolated" }),
          relativeFolder: "../workspace-b",
        } as WorkspaceKnowledgeItem;

        const error = yield* store.syncItem({ root, item: unsafe }).pipe(Effect.flip);
        expect(error._tag).toBe("WorkspaceKnowledgeFileStoreError");
        expect(yield* fileSystem.exists(path.join(parent, "workspace-b", "memory-1.md"))).toBe(
          false,
        );
      }),
    ),
  );
});
