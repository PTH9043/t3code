import type { ChatAttachment } from "@t3tools/contracts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

/** File contents stay on the host; provider image protocols receive only images. */
export function prepareFileAttachmentsForProvider(input: {
  readonly text: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly attachmentsDir: string;
  readonly extractedDocuments?: ReadonlyMap<
    string,
    { readonly path: string; readonly partial: boolean }
  >;
}) {
  const files = input.attachments.filter((attachment) => attachment.type === "file");
  if (files.length === 0) {
    return { text: input.text, attachments: input.attachments };
  }
  const references = files.map((attachment) => {
    const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
    if (!path) throw new Error(`Invalid file attachment id '${attachment.id}'.`);
    const extracted = input.extractedDocuments?.get(attachment.id);
    return `- Original filename: ${JSON.stringify(attachment.name)}\n  Server path: ${JSON.stringify(path)}\n  MIME type: ${attachment.mimeType}; size: ${attachment.sizeBytes} bytes${extracted ? `\n  Extracted text: ${JSON.stringify(extracted.path)}${extracted.partial ? " (partial; consult the original for omitted content)" : ""}` : ""}`;
  });
  return {
    text: [
      input.text,
      "[User-attached files]\nThe following original files have been uploaded to this server. Use the retrieved excerpts or extracted text when they contain the evidence needed for the question. Read additional ranges with your file tools when evidence is missing; consult the original for formatting, omitted content, or exact calculations. Cite the original filename and source location. The stored .bin extension does not change the original format; use the original filename and MIME type to choose appropriate readers for text, PDF, Office documents, spreadsheets, and other formats.",
      ...references,
    ]
      .filter(Boolean)
      .join("\n\n"),
    attachments: input.attachments.filter((attachment) => attachment.type === "image"),
  };
}
