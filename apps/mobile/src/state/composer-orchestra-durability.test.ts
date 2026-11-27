import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceMeetingParticipantId,
} from "@t3tools/contracts";
import { appAtomRegistry } from "./atom-registry";
import {
  composerDraftsAtom,
  decodePersistedComposerDrafts,
  finishComposerOrchestraStartAttempt,
  mergeLoadedComposerDrafts,
  orchestraAttemptMatchesContent,
  persistComposerOrchestraAttempt,
  persistComposerOrchestraStartAttempt,
  setComposerOrchestraConfig,
  sameComposerOrchestraAttempt,
  type ComposerOrchestraAttempt,
  type ComposerOrchestraStartAttempt,
} from "./use-composer-drafts";
import {
  createMobileOrchestraStart,
  DEFAULT_MOBILE_ORCHESTRA_CONFIG,
} from "./thread-orchestra-config";

const disk = vi.hoisted(() => ({
  contents: null as string | null,
  files: new Map<string, string>(),
  failWrite: false,
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
      if (disk.failWrite) throw new Error("synthetic storage failure");
      disk.files.set(this.name, value);
      disk.contents = value;
    }
  },
}));

const image = {
  id: "image-1",
  type: "image" as const,
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 1,
  dataUrl: "data:image/png;base64,YQ==",
  previewUri: "data:image/png;base64,YQ==",
};
const threadKey = "env:thread";
const attempt: ComposerOrchestraAttempt = {
  threadKey,
  projectId: ProjectId.make("project"),
  runId: WorkspaceCollaborationRunId.make("run"),
  commandId: CommandId.make("original-command"),
  createdAt: "2026-11-02T00:00:00Z",
  originalText: "둘째",
  originalAttachments: [image],
  prepared: {
    kind: "answer",
    text: "둘째",
    question: "어느 쪽인가요?",
    questionRef: { nodeId: null, askedAt: "2026-11-02T00:00:00Z" },
  },
};

afterEach(() => {
  appAtomRegistry.set(composerDraftsAtom, {});
  disk.failWrite = false;
});

