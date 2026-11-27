import * as Schema from "effect/Schema";
import { ManagedMcpProvider } from "./mcpTools.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ExtensionAction = Schema.Literals([
  "install",
  "update",
  "enable",
  "disable",
  "uninstall",
]);
export type ExtensionAction = typeof ExtensionAction.Type;
export const SkillSecurityFinding = Schema.Struct({
  kind: Schema.Literals([
    "instruction-override",
    "hidden-text",
    "download-execution",
    "credential-access",
    "credential-network",
    "embedded-secret",
    "encoded-execution",
    "permission-change",
  ]),
  file: Schema.String,
  line: Schema.Number,
});
export const SkillSecuritySkip = Schema.Struct({
  reason: Schema.Literals([
    "symlink",
    "non-regular",
    "too-large",
    "file-limit",
    "total-limit",
    "depth-limit",
    "unreadable",
    "encoding",
    "changed",
    "finding-limit",
    "line-limit",
    "line-length",
    "scan-error",
  ]),
  file: Schema.String,
});
export const SkillSecurityReport = Schema.Struct({
  version: Schema.Literal(1),
  complete: Schema.Boolean,
  scannedFiles: Schema.Number,
  findings: Schema.Array(SkillSecurityFinding),
  skipped: Schema.Array(SkillSecuritySkip),
});
export type SkillSecurityReport = typeof SkillSecurityReport.Type;
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
  securityScan: Schema.optionalKey(SkillSecurityReport),
});
export type ExtensionEntry = typeof ExtensionEntry.Type;
export const ExtensionCatalog = Schema.Struct({
  entries: Schema.Array(ExtensionEntry),
  recoveryWarnings: Schema.optionalKey(Schema.Array(Schema.String)),
  instances: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        instanceId: ProviderInstanceId,
        provider: ManagedMcpProvider,
        displayName: Schema.String,
      }),
    ),
  ),
  providers: Schema.Array(
    Schema.Struct({
      provider: ManagedMcpProvider,
      actions: Schema.Array(ExtensionAction),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ExtensionCatalog = typeof ExtensionCatalog.Type;
export const ExtensionLookup = Schema.Struct({
  workspaceRoot: Schema.optionalKey(Schema.String),
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
});
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
