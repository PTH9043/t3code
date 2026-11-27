import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  ProjectId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Context from "effect/Context";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { WorkspaceDevelopment } from "../../orchestration/WorkspaceDevelopment.ts";
import { GrokResearch } from "../../research/GrokResearch.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceMemory } from "../../orchestration/WorkspaceMemory.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceAgentExecutor } from "../../orchestration/Services/WorkspaceAgentExecutor.ts";
import { state } from "../../orchestration/workspaceDevelopmentFixtures.ts";
import { McpInvocationContext } from "../McpInvocationContext.ts";
import { handlersLayer, WorkspaceDevelopmentToolkit } from "./workspaceDevelopment.ts";

const invocation = {
  environmentId: EnvironmentId.make("environment-tool-test"),
  threadId: ThreadId.make("main"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const thread: OrchestrationThreadShell = {
  id: invocation.threadId,
  projectId: ProjectId.make("project"),
  title: "Main",
  modelSelection: { instanceId: invocation.providerInstanceId, model: "selected" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-10-12T00:00:00Z",
  updatedAt: "2026-10-12T00:00:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const unused = () => Effect.die("unused");
const researchQueries = Layer.succeed(ProjectionSnapshotQuery, {
  getThreadShellById: () => Effect.succeed(Option.some(thread)),
  getProjectShellById: unused,
  getCommandReadModel: unused,
  getSnapshot: unused,
  getShellSnapshot: unused,
  getArchivedShellSnapshot: unused,
  searchThreads: unused,
  getSnapshotSequence: unused,
  getCounts: unused,
  getActiveProjectByWorkspaceRoot: unused,
  getFirstActiveThreadIdByProjectId: unused,
  getThreadCheckpointContext: unused,
  getFullThreadDiffContext: unused,
  getThreadRuntimeContext: () => Effect.die("unused runtime context"),
  getThreadDetailById: unused,
  getThreadDetailSnapshot: unused,
});
function layer(invoke?: typeof WorkspaceDevelopment.Service.invoke) {
  const handlers = invoke
    ? handlersLayer.pipe(
        Layer.provide(
          Layer.succeed(WorkspaceDevelopment, {
            get: () => Effect.succeed(state),
            subscribe: () => Stream.empty,
            configure: () => Effect.die("unused"),
            directInput: () => Effect.die("unused"),
            returnControl: () => Effect.die("unused"),
            goal: () => Effect.die("unused"),
            prepareMainInput: () => Effect.die("unused"),
            workflowContext: () => Effect.die("unused"),
            invoke,
          }),
        ),
      )
    : handlersLayer;
  return McpServer.toolkit(WorkspaceDevelopmentToolkit).pipe(
    Layer.provide(handlers),
    Layer.provideMerge(McpServer.McpServer.layer),
  );
}
const summary = {
  revision: state.revision,
  policyRevision: state.policyRevision,
  goal: null,
  mainObservedRevision: 3,
  mainActedRevision: 0,
  ownerModels: state.ownerModels,
  workspaces: state.workspaces,
  bindings: [],
  tasks: [],
  verifications: [],
  integrations: [],
};
const call = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  return yield* server.callTool({
    name: "workspace_manage",
    arguments: { action: "status", commandId: CommandId.make("read-1") },
  });
}).pipe(
  Effect.provideService(McpInvocationContext, invocation),
  Effect.provideService(McpSchema.McpServerClient, client),
);
it.effect(
  "authorizes memory tools against the authenticated project before invoking storage",
  () => {
    let calls = 0;
    const memory = Layer.succeed(WorkspaceMemory, {
      invoke: (input) =>
        Effect.sync(() => {
          calls++;
          expect(input.projectId).toBe(thread.projectId);
          if (input.action === "search") expect(input.limit).toBe(20);
          return '{"version":2}';
        }),
      context: unused,
      contextPaths: unused,
      reconcile: unused,
      handoff: unused,
    });
    const toolkit = McpServer.toolkit(WorkspaceDevelopmentToolkit).pipe(
      Layer.provide(handlersLayer.pipe(Layer.provide(memory), Layer.provide(researchQueries))),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const own = yield* server.callTool({
        name: "workspace_memory",
        arguments: { action: "status", projectId: thread.projectId },
      });
      expect(own.isError).toBe(false);
      const foreign = yield* server.callTool({
        name: "workspace_memory",
        arguments: { action: "status", projectId: "foreign-project" },
      });
      expect(foreign.isError).toBe(true);
      expect(calls).toBe(1);
      // Agents routinely omit the project or ask for more results than the cap;
      // both resolve to the current project and the cap instead of failing.
      const implicit = yield* server.callTool({
        name: "workspace_memory",
        arguments: { action: "status" },
      });
      expect(implicit.isError).toBe(false);
      const oversized = yield* server.callTool({
        name: "workspace_memory",
        arguments: { action: "search", query: "usage", limit: 50 },
      });
      expect(oversized.isError).toBe(false);
      expect(calls).toBe(3);
    }).pipe(
      Effect.provideService(McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(toolkit),
    );
  },
);

it.effect("returns an object with the command receipt in actual MCP structuredContent", () =>
  call.pipe(
    Effect.provide(
      layer((scope) => {
        expect(scope.threadId).toBe(invocation.threadId);
        return Effect.succeed(JSON.stringify(summary));
      }),
    ),
    Effect.map((result) => {
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        revision: 3,
        receipt: { action: "status", commandId: "read-1" },
      });
      const content = result.content[0];
      expect(content?.type === "text" ? JSON.parse(content.text) : null).toEqual(
        result.structuredContent,
      );
    }),
  ),
);
it.effect("marks disabled development as a tool failure", () =>
  call.pipe(
    Effect.provide(layer()),
    Effect.map((result) => {
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject([
        { type: "text", text: expect.stringContaining("비활성화") },
      ]);
    }),
  ),
);
it.effect("fails malformed results without submitting the command again", () => {
  let submissions = 0;
  return call.pipe(
    Effect.provide(
      layer(() => {
        submissions++;
        return Effect.succeed("{invalid}");
      }),
    ),
    Effect.map((result) => {
      expect(result.isError).toBe(true);
      expect(submissions).toBe(1);
      expect(result.content).toMatchObject([{ text: expect.stringContaining("재전송하지 말고") }]);
    }),
  );
});
it.effect(
  "scopes Grok research tools to the authenticated caller's project before making a paid call",
  () => {
    let statusReads = 0;
    let paidCalls = 0;
    const research = Layer.succeed(GrokResearch, {
      status: (projectId) =>
        Effect.sync(() => {
          statusReads++;
          expect(projectId).toBe(thread.projectId);
          return {
            apiKeyReady: false,
            model: "grok-4.7",
            day: "2026-10-12",
            dailyLimitUsd: null,
            reportedTodayUsd: 0,
            projectTodayUsd: 0,
            unreportedCalls: 0,
            busy: false,
            calls: [],
          };
        }),
      runOrdered: (input) =>
        Effect.sync(() => {
          expect(input.projectId).toBe(thread.projectId);
          return {
            status: "search-directly" as const,
            attempts: [],
            text: "직접 검색",
            sources: [],
          };
        }),
      run: () =>
        Effect.sync(() => {
          paidCalls++;
        }).pipe(Effect.andThen(Effect.die("A foreign-project call must never execute"))),
      configureKey: unused,
    });
    const toolkit = McpServer.toolkit(WorkspaceDevelopmentToolkit).pipe(
      Layer.provide(
        handlersLayer.pipe(
          Layer.provide(research),
          Layer.provide(researchQueries),
          Layer.provide(
            ServerSettingsService.layerTest({
              searchModels: [{ provider: "openai", model: "fixture" }],
            }),
          ),
        ),
      ),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const own = yield* server.callTool({
        name: "workspace_research",
        arguments: { action: "status", projectId: thread.projectId },
      });
      expect(own.isError).toBe(false);
      const foreign = yield* server.callTool({
        name: "workspace_research",
        arguments: {
          action: "run",
          projectId: "another-project",
          requestId: "request",
          query: "조사",
          source: "web",
        },
      });
      expect(foreign.isError).toBe(true);
      const search = { action: "search", requestId: "ordered", query: "공개 자료" };
      const ownSearch = yield* server.callTool({ name: "workspace_research", arguments: search });
      expect(ownSearch.isError).toBe(false);
      expect(ownSearch.structuredContent).toMatchObject({ status: "search-directly" });
      const oldDefault = yield* server.callTool({
        name: "workspace_research",
        arguments: { ...search, action: "run", source: "web", projectId: thread.projectId },
      });
      expect(oldDefault.isError).toBe(false);
      expect(oldDefault.structuredContent).toMatchObject({ status: "search-directly" });
      const foreignSearch = yield* server.callTool({
        name: "workspace_research",
        arguments: { ...search, projectId: "another-project" },
      });
      expect(foreignSearch.isError).toBe(true);
      expect(statusReads).toBe(1);
      expect(paidCalls).toBe(0);
    }).pipe(
      Effect.provideService(McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(toolkit),
    );
  },
);

