import { useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ProviderInteractionMode,
  ProviderInstanceId,
  RuntimeMode,
  ModelSelection,
  ThreadId,
  WorkflowStart,
  WorkflowVersion,
  WorkspaceCollaborationRunId,
} from "@t3tools/contracts";
import { previewWorkflow } from "@t3tools/shared/workflow";
import { ArrowUpRightIcon, ChevronDownIcon, GitBranchIcon, PlayIcon, XIcon } from "lucide-react";
import { useComposerRequestModeStore } from "../../askFirstStore";
import {
  meetingSetupFromConfig,
  updateMeetingComposerConfig,
  type MeetingComposerConfig,
} from "../../meetingComposerStore";
import { randomUUID } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import {
  runStatusLabel,
  useOperationsRevisionRefresh,
} from "../control-center/controlCenterShared";
import {
  chatWorkflowChoices,
  chatWorkflowValues,
  resolveWorkflowRoleModels,
  selectMeetingCoordinator,
  type WorkflowModelDraft,
  type WorkflowModelMode,
  type WorkflowModelRole,
} from "./chatWorkflow";
import { WorkflowModelSelector } from "./WorkflowModelSelector";
import { MeetingModePanel } from "./MeetingModePanel";
import { useComposerWorkMode } from "./useComposerWorkMode";
import {
  WorkspaceDevelopmentPanel,
  type WorkspaceDevelopmentPanelProps,
} from "./WorkspaceDevelopmentPanel";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

interface ChatWorkflowLauncherProps {
  project: EnvironmentProject | null;
  contextKey: string;
  threadId: ThreadId | null;
  prompt: string;
  attachmentCount: number;
  startBlocked: boolean;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  meetingConfig: MeetingComposerConfig;
  currentModel: ModelSelection | null;
  unavailableReason: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  development: WorkspaceDevelopmentPanelProps | null;
  onMainModelChange?: (model: ModelSelection) => void;
}

const permissionLabels: Record<RuntimeMode, string> = {
  "approval-required": "승인 필요",
  "auto-accept-edits": "수정 자동 승인",
  auto: "자동",
  "full-access": "전체 권한",
};
const requestLabels = { direct: "바로 실행", "ask-first": "질문하기", conditions: "조건 확인" };
const selectClass = "w-full rounded-xl border border-input bg-background px-3 py-2 text-sm";
const roleLabels: Record<string, string> = {
  coordinator: "총괄",
  implementer: "구현",
  researcher: "조사",
};

export function ChatWorkflowLauncher(props: ChatWorkflowLauncherProps) {
  if (!props.project)
    return (
      <div className="mb-1.5 px-1" data-chat-workflow-bar="true">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled
          title="프로젝트를 선택하면 AI 작업을 사용할 수 있습니다."
        >
          <GitBranchIcon className="size-3.5" />
          AI 작업
        </Button>
      </div>
    );
  return (
    <ProjectChatWorkflowLauncher
      key={`${props.project.environmentId}:${props.project.id}:${props.contextKey}`}
      {...props}
      project={props.project}
    />
  );
}

