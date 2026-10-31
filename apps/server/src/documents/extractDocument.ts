// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { unzipSync } from "fflate";
import { createPdfOcr } from "./localOcr.ts";

export const DOCUMENT_PARSER_VERSION = "2";
export const DOCUMENT_MAX_CHARS = 500_000;
export const DOCUMENT_MAX_SECTIONS = 256;
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_PDF_PAGES = 200;
export interface DocumentSection {
  readonly location: string;
  readonly text: string;
}
export interface ExtractedDocument {
  readonly status: "indexed" | "partial" | "empty" | "unsupported";
  readonly sections: readonly DocumentSection[];
  readonly chars: number;
  readonly message: string | null;
}

function sectionCollector() {
  const sections: DocumentSection[] = [];
  let chars = 0;
  let partial = false;
  return {
    add(location: string, text: string) {
      if (!text.trim()) return;
      const remaining = DOCUMENT_MAX_CHARS - chars;
      if (remaining <= 0 || sections.length >= DOCUMENT_MAX_SECTIONS) {
        partial = true;
        return;
      }
      const kept = text.slice(0, remaining);
      partial ||= kept.length < text.length;
      sections.push({ location, text: kept });
      chars += kept.length;
    },
    full: () => chars >= DOCUMENT_MAX_CHARS || sections.length >= DOCUMENT_MAX_SECTIONS,
    finish(incomplete = false): ExtractedDocument {
      const status = chars === 0 ? "empty" : partial || incomplete ? "partial" : "indexed";
      return {
        status,
        sections,
        chars,
        message:
          status === "partial"
            ? "추출 상한으로 일부만 색인했습니다. 전체 내용은 첨부 원본에서 확인하세요."
            : status === "empty"
              ? "검색할 텍스트가 없습니다. 스캔 문서는 원본 확인이나 OCR이 필요합니다."
              : null,
      };
    },
  };
}

function decodeText(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new NodeUtil.TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new NodeUtil.TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  return new NodeUtil.TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function xml(bytes: Uint8Array | undefined) {
  if (!bytes) throw new Error("문서에 필요한 XML 항목이 없습니다.");
  const text = decodeText(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error("외부 선언을 포함한 문서는 색인하지 않습니다.");
  return new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") throw new Error(message);
    },
  }).parseFromString(text, "application/xml");
}
function elements(node: Document | Element, name: string) {
  return Array.from(node.getElementsByTagNameNS("*", name));
}
function officeArchive(bytes: Uint8Array, names: (name: string) => boolean) {
  let expanded = 0;
  let entries = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      if (++entries > 4096) throw new Error("문서 내부 항목 수가 추출 상한을 초과합니다.");
      if (!names(file.name)) return false;
      expanded += file.originalSize;
      if (file.originalSize > MAX_XML_BYTES || expanded > MAX_ARCHIVE_BYTES)
        throw new Error("문서의 압축 해제 크기가 추출 상한을 초과합니다.");
      return true;
    },
  });
}