describe("durable conversation orchestra attempts", () => {
  it("stores the original request, restores it after decoding, and preserves subsequent edits", async () => {
    const original = { text: attempt.originalText, attachments: [image] };
    appAtomRegistry.set(composerDraftsAtom, { [threadKey]: original });
    expect(await persistComposerOrchestraAttempt(threadKey, attempt)).toBe(true);
    const restored = decodePersistedComposerDrafts(JSON.parse(disk.contents!));
    expect(restored[threadKey]?.orchestraAttempt).toEqual(attempt);
    expect(orchestraAttemptMatchesContent(restored[threadKey]!, attempt)).toBe(true);
    expect(
      orchestraAttemptMatchesContent(
        { ...original, attachments: [{ ...image, dataUrl: "data:image/png;base64,Yg==" }] },
        attempt,
      ),
    ).toBe(false);
    const edited = { text: "새로 입력한 내용", attachments: [] };
    expect(mergeLoadedComposerDrafts(restored, { [threadKey]: edited })[threadKey]).toEqual({
      ...edited,
      orchestraAttempt: attempt,
    });
  });

  it("reports a failed durable write before a request can be submitted", async () => {
    disk.failWrite = true;
    appAtomRegistry.set(composerDraftsAtom, {
      [threadKey]: { text: attempt.originalText, attachments: [image] },
    });
    await expect(persistComposerOrchestraAttempt(threadKey, attempt)).rejects.toThrow();
    expect(appAtomRegistry.get(composerDraftsAtom)[threadKey]?.orchestraAttempt).toEqual(attempt);
  });

  it("rejects reuse of a request ID when the original question or image has changed", async () => {
    const changedQuestion: ComposerOrchestraAttempt = {
      ...attempt,
      prepared: {
        kind: "answer",
        text: "둘째",
        question: "다른 질문인가요?",
        questionRef: { nodeId: null, askedAt: "2026-11-02T00:00:00Z" },
      },
    };
    const changedImage = {
      ...attempt,
      originalAttachments: [{ ...image, dataUrl: "data:image/png;base64,Yg==" }],
    };
    expect(sameComposerOrchestraAttempt(attempt, changedQuestion)).toBe(false);
    expect(sameComposerOrchestraAttempt(attempt, changedImage)).toBe(false);
    appAtomRegistry.set(composerDraftsAtom, {
      [threadKey]: { text: attempt.originalText, attachments: [image], orchestraAttempt: attempt },
    });
    expect(await persistComposerOrchestraAttempt(threadKey, changedQuestion)).toBe(false);
    expect(await persistComposerOrchestraAttempt(threadKey, changedImage)).toBe(false);
  });

  it("persists the exact start before sending and keeps later text and settings after acknowledgement", async () => {
    const supervisor = {
      id: WorkspaceMeetingParticipantId.make("chair"),
      displayName: "감독",
      roleDescription: "검증",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "model-b",
        options: [{ id: "effort", value: "high" }],
      },
    };
    const config = {
      ...DEFAULT_MOBILE_ORCHESTRA_CONFIG,
      enabled: true,
      participants: [supervisor],
      chairParticipantId: supervisor.id,
    };
    const request = createMobileOrchestraStart({
      config,
      projectId: ProjectId.make("project"),
      threadId: ThreadId.make("thread"),
      currentModel: { instanceId: ProviderInstanceId.make("codex"), model: "model-a" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      task: "목표",
      requestId: "original-start",
      availableModels: [supervisor.modelSelection],
    });
    expect(request.start).not.toBeNull();
    const start: ComposerOrchestraStartAttempt = {
      threadKey,
      originalText: "목표",
      config,
      input: request.start!,
    };
    appAtomRegistry.set(composerDraftsAtom, {
      [threadKey]: { text: "목표", attachments: [], orchestraConfig: config },
    });
    expect(await persistComposerOrchestraStartAttempt(threadKey, start)).toBe(true);
    const restored = decodePersistedComposerDrafts(JSON.parse(disk.contents!));
    expect(restored[threadKey]?.orchestraStartAttempt).toEqual(start);
    setComposerOrchestraConfig("env:other-thread", { ...config, activationId: "other" });
    expect(
      await persistComposerOrchestraStartAttempt(threadKey, {
        ...start,
        input: { ...start.input, task: "다른 목표" },
      }),
    ).toBe(false);
    finishComposerOrchestraStartAttempt(threadKey, "original-start");
    expect(appAtomRegistry.get(composerDraftsAtom)[threadKey]).toMatchObject({
      text: "",
      orchestraConfig: { ...config, enabled: false },
    });
    expect(
      appAtomRegistry.get(composerDraftsAtom)[threadKey]?.orchestraStartAttempt,
    ).toBeUndefined();
    expect(appAtomRegistry.get(composerDraftsAtom)["env:other-thread"]?.orchestraConfig).toEqual({
      ...config,
      activationId: "other",
    });
    const editedConfig = { ...config, executionMode: "persistent" as const };
    const edited = { ...restored[threadKey]!, text: "새 초안", orchestraConfig: editedConfig };
    expect(
      mergeLoadedComposerDrafts(restored, { [threadKey]: { text: "새 초안", attachments: [] } })[
        threadKey
      ],
    ).toMatchObject({
      text: "새 초안",
      orchestraStartAttempt: start,
      orchestraConfig: config,
    });
    appAtomRegistry.set(composerDraftsAtom, { [threadKey]: edited });
    finishComposerOrchestraStartAttempt(threadKey, "original-start");
    expect(appAtomRegistry.get(composerDraftsAtom)[threadKey]).toMatchObject({
      text: "새 초안",
      orchestraConfig: { ...editedConfig, enabled: false },
    });
    expect(
      appAtomRegistry.get(composerDraftsAtom)[threadKey]?.orchestraStartAttempt,
    ).toBeUndefined();
    appAtomRegistry.set(composerDraftsAtom, {
      [threadKey]: { ...edited, orchestraConfig: { ...editedConfig, activationId: "new-choice" } },
    });
    finishComposerOrchestraStartAttempt(threadKey, "original-start");
    expect(appAtomRegistry.get(composerDraftsAtom)[threadKey]?.orchestraConfig).toMatchObject({
      enabled: true,
      activationId: "new-choice",
    });
  });
});
