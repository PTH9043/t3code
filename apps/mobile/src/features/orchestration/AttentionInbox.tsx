import { useState } from "react";
import { Pressable, View } from "react-native";
import { CommonActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  attentionKindLabels,
  threadAttentionItems,
} from "@t3tools/client-runtime/state/presentation";
import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

export function AttentionInbox({
  threads,
  onSelect,
  environmentId,
  projectId,
}: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  onSelect: (thread: EnvironmentThreadShell) => void;
  environmentId?: EnvironmentId;
  projectId?: ProjectId;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const items = threadAttentionItems(
    threads.filter(
      (t) =>
        (!environmentId || t.environmentId === environmentId) &&
        (!projectId || t.projectId === projectId),
    ),
  );
  const environments = environmentId
    ? [environmentId]
    : [...new Set(threads.map((t) => t.environmentId))];
  return (
    <View className="mx-3 mb-3 gap-2 rounded-xl border border-border bg-card p-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text className="font-t3-bold text-foreground">
          확인함 · 대화 요청 {items.length}개 {open ? "▴" : "▾"}
        </Text>
        <Text className="text-xs text-foreground-muted">질문·승인·계획·오류·제한 대기</Text>
      </Pressable>
      {open && (
        <>
          {(expanded ? items : items.slice(0, 8)).map((item) => (
            <Pressable
              key={item.id}
              onPress={() => onSelect(item.thread)}
              className="border-t border-border py-2"
            >
              <Text className="text-xs text-primary">{attentionKindLabels[item.kind]}</Text>
              <Text className="text-sm text-foreground">{item.thread.title}</Text>
            </Pressable>
          ))}
          {items.length > 8 && (
            <Pressable onPress={() => setExpanded(!expanded)}>
              <Text className="text-xs text-primary">
                {expanded ? "접기" : "대화 요청 모두 보기"}
              </Text>
            </Pressable>
          )}
          {environments.map((id) => (
            <RunAttention key={id} environmentId={id} {...(projectId ? { projectId } : {})} />
          ))}
        </>
      )}
    </View>
  );
}
function RunAttention({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
}) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workspaceAttention({
      environmentId,
      input: projectId ? { projectId } : {},
    }),
  );
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const items = result.data?.items ?? [];
  return (
    <View className="gap-2">
      {result.error && <Text className="text-xs text-red-600">{result.error}</Text>}
      {(expanded ? items : items.slice(0, 8)).map((item) => (
        <Pressable
          key={item.id}
          className="border-t border-border py-2"
          onPress={() =>
            navigation.dispatch(
              CommonActions.navigate({
                name: "WorkspaceCollaborationRuns",
                params: { environmentId, projectId: item.projectId },
              }),
            )
          }
        >
          <Text className="text-xs text-primary">{item.title}</Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            {item.detail}
          </Text>
        </Pressable>
      ))}
      {items.length > 8 && (
        <Pressable onPress={() => setExpanded(!expanded)}>
          <Text className="text-xs text-primary">{expanded ? "접기" : "실행 요청 모두 보기"}</Text>
        </Pressable>
      )}
    </View>
  );
}
