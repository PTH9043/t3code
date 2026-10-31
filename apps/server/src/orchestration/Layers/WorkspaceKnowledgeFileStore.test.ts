// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeItem,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeWorkspaceKnowledgeFileStore } from "./WorkspaceKnowledgeFileStore.ts";

const item: WorkspaceKnowledgeItem = {
  id: WorkspaceKnowledgeItemId.make("memory-1"),
  projectId: ProjectId.make("workspace-a"),
  kind: "long-term-memory",
  title: "Memory",
  content: "Initial",
  status: "active",
  origin: "user",
  relativeFolder: "old",
  tags: [],
  originalChars: null,
  storedChars: null,
  promptUses: 0,
  lastUsedAt: null,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T01:00:00.000Z",
};

function memoryFileSystem() {
  const files = new Map<string, string>();
  const directories = new Set<string>(["/"]);
  const writes: string[] = [];
  const path = NodePath.posix;
  const fs = FileSystem.makeNoop({
    makeDirectory: (directory) =>
      Effect.sync(() => {
        let current = path.resolve(directory);
        while (!directories.has(current)) {
          directories.add(current);
          current = path.dirname(current);
        }
      }),
    exists: (name) => Effect.sync(() => directories.has(name) || files.has(name)),
    realPath: (name) => Effect.succeed(name),
    readFileString: (name) =>
      Effect.sync(() => {
        const contents = files.get(name);
        if (contents === undefined) throw new Error(`Missing in-memory file: ${name}`);
        return contents;
      }),
    writeFileString: (name, contents) =>
      Effect.sync(() => {
        files.set(name, contents);
        writes.push(name);
      }),
  });
  const store = makeWorkspaceKnowledgeFileStore.pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path as unknown as Path.Path),
  );
  return { files, writes, store };
}

it.effect("updates the original file without creating temporary or history files", () =>
  Effect.gen(function* () {
    const memory = memoryFileSystem();
    const store = yield* memory.store;
    const target = "/workspace-a/entries/old/memory-1.md";
    const manifest = "/workspace-a/.newautousage/index.json";
    yield* store.syncItem({ root: "/workspace-a", item });
    expect(memory.writes).toEqual([target, manifest]);
    memory.writes.length = 0;
    yield* store.syncItem({ root: "/workspace-a", item });
    expect(memory.writes).toEqual([]);
    yield* store.syncItem({
      root: "/workspace-a",
      item: {
        ...item,
        content: "Revised",
        relativeFolder: "new",
        status: "archived",
        updatedAt: "2026-08-08T02:00:00.000Z",
      },
    });
    expect(memory.writes).toEqual([target, manifest]);
    expect(memory.files.get(target)).toContain("Revised");
    const manifestContents = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          entries: Schema.Record(
            Schema.String,
            Schema.Struct({ path: Schema.String, status: Schema.String }),
          ),
        }),
      ),
    )(memory.files.get(manifest) ?? "");
    expect(manifestContents.entries["memory-1"]).toMatchObject({
      path: "entries/old/memory-1.md",
      status: "archived",
    });
    expect([...memory.files.keys()].sort()).toEqual([target, manifest].sort());
  }),
);

it.effect("preserves workspace boundaries and existing untracked files", () =>
  Effect.gen(function* () {
    const memory = memoryFileSystem();
    const store = yield* memory.store;
    yield* store.syncItem({ root: "/workspace-a", item });
    const other = { ...item, projectId: ProjectId.make("workspace-b"), content: "Other" };
    yield* store.syncItem({ root: "/workspace-b", item: other });
    expect(memory.files.get("/workspace-a/entries/old/memory-1.md")).toContain("Initial");
    expect(memory.files.get("/workspace-b/entries/old/memory-1.md")).toContain("Other");
    memory.writes.length = 0;
    const wrongWorkspace = yield* store
      .syncItem({ root: "/workspace-a", item: other })
      .pipe(Effect.flip);
    expect(wrongWorkspace._tag).toBe("WorkspaceKnowledgeFileStoreError");
    const traversal = yield* store
      .syncItem({ root: "/workspace-a", item: { ...item, relativeFolder: "../outside" } })
      .pipe(Effect.flip);
    expect(traversal._tag).toBe("WorkspaceKnowledgeFileStoreError");
    const collisionPath = "/workspace-a/entries/old/memory-2.md";
    memory.files.set(collisionPath, "Untracked");
    const collision = yield* store
      .syncItem({
        root: "/workspace-a",
        item: { ...item, id: WorkspaceKnowledgeItemId.make("memory-2") },
      })
      .pipe(Effect.flip);
    expect(collision._tag).toBe("WorkspaceKnowledgeFileStoreError");
    expect(memory.files.get(collisionPath)).toBe("Untracked");
    expect(memory.writes).toEqual([]);
  }),
);

it.effect("does not recreate a missing existing memory file", () =>
  Effect.gen(function* () {
    const memory = memoryFileSystem();
    const store = yield* memory.store;
    yield* store.syncItem({ root: "/workspace-a", item });
    memory.files.delete("/workspace-a/entries/old/memory-1.md");
    memory.writes.length = 0;
    const error = yield* store.syncItem({ root: "/workspace-a", item }).pipe(Effect.flip);
    expect(error._tag).toBe("WorkspaceKnowledgeFileStoreError");
    expect(memory.writes).toEqual([]);
  }),
);
