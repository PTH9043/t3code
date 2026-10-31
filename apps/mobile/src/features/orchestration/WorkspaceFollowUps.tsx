import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  WorkspaceCollaborationRunId,
  WorkspaceScheduleId,
  type EnvironmentId,
  type ProjectId,
  type WorkspaceCollaborationRun,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Pressable, Switch, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { orchestrationEnvironment } from "../../state/orchestration";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 as randomUUID } from "../../lib/uuid";
import { WorkspaceMcpTools } from "./WorkspaceMcpTools";
import { WorkspaceUpgradeTools } from "./WorkspaceUpgradeTools";
import { useProject } from "../../state/entities";

export function WorkspaceFollowUps(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceRoot: string;
  runs: ReadonlyArray<WorkspaceCollaborationRun>;
  revision: string | null;
  refreshRuns: () => void;
}) {
  const project = useProject({ environmentId: props.environmentId, projectId: props.projectId });
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId)) ??
    DEFAULT_SERVER_SETTINGS;
  const profiles = settings.executionProfiles;
  const schedules = useEnvironmentQuery(
    orchestrationEnvironment.workspaceSchedules({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  useEffect(() => {
    schedules.refresh();
  }, [props.revision, schedules.refresh]);
  const request = useAtomCommand(orchestrationEnvironment.startWorkflow, {
    reportFailure: false,
  });
  const upsert = useAtomCommand(projectEnvironment.upsertWorkspaceSchedule, {
    reportFailure: false,
  });
  const remove = useAtomCommand(projectEnvironment.removeWorkspaceSchedule, {
    reportFailure: false,
  });
  const [profileId, setProfileId] = useState("");
  const [runId, setRunId] = useState<WorkspaceCollaborationRunId | null>(null);
  const [task, setTask] = useState("");
  const [verified, setVerified] = useState(true);
  const [cancelOnFailure, setCancelOnFailure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (followUp: boolean) => {
    if (!task.trim() || (followUp && !runId)) return;
    if (profileId && !profiles[profileId]) {
      setError("선택한 프로필이 삭제되었습니다. 다시 선택하세요.");
      return;
    }
    if (!followUp && !profiles[profileId] && !project?.defaultModelSelection) {
      setError("프로젝트 기본 모델이나 실행 프로필을 선택하세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const profile = profiles[profileId];
      const result =
        followUp && runId
          ? await upsert({
              environmentId: props.environmentId,
              input: {
                scheduleId: WorkspaceScheduleId.make(`schedule-${randomUUID()}`),
                projectId: props.projectId,
                title: task.trim().slice(0, 100),
                task: task.trim(),
                enabled: true,
                timing: {
                  kind: "after-run",
                  runId,
                  condition: verified ? "verified" : "completed",
                  onFailure: cancelOnFailure ? "cancel" : "hold",
                  ...(profile ? { executionProfile: profile } : {}),
                },
              },
            })
          : await request({
              environmentId: props.environmentId,
              input: {
                projectId: props.projectId,
                task: task.trim(),
                requestId: randomUUID(),
                ...(profile ? { executionProfile: profile } : {}),
                ...(!profile && project?.defaultModelSelection
                  ? {
                      roleModels: {
                        coordinator: project.defaultModelSelection,
                        implementer: project.defaultModelSelection,
                        researcher: project.defaultModelSelection,
                      },
                    }
                  : {}),
              },
            });
      if (result._tag === "Failure")
        setError("작업을 저장하지 못했습니다. 연결·권한을 확인하세요.");
      else {
        setTask("");
        schedules.refresh();
        props.refreshRuns();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-3.5">
      <Text className="text-base font-t3-bold text-foreground">프로필 실행·후속 예약</Text>
      <Text className="text-xs text-foreground-muted">
        프로필은 웹·데스크톱에서 저장할 수 있습니다. 예약은 현재 버전을 보존합니다.
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {[{ id: "", name: "기본 설정", revision: 0 }, ...Object.values(profiles)].map((profile) => (
          <Pressable
            key={profile.id}
            accessibilityRole="button"
            accessibilityState={{ selected: profileId === profile.id }}
            onPress={() => setProfileId(profile.id)}
            className="rounded-lg border border-border p-2"
          >
            <Text className="text-xs text-foreground">
              {profileId === profile.id ? "✓ " : ""}
              {profile.name}
              {profile.revision ? ` v${profile.revision}` : ""}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel="실행할 작업"
        value={task}
        onChangeText={setTask}
        maxLength={15000}
        multiline
        placeholder="실행할 작업"
        className="min-h-20 rounded-lg border border-border p-3 text-foreground"
      />
      <Pressable
        accessibilityRole="button"
        disabled={busy || !task.trim()}
        onPress={() => void submit(false)}
        className="rounded-lg bg-fill p-3"
      >
        <Text className="text-foreground">{busy ? "저장 중…" : "지금 실행"}</Text>
      </Pressable>
      <Text className="text-xs text-foreground-muted">선행 실행 (최근 6개)</Text>
      {props.runs.slice(0, 6).map((run) => (
        <Pressable
          key={run.id}
          accessibilityRole="button"
          accessibilityState={{ selected: runId === run.id }}
          onPress={() => setRunId(run.id)}
          className="rounded-lg border border-border p-2"
        >
          <Text numberOfLines={2} className="text-xs text-foreground">
            {runId === run.id ? "✓ " : ""}
            {run.task.slice(0, 100)} · {run.status}
          </Text>
        </Pressable>
      ))}
      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-foreground">검증 통과 근거까지 확인</Text>
        <Switch
          value={verified}
          onValueChange={setVerified}
          accessibilityLabel="후속 예약 검증 통과 조건"
        />
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-foreground">선행 실패·취소 시 예약 취소</Text>
        <Switch
          value={cancelOnFailure}
          onValueChange={setCancelOnFailure}
          accessibilityLabel="선행 실패 시 후속 예약 취소"
        />
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={busy || !task.trim() || !runId}
        onPress={() => void submit(true)}
        className="rounded-lg bg-fill p-3"
      >
        <Text className="text-foreground">선행 실행 후 1회 예약</Text>
      </Pressable>
      {error || schedules.error ? (
        <ErrorBanner message={error ?? "예약을 불러오지 못했습니다."} />
      ) : null}
      {(schedules.data?.schedules ?? []).map((schedule) => (
        <View key={schedule.id} className="gap-1 border-t border-border pt-2">
          <Text className="text-sm text-foreground">
            {schedule.title} · {schedule.enabled ? "활성" : "중지"}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {schedule.lastTriggeredAt
              ? "최근 실행 " + new Date(schedule.lastTriggeredAt).toLocaleString("ko-KR")
              : schedule.nextTriggerAt
                ? "다음 실행 " + new Date(schedule.nextTriggerAt).toLocaleString("ko-KR")
                : "조건 대기"}
            {schedule.timing.executionProfile
              ? ` · ${schedule.timing.executionProfile.name} v${schedule.timing.executionProfile.revision}`
              : ""}
          </Text>
          {schedule.lastError ? (
            <Text className="text-xs text-destructive">{schedule.lastError}</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              setBusy(true);
              setError(null);
              void remove({
                environmentId: props.environmentId,
                input: { projectId: props.projectId, scheduleId: schedule.id },
              })
                .then((result) => {
                  if (result._tag === "Failure") setError("예약 취소 실패");
                  else schedules.refresh();
                })
                .finally(() => setBusy(false));
            }}
            className="self-start py-2"
          >
            <Text className="text-xs text-foreground">예약 삭제</Text>
          </Pressable>
        </View>
      ))}
      <WorkspaceMcpTools
        key={`${props.environmentId}:${props.workspaceRoot}`}
        environmentId={props.environmentId}
        workspaceRoot={props.workspaceRoot}
      />
      {project ? (
        <WorkspaceUpgradeTools
          key={`${props.environmentId}:${props.projectId}`}
          project={project}
        />
      ) : null}
    </View>
  );
}
