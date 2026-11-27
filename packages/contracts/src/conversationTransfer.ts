import * as Schema from "effect/Schema";
import { EventId, MessageId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import type { OrchestrationMessage, OrchestrationThreadActivity } from "./orchestration.ts";

export const ConversationSourceFormat = Schema.Literals(["codex", "claude", "grok", "t3"]);
export type ConversationSourceFormat = typeof ConversationSourceFormat.Type;
export const ImportedConversation = Schema.Struct({
  format: ConversationSourceFormat,
  sourceHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sourceSessionId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant", "system"]),
      text: Schema.String.check(Schema.isMaxLength(200_000)),
      createdAt: Schema.NullOr(Schema.String),
    }),
  ).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1000),
    Schema.makeFilter(
      (messages) => messages.reduce((sum, item) => sum + item.text.length, 0) <= 2_000_000,
    ),
  ),
});
export type ImportedConversation = typeof ImportedConversation.Type;
export function importedConversationMessages(
  threadId: ThreadId,
  imported: ImportedConversation,
  createdAt: string,
): OrchestrationMessage[] {
  return imported.messages.map((message, index) => ({
    ...message,
    id: MessageId.make(`import:${threadId}:${index}`),
    createdAt: message.createdAt ?? createdAt,
    updatedAt: message.createdAt ?? createdAt,
    turnId: null,
    streaming: false,
  }));
}
export function importedConversationActivity(
  threadId: ThreadId,
  imported: ImportedConversation,
  createdAt: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`import:${threadId}`),
    kind: "conversation.imported",
    tone: "info",
    summary: `${imported.format} 대화 ${imported.messages.length}개 가져옴`,
    payload: {
      format: imported.format,
      sourceHash: imported.sourceHash,
      sourceSessionId: imported.sourceSessionId,
      messageCount: imported.messages.length,
    },
    turnId: null,
    createdAt,
  };
}
export class ConversationTransferError extends Schema.TaggedErrorClass<ConversationTransferError>()(
  "ConversationTransferError",
  { message: Schema.String },
) {}

export const ConversationPreviewInput = Schema.Struct({
  format: ConversationSourceFormat,
  content: Schema.String.check(Schema.isMaxLength(8_000_000)),
});
export const ConversationPreview = Schema.Struct({
  format: ConversationSourceFormat,
  sourceHash: Schema.String,
  sourceSessionId: Schema.NullOr(Schema.String),
  messageCount: Schema.Number,
  sample: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
});
export type ConversationPreview = typeof ConversationPreview.Type;
export const ConversationImportInput = Schema.Struct({
  ...ConversationPreviewInput.fields,
  projectId: ProjectId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(180)),
  modelSelection: Schema.suspend(() => ModelSelection),
});
export const ConversationExportScope = Schema.Literals(["all", "user_only", "ai_only"]);
export type ConversationExportScope = typeof ConversationExportScope.Type;
export const ConversationExportFileFormat = Schema.Literals(["json", "markdown"]);
export type ConversationExportFileFormat = typeof ConversationExportFileFormat.Type;
export const ConversationExportInput = Schema.Struct({
  threadId: ThreadId,
  original: Schema.optionalKey(Schema.Boolean),
  scope: Schema.optionalKey(ConversationExportScope),
  outputFormat: Schema.optionalKey(ConversationExportFileFormat),
});
export const ConversationExport = Schema.Struct({
  fileName: Schema.String,
  content: Schema.String,
  format: Schema.String,
});
