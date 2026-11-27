import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { createJSONStorage } from "zustand/middleware";
import {
  defaultInstanceIdForDriver,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  findThreadModelTeam,
  type ModelSelection,
  type ThreadModelTeam,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { derivePhysicalProjectKeyFromPath } from "@t3tools/client-runtime/state/project-grouping";

// The composer draft's `modelSelectionByProvider` and
// `stickyModelSelectionByProvider` maps are keyed by `ProviderInstanceId`
// in production; these aliases keep the legacy-key migration tests concise.
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const CODEX_SECONDARY_INSTANCE = ProviderInstanceId.make("codex_secondary");
const CLAUDE_AGENT_INSTANCE = ProviderInstanceId.make("claudeAgent");
const CURSOR_INSTANCE = ProviderInstanceId.make("cursor");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

type ProviderOptionSelectionBag = ReadonlyArray<ProviderOptionSelection>;
type ProviderOptionSelectionsByProvider = Partial<Record<string, ProviderOptionSelectionBag>>;

function toSelections(
  options: Record<string, string | boolean | undefined> | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  const result: Array<ProviderOptionSelection> = [];
  if (!options) return result;
  for (const [id, value] of Object.entries(options)) {
    if (typeof value === "string" || typeof value === "boolean") {
      result.push({ id, value });
    }
  }
  return result;
}

function selectionsByProvider(
  options: Partial<Record<ProviderDriverKind, Record<string, string | boolean | undefined>>>,
): ProviderOptionSelectionsByProvider {
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, bag] of Object.entries(options) as Array<
    [ProviderDriverKind, Record<string, string | boolean | undefined>]
  >) {
    result[provider] = toSelections(bag);
  }
  return result;
}
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  clearComposerDraftsEnvironment,
  selectDraftIdByThreadRef,
  restoreDraftFolderProjectId,
  selectDraftModelTeams,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThread,
  markPromotedDraftThreadByRef,
  markPromotedDraftThreads,
  markPromotedDraftThreadsByRef,
  type ComposerImageAttachment,
  useComposerDraftStore,
  DraftId,
} from "./composerDraftStore";
import { removeLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";

function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function makeTerminalContext(input: {
  id: string;
  text?: string;
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: ThreadId.make("thread-dedupe"),
    terminalId: input.terminalId ?? "default",
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
  };
}

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function modelSelection(
  provider: ProviderDriverKind,
  model: string,
  options?: Record<string, string | boolean | undefined>,
): ModelSelection {
  return createModelSelection(defaultInstanceIdForDriver(provider), model, toSelections(options));
}

function providerModelOptions(
  options: Partial<Record<string, Record<string, string | boolean | undefined>>>,
): ProviderOptionSelectionsByProvider {
  return selectionsByProvider(options);
}

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const OTHER_TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const LEGACY_TEST_ENVIRONMENT_ID = EnvironmentId.make("__legacy__");

function threadKeyFor(
  threadId: ThreadId,
  environmentId: EnvironmentId = LEGACY_TEST_ENVIRONMENT_ID,
): string {
  if (environmentId === LEGACY_TEST_ENVIRONMENT_ID) {
    return threadId;
  }
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function draftFor(threadId: ThreadId, environmentId: EnvironmentId = LEGACY_TEST_ENVIRONMENT_ID) {
  const store = useComposerDraftStore.getState().draftsByThreadKey;
  return store[threadKeyFor(threadId, environmentId)] ?? store[threadId] ?? undefined;
}

function draftByKey(key: string) {
  return useComposerDraftStore.getState().draftsByThreadKey[key] ?? undefined;
}

describe("composerDraftStore addImages", () => {
  const threadId = ThreadId.make("thread-dedupe");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("deduplicates identical images in one batch by file signature", () => {
    const first = makeImage({
      id: "img-1",
      previewUrl: "blob:first",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });
    const duplicate = makeImage({
      id: "img-2",
      previewUrl: "blob:duplicate",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });

    useComposerDraftStore.getState().addImages(threadRef, [first, duplicate]);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-1"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:duplicate");
  });

  it("deduplicates against existing images across calls by file signature", () => {
    const first = makeImage({
      id: "img-a",
      previewUrl: "blob:a",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 777,
    });
    const duplicateLater = makeImage({
      id: "img-b",
      previewUrl: "blob:b",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 999,
    });

    useComposerDraftStore.getState().addImage(threadRef, first);
    useComposerDraftStore.getState().addImage(threadRef, duplicateLater);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-a"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });

  it("does not revoke blob URLs that are still used by an accepted duplicate image", () => {
    const first = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });
    const duplicateSameUrl = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });

    useComposerDraftStore.getState().addImages(threadRef, [first, duplicateSameUrl]);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-shared"]);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:shared");
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const threadId = ThreadId.make("thread-clear");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("does not revoke blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(threadRef, first);

    useComposerDraftStore.getState().clearComposerContent(threadRef);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });
});

describe("composerDraftStore syncPersistedAttachments", () => {
  const threadId = ThreadId.make("thread-sync-persisted");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  afterEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
  });

  it("treats malformed persisted draft storage as empty", async () => {
    const image = makeImage({
      id: "img-persisted",
      previewUrl: "blob:persisted",
    });
    useComposerDraftStore.getState().addImage(threadRef, image);
    setLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      {
        version: 2,
        state: {
          draftsByThreadId: {
            [threadId]: {
              attachments: "not-an-array",
            },
          },
        },
      },
      Schema.Unknown,
    );

    useComposerDraftStore.getState().syncPersistedAttachments(threadRef, [
      {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.previewUrl,
      },
    ]);
    await Promise.resolve();

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.persistedAttachments).toEqual([]);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.nonPersistedImageIds).toEqual([image.id]);
  });
});

