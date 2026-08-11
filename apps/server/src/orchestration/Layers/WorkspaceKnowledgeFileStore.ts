import type { WorkspaceKnowledgeItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
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

function historyFileName(updatedAt: string): string {
  return `${updatedAt.replaceAll(":", "-")}.md`;
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
    const targetRelativeSegments = ["entries", ...logicalFolder, `${item.id}.md`];
    const targetRelativePath = targetRelativeSegments.join("/");
    const manifestDirectory = path.join(rootPath, STORE_DIRECTORY);
    const manifestPath = path.join(manifestDirectory, "index.json");

    yield* fileSystem.makeDirectory(rootPath, { recursive: true });
    const realRoot = yield* fileSystem.realPath(rootPath);

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

    const targetPath = path.join(rootPath, ...targetRelativeSegments);
    yield* ensureContainedDirectory(path.dirname(targetPath));
    const nextContents = renderWorkspaceKnowledgeMarkdown(item);
    const previousEntry = manifest.entries[item.id];

    if (previousEntry !== undefined) {
      const oldSegments = yield* Effect.try({
        try: () => normalizeManifestPath(previousEntry.path),
        catch: (cause) =>
          new WorkspaceKnowledgeFileStoreError({
            message: "Cannot move an unsafe Workspace long-term-memory record.",
            cause,
          }),
      });
      const previousPath = path.join(rootPath, ...oldSegments);
      yield* assertContained(previousPath);
      if (yield* fileSystem.exists(previousPath)) {
        const realPreviousPath = yield* fileSystem.realPath(previousPath);
        yield* assertContained(realPreviousPath);
        const previousContents = yield* fileSystem.readFileString(previousPath);
        if (previousContents !== nextContents) {
          const historyPath = path.join(
            manifestDirectory,
            "history",
            item.id,
            historyFileName(previousEntry.updatedAt),
          );
          yield* ensureContainedDirectory(path.dirname(historyPath));
          yield* writeFileStringAtomically({ filePath: historyPath, contents: previousContents });
        }
        if (previousPath !== targetPath) {
          yield* fileSystem.remove(previousPath, { force: true });
        }
      }
    }

    yield* writeFileStringAtomically({ filePath: targetPath, contents: nextContents });
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
    yield* writeFileStringAtomically({
      filePath: manifestPath,
      contents: `${encodeUnknownJsonString(nextManifest)}\n`,
    });
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
