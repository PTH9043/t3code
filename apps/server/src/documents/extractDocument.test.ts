import { expect, it } from "vite-plus/test";
import { strToU8, zipSync } from "fflate";
import { docxFixture, pdfFixture, xlsxFixture } from "./documentFixtures.ts";
import {
  chunkAttachmentDocument,
  documentKnowledgeContent,
  extractDocument,
} from "./extractDocument.ts";

it("extracts PDF text with actual page references", async () => {
  const result = await extractDocument({
    bytes: pdfFixture(),
    name: "guide.pdf",
    mimeType: "application/pdf",
  });
  expect(result.status).toBe("indexed");
  expect(result.sections[0]?.text).toContain("7329");
  expect(result.sections[1]).toMatchObject({ location: "페이지 2" });
  expect(result.sections[1]?.text).toContain("23 days");
});
it("extracts Korean Word paragraphs and spreadsheet cell coordinates with cached formula results", async () => {
  const word = await extractDocument({
    bytes: docxFixture(),
    name: "계약.docx",
    mimeType: "application/octet-stream",
  });
  expect(word.sections[0]?.text).toContain("해지 기간은 17일");
  expect(word.sections[0]?.location).toContain("문단 1");
  const sheet = await extractDocument({
    bytes: xlsxFixture(),
    name: "매출.xlsx",
    mimeType: "application/octet-stream",
  });
  expect(sheet.sections[0]?.location).toContain('시트 "매출" · 행 7');
  expect(sheet.sections[0]?.text).toContain('A7="해오름"');
  expect(sheet.sections[0]?.text).toContain('C7="762"');
  expect(sheet.sections[0]?.text).toContain("저장된 결과");
});
it("preserves UTF-16 text and line references, and marks large extraction as partial", async () => {
  const bytes = Buffer.concat([
    Buffer.from([255, 254]),
    Buffer.from("산들 배송 기간은 9일\r\n고객은 27명", "utf16le"),
  ]);
  const result = await extractDocument({ bytes, name: "memo.txt", mimeType: "text/plain" });
  expect(result.sections[0]?.text).toContain("배송 기간은 9일");
  expect(result.sections[0]?.location).toBe("행 1–2");
  const large = await extractDocument({
    bytes: strToU8("x".repeat(600_000)),
    name: "large.txt",
    mimeType: "text/plain",
  });
  expect(large.status).toBe("partial");
  expect(large.chars).toBe(500_000);
});
it("rejects malformed office data, external XML declarations, and unsupported binary formats explicitly", async () => {
  await expect(
    extractDocument({
      bytes: new Uint8Array([0, 1]),
      name: "broken.docx",
      mimeType: "application/octet-stream",
    }),
  ).rejects.toThrow();
  const bytes = zipSync({
    "word/document.xml": strToU8(
      '<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///secret">]><doc>&x;</doc>',
    ),
  });
  await expect(
    extractDocument({ bytes, name: "external.docx", mimeType: "application/octet-stream" }),
  ).rejects.toThrow("외부 선언");
  expect(
    (
      await extractDocument({
        bytes: new Uint8Array([0, 1]),
        name: "old.xls",
        mimeType: "application/octet-stream",
      })
    ).status,
  ).toBe("unsupported");
});
it("retains the source location in every chunk of long paragraphs", () => {
  const document = documentKnowledgeContent([{ location: "페이지 9", text: "한빛".repeat(4000) }]);
  const chunks = chunkAttachmentDocument(document.content, document.locations);
  expect(chunks.length).toBeGreaterThan(3);
  expect(chunks.every((chunk) => chunk.startsWith("[페이지 9]\n"))).toBe(true);
});
