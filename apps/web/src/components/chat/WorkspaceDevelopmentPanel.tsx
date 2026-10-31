import {
  CommandId,
  type DevelopmentWorkspaceId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ProviderInstanceId,
  type ThreadId,
  type WorkspaceDevelopmentDirectInput,
  type WorkspaceDevelopmentState,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { meetingModelDefaultOptions } from "../../meetingModelOptions";
import {
  developmentControlLabels,
  developmentMainModel,
  formatDevelopmentVerificationCommands,
  parseDevelopmentVerificationCommands,
  parseDevelopmentTokenBudget,
} from "./workspaceDevelopmentSettings";
import { DevelopmentTokenUsage } from "./DevelopmentTokenUsage";

export interface DevelopmentInputTarget {
  readonly workspaceId: DevelopmentWorkspaceId | null;
  readonly mode: WorkspaceDevelopmentDirectInput["mode"];
  readonly requirementChange: boolean;
}
export const DEFAULT_DEVELOPMENT_INPUT_TARGET: DevelopmentInputTarget = {
  workspaceId: null,
  mode: "followup",
  requirementChange: false,
};
export interface WorkspaceDevelopmentPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly conversationId: ThreadId;
  readonly mainModel: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly state: WorkspaceDevelopmentState | null;
  readonly target: DevelopmentInputTarget;
  readonly onTargetChange: (target: DevelopmentInputTarget) => void;
  readonly instanceEntries?: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance?: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly surface?: "composer" | "picker";
  readonly onMainModelChange?: (model: ModelSelection) => void;
}

