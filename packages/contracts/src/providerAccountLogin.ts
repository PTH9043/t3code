import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Interactive CLI login for a registered provider instance. The server runs
 * the provider's CLI login command against the instance's dedicated home
 * directory, lets the CLI open the system browser, then confirms the account
 * landed before reporting success.
 */
export const ProviderAccountLoginInput = Schema.Struct({
  driver: Schema.Literals(["codex", "claudeAgent", "cursor", "grok", "gemini"]),
  /** Re-authenticate an existing instance instead of creating a new one. */
  instanceId: Schema.optional(ProviderInstanceId),
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAccountLoginInput = typeof ProviderAccountLoginInput.Type;

export const ProviderAccountLoginResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  displayName: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAccountLoginResult = typeof ProviderAccountLoginResult.Type;

export const GrokDeviceAuthBeginInput = Schema.Struct({
  /** Re-authenticate an existing Grok instance instead of creating a new one. */
  instanceId: Schema.optional(ProviderInstanceId),
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type GrokDeviceAuthBeginInput = typeof GrokDeviceAuthBeginInput.Type;

export const GrokDeviceAuthBeginResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  instanceId: ProviderInstanceId,
  verificationUrl: TrimmedNonEmptyString,
  userCode: Schema.optional(TrimmedNonEmptyString),
  expiresAt: TrimmedNonEmptyString,
});
export type GrokDeviceAuthBeginResult = typeof GrokDeviceAuthBeginResult.Type;

export const GrokDeviceAuthWaitInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type GrokDeviceAuthWaitInput = typeof GrokDeviceAuthWaitInput.Type;

export const GrokDeviceAuthCancelInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type GrokDeviceAuthCancelInput = typeof GrokDeviceAuthCancelInput.Type;

export const MuseAuthBeginInput = Schema.Struct({
  /** Re-authenticate an existing Muse instance instead of creating a new one. */
  instanceId: Schema.optional(ProviderInstanceId),
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type MuseAuthBeginInput = typeof MuseAuthBeginInput.Type;

export const MuseAuthBeginResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  instanceId: ProviderInstanceId,
  verificationUrl: TrimmedNonEmptyString,
  userCode: Schema.optional(TrimmedNonEmptyString),
  expiresAt: TrimmedNonEmptyString,
});
export type MuseAuthBeginResult = typeof MuseAuthBeginResult.Type;

export const MuseAuthWaitInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type MuseAuthWaitInput = typeof MuseAuthWaitInput.Type;

export const MuseAuthCancelInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type MuseAuthCancelInput = typeof MuseAuthCancelInput.Type;

export const MuseCloudAuthBeginInput = Schema.Struct({
  /** Re-authenticate an existing muse.ai cloud instance instead of creating a new one. */
  instanceId: Schema.optional(ProviderInstanceId),
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type MuseCloudAuthBeginInput = typeof MuseCloudAuthBeginInput.Type;

export const MuseCloudAuthBeginResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  instanceId: ProviderInstanceId,
  loginUrl: TrimmedNonEmptyString,
  browserLabel: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type MuseCloudAuthBeginResult = typeof MuseCloudAuthBeginResult.Type;

export const MuseCloudAuthWaitInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type MuseCloudAuthWaitInput = typeof MuseCloudAuthWaitInput.Type;

export const MuseCloudAuthCancelInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type MuseCloudAuthCancelInput = typeof MuseCloudAuthCancelInput.Type;

export const MuseCloudAuthCookieInput = Schema.Struct({
  /** Raw Cookie header, `hatch_sess=...`, bare token, JSON, or Netscape cookie jar text. */
  cookies: TrimmedNonEmptyString,
  instanceId: Schema.optional(ProviderInstanceId),
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type MuseCloudAuthCookieInput = typeof MuseCloudAuthCookieInput.Type;

export class ProviderAccountLoginError extends Schema.TaggedErrorClass<ProviderAccountLoginError>()(
  "ProviderAccountLoginError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