describe("composerDraftStore terminal contexts", () => {
  const threadId = ThreadId.make("thread-dedupe");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("deduplicates identical terminal contexts by selection signature", () => {
    const first = makeTerminalContext({ id: "ctx-1" });
    const duplicate = makeTerminalContext({ id: "ctx-2" });

    useComposerDraftStore.getState().addTerminalContexts(threadRef, [first, duplicate]);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-1"]);
  });

  it("clears terminal contexts when clearing composer content", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadRef, makeTerminalContext({ id: "ctx-1" }));

    useComposerDraftStore.getState().clearComposerContent(threadRef);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("inserts terminal contexts at the requested inline prompt position", () => {
    const firstInsertion = insertInlineTerminalContextPlaceholder("alpha beta", 6);
    const secondInsertion = insertInlineTerminalContextPlaceholder(firstInsertion.prompt, 0);

    expect(
      useComposerDraftStore
        .getState()
        .insertTerminalContext(
          threadRef,
          firstInsertion.prompt,
          makeTerminalContext({ id: "ctx-1" }),
          firstInsertion.contextIndex,
        ),
    ).toBe(true);
    expect(
      useComposerDraftStore.getState().insertTerminalContext(
        threadRef,
        secondInsertion.prompt,
        makeTerminalContext({
          id: "ctx-2",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
        }),
        secondInsertion.contextIndex,
      ),
    ).toBe(true);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.prompt).toBe(
      `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} alpha ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} beta`,
    );
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-2", "ctx-1"]);
  });

  it("omits terminal context text from persisted drafts", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadRef, makeTerminalContext({ id: "ctx-persist" }));

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { terminalContexts?: Array<Record<string, unknown>> }>;
    };

    expect(
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.terminalContexts?.[0],
      "Expected terminal context metadata to be persisted.",
    ).toMatchObject({
      id: "ctx-persist",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 4,
      lineEnd: 5,
    });
    expect(
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.terminalContexts?.[0]?.text,
    ).toBeUndefined();
  });

  it("hydrates persisted terminal contexts without in-memory snapshot text", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
            attachments: [],
            terminalContexts: [
              {
                id: "ctx-rehydrated",
                threadId,
                createdAt: "2026-03-13T12:00:00.000Z",
                terminalId: "default",
                terminalLabel: "Terminal 1",
                lineStart: 4,
                lineEnd: 5,
              },
            ],
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectKey: {},
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]?.terminalContexts).toMatchObject([
      {
        id: "ctx-rehydrated",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 5,
        text: "",
      },
    ]);
  });

  it("sanitizes malformed persisted drafts during merge", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: "",
            attachments: "not-an-array",
            terminalContexts: "not-an-array",
            provider: "bogus-provider",
            modelOptions: "not-an-object",
          },
        },
        draftThreadsByThreadId: "not-an-object",
        projectDraftThreadIdByProjectKey: "not-an-object",
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]).toBeUndefined();
    expect(mergedState.draftThreadsByThreadKey).toEqual({});
    expect(mergedState.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({});
  });
});

describe("composerDraftStore element contexts", () => {
  const threadId = ThreadId.make("thread-element");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  const baseSelection = {
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    tagName: "button",
    selector: "button.submit",
    htmlPreview: "<button>Save</button>",
    componentName: "SubmitButton",
    source: {
      functionName: "SubmitButton",
      fileName: "/repo/Button.tsx",
      lineNumber: 12,
      columnNumber: 5,
    },
    styles: ".submit { color: white; }",
  } as const;

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("adds an element context and stamps id + threadId + pickedAt", () => {
    const accepted = useComposerDraftStore.getState().addElementContext(threadRef, baseSelection);
    expect(accepted).toBe(true);
    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.elementContexts).toHaveLength(1);
    const entry = draft?.elementContexts[0]!;
    expect(entry.id.startsWith("el_")).toBe(true);
    expect(entry.threadId).toBe(threadId);
    expect(entry.pickedAt.length).toBeGreaterThan(0);
    expect(entry.componentName).toBe("SubmitButton");
  });

  it("dedupes by selector + tag + componentName + pageUrl signature", () => {
    const store = useComposerDraftStore.getState();
    expect(store.addElementContext(threadRef, baseSelection)).toBe(true);
    const second = store.addElementContext(threadRef, {
      ...baseSelection,
      htmlPreview: "<button>Save 2</button>",
    });
    expect(second).toBe(false);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.elementContexts).toHaveLength(1);
  });

  it("removeElementContext drops by id + leaves siblings intact", () => {
    const store = useComposerDraftStore.getState();
    store.addElementContext(threadRef, baseSelection);
    store.addElementContext(threadRef, { ...baseSelection, selector: "button.cancel" });
    const ids = draftFor(threadId, TEST_ENVIRONMENT_ID)!.elementContexts.map((c) => c.id);
    store.removeElementContext(threadRef, ids[0]!);
    const remaining = draftFor(threadId, TEST_ENVIRONMENT_ID)?.elementContexts;
    expect(remaining?.map((c) => c.id)).toEqual([ids[1]]);
  });

  it("setElementContexts replaces the slice and clearComposerContent wipes it", () => {
    const store = useComposerDraftStore.getState();
    store.addElementContext(threadRef, baseSelection);
    store.setElementContexts(threadRef, []);
    // Fully empty draft should be removed via shouldRemoveDraft.
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();

    store.addElementContext(threadRef, baseSelection);
    store.clearComposerContent(threadRef);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("persists element contexts via the partializer (round-trippable)", () => {
    useComposerDraftStore.getState().addElementContext(threadRef, baseSelection);
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persisted = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { elementContexts?: Array<Record<string, unknown>> }>;
    };
    const entry =
      persisted.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.elementContexts?.[0];
    expect(entry).toMatchObject({
      pageUrl: baseSelection.pageUrl,
      tagName: baseSelection.tagName,
      selector: baseSelection.selector,
      componentName: baseSelection.componentName,
    });
    // Persistence does NOT include htmlPreview / styles oversize-clamping —
    // that happens at normalization time, before the value reaches the store.
    expect(typeof entry?.htmlPreview).toBe("string");
  });
});

