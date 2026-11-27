import { readPdfPages, type PdfPageResult } from "./pdfPageReader.ts";

export interface PdfPageBatch {
  readonly firstPage: number;
  readonly lastPage: number;
  readonly totalPages: number;
  readonly pages: readonly PdfPageResult[];
}

/**
 * A caller commits each batch before asking for the next. A committed lastPage
 * can be used as the restart checkpoint; failed or empty pages remain explicit.
 */
export async function* readPdfPageBatches(input: {
  readonly bytes: Uint8Array;
  readonly fromPage?: number;
  readonly signal?: AbortSignal;
  readonly ocrCacheDirectory?: string;
  readonly maxBatchPages?: number;
  readonly maxBatchChars?: number;
}): AsyncGenerator<PdfPageBatch> {
  const maxPages = input.maxBatchPages ?? 64;
  const maxChars = input.maxBatchChars ?? 250_000;
  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 1
  )
    throw new RangeError("PDF 묶음 크기가 올바르지 않습니다.");
  let nextPage = input.fromPage ?? 1;
  while (true) {
    const pages: PdfPageResult[] = [];
    let chars = 0;
    for await (const page of readPdfPages({
      ...input,
      fromPage: nextPage,
      toPage: nextPage + maxPages - 1,
    })) {
      if (pages.length && chars + page.text.length > maxChars) break;
      pages.push(page);
      chars += page.text.length;
      nextPage = page.page + 1;
    }
    if (!pages.length) return;
    const last = pages.at(-1)!;
    yield { firstPage: pages[0]!.page, lastPage: last.page, totalPages: last.totalPages, pages };
    if (nextPage > last.totalPages) return;
  }
}
