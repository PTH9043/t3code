import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  handoffDescription,
  handoffMeasurementNote,
  handoffReportText,
  latestHandoffReport,
} from "@t3tools/client-runtime/state/conversation-handoff";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState } from "react";
import { Switch, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useThreadShell } from "../../state/entities";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function HandoffSettings(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  busy: boolean;
}) {
  const ref = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const thread = useThreadShell(ref);
  const activities = useAtomValue(environmentThreadDetails.activitiesAtom(ref));
  const latest = useMemo(() => latestHandoffReport(activities), [activities]);
  const latestInput = useMemo(() => latestInputComposition(activities), [activities]);
  const update = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  return (
    <View className="gap-2 border-t border-border pt-3">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 font-t3-bold">
          {saving ? "저장 중…" : "이 대화의 인계 문맥 절약"}
        </Text>
        <Switch
          accessibilityLabel="이 대화의 인계 문맥 절약"
          value={thread?.handoffMode === "compact"}
          disabled={saving || props.busy || thread?.handoffMode === undefined}
          onValueChange={(enabled) => {
            setSaving(true);
            setError(false);
            void update({
              environmentId: props.environmentId,
              input: { threadId: props.threadId, handoffMode: enabled ? "compact" : "standard" },
            })
              .then((result) => setError(result._tag === "Failure"))
              .finally(() => setSaving(false));
          }}
        />
      </View>
      <Text className="text-xs text-muted-foreground">{handoffDescription}</Text>
      <Text className="text-xs text-muted-foreground">
        해제하면 다음 인계부터 기존 방식으로 돌아갑니다.
      </Text>
      {thread?.handoffMode === undefined ? (
        <Text className="text-xs">서버의 지원 여부를 확인할 수 없습니다.</Text>
      ) : null}
      {props.busy ? <Text className="text-xs">작업이 끝난 뒤 설정을 바꿀 수 있습니다.</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-xs text-destructive">
          설정을 저장하지 못했습니다. 연결·권한을 확인하고 다시 시도하세요.
        </Text>
      ) : null}
      {latest ? (
        <>
          <Text className="text-xs">
            최근 준비 · {new Date(latest.createdAt).toLocaleString("ko-KR")}
          </Text>
          <Text className="text-xs">{handoffReportText(latest.report)}</Text>
        </>
      ) : (
        <Text className="text-xs">현재 불러온 기록에 인계 비교가 없습니다.</Text>
      )}
      <Text className="text-xs text-muted-foreground">{handoffMeasurementNote}</Text>
      {latestInput ? (
        <Text className="border-t border-border pt-2 text-xs">
          {inputCompositionText(latestInput.report)}
        </Text>
      ) : null}
    </View>
  );
}
import {
  latestInputComposition,
  inputCompositionText,
} from "@t3tools/client-runtime/state/token-usage";
