import type { WorkspaceKnowledgeItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  WorkspaceKnowledgeFileStore,
  WorkspaceKnowledgeFileStoreError,
  type WorkspaceKnowledgeFileStoreShape,
} from "../Services/WorkspaceKnowledgeFileStore.ts";

const STORE_DIRECTORY = ".newautousage";
const MANIFEST_VERSION = 1 as const;
const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJsonString = Schema.decodeUnknownSync(UnknownJsonString);
const encodeUnknownJsonString = Schema.encodeUnknownSync(UnknownJsonString);

interface ManifestEntry {
  readonly path: string;
  readonly updatedAt: string;
  readonly status: WorkspaceKnowledgeItem["status"];
}

interface WorkspaceKnowledgeManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly projectId: string;
  readonly entries: Record<string, ManifestEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(input: {
  readonly text: string;
  readonly projectId: string;
}): WorkspaceKnowledgeManifest {
  const parsed = decodeUnknownJsonString(input.text);
  if (
    !isRecord(parsed) ||
    parsed.version !== MANIFEST_VERSION ||
    parsed.projectId !== input.projectId ||
    !isRecord(parsed.entries)
  ) {
    throw new Error("Long-term-memory manifest is invalid or belongs to another Workspace.");
  }

  const entries: Record<string, ManifestEntry> = {};
  for (const [itemId, rawEntry] of Object.entries(parsed.entries)) {
    if (
      !isRecord(rawEntry) ||
      typeof rawEntry.path !== "string" ||
      typeof rawEntry.updatedAt !== "string" ||
      (rawEntry.status !== "candidate" &&
        rawEntry.status !== "active" &&
        rawEntry.status !== "superseded" &&
        rawEntry.status !== "archived")
    ) {
      throw new Error(`Long-term-memory manifest entry '${itemId}' is invalid.`);
    }
    entries[itemId] = {
      path: rawEntry.path,
      updatedAt: rawEntry.updatedAt,
      status: rawEntry.status,
    };
  }
  return { version: MANIFEST_VERSION, projectId: input.projectId, entries };
}

function normalizeLogicalFolder(relativeFolder: string | null): ReadonlyArray<string> {
  if (relativeFolder === null) return ["_root"];
  const normalized = relativeFolder.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("Long-term-memory relative folder escapes its Workspace root.");
  }
  return segments;
}

function normalizeManifestPath(relativePath: string): ReadonlyArray<string> {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("Long-term-memory manifest contains an unsafe path.");
  }
  return segments;
}

