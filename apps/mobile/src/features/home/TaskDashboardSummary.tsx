import { AttentionInbox } from "../orchestration/AttentionInbox";
import { useState } from "react";
import { Pressable, View } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  classifyDashboardTask,
  TASK_GROUPS,
  taskGroupLabels,
  type TaskGroup,
} from "@t3tools/client-runtime/state/task-dashboard";
import { AppText as Text } from "../../components/AppText";

export function TaskDashboardSummary(props: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  onSelect: (thread: EnvironmentThreadShell) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [group, setGroup] = useState<TaskGroup>("needs-input");
  const now = new Date().toISOString();
  const threads = props.threads.filter((thread) => !thread.archivedAt);
  const groups = TASK_GROUPS.map((id) => ({
    id,
    threads: threads.filter((thread) => classifyDashboardTask(thread, now) === id),
  }));
  return (
    <>
      <AttentionInbox threads={props.threads} onSelect={props.onSelect} />
      <View className="mx-3 mb-3 gap-2 rounded-xl border border-border bg-card p-3">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
        >
          <Text className="font-semibold text-foreground">작업 상태 {expanded ? "⌃" : "⌄"}</Text>
          <Text className="mt-1 text-xs text-muted-foreground">
            {groups
              .slice(0, 4)
              .map((item) => `${taskGroupLabels[item.id]} ${item.threads.length}`)
              .join(" · ")}
          </Text>
        </Pressable>
        {expanded ? (
          <>
            <View className="flex-row flex-wrap gap-2">
              {groups.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: group === item.id }}
                  onPress={() => setGroup(item.id)}
                  className={`rounded-lg border p-2 ${group === item.id ? "border-primary bg-primary/10" : "border-border"}`}
                >
                  <Text className="text-xs text-foreground">
                    {taskGroupLabels[item.id]} {item.threads.length}
                  </Text>
                </Pressable>
              ))}
            </View>
            {groups
              .find((item) => item.id === group)
              ?.threads.slice(0, 8)
              .map((thread) => (
                <Pressable
                  key={`${thread.environmentId}:${thread.id}`}
                  accessibilityRole="button"
                  onPress={() => props.onSelect(thread)}
                  className="border-t border-border py-2"
                >
                  <Text className="text-sm text-foreground">{thread.title}</Text>
                  {thread.planProgress ? (
                    <Text className="text-xs text-muted-foreground">
                      {thread.planProgress.completedSteps}/{thread.planProgress.totalSteps} ·{" "}
                      {thread.planProgress.step}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            <Text className="text-xs text-muted-foreground">
              완료는 AI 응답 완료입니다. 검증 결과와 하위 작업은 대화에서 확인하세요.
            </Text>
          </>
        ) : null}
      </View>
    </>
  );
}
