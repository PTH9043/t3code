// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  ClientOrchestrationCommand,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { clientTurnRequestDigest } from "../../../server/src/orchestration/turnRequestDigest.ts";
import { turnRequestFingerprint } from "./turnRequestFingerprint";
import { encodeQueuedThreadMessage, decodeQueuedThreadMessage } from "../state/thread-outbox-model";
import {
  buildQueuedProjectThreadStartTurnInput,
  buildProjectThreadStartTurnInput,
} from "./projectThreadStartTurn";

import { useCreateProjectThread } from "../features/threads/use-project-actions";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { startTurn: "startTurn" } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => dispatch }));
vi.mock("../state/use-remote-environment-registry", () => ({ setPendingConnectionError: vi.fn() }));

const encodeCommand = Schema.encodeSync(ClientOrchestrationCommand);
const decodeCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: (_algorithm: string, value: string) =>
    Promise.resolve(NodeCrypto.createHash("sha256").update(value).digest("hex")),
}));

describe("turn receipt fingerprint", () => {
  it("keeps the supported request fields stable across representative collation locales", async () => {
    const command = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("locale-command"),
      threadId: ThreadId.make("locale-thread"),
      message: {
        messageId: MessageId.make("locale-message"),
        role: "user" as const,
        text: "한글 👋",
        attachments: [],
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "test",
        options: [{ id: "Ä옵션", value: "turkish ı" }],
      },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      inputOrigin: "user" as const,
      titleSeed: "대화",
      taskConditions: {
        version: 1 as const,
        approvedByUser: true as const,
        sourceText: "요청",
        goal: "목표",
        scope: "범위",
        criteria: "기준",
        approach: "방법",
        restrictions: "제한",
        completion: "완료",
        output: "결과",
        mode: "work" as const,
        additionalActions: [],
      },
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project"),
          title: "대화",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: "main",
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/project",
          baseBranch: "main",
          branch: "temp",
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const baseline = await turnRequestFingerprint(command);
    const spy = vi.spyOn(String.prototype, "localeCompare");
    try {
      for (const locale of ["en", "ko", "tr", "sv", "de", "ja"]) {
        const compare = new Intl.Collator(locale).compare;
        spy.mockImplementation(function (this: string, other: string) {
          return compare(String(this), other);
        });
        expect(await turnRequestFingerprint(command)).toBe(baseline);
      }
    } finally {
      spy.mockRestore();
    }
  });
  it("reconstructs the exact local retry identity even if a new temporary branch name is generated", async () => {
    const spec = {
      projectId: ProjectId.make("project"),
      projectCwd: "/project",
      threadId: "thread",
      commandId: "command",
      messageId: "message",
      createdAt: "2026-01-01T00:00:00.000Z",
      text: "다시 시작",
      attachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      workspaceMode: "local" as const,
      branch: "main",
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "t3/one",
    };
    const first = { ...buildProjectThreadStartTurnInput(spec), type: "thread.turn.start" as const };
    const retry = {
      ...buildProjectThreadStartTurnInput({ ...spec, worktreeBranchName: "t3/two" }),
      type: "thread.turn.start" as const,
    };
    const edited = {
      ...buildProjectThreadStartTurnInput({ ...spec, text: "수정된 요청" }),
      type: "thread.turn.start" as const,
    };
    expect(await turnRequestFingerprint(retry)).toBe(await turnRequestFingerprint(first));
    expect(await turnRequestFingerprint(edited)).not.toBe(await turnRequestFingerprint(first));
  });
  it("replays the same seeded first turn after a pending task disk round-trip", async () => {
    const parent = { instanceId: ProviderInstanceId.make("answer"), model: "same" };
    const worker = ProviderInstanceId.make("worker");
    const responseStyle = {
      preset: "friendly" as const,
      tone: "",
      length: "",
      explanation: "",
      instructions: "Remember this draft instruction",
    };
    const teams = [
      { answeringInstanceId: parent.instanceId, forModel: "same", members: [] },
      {
        answeringInstanceId: worker,
        forModel: "same",
        members: [
          { instanceId: worker, model: "w", role: "scout" as const, instructions: "inspect" },
        ],
      },
    ];
    const message = {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("abc12345-room"),
      commandId: CommandId.make("command"),
      messageId: MessageId.make("message"),
      createdAt: "2026-09-01T00:00:00Z",
      modelSelection: parent,
      text: "hello",
      attachments: [],
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
      creation: {
        projectId: ProjectId.make("project"),
        workspaceMode: "worktree" as const,
        branch: "main",
        worktreePath: null,
        startFromOrigin: false,
        modelTeams: teams,
        responseStyle,
      },
    };
    const direct = buildProjectThreadStartTurnInput({
      ...message,
      ...message.creation,
      projectCwd: "/project",
    });
    const restored = decodeQueuedThreadMessage(
      JSON.parse(JSON.stringify(encodeQueuedThreadMessage(message))),
    );
    const replay = buildQueuedProjectThreadStartTurnInput(restored, "/project")!;
    expect(replay).toEqual(direct);
    dispatch.mockResolvedValue({ _tag: "Success", value: undefined });
    const send = useCreateProjectThread();
    await send({
      project: {
        id: message.creation.projectId,
        environmentId: message.environmentId,
        workspaceRoot: "/project",
        title: "Project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
      },
      envMode: message.creation.workspaceMode,
      branch: "main",
      worktreePath: null,
      startFromOrigin: false,
      modelSelection: parent,
      modelTeams: teams,
      responseStyle,
      runtimeMode: message.runtimeMode,
      interactionMode: message.interactionMode,
      initialMessageText: message.text,
      initialAttachments: [],
      turnMetadata: message,
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      environmentId: message.environmentId,
      input: replay,
    });
    expect(replay.bootstrap.createThread.modelTeams).toEqual(
      teams.map((team) => ({ ...team, threadId: message.threadId })),
    );
    expect(replay.bootstrap.prepareWorktree?.branch).toContain("abc12345");
    const command = decodeCommand({ ...replay, type: "thread.turn.start" });
    if (command.type !== "thread.turn.start") throw new Error("Expected first turn");
    expect(command.bootstrap?.createThread).toMatchObject({ responseStyle });
    expect(await turnRequestFingerprint({ ...replay, type: "thread.turn.start" })).toBe(
      clientTurnRequestDigest(command),
    );
    expect(command.bootstrap?.createThread?.modelTeams).toEqual(
      direct.bootstrap.createThread.modelTeams,
    );
    expect(await turnRequestFingerprint(command)).toBe(clientTurnRequestDigest(command));
    const { modelTeams: _teams, ...legacyCreation } = message.creation;
    const inherited = buildQueuedProjectThreadStartTurnInput(
      { ...restored, creation: legacyCreation },
      "/project",
    )!;
    expect(inherited.bootstrap.createThread).not.toHaveProperty("modelTeams");
    expect(await turnRequestFingerprint({ ...inherited, type: "thread.turn.start" })).not.toBe(
      await turnRequestFingerprint(command),
    );
  });

  it("matches the server for Unicode, attachment bytes and bootstrap settings", async () => {
    const command = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("turn-command"),
      threadId: ThreadId.make("turn-thread"),
      message: {
        messageId: MessageId.make("turn-message"),
        role: "user" as const,
        text: "한글 👋",
        attachments: [
          {
            type: "image" as const,
            name: "그림.png",
            mimeType: "image/png",
            sizeBytes: 1,
            dataUrl: "data:image/png;base64,YQ==",
          },
        ],
      },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project"),
          title: "대화",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: "main",
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    expect(await turnRequestFingerprint(command)).toBe(clientTurnRequestDigest(command));
    const wire = encodeCommand(command);
    const decoded = decodeCommand(wire);
    if (decoded.type !== "thread.turn.start") throw new Error("expected turn");
    expect(await turnRequestFingerprint(command)).toBe(clientTurnRequestDigest(decoded));
    const changed = { ...command, message: { ...command.message, text: "다른 요청" } };
    expect(await turnRequestFingerprint(changed)).toBe(clientTurnRequestDigest(changed));
    expect(await turnRequestFingerprint(changed)).not.toBe(await turnRequestFingerprint(command));
  });
});
