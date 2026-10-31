import { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import type {
  EnvironmentId,
  ProjectId,
  WorkflowVersion,
  WorkspaceCollaborationRun,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { uuidv4 as randomUUID } from "../../lib/uuid";
import { workspaceRunControl } from "@t3tools/shared/workflow";

function Action({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className="rounded-lg border border-border px-3 py-2"
    >
      <Text className="text-xs text-foreground">{label}</Text>
    </Pressable>
  );
}

export function WorkflowRunControls({
  environmentId,
  run,
  refresh,
}: {
  environmentId: EnvironmentId;
  run: WorkspaceCollaborationRun;
  refresh?: () => void;
}) {
  const command = useAtomCommand(orchestrationEnvironment.controlWorkflow, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runControl = workspaceRunControl(run);
  const control = async (action: "pause" | "resume" | "retry", nodeId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await command({
        environmentId,
        input: {
          projectId: run.projectId,
          runId: run.id,
          action,
          expectedRevision: runControl.controlRevision,
          ...(nodeId ? { nodeId } : {}),
        },
      });
      if (result._tag !== "Success")
        setError(
          "실행 상태가 변경되었거나 이전 입력의 종료가 미확인입니다. 최신 기록을 확인하세요.",
        );
      refresh?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2 rounded-xl border border-border p-3">
      <Text className="text-xs text-foreground">
        {run.workflow ? `${run.workflow.title} v${run.workflow.definitionRevision}` : "AI 작업"} ·{" "}
        {runControl.control === "paused"
          ? "일시정지"
          : runControl.control === "pause-requested"
            ? "진행 단계 정리 중"
            : "실행 제어 활성"}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {["queued", "running"].includes(run.status) ? (
          <Action
            disabled={busy}
            label={runControl.control === "active" ? "일시정지" : "재개"}
            onPress={() => void control(runControl.control === "active" ? "pause" : "resume")}
          />
        ) : null}
        {run.status === "failed"
          ? run.graph?.nodes
              .filter((node) => node.status === "failed" && node.attempts.length > 0)
              .map((node) => (
                <Action
                  key={node.id}
                  disabled={busy}
                  label={`${node.title} 재시도`}
                  onPress={() => void control("retry", node.id)}
                />
              ))
          : null}
      </View>
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}

export function WorkspaceWorkflowTemplates({
  environmentId,
  projectId,
  revision,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  revision: string | null;
}) {
  const overview = useEnvironmentQuery(
    orchestrationEnvironment.workspaceWorkflows({ environmentId, input: { projectId } }),
  );
  const command = useAtomCommand(orchestrationEnvironment.startWorkflow, { reportFailure: false });
  const [selected, setSelected] = useState<WorkflowVersion | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"direct" | "ask-first" | "conditions" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  useEffect(() => {
    overview.refresh();
  }, [revision, overview.refresh]);
  const start = async () => {
    if (!selected || !mode) return;
    request.current ??= randomUUID();
    setBusy(true);
    setError(null);
    try {
      const result = await command({
        environmentId,
        input: {
          projectId,
          definitionId: selected.id,
          revision: selected.revision,
          values,
          requestId: request.current,
          requestMode: mode,
          conditionsConfirmed: confirmed,
        },
      });
      if (result._tag !== "Success")
        setError(
          "시작 결과를 확인하지 못했습니다. 같은 입력으로 다시 확인하세요. 저장 버전·입력·권한 상태는 웹이나 데스크톱에서 확인할 수 있습니다.",
        );
      else {
        request.current = null;
        setSelected(null);
        overview.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <Text className="text-base font-t3-bold text-foreground">저장한 AI 워크플로</Text>
      <Text className="text-xs text-foreground-muted">
        현재 서버의 프로젝트 역할·권한·계획 모드로 실행합니다. 단계 편집과 스킬 연결은
        웹·데스크톱에서 할 수 있습니다.
      </Text>
      {overview.error ? <ErrorBanner message={overview.error} /> : null}
      <View className="flex-row flex-wrap gap-2">
        {overview.data?.definitions
          .filter((definition) => !definition.archived)
          .map((definition) => (
            <Action
              key={definition.id}
              label={`${definition.title} v${definition.revision}`}
              disabled={busy}
              onPress={() => {
                setSelected(definition);
                setValues({});
                setConfirmed(false);
              }}
            />
          ))}
        <Action label="새로고침" disabled={busy} onPress={overview.refresh} />
      </View>
      {selected ? (
        <View className="gap-3">
          <Text className="text-sm text-foreground">
            {selected.title} v{selected.revision} · 스킬과 단계는 저장 버전으로 고정됩니다.
          </Text>
          {selected.inputs.map((input) => (
            <View key={input.name} className="gap-1">
              <Text className="text-xs text-foreground">
                {input.label}
                {input.required ? " (필수)" : ""}
              </Text>
              <TextInput
                accessibilityLabel={input.label}
                className="rounded-lg border border-border p-3 text-foreground"
                value={values[input.name] ?? input.defaultValue}
                editable={!busy}
                onChangeText={(value) => {
                  setValues((current) => ({ ...current, [input.name]: value }));
                  setConfirmed(false);
                }}
              />
            </View>
          ))}
          <View className="flex-row flex-wrap gap-2">
            {(
              [
                ["direct", "바로 실행"],
                ["ask-first", "질문하기"],
                ["conditions", "조건 확인"],
              ] as const
            ).map(([value, label]) => (
              <Action
                key={value}
                label={`${mode === value ? "✓ " : ""}${label}`}
                disabled={busy}
                onPress={() => setMode(value)}
              />
            ))}
          </View>
          {mode === "conditions" ? (
            <Action
              label={confirmed ? "✓ 입력·단계 확인함" : "입력·단계 확인"}
              disabled={busy}
              onPress={() => setConfirmed(!confirmed)}
            />
          ) : null}
          <Action
            label="이 버전 실행"
            disabled={busy || !mode || (mode === "conditions" && !confirmed)}
            onPress={() => void start()}
          />
        </View>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}