describe("composerDraftStore review comments", () => {
  const threadId = ThreadId.make("thread-review-comment");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  const comment = {
    id: "comment-1",
    sectionId: "file:src/app.ts",
    sectionTitle: "File comment",
    filePath: "src/app.ts",
    startIndex: 1,
    endIndex: 2,
    rangeLabel: "L2 to L3",
    text: "Keep this configurable.",
    diff: "@@ -2,2 +2,2 @@\n two\n three",
  } as const;

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("upserts and removes review comments by id", () => {
    const store = useComposerDraftStore.getState();
    store.addReviewComment(threadRef, comment);
    store.addReviewComment(threadRef, { ...comment, text: "Updated comment." });

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.reviewComments).toEqual([
      { ...comment, text: "Updated comment." },
    ]);

    store.removeReviewComment(threadRef, comment.id);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("persists review comments and clears them with composer content", () => {
    const store = useComposerDraftStore.getState();
    store.addReviewComment(threadRef, comment);
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persisted = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { reviewComments?: Array<Record<string, unknown>> }>;
    };

    expect(
      persisted.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.reviewComments?.[0],
    ).toMatchObject(comment);

    store.clearComposerContent(threadRef);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("stores review comments against a new-thread draft id", () => {
    const draftId = DraftId.make("draft-review-comment");
    useComposerDraftStore.getState().addReviewComment(draftId, comment);

    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.reviewComments).toEqual([
      comment,
    ]);
  });
});

describe("composerDraftStore local draft model teams", () => {
  const draftId = DraftId.make("draft-team-session");
  const threadId = ThreadId.make("future-server-thread");
  const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, ProjectId.make("team-project"));
  const remoteProject = scopeProjectRef(OTHER_TEST_ENVIRONMENT_ID, projectRef.projectId);
  const parent = ProviderInstanceId.make("primary-account");
  const second = ProviderInstanceId.make("other-account");
  const team: ThreadModelTeam = {
    threadId,
    answeringInstanceId: parent,
    forModel: "parent-model",
    members: [
      {
        instanceId: second,
        model: "worker-model",
        role: "advisor",
        instructions: "Review the output.",
      },
    ],
  };
  const read = () => selectDraftModelTeams(useComposerDraftStore.getState(), draftId);
  beforeEach(resetComposerDraftStore);

  it("retains the server project ID, draft team and prompt when reopening a Windows folder without a remote", () => {
    const logicalKey = derivePhysicalProjectKeyFromPath(
      projectRef.environmentId,
      "C:\\Projects\\Keep",
    );
    const store = useComposerDraftStore.getState();
    store.setLogicalProjectDraftThreadId(logicalKey, projectRef, draftId, { threadId });
    store.setPrompt(draftId, "first request");
    store.updateDraftModelTeam(draftId, team);
    const { partialize, merge } = useComposerDraftStore.persist.getOptions();
    const snapshot = JSON.parse(JSON.stringify(partialize!(useComposerDraftStore.getState())));
    useComposerDraftStore.setState(merge!(snapshot, useComposerDraftStore.getInitialState()), true);
    expect(store.getDraftSession(draftId)).toMatchObject({
      ...projectRef,
      threadId,
      logicalProjectKey: logicalKey,
      modelTeams: [team],
    });
    expect(store.getDraftSessionByLogicalProjectKey(logicalKey)?.draftId).toBe(draftId);
    expect(store.getComposerDraft(draftId)?.prompt).toBe("first request");
  });

  it("uses the legacy scoped index to restore missing physical metadata without treating a modern index as a server ID", () => {
    const merge = useComposerDraftStore.persist.getOptions().merge!;
    const key = scopedProjectKey(projectRef);
    const current = useComposerDraftStore.getInitialState();
    const legacy = merge({ projectDraftThreadKeyByProjectKey: { [key]: draftId } }, current);
    expect(legacy.draftThreadsByThreadKey[draftId]).toMatchObject(projectRef);
    const logical = merge(
      { logicalProjectDraftThreadKeyByLogicalProjectKey: { [key]: draftId } },
      current,
    );
    expect(logical.draftThreadsByThreadKey[draftId]).toBeUndefined();
  });

  it("recovers an already overwritten ID only from a unique folder in the original environment", () => {
    const store = useComposerDraftStore.getState();
    const { environmentId } = projectRef;
    const workspaceRoot = "C:\\Projects\\Keep";
    const logicalKey = derivePhysicalProjectKeyFromPath(environmentId, workspaceRoot);
    const pathId = ProjectId.make(logicalKey.slice(environmentId.length + 1));
    store.setLogicalProjectDraftThreadId(
      logicalKey,
      { environmentId, projectId: pathId },
      draftId,
      {
        threadId,
        branch: "keep-branch",
        worktreePath: "C:\\Worktrees\\Keep",
      },
    );
    store.setPrompt(draftId, "unsent message");
    store.updateDraftModelTeam(draftId, team);
    const original = store.getDraftSession(draftId)!;
    const match = { environmentId, id: projectRef.projectId, workspaceRoot };
    const foreign = { ...match, environmentId: OTHER_TEST_ENVIRONMENT_ID };
    const emptyWorkspace = { tabs: [], lastChatViewByProjectKey: {} };
    for (const catalog of [
      [foreign],
      [match, { ...match, id: ProjectId.make("duplicate") }],
      [match, { ...match, id: pathId }],
    ]) {
      restoreDraftFolderProjectId(draftId, catalog, emptyWorkspace);
      expect(store.getDraftSession(draftId)).toBe(original);
    }
    restoreDraftFolderProjectId(draftId, [foreign, match], emptyWorkspace);
    expect(store.getDraftSession(draftId)).toEqual({
      ...original,
      projectId: projectRef.projectId,
    });
    expect(store.getComposerDraft(draftId)?.prompt).toBe("unsent message");
  });

  it.each(["draft", "thread"] as const)(
    "uses an exact remembered %s reference to resolve projects sharing one Windows folder",
    (kind) => {
      const store = useComposerDraftStore.getState();
      const { environmentId } = projectRef;
      const workspaceRoot = "C:\\Projects\\Keep";
      const logicalKey = derivePhysicalProjectKeyFromPath(environmentId, workspaceRoot);
      const pathId = ProjectId.make(logicalKey.slice(environmentId.length + 1));
      store.setLogicalProjectDraftThreadId(
        logicalKey,
        { environmentId, projectId: pathId },
        draftId,
        { threadId },
      );
      store.updateDraftModelTeam(draftId, team);
      const folder = { environmentId, workspaceRoot, id: projectRef.projectId };
      const catalog = [folder, { ...folder, id: ProjectId.make("other-project") }];
      const key = scopedProjectKey(projectRef);
      const view = kind === "draft" ? { kind, draftId } : { kind, environmentId, threadId };
      const otherKey = scopedProjectKey(scopeProjectRef(environmentId, catalog[1]!.id));
      restoreDraftFolderProjectId(draftId, catalog, {
        tabs: [],
        lastChatViewByProjectKey: { [key]: view, [otherKey]: view },
      });
      expect(store.getDraftSession(draftId)?.projectId).toBe(pathId);
      restoreDraftFolderProjectId(draftId, catalog, {
        tabs: [{ id: "saved-tab", view, projectKey: key, lastActivatedAt: 0 }],
        lastChatViewByProjectKey: { [otherKey]: { kind: "draft", draftId: "unrelated" } },
      });
      expect(store.getDraftSession(draftId)).toMatchObject({
        ...projectRef,
        threadId,
        modelTeams: [team],
      });
    },
  );

  it("rehydrates local teams through persisted JSON independently of prompt, model and account switches", async () => {
    const memory = createMemoryStorage();
    const persist = useComposerDraftStore.persist;
    const originalStorage = persist.getOptions().storage!;
    persist.setOptions({ storage: createJSONStorage(() => memory)! });
    try {
      const store = useComposerDraftStore.getState();
      store.setProjectDraftThreadId(projectRef, draftId, { threadId });
      store.updateDraftModelTeam(draftId, team);
      const otherModel = { ...team, forModel: "another-model", members: [] };
      const otherAccount = { ...team, answeringInstanceId: second, members: [] };
      for (const scope of [otherModel, otherAccount]) {
        store.setModelSelection(
          draftId,
          createModelSelection(scope.answeringInstanceId, scope.forModel),
        );
        store.updateDraftModelTeam(draftId, scope);
      }
      store.setModelSelection(draftId, createModelSelection(parent, team.forModel));
      store.setDraftThreadContext(draftId, { branch: "feature" });
      store.setProjectDraftThreadId(projectRef, draftId, { threadId });
      store.clearComposerContent(draftId);
      const json = await memory.getItem(COMPOSER_DRAFT_STORAGE_KEY);
      expect(json).toBeTruthy();
      resetComposerDraftStore();
      await memory.setItem(COMPOSER_DRAFT_STORAGE_KEY, json!);
      await persist.rehydrate();
      expect(read()).toEqual([team, otherModel, otherAccount]);
      const scope = { ...team, forModel: "PARENT-MODEL" };
      expect(findThreadModelTeam(read(), scope)?.members).toEqual(team.members);
      store.updateDraftModelTeam(draftId, { ...scope, members: [] });
      expect(read()).toHaveLength(3);
      expect(findThreadModelTeam(read(), team)?.members).toEqual([]);
      store.updateDraftModelTeam(draftId, { ...scope, members: null });
      expect(read()).toEqual([otherModel, otherAccount]);
    } finally {
      persist.setOptions({ storage: originalStorage });
    }
  });

  it("keeps a copied account and its exact options through draft reload and promotion", async () => {
    const memory = createMemoryStorage();
    const persist = useComposerDraftStore.persist;
    const originalStorage = persist.getOptions().storage!;
    persist.setOptions({ storage: createJSONStorage(() => memory)! });
    try {
      const store = useComposerDraftStore.getState();
      const ref = scopeThreadRef(projectRef.environmentId, threadId);
      const style = {
        preset: "friendly",
        tone: "",
        length: "",
        explanation: "",
        instructions: "fixture",
      } as const;
      const source = { instanceId: parent, model: "exact-alias" };
      store.setProjectDraftThreadId(projectRef, draftId, { threadId });
      expect(
        store.setDraftResponseStyle(
          draftId,
          scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId),
          style,
        ),
      ).toBe(false);
      expect(store.setDraftResponseStyle(draftId, ref, style)).toBe(true);
      store.setStickyModelSelection({
        ...source,
        options: [{ id: "reasoningEffort", value: "high" }],
      });
      store.applyStickyState(draftId);
      store.setModelSelection(draftId, source, { replaceOptions: true, exactModel: true });
      store.applyStickyState(draftId);
      store.clearComposerContent(draftId);
      const json = await memory.getItem(COMPOSER_DRAFT_STORAGE_KEY);
      expect(json).toBeTruthy();
      resetComposerDraftStore();
      await memory.setItem(COMPOSER_DRAFT_STORAGE_KEY, json!);
      await persist.rehydrate();
      expect(store.getDraftSession(draftId)?.responseStyle).toEqual(style);
      expect(store.getComposerDraft(draftId)?.modelSelectionByProvider[parent]).toEqual(source);
      store.markDraftThreadPromoting(draftId, ref);
      expect(store.setDraftResponseStyle(draftId, ref, style)).toBe(false);
      finalizePromotedDraftThreadByRef(ref);
      expect(store.getDraftSession(draftId)).toBeNull();
      expect(store.getComposerDraft(ref)?.exactModel).toBe(true);
      expect(store.getComposerDraft(ref)?.modelSelectionByProvider[parent]).toEqual(source);
      store.setModelSelection(ref, { instanceId: second, model: "manual" });
      expect(store.getComposerDraft(ref)?.exactModel).toBeFalsy();
    } finally {
      persist.setOptions({ storage: originalStorage });
    }
  });

  it("isolates drafts by environment and removes their teams on discard or completed promotion", () => {
    const store = useComposerDraftStore.getState();
    const empty = read();
    const remoteId = DraftId.make("remote-draft");
    const remoteTeam = { ...team, members: [] };
    const localRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    const remoteRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId);
    const resolve = (ref: typeof localRef) =>
      selectDraftIdByThreadRef(useComposerDraftStore.getState(), ref);
    expect(selectDraftModelTeams(store, null)).toBe(empty);
    store.updateDraftModelTeam(draftId, team);
    expect(read()).toBe(empty);
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setProjectDraftThreadId(remoteProject, remoteId, { threadId });
    expect(resolve(localRef)).toBe(draftId);
    expect(resolve(remoteRef)).toBe(remoteId);
    store.updateDraftModelTeam(draftId, { ...team, threadId: ThreadId.make("different-thread") });
    expect(read()).toBe(empty);
    store.updateDraftModelTeam(draftId, team);
    const local = read();
    store.updateDraftModelTeam(remoteId, remoteTeam);
    expect(read()).toBe(local);
    store.markDraftThreadPromoting(draftId, localRef);
    store.updateDraftModelTeam(draftId, { ...team, members: null });
    expect(read()).toBe(local);
    finalizePromotedDraftThreadByRef(localRef);
    expect(resolve(localRef)).toBeNull();
    expect(read()).toBe(empty);
    expect(selectDraftModelTeams(useComposerDraftStore.getState(), remoteId)).toEqual([remoteTeam]);
    store.clearProjectDraftThreadById(remoteProject, remoteId);
    expect(resolve(remoteRef)).toBeNull();
    expect(selectDraftModelTeams(useComposerDraftStore.getState(), remoteId)).toBe(empty);
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    expect(read()).toBe(empty);
  });

  it("drops account-bound overrides when retargeting a draft and keeps old draft metadata intact", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    const empty = read();
    store.updateDraftModelTeam(draftId, team);
    store.setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(TEST_ENVIRONMENT_ID, ProjectId.make("same-environment")),
    });
    expect(read()).toEqual([team]);
    store.setDraftThreadContext(draftId, { projectRef: remoteProject });
    expect(read()).toBe(empty);
    store.updateDraftModelTeam(draftId, team);
    store.setProjectDraftThreadId(remoteProject, draftId, {
      threadId: ThreadId.make("replacement"),
    });
    expect(read()).toBe(empty);

    const { merge } = useComposerDraftStore.persist.getOptions();
    const oldDraft = { ...store.getDraftSession(draftId)!, threadId, branch: "old-branch" };
    const hydrate = (metadata: unknown) =>
      merge!({ draftThreadsByThreadKey: { [draftId]: metadata } }, store);
    const legacy = hydrate(oldDraft);
    expect(legacy.draftThreadsByThreadKey[draftId]?.branch).toBe("old-branch");
    expect(selectDraftModelTeams(legacy, draftId)).toBe(empty);
    const repaired = hydrate({
      ...oldDraft,
      modelTeams: [
        { ...team, threadId: "foreign-thread" },
        { ...team, members: [{}] },
        team,
        { ...team, forModel: "PARENT-MODEL" },
      ],
    });
    expect(selectDraftModelTeams(repaired, draftId)).toEqual([team]);
  });
});

