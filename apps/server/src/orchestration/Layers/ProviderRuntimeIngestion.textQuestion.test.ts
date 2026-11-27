// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationReadModel,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import { upgradeRoomIds } from "../../upgradeRoom.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ANTIGRAVITY_QUESTION_INTRO } from "../textQuestions.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";

type TestThread = OrchestrationReadModel["threads"][number];
type Engine = OrchestrationEngineService["Service"];

const defaultThreadId = ThreadId.make("thread-1");
const createdAt = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T00:00:05.000Z";

const batch = {
  questions: [
    {
      header: "PowerShell",
      question: "PowerShell 영구 지침을 어떻게 처리할까요?",
      options: [
        { label: "조건부 예외 (권장)", description: "Antigravity만 허용" },
        { label: "전면 유지", description: "금지 유지" },
      ],
    },
  ],
};
const blockAnswer =
  "지침을 확인했습니다.\n\n" +
  ANTIGRAVITY_QUESTION_INTRO +
  "\n\n```json\n" +
  JSON.stringify(batch) +
  "\n```";
const listAnswer = [
  "PowerShell 영구 지침을 어떻게 처리할까요?",
  "",
  "- [1] (권장) 조건부 예외로 조정: Antigravity만 허용",
  "- [2] 전면 유지: PowerShell 절대 금지 유지",
].join("\n");
const cardQuestions = [
  {
    id: "question-1",
    header: "PowerShell",
    question: "PowerShell 영구 지침을 어떻게 처리할까요?",
    options: batch.questions[0]!.options,
  },
];

const requestIdOf = (activity: TestThread["activities"][number]) =>
  (activity.payload as { requestId?: unknown } | null)?.requestId;
const textCards = (thread: TestThread) =>
  thread.activities.filter(
    (activity) =>
      activity.kind === "user-input.requested" &&
      String(requestIdOf(activity)).startsWith("text-question:"),
  );

