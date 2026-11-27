import { useAtomValue } from "@effect/atom-react";
import {
  isCustomResponseStyle,
  type EnvironmentId,
  type ThreadId,
  type ThreadResponseStyle,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const DEFAULT_STYLE: ThreadResponseStyle = {
  preset: "default",
  tone: "",
  length: "",
  explanation: "",
  instructions: "",
};
const PRESETS: ReadonlyArray<readonly [ThreadResponseStyle["preset"], string]> = [
  ["default", "기본"],
  ["concise", "간결"],
  ["detailed", "상세"],
  ["friendly", "친근"],
  ["professional", "전문"],
];

export function responseStyleLabel(preset: ThreadResponseStyle["preset"]) {
  return PRESETS.find(([value]) => value === preset)?.[1] ?? preset;
}

export function sameStyle(a: ThreadResponseStyle | undefined, b: ThreadResponseStyle): boolean {
  return (
    a !== undefined &&
    a.preset === b.preset &&
    a.tone === b.tone &&
    a.length === b.length &&
    a.explanation === b.explanation &&
    a.instructions === b.instructions
  );
}

export function ThreadResponseStyleSettings({
  environmentId,
  threadId,
  local,
}: { environmentId: EnvironmentId } & (
  | { threadId: ThreadId; local?: never }
  | { threadId?: never; local?: never }
  | {
      threadId?: never;
      local: {
        value: ThreadResponseStyle | undefined;
        save: (value: ThreadResponseStyle) => Promise<void>;
      };
    }
)) {
  const insets = useSafeAreaInsets();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const ready = Boolean(local || settings);
  const global = !local && threadId === undefined;
  const observed =
    (local
      ? local.value
      : threadId === undefined
        ? settings?.globalResponseStyle
        : settings?.threadResponseStyles?.[threadId]) ?? DEFAULT_STYLE;
  const [confirmed, setConfirmed] = useState<{
    value: ThreadResponseStyle;
    previous: ThreadResponseStyle;
  } | null>(null);
  const saved = confirmed?.value ?? observed;
  // A conversation follows the global style until it stores a style that asks for something.
  const roomCustom = !global && isCustomResponseStyle(saved);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ThreadResponseStyle>(saved);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  useEffect(() => {
    if (!dirty) setDraft(saved);
    else if (sameStyle(saved, draft)) setDirty(false);
  }, [saved, draft, dirty]);
  useEffect(() => {
    if (
      confirmed &&
      (!sameStyle(confirmed.previous, observed) || sameStyle(confirmed.value, observed))
    ) {
      setConfirmed(null);
    }
  }, [confirmed, observed]);

  const change = (patch: Partial<ThreadResponseStyle>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
    setMessage(null);
    setError(null);
  };
  const close = () => {
    if (pending) return;
    setOpen(false);
    setDirty(false);
    setDraft(saved);
    setError(null);
    setMessage(null);
  };
  const save = async (clear = false) => {
    if (!ready || pending || (!dirty && !clear && !(global && !settings?.globalResponseStyle)))
      return;
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      if (local) {
        await local.save(draft);
        setConfirmed({ value: draft, previous: observed });
        setDirty(false);
        setMessage("첫 요청에 적용할 답변 스타일을 저장했습니다.");
        return;
      }
      // Clearing removes the global style, or returns a conversation to the global style.
      const roomValue = clear ? DEFAULT_STYLE : draft;
      const expected = threadId === undefined ? (clear ? null : draft) : roomValue;
      const patch =
        threadId === undefined
          ? { globalResponseStyle: clear ? null : draft }
          : { threadResponseStyles: { [threadId]: roomValue } };
      const result = await update({
        environmentId,
        input: { patch },
      });
      const actual =
        result._tag === "Success"
          ? threadId === undefined
            ? result.value.globalResponseStyle
            : result.value.threadResponseStyles?.[threadId]
          : undefined;
      if (expected === null ? actual !== null : !sameStyle(actual ?? undefined, expected)) {
        setError(
          "답변 스타일을 저장하지 못했습니다. 연결과 서버 지원 여부를 확인하고 다시 시도하세요.",
        );
        return;
      }
      setConfirmed({ value: actual ?? DEFAULT_STYLE, previous: observed });
      setDirty(false);
      setMessage(
        !clear
          ? "저장했습니다. 다음 요청부터 적용됩니다."
          : global
            ? "전역 답변 스타일을 해제했습니다."
            : "이 대화는 전역 답변 스타일을 따릅니다.",
      );
    } catch {
      setError("답변 스타일을 저장하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={global ? "전역 답변 스타일 설정" : "이 대화의 답변 스타일 설정"}
        className="px-4 py-2"
        onPress={() => setOpen(true)}
      >
        <Text className="text-xs text-muted-foreground">
          {global ? "전역 답변 스타일" : "이 대화의 답변 스타일"} ·{" "}
          {global
            ? settings?.globalResponseStyle
              ? responseStyleLabel(saved.preset)
              : "미설정"
            : roomCustom
              ? responseStyleLabel(saved.preset)
              : "전역 스타일 사용 중"}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={close}
      >
        <SafeAreaView className="flex-1 bg-background">
          <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
            <Text className="font-t3-bold text-base">
              {global ? "전역 답변 스타일" : "이 대화의 답변 스타일"}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="답변 스타일 닫기"
              disabled={pending}
              onPress={close}
              className="px-3 py-2"
            >
              <Text>닫기</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 20, paddingBottom: 20 + insets.bottom, gap: 16 }}
          >
            <Text className="text-xs text-muted-foreground">
              {global
                ? "이 서버의 모든 대화에 다음 요청부터 적용됩니다. 오케스트라에서는 최종 답변에 적용됩니다. 현재 요청의 지시가 우선합니다."
                : "이 대화에만 적용됩니다. 저장하면 전역 답변 스타일 대신 이 스타일로 답합니다. 비워 두면 전역 답변 스타일을 따릅니다."}
            </Text>
            {!ready ? (
              <Text accessibilityRole="alert">
                환경 설정을 불러오는 중입니다. 연결을 확인해 주세요.
              </Text>
            ) : null}
            <Text className="font-t3-bold text-foreground">프리셋</Text>
            <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
              {PRESETS.map(([value, label]) => (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{
                    selected: draft.preset === value,
                    disabled: pending || !ready,
                  }}
                  disabled={pending || !ready}
                  className="rounded-lg border border-border p-3"
                  onPress={() => change({ preset: value })}
                >
                  <Text className="text-foreground">
                    {draft.preset === value ? "●" : "○"} {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {(
              [
                ["tone", "말투"],
                ["length", "답변 길이"],
                ["explanation", "설명 방식"],
                ["instructions", "자유 지시"],
              ] as const
            ).map(([key, label]) => (
              <View key={key} className="gap-2">
                <Text className="font-t3-bold text-foreground">{label}</Text>
                <TextInput
                  accessibilityLabel={label}
                  editable={Boolean(settings) && !pending}
                  multiline={key === "instructions"}
                  value={draft[key]}
                  className="rounded-lg border border-border p-3 text-foreground"
                  onChangeText={(value) => change({ [key]: value })}
                />
              </View>
            ))}
            <Text className="text-xs text-muted-foreground">
              캐릭터의 말투와 겹치면 답변 스타일을 우선합니다.
            </Text>
            {error ? (
              <Text accessibilityRole="alert" className="text-destructive">
                {error}
              </Text>
            ) : null}
            {message ? <Text accessibilityRole="alert">{message}</Text> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="답변 스타일 저장"
              accessibilityState={{
                disabled:
                  !ready || pending || (!dirty && !(global && !settings?.globalResponseStyle)),
              }}
              disabled={
                !ready || pending || (!dirty && !(global && !settings?.globalResponseStyle))
              }
              onPress={() => void save()}
              className="rounded-lg border border-border p-3"
            >
              <Text className="text-center font-t3-bold text-foreground">
                {pending ? "저장 중…" : "저장"}
              </Text>
            </Pressable>
            {global && settings?.globalResponseStyle ? (
              <Pressable
                accessibilityRole="button"
                disabled={pending}
                onPress={() => void save(true)}
              >
                <Text>전역 스타일 해제</Text>
              </Pressable>
            ) : null}
            {threadId !== undefined && roomCustom ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="전역 스타일 사용"
                disabled={pending}
                onPress={() => void save(true)}
              >
                <Text>전역 스타일 사용</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