describe("composerDraftStore project draft thread mapping", () => {
  const projectId = ProjectId.make("project-a");
  const otherProjectId = ProjectId.make("project-b");
  const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, projectId);
  const otherProjectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, otherProjectId);
  const remoteProjectRef = scopeProjectRef(OTHER_TEST_ENVIRONMENT_ID, projectId);
  const threadId = ThreadId.make("thread-a");
  const otherThreadId = ThreadId.make("thread-b");
  const draftId = DraftId.make("draft-a");
  const otherDraftId = DraftId.make("draft-b");
  const sharedDraftId = DraftId.make("draft-shared");
  const localDraftId = DraftId.make("draft-local");
  const remoteDraftId = DraftId.make("draft-remote");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("clears composer data for one environment without touching another", () => {
    const store = useComposerDraftStore.getState();
    const localThreadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    const remoteThreadRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, otherThreadId);
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeSpy = vi.fn<(url: string) => void>();
    URL.revokeObjectURL = revokeSpy;

    try {
      store.setProjectDraftThreadId(projectRef, localDraftId, { threadId });
      store.setProjectDraftThreadId(remoteProjectRef, remoteDraftId, {
        threadId: otherThreadId,
      });
      store.setPrompt(localDraftId, "local draft");
      store.setPrompt(remoteDraftId, "remote draft");
      store.addImage(localDraftId, makeImage({ id: "img-local", previewUrl: "blob:local-draft" }));
      store.setPrompt(localThreadRef, "local thread draft");
      store.setPrompt(remoteThreadRef, "remote thread draft");

      clearComposerDraftsEnvironment(TEST_ENVIRONMENT_ID);

      const next = useComposerDraftStore.getState();
      expect(next.getDraftThreadByProjectRef(projectRef)).toBeNull();
      expect(next.getDraftThreadByProjectRef(remoteProjectRef)).not.toBeNull();
      expect(next.getComposerDraft(localDraftId)).toBeNull();
      expect(next.getComposerDraft(remoteDraftId)?.prompt).toBe("remote thread draft");
      expect(next.getComposerDraft(localThreadRef)).toBeNull();
      expect(next.getComposerDraft(remoteThreadRef)?.prompt).toBe("remote thread draft");
      expect(revokeSpy).toHaveBeenCalledWith("blob:local-draft");
    } finally {
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it("stores and reads project draft thread ids via actions", () => {
    const store = useComposerDraftStore.getState();
    expect(store.getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(store.getDraftThread(draftId)).toBeNull();

    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toMatchObject({
      threadId,
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      logicalProjectKey: scopedProjectKey(projectRef),
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      logicalProjectKey: scopedProjectKey(projectRef),
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("clears only matching project draft mapping entries", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "hello");

    store.clearProjectDraftThreadById(projectRef, otherDraftId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    );

    store.clearProjectDraftThreadById(projectRef, draftId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("clears project draft mapping by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "hello");
    store.clearProjectDraftThreadId(projectRef);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("revokes draft image blob URLs when clearing a project's draft thread", () => {
    const store = useComposerDraftStore.getState();
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeSpy = vi.fn<(url: string) => void>();
    URL.revokeObjectURL = revokeSpy;

    try {
      store.setProjectDraftThreadId(projectRef, draftId, { threadId });
      store.addImage(draftId, makeImage({ id: "img-project-clear", previewUrl: "blob:clear" }));

      store.clearProjectDraftThreadId(projectRef);

      expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
      expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
      expect(revokeSpy).toHaveBeenCalledWith("blob:clear");
    } finally {
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it("revokes draft image blob URLs when clearing a matching project draft thread by id", () => {
    const store = useComposerDraftStore.getState();
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeSpy = vi.fn<(url: string) => void>();
    URL.revokeObjectURL = revokeSpy;

    try {
      store.setProjectDraftThreadId(projectRef, draftId, { threadId });
      store.addImage(
        draftId,
        makeImage({ id: "img-project-clear-by-id", previewUrl: "blob:clear-by-id" }),
      );

      store.clearProjectDraftThreadById(projectRef, draftId);

      expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
      expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
      expect(revokeSpy).toHaveBeenCalledWith("blob:clear-by-id");
    } finally {
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it("clears orphaned composer drafts when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "orphan me");

    store.setProjectDraftThreadId(projectRef, otherDraftId, { threadId: otherThreadId });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      otherThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("keeps composer drafts when the thread is still mapped by another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setProjectDraftThreadId(otherProjectRef, sharedDraftId, { threadId });
    store.setPrompt(sharedDraftId, "keep me");

    store.clearProjectDraftThreadId(projectRef);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectRef(otherProjectRef)?.threadId,
    ).toBe(threadId);
    expect(draftByKey(sharedDraftId)?.prompt).toBe("keep me");
  });

  it("clears draft registration independently", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "remove me");
    store.clearDraftThread(draftId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("marks a promoted draft by thread id without deleting composer state", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");

    markPromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.promotedTo).toEqual(
      scopeThreadRef(TEST_ENVIRONMENT_ID, threadId),
    );
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
  });

  it("reads local draft composer state through a scoped thread ref", () => {
    const store = useComposerDraftStore.getState();
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "scoped access");

    expect(store.getComposerDraft(draftId)?.prompt).toBe("scoped access");
    expect(store.getComposerDraft(threadRef)?.prompt).toBe("scoped access");
  });

  it("does not clear composer drafts for existing server threads during promotion cleanup", () => {
    const store = useComposerDraftStore.getState();
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    store.setPrompt(threadRef, "keep me");

    markPromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThread(threadRef)).toBeNull();
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("keep me");
  });

  it("marks promoted drafts from an iterable of server thread ids", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");
    store.setProjectDraftThreadId(otherProjectRef, otherDraftId, { threadId: otherThreadId });
    store.setPrompt(otherDraftId, "keep me");

    markPromotedDraftThreads([threadId]);

    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.promotedTo).toEqual(
      scopeThreadRef(TEST_ENVIRONMENT_ID, threadId),
    );
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectRef(otherProjectRef)?.threadId,
    ).toBe(otherThreadId);
    expect(draftByKey(otherDraftId)?.prompt).toBe("keep me");
  });

  it("marks every matching scoped draft when multiple environments share a thread id", () => {
    const store = useComposerDraftStore.getState();
    const localThreadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    const remoteThreadRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId);

    store.setProjectDraftThreadId(projectRef, localDraftId, { threadId });
    store.setPrompt(localDraftId, "local draft");
    store.setProjectDraftThreadId(remoteProjectRef, remoteDraftId, { threadId });
    store.setPrompt(remoteDraftId, "remote draft");

    markPromotedDraftThread(threadId);

    expect(store.getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(store.getDraftThreadByProjectRef(remoteProjectRef)).toBeNull();
    expect(store.getDraftThreadByRef(localThreadRef)?.promotedTo).toEqual(localThreadRef);
    expect(store.getDraftThreadByRef(remoteThreadRef)?.promotedTo).toEqual(remoteThreadRef);
    expect(draftByKey(localDraftId)?.prompt).toBe("local draft");
    expect(draftByKey(remoteDraftId)?.prompt).toBe("remote draft");
  });

  it("only marks promoted drafts for the matching environment ref", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");

    markPromotedDraftThreadByRef(scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId));

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    );
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
  });

  it("only marks iterable promotion cleanup entries for the matching environment refs", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");

    markPromotedDraftThreadsByRef([scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId)]);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    );
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
  });

  it("keeps existing server-thread composer drafts during iterable promotion cleanup", () => {
    const store = useComposerDraftStore.getState();
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    store.setPrompt(threadRef, "keep me");

    markPromotedDraftThreads([threadId]);

    expect(useComposerDraftStore.getState().getDraftThread(threadRef)).toBeNull();
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("keep me");
  });

  it("finalizes a promoted draft after the canonical thread route is active", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");
    markPromotedDraftThread(threadId);

    finalizePromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("finalizes a matching materialized draft even when promotion was not pre-marked", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");

    finalizePromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("updates branch context on an existing draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "main",
      worktreePath: null,
    });
    store.setDraftThreadContext(draftId, {
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
      envMode: "worktree",
    });
  });

  it("stores the start-from-origin choice with the draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      envMode: "worktree",
      startFromOrigin: true,
    });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.startFromOrigin).toBe(true);

    store.setDraftThreadContext(draftId, { startFromOrigin: false });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.startFromOrigin).toBe(false);
  });

  it("preserves existing branch and worktree when setProjectDraftThreadId receives undefined", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
    };
    store.setProjectDraftThreadId(projectRef, draftId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
      envMode: "worktree",
    });
  });

  it("preserves worktree env mode without a worktree path", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
      envMode: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: "local" | "worktree";
    };
    store.setProjectDraftThreadId(projectRef, draftId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
  });

  it("clears branch and worktree but keeps env mode when remapping a draft to another environment", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "feature/local-only",
      worktreePath: "/tmp/local-worktree",
      envMode: "worktree",
      startFromOrigin: true,
    });

    store.setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), remoteProjectRef, draftId, {
      threadId,
    });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: OTHER_TEST_ENVIRONMENT_ID,
      projectId,
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("clears branch and worktree but keeps env mode when changing a draft thread project ref", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "feature/local-only",
      worktreePath: "/tmp/local-worktree",
      envMode: "worktree",
      startFromOrigin: true,
    });

    store.setDraftThreadContext(draftId, {
      projectRef: remoteProjectRef,
    });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: OTHER_TEST_ENVIRONMENT_ID,
      projectId,
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
    });
  });
});