it.effect("forwards the selected research provider and mode through the MCP tool", () => {
  const seen: Array<{ provider?: string; geminiMode?: string; customMode?: string }> = [];
  const research = Layer.succeed(GrokResearch, {
    runOrdered: unused,
    status: unused,
    configureKey: unused,
    run: (input) =>
      Effect.sync(() => {
        seen.push(input);
        return {
          requestId: input.requestId,
          projectId: input.projectId,
          query: input.query,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { researchModel: input.model } : {}),
          displayOnly: input.provider === "gemini" && input.geminiMode === "google",
          kind: "research" as const,
          status: "complete" as const,
          createdAt: "2026-10-12T00:00:00Z",
          day: "2026-10-12",
          responseId: null,
          costTicks: null,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          text: "Synthetic research",
          sources: ["https://example.com/source"],
          itemId: null,
          message: null,
        };
      }),
  });
  const toolkit = McpServer.toolkit(WorkspaceDevelopmentToolkit).pipe(
    Layer.provide(handlersLayer.pipe(Layer.provide(research), Layer.provide(researchQueries))),
    Layer.provideMerge(McpServer.McpServer.layer),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const selections = [
      { provider: "openai" },
      { provider: "anthropic" },
      { provider: "gemini", geminiMode: "analysis", followUpId: "prior" },
      { provider: "custom", customMode: "search", apiInstanceId: "custom-api" },
      {
        provider: "custom",
        customMode: "analysis",
        apiInstanceId: "custom-api",
        followUpId: "prior",
      },
    ];
    for (const [index, selection] of selections.entries()) {
      const result = yield* server.callTool({
        name: "workspace_research",
        arguments: {
          action: "run",
          projectId: thread.projectId,
          requestId: `research-${index}`,
          query: "synthetic question",
          source: "web",
          model: "synthetic-model",
          ...selection,
        },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        provider: selection.provider,
        displayOnly: selection.provider === "gemini" && selection.geminiMode === "google",
      });
      expect(seen[index]).toMatchObject(selection);
    }
    const google = yield* server.callTool({
      name: "workspace_research",
      arguments: {
        action: "run",
        projectId: thread.projectId,
        requestId: "google-display-only",
        query: "synthetic question",
        source: "web",
        model: "synthetic-model",
        provider: "gemini",
        geminiMode: "google",
      },
    });
    expect(google.isError).toBe(true);
    expect(google.content).toMatchObject([
      { type: "text", text: expect.stringContaining("프로젝트 조사 화면") },
    ]);
    expect(seen).toHaveLength(selections.length);
  }).pipe(
    Effect.provideService(McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(toolkit),
  );
});

