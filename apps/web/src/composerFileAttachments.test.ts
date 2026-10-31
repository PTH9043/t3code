import { describe, expect, it } from "vite-plus/test";
import { hydrateImagesFromPersisted } from "./composerDraftStore";

describe("persisted composer file attachments", () => {
  it("restores mixed documents and legacy images without turning documents into image previews", async () => {
    const attachments = hydrateImagesFromPersisted([
      {
        type: "file",
        id: "document",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        dataUrl: "data:text/plain;base64,aGVsbG8=",
      },
      {
        id: "legacy-image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 4,
        dataUrl: "data:image/png;base64,iVBORw==",
      },
    ]);
    expect(attachments.map((attachment) => attachment.type)).toEqual(["file", "image"]);
    expect(attachments[0]?.previewUrl).toBe("");
    expect(await attachments[0]?.file.text()).toBe("hello");
    expect(attachments[0]?.file.name).toBe("notes.txt");
    expect(attachments[1]?.previewUrl).toBe("data:image/png;base64,iVBORw==");
  });
});