describe("composerDraftStore modelSelection", () => {
  const threadId = ThreadId.make("thread-model-options");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a model selection in the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadRef,
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );
  });

  it("keeps a newly selected model in its conversation when draft content is cleared", () => {
    const store = useComposerDraftStore.getState();
    const otherThreadId = ThreadId.make("other-model-conversation");
    const otherThreadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, otherThreadId);
    const nextModel = modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6");
    const otherModel = modelSelection(CODEX_DRIVER, "gpt-5.4");

    store.setModelSelection(otherThreadRef, otherModel);
    store.setModelSelection(threadRef, nextModel);
    store.setPrompt(threadRef, "다음 요청");
    store.clearComposerContent(threadRef);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.activeProvider).toBe(CLAUDE_AGENT_INSTANCE);
    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(nextModel);
    expect(
      draftFor(otherThreadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(otherModel);
  });

  it("keeps default-only model selections on the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, "gpt-5.4"));
  });

  it("replaces only the targeted provider options on the current model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );
    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
      {
        persistSticky: true,
      },
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: false,
      }),
    );
  });

  it("keeps explicit default-state overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        effort: "max",
      }),
    );

    store.setProviderModelOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ thinking: true }));

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({});
  });

  it("keeps explicit off/default codex overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4", { fastMode: true }));

    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "high", fastMode: false }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4", {
        reasoningEffort: "high",
        fastMode: false,
      }),
    );
  });

  it("keeps explicit Cursor reset overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadRef,
      modelSelection(CURSOR_DRIVER, "claude-opus-4-6", {
        reasoning: "xhigh",
        fastMode: true,
        thinking: false,
      }),
    );

    store.setProviderModelOptions(
      threadRef,
      CURSOR_DRIVER,
      toSelections({ reasoning: "medium", fastMode: false, thinking: true }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, "claude-opus-4-6", {
        reasoning: "medium",
        fastMode: false,
        thinking: true,
      }),
    );
  });

  it("preserves the selected Cursor model when only traits change", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(threadRef, CURSOR_DRIVER, toSelections({ reasoning: "high" }), {
      model: "gpt-5.4",
      persistSticky: true,
    });

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: "high",
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: "high",
      }),
    );
  });

  it("updates only the draft when sticky persistence is omitted", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }));
  });

  it("does not clear other provider options when setting options for a single provider", () => {
    const store = useComposerDraftStore.getState();

    // Set options for both providers
    store.setModelOptions(
      threadRef,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    // Now set options for only codex — claudeAgent should be untouched
    store.setModelOptions(threadRef, providerModelOptions({ codex: { reasoningEffort: "xhigh" } }));

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]?.options).toEqual(
      createModelSelection(CODEX_INSTANCE, "gpt-5.4", toSelections({ reasoningEffort: "xhigh" }))
        .options,
    );
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]?.options).toEqual(
      createModelSelection(
        CLAUDE_AGENT_INSTANCE,
        "claude-opus-4-6",
        toSelections({ effort: "max" }),
      ).options,
    );
  });

  it("preserves other provider options when switching the active model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelOptions(
      threadRef,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    store.setModelSelection(threadRef, modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"));

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]?.options).toEqual(
      createModelSelection(CODEX_INSTANCE, "gpt-5.4", toSelections({ fastMode: true })).options,
    );
    expect(draft?.activeProvider).toBe("claudeAgent");
  });

  it("creates the first sticky snapshot from provider option changes", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));

    store.setProviderModelOptions(threadRef, CODEX_DRIVER, toSelections({ fastMode: true }), {
      persistSticky: true,
    });

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4", {
        fastMode: true,
      }),
    );
  });

  it("stores provider option changes on a selected custom instance", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "low" }),
      {
        instanceId: CODEX_SECONDARY_INSTANCE,
        model: "gpt-5-codex",
        persistSticky: true,
      },
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(
      expect.objectContaining({
        instanceId: CODEX_SECONDARY_INSTANCE,
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    );
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.activeProvider).toBe(CODEX_SECONDARY_INSTANCE);
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe(CODEX_SECONDARY_INSTANCE);
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toBe(
      undefined,
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(
      expect.objectContaining({
        instanceId: CODEX_SECONDARY_INSTANCE,
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    );
  });

  it("updates only the draft when sticky persistence is disabled", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
      {
        persistSticky: false,
      },
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }));
  });
});

