import { useEffect, useMemo, useState } from "react";
import { Image, Linking, Pressable, ScrollView, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import {
  GENERATED_TEXT_VISIBLE_CHARS,
  groupGeneratedResultAttachments,
  readResultText,
  resultTextExcerpt,
} from "@t3tools/shared/generatedResults";
import { AppText as Text } from "../../components/AppText";
import { useAssetUrl } from "../../state/assets";

export function GeneratedResult(props: {
  readonly attachment: ChatAttachment;
  readonly environmentId: EnvironmentId;
  readonly onPressImage: (uri: string) => void;
}) {
  return props.attachment.type === "image" ? (
    <GeneratedImage {...props} />
  ) : (
    <GeneratedText {...props} />
  );
}

export function GeneratedResultsList(props: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly environmentId: EnvironmentId;
  readonly onPressImage: (uri: string) => void;
}) {
  const groups = useMemo(
    () => groupGeneratedResultAttachments(props.attachments),
    [props.attachments],
  );
  return (
    <>
      {groups.map((group) =>
        group.kind === "image-gallery" ? (
          <GeneratedImageGallery
            key={group.id}
            attachments={group.attachments}
            environmentId={props.environmentId}
            onPressImage={props.onPressImage}
          />
        ) : (
          <GeneratedResult
            key={group.attachment.id}
            attachment={group.attachment}
            environmentId={props.environmentId}
            onPressImage={props.onPressImage}
          />
        ),
      )}
    </>
  );
}

function GeneratedImageGalleryTile({ attachment, environmentId, onPressImage }: ResultProps) {
  const uri = useAssetUrl(environmentId, { _tag: "attachment", attachmentId: attachment.id });
  const [error, setError] = useState<string | null>(null);
  return (
    <View
      style={{ width: "48.5%" }}
      className="overflow-hidden rounded-lg border border-neutral-300 dark:border-neutral-700"
      accessibilityLabel={"생성 이미지 " + attachment.name}
    >
      {uri && !error ? (
        <Pressable
          accessibilityLabel={"이미지 확대 " + attachment.name}
          onPress={() => onPressImage(uri)}
        >
          <Image
            source={{ uri }}
            resizeMode="contain"
            style={{ width: "100%", height: 150 }}
            onError={() => setError("이미지를 표시할 수 없습니다.")}
          />
        </Pressable>
      ) : (
        <View style={{ height: 150 }} className="items-center justify-center p-2">
          <Text className="text-center text-xs">{error ?? "이미지를 불러오는 중…"}</Text>
        </View>
      )}
      <Text numberOfLines={1} className="px-2 py-1 text-xs">
        {attachment.name}
      </Text>
    </View>
  );
}

function GeneratedImageGallery(props: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly environmentId: EnvironmentId;
  readonly onPressImage: (uri: string) => void;
}) {
  return (
    <View
      className="my-2 overflow-hidden rounded-xl border border-neutral-300 dark:border-neutral-700"
      accessibilityLabel={`생성 이미지 ${props.attachments.length}장`}
    >
      <Text className="px-3 pt-2.5 pb-1.5 text-xs font-t3-semibold">
        생성 이미지 {props.attachments.length}장
      </Text>
      <View className="flex-row flex-wrap justify-between gap-y-2 px-2 pb-2">
        {props.attachments.map((attachment) => (
          <GeneratedImageGalleryTile
            key={attachment.id}
            attachment={attachment}
            environmentId={props.environmentId}
            onPressImage={props.onPressImage}
          />
        ))}
      </View>
    </View>
  );
}

