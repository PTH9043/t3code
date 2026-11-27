import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import {
  formatCompactA11ySnapshot,
  type A11yElementLike,
} from "@t3tools/shared/compactA11ySnapshot";
import {
  WorkspaceDevelopmentToolkit,
  handlersLayer as DevelopmentHandlers,
} from "./toolkits/workspaceDevelopment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { UpgradeRoomMemory } from "../orchestration/UpgradeRoomMemory.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const invocation = yield* registry.resolve(token);
        if (!invocation) {
          // Without this the only symptom of a dead credential is the agent
          // quietly losing the whole `t3-code` toolkit for the rest of its
          // session, with nothing on the server to explain why.
          yield* Effect.logWarning("rejected MCP request with an unusable credential", {
            reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
          });
          return unauthorized;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map(normalizeMcpHttpResponse),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

// The preview host drives arbitrary third-party pages, and the wire schema types
// `message`/`detail` as unbounded strings and Unknown. Both reach the model's
// context, so this server bounds them rather than trusting the host to: only
// these structural keys cross, and the message is clipped.
const PREVIEW_ERROR_DETAIL_KEYS = [
  "requestId",
  "operation",
  "tabId",
  "timeoutMs",
  "bridgeAvailable",
  "selectorKind",
  "selectorLength",
] as const;
const PREVIEW_ERROR_MESSAGE_MAX = 2_000;

const previewSnapshotRemoteError = (
  error: unknown,
): { readonly message?: string; readonly detail?: Record<string, unknown> } => {
  const remote =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  if (typeof remote !== "object" || remote === null) return {};
  const rawMessage =
    "message" in remote && typeof remote.message === "string" ? remote.message : undefined;
  const message =
    rawMessage === undefined ? undefined : rawMessage.slice(0, PREVIEW_ERROR_MESSAGE_MAX);
  const rawDetail = "detail" in remote ? remote.detail : undefined;
  const detail =
    typeof rawDetail === "object" && rawDetail !== null
      ? Object.fromEntries(
          PREVIEW_ERROR_DETAIL_KEYS.filter((key) => key in rawDetail).map((key) => [
            key,
            (rawDetail as Record<string, unknown>)[key],
          ]),
        )
      : undefined;
  return {
    ...(message === undefined ? {} : { message }),
    ...(detail === undefined || Object.keys(detail).length === 0 ? {} : { detail }),
  };
};

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const remote = previewSnapshotRemoteError(firstFailure);
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
        ...(remote.detail === undefined ? {} : { detail: remote.detail }),
      },
    },
    content: [{ type: "text", text: remote.message ?? "Preview snapshot failed." }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  const normalizedSnapshotTool = normalizeDevelopmentToolSchema(
    new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
  );
  const snapshotDeclaredKeys = extractDeclaredPropertyKeys(normalizedSnapshotTool.inputSchema);
  yield* server.addTool({
    tool: normalizedSnapshotTool,
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built
          .handle("preview_snapshot", stripMcpClientMetaFields(payload, snapshotDeclaredKeys))
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.matchCauseEffect({
              onFailure: previewSnapshotFailure,
              onSuccess: ({ encodedResult }) => {
                const snapshot = encodedResult as {
                  readonly screenshot?: {
                    readonly mimeType: "image/png";
                    readonly data: string;
                    readonly width: number;
                    readonly height: number;
                  };
                  readonly [key: string]: unknown;
                };
                const { screenshot, ...page } = snapshot;
                const rawElements = Array.isArray(page.elements)
                  ? (page.elements as ReadonlyArray<A11yElementLike>)
                  : Array.isArray(page.interactiveElements)
                    ? (page.interactiveElements as ReadonlyArray<A11yElementLike>)
                    : undefined;
                const compactA11y =
                  rawElements && rawElements.length > 0
                    ? formatCompactA11ySnapshot({
                        url: typeof page.url === "string" ? page.url : null,
                        title: typeof page.title === "string" ? page.title : null,
                        elements: rawElements,
                      })
                    : undefined;
                const metadata = {
                  ...page,
                  ...(compactA11y !== undefined ? { compactA11y } : {}),
                  ...(screenshot === undefined
                    ? {}
                    : {
                        screenshot: {
                          mimeType: screenshot.mimeType,
                          width: screenshot.width,
                          height: screenshot.height,
                        },
                      }),
                };
                return Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: metadata,
                    content: [
                      { type: "text", text: JSON.stringify(metadata) },
                      ...(screenshot === undefined
                        ? []
                        : [
                            {
                              type: "image" as const,
                              data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                              mimeType: screenshot.mimeType,
                            },
                          ]),
                    ],
                  }),
                );
              },
            }),
          );
      }),
  });
});

const PreviewStandardToolkitRegistrationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registry = McpServer.McpServer.of({
      ...server,
      addTool: (options) => {
        const normalizedTool = normalizeDevelopmentToolSchema(options.tool);
        const declaredKeys = extractDeclaredPropertyKeys(normalizedTool.inputSchema);
        return server.addTool({
          ...options,
          tool: normalizedTool,
          handle: (payload) => options.handle(stripMcpClientMetaFields(payload, declaredKeys)),
        });
      },
    });
    yield* McpServer.registerToolkit(PreviewStandardToolkit).pipe(
      Effect.provideService(McpServer.McpServer, registry),
    );
  }),
).pipe(Layer.provide(PreviewStandardToolkitHandlersLive));

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

const MCP_CLIENT_WRAPPER_KEYS: ReadonlySet<string> = new Set([
  "toolSummary",
  "waitForPreviousTools",
  "_meta",
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonValueEquals = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => jsonValueEquals(item, right[index]))
    );
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) => Object.hasOwn(right, key) && jsonValueEquals(left[key], right[key]),
    );
  }
  return false;
};

const collectUnionObjectBranches = (
  node: unknown,
): ReadonlyArray<Record<string, unknown>> | null => {
  if (!isPlainRecord(node)) return null;
  const unionBranches = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : null;
  if (unionBranches !== null && !isPlainRecord(node.properties)) {
    const out: Array<Record<string, unknown>> = [];
    for (const item of unionBranches) {
      const nested = collectUnionObjectBranches(item);
      if (nested === null) return null;
      out.push(...nested);
    }
    return out.length > 0 ? out : null;
  }
  if (node.type === "object" || isPlainRecord(node.properties)) {
    return [node];
  }
  return null;
};

const isStringEnumProperty = (
  schema: Record<string, unknown>,
): schema is {
  readonly type: "string";
  readonly enum: ReadonlyArray<string>;
  readonly description?: string;
} => {
  if (schema.type !== "string" || !Array.isArray(schema.enum)) return false;
  const allowedKeys = new Set(["type", "enum", "description"]);
  return (
    Object.keys(schema).every((key) => allowedKeys.has(key)) &&
    schema.enum.every((item): item is string => typeof item === "string")
  );
};