it.effect("hands a task to a subordinate model through the MCP tool", () => {
  const prompts: Array<string> = [];
  const team = {
    threadId: invocation.threadId,
    answeringInstanceId: invocation.providerInstanceId,
    forModel: thread.modelSelection.model,
    source: "account",
    members: [
      {
        instanceId: ProviderInstanceId.make("codex_work"),
        account: "Codex Work",
        model: "gpt-6-sol",
        role: "worker",
      },
    ],
  } as const;
  const executor = Layer.succeed(WorkspaceAgentExecutor, {
    execute: (input) =>
      Effect.sync(() => {
        prompts.push(input.prompt);
        return "Subordinate answer.";
      }),
  });
  const toolkit = <E, R>(handlers: Layer.Layer<Layer.Success<typeof handlersLayer>, E, R>) =>
    McpServer.toolkit(WorkspaceDevelopmentToolkit).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
  const delegate = (action: "status" | "run") =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server.callTool({
        name: "workspace_delegate",
        arguments: action === "run" ? { action, to: "worker", task: "Do the thing." } : { action },
      });
    }).pipe(
      Effect.provideService(McpInvocationContext, {
        ...invocation,
        executionCwd: "/work",
        delegateTeam: team,
        activeDelegateTurnId: Effect.succeed(TurnId.make("turn")),
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      // A single struct: MCP clients get an object schema without a root union.
      const schema = server.tools.find((entry) => entry.tool.name === "workspace_delegate")?.tool
        .inputSchema;
      expect(schema).toMatchObject({ type: "object" });
      expect(schema).not.toHaveProperty("anyOf");
      const status = yield* delegate("status");
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        subordinates: [{ role: "worker", account: "Codex Work", model: "gpt-6-sol" }],
        status: null,
      });
      const run = yield* delegate("run");
      expect(run.isError).toBe(false);
      expect(run.structuredContent).toMatchObject({
        status: "completed",
        text: "Subordinate answer.",
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Do the thing.");
    }).pipe(
      Effect.provide(
        toolkit(handlersLayer.pipe(Layer.provide(executor), Layer.provide(researchQueries))),
      ),
    );
    // Without the executor the tool reports itself unavailable instead of failing obscurely.
    const disabled = yield* delegate("status").pipe(Effect.provide(toolkit(handlersLayer)));
    expect(disabled.isError).toBe(true);
    expect(disabled.content).toMatchObject([
      { type: "text", text: expect.stringContaining("사용할 수 없습니다") },
    ]);
  });
});

