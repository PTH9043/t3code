import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function NoticeSecondsRow({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const value = draft ?? String(settings?.backgroundWatchNoticeSeconds ?? "");
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
  const canSave =
    settings != null &&
    Number.isInteger(seconds) &&
    seconds !== settings.backgroundWatchNoticeSeconds &&
    !saving;
  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(false);
    try {
      const result = await update({
        environmentId,
        input: { patch: { backgroundWatchNoticeSeconds: seconds } },
      });
      if (result._tag === "Success") setDraft(null);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <View className="gap-2 px-4 py-3">
      <Text>감시 중단 알림 표시 시간 · {label}</Text>
      <Text className="text-sm text-foreground-muted">
        중단 시각부터 표시할 시간입니다. 0초로 설정하면 알림을 숨깁니다.
      </Text>
      <View className="flex-row items-center gap-2">
        <TextInput
          accessibilityLabel={label + " 감시 중단 알림 표시 시간(초)"}
          className="min-w-16 rounded-lg bg-surface px-3 py-2 text-foreground"
          value={value}
          editable={settings != null && !saving}
          keyboardType="number-pad"
          onChangeText={setDraft}
        />
        <Text>초</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label + " 중단 알림 시간 저장"}
          disabled={!canSave}
          onPress={save}
          className="px-3 py-2 disabled:opacity-50"
        >
          <Text>{saving ? "저장 중" : "저장"}</Text>
        </Pressable>
      </View>
      {error && (
        <Text accessibilityRole="alert">
          저장하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.
        </Text>
      )}
    </View>
  );
}

export function BackgroundWatchNoticeSettings() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId, label }) => (
    <NoticeSecondsRow key={environmentId} environmentId={environmentId} label={label} />
  ));
}
