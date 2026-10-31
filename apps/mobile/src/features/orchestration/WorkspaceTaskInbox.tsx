import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import type {
  EnvironmentId,
  ProjectId,
  WorkspaceTaskInputs,
  WorkspaceTaskAction,
} from "@t3tools/contracts";
import {
  taskInboxStatus,
  taskInboxActions,
  taskInboxActionLabels,
} from "@t3tools/client-runtime/state/task-inbox";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";

function TaskDetail({
  environmentId,
  projectId,
  taskId,
  close,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  taskId: string;
  close: () => void;
}) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.taskInboxTask({ environmentId, input: { projectId, taskId } }),
  );
  const task = result.data;
  return (
    <View className="gap-2 rounded-xl border border-border p-3">
      <Pressable accessibilityRole="button" onPress={close}>
        <Text className="text-primary">실행 자료 닫기</Text>
      </Pressable>
      {result.error ? <ErrorBanner message={result.error} /> : null}
      {task ? (
        <>
          <Text className="text-sm text-foreground">
            {task.recipe.name} v{task.recipe.revision} · {taskInboxStatus[task.status]} · 시도{" "}
            {task.attempt + 1}
          </Text>
          {Object.entries(task.inputs).map(([key, value]) => (
            <Text key={key} selectable className="text-xs text-foreground-muted">
              {key}: {value}
            </Text>
          ))}
          {task.receipts.map((receipt) => (
            <View
              key={`${receipt.kind}:${receipt.label}:${receipt.observedAt}:${receipt.sha256}`}
              className="gap-1 border-t border-border pt-2"
            >
              <Text selectable className="text-xs text-foreground">
                {receipt.passed ? "통과" : "실패"} · {receipt.label} · 종료 코드{" "}
                {receipt.exitCode ?? "해당 없음"}
              </Text>
              <Text selectable className="text-xs text-foreground-muted">
                {receipt.output}
              </Text>
              {receipt.sha256 ? (
                <Text selectable className="text-xs text-foreground-muted">
                  SHA-256 {receipt.sha256}
                </Text>
              ) : null}
            </View>
          ))}
          <Text selectable className="text-xs text-foreground">
            {task.output || "저장된 최종 출력 없음"}
          </Text>
        </>
      ) : null}
      <Pressable accessibilityRole="button" onPress={result.refresh}>
        <Text className="text-primary">자료 새로고침</Text>
      </Pressable>
    </View>
  );
}

export function WorkspaceTaskInbox({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.taskInbox({ environmentId, input: { projectId } }),
  );
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState("");
  const [inputs, setInputs] = useState<WorkspaceTaskInputs>({});
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = useAtomCommand(orchestrationEnvironment.submitInboxTask, { reportFailure: false });
  const act = useAtomCommand(orchestrationEnvironment.actOnInboxTask, { reportFailure: false });
  const recipe = result.data?.recipes.find((item) => item.id === selected);

  const send = async () => {
    if (!recipe) return;
    setBusy(true);
    setError(null);
    try {
      const response = await submit({
        environmentId,
        input: {
          projectId,
          recipeId: recipe.id,
          recipeRevision: recipe.revision,
          inputs,
          source: "mobile",
          externalId: uuidv4(),
        },
      });
      if (response._tag === "Failure")
        setError("업무를 접수하지 못했습니다. 필수 입력과 양식 상태를 확인하세요.");
      else result.refresh();
    } finally {
      setBusy(false);
    }
  };
  const action = async (taskId: string, value: WorkspaceTaskAction["action"]) => {
    setBusy(true);
    setError(null);
    try {
      const response = await act({ environmentId, input: { projectId, taskId, action: value } });
      if (response._tag === "Failure")
        setError(
          "현재 상태에서는 이 동작을 수행하지 못했습니다. 새로고침 후 실행 상태를 확인하세요.",
        );
      else result.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-semibold text-foreground">자동 업무 접수함</Text>
        <Pressable accessibilityRole="button" onPress={result.refresh}>
          <Text className="text-primary">새로고침</Text>
        </Pressable>
      </View>
      {result.error || error ? (
        <ErrorBanner message={error ?? result.error ?? "조회 실패"} />
      ) : null}
      <Text className="text-xs text-foreground-muted">
        전체 {result.data?.totalTasks ?? 0} · 결과 검사 통과 {result.data?.completed ?? 0} · AI 생략{" "}
        {result.data?.aiSkipped ?? 0} · 진행·보류 {result.data?.waiting ?? 0}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="rounded-xl border border-border p-3"
      >
        <Text className="text-foreground">
          {expanded ? "접수·작업 기록 접기" : "업무 접수·기록 펼치기"}
        </Text>
      </Pressable>
      {expanded ? (
        <>
          <Text className="text-xs text-foreground-muted">
            업무 양식은 웹·데스크톱의 자동 작업 성과 화면에서 편집합니다.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {result.data?.recipes
              .filter((item) => item.enabled)
              .map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: selected === item.id }}
                  onPress={() => {
                    setSelected(item.id);
                    setInputs({});
                  }}
                  className="rounded-xl border border-border p-2"
                >
                  <Text className="text-xs text-foreground">
                    {selected === item.id ? "✓ " : ""}
                    {item.name} v{item.revision}
                  </Text>
                </Pressable>
              ))}
          </View>
          {recipe?.parameters.map((field) => (
            <View key={field.name} className="gap-1">
              <Text className="text-sm text-foreground">
                {field.label}
                {field.required ? " *" : ""}
              </Text>
              <TextInput
                accessibilityLabel={field.label}
                multiline
                value={inputs[field.name] ?? field.defaultValue}
                onChangeText={(value) =>
                  setInputs((current) => ({ ...current, [field.name]: value }))
                }
                className="min-h-12 rounded-xl border border-border p-3 text-foreground"
              />
            </View>
          ))}
          {recipe ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy || !recipe.enabled}
              onPress={() => void send()}
              className="rounded-xl border border-border p-3"
            >
              <Text className="text-center text-primary">업무 접수</Text>
            </Pressable>
          ) : null}
          {result.data?.tasks.map((task) => (
            <View key={task.id} className="gap-2 border-t border-border pt-3">
              <Text className="text-sm text-foreground">
                {task.recipeName} v{task.recipeRevision} · {taskInboxStatus[task.status]}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {task.source} · {task.externalId} · 시도 {task.attempt + 1}
              </Text>
              {task.error ? (
                <Text className="text-xs text-foreground-muted">{task.error}</Text>
              ) : null}
              {task.status === "delivery-unknown" ? (
                <Text className="text-xs text-foreground-muted">
                  이미 수행된 변경을 먼저 확인하세요. 새 시도는 업무를 다시 수행합니다.
                </Text>
              ) : null}
              <View className="flex-row flex-wrap gap-2">
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDetail(task.id)}
                  className="rounded-lg border border-border p-2"
                >
                  <Text className="text-xs text-primary">입력·실행 자료</Text>
                </Pressable>
                {taskInboxActions(task.status, !!task.runId).map((value) => (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void action(task.id, value)}
                    className="rounded-lg border border-border p-2"
                  >
                    <Text className="text-xs text-primary">{taskInboxActionLabels[value]}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
          {detail ? (
            <TaskDetail
              environmentId={environmentId}
              projectId={projectId}
              taskId={detail}
              close={() => setDetail(null)}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}