function ProjectChatWorkflowLauncher({
  project,
  ...props
}: ChatWorkflowLauncherProps & { project: EnvironmentProject }) {
  const open = props.open;
  const setOpen = props.onOpenChange;
  const { changingMode, modeError, selectMode } = useComposerWorkMode(props.development);
  const [selectedId, setSelectedId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [savedVersion, setSavedVersion] = useState<WorkflowVersion | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<WorkspaceCollaborationRunId | null>(null);
  const [pending, setPending] = useState<{ input: WorkflowStart; configuration: string } | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelModeChoice, setModelMode] = useState<WorkflowModelMode | null>(null);
  const modelMode = modelModeChoice ?? "current";
  const [singleModel, setSingleModel] = useState<ModelSelection | null>(null);
  const [roleModelsDraft, setRoleModelsDraft] = useState<WorkflowModelDraft>({});
  const inFlight = useRef(false);
  const workflowOpen = open;
  const watch = workflowOpen || busy || selectedRunId !== null || pending !== null;
  const lookup = { environmentId: project.environmentId, input: { projectId: project.id } };
  const overview = useEnvironmentQuery(
    watch ? orchestrationEnvironment.workspaceWorkflows(lookup) : null,
  );
  const roles = useEnvironmentQuery(
    workflowOpen || busy || pending !== null
      ? orchestrationEnvironment.workspaceAgentRoles(lookup)
      : null,
  );
  const runtime = useEnvironmentQuery(
    watch ? orchestrationEnvironment.workspaceRuntime(lookup) : null,
  );
  const detail = useEnvironmentQuery(
    workflowOpen && selectedRunId
      ? orchestrationEnvironment.workflowRun({
          ...lookup,
          input: { projectId: project.id, runId: selectedRunId },
        })
      : null,
  );
  useOperationsRevisionRefresh(runtime.data, overview.refresh);
  useOperationsRevisionRefresh(runtime.data, detail.refresh);
  useOperationsRevisionRefresh(runtime.data, roles.refresh);
  const save = useAtomCommand(orchestrationEnvironment.saveWorkflow, { reportFailure: false });
  const start = useAtomCommand(orchestrationEnvironment.startWorkflow, { reportFailure: false });
  const control = useAtomCommand(orchestrationEnvironment.controlWorkflow, {
    reportFailure: false,
  });
  const requestMode = useComposerRequestModeStore(
    (state) => state.modeByFolder[`${project.environmentId}:${project.id}`] ?? "direct",
  );
  const choices = useMemo(() => chatWorkflowChoices(overview.data), [overview.data]);
  const choice = choices.find((item) => item.definition.id === selectedId);
  const definition = savedVersion?.id === selectedId ? savedVersion : choice?.definition;
  const version = savedVersion?.id === selectedId ? savedVersion : choice?.version;
  const preview = useMemo(
    () => (definition ? previewWorkflow(definition, values) : null),
    [definition, values],
  );
  const roleModels = resolveWorkflowRoleModels(
    modelMode,
    singleModel,
    roleModelsDraft,
    props.currentModel,
  );
  const missingModelSelection = modelMode !== "project" && roleModels === undefined;
  const missingParticipants = props.meetingConfig.enabled && props.meetingConfig.seats.length < 2;
  const assignedParticipants =
    modelMode !== "project" && definition?.nodes.some((node) => node.participantId !== null);
  const projectRoleBindings = roles.data?.roles;
  const projectRolesLoading =
    !props.meetingConfig.enabled && modelMode === "project" && !projectRoleBindings;
  const missingProjectRoles =
    !props.meetingConfig.enabled && modelMode === "project" && projectRoleBindings
      ? [
          ...new Set([
            "coordinator",
            ...(definition?.nodes ?? []).map((node) =>
              node.agent === "codex"
                ? "implementer"
                : node.agent === "grok"
                  ? "researcher"
                  : "coordinator",
            ),
            ...(!definition ? ["implementer", "researcher"] : []),
          ]),
        ].filter(
          (role) =>
            !projectRoleBindings.some((binding) => binding.role === role && binding.enabled),
        )
      : [];
  const meetingSelection = useMemo(
    () =>
      props.meetingConfig.enabled
        ? selectMeetingCoordinator(
            meetingSetupFromConfig(props.meetingConfig),
            roleModels?.coordinator,
            roleModels ? [roleModels.implementer, roleModels.researcher] : [],
          )
        : null,
    [props.meetingConfig, roleModels?.coordinator, roleModels?.implementer, roleModels?.researcher],
  );
  const execution = useMemo(() => {
    const config = props.meetingConfig;
    if (!config.enabled || !meetingSelection?.meeting) return null;
    const meeting = {
      ...meetingSelection.meeting,
      runtimeMode: props.runtimeMode,
      interactionMode: props.interactionMode,
    };
    const orchestra = {
      maxParallel: config.maxParallel,
      isolateWorktrees: config.isolateWorktrees,
      ...(config.reviewPlan === undefined ? {} : { reviewPlan: config.reviewPlan }),
      ...(config.resumeAfterLimit === undefined
        ? {}
        : { resumeAfterLimit: config.resumeAfterLimit }),
      ...(config.maxWorkerTurns === undefined ? {} : { maxWorkerTurns: config.maxWorkerTurns }),
      ...(config.verificationCommands === undefined
        ? {}
        : { verificationCommands: config.verificationCommands }),
    };
    return {
      meeting,
      orchestra,
      ...(config.executionProfile
        ? { executionProfile: { ...config.executionProfile, meeting, orchestra } }
        : {}),
    };
  }, [props.meetingConfig, props.runtimeMode, props.interactionMode, meetingSelection?.meeting]);
  const configuration = JSON.stringify({
    definition: definition
      ? {
          schemaVersion: definition.schemaVersion,
          id: definition.id,
          title: definition.title,
          description: definition.description,
          inputs: definition.inputs,
          nodes: definition.nodes,
        }
      : null,
    values,
    task: selectedId ? null : props.prompt.trim(),
    runtimeMode: props.runtimeMode,
    interactionMode: props.interactionMode,
    requestMode,
    execution,
    threadId: props.threadId,
    modelMode,
    roleModels,
    roles: roles.data?.roles.map((role) => ({
      role: role.role,
      modelSelection: role.modelSelection,
      instructions: role.instructions,
      enabled: role.enabled,
    })),
  });
  const currentConfiguration = useRef(configuration);
  currentConfiguration.current = configuration;
  const allRuns =
    overview.data?.allRuns ??
    overview.data?.runs.map((item) => ({
      ...item,
      title: item.workflow.title,
      workflowRevision: item.workflow.definitionRevision,
      control: item.workflow.control,
      controlRevision: item.workflow.controlRevision,
    })) ??
    [];
  const summary = allRuns.find((item) => item.id === selectedRunId);
  const run = detail.data;
  const question = run?.meeting?.pendingQuestion;
  const development = props.development;
  const developmentActive =
    development?.state?.enabled === true &&
    development.state.conversationId === development.conversationId;
  const targetWorkspace = development?.state?.workspaces.find(
    (workspace) => workspace.id === development.target.workspaceId,
  );
  const developmentTargetName = developmentActive
    ? development.target.workspaceId === null
      ? "Main"
      : targetWorkspace
        ? `${targetWorkspace.name}${targetWorkspace.status === "ready" ? "" : " (사용 불가)"}`
        : "선택한 작업실 (사용 불가)"
    : null;
  const threadId =
    run?.meeting?.threadId ??
    run?.runContext?.threadId ??
    run?.workflow?.threadId ??
    run?.steps.find((step) => step.status === "running" && step.threadId)?.threadId ??
    run?.steps.find((step) => step.threadId)?.threadId ??
    run?.graph?.nodes.find((node) => node.threadId)?.threadId;
  const locked = busy || pending !== null;
  const pendingChanged = pending !== null && pending.configuration !== configuration;

  const execute = async () => {
    if (
      inFlight.current ||
      props.startBlocked ||
      props.unavailableReason ||
      pendingChanged ||
      (!selectedId && props.attachmentCount > 0) ||
      missingModelSelection ||
      missingParticipants ||
      meetingSelection?.error ||
      assignedParticipants ||
      projectRolesLoading ||
      missingProjectRoles.length > 0
    )
      return;
    if (
      !pending &&
      ((selectedId ? !definition || !preview?.valid : !props.prompt.trim()) ||
        (requestMode === "conditions" && confirmed !== configuration))
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let request = pending;
      if (!request) {
        let pinned = version;
        const reviewed = configuration;
        if (definition && !pinned) {
          const result = await save({
            ...lookup,
            input: { projectId: project.id, definition, expectedRevision: 0, archived: false },
          });
          if (result._tag !== "Success") {
            setError(String(squashAtomCommandFailure(result)));
            overview.refresh();
            return;
          }
          pinned = result.value;
          setSavedVersion(pinned);
          overview.refresh();
        }
        if (currentConfiguration.current !== reviewed) {
          setError("실행 설정이 바뀌었습니다. 현재 구성을 다시 확인하세요.");
          return;
        }
        request = {
          configuration: reviewed,
          input: {
            projectId: project.id,
            ...(pinned
              ? { definitionId: pinned.id, revision: pinned.revision, values }
              : { task: props.prompt.trim() }),
            requestId: randomUUID(),
            ...(props.threadId ? { threadId: props.threadId } : {}),
            ...(roleModels ? { roleModels } : {}),
            runtimeMode: props.runtimeMode,
            interactionMode: props.interactionMode,
            requestMode,
            conditionsConfirmed: confirmed === reviewed,
            ...execution,
          },
        };
        setPending(request);
      }
      if (!request) return;
      const result = await start({ ...lookup, input: request.input });
      overview.refresh();
      if (result._tag !== "Success") {
        setError("실행 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
        return;
      }
      setSelectedRunId(result.value.id);
      setPending(null);
      setSavedVersion(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const changeRun = async (action: "pause" | "resume" | "cancel") => {
    if (!summary || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await control({
        ...lookup,
        input: {
          projectId: project.id,
          runId: summary.id,
          expectedRevision: summary.controlRevision,
          action,
        },
      });
      if (result._tag !== "Success") setError(String(squashAtomCommandFailure(result)));
      overview.refresh();
      detail.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-2 px-1" data-chat-workflow-bar="true">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-7 shrink-0 gap-1.5 rounded-full border border-border/60 bg-background/70 px-2.5 text-xs text-secondary-label hover:text-foreground"
              aria-label="AI 작업 열기"
            />
          }
        >
          <GitBranchIcon className="size-3.5" />
          AI 작업
          <ChevronDownIcon className="size-3" />
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          sideOffset={10}
          className="w-[min(28rem,calc(100vw-1.5rem))] rounded-2xl border border-border/70 shadow-xl"
          viewportClassName="max-h-[min(40rem,calc(100dvh-3rem))]"
          onKeyDown={(event) => {
            if (event.key === "Enter") event.stopPropagation();
          }}
        >
          <div className="grid min-w-0 gap-4" data-chat-workflow-panel="true">
            <header className="flex items-start justify-between gap-3">
              <div>
                <PopoverTitle className="flex items-center gap-2 text-sm">
                  <GitBranchIcon className="size-4 text-primary" />
                  AI 작업
                </PopoverTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  선택한 모델로 작업을 실행하고 지속 진행과 참가자를 함께 관리합니다.
                </p>
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="AI 작업 닫기"
                onClick={() => setOpen(false)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </header>
            {modeError ? (
              <p role="alert" className="text-xs text-destructive">
                {modeError}
              </p>
            ) : null}
            <>
              {props.development ? (
                <details className="rounded-xl border border-border/60 bg-muted/20 p-3 text-xs">
                  <summary className="cursor-pointer font-medium">지속 진행·담당 모델 설정</summary>
                  <WorkspaceDevelopmentPanel
                    {...props.development}
                    surface="picker"
                    mainModel={props.currentModel ?? props.development.mainModel}
                    instanceEntries={props.instanceEntries}
                    modelOptionsByInstance={props.modelOptionsByInstance}
                    {...(props.onMainModelChange
                      ? { onMainModelChange: props.onMainModelChange }
                      : {})}
                  />
                </details>
              ) : (
                <p className="text-xs text-muted-foreground">
                  지속 진행 설정은 프로젝트의 기존 대화에서 사용할 수 있습니다.
                </p>
              )}
              {props.meetingConfig.enabled ? (
                <div className="grid gap-2">
                  <details className="rounded-xl border border-border/60 bg-muted/20 p-3 text-xs">
                    <summary className="cursor-pointer font-medium">
                      오케스트라 참가자·실행 설정
                    </summary>
                    {modelMode !== "project" ? (
                      <p className="mt-2 text-muted-foreground">
                        아래 지휘 AI 선택은 모델 선택 방식에서 오케스트라 참가자를 사용할 때
                        적용됩니다. 현재 방식에서는 선택한 총괄 모델이 지휘합니다.
                      </p>
                    ) : null}
                    <fieldset disabled={locked || changingMode}>
                      <MeetingModePanel
                        instanceEntries={props.instanceEntries}
                        modelOptionsByInstance={props.modelOptionsByInstance}
                        profileTarget={{
                          environmentId: project.environmentId,
                          folderKey: `${project.environmentId}:${project.id}`,
                        }}
                      />
                    </fieldset>
                  </details>
                  {missingParticipants ? (
                    <p role="alert" className="text-xs text-destructive">
                      오케스트라 참가자를 2명 이상 선택하세요.
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={locked || changingMode}
                    onClick={() =>
                      updateMeetingComposerConfig((current) => ({ ...current, enabled: false }))
                    }
                  >
                    오케스트라 참가자 사용 끄기
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={locked || changingMode}
                  onClick={() => void selectMode("meeting")}
                >
                  오케스트라 참가자 함께 사용
                </Button>
              )}
              <fieldset disabled={locked} className="grid min-w-0 gap-3" aria-busy={busy}>
                <label className="grid gap-1.5 text-xs font-medium">
                  작업 단계 구성
                  <select
                    aria-label="작업 단계 구성"
                    className={selectClass}
                    value={selectedId}
                    onChange={(event) => {
                      const next = choices.find(
                        (item) => item.definition.id === event.target.value,
                      );
                      setSelectedId(event.target.value);
                      setSavedVersion(null);
                      setConfirmed(null);
                      setError(null);
                      if (next)
                        setValues(chatWorkflowValues(next.definition, values, props.prompt));
                    }}
                  >
                    <option value="">AI가 작업 단계 계획</option>
                    {choices.map((item) => (
                      <option key={item.definition.id} value={item.definition.id}>
                        {item.definition.title}
                        {item.version ? ` · v${item.version.revision}` : " · 기본 템플릿"}
                      </option>
                    ))}
                  </select>
                </label>
                {definition ? (
                  <>
                    <div className="flex flex-wrap gap-1.5" aria-label="실행 단계">
                      {definition.nodes.map((node, index) => (
                        <span
                          key={node.id}
                          className="rounded-md bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground"
                        >
                          {index + 1}. {node.title}
                        </span>
                      ))}
                    </div>
                    {definition.inputs.map((input) => (
                      <label key={input.name} className="grid gap-1.5 text-xs font-medium">
                        {input.label}
                        {input.required ? " *" : ""}
                        {input.type === "string" ? (
                          <Textarea
                            aria-label={input.label}
                            className="text-sm"
                            value={values[input.name] ?? input.defaultValue}
                            onChange={(event) => {
                              setValues((current) => ({
                                ...current,
                                [input.name]: event.target.value,
                              }));
                              setConfirmed(null);
                            }}
                          />
                        ) : (
                          <Input
                            aria-label={input.label}
                            value={values[input.name] ?? input.defaultValue}
                            onChange={(event) => {
                              setValues((current) => ({
                                ...current,
                                [input.name]: event.target.value,
                              }));
                              setConfirmed(null);
                            }}
                          />
                        )}
                      </label>
                    ))}
                    {definition.inputs.some((input) => input.name === "goal") && props.prompt ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="justify-self-start text-xs text-muted-foreground"
                        onClick={() => {
                          setValues((current) => ({ ...current, goal: props.prompt }));
                          setConfirmed(null);
                        }}
                      >
                        채팅 입력 가져오기
                      </Button>
                    ) : null}
                  </>
                ) : selectedId ? null : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      채팅 입력을 작업 목표로 사용하고 선택한 모델이 작업 단계를 계획합니다.
                    </p>
                    {props.attachmentCount > 0 ? (
                      <p role="alert" className="text-xs text-destructive">
                        AI 작업 목표에는 첨부 파일을 포함할 수 없습니다. 파일은 초안에 보존됩니다.
                      </p>
                    ) : null}
                  </>
                )}
                <WorkflowModelSelector
                  environmentId={project.environmentId}
                  mode={modelMode}
                  current={props.currentModel}
                  meetingEnabled={props.meetingConfig.enabled}
                  single={singleModel}
                  roles={roleModelsDraft}
                  onModeChange={(mode) => {
                    setModelMode(mode);
                    setConfirmed(null);
                  }}
                  onSingleChange={(model) => {
                    setSingleModel(model);
                    setConfirmed(null);
                  }}
                  onRoleChange={(role: WorkflowModelRole, model) => {
                    setRoleModelsDraft((current) => ({
                      ...current,
                      [role]: model ?? undefined,
                    }));
                    setConfirmed(null);
                  }}
                />
                {modelMode !== "project" && execution?.meeting ? (
                  <p className="text-xs text-muted-foreground">
                    선택한 총괄 모델이 계획과 진행을 맡습니다. 이번에 선택하지 않은 Fable 모델은
                    실행에서 제외합니다.
                  </p>
                ) : null}
                {meetingSelection?.error ? (
                  <p role="alert" className="text-xs text-destructive">
                    {meetingSelection.error}
                  </p>
                ) : null}
                {assignedParticipants ? (
                  <p role="alert" className="text-xs text-destructive">
                    참가자가 지정된 단계가 있습니다. 역할 모델을 사용하려면 단계의 참가자 지정을
                    해제하세요.
                  </p>
                ) : null}
                {missingProjectRoles.length > 0 ? (
                  <p role="alert" className="text-xs text-destructive">
                    활성 역할 모델이 없습니다:{" "}
                    {missingProjectRoles.map((role) => roleLabels[role] ?? role).join(", ")}. 위에서
                    모델을 직접 선택하거나 프로젝트 역할을 설정하세요.
                  </p>
                ) : null}
              </fieldset>
              <details
                className="rounded-xl border border-border/60 bg-muted/20 p-3 text-xs"
                open={requestMode === "conditions"}
              >
                <summary className="cursor-pointer font-medium">
                  실행 설정 · {permissionLabels[props.runtimeMode]} ·{" "}
                  {props.interactionMode === "plan" ? "계획" : "작업"} ·{" "}
                  {requestLabels[requestMode]}
                </summary>
                <div className="mt-2 grid gap-1.5 text-muted-foreground">
                  <p>현재 채팅의 권한·계획·질문 설정으로 실행합니다.</p>
                  {roleModels ? (
                    <>
                      <p>
                        총괄 · {roleModels.coordinator.instanceId} / {roleModels.coordinator.model}
                      </p>
                      <p>
                        구현 · {roleModels.implementer.instanceId} / {roleModels.implementer.model}
                      </p>
                      <p>
                        조사 · {roleModels.researcher.instanceId} / {roleModels.researcher.model}
                      </p>
                      {execution?.meeting ? (
                        <p>회의 토론은 기존 참가자 모델을 사용합니다.</p>
                      ) : null}
                    </>
                  ) : execution?.meeting ? (
                    execution.meeting.participants.map((seat) => (
                      <p key={seat.id}>
                        {seat.displayName} · {seat.modelSelection.model}
                      </p>
                    ))
                  ) : (
                    <>
                      {roles.data?.roles
                        .filter((role) => role.enabled)
                        .map((role) => (
                          <p key={role.role}>
                            {role.displayName} · {role.modelSelection?.model ?? "AI 연결 필요"}
                          </p>
                        ))}
                      <p>단계별 AI는 프로젝트 역할 설정을 사용합니다.</p>
                    </>
                  )}
                </div>
              </details>
              {requestMode === "conditions" ? (
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={locked || (selectedId ? !definition : !props.prompt.trim())}
                    checked={confirmed === configuration}
                    onChange={(event) => setConfirmed(event.target.checked ? configuration : null)}
                  />
                  목표와 실행 설정을 확인했습니다.
                </label>
              ) : null}
              {preview?.issues.map((issue) => (
                <p key={`${issue.path}:${issue.message}`} className="text-xs text-destructive">
                  {issue.message}
                </p>
              ))}
              {!props.threadId ? (
                <p className="text-xs text-muted-foreground">
                  아직 저장되지 않은 채팅입니다. 실행 후 생성되는 실행 대화를 열 수 있습니다.
                </p>
              ) : null}
              {error ||
              overview.error ||
              roles.error ||
              props.unavailableReason ||
              pendingChanged ? (
                <p
                  role="alert"
                  className="rounded-lg bg-destructive/8 p-2.5 text-xs text-destructive"
                >
                  {pendingChanged
                    ? "이전 요청과 설정이 다릅니다. 원래 설정으로 결과를 확인하거나 실행 기록을 확인하세요."
                    : (error ?? overview.error ?? roles.error ?? props.unavailableReason)}
                </p>
              ) : null}
              {props.startBlocked ? (
                <p className="text-xs text-muted-foreground">
                  진행 중인 전송이나 대기 중인 질문·승인을 처리한 뒤 시작하세요.
                </p>
              ) : null}
              <Button
                type="button"
                className="w-full rounded-xl"
                disabled={
                  busy ||
                  props.startBlocked ||
                  missingModelSelection ||
                  missingParticipants ||
                  !!meetingSelection?.error ||
                  !!assignedParticipants ||
                  projectRolesLoading ||
                  missingProjectRoles.length > 0 ||
                  !!props.unavailableReason ||
                  pendingChanged ||
                  (!selectedId && props.attachmentCount > 0) ||
                  (!pending &&
                    ((selectedId ? !definition || !preview?.valid : !props.prompt.trim()) ||
                      (requestMode === "conditions" && confirmed !== configuration)))
                }
                onClick={() => void execute()}
              >
                <PlayIcon className="size-3.5" />
                {busy
                  ? "처리 중…"
                  : pending
                    ? "같은 요청으로 결과 확인"
                    : selectedId && !version
                      ? "저장 후 실행"
                      : "AI 작업 시작"}
              </Button>
              <p className="-mt-2 text-[11px] text-muted-foreground">
                채팅 초안은 그대로 유지됩니다.
              </p>
              {summary ? (
                <section
                  className="grid gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3"
                  aria-label="AI 작업 실행 상태"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <strong className="truncate">{summary.title}</strong>
                    <span className="shrink-0">
                      {runStatusLabel(summary.status)} · {summary.counts.completed}/
                      {summary.counts.total}
                    </span>
                  </div>
                  {question ? (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      답변이 필요합니다. 실행 대화에서 질문을 확인하세요.
                    </p>
                  ) : null}
                  {summary.error ? (
                    <p className="text-xs text-destructive">{summary.error}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {["queued", "running"].includes(summary.status) ? (
                      <>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void changeRun(summary.control === "active" ? "pause" : "resume")
                          }
                        >
                          {summary.control === "active" ? "일시정지" : "재개"}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void changeRun("cancel")}
                        >
                          취소
                        </Button>
                      </>
                    ) : null}
                    {threadId ? (
                      <Link
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        to="/$environmentId/$threadId"
                        params={{ environmentId: project.environmentId, threadId }}
                      >
                        실행 대화 열기
                        <ArrowUpRightIcon className="size-3" />
                      </Link>
                    ) : null}
                  </div>
                </section>
              ) : null}
              {allRuns.length ? (
                <details className="border-t border-border/60 pt-3 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    프로젝트 실행 기록
                  </summary>
                  <div className="mt-2 grid max-h-40 gap-1 overflow-auto">
                    {allRuns.map((item) => (
                      <Button
                        type="button"
                        key={item.id}
                        size="xs"
                        variant="ghost"
                        className="justify-between gap-2"
                        onClick={() => setSelectedRunId(item.id)}
                      >
                        <span className="truncate">
                          {item.title}
                          {item.workflowRevision !== null ? ` · v${item.workflowRevision}` : ""}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {runStatusLabel(item.status)}
                        </span>
                      </Button>
                    ))}
                  </div>
                </details>
              ) : null}
              <Link
                className="justify-self-end text-xs text-muted-foreground hover:text-foreground"
                to="/control-center/$environmentId/$projectId"
                params={{ environmentId: project.environmentId, projectId: project.id }}
                hash="project-workflows"
              >
                단계·스킬 관리
                <ArrowUpRightIcon className="ml-1 inline size-3" />
              </Link>
            </>
            <Link
              className="justify-self-end text-xs text-muted-foreground hover:text-foreground"
              to="/control-center/$environmentId/$projectId"
              params={{ environmentId: project.environmentId, projectId: project.id }}
              hash="project-runs"
            >
              전체 실행 이력
              <ArrowUpRightIcon className="ml-1 inline size-3" />
            </Link>
          </div>
        </PopoverPopup>
      </Popover>
      {summary ? (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground" role="status">
          {summary.title} · {runStatusLabel(summary.status)}
        </span>
      ) : null}
      {developmentTargetName ? (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground" role="status">
          보낼 대상 · {developmentTargetName}
        </span>
      ) : null}
    </div>
  );
}