/** Extract text without executing document scripts, macros, or spreadsheet formulas. */
export async function extractDocument(input: {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly mimeType: string;
  readonly ocr?: { readonly cacheDirectory: string; readonly signal?: AbortSignal };
}): Promise<ExtractedDocument> {
  const extension = NodePath.extname(input.name).toLowerCase();
  const collector = sectionCollector();
  if (extension === ".pdf" || input.mimeType === "application/pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Bundle the worker with the server too; Node uses PDF.js's main-thread handler.
    Object.assign(globalThis, {
      pdfjsWorker: await import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    });
    const loading = pdfjs.getDocument({
      data: new Uint8Array(input.bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    });
    const ocr = input.ocr ? createPdfOcr(input.ocr.cacheDirectory, input.ocr.signal) : null;
    let ocrPages = 0;
    let ocrIncomplete = false;
    let lowConfidence = false;
    try {
      const document = await loading.promise;
      for (
        let pageNumber = 1;
        pageNumber <= Math.min(document.numPages, MAX_PDF_PAGES);
        pageNumber++
      ) {
        const page = await document.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          const text = content.items
            .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
            .join("");
          if (ocr && text.replace(/\s/g, "").length < 12) {
            if (ocrPages >= 12) {
              ocrIncomplete = true;
              collector.add(`페이지 ${pageNumber}`, text);
            } else {
              ocrPages++;
              try {
                const { createCanvas } = await import("@napi-rs/canvas");
                const original = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({
                  scale: Math.min(2, 2000 / Math.max(original.width, original.height)),
                });
                const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                try {
                  await page.render({
                    viewport,
                    canvas: canvas as unknown as Parameters<typeof page.render>[0]["canvas"],
                    canvasContext: canvas.getContext("2d") as unknown as Parameters<
                      typeof page.render
                    >[0]["canvasContext"],
                  }).promise;
                  const result = await ocr.recognize(canvas.toBuffer("image/png"));
                  lowConfidence ||= result.confidence < 70;
                  collector.add(`페이지 ${pageNumber} · OCR`, result.text || text);
                } finally {
                  canvas.width = 1;
                  canvas.height = 1;
                }
              } catch {
                ocrIncomplete = true;
                collector.add(`페이지 ${pageNumber}`, text);
              }
            }
          } else collector.add(`페이지 ${pageNumber}`, text);
        } finally {
          page.cleanup();
        }
        if (collector.full()) return collector.finish(pageNumber < document.numPages);
      }
      const result = collector.finish(document.numPages > MAX_PDF_PAGES || ocrIncomplete);
      return ocrPages
        ? {
            ...result,
            message: [
              result.message,
              ocrIncomplete
                ? "일부 페이지 OCR을 완료하지 못했습니다. OCR은 문서당 최대 12페이지입니다."
                : null,
              lowConfidence
                ? "일부 OCR의 인식 신뢰도가 낮습니다. 숫자와 표는 원본을 확인하세요."
                : null,
              "스캔 페이지를 로컬 OCR로 추출했습니다.",
            ]
              .filter(Boolean)
              .join(" "),
          }
        : result;
    } finally {
      await ocr?.close();
      await loading.destroy();
    }
  }
  if (extension === ".docx") {
    const archive = officeArchive(input.bytes, (name) => name === "word/document.xml");
    const paragraphs = elements(xml(archive["word/document.xml"]), "p");
    let block = "";
    let firstParagraph = 1;
    for (let index = 0; index < paragraphs.length; index++) {
      const paragraph = paragraphs[index]!;
      block += `${elements(paragraph, "t")
        .map((node) => node.textContent ?? "")
        .join("")}\n`;
      if (block.length >= 2400 || index === paragraphs.length - 1) {
        collector.add(`문단 ${firstParagraph}–${index + 1}`, block);
        block = "";
        firstParagraph = index + 2;
      }
      if (collector.full()) return collector.finish(index + 1 < paragraphs.length);
    }
    return collector.finish();
  }
  if (extension === ".xlsx") {
    const archive = officeArchive(
      input.bytes,
      (name) =>
        ["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml"].includes(name) ||
        /^xl\/worksheets\/[^/]+\.xml$/.test(name),
    );
    const strings = archive["xl/sharedStrings.xml"]
      ? elements(xml(archive["xl/sharedStrings.xml"]), "si").map((node) =>
          elements(node, "t")
            .map((text) => text.textContent ?? "")
            .join(""),
        )
      : [];
    const relationships = new Map(
      elements(xml(archive["xl/_rels/workbook.xml.rels"]), "Relationship")
        .filter((node) => node.getAttribute("TargetMode") !== "External")
        .map((node) => [node.getAttribute("Id"), node.getAttribute("Target") ?? ""]),
    );
    const sheets = elements(xml(archive["xl/workbook.xml"]), "sheet");
    for (const sheet of sheets) {
      const relationId = sheet.getAttributeNS(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "id",
      );
      const target = relationships.get(relationId) ?? "";
      const filename = NodePath.posix.normalize(
        target.startsWith("/") ? target.slice(1) : `xl/${target}`,
      );
      if (!/^xl\/worksheets\/[^/]+\.xml$/.test(filename))
        throw new Error("지원하지 않는 시트 경로입니다.");
      const rows = elements(xml(archive[filename]), "row");
      let block = "";
      let firstRow = rows[0]?.getAttribute("r") ?? "?";
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const values = elements(row, "c")
          .map((cell) => {
            const value = elements(cell, "v")[0]?.textContent ?? "";
            const type = cell.getAttribute("t");
            const text =
              type === "s"
                ? (strings[Number(value)] ?? "")
                : type === "inlineStr"
                  ? elements(cell, "t")
                      .map((node) => node.textContent ?? "")
                      .join("")
                  : value;
            const formula = elements(cell, "f")[0]?.textContent;
            return `${cell.getAttribute("r") ?? "셀"}=${JSON.stringify(text)}${formula ? ` (수식 ${JSON.stringify(formula)}, 저장된 결과)` : ""}`;
          })
          .join(" · ");
        block += `${values}\n`;
        if (block.length >= 2400 || index === rows.length - 1) {
          collector.add(
            `시트 ${JSON.stringify(sheet.getAttribute("name") ?? "")} · 행 ${firstRow}–${row.getAttribute("r") ?? "?"}`,
            block,
          );
          block = "";
          firstRow = rows[index + 1]?.getAttribute("r") ?? "?";
        }
        if (collector.full()) return collector.finish(true);
      }
    }
    return collector.finish();
  }
  if (
    input.mimeType.startsWith("text/") ||
    [
      ".txt",
      ".md",
      ".csv",
      ".tsv",
      ".json",
      ".jsonl",
      ".xml",
      ".html",
      ".log",
      ".yaml",
      ".yml",
      ".js",
      ".ts",
      ".py",
    ].includes(extension)
  ) {
    const text = decodeText(input.bytes);
    if (text.includes("\0")) throw new Error("텍스트로 해석할 수 없는 데이터입니다.");
    const lines = text.replaceAll("\r\n", "\n").split("\n");
    let block = "";
    let firstLine = 1;
    for (let index = 0; index < lines.length; index++) {
      block += `${lines[index]}\n`;
      if (block.length >= 2400 || index === lines.length - 1) {
        collector.add(`행 ${firstLine}–${index + 1}`, block);
        block = "";
        firstLine = index + 2;
        if (collector.full()) return collector.finish(index + 1 < lines.length);
      }
    }
    return collector.finish();
  }
  return {
    status: "unsupported",
    sections: [],
    chars: 0,
    message: "이 형식은 자동 텍스트 추출을 지원하지 않습니다. 첨부 원본을 확인하세요.",
  };
}

export function documentKnowledgeContent(sections: readonly DocumentSection[]) {
  let content = "";
  const locations: { start: number; end: number; label: string }[] = [];
  for (const section of sections) {
    const start = content.length;
    content += `[${section.location}]\n${section.text}\n\n`;
    locations.push({ start, end: content.length, label: section.location });
  }
  return { content, locations };
}

/** Repeat source location in every retrieval chunk, including long paragraphs. */
export function chunkAttachmentDocument(
  content: string,
  locations: readonly { start: number; end: number; label: string }[],
) {
  return locations.flatMap((location) => {
    const text = content.slice(location.start, location.end);
    const chunks: string[] = [];
    for (let offset = 0; offset < text.length; offset += 2200)
      chunks.push(`[${location.label}]\n${text.slice(offset, offset + 2400)}`);
    return chunks;
  });
}