const mergeUnionPropertySchemas = (
  schemas: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> => {
  const unique: Array<Record<string, unknown>> = [];
  for (const candidate of schemas) {
    if (!unique.some((existing) => jsonValueEquals(existing, candidate))) {
      unique.push(candidate);
    }
  }
  if (unique.length === 1) return unique[0]!;
  if (unique.every(isStringEnumProperty)) {
    const mergedEnum = Array.from(new Set(unique.flatMap((entry) => entry.enum)));
    const description = unique.find((entry) => typeof entry.description === "string")?.description;
    return {
      type: "string",
      enum: mergedEnum,
      ...(description !== undefined ? { description } : {}),
    };
  }
  return { anyOf: unique };
};

/**
 * Effect emits a root `anyOf` with `additionalProperties: false` inside every
 * branch for `Schema.Union` tool inputs. MCP hosts such as Antigravity CLI
 * (`agy acp`) inject client-side wrapper fields (`toolSummary`) into the root
 * `properties` + `required` and validate before calling the server — causing
 * every `anyOf` branch to reject `toolSummary` as an additional property.
 *
 * Flattening root object unions into a single `type: "object"` schema with
 * merged `properties` and intersected `required` keeps client validators happy
 * while Effect's server-side `Schema.Union` continues to enforce exact per-action
 * parameter rules on execution.
 */
export const flattenMcpRootUnionObjectSchema = (inputSchema: unknown): Record<string, unknown> => {
  if (!isPlainRecord(inputSchema)) return {};
  if (!Array.isArray(inputSchema.anyOf) && !Array.isArray(inputSchema.oneOf)) {
    return inputSchema;
  }
  const branches = collectUnionObjectBranches(inputSchema);
  if (branches === null || branches.length === 0) {
    return { ...inputSchema, type: "object" };
  }

  const mergedDefs: Record<string, unknown> = {};
  if (isPlainRecord(inputSchema.$defs)) Object.assign(mergedDefs, inputSchema.$defs);
  const mergedDefinitions: Record<string, unknown> = {};
  if (isPlainRecord(inputSchema.definitions))
    Object.assign(mergedDefinitions, inputSchema.definitions);

  const propertyBuckets = new Map<string, Array<Record<string, unknown>>>();
  for (const branch of branches) {
    if (isPlainRecord(branch.$defs)) Object.assign(mergedDefs, branch.$defs);
    if (isPlainRecord(branch.definitions)) Object.assign(mergedDefinitions, branch.definitions);
    const props = isPlainRecord(branch.properties) ? branch.properties : {};
    for (const [key, propSchema] of Object.entries(props)) {
      const normalizedProp = isPlainRecord(propSchema) ? propSchema : {};
      const bucket = propertyBuckets.get(key);
      if (bucket) bucket.push(normalizedProp);
      else propertyBuckets.set(key, [normalizedProp]);
    }
  }

  const mergedProperties: Record<string, unknown> = {};
  for (const [key, schemas] of propertyBuckets.entries()) {
    mergedProperties[key] = mergeUnionPropertySchemas(schemas);
  }

  const firstRequired = Array.isArray(branches[0]?.required)
    ? branches[0].required.filter((item): item is string => typeof item === "string")
    : [];
  const commonRequired = firstRequired.filter((reqKey) =>
    branches.every((branch) => Array.isArray(branch.required) && branch.required.includes(reqKey)),
  );

  return {
    ...(Object.keys(mergedDefs).length > 0 ? { $defs: mergedDefs } : {}),
    ...(Object.keys(mergedDefinitions).length > 0 ? { definitions: mergedDefinitions } : {}),
    type: "object",
    properties: mergedProperties,
    ...(commonRequired.length > 0 ? { required: commonRequired } : {}),
    additionalProperties: false,
  };
};

export const extractDeclaredPropertyKeys = (inputSchema: unknown): ReadonlySet<string> => {
  if (!isPlainRecord(inputSchema) || !isPlainRecord(inputSchema.properties)) {
    return new Set();
  }
  return new Set(Object.keys(inputSchema.properties));
};

export const stripMcpClientMetaFields = <T>(
  payload: T,
  declaredPropertyKeys?: ReadonlySet<string>,
): T => {
  if (!isPlainRecord(payload)) return payload;
  let copied: Record<string, unknown> | null = null;
  for (const key of Object.keys(payload)) {
    if (MCP_CLIENT_WRAPPER_KEYS.has(key) && !(declaredPropertyKeys?.has(key) ?? false)) {
      copied ??= { ...payload };
      delete copied[key];
    }
  }
  return (copied ?? payload) as T;
};

export const normalizeDevelopmentToolSchema = (tool: McpSchema.Tool): McpSchema.Tool => {
  const flattened = flattenMcpRootUnionObjectSchema(tool.inputSchema);
  return flattened === tool.inputSchema
    ? tool
    : new McpSchema.Tool({
        ...tool,
        inputSchema: flattened as typeof tool.inputSchema,
      });
};

/** Keep image bytes out of text/structured output and deliver them as MCP image content. */
export const normalizeDevelopmentToolResult = (name: string, result: McpSchema.CallToolResult) => {
  if (
    name !== "workspace_document" ||
    result.isError ||
    !result.structuredContent ||
    typeof result.structuredContent !== "object"
  )
    return result;
  const value = result.structuredContent as Record<string, unknown>;
  const raw = value.image;
  if (
    !raw ||
    typeof raw !== "object" ||
    !("mimeType" in raw) ||
    raw.mimeType !== "image/png" ||
    !("data" in raw) ||
    typeof raw.data !== "string"
  )
    return result;
  const { image: _omit, ...metadata } = value;
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: metadata,
    content: [
      { type: "text", text: JSON.stringify(metadata) },
      {
        type: "image",
        data: new Uint8Array(Buffer.from(raw.data, "base64")),
        mimeType: "image/png",
      },
    ],
  });
};

export const DevelopmentToolkitRegistrationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const upgrade = yield* UpgradeRoomMemory;
    const server = yield* McpServer.McpServer;
    // Buffer and register tools in canonical alphabetical order so the 0-index
    // MCP tool schema array stays byte-deterministic across restarts for KV caching.
    const pendingTools: Array<Parameters<typeof server.addTool>[0]> = [];
    const registry = McpServer.McpServer.of({
      ...server,
      addTool: (options) => {
        if (upgrade && !["workspace_memory", "workspace_document"].includes(options.tool.name)) {
          return Effect.void;
        }
        const normalizedTool = normalizeDevelopmentToolSchema(options.tool);
        const declaredKeys = extractDeclaredPropertyKeys(normalizedTool.inputSchema);
        pendingTools.push({
          ...options,
          tool: normalizedTool,
          handle: (payload) =>
            options
              .handle(stripMcpClientMetaFields(payload, declaredKeys))
              .pipe(
                Effect.map((result) => normalizeDevelopmentToolResult(options.tool.name, result)),
              ),
        });
        return Effect.void;
      },
    });
    yield* McpServer.registerToolkit(WorkspaceDevelopmentToolkit).pipe(
      Effect.provideService(McpServer.McpServer, registry),
    );
    pendingTools.sort((left, right) => left.tool.name.localeCompare(right.tool.name));
    for (const entry of pendingTools) {
      yield* server.addTool(entry);
    }
  }),
).pipe(Layer.provide(DevelopmentHandlers));

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  DevelopmentToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive));
