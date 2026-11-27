import { useMemo, useState } from "react";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { useServerConfigs } from "~/state/entities";
import type { WorkflowModelDraft, WorkflowModelMode, WorkflowModelRole } from "./chatWorkflow";

import { WorkerFamilyFilter, workerModelFamily } from "./WorkerFamilyFilter";

const labels: Record<WorkflowModelRole, string> = {
  coordinator: "총괄",
  implementer: "구현",
  researcher: "조사",
};

export function WorkflowModelSelector(props: {
  environmentId: EnvironmentId;
  mode: WorkflowModelMode;
  onModeChange: (mode: WorkflowModelMode) => void;
  single: ModelSelection | null;
  onSingleChange: (value: ModelSelection | null) => void;
  roles: WorkflowModelDraft;
  onRoleChange: (role: WorkflowModelRole, value: ModelSelection | null) => void;
  current: ModelSelection | null;
  meetingEnabled: boolean;
}) {
  const configs = useServerConfigs();
  const snapshots = configs.get(props.environmentId)?.providers ?? [];
  const settings = useEnvironmentSettings(props.environmentId);
  const options = useMemo(
    () =>
      deriveProviderInstanceEntries(snapshots)
        .filter((entry) => entry.enabled && entry.isAvailable)
        .flatMap((entry) =>
          getAppModelOptionsForInstance(settings, entry).map((model) => ({
            family: workerModelFamily(entry.driverKind, entry.instanceId, model.slug),
            key: JSON.stringify([entry.instanceId, model.slug]),
            label: `${entry.displayName} · ${model.name}`,
            selection: { instanceId: entry.instanceId, model: model.slug },
          })),
        ),
    [snapshots, settings],
  );
  const [family, setFamily] = useState("all");
  const visibleFamily = options.some((option) => option.family === family) ? family : "all";
  const renderPicker = (
    label: string,
    selection: ModelSelection | null | undefined,
    onChange: (value: ModelSelection | null) => void,
  ) => (
    <label className="grid gap-1 text-xs font-medium">
      {label}
      <select
        className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
        aria-label={label}
        value={selection ? JSON.stringify([selection.instanceId, selection.model]) : ""}
        onChange={(event) => {
          onChange(
            options.find((option) => option.key === event.currentTarget.value)?.selection ?? null,
          );
        }}
      >
        <option value="">모델을 선택하세요</option>
        {options
          .filter(
            (option) =>
              visibleFamily === "all" ||
              option.family === visibleFamily ||
              (option.selection.instanceId === selection?.instanceId &&
                option.selection.model === selection?.model),
          )
          .map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <div className="grid gap-2" aria-label="워크플로 모델 설정">
      <label className="grid gap-1 text-xs font-medium">
        모델 선택 방식
        <select
          className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
          aria-label="워크플로 모델 선택 방식"
          value={props.mode}
          onChange={(event) => props.onModeChange(event.currentTarget.value as WorkflowModelMode)}
        >
          <option value="current">현재 채팅에서 선택한 모델</option>
          <option value="project">
            {props.meetingEnabled ? "선택한 오케스트라 참가자" : "기존 프로젝트 역할 설정"}
          </option>
          <option value="single">모델 하나를 모든 역할에 사용</option>
          <option value="roles">역할별로 모델 선택</option>
        </select>
      </label>
      {(props.mode === "single" || props.mode === "roles") && (
        <WorkerFamilyFilter options={options} value={visibleFamily} onChange={setFamily} />
      )}
      {props.mode === "current" ? (
        <p className="text-xs text-muted-foreground">
          {props.current
            ? `${props.current.instanceId} · ${props.current.model}을(를) 모든 역할에 사용합니다.`
            : "현재 채팅에서 사용할 수 있는 모델을 선택하세요."}
        </p>
      ) : null}
      {props.mode === "single"
        ? renderPicker("전체 역할 모델", props.single, props.onSingleChange)
        : null}
      {props.mode === "roles"
        ? (["coordinator", "implementer", "researcher"] as const).map((role) => (
            <div key={role}>
              {renderPicker(`${labels[role]} 모델`, props.roles[role], (value) =>
                props.onRoleChange(role, value),
              )}
            </div>
          ))
        : null}
      {props.mode !== "project" ? (
        <p className="text-xs text-muted-foreground">선택한 모델은 이번 실행에만 적용됩니다.</p>
      ) : null}
      {options.length === 0 && (props.mode === "single" || props.mode === "roles") ? (
        <p className="text-xs text-destructive">
          사용할 수 있는 AI 계정과 모델이 없습니다. 연결 설정을 확인하세요.
        </p>
      ) : null}
    </div>
  );
}