describe("composerDraftStore setModelSelection", () => {
  const threadId = ThreadId.make("thread-model");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("keeps explicit model overrides instead of coercing to null", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.3-codex"));

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, "gpt-5.3-codex"));
  });
});

describe("composerDraftStore sticky composer settings", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a sticky model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("normalizes empty sticky model options by dropping selection options", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(modelSelection(CODEX_DRIVER, "gpt-5.4"));

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4"),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("drops empty cursor model options when normalizing sticky state", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: undefined,
        fastMode: undefined,
        thinking: undefined,
        contextWindow: undefined,
      }),
    );

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(modelSelection(CURSOR_DRIVER, "gpt-5.4"));
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("cursor");
  });

  it("applies sticky activeProvider to new drafts", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.make("thread-sticky-active-provider");
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

    store.setStickyModelSelection(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"));
    store.applyStickyState(threadRef);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toMatchObject({
      modelSelectionByProvider: {
        claudeAgent: modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"),
      },
      activeProvider: "claudeAgent",
    });
  });
});

describe("composerDraftStore provider-scoped option updates", () => {
  const threadId = ThreadId.make("thread-provider");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("retains off-provider option memory without changing the active selection", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadRef,
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "medium",
      }),
    );
    store.setProviderModelOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ effort: "max" }));
    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", { reasoningEffort: "medium" }),
    );
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]?.options).toEqual(
      createModelSelection(
        CLAUDE_AGENT_INSTANCE,
        "claude-opus-4-6",
        toSelections({ effort: "max" }),
      ).options,
    );
    expect(draft?.activeProvider).toBe("codex");
  });
});

