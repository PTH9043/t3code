import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { UpgradeRoomMemory } from "../orchestration/UpgradeRoomMemory.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
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
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("reports the host's reason for a preview snapshot failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationTabNotFoundError",
                message: `Preview automation target for snapshot request ${event.request.requestId} is unavailable on environment ${environmentId} thread ${threadId} (tab unassigned, bridge unavailable).`,
                detail: {
                  requestId: event.request.requestId,
                  operation: "snapshot",
                  environmentId,
                  threadId,
                  tabId: null,
                  bridgeAvailable: false,
                },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("bridge unavailable"),
        },
      ]);
      expect(snapshot.structuredContent).toMatchObject({
        error: {
          _tag: "PreviewAutomationTabNotFoundError",
          operation: "snapshot",
          failureCount: 1,
          detail: { bridgeAvailable: false, tabId: null },
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds what a preview host can put into the model's context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-hostile-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-hostile-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationTabNotFoundError",
                message: "x".repeat(50_000),
                detail: {
                  operation: "snapshot",
                  consoleOutput: "sensitive browser output",
                  pageText: "y".repeat(50_000),
                },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      const text = snapshot.content[0];
      expect(text?.type).toBe("text");
      expect(text?.type === "text" ? text.text.length : -1).toBe(2_000);

      const error = (snapshot.structuredContent as { readonly error: Record<string, unknown> })
        .error;
      expect(error.detail).toEqual({ operation: "snapshot" });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("returns a screenshot-less preview snapshot without an image block", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-screenshotless-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-screenshotless-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              result: {
                url: "http://example.test/",
                title: "Example",
                loading: false,
                visibleText: "Example",
                interactiveElements: [],
                accessibilityTree: {},
                consoleEntries: [],
                networkEntries: [],
                actionTimeline: [],
                screenshotError: "UnknownVizError",
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(false);
      expect(snapshot.structuredContent).toMatchObject({
        visibleText: "Example",
        screenshotError: "UnknownVizError",
      });
      expect(snapshot.structuredContent).not.toHaveProperty("screenshot");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const press = yield* server
        .callTool({
          name: "preview_press",
          arguments: { key: "Enter", toolSummary: "Press Enter" },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

const DevelopmentTestLayer = McpHttpServer.DevelopmentToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.succeed(UpgradeRoomMemory, false)),
);

it.effect(
  "flattens root anyOf union tool schemas so Antigravity/ACP toolSummary injection never collides, and strips client wrapper fields on call",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const unionToolNames = [
          "workspace_memory",
          "workspace_research",
          "workspace_document",
          "workspace_mailbox",
          "assistant_computer",
          "runtime_plugin",
        ] as const;

        for (const name of unionToolNames) {
          const entry = server.tools.find(({ tool }) => tool.name === name);
          expect(entry, `missing tool ${name}`).toBeDefined();
          const schema = entry!.tool.inputSchema as Record<string, unknown>;
          expect(schema.type).toBe("object");
          expect(schema.anyOf).toBeUndefined();
          expect(schema.oneOf).toBeUndefined();
          expect(schema.additionalProperties).toBe(false);
          expect(typeof schema.properties).toBe("object");
        }

        const memoryTool = server.tools.find(({ tool }) => tool.name === "workspace_memory")!.tool;
        const memorySchema = memoryTool.inputSchema as {
          readonly type: string;
          readonly additionalProperties: boolean;
          readonly required?: ReadonlyArray<string>;
          readonly properties: Record<string, Record<string, unknown>>;
        };
        expect(memorySchema.required).toEqual(["action"]);
        expect(memorySchema.properties.action).toEqual({
          type: "string",
          enum: [
            "status",
            "dream",
            "backfill",
            "user_style",
            "search",
            "reflect",
            "read",
            "remember",
            "forget",
            "forget-message",
            "history",
            "export",
          ],
        });
        expect(memorySchema.properties.speaker).toEqual({
          type: "string",
          enum: ["all", "user", "ai"],
        });
        expect(memorySchema.properties.layer).toEqual({
          type: "string",
          enum: ["all", "observation", "fact"],
        });

        const mailboxSchema = server.tools.find(({ tool }) => tool.name === "workspace_mailbox")!
          .tool.inputSchema as Record<string, unknown>;
        expect(mailboxSchema.required).toBeUndefined();

        // Simulate Antigravity CLI (`agy acp`) injecting `toolSummary` into root `properties` + `required`
        const agyMutatedProperties = new Set([
          ...Object.keys(memorySchema.properties),
          "toolSummary",
        ]);
        const agyCallInput = {
          action: "search",
          limit: 10,
          query: "youtube",
          toolSummary: "Search YouTube memory records",
        };
        expect(Object.keys(agyCallInput).every((key) => agyMutatedProperties.has(key))).toBe(true);

        // Server-side `stripMcpClientMetaFields` strips undeclared `toolSummary` so schema validation
        // passes through to the actual domain handler (which reports missing WorkspaceMemory service here,
        // NOT `InvalidParams` on `toolSummary`).
        const callWithSummary = yield* server
          .callTool({
            name: "workspace_memory",
            arguments: agyCallInput,
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(callWithSummary.isError).toBe(true);
        expect(callWithSummary.content[0]).toEqual({
          type: "text",
          text: expect.stringContaining("기억 서비스가 비활성화되어 있습니다."),
        });

        // Missing per-action required fields (`query` omitted on `action: "search"`) are STILL rejected
        // by Effect's server-side `WorkspaceMemoryToolInput` union schema!
        const missingQuery = yield* server
          .callTool({
            name: "workspace_memory",
            arguments: { action: "search", toolSummary: "Invalid search" },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.flip,
          );
        expect(missingQuery._tag).toBe("InvalidParams");
      }),
    ).pipe(Effect.provide(DevelopmentTestLayer)),
);
