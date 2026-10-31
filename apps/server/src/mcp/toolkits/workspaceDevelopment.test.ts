import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { WorkspaceDevelopment } from "../../orchestration/WorkspaceDevelopment.ts";
import { GrokResearch } from "../../research/GrokResearch.ts";
import { WorkspaceMemory } from "../../orchestration/WorkspaceMemory.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
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
      run: () =>
        Effect.sync(() => {
          paidCalls++;
        }).pipe(Effect.andThen(Effect.die("A foreign-project call must never execute"))),
      configureKey: unused,
    });
    const toolkit = McpServer.toolkit(WorkspaceDevelopmentToolkit).pipe(
      Layer.provide(handlersLayer.pipe(Layer.provide(research), Layer.provide(researchQueries))),
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
      expect(statusReads).toBe(1);
      expect(paidCalls).toBe(0);
    }).pipe(
      Effect.provideService(McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(toolkit),
    );
  },
);
