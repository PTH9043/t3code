// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ApprovalRequestId,
  CodexSettings,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ProviderExecutionId,
  ThreadId,
  TurnId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";

import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { SubordinateRow } from "../subagentSelection.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
import { makeCodexAdapter } from "./CodexAdapter.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

// Test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "t3/provider/Layers/CodexAdapter.test/CodexAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent, Cause.Done>());
  private readonly now = "2026-01-01T00:00:00.000Z";

  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  );

  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
      }),
  );

  public readonly interruptTurnImpl = vi.fn(
    (_turnId?: TurnId, _questionRequestId?: ApprovalRequestId): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly readThreadImpl = vi.fn(
    (): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly rollbackThreadImpl = vi.fn(
    (_numTurns: number): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly respondToUserInputImpl = vi.fn(
    (
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
      _images?: ReadonlyArray<{ readonly type: "image"; readonly url: string }>,
    ): Promise<void> => Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  start() {
    return Effect.promise(() => this.startImpl());
  }

  getSession = Effect.promise(() => this.startImpl());

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  interruptTurn(turnId?: TurnId, questionRequestId?: ApprovalRequestId) {
    return Effect.promise(() => this.interruptTurnImpl(turnId, questionRequestId));
  }

  readThread = Effect.promise(() => this.readThreadImpl());

  rollbackThread(numTurns: number) {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
  }

  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }

  respondToUserInput(
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
    images?: ReadonlyArray<{ readonly type: "image"; readonly url: string }>,
  ) {
    return Effect.promise(() =>
      images
        ? this.respondToUserInputImpl(requestId, answers, images)
        : this.respondToUserInputImpl(requestId, answers),
    );
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.promise(() => this.closeImpl());

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }

  endEvents() {
    return Queue.end(this.eventQueue);
  }
}

function makeRuntimeFactory() {
  const runtimes: Array<FakeCodexRuntime> = [];
  const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtimes.push(runtime);
    return Effect.succeed(runtime);
  });

  return {
    factory,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const releasedThreadIds: Array<ThreadId> = [];

  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* () {
      yield* Scope.Scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releasedThreadIds.push(runtimeOptions.threadId);
        }),
      );

      if (options?.failConstruction) {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error("runtime construction failed"),
        });
      }

      const runtime = new FakeCodexRuntime(runtimeOptions);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const questionImageRuntimeFactory = makeRuntimeFactory();
const questionImageLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      return yield* makeCodexAdapter(decodeCodexSettings({}), {
        makeRuntime: questionImageRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-question-image-" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

questionImageLayer("Codex question images", (it) => {
  it.effect("passes stored question images as native image inputs to the selected session", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const config = yield* ServerConfig;
      const threadId = asThreadId("question-image-thread");
      const image = {
        type: "image" as const,
        id: "question-image",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: image,
      });
      if (!path) throw new Error("Missing test attachment path");
      NodeFS.writeFileSync(path, Buffer.from("abc"));
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make("question"),
        { q: "see image" },
        [{ questionId: "q", image }],
      );
      NodeAssert.deepStrictEqual(
        questionImageRuntimeFactory.lastRuntime?.respondToUserInputImpl.mock.calls.at(-1),
        [
          ApprovalRequestId.make("question"),
          { q: "see image" },
          [{ type: "image", url: "data:image/png;base64,YWJj" }],
        ],
      );
    }),
  );
});

const validationRuntimeFactory = makeRuntimeFactory();
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("codex"),
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      NodeAssert.equal(validationRuntimeFactory.factory.mock.calls.length, 0);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "serviceTier", value: "priority" },
        ]),
        runtimeMode: "full-access",
      });

      NodeAssert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0], {
        binaryPath: "codex",
        cwd: process.cwd(),
        launchArgs: "",
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        serviceTier: "priority",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("disables native spawn in the runtime created for a delegated Codex child", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("delegated-codex");
      yield* adapter.startSession({
        threadId,
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "chosen-worker"),
        runtimeMode: "approval-required",
        execution: {
          executionId: ProviderExecutionId.make(threadId),
          ownerThreadId: asThreadId("owner"),
          runId: WorkspaceCollaborationRunId.make("run"),
          nodeId: WorkspaceTaskNodeId.make("delegate-scout"),
          attempt: 1,
        },
      });
      const options = validationRuntimeFactory.factory.mock.lastCall?.[0];
      NodeAssert.equal(options?.restrictNativeSubagents, true);
      NodeAssert.equal(options?.model, "chosen-worker");
      NodeAssert.equal(options?.runtimeMode, "approval-required");
      NodeAssert.equal(adapter.capabilities.nativeSubagentPolicy?.(threadId)?.restricted, true);
    }),
  );
});

