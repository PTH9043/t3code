import { useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAssetUrlState } from "../../assets/assetUrls";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export function MarkdownResultImage(props: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly alt?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const result = useAssetUrlState(props.threadRef.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.filePath,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (result._tag === "Failure")
    return (
      <span className="my-2 block text-sm text-destructive">
        이미지를 읽을 수 없습니다: {props.alt ?? props.filePath}
      </span>
    );
  if (result._tag !== "Success")
    return <span className="my-2 block text-sm text-muted-foreground">이미지를 불러오는 중…</span>;
  if (failedUrl === result.url)
    return (
      <span className="my-2 block text-sm text-destructive">
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
      className="my-2 block h-auto max-h-[520px] max-w-full object-contain"
      onError={() => setFailedUrl(result.url)}
    />
  );
  return props.onImageExpand ? (
    <span className="block">
      <button
        type="button"
        className="cursor-zoom-in"
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
}
