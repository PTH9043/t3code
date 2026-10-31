import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const DeepSeekConnectInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: TrimmedNonEmptyString,
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type DeepSeekConnectInput = typeof DeepSeekConnectInput.Type;
export const DeepSeekConnectResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  models: Schema.Array(TrimmedNonEmptyString),
});
export class DeepSeekConnectionError extends Schema.TaggedErrorClass<DeepSeekConnectionError>()(
  "DeepSeekConnectionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
