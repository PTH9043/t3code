import { WorkspaceAgentControlPanel } from "./WorkspaceAgentControlPanel";
import { useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import type {
  EnvironmentId,
  WorkspaceCollaborationRun,
  WorkspaceOrchestraPlanEdit,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { projectEnvironment } from "../../state/projects";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const INPUT = "rounded-lg border border-border bg-card p-2 text-sm text-foreground";
export function OrchestraRunControls({
  environmentId,
  run,
}: {
  environmentId: EnvironmentId;
  run: WorkspaceCollaborationRun;
}) {
  return (
    <View className="gap-2">
      {run.status === "running" && run.graph?.planReview?.status === "pending" && (
        <PlanEditor
          key={run.id + ":" + run.graph.planReview.revision}
          environmentId={environmentId}
          run={run}
        />
      )}
      {run.graph && (run.meeting?.threadId || run.graph.nodes.some((node) => node.threadId)) && (
        <WorkspaceAgentControlPanel environmentId={environmentId} run={run} />
      )}
      {run.graph?.delivery && (
        <View className="gap-2 rounded-xl bg-fill p-3">
          <Text className="font-t3-bold text-foreground">
            {
              {
                verifying: "실제 검증 중",
                passed: "검증 통과",
                failed: "검증 실패",
                "needs-verification": "검증 명령 필요",
                "awaiting-integration": "변경 통합 대기",
              }[run.graph.delivery.status]
            }
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {run.graph.delivery.detail}
          </Text>
          {run.graph.delivery.commands.map((receipt) => (
            <Text key={receipt.logPath} selectable className="text-xs text-foreground-muted">
              {receipt.command} · 종료 코드 {receipt.exitCode ?? "없음"}
              {receipt.timedOut ? " · 시간 초과" : ""}
              {"\n"}
              {receipt.logPath}
            </Text>
          ))}
          {run.graph.delivery.worktrees.map((path) => (
            <Text key={path} selectable className="text-xs text-foreground-muted">
              {path}
            </Text>
          ))}
          {run.status === "running" && run.graph.delivery.status !== "verifying" && (
            <RetryVerification environmentId={environmentId} run={run} />
          )}
        </View>
      )}
    </View>
  );
}
function PlanEditor({
  environmentId,
  run,
}: {
  environmentId: EnvironmentId;
  run: WorkspaceCollaborationRun;
}) {
  const graph = run.graph!;
  const nodes = graph.nodes.filter(
    (node) =>
      node.id !== "plan" &&
      ["orchestration", "research", "implementation", "debug"].includes(node.kind),
  );
  const gates = new Map(
    graph.nodes.flatMap((node) =>
      node.validationTargetId === null ? [] : [[node.id, node.validationTargetId] as const],
    ),
  );
  const [edits, setEdits] = useState<ReadonlyArray<WorkspaceOrchestraPlanEdit>>(() =>
    nodes.map((node) => ({
      nodeId: node.id,
      title: node.title,
      task: node.handoff.task,
      participantId: node.participantId,
      dependsOn: node.dependsOn.flatMap((id) => {
        const producer = gates.get(id) ?? id;
        return nodes.some((candidate) => candidate.id === producer) ? [producer] : [];
      }),
    })),
  );
  const [busy, setBusy] = useState(false);
  const review = useAtomCommand(projectEnvironment.reviewWorkspaceCollaborationRun, {
    label: "실행 계획 확인",
    reportFailure: true,
  });
  const runs = useEnvironmentQuery(
    orchestrationEnvironment.workspaceCollaborationRuns({
      environmentId,
      input: { projectId: run.projectId },
    }),
  );
  const update = (id: string, patch: Partial<WorkspaceOrchestraPlanEdit>) =>
    setEdits((current) =>
      current.map((edit) => (edit.nodeId === id ? { ...edit, ...patch } : edit)),
    );
  const submit = async (approve: boolean) => {
    setBusy(true);
    try {
      if (edits.some((edit) => !edit.title.trim() || !edit.task.trim())) {
        Alert.alert("작업 이름과 지시를 입력하세요.");
        return;
      }
      const result = await review({
        environmentId,
        input: {
          projectId: run.projectId,
          runId: run.id,
          expectedRevision: graph.planReview!.revision,
          edits: edits.map((edit) => ({
            ...edit,
            title: edit.title.trim(),
            task: edit.task.trim(),
          })),
          approve,
        },
      });
      if (result._tag === "Success") runs.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 rounded-xl bg-fill p-3">
      <Text className="font-t3-bold text-foreground">실행 계획 확인</Text>
      <Text className="text-xs text-foreground-muted">
        계획을 수정한 뒤 저장하거나 시작하세요. 아직 실행하지 않았습니다.
      </Text>
      {edits.map((edit) => (
        <View key={edit.nodeId} className="gap-2 rounded-lg border border-border p-2">
          <TextInput
            accessibilityLabel="작업 이름"
            className={INPUT}
            editable={!busy}
            value={edit.title}
            maxLength={200}
            onChangeText={(title) => update(edit.nodeId, { title })}
          />
          <TextInput
            accessibilityLabel="작업 지시"
            className={INPUT}
            multiline
            editable={!busy}
            value={edit.task}
            maxLength={8000}
            onChangeText={(task) => update(edit.nodeId, { task })}
          />
          <Text className="text-xs text-foreground-muted">담당 AI</Text>
          {run.meeting?.participants.map((seat) => (
            <Pressable
              key={seat.id}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ selected: edit.participantId === seat.id }}
              onPress={() => update(edit.nodeId, { participantId: seat.id })}
            >
              <Text className="py-1 text-xs text-foreground">
                {edit.participantId === seat.id ? "●" : "○"} {seat.displayName} ·{" "}
                {seat.modelSelection.model}
              </Text>
            </Pressable>
          ))}
          <Text className="text-xs text-foreground-muted">먼저 끝나야 하는 작업</Text>
          {nodes
            .filter((node) => node.id !== edit.nodeId)
            .map((node) => (
              <Pressable
                key={node.id}
                disabled={busy}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: edit.dependsOn.includes(node.id) }}
                onPress={() =>
                  update(edit.nodeId, {
                    dependsOn: edit.dependsOn.includes(node.id)
                      ? edit.dependsOn.filter((id) => id !== node.id)
                      : [...edit.dependsOn, node.id],
                  })
                }
              >
                <Text className="py-1 text-xs text-foreground">
                  {edit.dependsOn.includes(node.id) ? "☑" : "☐"} {node.title}
                </Text>
              </Pressable>
            ))}
        </View>
      ))}
      <Pressable disabled={busy} accessibilityRole="button" onPress={() => void submit(false)}>
        <Text className="p-2 text-sm text-foreground">계획만 저장</Text>
      </Pressable>
      <Pressable disabled={busy} accessibilityRole="button" onPress={() => void submit(true)}>
        <Text className="p-2 text-sm font-t3-bold text-foreground">이 계획으로 시작</Text>
      </Pressable>
    </View>
  );
}
function RetryVerification({
  environmentId,
  run,
}: {
  environmentId: EnvironmentId;
  run: WorkspaceCollaborationRun;
}) {
  const [commands, setCommands] = useState((run.orchestra?.verificationCommands ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const verify = useAtomCommand(projectEnvironment.verifyWorkspaceCollaborationRun, {
    label: "오케스트라 결과 검증",
    reportFailure: true,
  });
  const runs = useEnvironmentQuery(
    orchestrationEnvironment.workspaceCollaborationRuns({
      environmentId,
      input: { projectId: run.projectId },
    }),
  );
  const submit = async () => {
    setBusy(true);
    try {
      const result = await verify({
        environmentId,
        input: {
          projectId: run.projectId,
          runId: run.id,
          verificationCommands: commands
            .split(/\r?\n/u)
            .map((command) => command.trim())
            .filter(Boolean),
        },
      });
      if (result._tag === "Success") runs.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel="검증 명령"
        className={INPUT}
        multiline
        editable={!busy}
        maxLength={4000}
        value={commands}
        onChangeText={setCommands}
      />
      <Pressable disabled={busy} accessibilityRole="button" onPress={() => void submit()}>
        <Text className="p-2 text-sm text-foreground">통합 상태 확인 · 다시 검증</Text>
      </Pressable>
    </View>
  );
}
