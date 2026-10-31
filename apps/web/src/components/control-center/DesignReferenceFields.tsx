import { useState } from "react";
import type { EnvironmentId, ProjectId, WorkspaceDesignReference } from "@t3tools/contracts";
import { useAssetUrl } from "~/assets/assetUrls";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { notifyCommandFailure } from "./controlCenterShared";

export const emptyDesignReference: WorkspaceDesignReference = {
  version: "",
  components: [],
  layout: "",
  images: [],
  sourceUrl: null,
};

export function DesignReferenceFields(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  value: WorkspaceDesignReference | null;
  onChange: (value: WorkspaceDesignReference | null) => void;
}) {
  const value = props.value ?? emptyDesignReference;
  const upload = useAtomCommand(serverEnvironment.uploadDesignImage, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 8_000_000 || value.images.length >= 8) {
      setError("이미지는 각각 8 MB 이내, 최대 8개입니다.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener(
          "load",
          () => {
            if (typeof reader.result === "string") resolve(reader.result);
            else reject(new Error("이미지를 읽지 못했습니다."));
          },
          { once: true },
        );
        reader.addEventListener("error", () => reject(new Error("이미지를 읽지 못했습니다.")), {
          once: true,
        });
        reader.readAsDataURL(file);
      });
      const result = await upload({
        environmentId: props.environmentId,
        input: { projectId: props.projectId, name: file.name, dataUrl },
      });
      if (
        !notifyCommandFailure(result, "이미지를 보관하지 못했습니다.") &&
        result._tag === "Success"
      )
        props.onChange({ ...value, images: [...value.images, result.value] });
    } catch {
      setError("이미지를 읽지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details open={props.value !== null} className="rounded-xl border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold">화면·컴포넌트 참고 자료</summary>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="flex items-center gap-2 text-xs md:col-span-2">
          <input
            type="checkbox"
            checked={props.value !== null}
            onChange={(event) => props.onChange(event.target.checked ? emptyDesignReference : null)}
          />
          이미지·출처·버전을 RAG 자료로 저장
        </label>
        {props.value ? (
          <>
            <label className="grid gap-1 text-xs">
              버전
              <Input
                value={value.version}
                onChange={(event) => props.onChange({ ...value, version: event.target.value })}
                placeholder="v2 · 2026-10-05"
                maxLength={100}
              />
            </label>
            <label className="grid gap-1 text-xs">
              원본·Figma 링크
              <Input
                value={value.sourceUrl ?? ""}
                onChange={(event) =>
                  props.onChange({ ...value, sourceUrl: event.target.value || null })
                }
                placeholder="https://www.figma.com/..."
              />
            </label>
            <label className="grid gap-1 text-xs md:col-span-2">
              컴포넌트 (쉼표로 구분)
              <Input
                value={value.components.join(", ")}
                onChange={(event) =>
                  props.onChange({
                    ...value,
                    components: event.target.value.split(",").map((item) => item.trim()),
                  })
                }
                placeholder="사이드바, 작업 카드, 상태 배지"
              />
            </label>
            <label className="grid gap-1 text-xs md:col-span-2">
              레이아웃·스타일 설명
              <Textarea
                value={value.layout}
                maxLength={4000}
                onChange={(event) => props.onChange({ ...value, layout: event.target.value })}
                placeholder="2열 카드, 왼쪽 고정 탐색, 어두운 배경"
              />
            </label>
            <label className="grid gap-1 text-xs md:col-span-2">
              이미지 주소 (줄마다 URL · 선택 설명)
              <Textarea
                value={value.images
                  .filter((image) => image.url)
                  .map((image) => `${image.url}${image.caption ? ` | ${image.caption}` : ""}`)
                  .join("\n")}
                onChange={(event) =>
                  props.onChange({
                    ...value,
                    images: [
                      ...value.images.filter((image) => image.attachmentId),
                      ...event.target.value
                        .split("\n")
                        .filter(Boolean)
                        .map((line) => {
                          const [url, ...caption] = line.split("|");
                          return { url: (url ?? "").trim(), caption: caption.join("|").trim() };
                        }),
                    ],
                  })
                }
                placeholder="https://example.com/ui.png | 작업 대시보드"
              />
            </label>
            <label className="grid gap-1 text-xs md:col-span-2">
              이미지 파일 보관
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={busy || value.images.length >= 8}
                onChange={(event) => void uploadFile(event.target.files?.[0])}
              />
            </label>
            {value.images
              .filter((image) => image.attachmentId)
              .map((image) => (
                <div
                  key={image.attachmentId}
                  className="flex items-center justify-between gap-2 text-xs md:col-span-2"
                >
                  <span>{image.caption} · 서버에 보관됨</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      props.onChange({
                        ...value,
                        images: value.images.filter((item) => item !== image),
                      })
                    }
                  >
                    참고에서 제거
                  </Button>
                </div>
              ))}
            {error ? (
              <p role="alert" className="text-xs text-destructive md:col-span-2">
                {error}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground md:col-span-2">
              파일은 현재 환경에 보관됩니다. 시각 분석 결과는 내용·레이아웃 설명에 기록하세요. Figma
              MCP는 계정 연결 후 사용할 수 있습니다.
            </p>
          </>
        ) : null}
      </div>
    </details>
  );
}

function StoredDesignImage({
  environmentId,
  attachmentId,
  caption,
}: {
  environmentId: EnvironmentId;
  attachmentId: string;
  caption: string;
}) {
  const url = useAssetUrl(environmentId, { _tag: "attachment", attachmentId });
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img
        src={url}
        alt={caption || "디자인 참고 이미지"}
        loading="lazy"
        className="aspect-video w-full rounded-lg bg-muted object-contain"
      />
    </a>
  ) : (
    <p className="text-xs text-muted-foreground">보관 이미지 불러오는 중…</p>
  );
}

export function DesignReferencePreview({
  reference,
  environmentId,
}: {
  reference: WorkspaceDesignReference;
  environmentId: EnvironmentId;
}) {
  return (
    <details className="mt-3 rounded-lg border border-border p-2">
      <summary className="cursor-pointer text-xs font-medium">
        디자인 참고{reference.version ? ` · ${reference.version}` : ""}
        {reference.images.length ? ` · 이미지 ${reference.images.length}개` : ""}
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        {reference.components.filter(Boolean).join(" · ")}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{reference.layout}</p>
      {reference.sourceUrl ? (
        <a
          className="mt-2 inline-block text-xs text-primary underline"
          href={reference.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          원본 참고 자료 열기
        </a>
      ) : null}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {reference.images.map((image) => (
          <figure key={`${image.attachmentId ?? image.url}:${image.caption}`}>
            {image.attachmentId ? (
              <StoredDesignImage
                environmentId={environmentId}
                attachmentId={image.attachmentId}
                caption={image.caption}
              />
            ) : (
              <a href={image.url} target="_blank" rel="noreferrer">
                <img
                  src={image.url}
                  alt={image.caption || "디자인 참고 이미지"}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="aspect-video w-full rounded-lg bg-muted object-contain"
                />
              </a>
            )}
            {image.caption ? (
              <figcaption className="mt-1 text-[10px] text-muted-foreground">
                {image.caption}
              </figcaption>
            ) : null}
          </figure>
        ))}
      </div>
    </details>
  );
}
