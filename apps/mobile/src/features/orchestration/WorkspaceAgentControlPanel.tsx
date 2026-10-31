import { useRef, useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type {
  EnvironmentId,
  WorkspaceCollaborationRun,
  WorkspaceAgentControlAction,
} from "@t3tools/contracts";
import { agentControlStatusLabels } from "@t3tools/client-runtime/state/presentation";
import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
type Props = { environmentId: EnvironmentId; run: WorkspaceCollaborationRun };
export function WorkspaceAgentControlPanel(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-2 rounded-xl border border-border bg-card p-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text className="font-t3-bold text-foreground">
          작업자 메시지 · 실제 인계 입력 {open ? "▴" : "▾"}
        </Text>
      </Pressable>
      {props.run.graph?.nodes
        .filter(
          (n) => n.usageRecovery?.phase === "waiting" && ["queued", "blocked"].includes(n.status),
        )
        .map((n) => (
          <Text key={n.id} className="text-xs text-foreground-muted">
            사용량 제한 대기 · {n.title} · {n.usageRecovery!.resumeAt} 이후 재개 (
            {n.usageRecovery!.count}/3)
          </Text>
        ))}
      {open && <Mailbox {...props} />}
    </View>
  );
}
function Mailbox({ environmentId, run }: Props) {
  const lookup = { projectId: run.projectId, runId: run.id };
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workspaceAgentControl({ environmentId, input: lookup }),
  );
  const action = useAtomCommand(orchestrationEnvironment.actOnAgentControl, {
    reportFailure: true,
  });
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<string | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const targets =
    run.graph?.nodes.filter(
      (n) => !["completed", "failed", "cancelled", "skipped"].includes(n.status),
    ) ?? [];
  const destination = targets.find((n) => n.id === target)?.id ?? targets[0]?.id;
  const live = run.status === "running" || run.status === "queued";
  const mutate = async (input: WorkspaceAgentControlAction) => {
    setBusy(true);
    try {
      const receipt = await action({ environmentId, input });
      if (receipt._tag === "Success") {
        result.refresh();
        return true;
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2">
      <Text className="text-xs text-foreground-muted">
        대기 메시지는 다음 작업 입력에 포함됩니다. 실행 중인 AI는 메시지함 도구로 새 내용을 확인할
        수 있습니다.
      </Text>
      {live && targets.length > 0 && (
        <>
          {targets.map((n) => (
            <Pressable
              key={n.id}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ selected: destination === n.id }}
              onPress={() => setTarget(n.id)}
            >
              <Text className="py-1 text-xs text-foreground">
                {destination === n.id ? "●" : "○"} {n.title}
              </Text>
            </Pressable>
          ))}
          <TextInput
            accessibilityLabel="작업자 메시지"
            className="rounded-lg border border-border bg-card p-2 text-sm text-foreground"
            multiline
            editable={!busy}
            maxLength={8000}
            value={text}
            onChangeText={setText}
            placeholder="작업자에게 전달할 내용"
          />
          <Pressable
            disabled={busy || !text.trim()}
            accessibilityRole="button"
            onPress={() =>
              void (async () => {
                if (!destination || !text.trim()) return;
                const key = destination + ":" + text.trim();
                if (request.current?.key !== key) request.current = { key, id: uuidv4() };
                if (
                  await mutate({
                    ...lookup,
                    action: "send",
                    requestId: request.current.id,
                    toNodeId: destination,
                    text: text.trim(),
                  })
                ) {
                  setText("");
                  request.current = null;
                }
              })()
            }
          >
            <Text className="py-2 text-sm text-primary">메시지 전송</Text>
          </Pressable>
        </>
      )}
      {result.error && <Text className="text-xs text-red-600">{result.error}</Text>}
      {result.data?.records.toReversed().map((record) => (
        <View key={record.id} className="gap-1 border-t border-border py-2">
          <Text className="text-xs font-t3-bold text-foreground">
            {record.title} · {agentControlStatusLabels[record.status]}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {record.text}
          </Text>
          {record.recordType === "handoff" && (
            <Pressable
              accessibilityRole="button"
              onPress={() => setEvidence(evidence === record.id ? null : record.id)}
            >
              <Text className="py-2 text-xs text-primary">
                실제 입력 원문 {evidence === record.id ? "닫기" : "보기"}
              </Text>
            </Pressable>
          )}
          {evidence === record.id && (
            <InputEvidence environmentId={environmentId} run={run} recordId={record.id} />
          )}
          {live &&
            record.recordType === "message" &&
            ["queued", "unknown"].includes(record.status) && (
              <Pressable
                disabled={busy}
                onPress={() =>
                  void mutate({
                    ...lookup,
                    action: "cancel",
                    recordId: record.id,
                    expectedRevision: record.revision,
                  })
                }
              >
                <Text className="py-2 text-xs text-primary">메시지 취소</Text>
              </Pressable>
            )}
          {live && record.recordType === "message" && record.status === "unknown" && (
            <Pressable
              disabled={busy}
              onPress={() =>
                Alert.alert(
                  "메시지 재전송",
                  "이미 전달됐을 수 있습니다. 같은 내용을 다시 대기열에 넣을까요?",
                  [
                    { text: "닫기", style: "cancel" },
                    {
                      text: "재전송",
                      onPress: () =>
                        void mutate({
                          ...lookup,
                          action: "requeue",
                          recordId: record.id,
                          expectedRevision: record.revision,
                        }),
                    },
                  ],
                )
              }
            >
              <Text className="py-2 text-xs text-primary">재전송 선택</Text>
            </Pressable>
          )}
        </View>
      ))}
      <Text className="text-xs text-foreground-muted">
        최근 {result.data?.records.length ?? 0}개 · 전체 {result.data?.total ?? 0}개 보존
      </Text>
      <Pressable onPress={result.refresh}>
        <Text className="py-2 text-xs text-primary">기록 새로고침</Text>
      </Pressable>
    </View>
  );
}
function InputEvidence({ environmentId, run, recordId }: Props & { recordId: string }) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.agentControlEvidence({
      environmentId,
      input: { projectId: run.projectId, runId: run.id, recordId },
    }),
  );
  return (
    <View className="gap-2">
      <Text className="text-xs text-foreground-muted">
        앱에서 CLI로 전달한 작업 입력 · 제공자 내부 시스템 지시 제외
      </Text>
      {result.error && <Text className="text-xs text-red-600">{result.error}</Text>}
      {result.data && (
        <>
          <Text selectable className="text-xs text-foreground-muted">
            SHA-256 {result.data.record.sourceHash}
          </Text>
          <Pressable
            onPress={() =>
              void Clipboard.setStringAsync(result.data!.text).catch(() =>
                Alert.alert("원문 복사 실패"),
              )
            }
          >
            <Text className="py-2 text-xs text-primary">원문 전체 복사</Text>
          </Pressable>
          <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
            <Text selectable className="text-xs text-foreground">
              {result.data.text}
            </Text>
          </ScrollView>
        </>
      )}
    </View>
  );
}