describe("ProviderRuntimeIngestion text questions", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  let threadId = defaultThreadId;
  const tempDirs: string[] = [];

  async function disposeHarness() {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;
    if (runtime) await runtime.dispose();
    runtime = null;
  }

  afterEach(async () => {
    await disposeHarness();
    for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  /** `seed` runs before the ingestion starts, which is when unanswered questions are restored. */
  async function createHarness(input: {
    readonly provider: string;
    readonly model: string;
    readonly threadId?: ThreadId;
    readonly seed?: (engine: Engine) => Promise<void>;
  }) {
    threadId = input.threadId ?? defaultThreadId;
    const makeTempDir = (prefix: string) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    };
    const workspaceRoot = makeTempDir("t3-text-question-project-");
    NodeFS.mkdirSync(NodePath.join(workspaceRoot, ".git"));
    // Replay buffer: an emit racing ahead of the forked subscription must not be lost.
    const events = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>({ replay: 256 }));
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(String(instanceId));
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(events);
      },
    };
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(
        Layer.succeed(
          RepositoryIdentityResolver.RepositoryIdentityResolver,
          RepositoryIdentityResolver.RepositoryIdentityResolver.of({
            resolve: () => Effect.succeed(null),
          }),
        ),
      ),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(ServerSettingsService.layerTest({})),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), makeTempDir("t3-text-question-state-")),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    const modelSelection = {
      instanceId: ProviderInstanceId.make(input.provider),
      model: input.model,
    };
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: ProjectId.make("project-1"),
        title: "Provider Project",
        workspaceRoot,
        defaultModelSelection: modelSelection,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(setSession(engine, input.provider, "ready", null, "cmd-session-seed"));
    await input.seed?.(engine);
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(ingestion.start().pipe(Scope.provide(scope)));

    const provider = ProviderDriverKind.make(input.provider);
    const emit = (event: Record<string, unknown>) =>
      Effect.runSync(
        PubSub.publish(events, { provider, threadId, createdAt, ...event } as ProviderRuntimeEvent),
      );
    const readThread = async () =>
      (await runtime!.runPromise(snapshotQuery.getSnapshot())).threads.find(
        (entry) => entry.id === threadId,
      );
    const waitForThread = async (predicate: (thread: TestThread) => boolean) => {
      const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + 5000;
      while (true) {
        const thread = await readThread();
        if (thread && predicate(thread)) return thread;
        if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline)
          throw new Error(
            "Timed out waiting for thread state: " +
              JSON.stringify(thread?.activities.map((activity) => activity.kind)),
          );
        await Effect.runPromise(Effect.yieldNow);
      }
    };
    /** Emit one finished turn whose final answer is `text`. */
    const answer = (
      turn: string,
      text: string,
      options?: { readonly state?: string; readonly beforeCompletion?: () => void },
    ) => {
      emit({ type: "turn.started", eventId: EventId.make(`evt-${turn}-started`), turnId: turn });
      emit({
        type: "content.delta",
        eventId: EventId.make(`evt-${turn}-delta`),
        turnId: turn,
        itemId: ProviderItemId.make(`item-${turn}`),
        payload: { streamKind: "assistant_text", delta: text },
      });
      emit({
        type: "item.completed",
        eventId: EventId.make(`evt-${turn}-item`),
        turnId: turn,
        itemId: ProviderItemId.make(`item-${turn}`),
        payload: { itemType: "assistant_message", status: "completed" },
      });
      options?.beforeCompletion?.();
      emit({
        type: "turn.completed",
        eventId: EventId.make(`evt-${turn}-completed`),
        turnId: turn,
        payload: { state: options?.state ?? "completed" },
      });
    };
    /** Events are handled in order, so a later turn being active proves the earlier ones were handled. */
    const settled = () => {
      emit({
        type: "turn.started",
        eventId: EventId.make("evt-after-started"),
        turnId: "turn-after",
      });
      return waitForThread((thread) => thread.session?.activeTurnId === "turn-after");
    };
    return { engine, emit, answer, settled, readThread, waitForThread, modelSelection };
  }

  function setSession(
    engine: Engine,
    provider: string,
    status: "ready" | "running",
    activeTurnId: string | null,
    commandId: string,
    updatedAt = createdAt,
  ) {
    return engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(commandId),
      threadId,
      session: {
        threadId,
        status,
        providerName: provider,
        runtimeMode: "approval-required",
        activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
        updatedAt,
        lastError: null,
      },
      createdAt: updatedAt,
    });
  }

  function requestTurn(
    engine: Engine,
    modelSelection: { instanceId: ProviderInstanceId; model: string },
    id: string,
  ) {
    return Effect.runPromise(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-turn-${id}`),
        threadId,
        message: {
          messageId: MessageId.make(`msg-${id}`),
          role: "user",
          text: "요청",
          attachments: [],
        },
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
  }

  /** A finished turn recorded without the ingestion, as left behind by an earlier server run. */
  const seedFinishedTurn =
    (provider: string, model: string, text: string) => async (engine: Engine) => {
      await requestTurn(
        engine,
        { instanceId: ProviderInstanceId.make(provider), model },
        "restore",
      );
      await Effect.runPromise(
        setSession(engine, provider, "running", "turn-restore", "cmd-restore-running"),
      );
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-restore-delta"),
          threadId,
          messageId: MessageId.make("assistant-restore"),
          turnId: TurnId.make("turn-restore"),
          delta: text,
          createdAt: later,
        }),
      );
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make("cmd-restore-complete"),
          threadId,
          messageId: MessageId.make("assistant-restore"),
          turnId: TurnId.make("turn-restore"),
          createdAt: later,
        }),
      );
      await Effect.runPromise(
        setSession(engine, provider, "ready", null, "cmd-restore-ready", later),
      );
    };

  it("opens a card for an Antigravity answer that ends with the question block", async () => {
    const harness = await createHarness({ provider: "gemini", model: "auto" });
    harness.answer("turn-1", blockAnswer);
    const thread = await harness.waitForThread((entry) => textCards(entry).length === 1);
    const card = textCards(thread)[0]!;
    expect(card.summary).toBe("Antigravity 질문");
    expect(card.turnId).toBe("turn-1");
    expect(card.payload).toEqual({ requestId: "text-question:turn-1", questions: cardQuestions });
    expect(thread.messages.at(-1)?.text).toBe(blockAnswer);
  });

  it("opens a card for an Antigravity answer that ends with a numbered option list", async () => {
    const harness = await createHarness({ provider: "gemini", model: "auto" });
    harness.answer("turn-1", listAnswer);
    const thread = await harness.waitForThread((entry) => textCards(entry).length === 1);
    expect(textCards(thread)[0]?.payload).toEqual({
      requestId: "text-question:turn-1",
      questions: [
        {
          id: "question-1",
          header: "선택",
          question: "PowerShell 영구 지침을 어떻게 처리할까요?",
          options: [
            { label: "(권장) 조건부 예외로 조정", description: "Antigravity만 허용" },
            { label: "전면 유지", description: "PowerShell 절대 금지 유지" },
          ],
        },
      ],
    });
  });

  it("opens one card when the same completion is delivered twice", async () => {
    const harness = await createHarness({ provider: "gemini", model: "auto" });
    harness.answer("turn-1", blockAnswer);
    await harness.waitForThread((entry) => textCards(entry).length === 1);
    harness.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-1-completed-again"),
      turnId: "turn-1",
      payload: { state: "completed" },
    });
    expect(textCards(await harness.settled())).toHaveLength(1);
  });

  it("opens no card when the turn already asked through a native question", async () => {
    const harness = await createHarness({ provider: "gemini", model: "auto" });
    harness.answer("turn-1", blockAnswer, {
      beforeCompletion: () =>
        harness.emit({
          type: "user-input.requested",
          eventId: EventId.make("evt-native-question"),
          turnId: "turn-1",
          requestId: ApprovalRequestId.make("native-1"),
          payload: { questions: [{ ...cardQuestions[0]!, question: "다른 질문인가요?" }] },
        }),
    });
    const thread = await harness.settled();
    expect(textCards(thread)).toHaveLength(0);
    expect(
      thread.activities
        .filter((activity) => activity.kind === "user-input.requested")
        .map(requestIdOf),
    ).toEqual(["native-1"]);
  });

  it("opens no card for an Antigravity turn that ended as failed", async () => {
    const harness = await createHarness({ provider: "gemini", model: "auto" });
    harness.answer("turn-1", blockAnswer, { state: "failed" });
    expect(textCards(await harness.settled())).toHaveLength(0);
  });

  it.each(["interrupted", "cancelled"])(
    "opens a card for an %s Antigravity turn when its finalized latest message has a complete JSON question block",
    async (state) => {
      const harness = await createHarness({ provider: "gemini", model: "auto" });
      harness.answer("turn-1", blockAnswer, { state });
      const thread = await harness.waitForThread((entry) => textCards(entry).length === 1);
      expect(textCards(thread)[0]).toMatchObject({
        summary: "Antigravity 질문",
        turnId: "turn-1",
        payload: { requestId: "text-question:turn-1", questions: cardQuestions },
      });
    },
  );

  it.each(["interrupted", "cancelled"])(
    "opens no card for an %s Antigravity turn with only a prose list or truncated JSON",
    async (state) => {
      const harness = await createHarness({ provider: "gemini", model: "auto" });
      harness.answer("turn-1", listAnswer, { state });
      harness.answer("turn-2", blockAnswer.slice(0, -12), { state });
      expect(textCards(await harness.settled())).toHaveLength(0);
    },
  );

  it("opens no card for an interrupted Antigravity turn when a newer user message followed the assistant message", async () => {
    const harness = await createHarness({ provider: "gemini", model: "auto" });
    await requestTurn(harness.engine, harness.modelSelection, "initial");
    harness.emit({
      type: "turn.started",
      eventId: EventId.make("evt-t1-started"),
      turnId: "turn-1",
    });
    harness.emit({
      type: "content.delta",
      eventId: EventId.make("evt-t1-delta"),
      turnId: "turn-1",
      itemId: ProviderItemId.make("item-t1"),
      payload: { streamKind: "assistant_text", delta: blockAnswer },
    });
    harness.emit({
      type: "item.completed",
      eventId: EventId.make("evt-t1-item"),
      turnId: "turn-1",
      itemId: ProviderItemId.make("item-t1"),
      payload: { itemType: "assistant_message", status: "completed" },
    });
    await harness.waitForThread((entry) =>
      entry.messages.some((message) => message.role === "assistant" && message.turnId === "turn-1"),
    );
    await requestTurn(harness.engine, harness.modelSelection, "newer-user");
    await harness.waitForThread((entry) =>
      entry.messages.some((message) => message.id === "msg-newer-user"),
    );
    harness.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-t1-completed"),
      turnId: "turn-1",
      payload: { state: "interrupted" },
    });
    expect(textCards(await harness.settled())).toHaveLength(0);
  });

  it.each([
    ["codex", "gpt-5-codex"],
    ["claudeAgent", "claude-sonnet-4-6"],
    ["cursor", "auto"],
    ["grok", "grok-code"],
  ])("opens no card for a %s answer with the same text", async (provider, model) => {
    const harness = await createHarness({ provider, model });
    await requestTurn(harness.engine, harness.modelSelection, "one");
    harness.answer("turn-1", blockAnswer);
    harness.answer("turn-2", listAnswer);
    expect(textCards(await harness.settled())).toHaveLength(0);
  });

  it("keeps the EXAONE gate: the block opens a card, a numbered list and other OpenCode models do not", async () => {
    const exaone = await createHarness({ provider: "opencode", model: "t3_exaone/k-exaone_v2.5" });
    await requestTurn(exaone.engine, exaone.modelSelection, "one");
    exaone.answer("turn-1", listAnswer);
    await exaone.waitForThread(
      (entry) => entry.session?.status === "ready" && entry.messages.length === 2,
    );
    await requestTurn(exaone.engine, exaone.modelSelection, "two");
    exaone.answer("turn-2", blockAnswer);
    const thread = await exaone.waitForThread((entry) => textCards(entry).length === 1);
    expect(textCards(thread)[0]).toMatchObject({
      summary: "EXAONE 질문",
      turnId: "turn-2",
      payload: { requestId: "text-question:turn-2", questions: cardQuestions },
    });
    await disposeHarness();

    const other = await createHarness({ provider: "opencode", model: "t3_antseed/kimi-k3.1-pro" });
    await requestTurn(other.engine, other.modelSelection, "one");
    other.answer("turn-1", blockAnswer);
    expect(textCards(await other.settled())).toHaveLength(0);
  });

  it("replaces an unanswered Antigravity card when the same question arrives natively", async () => {
    const harness = await createHarness({ provider: "gemini", model: "auto" });
    harness.answer("turn-1", blockAnswer);
    await harness.waitForThread((entry) => textCards(entry).length === 1);
    harness.emit({
      type: "user-input.requested",
      eventId: EventId.make("evt-native-question"),
      turnId: "turn-1",
      requestId: ApprovalRequestId.make("native-1"),
      payload: {
        questions: cardQuestions.map((question) => ({ ...question, id: "native-question" })),
      },
    });
    const thread = await harness.waitForThread((entry) =>
      entry.activities.some(
        (activity) =>
          activity.kind === "user-input.requested" && requestIdOf(activity) === "native-1",
      ),
    );
    expect(
      thread.activities
        .filter((activity) => activity.kind === "user-input.resolved")
        .map((activity) => activity.payload),
    ).toEqual([{ requestId: "text-question:turn-1", answers: {}, reason: "superseded" }]);
  });

  it("holds back a turnless native copy of an open Antigravity card", async () => {
    const harness = await createHarness({ provider: "gemini", model: "auto" });
    harness.answer("turn-1", blockAnswer);
    await harness.waitForThread((entry) => textCards(entry).length === 1);
    harness.emit({
      type: "user-input.requested",
      eventId: EventId.make("evt-native-question"),
      requestId: ApprovalRequestId.make("native-1"),
      payload: {
        questions: cardQuestions.map((question) => ({ ...question, id: "native-question" })),
      },
    });
    const thread = await harness.waitForThread((entry) =>
      entry.activities.some(
        (activity) => activity.kind === "provider.user-input.duplicate.deferred",
      ),
    );
    expect(
      thread.activities
        .filter((activity) => activity.kind === "user-input.requested")
        .map(requestIdOf),
    ).toEqual(["text-question:turn-1"]);
    expect(
      thread.activities.find(
        (activity) => activity.kind === "provider.user-input.duplicate.deferred",
      )?.payload,
    ).toMatchObject({ requestId: "text-question:turn-1", nativeRequestId: "native-1" });
  });

  it.each([
    ["the question block", blockAnswer, cardQuestions[0]!.header],
    ["a numbered option list", listAnswer, "선택"],
  ])(
    "restores an unanswered Antigravity question with %s at startup",
    async (_label, text, header) => {
      const harness = await createHarness({
        provider: "gemini",
        model: "auto",
        seed: seedFinishedTurn("gemini", "auto", text),
      });
      const cards = textCards((await harness.readThread())!);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        summary: "Antigravity 질문",
        turnId: "turn-restore",
        payload: { requestId: "text-question:turn-restore", questions: [{ header }] },
      });
    },
  );

  it("restores an unanswered Antigravity question in the primary server's upgrade room at startup", async () => {
    const harness = await createHarness({
      provider: "gemini",
      model: "auto",
      threadId: upgradeRoomIds.threadId,
      seed: seedFinishedTurn("gemini", "auto", blockAnswer),
    });
    const thread = (await harness.readThread())!;
    expect(thread.messages.at(-1)?.text).toBe(blockAnswer);
    expect(textCards(thread)).toMatchObject([
      { summary: "Antigravity 질문", payload: { requestId: "text-question:turn-restore" } },
    ]);
  });

  it("restores an unanswered EXAONE block at startup, and nothing for its numbered list", async () => {
    const model = "t3_exaone/k-exaone_v2.5";
    const restored = await createHarness({
      provider: "opencode",
      model,
      seed: seedFinishedTurn("opencode", model, blockAnswer),
    });
    expect(textCards((await restored.readThread())!)).toMatchObject([
      { summary: "EXAONE 질문", payload: { requestId: "text-question:turn-restore" } },
    ]);
    await disposeHarness();

    const list = await createHarness({
      provider: "opencode",
      model,
      seed: seedFinishedTurn("opencode", model, listAnswer),
    });
    expect(textCards((await list.readThread())!)).toHaveLength(0);
  });

  it.each([
    ["codex", "gpt-5-codex"],
    ["claudeAgent", "claude-sonnet-4-6"],
    ["opencode", "t3_antseed/kimi-k3.1-pro"],
  ])("restores nothing at startup for a %s answer with the same text", async (provider, model) => {
    const harness = await createHarness({
      provider,
      model,
      seed: seedFinishedTurn(provider, model, blockAnswer),
    });
    expect(textCards((await harness.readThread())!)).toHaveLength(0);
  });

  it("resolves a recovered Antigravity text-question card immediately on turn.started", async () => {
    const harness = await createHarness({ provider: "gemini", model: "gemini-4-neon" });
    harness.answer("turn-1", blockAnswer);
    await harness.waitForThread((entry) => textCards(entry).length === 1);

    const requestId = "text-question:turn-1";
    const messageId = MessageId.make("recovered-question-test-key");
    const attemptId = "attempt-evt-1";
    const answers = { "question-1": "계속" };

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-recovery-queued"),
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-11-18T00:00:01.000Z",
        activity: {
          id: EventId.make("evt-recovery-queued"),
          kind: "provider.user-input.recovery.queued",
          tone: "info",
          summary: "복구한 질문 답변 준비",
          payload: { requestId, messageId, answers },
          turnId: null,
          createdAt: "2026-11-18T00:00:01.000Z",
        },
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-recovery-turn-start"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId,
          role: "user",
          text: "User answers to the questions you asked:\n어떻게 진행할까요?\n계속",
          attachments: [],
        },
        modelSelection: harness.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: "2026-11-18T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-recovery-delivery-start"),
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-11-18T00:00:02.000Z",
        activity: {
          id: EventId.make("evt-recovery-delivery-start"),
          kind: "provider.user-input.delivery.started",
          tone: "info",
          summary: "복구한 질문 답변 전송 중",
          payload: { requestId, attemptId },
          turnId: null,
          createdAt: "2026-11-18T00:00:02.000Z",
        },
      }),
    );

    // Emit only `turn.started` (simulating Antigravity ACP `sendTurn()` still blocking
    // while executing a multi-minute turn). The card must resolve immediately.
    harness.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-2-started"),
      turnId: "turn-2",
      payload: { model: "gemini-4-neon" },
    });

    const thread = await harness.waitForThread((entry) =>
      entry.activities.some(
        (activity) =>
          activity.kind === "user-input.resolved" && requestIdOf(activity) === requestId,
      ),
    );
    expect(
      thread.activities.find(
        (activity) =>
          activity.kind === "provider.user-input.delivery.finished" &&
          requestIdOf(activity) === requestId,
      )?.payload,
    ).toEqual({ requestId, attemptId, outcome: "accepted" });
    expect(
      thread.activities.find(
        (activity) =>
          activity.kind === "user-input.resolved" && requestIdOf(activity) === requestId,
      )?.payload,
    ).toEqual({ requestId, answers, recovered: true });
  });
});