const sessionRuntimeFactory = makeRuntimeFactory();
const sessionErrorLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: sessionRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps missing adapter sessions to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "codex");
      NodeAssert.equal(result.failure.threadId, "sess-missing");
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-missing"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ]),
          attachments: [],
        }),
      );

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "priority",
      });
    }),
  );

  it.effect("passes configured launch args into the session runtime", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({ launchArgs: "--strict-config --enable foo" });
        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-launch-args"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.launchArgs, "--strict-config --enable foo");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "guards the managed Claude MCP server only for ordinary chats and reads the current room setting",
    () => {
      const factory = makeRuntimeFactory();
      const room = asThreadId("opt-in-room");
      const settings = ServerSettingsService.layerTest({
        providers: { claudeAgent: { binaryPath: process.execPath } },
        mcpTools: { claudeTools: true },
      });
      const layer = Layer.effect(
        CodexAdapter,
        makeCodexAdapter(decodeCodexSettings({}), {
          makeRuntime: factory.factory,
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-codex-watch-" })),
        Layer.provideMerge(settings),
        Layer.provideMerge(NodeServices.layer),
      );
      return Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const service = yield* ServerSettingsService;
        yield* adapter.startSession({ threadId: room, runtimeMode: "approval-required" });
        const ordinary = factory.lastRuntime!.options;
        NodeAssert.ok(ordinary.appServerArgs?.some((arg) => arg.includes("codex-watch-stdio")));
        NodeAssert.equal(ordinary.runtimeMode, "approval-required");
        NodeAssert.ok(ordinary.watchAllowed);
        NodeAssert.equal(yield* ordinary.watchAllowed, false);
        yield* service.updateSettings({
          backgroundWatchThreadUpdate: { threadId: room, enabled: true },
        });
        NodeAssert.equal(yield* ordinary.watchAllowed, true);
        const child = asThreadId("execution-room");
        yield* adapter.startSession({
          threadId: child,
          runtimeMode: "full-access",
          execution: {
            executionId: ProviderExecutionId.make(child),
            ownerThreadId: room,
            runId: WorkspaceCollaborationRunId.make("run"),
            nodeId: WorkspaceTaskNodeId.make("node"),
            attempt: 1,
          },
        });
        const execution = factory.lastRuntime!.options;
        NodeAssert.equal(execution.watchAllowed, undefined);
        NodeAssert.ok(
          execution.appServerArgs?.some((arg) => arg.includes("mcp_servers.t3-claude-tools")),
        );
        NodeAssert.ok(!execution.appServerArgs?.some((arg) => arg.includes("codex-watch-stdio")));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("passes managed HTTP credentials through the session environment", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        return yield* makeCodexAdapter(decodeCodexSettings({}), {
          environment: { EXISTING_OPTION: "preserved" },
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          customMcpServers: {
            apps: {
              name: "apps",
              label: "Apps",
              enabled: true,
              providers: ["codex"],
              workspaceRoot: null,
              transport: "http",
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer fixture-secret" },
            },
          },
        }),
      ),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-http-credential"),
        runtimeMode: "full-access",
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.environment?.EXISTING_OPTION, "preserved");
      NodeAssert.equal(
        runtime.options.environment?.T3_MCP_HTTP_HEADER_0_0,
        "Bearer fixture-secret",
      );
      NodeAssert.ok(runtime.options.appServerArgs?.some((arg) => arg.includes("env_http_headers")));
      NodeAssert.ok(!runtime.options.appServerArgs?.join(" ").includes("fixture-secret"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses T3CODE_CODEX_LAUNCH_ARGS for the session runtime", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({ launchArgs: "--enable settings-feature" });
        return yield* makeCodexAdapter(codexConfig, {
          environment: { T3CODE_CODEX_LAUNCH_ARGS: " --strict-config --enable env-feature " },
          makeRuntime: runtimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-launch-args-env"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      NodeAssert.equal(runtime.options.launchArgs, "--strict-config --enable env-feature");
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps codex model options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("codex_personal");
    const customRuntimeFactory = makeRuntimeFactory();
    const customLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});
        return yield* makeCodexAdapter(codexConfig, {
          instanceId: customInstanceId,
          makeRuntime: customRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-custom-instance"),
        runtimeMode: "full-access",
      });
      const runtime = customRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-custom-instance"),
          input: "hello",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex_personal"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "flex" },
            ],
          ),
          attachments: [],
        }),
      );

      NodeAssert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "flex",
      });
    }).pipe(Effect.provide(customLayer));
  });

  it.effect("runs sub-agents on the model assigned to the answering model", () => {
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        return yield* makeCodexAdapter(
          decodeCodexSettings({
            subagentModel: "gpt-5.6-luna",
            subagentModelByModel: "gpt-6-sol=gpt-6-luna, terra=inherit",
          }),
          { makeRuntime: runtimeFactory.factory },
        );
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const threadId = asThreadId("sess-subagent-model");
    const selection = (model: string) =>
      createModelSelection(ProviderInstanceId.make("codex"), model);

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: selection("gpt-6-sol"),
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      const args = runtime.options.appServerArgs ?? [];
      NodeAssert.equal(args[args.indexOf('agents.default_subagent_model="gpt-6-luna"') - 1], "-c");

      const turnSubagentModel = (model: string) =>
        Effect.gen(function* () {
          runtime.sendTurnImpl.mockClear();
          yield* Effect.ignore(
            adapter.sendTurn({
              threadId,
              input: "hello",
              modelSelection: selection(model),
              attachments: [],
            }),
          );
          return runtime.sendTurnImpl.mock.calls[0]?.[0].subagentModel;
        });
      // Same answering model: the session default already covers it.
      NodeAssert.equal(yield* turnSubagentModel("gpt-6-sol"), undefined);
      // Switched mid-session: the turn names the newly assigned model.
      NodeAssert.equal(yield* turnSubagentModel("gpt-6-astra"), "gpt-5.6-luna");
      NodeAssert.equal(yield* turnSubagentModel("gpt-6.1-terra"), "gpt-6.1-terra");
      // Back on the first model: keep naming it, or the earlier instruction would linger.
      NodeAssert.equal(yield* turnSubagentModel("gpt-6-sol"), "gpt-6-luna");
    }).pipe(Effect.provide(layer));
  });

  it.effect("names the answering model's subordinates each turn, never for an execution", () => {
    const runtimeFactory = makeRuntimeFactory();
    const codex = ProviderInstanceId.make("codex");
    const assigned: ReadonlyArray<SubordinateRow> = [
      { role: "worker", account: "Codex", instanceId: codex, model: "gpt-6-luna" },
      {
        forModel: "gpt-6-sol",
        role: "advisor",
        account: "Codex",
        instanceId: codex,
        model: "gpt-6-astra",
      },
    ];
    let rows = assigned;
    const layer = Layer.effect(
      CodexAdapter,
      makeCodexAdapter(decodeCodexSettings({}), {
        makeRuntime: runtimeFactory.factory,
        subordinates: Effect.sync(() => rows),
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const threadId = asThreadId("sess-subordinates");
    const executionThreadId = asThreadId("sess-subordinate-execution");
    const selection = (model: string) => createModelSelection(codex, model);

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      setMcpProviderSession({
        environmentId: EnvironmentId.make("test-environment"),
        threadId,
        providerSessionId: "session",
        providerInstanceId: codex,
        endpoint: "http://127.0.0.1:2345/mcp",
        authorizationHeader: "Bearer synthetic-session-secret",
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => clearMcpProviderSession(threadId)));
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: selection("gpt-6-sol"),
      });
      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      // workspace_delegate holds a call for minutes; Codex must not cut it at its default.
      const args = runtime.options.appServerArgs ?? [];
      NodeAssert.equal(args[args.indexOf("mcp_servers.t3-code.tool_timeout_sec=300") - 1], "-c");

      const turnRoster = (target: typeof runtime, id: ThreadId, model?: string) =>
        Effect.gen(function* () {
          target.sendTurnImpl.mockClear();
          yield* Effect.ignore(
            adapter.sendTurn({
              threadId: id,
              input: "hello",
              ...(model ? { modelSelection: selection(model) } : {}),
              attachments: [],
            }),
          );
          return target.sendTurnImpl.mock.calls[0]?.[0].subordinateRoster;
        });
      // The session's model applies when the turn does not name one.
      const first = (yield* turnRoster(runtime, threadId)) ?? "";
      NodeAssert.match(first, /- worker — Codex · gpt-6-luna — /);
      NodeAssert.match(first, /- advisor — Codex · gpt-6-astra — /);
      // The advisor is assigned to gpt-6-sol only.
      const switched = (yield* turnRoster(runtime, threadId, "gpt-6.1-terra")) ?? "";
      NodeAssert.match(switched, /- worker — Codex · gpt-6-luna — /);
      NodeAssert.doesNotMatch(switched, /gpt-6-astra/);
      // Assignments are read per turn; removing them removes the roster.
      rows = [];
      NodeAssert.equal(yield* turnRoster(runtime, threadId), undefined);
      rows = assigned;

      // A subordinate or orchestra participant never gets subordinates of its own.
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: executionThreadId,
        runtimeMode: "full-access",
        modelSelection: selection("gpt-6-sol"),
        execution: {
          executionId: ProviderExecutionId.make(executionThreadId),
          ownerThreadId: threadId,
          runId: WorkspaceCollaborationRunId.make("run-1"),
          nodeId: WorkspaceTaskNodeId.make("delegate-worker"),
          attempt: 1,
        },
      });
      const executionRuntime = runtimeFactory.lastRuntime;
      NodeAssert.ok(executionRuntime && executionRuntime !== runtime);
      NodeAssert.equal(yield* turnRoster(executionRuntime, executionThreadId), undefined);
    }).pipe(Effect.provide(layer));
  });
});

