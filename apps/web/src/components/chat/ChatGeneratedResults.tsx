import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon, LayoutGridIcon, Rows3Icon } from "lucide-react";
import type { ChatAttachment, ScopedThreadRef } from "@t3tools/contracts";
import {
  GENERATED_TEXT_VISIBLE_CHARS,
  groupGeneratedResultAttachments,
  readResultText,
  resultTextExcerpt,
} from "@t3tools/shared/generatedResults";
import { useAssetUrlState } from "../../assets/assetUrls";
import { downloadFile } from "../../browser/downloadFile";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";

type ResultAttachment = ChatAttachment & { readonly previewUrl?: string };
interface ResultProps {
  readonly attachment: ResultAttachment;
  readonly threadRef: ScopedThreadRef;
  readonly cwd?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

const CHECKERBOARD_STYLE = {
  backgroundImage:
    "conic-gradient(from 90deg,#80808018 25%,transparent 0 50%,#80808018 0 75%,transparent 0)",
} as const;

function galleryGridClass(count: number): string {
  return count === 2 || count === 4 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3";
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
      <div className="bg-[length:20px_20px]" style={CHECKERBOARD_STYLE}>
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

function ResultImageGalleryTile({
  attachment,
  threadRef,
  stacked,
  onUrlResolved,
  onExpand,
}: {
  readonly attachment: ResultAttachment;
  readonly threadRef: ScopedThreadRef;
  readonly stacked: boolean;
  readonly onUrlResolved: (attachmentId: string, url: string | null) => void;
  readonly onExpand: (attachmentId: string, fallbackUrl: string) => void;
}) {
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

  useEffect(() => {
    onUrlResolved(attachment.id, url && !failed ? url : null);
    return () => onUrlResolved(attachment.id, null);
  }, [attachment.id, failed, onUrlResolved, url]);

  return (
    <figure
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border/80 bg-background/60"
      data-result-id={attachment.id}
    >
      <div className="flex-1 bg-[length:20px_20px]" style={CHECKERBOARD_STYLE}>
        {url && !failed ? (
          <button
            type="button"
            className="block w-full cursor-zoom-in"
            aria-label={"이미지 확대 " + attachment.name}
            onClick={() => onExpand(attachment.id, url)}
          >
            <img
              src={url}
              crossOrigin="anonymous"
              alt={attachment.name}
              loading="lazy"
              decoding="async"
              width={attachment.result?.width}
              height={attachment.result?.height}
              className={
                stacked
                  ? "mx-auto block h-auto max-h-[520px] w-full object-contain"
                  : "mx-auto block h-44 w-full object-contain sm:h-48"
              }
              onError={() => setFailedUrl(url)}
            />
          </button>
        ) : (
          <div className="flex h-44 items-center justify-center p-3 text-center text-xs text-muted-foreground sm:h-48">
            {failed ? "이미지를 표시할 수 없습니다." : "이미지를 불러오는 중…"}
          </div>
        )}
      </div>
      <figcaption className="flex min-w-0 items-center justify-between gap-1 border-t border-border/70 bg-card px-2 py-1 text-[11px]">
        <span className="min-w-0 truncate text-muted-foreground" title={attachment.name}>
          {attachment.name}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={!downloadUrl}
          aria-label={attachment.name + " 원본 다운로드"}
          onClick={() => {
            if (downloadUrl)
              void downloadFile(downloadUrl, attachment.name).catch((cause) =>
                setError(String(cause)),
              );
          }}
        >
          <DownloadIcon className="size-3" />
        </Button>
      </figcaption>
      {error ? (
        <p role="alert" className="px-2 pb-1.5 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
    </figure>
  );
}

function ResultImageGallery({
  attachments,
  threadRef,
  onImageExpand,
}: {
  readonly attachments: ReadonlyArray<ResultAttachment>;
  readonly threadRef: ScopedThreadRef;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [layout, setLayout] = useState<"grid" | "stack">("grid");
  const resolvedUrlsRef = useRef<Map<string, string>>(new Map());

  const handleUrlResolved = useCallback((attachmentId: string, url: string | null) => {
    if (url) {
      resolvedUrlsRef.current.set(attachmentId, url);
    } else {
      resolvedUrlsRef.current.delete(attachmentId);
    }
  }, []);

  const handleExpand = useCallback(
    (attachmentId: string, fallbackUrl: string) => {
      if (!onImageExpand) return;
      const items: ExpandedImageItem[] = [];
      let clickedIndex = -1;
      for (const attachment of attachments) {
        const src =
          resolvedUrlsRef.current.get(attachment.id) ??
          (attachment.id === attachmentId ? fallbackUrl : null);
        if (!src) continue;
        if (attachment.id === attachmentId) {
          clickedIndex = items.length;
        }
        items.push({ src, name: attachment.name });
      }
      if (items.length === 0) return;
      onImageExpand({
        images: items,
        index: clickedIndex >= 0 ? clickedIndex : 0,
      });
    },
    [attachments, onImageExpand],
  );

  return (
    <section
      className="my-3 overflow-hidden rounded-xl border border-border bg-card"
      aria-label={`생성 이미지 ${attachments.length}장`}
      data-result-image-gallery="true"
      data-result-image-count={attachments.length}
      data-result-image-layout={layout}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs">
        <span className="font-medium text-foreground">생성 이미지 {attachments.length}장</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setLayout((current) => (current === "grid" ? "stack" : "grid"))}
        >
          {layout === "grid" ? (
            <>
              <Rows3Icon className="mr-1 size-3.5" />
              크게 보기
            </>
          ) : (
            <>
              <LayoutGridIcon className="mr-1 size-3.5" />
              모아보기
            </>
          )}
        </Button>
      </div>
      <div
        className={cn(
          "grid gap-2 p-2",
          layout === "grid" ? galleryGridClass(attachments.length) : "grid-cols-1",
        )}
      >
        {attachments.map((attachment) => (
          <ResultImageGalleryTile
            key={attachment.id}
            attachment={attachment}
            threadRef={threadRef}
            stacked={layout === "stack"}
            onUrlResolved={handleUrlResolved}
            onExpand={handleExpand}
          />
        ))}
      </div>
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
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const full = useRef<{ url: string; promise: ReturnType<typeof readResultText> } | null>(null);
  useEffect(() => {
    if (!expanded || !previewUrl) return;
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
  }, [expanded, previewUrl, attempt]);
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
  const sizeLabel =
    attachment.sizeBytes > 0 ? `${Math.max(0.1, attachment.sizeBytes / 1024).toFixed(1)} KB` : null;
  return (
    <section
      className="my-3 min-w-0 overflow-hidden rounded-xl border border-border bg-card"
      aria-label={"생성 텍스트 " + attachment.name}
      data-result-id={attachment.id}
      data-result-report-collapsed={expanded ? "false" : "true"}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-1 px-2 py-1.5 text-xs",
          expanded && "border-b border-border",
        )}
      >
        <button
          type="button"
          className="min-w-0 flex-1 break-all px-1 text-left font-medium"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {attachment.name}{" "}
          {sizeLabel ? (
            <span className="font-normal text-muted-foreground">({sizeLabel})</span>
          ) : null}{" "}
          {expanded ? "▾" : "▸"}
        </button>
        {markdown && expanded ? (
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
  const groups = useMemo(
    () => groupGeneratedResultAttachments(props.attachments),
    [props.attachments],
  );
  return (
    <>
      {groups.map((group) =>
        group.kind === "image-gallery" ? (
          <ResultImageGallery
            key={group.id}
            attachments={group.attachments}
            threadRef={props.threadRef}
            onImageExpand={props.onImageExpand}
          />
        ) : group.kind === "image" ? (
          <ResultImage key={group.attachment.id} {...props} attachment={group.attachment} />
        ) : group.kind === "text" ? (
          <ResultText key={group.attachment.id} {...props} attachment={group.attachment} />
        ) : (
          <ResultFile key={group.attachment.id} {...props} attachment={group.attachment} />
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