export function renderWorkspaceKnowledgeMarkdown(item: WorkspaceKnowledgeItem): string {
  const metadata = encodeUnknownJsonString({
    version: MANIFEST_VERSION,
    workspaceId: item.projectId,
    memoryId: item.id,
    kind: item.kind,
    title: item.title,
    status: item.status,
    origin: item.origin,
    logicalFolder: item.relativeFolder,
    scope: item.scope ?? "project",
    appliesToFolder: item.appliesToFolder ?? null,
    research: item.research ?? null,
    tags: item.tags,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
  const heading = item.title.replace(/\s+/g, " ").trim();
  const body = item.content.endsWith("\n") ? item.content : `${item.content}\n`;
  return `<!-- NewAutoUsage workspace memory: ${metadata} -->\n\n# ${heading}\n\n${body}`;
}

export const makeWorkspaceKnowledgeFileStore = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const syncItemUnsafe = Effect.fn("WorkspaceKnowledgeFileStore.syncItem")(function* (input: {
    readonly root: string;
    readonly item: WorkspaceKnowledgeItem;
  }) {
    const { root, item } = input;
    if (item.kind !== "long-term-memory") {
      return yield* new WorkspaceKnowledgeFileStoreError({
        message: `Only long-term-memory items can be mirrored (received '${item.kind}').`,
      });
    }

    const rootPath = path.resolve(root);
    const logicalFolder = yield* Effect.try({
      try: () => normalizeLogicalFolder(item.relativeFolder),
      catch: (cause) =>
        new WorkspaceKnowledgeFileStoreError({
          message: "Invalid Workspace long-term-memory relative folder.",
          cause,
        }),
    });
    yield* fileSystem.makeDirectory(rootPath, { recursive: true });
    const realRoot = yield* fileSystem.realPath(rootPath);
    const manifestDirectory = path.join(realRoot, STORE_DIRECTORY);
    const manifestPath = path.join(manifestDirectory, "index.json");

    const assertContained = (candidate: string) =>
      Effect.gen(function* () {
        const relative = path.relative(realRoot, candidate);
        if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
          return yield* new WorkspaceKnowledgeFileStoreError({
            message: "Long-term-memory file path escaped its Workspace root.",
          });
        }
      });

    const ensureContainedDirectory = (directory: string) =>
      Effect.gen(function* () {
        let existingAncestor = directory;
        while (!(yield* fileSystem.exists(existingAncestor))) {
          const parent = path.dirname(existingAncestor);
          if (parent === existingAncestor) {
            return yield* new WorkspaceKnowledgeFileStoreError({
              message: "Cannot locate a safe long-term-memory parent directory.",
            });
          }
          existingAncestor = parent;
        }
        const realAncestor = yield* fileSystem.realPath(existingAncestor);
        if (realAncestor !== realRoot) yield* assertContained(realAncestor);
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        const realDirectory = yield* fileSystem.realPath(directory);
        yield* assertContained(realDirectory);
      });

    yield* ensureContainedDirectory(manifestDirectory);
    if (yield* fileSystem.exists(manifestPath)) {
      const realManifestPath = yield* fileSystem.realPath(manifestPath);
      yield* assertContained(realManifestPath);
    }

    const manifest: WorkspaceKnowledgeManifest = yield* Effect.gen(function* () {
      if (!(yield* fileSystem.exists(manifestPath))) {
        return {
          version: MANIFEST_VERSION,
          projectId: item.projectId,
          entries: {} as Record<string, ManifestEntry>,
        } satisfies WorkspaceKnowledgeManifest;
      }
      const text = yield* fileSystem.readFileString(manifestPath);
      return yield* Effect.try({
        try: () => parseManifest({ text, projectId: item.projectId }),
        catch: (cause) =>
          new WorkspaceKnowledgeFileStoreError({
            message: "Cannot read the Workspace long-term-memory manifest safely.",
            cause,
          }),
      });
    });

    const previousEntry = manifest.entries[item.id];
    const targetRelativePath =
      previousEntry?.path ?? ["entries", ...logicalFolder, `${item.id}.md`].join("/");
    const targetRelativeSegments = yield* Effect.try({
      try: () => normalizeManifestPath(targetRelativePath),
      catch: (cause) =>
        new WorkspaceKnowledgeFileStoreError({
          message: "Cannot write an unsafe Workspace long-term-memory record.",
          cause,
        }),
    });
    if (
      targetRelativeSegments[0] !== "entries" ||
      targetRelativeSegments[targetRelativeSegments.length - 1] !== `${item.id}.md`
    ) {
      return yield* new WorkspaceKnowledgeFileStoreError({
        message: "Cannot write a Workspace long-term-memory record outside its entries path.",
      });
    }
    const targetPath = path.join(realRoot, ...targetRelativeSegments);
    yield* assertContained(targetPath);
    if (previousEntry !== undefined && !(yield* fileSystem.exists(path.dirname(targetPath)))) {
      return yield* new WorkspaceKnowledgeFileStoreError({
        message: "Cannot update a Workspace long-term-memory file in a missing directory.",
      });
    }
    yield* ensureContainedDirectory(path.dirname(targetPath));
    const targetExists = yield* fileSystem.exists(targetPath);
    if (targetExists) {
      const realTargetPath = yield* fileSystem.realPath(targetPath);
      yield* assertContained(realTargetPath);
      if (previousEntry === undefined) {
        return yield* new WorkspaceKnowledgeFileStoreError({
          message: "Cannot overwrite an untracked Workspace long-term-memory file.",
        });
      }
    } else if (previousEntry !== undefined) {
      return yield* new WorkspaceKnowledgeFileStoreError({
        message: "Cannot update a missing Workspace long-term-memory file.",
      });
    }
    const nextContents = renderWorkspaceKnowledgeMarkdown(item);
    const previousContents = targetExists ? yield* fileSystem.readFileString(targetPath) : null;
    if (previousContents !== nextContents) {
      yield* fileSystem.writeFileString(targetPath, nextContents);
    }
    const nextManifest: WorkspaceKnowledgeManifest = {
      ...manifest,
      entries: {
        ...manifest.entries,
        [item.id]: {
          path: targetRelativePath,
          updatedAt: item.updatedAt,
          status: item.status,
        },
      },
    };
    if (
      previousEntry === undefined ||
      previousEntry.path !== targetRelativePath ||
      previousEntry.updatedAt !== item.updatedAt ||
      previousEntry.status !== item.status
    ) {
      yield* fileSystem.writeFileString(manifestPath, `${encodeUnknownJsonString(nextManifest)}\n`);
    }
  });

  const syncItem: WorkspaceKnowledgeFileStoreShape["syncItem"] = (input) =>
    syncItemUnsafe(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) =>
        cause instanceof WorkspaceKnowledgeFileStoreError
          ? cause
          : new WorkspaceKnowledgeFileStoreError({
              message: `Failed to synchronize long-term memory '${input.item.id}' for Workspace '${input.item.projectId}'.`,
              cause,
            }),
      ),
    );

  return { syncItem } satisfies WorkspaceKnowledgeFileStoreShape;
});

export const WorkspaceKnowledgeFileStoreLive = Layer.effect(
  WorkspaceKnowledgeFileStore,
  makeWorkspaceKnowledgeFileStore,
);