describe("composerDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.make("thread-settings");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores runtime mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadRef, "approval-required");

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.runtimeMode).toBe("approval-required");
  });

  it("stores interaction mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setInteractionMode(threadRef, "plan");

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.interactionMode).toBe("plan");
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadRef, "approval-required");
    store.setInteractionMode(threadRef, "plan");
    store.setRuntimeMode(threadRef, null);
    store.setInteractionMode(threadRef, null);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("clears model selection overrides while preserving prompt text", () => {
    const store = useComposerDraftStore.getState();

    store.setPrompt(threadRef, "keep prompt");
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.activeProvider).toBe("codex");

    store.clearModelSelection(threadRef);

    const remaining = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(remaining?.prompt).toBe("keep prompt");
    expect(remaining?.activeProvider).toBeNull();
    expect(remaining?.modelSelectionByProvider).toEqual({});

    store.setPrompt(threadRef, "");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createDebouncedStorage
// ---------------------------------------------------------------------------

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}

describe("createDebouncedStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates getItem immediately", () => {
    const base = createMockStorage();
    base.getItem.mockReturnValueOnce("value");
    const storage = createDebouncedStorage(base);

    expect(storage.getItem("key")).toBe("value");
    expect(base.getItem).toHaveBeenCalledWith("key");
  });

  it("does not write to base storage until the debounce fires", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");
  });

  it("only writes the last value when setItem is called rapidly", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.setItem("key", "v2");
    storage.setItem("key", "v3");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v3");
  });

  it("removeItem cancels a pending setItem write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");

    vi.advanceTimersByTime(300);
    expect(base.setItem).not.toHaveBeenCalled();
    expect(base.removeItem).toHaveBeenCalledWith("key");
  });

  it("flush writes the pending value immediately", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    storage.flush();
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");

    // Timer should be cancelled; no duplicate write.
    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when nothing is pending", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.flush();
    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("flush after removeItem is a no-op", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.flush();

    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("setItem works normally after removeItem cancels a pending write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.setItem("key", "v2");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v2");
  });
});
