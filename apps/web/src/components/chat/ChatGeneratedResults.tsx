import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment, ScopedThreadRef } from "@t3tools/contracts";
import {
  GENERATED_TEXT_VISIBLE_CHARS,
  readResultText,
  resultTextExcerpt,
} from "@t3tools/shared/generatedResults";
import { useAssetUrlState } from "../../assets/assetUrls";
import { downloadFile } from "../../browser/downloadFile";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

type ResultAttachment = ChatAttachment & { readonly previewUrl?: string };
interface ResultProps {
  readonly attachment: ResultAttachment;
  readonly threadRef: ScopedThreadRef;
  readonly cwd?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

function ResultImage({ attachment, threadRef, onImageExpand }: ResultProps) {
  const resource = useAssetUrlState(threadRef.environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
  });
  const url = resource._tag === "Success" ? resource.url : null;
  const download = useAssetUrlState(threadRef.environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
    downloadName: attachment.name,
  });
  const downloadUrl = download._tag === "Success" ? download.url : null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failed = resource._tag === "Failure" || (url !== null && failedUrl === url);
  return (
    <section
      className="my-3 overflow-hidden rounded-xl border border-border bg-card"
      aria-label={"생성 이미지 " + attachment.name}
      data-result-id={attachment.id}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="min-w-0 break-all font-medium">{attachment.name}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!downloadUrl}
          onClick={() => {
            if (downloadUrl)
              void downloadFile(downloadUrl, attachment.name).catch((cause) =>
                setError(String(cause)),
              );
          }}
        >
          원본 다운로드
        </Button>
      </div>
      <div
        className="bg-[length:20px_20px]"
        style={{
          backgroundImage:
            "conic-gradient(from 90deg,#80808018 25%,transparent 0 50%,#80808018 0 75%,transparent 0)",
        }}
      >
        {url && !failed ? (
          <button
            type="button"
            className="block w-full cursor-zoom-in"
            aria-label={"이미지 확대 " + attachment.name}
            onClick={() => {
              onImageExpand?.({ images: [{ src: url, name: attachment.name }], index: 0 });
            }}
          >
            <img
              src={url}
              crossOrigin="anonymous"
              alt={attachment.name}
              loading="lazy"
              decoding="async"
              width={attachment.result?.width}
              height={attachment.result?.height}
              className="mx-auto block h-auto max-h-[520px] w-full object-contain"
              onError={() => setFailedUrl(url)}
            />
          </button>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            {failed ? "이미지를 표시할 수 없습니다." : "이미지를 불러오는 중…"}
          </p>
        )}
      </div>
      {error ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ResultText({ attachment, threadRef, cwd, onImageExpand }: ResultProps) {
  const preview = useAssetUrlState(threadRef.environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
    preview: true,
  });
  const original = useAssetUrlState(threadRef.environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
  });
  const previewUrl = preview._tag === "Success" ? preview.url : null;
  const originalUrl = original._tag === "Success" ? original.url : null;
  const [body, setBody] = useState<Awaited<ReturnType<typeof readResultText>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [raw, setRaw] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const full = useRef<{ url: string; promise: ReturnType<typeof readResultText> } | null>(null);
  useEffect(() => {
    if (!previewUrl) return;
    const controller = new AbortController();
    setError(null);
    void readResultText(previewUrl, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setBody((existing) => existing ?? value);
      },
      (cause) => {
        if (!controller.signal.aborted) setError(String(cause));
      },
    );
    return () => controller.abort();
  }, [previewUrl, attempt]);
  const loadFull = useCallback(async () => {
    if (body && !body.truncated) return body;
    if (!originalUrl) throw new Error("결과 파일 연결을 기다리는 중입니다.");
    if (full.current?.url !== originalUrl)
      full.current = { url: originalUrl, promise: readResultText(originalUrl) };
    try {
      return await full.current.promise;
    } catch (cause) {
      full.current = null;
      throw cause;
    }
  }, [body, originalUrl]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const markdown = /^(md|markdown)$/.test(attachment.result?.language ?? "");
  const visibleText = body ? (showAll ? body.text : resultTextExcerpt(body.text)) : "";
  const truncated =
    body && (body.truncated || (!showAll && body.text.length > GENERATED_TEXT_VISIBLE_CHARS));
  return (
    <section
      className="my-3 min-w-0 overflow-hidden rounded-xl border border-border bg-card"
      aria-label={"생성 텍스트 " + attachment.name}
      data-result-id={attachment.id}
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-xs">
        <button
          type="button"
          className="min-w-0 flex-1 break-all px-1 text-left font-medium"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {attachment.name} {expanded ? "▾" : "▸"}
        </button>
        {markdown ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setRaw((value) => !value)}>
            {raw ? "읽기" : "원문"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || !originalUrl}
          onClick={() =>
            void run(async () => {
              const value = await loadFull();
              const success = await writeTextToClipboard(value.text, "생성 결과");
              setCopied(success);
            })
          }
        >
          {copied ? "복사됨" : "전체 복사"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || !originalUrl}
          onClick={() =>
            void run(async () => {
              if (originalUrl) await downloadFile(originalUrl, attachment.name);
            })
          }
        >
          원본 다운로드
        </Button>
      </div>
      {expanded ? (
        <div className="min-w-0 px-3 py-3">
          {body ? (
            <div className="max-h-[480px] min-w-0 overflow-auto">
              {markdown && !raw && visibleText.length <= GENERATED_TEXT_VISIBLE_CHARS ? (
                <ChatMarkdown
                  text={visibleText}
                  cwd={cwd}
                  threadRef={threadRef}
                  onImageExpand={onImageExpand}
                />
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground/90">
                  {visibleText || "(빈 텍스트 파일)"}
                </pre>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {preview._tag === "Failure" ? "텍스트 연결에 실패했습니다." : "내용을 불러오는 중…"}
            </p>
          )}
          {truncated ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>일부 내용 표시 · 전체 {(attachment.sizeBytes / 1024).toFixed(1)} KB</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const value = await loadFull();
                    setBody(value);
                    setShowAll(true);
                  })
                }
              >
                전체 내용 보기
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="px-3 pb-3 text-xs text-destructive">
          {error}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            다시 시도
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function ChatGeneratedResults(props: {
  readonly attachments: ReadonlyArray<ResultAttachment>;
  readonly threadRef: ScopedThreadRef;
  readonly cwd?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  return (
    <>
      {props.attachments.map((attachment) =>
        attachment.type === "image" ? (
          <ResultImage key={attachment.id} {...props} attachment={attachment} />
        ) : attachment.result?.kind === "text" ? (
          <ResultText key={attachment.id} {...props} attachment={attachment} />
        ) : (
          <ResultFile key={attachment.id} {...props} attachment={attachment} />
        ),
      )}
    </>
  );
}

function ResultFile({ attachment, threadRef }: ResultProps) {
  const resource = useAssetUrlState(threadRef.environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
    downloadName: attachment.name,
  });
  return (
    <a
      className="my-2 block rounded-lg border border-border p-3 text-sm underline"
      href={resource._tag === "Success" ? resource.url : undefined}
      download={attachment.name}
    >
      {attachment.name}
    </a>
  );
}
