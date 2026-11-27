import * as Schema from "effect/Schema";

export const McpToolId = Schema.Literals([
  "openaiDocs",
  "context7",
  "filesystem",
  "sequentialThinking",
  "claudeTools",
]);
export type McpToolId = typeof McpToolId.Type;

export const ManagedMcpProvider = Schema.Literals(["codex", "claudeAgent", "gemini", "grok"]);
export type ManagedMcpProvider = typeof ManagedMcpProvider.Type;
export const McpServerName = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/));
const ManagedMcpConfigBase = {
  name: McpServerName,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  enabled: Schema.Boolean,
  providers: Schema.Array(ManagedMcpProvider).check(Schema.isMinLength(1)),
  workspaceRoot: Schema.NullOr(Schema.String),
};
export const ManagedMcpServerConfig = Schema.Union([
  Schema.Struct({
    ...ManagedMcpConfigBase,
    transport: Schema.Literal("stdio"),
    command: Schema.String.check(Schema.isMinLength(1)),
    args: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    ...ManagedMcpConfigBase,
    transport: Schema.Literal("http"),
    url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
    headers: Schema.Record(Schema.String, Schema.String),
    redactedHeaders: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
]);
export type ManagedMcpServerConfig = typeof ManagedMcpServerConfig.Type;

export const McpProjectProfile = Schema.Struct({
  workspaceRoot: Schema.String.check(Schema.isMinLength(1)),
  enabledBuiltins: Schema.Array(McpToolId),
});
export type McpProjectProfile = typeof McpProjectProfile.Type;

export const McpToolCatalogEntry = Schema.Struct({
  id: Schema.String,
  builtinId: Schema.NullOr(McpToolId),
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  source: Schema.String,
  providers: Schema.Array(Schema.String),
  /** Providers whose native toolset already covers this builtin server; skipped from default auto-injection unless explicitly pinned by a project profile. */
  nativeRedundantProviders: Schema.optionalKey(Schema.Array(ManagedMcpProvider)),
  /** Estimated tool count used for session tool-declaration budget guidance (e.g. Antigravity MCP cap). */
  estimatedToolCount: Schema.optionalKey(Schema.Number),
  status: Schema.Literals(["unchecked", "ready", "missing", "error"]),
  checkedAt: Schema.NullOr(Schema.String),
  tools: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
  scope: Schema.Literals(["environment", "project"]),
});
export type McpToolCatalogEntry = typeof McpToolCatalogEntry.Type;

export const McpToolCatalog = Schema.Struct({ entries: Schema.Array(McpToolCatalogEntry) });
export type McpToolCatalog = typeof McpToolCatalog.Type;

export class McpToolsError extends Schema.TaggedErrorClass<McpToolsError>()("McpToolsError", {
  message: Schema.String,
}) {}
