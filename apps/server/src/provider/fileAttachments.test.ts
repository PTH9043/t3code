import { describe, expect, it } from "vite-plus/test";
import { prepareFileAttachmentsForProvider } from "./fileAttachments.ts";

describe("prepareFileAttachmentsForProvider", () => {
  it("allows a document-only turn and keeps an original filename separate from its safe stored path", () => {
    const prepared = prepareFileAttachmentsForProvider({
      text: undefined,
      attachmentsDir: ".t3/attachments",
      attachments: [
        {
          type: "file",
          id: "thread-attachment",
          name: "../회의 자료.docx",
          mimeType: "application/octet-stream",
          sizeBytes: 20,
        },
      ],
    });
    expect(prepared.text).toContain('Original filename: "../회의 자료.docx"');
    expect(prepared.text).toContain("thread-attachment.bin");
    expect(prepared.attachments).toEqual([]);
  });

  it("leaves existing image-only turns unchanged", () => {
    const images = [
      {
        type: "image" as const,
        id: "image-id",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 20,
      },
    ];
    expect(
      prepareFileAttachmentsForProvider({
        text: "Look",
        attachments: images,
        attachmentsDir: ".t3/attachments",
      }),
    ).toEqual({ text: "Look", attachments: images });
  });
});