it("keeps workspace_delegate loaded in Claude Code instead of behind tool search", () => {
  const delegate = WorkspaceDevelopmentToolkit.tools.workspace_delegate;
  expect(Context.getOrUndefined(delegate.annotations, Tool.Meta)).toEqual({
    "anthropic/alwaysLoad": true,
  });
  expect(
    Context.getOrUndefined(
      WorkspaceDevelopmentToolkit.tools.workspace_helper.annotations,
      Tool.Meta,
    ),
  ).toBeUndefined();
});

it.effect("advertises workspace_delegate as always loaded in the MCP tool list", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const listed = server.tools.find(({ tool }) => tool.name === "workspace_delegate")?.tool;
    expect(listed?._meta).toEqual({ "anthropic/alwaysLoad": true });
    expect(
      server.tools.find(({ tool }) => tool.name === "workspace_helper")?.tool._meta,
    ).toBeUndefined();

    // Verify Wave 1 & Wave 2 tools are registered cleanly as object schemas (only +2 MCP tools).
    const ccrTool = server.tools.find(
      ({ tool }) => tool.name === "workspace_retrieve_output",
    )?.tool;
    const graphTool = server.tools.find(({ tool }) => tool.name === "workspace_code_graph")?.tool;
    expect(ccrTool?.inputSchema).toMatchObject({ type: "object" });
    expect(graphTool?.inputSchema).toMatchObject({ type: "object" });

    // Call workspace_retrieve_output with missing hash -> clean non-error found:false response
    const missing = yield* server
      .callTool({
        name: "workspace_retrieve_output",
        arguments: { outputHash: "ccr_0000000000000000" },
      })
      .pipe(
        Effect.provideService(McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(missing.isError).toBe(false);
    expect(missing.structuredContent).toMatchObject({ found: false });
  }).pipe(Effect.provide(layer((_scope) => Effect.succeed("unused")))),
);
