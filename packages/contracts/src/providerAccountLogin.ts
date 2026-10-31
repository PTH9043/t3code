import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Interactive CLI login for a registered provider instance. The server runs
 * `codex login` or `claude auth login` against the instance's dedicated home
 * directory, lets the CLI open the system browser, then checks `login status`
 * to confirm the account landed before reporting success.
 */
export const ProviderAccountLoginInput = Schema.Struct({
  driver: Schema.Literals(["codex", "claudeAgent", "cursor", "grok", "gemini", "opencode"]),
});
export type ProviderAccountLoginInput = typeof ProviderAccountLoginInput.Type;

export const ProviderAccountLoginResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAccountLoginResult = typeof ProviderAccountLoginResult.Type;

export class ProviderAccountLoginError extends Schema.TaggedErrorClass<ProviderAccountLoginError>()(
  "ProviderAccountLoginError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
