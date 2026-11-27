import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * OpenCode Go authenticates by writing an API key into
 * `~/.local/share/opencode/auth.json` under the `opencode-go` provider id,
 * with `type: "api"`, so OpenCode recognizes Go
 * without overwriting the separate OpenCode Zen credential.
 */
export const OpenCodeConnectInput = Schema.Struct({
  /**
   * When omitted, the call is a read-only probe: it reports whether a Go key
   * is already registered without writing anything. When supplied, the key is
   * saved to `auth.json` and the same status is returned.
   */
  apiKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type OpenCodeConnectInput = typeof OpenCodeConnectInput.Type;

export const OpenCodeConnectResult = Schema.Struct({
  connected: Schema.Boolean,
  /**
   * Whether an OpenCode Go key is registered in `auth.json`. Optional so
   * a pre-upgrade server that only returns `connected` still decodes.
   */
  keyRegistered: Schema.optionalKey(Schema.Boolean),
});
export type OpenCodeConnectResult = typeof OpenCodeConnectResult.Type;

export class OpenCodeConnectionError extends Schema.TaggedErrorClass<OpenCodeConnectionError>()(
  "OpenCodeConnectionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