export function WorkspaceDevelopmentPanel(props: WorkspaceDevelopmentPanelProps) {
  const configure = useAtomCommand(orchestrationEnvironment.configureDevelopment);
  const returnControl = useAtomCommand(orchestrationEnvironment.returnDevelopmentControl);
  const goalCommand = useAtomCommand(orchestrationEnvironment.developmentGoal);
  const inPicker = props.surface === "picker";
  const [expanded, setExpanded] = useState(inPicker);
  const [busy, setBusy] = useState(false);
  const [commands, setCommands] = useState(() =>
    formatDevelopmentVerificationCommands(props.state?.verificationCommands ?? []),
  );
  const [mainModel, setMainModel] = useState(() =>
    developmentMainModel(props.state, props.mainModel),
  );
  const [ownerRows, setOwnerRows] = useState(() =>
    (props.state?.ownerModels ?? [props.mainModel]).map((selection) => ({
      id: randomUUID(),
      selection,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [maxSteps, setMaxSteps] = useState(props.state?.goal?.maxSteps ?? 12);
  const [maxMinutes, setMaxMinutes] = useState(props.state?.goal?.maxMinutes ?? 60);
  const [maxTokens, setMaxTokens] = useState(() => String(props.state?.goal?.maxTokens ?? ""));
  const [maxDailyTokens, setMaxDailyTokens] = useState(() =>
    String(props.state?.maxDailyTokens ?? ""),
  );
  const state = props.state;
  useEffect(() => {
    setMaxTokens(String(state?.goal?.maxTokens ?? ""));
    setMaxSteps(state?.goal?.maxSteps ?? 12);
    setMaxMinutes(state?.goal?.maxMinutes ?? 60);
  }, [state?.goal?.id, state?.goal?.maxTokens, state?.goal?.maxSteps, state?.goal?.maxMinutes]);
  useEffect(() => {
    setMaxDailyTokens(String(state?.maxDailyTokens ?? ""));
  }, [state?.maxDailyTokens]);
  const isMain = !state || state.conversationId === props.conversationId;
  const controlGoal = async (action: "start" | "pause" | "resume" | "cancel") => {
    setBusy(true);
    setError(null);
    try {
      const result = await goalCommand({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          conversationId: props.conversationId,
          commandId: CommandId.make(randomUUID()),
          action,
          ...(state?.goal ? { expectedGoalRevision: state.goal.revision } : {}),
          ...(action === "start" || action === "resume"
            ? { maxTokens: parseDevelopmentTokenBudget(maxTokens), maxSteps, maxMinutes }
            : {}),
          ...(action === "start"
            ? {
                objective,
                acceptanceCriteria: criteria
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
                maxSteps,
                maxMinutes,
              }
            : {}),
        },
      });
      if (result._tag !== "Success")
        setError("목표 설정을 적용하지 못했습니다. 최신 상태와 연결을 확인하세요.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "목표 설정을 적용하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const modelChoices = (props.instanceEntries ?? [])
    .filter(
      (entry) =>
        isProviderInstancePickerReady(entry) &&
        ["codex", "claudeAgent", "opencode", "deepseek", "antseed"].includes(entry.driverKind),
    )
    .flatMap((entry) =>
      (props.modelOptionsByInstance?.get(entry.instanceId) ?? entry.models).map((model) => ({
        key: modelPickerModelKey(entry.instanceId, model.slug),
        label: `${entry.displayName} · ${model.name}`,
        selection: {
          instanceId: entry.instanceId,
          model: model.slug,
          options: meetingModelDefaultOptions(entry, model.slug),
        },
      })),
    );
  const renderModelSelect = (
    label: string,
    selection: ModelSelection,
    onChange: (model: ModelSelection) => void,
  ) => {
    const key = modelPickerModelKey(selection.instanceId, selection.model);
    return (
      <select
        aria-label={label}
        value={key}
        disabled={busy}
        className="w-full min-w-0 rounded border bg-background px-2 py-1.5"
        onChange={(event) => {
          const choice = modelChoices.find((model) => model.key === event.target.value);
          if (choice) onChange(choice.selection);
        }}
      >
        {!modelChoices.some((model) => model.key === key) && (
          <option value={key}>
            {selection.instanceId} · {selection.model}
          </option>
        )}
        {modelChoices.map((choice) => (
          <option key={choice.key} value={choice.key}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  };
  const saveConfiguration = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await configure({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          conversationId: props.conversationId,
          commandId: CommandId.make(randomUUID()),
          enabled,
          maxDailyTokens: enabled
            ? parseDevelopmentTokenBudget(maxDailyTokens)
            : (state?.maxDailyTokens ?? null),
          mainModel: enabled ? mainModel : developmentMainModel(state, props.mainModel),
          ownerModels: enabled
            ? ownerRows.map((row) => row.selection)
            : (state?.ownerModels ?? ownerRows.map((row) => row.selection)),
          runtimeMode: props.runtimeMode,
          ...(props.interactionMode !== undefined
            ? { interactionMode: props.interactionMode }
            : {}),
          maxParallelOwners: state?.maxParallelOwners ?? 3,
          verificationCommands: enabled
            ? parseDevelopmentVerificationCommands(commands)
            : (state?.verificationCommands ?? []),
        },
      });
      if (result._tag === "Success") {
        if (enabled) {
          props.onMainModelChange?.(mainModel);
        }
        setExpanded(true);
      } else {
        const error = squashAtomCommandFailure(result);
        setError(error instanceof Error ? error.message : "작업실 설정을 적용하지 못했습니다.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "검증 명령을 한 줄에 하나씩 입력하세요.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={
        inPicker
          ? "min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3 text-xs"
          : "mx-auto mb-2 max-w-3xl rounded-lg border border-border bg-background/95 px-3 py-2 text-xs"
      }
    >
      {(!inPicker || (state?.enabled && isMain)) && (
        <div className="flex flex-wrap items-center gap-2">
          {!inPicker && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="font-medium"
            >
              지속 작업실 {state?.enabled ? "· 사용 중" : "· 설정"}
            </button>
          )}
          {state?.enabled && isMain && (
            <>
              <label>
                보낼 대상{" "}
                <select
                  aria-label="지속 작업실 입력 대상"
                  value={props.target.workspaceId ?? ""}
                  className="ml-1 rounded border bg-background px-1 py-1"
                  onChange={(event) =>
                    props.onTargetChange({
                      ...props.target,
                      workspaceId:
                        state.workspaces.find((workspace) => workspace.id === event.target.value)
                          ?.id ?? null,
                    })
                  }
                >
                  <option value="">Main · 전체 프로젝트</option>
                  {state.workspaces
                    .filter((workspace) => workspace.status === "ready")
                    .map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        @{workspace.name} · {developmentControlLabels[workspace.control]}
                      </option>
                    ))}
                </select>
              </label>
              {props.target.workspaceId && (
                <>
                  <select
                    aria-label="직접 지시 방식"
                    value={props.target.mode}
                    className="rounded border bg-background px-1 py-1"
                    onChange={(event) =>
                      props.onTargetChange({
                        ...props.target,
                        mode: event.target.value as DevelopmentInputTarget["mode"],
                      })
                    }
                  >
                    <option value="followup">보충 / 후속</option>
                    <option value="queue">대기열 추가</option>
                    <option value="replace">중단 후 교체</option>
                    <option value="takeover">직접 인수</option>
                  </select>
                  <label>
                    <input
                      type="checkbox"
                      checked={props.target.requirementChange}
                      onChange={(event) =>
                        props.onTargetChange({
                          ...props.target,
                          requirementChange: event.target.checked,
                        })
                      }
                    />{" "}
                    확정 요구 변경
                  </label>
                </>
              )}
            </>
          )}
        </div>
      )}
      {state?.enabled && isMain && state.goal && (
        <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="개발 목표 진행 상태">
          <strong>
            개발 목표 ·{" "}
            {
              {
                active: "자동 진행",
                paused: "일시정지",
                blocked: "확인 필요",
                limited: "상한 도달",
                complete: "검증 완료",
                cancelled: "종료",
              }[state.goal.status]
            }
          </strong>
          <span>
            {state.goal.steps}/{state.goal.maxSteps}회 ·{" "}
            {state.goal.status === "complete"
              ? "로컬 통합 완료"
              : state.goal.status !== "active"
                ? "자동 진행 정지"
                : state.goal.phase === "waiting"
                  ? "Owner 결과 대기"
                  : state.goal.phase === "running"
                    ? "Main 실행 중"
                    : "다음 단계 준비"}
          </span>
          <p className="w-full whitespace-pre-wrap">{state.goal.objective}</p>
          <p className="w-full whitespace-pre-wrap text-muted-foreground">
            {state.goal.lastSummary}
          </p>
          {!["active", "complete", "cancelled"].includes(state.goal.status) && (
            <div className="w-full space-y-1">
              <label>
                재개 시 목표 토큰 예산{" "}
                <input
                  aria-label="재개 시 목표 토큰 예산"
                  type="number"
                  min={1}
                  placeholder="미설정"
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(event.target.value)}
                  className="w-32 rounded border bg-background p-1"
                />
              </label>
              <label className="ml-2">
                진행 횟수 상한{" "}
                <input
                  aria-label="재개 시 진행 횟수 상한"
                  type="number"
                  min={1}
                  max={50}
                  value={maxSteps}
                  onChange={(event) => setMaxSteps(Number(event.target.value))}
                  className="w-16 rounded border bg-background p-1"
                />
              </label>
              <label className="ml-2">
                활성 시간 상한{" "}
                <input
                  aria-label="재개 시 활성 시간 상한"
                  type="number"
                  min={1}
                  max={480}
                  value={maxMinutes}
                  onChange={(event) => setMaxMinutes(Number(event.target.value))}
                  className="w-16 rounded border bg-background p-1"
                />
                분
              </label>
            </div>
          )}
          {state.goal.status === "active" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void controlGoal("pause")}
              className="rounded border px-2 py-1"
            >
              목표 일시정지
            </button>
          )}
          {["paused", "blocked", "limited"].includes(state.goal.status) && (
            <button
              type="button"
              disabled={busy || !!state.goal.pendingMessageId}
              onClick={() => void controlGoal("resume")}
              className="rounded border px-2 py-1"
            >
              목표 재개
            </button>
          )}
          {!["complete", "cancelled"].includes(state.goal.status) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void controlGoal("cancel")}
              className="rounded border px-2 py-1"
            >
              목표 종료
            </button>
          )}
        </div>
      )}
      {state?.enabled && isMain && (
        <DevelopmentTokenUsage
          usage={state.usage}
          maxTokens={state.goal?.maxTokens}
          maxDailyTokens={state.maxDailyTokens}
          hasGoal={!!state.goal}
        />
      )}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
      {expanded && (
        <div className="mt-2 space-y-2">
          {!isMain ? (
            <p>이 프로젝트의 기존 Main 대화에서 작업실을 조율합니다.</p>
          ) : (
            <>
              {inPicker && (
                <>
                  <p className="text-muted-foreground leading-relaxed">
                    Main이 일을 나누고 담당 AI가 각 작업실의 대화와 작업을 이어갑니다. 후속 요청도
                    같은 담당자에게 전달되며, 전체 기록은 이 대화에서 확인합니다.
                  </p>
                  <ol className="list-inside list-decimal space-y-1 text-muted-foreground">
                    <li>Main과 담당 AI 모델을 고릅니다.</li>
                    <li>사용 시작을 누른 뒤 입력창에 개발 요청을 보냅니다.</li>
                    <li>보낼 대상에서 Main 또는 담당 작업실을 고릅니다.</li>
                  </ol>
                  <p className="text-muted-foreground">
                    오케스트라는 요청별 토론·실행에, 지속 작업실은 같은 담당자와 이어가는 개발에
                    사용합니다.
                  </p>
                  <label className="block space-y-1">
                    <span className="font-medium">Main · 전체 작업을 조율할 AI</span>
                    {renderModelSelect("지속 작업실 Main 모델", mainModel, setMainModel)}
                  </label>
                  <div className="space-y-1">
                    <span className="font-medium">담당 AI · 작업실에서 사용할 모델</span>
                    {ownerRows.map((row, index) => (
                      <div key={row.id} className="flex items-center gap-1">
                        {renderModelSelect(
                          `작업실 담당 모델 ${index + 1}`,
                          row.selection,
                          (selection) =>
                            setOwnerRows((current) =>
                              current.map((value) =>
                                value.id === row.id ? { ...value, selection } : value,
                              ),
                            ),
                        )}
                        {ownerRows.length > 1 && (
                          <button
                            type="button"
                            aria-label={`담당 모델 ${index + 1} 제거`}
                            disabled={busy}
                            className="shrink-0 rounded border px-2 py-1"
                            onClick={() =>
                              setOwnerRows((current) =>
                                current.filter((value) => value.id !== row.id),
                              )
                            }
                          >
                            제거
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={busy || ownerRows.length >= 8 || modelChoices.length === 0}
                      className="rounded border px-2 py-1 disabled:opacity-50"
                      onClick={() =>
                        setOwnerRows((current) => [
                          ...current,
                          { id: randomUUID(), selection: modelChoices[0]!.selection },
                        ])
                      }
                    >
                      담당 AI 추가
                    </button>
                  </div>
                  <label className="block">
                    <span className="font-medium">통합 전 검증 명령 · 한 줄에 하나</span>
                    <textarea
                      aria-label="작업실 검증 명령"
                      rows={2}
                      value={commands}
                      disabled={busy}
                      placeholder={"vp test run src/example.test.ts\nvp run typecheck"}
                      onChange={(event) => setCommands(event.target.value)}
                      className="mt-1 w-full rounded border bg-background p-2 font-mono"
                    />
                    <span className="mt-1 block text-muted-foreground">
                      프로젝트에서 실제로 쓰는 테스트 명령을 입력하세요. 비워 두면 작업 배정은
                      가능하며, 자동 목표 진행과 결과 통합 전에 검증 명령을 저장해야 합니다.
                    </span>
                  </label>
                  <label className="block space-y-1">
                    <span className="font-medium">프로젝트 일일 토큰 예산 · 서버 날짜 기준</span>
                    <input
                      aria-label="프로젝트 일일 토큰 예산"
                      type="number"
                      min={1}
                      disabled={busy}
                      placeholder="미설정"
                      value={maxDailyTokens}
                      onChange={(event) => setMaxDailyTokens(event.target.value)}
                      className="w-full rounded border bg-background p-2"
                    />
                    <span className="block text-muted-foreground">
                      프로젝트의 보고된 사용량을 합산해 새 자동 작업을 제한합니다. 비워 두면 예산
                      제한을 사용하지 않습니다.
                    </span>
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void saveConfiguration(true)}
                    className="rounded border bg-primary px-2 py-1.5 text-primary-foreground disabled:opacity-50"
                  >
                    {busy ? "적용 중…" : state?.enabled ? "설정 저장" : "지속 작업실 사용 시작"}
                  </button>
                  {state?.enabled && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void saveConfiguration(false)}
                      className="rounded border px-2 py-1 disabled:opacity-50"
                    >
                      지속 작업실 끄기
                    </button>
                  )}
                </>
              )}
              {state?.enabled &&
                (!state.goal || ["complete", "cancelled"].includes(state.goal.status)) && (
                  <div className="space-y-2 rounded border p-2">
                    <strong>목표를 정하고 자동 개발</strong>
                    <label className="block space-y-1">
                      목표 토큰 예산{" "}
                      <input
                        aria-label="목표 토큰 예산"
                        type="number"
                        min={1}
                        placeholder="미설정"
                        value={maxTokens}
                        onChange={(event) => setMaxTokens(event.target.value)}
                        className="w-full rounded border bg-background p-2"
                      />
                    </label>
                    <p className="text-muted-foreground">
                      목표에 필요한 개발·검증·로컬 통합을 같은 Main 대화에서 이어갑니다. 현재 실행
                      중인 작업은 일시정지 후에도 마무리되며 추가 자동 진행만 멈춥니다.
                    </p>
                    <textarea
                      aria-label="자동 개발 목표"
                      placeholder="이 프로젝트에서 이루고 싶은 목표"
                      value={objective}
                      onChange={(e) => setObjective(e.target.value)}
                      rows={2}
                      className="w-full rounded border bg-background p-2"
                    />
                    <textarea
                      aria-label="목표 완료조건"
                      placeholder="완료조건을 한 줄에 하나씩"
                      value={criteria}
                      onChange={(e) => setCriteria(e.target.value)}
                      rows={2}
                      className="w-full rounded border bg-background p-2"
                    />
                    <label>
                      자동 Main 진행 상한{" "}
                      <input
                        aria-label="목표 진행 횟수 상한"
                        type="number"
                        min={1}
                        max={50}
                        value={maxSteps}
                        onChange={(e) => setMaxSteps(Number(e.target.value))}
                        className="w-16 rounded border bg-background p-1"
                      />
                      회
                    </label>
                    <label className="ml-2">
                      활성 시간{" "}
                      <input
                        aria-label="목표 시간 상한"
                        type="number"
                        min={1}
                        max={480}
                        value={maxMinutes}
                        onChange={(e) => setMaxMinutes(Number(e.target.value))}
                        className="w-16 rounded border bg-background p-1"
                      />
                      분
                    </label>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !objective.trim() ||
                        !criteria.trim() ||
                        !!state.goal?.pendingMessageId ||
                        state.verificationCommands.length === 0
                      }
                      onClick={() => void controlGoal("start")}
                      className="block rounded border px-2 py-1 disabled:opacity-50"
                    >
                      목표 시작
                    </button>
                    {state.verificationCommands.length === 0 && (
                      <p className="text-muted-foreground">
                        자동 개발을 시작하려면 AI 작업의 지속 진행 설정에서 검증 명령을 저장하세요.
                      </p>
                    )}
                  </div>
                )}
              {state?.workspaces.map((workspace) => (
                <div key={workspace.id} className="rounded border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{workspace.name}</strong>
                    <span>
                      {workspace.status} · {workspace.control}
                      {workspace.takeover ? " · 직접 인수 중" : ""} · 요구 r
                      {workspace.requirementRevision}
                    </span>
                    {workspace.takeover && (
                      <button
                        type="button"
                        className="rounded border px-2 py-1"
                        onClick={() =>
                          void returnControl({
                            environmentId: props.environmentId,
                            input: {
                              projectId: props.projectId,
                              workspaceId: workspace.id,
                              commandId: CommandId.make(randomUUID()),
                              expectedRevision: workspace.stateRevision,
                            },
                          })
                        }
                      >
                        Main에 반환
                      </button>
                    )}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                    {workspace.error ?? workspace.lastSummary.slice(-400)}
                  </p>
                  <details className="mt-1">
                    <summary>세션·작업 기록</summary>
                    <p className="break-all">
                      {state.bindings.find((binding) => binding.id === workspace.bindingId)
                        ?.nativeSessionId ?? "첫 실제 입력 후 세션 ID 확인"}
                    </p>
                    {state.tasks
                      .filter((task) => task.workspaceId === workspace.id)
                      .slice(-5)
                      .map((task) => (
                        <div key={task.id} className="mt-1 break-all">
                          <p>
                            {task.source} · {task.status} · {task.delivery} ·{" "}
                            {task.nativeTurnId ?? task.messageId}
                          </p>
                          <p className="whitespace-pre-wrap">{task.objective}</p>
                          {task.failureRecovery && (
                            <p className="whitespace-pre-wrap text-muted-foreground">
                              복구 안내: {task.failureRecovery.instruction}
                            </p>
                          )}
                          {task.nativeMessageIds.length > 0 && (
                            <p className="text-muted-foreground">
                              원문 참조: {task.nativeMessageIds.join(", ")}
                            </p>
                          )}
                        </div>
                      ))}
                  </details>
                </div>
              ))}
              {state?.enabled && (
                <p className="text-muted-foreground">
                  별도 CLI/UI의 동시 입력은 이 대기열로 통제되지 않습니다. 외부 변경이 감지되면
                  재확인 전 통합을 보류합니다.
                </p>
              )}
              {state?.enabled && (
                <p className="text-muted-foreground">
                  작업실 신설·재사용과 로컬 통합을 지원합니다. 자동 분할·조직 통합·폐기, 추가
                  Reviewer, Cursor·Grok 담당자는 아직 지원하지 않습니다.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
