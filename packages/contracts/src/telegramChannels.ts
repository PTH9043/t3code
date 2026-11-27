import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
  WorkspaceKnowledgeItemId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// MTProto marks channels by subtracting the raw channel ID from -10^12.
export const TelegramMarkedChannelId = TrimmedNonEmptyString.check(
  Schema.makeFilter((value: string) => {
    if (!/^-[1-9]\d{12,18}$/.test(value)) return false;
    const peer = BigInt(value);
    return peer < -1_000_000_000_000n && peer >= -9_223_372_036_854_775_807n;
  }),
);
export const TelegramChannelReference = Schema.Union([
  TelegramMarkedChannelId,
  TrimmedNonEmptyString.check(
    Schema.isPattern(/^(?:@[a-z][a-z\d_]{0,31}|(?:https?:\/\/)?t\.me\/[a-z][a-z\d_]{0,31}\/?)$/i),
  ),
]);

export const TelegramChannelLookupTitle = TrimmedNonEmptyString.check(
  Schema.makeFilter((value: string) => !/[\r\n]/.test(value) && !value.includes("\0")),
);

export const TelegramChannelCliPolicy = Schema.Struct({
  instanceId: ProviderInstanceId,
  modelId: TrimmedNonEmptyString,
  allowExternalTransfer: Schema.Literal(true),
});
export type TelegramChannelCliPolicy = typeof TelegramChannelCliPolicy.Type;

export const TelegramChannelsStatusInput = Schema.Struct({ projectId: ProjectId });
export type TelegramChannelsStatusInput = typeof TelegramChannelsStatusInput.Type;

const registration = {
  projectId: ProjectId,
  registrationId: TelegramMarkedChannelId,
};

export const TelegramChannelsManageInput = Schema.Union([
  // Exact local title lookup shares the management authorization of registration.
  Schema.Struct({
    action: Schema.Literal("lookup"),
    projectId: ProjectId,
    title: TelegramChannelLookupTitle,
  }),
  Schema.Struct({
    action: Schema.Literal("register"),
    projectId: ProjectId,
    channel: TelegramChannelReference,
  }),
  Schema.Struct({
    action: Schema.Literals(["pause", "resume", "sync", "retry", "remove"]),
    ...registration,
  }),
  Schema.Struct({
    action: Schema.Literal("setPolicy"),
    ...registration,
    policy: Schema.NullOr(TelegramChannelCliPolicy),
  }),
]);
export type TelegramChannelsManageInput = typeof TelegramChannelsManageInput.Type;

export const TelegramChannelRegistration = Schema.Struct({
  registrationId: registration.registrationId,
  channel: TrimmedNonEmptyString,
  phase: Schema.Literals(["queued", "backfill", "incremental", "paused", "partial", "error"]),
  /** Last message ID fetched, including pages awaiting local processing. */
  readThroughId: Schema.optionalKey(NonNegativeInt),
  /** Messages already fetched, including pages waiting for summarization. */
  fetchedCount: Schema.optionalKey(NonNegativeInt),
  processedCount: NonNegativeInt,
  totalCount: Schema.optionalKey(NonNegativeInt),
  missingTextCount: NonNegativeInt,
  unavailableCount: NonNegativeInt,
  lastSyncedAt: Schema.optionalKey(IsoDateTime),
  error: Schema.optionalKey(TrimmedNonEmptyString),
  sourceDocumentIds: Schema.Array(WorkspaceKnowledgeItemId),
  policy: Schema.NullOr(TelegramChannelCliPolicy),
});
export type TelegramChannelRegistration = typeof TelegramChannelRegistration.Type;

export const TelegramChannelsStatusResult = Schema.Struct({
  registrations: Schema.Array(TelegramChannelRegistration),
  /** Present only after an explicit exact-title lookup. */
  matches: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        registrationId: TelegramMarkedChannelId,
        title: TelegramChannelLookupTitle,
      }),
    ),
  ),
  /** Exact models on registered CLI accounts that can generate tool-free summaries. */
  cliModels: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      accountLabel: TrimmedNonEmptyString,
      modelId: TrimmedNonEmptyString,
    }),
  ),
  unsupportedCli: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        instanceId: ProviderInstanceId,
        accountLabel: TrimmedNonEmptyString,
        driver: TrimmedNonEmptyString,
        reason: TrimmedNonEmptyString,
      }),
    ),
  ),
});
export type TelegramChannelsStatusResult = typeof TelegramChannelsStatusResult.Type;

export class TelegramChannelsError extends Schema.TaggedErrorClass<TelegramChannelsError>()(
  "TelegramChannelsError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
