import * as Schema from "effect/Schema";
import { ManagedMcpProvider } from "./mcpTools.ts";

export const ExtensionAction = Schema.Literals([
  "install",
  "update",
  "enable",
  "disable",
  "uninstall",
]);
export type ExtensionAction = typeof ExtensionAction.Type;
export const ExtensionEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["skill", "plugin"]),
  provider: ManagedMcpProvider,
  source: Schema.String,
  version: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  scope: Schema.Literals(["user", "project", "local", "managed"]),
  actions: Schema.Array(ExtensionAction),
});
export type ExtensionEntry = typeof ExtensionEntry.Type;
export const ExtensionCatalog = Schema.Struct({
  entries: Schema.Array(ExtensionEntry),
  providers: Schema.Array(
    Schema.Struct({
      provider: ManagedMcpProvider,
      actions: Schema.Array(ExtensionAction),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ExtensionCatalog = typeof ExtensionCatalog.Type;
export const ExtensionLookup = Schema.Struct({ workspaceRoot: Schema.optionalKey(Schema.String) });
export const ExtensionActionInput = Schema.Struct({
  ...ExtensionLookup.fields,
  provider: ManagedMcpProvider,
  action: ExtensionAction,
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  kind: Schema.optionalKey(Schema.Literals(["skill", "plugin"])),
  trust: Schema.optionalKey(Schema.Boolean),
  scope: Schema.optionalKey(Schema.Literals(["user", "project", "local"])),
});
export type ExtensionActionInput = typeof ExtensionActionInput.Type;
export class ExtensionError extends Schema.TaggedErrorClass<ExtensionError>()("ExtensionError", {
  message: Schema.String,
}) {}
