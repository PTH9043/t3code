import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * The Antseed gateway exposes an OpenAI-compatible API, so an account is
 * described only by where the gateway listens and the key it accepts.
 */
export const AntseedConnectInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\//)),
  apiKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
  connectionKind: Schema.optionalKey(Schema.Literals(["gateway", "local-proxy"])),
});
export type AntseedConnectInput = typeof AntseedConnectInput.Type;

export const AntseedConnectResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  models: Schema.Array(TrimmedNonEmptyString),
});
export type AntseedConnectResult = typeof AntseedConnectResult.Type;

export class AntseedConnectionError extends Schema.TaggedErrorClass<AntseedConnectionError>()(
  "AntseedConnectionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