const lifecycleRuntimeFactory = makeRuntimeFactory();
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

function startLifecycleRuntime() {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = lifecycleRuntimeFactory.lastRuntime;
    NodeAssert.ok(runtime);
    return { adapter, runtime };
  });
}

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("passes the selected question to the runtime when stopping", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const questionRequestId = ApprovalRequestId.make("async:question-1");
      yield* adapter.interruptTurn(asThreadId("thread-1"), undefined, { questionRequestId });
      NodeAssert.deepStrictEqual(runtime.interruptTurnImpl.mock.calls.at(-1), [
        undefined,
        questionRequestId,
      ]);
    }),
  );
  it.effect("clears a question closed by Codex without reporting a user answer", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-question-closed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-10-26T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.make("question-closed"),
        payload: { threadId: "native-thread", requestId: 0, t3UserInputResolved: "closed" },
      } satisfies ProviderEvent);
      const event = yield* Fiber.join(eventFiber);
      NodeAssert.ok(Option.isSome(event));
      NodeAssert.equal(event.value.type, "user-input.resolved");
      if (event.value.type === "user-input.resolved")
        NodeAssert.equal(event.value.payload.reason, "provider-resolved");
    }),
  );
  it.effect("keeps a native free-text question with no options so the user can answer it", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-free-text-question"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-10-26T00:00:00.000Z",
        method: "item/tool/requestUserInput",
        requestId: ApprovalRequestId.make("free-text-question"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          isBlocking: false,
          autoResolutionMs: null,
          questions: [
            {
              id: "target",
              header: "Target",
              question: "Which directory should be used?",
              isOther: true,
              isSecret: false,
              options: null,
            },
          ],
        },
      } satisfies ProviderEvent);
      const event = yield* Fiber.join(eventFiber);
      NodeAssert.ok(Option.isSome(event));
      NodeAssert.equal(event.value.type, "user-input.requested");
      if (event.value.type === "user-input.requested")
        NodeAssert.deepEqual(event.value.payload.questions, [
          {
            id: "target",
            header: "Target",
            question: "Which directory should be used?",
            options: [],
            multiSelect: false,
          },
        ]);
    }),
  );
  it.effect(
    "emits a terminal receipt when the native event stream ends without a session exit",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        yield* runtime.endEvents();
        const event = yield* Stream.runHead(adapter.streamEvents);
        NodeAssert.ok(Option.isSome(event));
        NodeAssert.equal(event.value.type, "session.exited");
        NodeAssert.equal(event.value.threadId, "thread-1");
        NodeAssert.deepStrictEqual(event.value.payload, {
          exitKind: "error",
          recoverable: true,
          reason: "Codex 실행 이벤트 연결이 종료되어 결과를 기다릴 수 없습니다.",
        });
      }),
  );
  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "done",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.itemId, "msg_1");
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("labels MCP lifecycle entries with server and tool names", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-mcp-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("mcp_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "mcpToolCall",
            id: "mcp_1",
            server: "t3-code",
            tool: "preview_status",
            arguments: {},
            durationMs: 12,
            error: null,
            result: { content: [{ type: "text", text: "attached" }] },
            status: "completed",
          },
        },
      });
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.itemType, "mcp_tool_call");
      NodeAssert.equal(firstEvent.value.payload.title, "t3-code · preview_status");
      NodeAssert.deepStrictEqual(firstEvent.value.payload.data, {
        completedAtMs: 1_778_000_000_000,
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "mcp_1",
          server: "t3-code",
          tool: "preview_status",
          arguments: {},
          durationMs: 12,
          error: null,
          result: { content: [{ type: "text", text: "attached" }] },
          status: "completed",
        },
      });
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan_1",
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "session/closed",
        message: "Session stopped",
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      NodeAssert.equal(firstEvent.value.threadId, "thread-1");
      NodeAssert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps realtime started notifications with upstream realtime session ids", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-realtime-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/realtime/started",
        payload: {
          threadId: "thread-1",
          realtimeSessionId: "realtime-session-1",
          version: "v2",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "thread.realtime.started");
      if (firstEvent.value.type !== "thread.realtime.started") {
        return;
      }
      NodeAssert.equal(firstEvent.value.threadId, "thread-1");
      NodeAssert.equal(firstEvent.value.payload.realtimeSessionId, "realtime-session-1");
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.class, "provider_error");
      NodeAssert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "command",
        requestId: ApprovalRequestId.make("req-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "file-read",
        requestId: ApprovalRequestId.make("req-file-read-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-file-read-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      NodeAssert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: {
              answers: [],
            },
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      NodeAssert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          mode: "unelevated",
          success: false,
          error: "unsupported environment",
        },
      };

      yield* runtime.emit(event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      NodeAssert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      NodeAssert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        NodeAssert.equal(firstEvent.payload.state, "error");
        NodeAssert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      NodeAssert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        NodeAssert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            itemId: "item-user-input-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        NodeAssert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          NodeAssert.equal(events[0].requestId, "req-user-input-1");
          NodeAssert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
          NodeAssert.equal(events[0].payload.questions[0]?.multiSelect, false);
        }

        NodeAssert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          NodeAssert.equal(events[1].requestId, "req-user-input-1");
          NodeAssert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("keeps an option whose description Codex left blank, falling back to its label", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-user-input-blank-description"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/tool/requestUserInput",
        requestId: ApprovalRequestId.make("req-user-input-2"),
        payload: {
          itemId: "item-user-input-2",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "use_emoji",
              header: "README",
              question: "Should the greeting use emoji?",
              options: [
                { label: "Yes", description: "" },
                { label: "No", description: "Plain text" },
              ],
            },
          ],
        },
      } satisfies ProviderEvent);

      const event = yield* Fiber.join(eventFiber);
      NodeAssert.equal(event._tag, "Some");
      if (event._tag !== "Some" || event.value.type !== "user-input.requested") {
        return;
      }
      NodeAssert.deepEqual(event.value.payload.questions[0]?.options, [
        { label: "Yes", description: "Yes" },
        { label: "No", description: "Plain text" },
      ]);
    }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      NodeAssert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      NodeAssert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
      NodeAssert.equal(firstEvent.value.payload.consumption?.[0]?.counts.total, 11_839);
      NodeAssert.equal(firstEvent.value.payload.consumption?.[0]?.counts.cacheRead, 3456);
      NodeAssert.equal(firstEvent.value.payload.consumption?.[0]?.startsAtZero, true);
    }),
  );

  it.effect("stamps the turn named by a thread-scoped Codex token usage notification", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      // Codex reports usage per THREAD: the notification envelope carries no turn id,
      // only the body does. Without picking it up the usage never reaches a turn and
      // the thread reads back as "unreported" forever.
      yield* runtime.emit({
        id: asEventId("evt-thread-scoped-token-usage"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 200,
              cachedInputTokens: 0,
              outputTokens: 10,
              reasoningOutputTokens: 0,
              totalTokens: 210,
            },
            last: {
              inputTokens: 200,
              cachedInputTokens: 0,
              outputTokens: 10,
              reasoningOutputTokens: 0,
              totalTokens: 210,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }
      NodeAssert.equal(firstEvent.value.turnId, "turn-1");
      NodeAssert.equal(firstEvent.value.payload.consumption?.[0]?.counts.total, 210);
    }),
  );

  it.effect("counts a child agent's own usage and confirms it when the child finishes", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
        Effect.forkChild,
      );
      const child = { agentThreadId: "child-thread-1", agentName: "worker" };
      const total = {
        inputTokens: 900,
        cachedInputTokens: 100,
        outputTokens: 50,
        reasoningOutputTokens: 0,
        totalTokens: 950,
      };

      // A child is its own app-server thread: the parent's counter never
      // includes this spend, so it must reach the turn as a separate source.
      yield* runtime.emit({
        id: asEventId("evt-child-usage"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "collabAgent/tokenUsage",
        payload: { ...child, tokenUsage: { total, last: total } },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-child-done"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:02.000Z",
        method: "collabAgent/turnCompleted",
        payload: { ...child, status: "completed" },
      } satisfies ProviderEvent);

      const usage = Array.from(yield* Fiber.join(eventsFiber)).filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      NodeAssert.equal(usage.length, 2);
      const [live, final] = usage.map((event) => event.payload.consumption?.[0]);
      NodeAssert.equal(live?.sourceId, "codex:child-thread-1");
      NodeAssert.equal(live?.counts.total, 950);
      NodeAssert.equal(live?.startsAtZero, true);
      NodeAssert.equal(live?.includesNativeChildren, true);
      NodeAssert.equal(live?.isFinal, undefined);
      NodeAssert.equal(final?.sourceId, "codex:child-thread-1");
      NodeAssert.equal(final?.counts.total, 950);
      NodeAssert.equal(final?.isFinal, true);
      NodeAssert.equal(usage[0]?.turnId, "turn-1");
    }),
  );

  it.effect("scopes the Codex usage counter to the session that owns it", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      // A resumed app-server can reset or carry its native cumulative counter.
      // Use a distinct epoch and do not assume its first balance is new spend.
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
        resumeCursor: { threadId: "native-thread-1" },
      });
      const runtime = lifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-resumed-token-usage"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:02.000Z",
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "native-thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 90,
              cachedInputTokens: 0,
              outputTokens: 10,
              reasoningOutputTokens: 0,
              totalTokens: 100,
            },
            last: {
              inputTokens: 90,
              cachedInputTokens: 0,
              outputTokens: 10,
              reasoningOutputTokens: 0,
              totalTokens: 100,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      NodeAssert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }
      const observation = firstEvent.value.payload.consumption?.[0];
      NodeAssert.ok(observation);
      NodeAssert.notEqual(observation.sourceId, "codex:native-thread-1");
      NodeAssert.ok(observation.sourceId.startsWith("codex:native-thread-1#"));
      NodeAssert.equal(observation.startsAtZero, false);
    }),
  );
});

