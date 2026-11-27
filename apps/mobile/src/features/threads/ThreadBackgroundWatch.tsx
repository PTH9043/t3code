import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadBackgroundWatch({
  environmentId,
  threadId,
  connected,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  connected: boolean;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const [open, setOpen] = useState(false);
  const ids = settings?.backgroundWatchThreadIds;
  const [receipt, setReceipt] = useState<{
    previous: readonly ThreadId[];
    enabled: boolean;
  } | null>(null);
  // Use the acknowledged value until the settings stream delivers its next list.
  const enabled =
    receipt && receipt.previous === ids ? receipt.enabled : (ids?.includes(threadId) ?? false);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const ready = connected && Array.isArray(ids);
  const status = !ready ? "확인 필요" : saving ? "저장 중" : enabled ? "켜짐" : "꺼짐";
  async function change(next: boolean) {
    if (!ready || inFlight.current || next === enabled) return;
    inFlight.current = true;
    setSaving(true);
    setFailed(false);
    try {
      const result = await update({
        environmentId,
        input: { patch: { backgroundWatchThreadUpdate: { threadId, enabled: next } } },
      });
      if (
        result._tag === "Failure" ||
        !Array.isArray(result.value.backgroundWatchThreadIds) ||
        result.value.backgroundWatchThreadIds.includes(threadId) !== next
      ) {
        setFailed(true);
      } else {
        setReceipt({ previous: ids, enabled: next });
      }
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`이 대화의 백그라운드 감시 · ${status}`}
        onPress={() => setOpen(true)}
        className="px-2 py-2"
      >
        <Text className="text-xs text-muted-foreground">감시 {status}</Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-background">
          <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
            <Text accessibilityRole="header" className="font-t3-bold text-foreground">
              이 대화의 백그라운드 감시
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="감시 설정 닫기"
              onPress={() => setOpen(false)}
              className="px-3 py-2"
            >
              <Text>닫기</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
            <View className="flex-row items-center justify-between gap-2">
              <Text className="text-foreground">감시 {status}</Text>
              {ready && (
                <Switch
                  accessibilityLabel="이 대화의 백그라운드 감시"
                  value={enabled}
                  disabled={saving}
                  onValueChange={change}
                />
              )}
            </View>
            <Text className="text-sm text-muted-foreground">
              켜면 이 대화에서 백그라운드 감시를 사용할 수 있습니다. 끄면 이 대화의 감시만 중지되고
              진행 중인 답변은 계속됩니다.
            </Text>
            {!ready && (
              <Text accessibilityRole="alert">
                감시 설정을 확인할 수 없습니다. 서버 연결을 확인해 주세요.
              </Text>
            )}
            {failed && (
              <Text accessibilityRole="alert" className="text-destructive">
                감시 설정 변경을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.
              </Text>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
