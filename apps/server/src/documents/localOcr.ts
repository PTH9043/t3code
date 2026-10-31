// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeHttps from "node:https";
import { createWorker, PSM, type Worker, type Page } from "tesseract.js";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const LANGUAGE_HASHES = {
  eng: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
  kor: "6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2",
};
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const downloadLanguage = (language: string, signal: AbortSignal) =>
  new Promise<Buffer>((resolve, reject) => {
    const request = NodeHttps.get(
      `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${language}.traineddata`,
      { signal },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error("OCR 언어 모델 다운로드에 실패했습니다."));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 8_000_000)
            request.destroy(new Error("OCR 언어 모델 크기가 예상 범위를 넘었습니다."));
          else chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
  });
async function prepareLanguages(directory: string, signal: AbortSignal) {
  await NodeFSP.mkdir(directory, { recursive: true });
  for (const [language, expectedHash] of Object.entries(LANGUAGE_HASHES)) {
    const filename = NodePath.join(directory, `${language}.traineddata`);
    const cached = await NodeFSP.readFile(filename).catch(() => null);
    if (cached && digest(cached) === expectedHash) continue;
    const bytes = await downloadLanguage(language, signal);
    if (digest(bytes) !== expectedHash)
      throw new Error("OCR 언어 모델 무결성을 확인하지 못했습니다.");
    const temporary = `${filename}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(temporary, bytes);
      await NodeFSP.rename(temporary, filename);
    } finally {
      await NodeFSP.unlink(temporary).catch(() => undefined);
    }
  }
}

/** Preserve large horizontal gaps as cell separators; OCR does not infer spreadsheet formulas. */
export function ocrLayoutText(page: Pick<Page, "text" | "blocks">) {
  if (!page.blocks?.length) return page.text;
  return page.blocks
    .flatMap((block) =>
      block.paragraphs.flatMap((paragraph) =>
        paragraph.lines.map((line) => {
          const words = line.words.toSorted((left, right) => left.bbox.x0 - right.bbox.x0);
          const hasColumns = words.some(
            (word, index) =>
              index > 0 &&
              word.bbox.x0 - words[index - 1]!.bbox.x1 >
                Math.max(24, (word.bbox.y1 - word.bbox.y0) * 1.5),
          );
          if (!hasColumns) return line.text.trim();
          return words
            .map((word, index) => {
              const previous = words[index - 1];
              const gap = previous ? word.bbox.x0 - previous.bbox.x1 : 0;
              const height = word.bbox.y1 - word.bbox.y0;
              return `${previous ? (gap > Math.max(24, height * 1.5) ? "\t" : " ") : ""}${word.text}`;
            })
            .join("");
        }),
      ),
    )
    .join("\n");
}

/** A document owns its worker and always terminates it, including on cancellation. */
export function createPdfOcr(cacheDirectory: string, signal?: AbortSignal) {
  let worker: Promise<Worker> | undefined;
  let ready: Worker | undefined;
  let closed = false;
  const getWorker = (initializationSignal: AbortSignal) =>
    (worker ??= (async () => {
      // Download only verified models with cancellation, before starting the OCR worker.
      await prepareLanguages(cacheDirectory, initializationSignal);
      if (closed || initializationSignal.aborted) throw new Error("OCR cancelled");
      const instance = await createWorker(["kor", "eng"], 1, {
        cachePath: NodePath.resolve(cacheDirectory),
        langPath: NodePath.resolve(cacheDirectory),
        gzip: false,
        errorHandler: () => undefined,
      });
      if (closed || signal?.aborted) {
        await instance.terminate();
        throw new Error("OCR cancelled");
      }
      ready = instance;
      await instance.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1",
        user_defined_dpi: "150",
      });
      return instance;
    })());
  const close = async () => {
    closed = true;
    const instance = ready;
    ready = undefined;
    if (instance) await instance.terminate().catch(() => undefined);
  };
  const onAbort = () => {
    void close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    async recognize(image: Uint8Array) {
      if (closed || signal?.aborted) throw new Error("OCR cancelled");
      const result = await Effect.runPromise(
        Effect.tryPromise(async (initializationSignal) => {
          const instance = await getWorker(initializationSignal);
          return instance.recognize(Buffer.from(image), {}, { text: true, blocks: true });
        }).pipe(
          Effect.timeout("30 seconds"),
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.promise(close) : Effect.void)),
        ),
        signal ? { signal } : undefined,
      );
      return { text: ocrLayoutText(result.data), confidence: result.data.confidence };
    },
    async close() {
      signal?.removeEventListener("abort", onAbort);
      await close();
    },
  };
}