type ResultProps = Parameters<typeof GeneratedResult>[0];
function GeneratedImage({ attachment, environmentId, onPressImage }: ResultProps) {
  const uri = useAssetUrl(environmentId, { _tag: "attachment", attachmentId: attachment.id });
  const download = useAssetUrl(environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
    downloadName: attachment.name,
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <View
      className="my-2 overflow-hidden rounded-xl border border-neutral-300 dark:border-neutral-700"
      accessibilityLabel={"생성 이미지 " + attachment.name}
    >
      <Text className="p-3 text-sm font-t3-semibold">{attachment.name}</Text>
      {uri ? (
        <Pressable
          accessibilityLabel={"이미지 확대 " + attachment.name}
          onPress={() => onPressImage(uri)}
        >
          <Image
            source={{ uri }}
            resizeMode="contain"
            style={{ width: "100%", height: 320 }}
            onError={() => setError("이미지를 표시할 수 없습니다.")}
          />
        </Pressable>
      ) : (
        <Text className="p-3 text-sm">이미지를 불러오는 중…</Text>
      )}
      <Pressable
        disabled={!download}
        className="p-3"
        accessibilityRole="button"
        onPress={() => {
          if (download) void Linking.openURL(download).catch((cause) => setError(String(cause)));
        }}
      >
        <Text className="text-sm underline">원본 다운로드</Text>
      </Pressable>
      {error ? <Text className="p-3 text-sm text-red-600">{error}</Text> : null}
    </View>
  );
}

function GeneratedText({ attachment, environmentId }: ResultProps) {
  const preview = useAssetUrl(environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
    preview: true,
  });
  const original = useAssetUrl(environmentId, { _tag: "attachment", attachmentId: attachment.id });
  const download = useAssetUrl(environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
    downloadName: attachment.name,
  });
  const [body, setBody] = useState<Awaited<ReturnType<typeof readResultText>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!expanded || !preview) return;
    const controller = new AbortController();
    void readResultText(preview, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setBody(value);
      },
      (cause) => {
        if (!controller.signal.aborted) setError(String(cause));
      },
    );
    return () => controller.abort();
  }, [expanded, preview]);
  const fullText = async () => {
    if (body && !body.truncated) return body;
    if (!original) throw new Error("결과 파일 연결을 기다리는 중입니다.");
    return await readResultText(original);
  };
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
  const truncated =
    body && (body.truncated || (!showAll && body.text.length > GENERATED_TEXT_VISIBLE_CHARS));
  return (
    <View
      className="my-2 overflow-hidden rounded-xl border border-neutral-300 dark:border-neutral-700"
      accessibilityLabel={"생성 텍스트 " + attachment.name}
    >
      <Pressable
        className="p-3"
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
      >
        <Text className="text-sm font-t3-semibold">
          {attachment.name} {expanded ? "▾" : "▸"}
        </Text>
      </Pressable>
      <View className="flex-row flex-wrap gap-4 px-3 pb-3">
        <Pressable
          disabled={busy || !original}
          accessibilityRole="button"
          onPress={() =>
            void run(async () => {
              const value = await fullText();
              await Clipboard.setStringAsync(value.text);
              setCopied(true);
            })
          }
        >
          <Text className="text-sm underline">{copied ? "복사됨" : "전체 복사"}</Text>
        </Pressable>
        <Pressable
          disabled={!download}
          accessibilityRole="button"
          onPress={() => {
            if (download) void Linking.openURL(download).catch((cause) => setError(String(cause)));
          }}
        >
          <Text className="text-sm underline">원본 다운로드</Text>
        </Pressable>
      </View>
      {expanded ? (
        <ScrollView
          style={{ maxHeight: 400 }}
          nestedScrollEnabled
          contentContainerStyle={{ padding: 12 }}
        >
          <Text selectable className="text-sm leading-6">
            {body
              ? (showAll ? body.text : resultTextExcerpt(body.text)) || "(빈 텍스트 파일)"
              : "내용을 불러오는 중…"}
          </Text>
        </ScrollView>
      ) : null}
      {expanded && truncated ? (
        <Pressable
          disabled={busy}
          className="p-3"
          accessibilityRole="button"
          onPress={() =>
            void run(async () => {
              setBody(await fullText());
              setShowAll(true);
            })
          }
        >
          <Text className="text-sm underline">
            전체 내용 보기 · {(attachment.sizeBytes / 1024).toFixed(1)} KB
          </Text>
        </Pressable>
      ) : null}
      {error ? <Text className="p-3 text-sm text-red-600">{error}</Text> : null}
    </View>
  );
}
