import { createContext, use, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAssetUrlState } from "../../assets/assetUrls";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export const MarkdownImageGalleryContext = createContext(false);

export function MarkdownResultImage(props: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly alt?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const inGallery = use(MarkdownImageGalleryContext);
  const result = useAssetUrlState(props.threadRef.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.filePath,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (result._tag === "Failure")
    return (
      <span
        className={
          inGallery
            ? "flex h-44 items-center justify-center rounded-lg border border-border bg-card p-3 text-center text-xs text-destructive"
            : "my-2 block text-sm text-destructive"
        }
      >
        이미지를 읽을 수 없습니다: {props.alt ?? props.filePath}
      </span>
    );
  if (result._tag !== "Success")
    return (
      <span
        className={
          inGallery
            ? "flex h-44 items-center justify-center rounded-lg border border-border bg-card p-3 text-center text-xs text-muted-foreground"
            : "my-2 block text-sm text-muted-foreground"
        }
      >
        이미지를 불러오는 중…
      </span>
    );
  if (failedUrl === result.url)
    return (
      <span
        className={
          inGallery
            ? "flex h-44 flex-col items-center justify-center gap-1 rounded-lg border border-border bg-card p-3 text-center text-xs text-destructive"
            : "my-2 block text-sm text-destructive"
        }
      >
        이미지를 표시할 수 없습니다.{" "}
        <button type="button" className="underline" onClick={() => setFailedUrl(null)}>
          다시 시도
        </button>
      </span>
    );
  const image = (
    <img
      src={result.url}
      crossOrigin="anonymous"
      alt={props.alt ?? "생성 이미지"}
      loading="lazy"
      decoding="async"
      className={
        inGallery
          ? "mx-auto block h-44 w-full object-contain sm:h-48"
          : "my-2 block h-auto max-h-[520px] max-w-full object-contain"
      }
      onError={() => setFailedUrl(result.url)}
    />
  );
  const wrapped = props.onImageExpand ? (
    <span className="block">
      <button
        type="button"
        className={inGallery ? "block w-full cursor-zoom-in" : "cursor-zoom-in"}
        aria-label={"이미지 확대 " + (props.alt ?? props.filePath)}
        onClick={() =>
          props.onImageExpand?.({
            images: [{ src: result.url, name: props.alt ?? props.filePath }],
            index: 0,
          })
        }
      >
        {image}
      </button>
    </span>
  ) : (
    image
  );
  if (!inGallery) {
    return wrapped;
  }
  return (
    <span
      className="block overflow-hidden rounded-lg border border-border bg-card"
      style={{
        backgroundImage:
          "conic-gradient(from 90deg,#80808018 25%,transparent 0 50%,#80808018 0 75%,transparent 0)",
        backgroundSize: "20px 20px",
      }}
    >
      {wrapped}
      {props.alt ? (
        <span className="block truncate border-t border-border/70 bg-card px-2 py-1 text-[11px] text-muted-foreground">
          {props.alt}
        </span>
      ) : null}
    </span>
  );
}
