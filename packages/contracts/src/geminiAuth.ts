import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const singleLineAuthorizationCode = Schema.makeFilter(
  (code: string) =>
    (!code.includes("\r") && !code.includes("\n") && !code.includes("\u0000")) ||
    "Authorization code must be a single line without null bytes.",
);

export const GeminiAuthBeginInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type GeminiAuthBeginInput = typeof GeminiAuthBeginInput.Type;

export const GeminiAuthBeginResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  authorizationUrl: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type GeminiAuthBeginResult = typeof GeminiAuthBeginResult.Type;

export const GeminiAuthCompleteInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(4096), singleLineAuthorizationCode),
});
export type GeminiAuthCompleteInput = typeof GeminiAuthCompleteInput.Type;

export const GeminiAuthCompleteResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  email: Schema.optional(TrimmedNonEmptyString),
});
export type GeminiAuthCompleteResult = typeof GeminiAuthCompleteResult.Type;

export const GeminiAuthCancelInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type GeminiAuthCancelInput = typeof GeminiAuthCancelInput.Type;

export class GeminiAuthError extends Schema.TaggedErrorClass<GeminiAuthError>()("GeminiAuthError", {
  kind: Schema.Literals([
    "instance-not-found",
    "wrong-driver",
    "cli-not-found",
    "start-failed",
    "authorization-url-missing",
    "session-not-found",
    "authorization-failed",
    "authorization-timeout",
    "storage-failed",
  ]),
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}
