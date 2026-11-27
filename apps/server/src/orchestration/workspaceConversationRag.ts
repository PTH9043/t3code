import * as NodeCrypto from "node:crypto";

import {
  WorkspaceKnowledgeItemId,
  type ChatAttachment,
  type IsoDateTime,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
  type WorkspaceConversationRagSettings,
  type WorkspaceKnowledgeActor,
  type WorkspaceKnowledgeItem,
} from "@t3tools/contracts";
import { redactMemorySensitiveData } from "./memoryPrivacyGuard.ts";

const AUTO_CONVERSATION_TAG = "auto-conversation";
const COMPACTION_MARKER = "[…중간의 반복·초과 내용은 원본 대화에 보존됨…]";

export interface ConversationRagCompaction {
  readonly content: string;
  readonly originalChars: number;
  readonly compactedChars: number;
  readonly duplicateBlocksRemoved: number;
  readonly redactionCount: number;
  readonly truncated: boolean;
  readonly contentHash: string;
}

function digest(value: string, length: number): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function redactConversationRagSensitiveData(input: string): {
  readonly content: string;
  readonly redactionCount: number;
} {
  return redactMemorySensitiveData(input);
}

function normalizeConversationInput(input: string): string {
  return input
    .replaceAll("\r\n", "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line) => !/^\s*(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+|\[\s*[=#>-]{4,}\s*\]\s*\d+%)\s*$/u.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function deduplicateBlocks(input: string): {
  readonly content: string;
  readonly duplicateBlocksRemoved: number;
} {
  const seen = new Set<string>();
  const kept: string[] = [];
  let duplicateBlocksRemoved = 0;
  for (const block of input.split(/\n{2,}/)) {
    const normalized = block.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) {
      duplicateBlocksRemoved += 1;
      continue;
    }
    seen.add(normalized);
    kept.push(block.trim());
  }
  return { content: kept.join("\n\n"), duplicateBlocksRemoved };
}

function boundCompactedContent(
  content: string,
  maxInputChars: number,
): {
  readonly content: string;
  readonly truncated: boolean;
} {
  if (content.length <= maxInputChars) return { content, truncated: false };
  const available = Math.max(0, maxInputChars - COMPACTION_MARKER.length - 4);
  const headLength = Math.ceil(available * 0.65);
  const tailLength = Math.max(0, available - headLength);
  return {
    content: `${content.slice(0, headLength).trimEnd()}\n\n${COMPACTION_MARKER}\n\n${content
      .slice(content.length - tailLength)
      .trimStart()}`,
    truncated: true,
  };
}

/**
 * Compaction limits without the conversation-specific setting names, so agent
 * output capture reuses the same normalize → redact → deduplicate → bound
 * pipeline instead of growing a second implementation that drifts from it.
 */
export interface KnowledgeCompactionLimits {
  readonly redactSensitiveData: boolean;
  readonly maxChars: number;
}

export function compactKnowledgeContent(
  input: string,
  limits: KnowledgeCompactionLimits,
): ConversationRagCompaction | null {
  const originalChars = input.length;
  const normalized = normalizeConversationInput(input);
  if (normalized.length === 0) return null;
  const redacted = limits.redactSensitiveData
    ? redactConversationRagSensitiveData(normalized)
    : { content: normalized, redactionCount: 0 };
  const deduplicated = deduplicateBlocks(redacted.content);
  const bounded = boundCompactedContent(deduplicated.content, limits.maxChars);
  if (bounded.content.length === 0) return null;
  return {
    content: bounded.content,
    originalChars,
    compactedChars: bounded.content.length,
    duplicateBlocksRemoved: deduplicated.duplicateBlocksRemoved,
    redactionCount: redacted.redactionCount,
    truncated: bounded.truncated,
    contentHash: digest(bounded.content, 32),
  };
}

export function knowledgeContentDigest(value: string, length: number): string {
  return digest(value, length);
}

export function compactConversationRagInput(
  input: string,
  settings: WorkspaceConversationRagSettings,
): ConversationRagCompaction | null {
  return compactKnowledgeContent(input, {
    redactSensitiveData: settings.redactSensitiveData,
    maxChars: settings.maxInputChars,
  });
}

function attachmentContext(attachments: ReadonlyArray<ChatAttachment>): string {
  if (attachments.length === 0) return "";
  return attachments
    .map(
      (attachment) =>
        `[첨부 이미지: ${attachment.name} · ${attachment.mimeType} · ${attachment.sizeBytes}바이트]`,
    )
    .join("\n");
}

export function conversationRagThreadItemPrefix(threadId: ThreadId): string {
  return `conversation-${digest(threadId, 16)}-`;
}

export function conversationRagItemId(input: {
  readonly threadId: ThreadId;
  readonly contentHash: string;
}): WorkspaceKnowledgeItemId {
  return WorkspaceKnowledgeItemId.make(
    `${conversationRagThreadItemPrefix(input.threadId)}${input.contentHash}`,
  );
}

export function toConversationRagKnowledgeItem(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly sourceId: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly createdAt: IsoDateTime;
  readonly settings: WorkspaceConversationRagSettings;
  readonly relativeFolder?: string | null;
  readonly actor?: WorkspaceKnowledgeActor | null;
  readonly confidence?: "high" | "medium" | "low";
  readonly modelSelection?: ModelSelection | null;
}): WorkspaceKnowledgeItem | null {
  if (!input.settings.enabled) return null;
  const attachments = attachmentContext(input.attachments);
  const source = [input.text, attachments].filter((part) => part.trim().length > 0).join("\n\n");
  const compacted = compactConversationRagInput(source, input.settings);
  if (compacted === null) return null;
  const threadTitle =
    input.threadTitle.replace(/\s+/g, " ").trim().slice(0, 100) || "제목 없는 대화";
  return {
    id: conversationRagItemId({
      threadId: input.threadId,
      contentHash: compacted.contentHash,
    }),
    projectId: input.projectId,
    kind: "rag-source",
    title: `대화 입력 · ${threadTitle}`,
    provenance: {
      threadId: input.threadId,
      actor: input.actor ?? "user",
      confidence: input.confidence ?? "medium",
      ...(input.modelSelection
        ? {
            modelSelection: {
              instanceId: input.modelSelection.instanceId,
              model: input.modelSelection.model,
            },
          }
        : {}),
    },
    content: compacted.content,
    status: "active",
    origin: "user",
    relativeFolder: input.relativeFolder ?? null,
    tags: [
      AUTO_CONVERSATION_TAG,
      "compacted",
      `thread-${digest(input.threadId, 16)}`,
      `source-${digest(input.sourceId, 16)}`,
      `original-chars-${compacted.originalChars}`,
      `stored-chars-${compacted.compactedChars}`,
      ...(compacted.redactionCount > 0 ? [`redacted-${compacted.redactionCount}`] : []),
      ...(compacted.duplicateBlocksRemoved > 0
        ? [`deduplicated-${compacted.duplicateBlocksRemoved}`]
        : []),
      ...(compacted.truncated ? ["bounded"] : []),
    ],
    originalChars: compacted.originalChars,
    storedChars: compacted.compactedChars,
    promptUses: 0,
    lastUsedAt: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function isAutomaticConversationRagItem(item: WorkspaceKnowledgeItem): boolean {
  return item.kind === "rag-source" && item.tags.includes(AUTO_CONVERSATION_TAG);
}