const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory();
const scopedLifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedLifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedLifecycleLayer("CodexAdapterLive scoped lifecycle", (it) => {
  it.effect("closes the externally owned session scope on stopSession", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-stop"),
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      yield* adapter.stopSession(asThreadId("thread-stop"));

      NodeAssert.equal(runtime.closeImpl.mock.calls.length, 1);
      NodeAssert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-stop"),
      ]);
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("thread-stop")), false);
    }),
  );
});

const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true });
const scopedFailureLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedFailureRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedFailureLayer("CodexAdapterLive scoped startup failure", (it) => {
  it.effect("closes the externally owned session scope when startSession fails", () =>
    Effect.gen(function* () {
      scopedFailureRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-fail"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterProcessError");
      NodeAssert.deepStrictEqual(scopedFailureRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-fail"),
      ]);
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("thread-fail")), false);
    }),
  );
});

it.effect("flushes managed native logs when the adapter layer shuts down", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-codex-adapter-native-log-"),
    );
    const basePath = NodePath.join(tempDir, "provider-native.ndjson");
    const runtimeFactory = makeRuntimeFactory();
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
            nativeEventLogPath: basePath,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-native-log"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        message: "native flush test",
      } satisfies ProviderEvent);
      yield* Fiber.join(firstEventFiber);

      yield* Scope.close(scope, Exit.void);
      scopeClosed = true;

      const threadLogPath = NodePath.join(tempDir, "provider-native.thread-logger.log");
      NodeAssert.equal(NodeFS.existsSync(threadLogPath), true);
      const contents = NodeFS.readFileSync(threadLogPath, "utf8");
      NodeAssert.match(contents, /NTIVE: .*"message":"native flush test"/);
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);
