// @effect-diagnostics nodeBuiltinImport:off
import { createPdfOcr } from "./localOcr.ts";
import { acquirePdfDocument } from "./pdfDocumentLock.ts";

export type PdfPageResult = {
  readonly page: number;
  readonly totalPages: number;
  readonly text: string;
  readonly status: "text" | "ocr" | "empty" | "failed";
  readonly message?: string;
  readonly contentType?: "text" | "scan" | "blank" | "visual" | "mixed" | "unknown";
  readonly hasTable?: boolean;
  readonly visualReviewRequired?: boolean;
};

/** Read pages one at a time so callers can checkpoint storage between pages. */
export async function* readPdfPages(input: {
  readonly bytes: Uint8Array;
  readonly fromPage?: number;
  readonly toPage?: number;
  readonly signal?: AbortSignal;
  readonly ocrCacheDirectory?: string;
}): AsyncGenerator<PdfPageResult> {
  const release = await acquirePdfDocument(input.signal);
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    Object.assign(globalThis, {
      pdfjsWorker: await import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    });
    const loading = pdfjs.getDocument({
      data: new Uint8Array(input.bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      // 0 = errors only. Font-program notices ("TT: undefined function") are
      // harmless for text extraction and only add noise to the server log.
      verbosity: 0,
    });
    const ocr = input.ocrCacheDirectory
      ? createPdfOcr(input.ocrCacheDirectory, input.signal)
      : null;
    try {
      const document = await loading.promise;
      const start = input.fromPage ?? 1;
      if (!Number.isSafeInteger(start) || start < 1 || start > document.numPages + 1)
        throw new RangeError("PDF 시작 페이지가 올바르지 않습니다.");
      const end = input.toPage ?? document.numPages;
      if (!Number.isSafeInteger(end) || end < start)
        throw new RangeError("PDF 종료 페이지가 올바르지 않습니다.");
      for (let pageNumber = start; pageNumber <= Math.min(end, document.numPages); pageNumber++) {
        input.signal?.throwIfAborted();
        let page: Awaited<ReturnType<typeof document.getPage>> | undefined;
        let result: PdfPageResult;
        let extractedText = "";
        try {
          page = await document.getPage(pageNumber);
          const content = await page.getTextContent();
          let text = content.items
            .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
            .join("");
          extractedText = text;
          const positions = content.items.filter(
            (item) => "str" in item && item.str.trim().length > 0 && "transform" in item,
          );
          const rows = new Map<number, Array<{ x: number; width: number }>>();
          for (const item of positions) {
            if (!("transform" in item) || !("width" in item)) continue;
            const y = Math.round(item.transform[5]! / 4);
            const row = rows.get(y) ?? [];
            row.push({ x: item.transform[4]!, width: item.width });
            rows.set(y, row);
          }
          const tableRows = [...rows.values()].filter((row) => {
            row.sort((a, b) => a.x - b.x);
            return row.some(
              (cell, index) =>
                index > 0 && cell.x - (row[index - 1]!.x + row[index - 1]!.width) > 20,
            );
          }).length;
          const hasTable = tableRows >= 2;
          const operators = await page.getOperatorList();
          const opNames = [
            "paintImageXObject",
            "paintInlineImageXObject",
            "paintImageMaskXObject",
            "paintImageXObjectRepeat",
            "paintInlineImageXObjectGroup",
            "paintImageMaskXObjectGroup",
            "paintImageMaskXObjectRepeat",
            "paintJpegXObject",
            "paintSolidColorImageMask",
          ] as const;
          const imageOps = new Set(
            opNames
              .map((name) => (pdfjs.OPS as Record<string, number>)[name])
              .filter((value) => value !== undefined),
          );
          const vectorOps = new Set([
            pdfjs.OPS.stroke,
            pdfjs.OPS.closeStroke,
            pdfjs.OPS.fill,
            pdfjs.OPS.eoFill,
            pdfjs.OPS.fillStroke,
            pdfjs.OPS.eoFillStroke,
            pdfjs.OPS.closeFillStroke,
            pdfjs.OPS.closeEOFillStroke,
          ]);
          const hasImage = operators.fnArray.some((op) => imageOps.has(op));
          const hasVector = operators.fnArray.some((op) => vectorOps.has(op));
          const annotations = await page.getAnnotations();
          const hasVisual = hasImage || hasVector || annotations.length > 0;
          const hasText = text.trim().length > 0;
          const contentType: NonNullable<PdfPageResult["contentType"]> = hasText
            ? hasVisual
              ? "mixed"
              : "text"
            : hasImage
              ? "scan"
              : hasVisual
                ? "visual"
                : "blank";
          let status: PdfPageResult["status"] = hasText ? "text" : "empty";
          const notes: string[] = [];
          if (!hasText && hasImage && !ocr)
            notes.push("스캔 이미지 페이지입니다. OCR이 꺼져 있어 내용을 읽지 못했습니다.");
          if (!hasText && hasVisual && !hasImage)
            notes.push(
              "그림 또는 주석이 있는 페이지입니다. 시각 내용은 텍스트 추출로 확인하지 못했습니다.",
            );
          if (hasImage && ocr && text.replace(/\s/g, "").length < 12) {
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
              const recognized = await ocr.recognize(canvas.toBuffer("image/png"));
              text = recognized.text || text;
              status = text.trim() ? "ocr" : "empty";
              if (recognized.confidence < 70)
                notes.push("OCR 신뢰도가 낮습니다. 원본 페이지를 확인하세요.");
              if (!text.trim())
                notes.push("OCR에서 텍스트를 찾지 못했습니다. 원본 페이지를 확인하세요.");
            } finally {
              canvas.width = 1;
              canvas.height = 1;
            }
          }
          if (hasVisual && (hasText || status === "ocr"))
            notes.push("이미지·그림·주석의 시각 정보는 별도 확인이 필요합니다.");
          if (hasTable) notes.push("표로 보이는 배열이 있어 열과 값은 원본을 확인하세요.");
          const message = notes.length ? notes.join(" ") : undefined;
          result = {
            page: pageNumber,
            totalPages: document.numPages,
            text,
            status,
            contentType,
            hasTable,
            visualReviewRequired: (hasVisual && contentType !== "blank") || hasTable,
            ...(message ? { message } : {}),
          };
        } catch (error) {
          input.signal?.throwIfAborted();
          result = {
            page: pageNumber,
            totalPages: document.numPages,
            text: extractedText,
            status: "failed",
            message: error instanceof Error ? error.message : "페이지 추출에 실패했습니다.",
          };
        } finally {
          page?.cleanup();
        }
        yield result;
      }
    } finally {
      try {
        await ocr?.close();
      } finally {
        await loading.destroy();
      }
    }
  } finally {
    release();
  }
}
