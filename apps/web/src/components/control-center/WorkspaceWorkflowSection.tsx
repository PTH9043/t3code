import { lazy, Suspense, useMemo, useRef, useState } from "react";
import {
  WorkflowDefinition,
  type WorkflowNode,
  type WorkflowVersion,
  type SkillMetadata,
  WorkspaceCollaborationRunId,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import { GitBranchIcon, RefreshCcwIcon } from "lucide-react";
import { previewWorkflow } from "@t3tools/shared/workflow";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useComposerRequestModeStore } from "~/askFirstStore";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ExecutionProfileSelect } from "./ExecutionProfiles";
import { WorkspaceTaskGraphView } from "./WorkspaceTaskGraphView";
import { isWorkflowDraftDirty, workflowEditorRevision } from "./workflowEditor";
import {
  SectionCard,
  notifyCommandFailure,
  notifySuccess,
  useOperationsRevisionRefresh,
} from "./controlCenterShared";

const WorkflowCanvas = lazy(() => import("./WorkflowCanvas"));
const selectClass = "w-full rounded-md border border-input bg-background p-2 text-sm";
const decodeDefinition = Schema.decodeUnknownSync(WorkflowDefinition);
const serialize = Schema.encodeSync(Schema.fromJsonString(WorkflowDefinition));
const decodeWorkflowJson = Schema.decodeUnknownSync(Schema.fromJsonString(WorkflowDefinition));

function WorkflowRunDetails({
  project,
  runId,
  onEdit,
}: {
  project: EnvironmentProject;
  runId: string;
  onEdit: (definition: WorkflowVersion) => void;
}) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workflowRun({
      environmentId: project.environmentId,
      input: { projectId: project.id, runId: WorkspaceCollaborationRunId.make(runId) },
    }),
  );
  const runtime = useEnvironmentQuery(
    orchestrationEnvironment.workspaceRuntime({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  useOperationsRevisionRefresh(runtime.data, result.refresh);
  const run = result.data;
  if (result.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {result.error}
      </p>
    );
  if (!run?.workflow) return <p className="text-sm">선택한 실행을 불러오는 중…</p>;
  return (
    <div className="grid gap-3">
      <p className="text-xs">
        고정 버전 {run.workflow.definitionDigest.slice(0, 12)} · 권한과 참가자는 실행 시작 당시
        선택을 유지합니다. 질문·검증·결과는 협업 실행과 같은 기록입니다.
      </p>
      <Button size="xs" variant="outline" onClick={() => onEdit(run.workflow!.definition)}>
        이 버전으로 새 초안
      </Button>
      {run.graph ? (
        <WorkspaceTaskGraphView graph={run.graph} participants={run.meeting?.participants} />
      ) : (
        <p className="text-sm">실행 계획·질문을 준비하는 중입니다.</p>
      )}
    </div>
  );
}

export function WorkspaceWorkflowSection({ project }: { project: EnvironmentProject }) {
  const queryInput = { environmentId: project.environmentId, input: { projectId: project.id } };
  const overview = useEnvironmentQuery(orchestrationEnvironment.workspaceWorkflows(queryInput));
  const skillCatalog = useEnvironmentQuery(orchestrationEnvironment.workflowSkills(queryInput));
  const runtime = useEnvironmentQuery(orchestrationEnvironment.workspaceRuntime(queryInput));
  useOperationsRevisionRefresh(runtime.data, overview.refresh);
  const saveCommand = useAtomCommand(orchestrationEnvironment.saveWorkflow, {
    reportFailure: false,
  });
  const startCommand = useAtomCommand(orchestrationEnvironment.startWorkflow, {
    reportFailure: false,
  });
  const profiles = useEnvironmentSettings(
    project.environmentId,
    (settings) => settings.executionProfiles,
  );
  const requestMode = useComposerRequestModeStore(
    (state) => state.modeByFolder[`${project.environmentId}:${project.id}`] ?? "direct",
  );
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [inputKeys, setInputKeys] = useState<string[]>([]);
  const [skillKeys, setSkillKeys] = useState<Record<string, string[]>>({});
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [canvas, setCanvas] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmedConfiguration, setConfirmedConfiguration] = useState<string | null>(null);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [skillPath, setSkillPath] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const startRequest = useRef<string | null>(null);
  const saved = overview.data?.definitions.find((entry) => entry.id === draft?.id);
  const node = draft?.nodes.find((entry) => entry.id === selectedId);
  const configuration = JSON.stringify({
    definition: draft,
    values,
    profileId,
    profile: profiles[profileId] ?? null,
    requestMode,
  });
  const conditionsConfirmed = confirmedConfiguration === configuration;
  const preview = useMemo(() => (draft ? previewWorkflow(draft, values) : null), [draft, values]);
  const dirty = isWorkflowDraftDirty(draft, saved);
  const load = (definition: WorkflowDefinition | WorkflowVersion, preserveEditor = false) => {
    setInputKeys(definition.inputs.map(() => randomUUID()));
    setSkillKeys(
      Object.fromEntries(
        definition.nodes.map((entry) => [entry.id, entry.skills.map(() => randomUUID())]),
      ),
    );
    setDraft(decodeDefinition(definition));
    setRevision(
      workflowEditorRevision(
        definition,
        overview.data?.definitions.find((entry) => entry.id === definition.id),
      ),
    );
    setSelectedId(
      preserveEditor && definition.nodes.some((entry) => entry.id === selectedId)
        ? selectedId
        : (definition.nodes[0]?.id ?? ""),
    );
    setValues((current) =>
      preserveEditor
        ? Object.fromEntries(
            definition.inputs
              .filter((entry) => entry.name in current)
              .map((entry) => [entry.name, current[entry.name]!]),
          )
        : {},
    );
    setError(null);
    setConfirmedConfiguration(null);
  };
  const updateNode = (patch: Partial<WorkflowNode>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            nodes: current.nodes.map((entry) =>
              entry.id === selectedId ? { ...entry, ...patch } : entry,
            ),
          }
        : current,
    );
  const save = async (archived = false) => {
    if (!draft) return;
    setBusy(true);
    try {
      const definition = decodeDefinition(draft);
      const result = await saveCommand({
        ...queryInput,
        input: { projectId: project.id, definition, expectedRevision: revision, archived },
      });
      if (notifyCommandFailure(result, "워크플로 저장 실패") || result._tag !== "Success") return;
      load(result.value, true);
      overview.refresh();
      notifySuccess(
        archived ? "워크플로를 보관했습니다." : `v${result.value.revision}으로 저장했습니다.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!draft || !saved || dirty || !preview?.valid) return;
    if (profileId && !profiles[profileId]) {
      setError("실행 프로필을 다시 선택하세요.");
      return;
    }
    if (!profiles[profileId] && !project.defaultModelSelection) {
      setError("프로젝트 기본 모델이나 실행 프로필을 선택하세요.");
      return;
    }
    startRequest.current ??= randomUUID();
    setBusy(true);
    try {
      const result = await startCommand({
        ...queryInput,
        input: {
          projectId: project.id,
          definitionId: saved.id,
          revision: saved.revision,
          values,
          requestId: startRequest.current,
          requestMode,
          conditionsConfirmed,
          ...(profiles[profileId] ? { executionProfile: profiles[profileId] } : {}),
          ...(!profiles[profileId] && project.defaultModelSelection
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
      overview.refresh();
      if (
        notifyCommandFailure(result, "워크플로 시작 결과를 확인하세요") ||
        result._tag !== "Success"
      )
        return;
      setSelectedRunId(result.value.id);
      startRequest.current = null;
      notifySuccess("저장된 버전으로 실행을 시작했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const connectSkill = (skill: SkillMetadata, mode: "native" | "instructions") => {
    if (!node) return;
    setSkillKeys((current) => ({
      ...current,
      [node.id]: [...(current[node.id] ?? []), randomUUID()],
    }));
    updateNode({
      skills: [
        ...node.skills,
        {
          name: skill.name,
          path: skill.path,
          provider: skill.provider,
          digest: skill.digest,
          arguments: "",
          mode,
        },
      ],
    });
  };
  return (
    <SectionCard
      id="project-workflows"
      icon={GitBranchIcon}
      title="저장된 작업 단계·스킬"
      description="단계와 스킬을 저장하고 같은 버전으로 다시 실행합니다. 실행 중 편집은 다음 실행부터 적용됩니다."
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            overview.refresh();
            skillCatalog.refresh();
          }}
        >
          <RefreshCcwIcon className="size-3.5" />
          새로고침
        </Button>
      }
    >
      {overview.error || skillCatalog.error || error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? overview.error ?? skillCatalog.error}
        </p>
      ) : null}
      <fieldset
        className="grid min-w-0 gap-4"
        disabled={busy}
        aria-busy={busy}
        aria-label="워크플로 편집 및 실행"
      >
        <div className="flex flex-wrap gap-2">
          {overview.data?.defaults.map((definition) => (
            <Button
              key={definition.id}
              size="xs"
              variant="outline"
              onClick={() =>
                load(
                  overview.data?.definitions.find((entry) => entry.id === definition.id) ??
                    definition,
                )
              }
            >
              {definition.title}
            </Button>
          ))}
        </div>
        <label className="grid gap-1 text-xs">
          저장한 워크플로
          <select
            className={selectClass}
            value={saved?.id ?? ""}
            onChange={(event) => {
              const version = overview.data?.definitions.find(
                (entry) => entry.id === event.target.value,
              );
              if (version) load(version);
            }}
          >
            <option value="">선택하세요</option>
            {overview.data?.definitions.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.title} · v{definition.revision}
                {definition.archived ? " · 보관됨" : ""}
              </option>
            ))}
          </select>
        </label>
        {draft ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-xs">
                이름
                <Input
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
              <label className="grid gap-1 text-xs">
                워크플로 ID
                <Input
                  value={draft.id}
                  onChange={(event) => {
                    setDraft({ ...draft, id: event.target.value });
                    setRevision(
                      overview.data?.definitions.find((entry) => entry.id === event.target.value)
                        ?.revision ?? 0,
                    );
                  }}
                />
              </label>
            </div>
            <label className="grid gap-1 text-xs">
              설명
              <Textarea
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="xs" onClick={() => void save()} disabled={busy}>
                새 버전 저장
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setDraft({ ...draft, id: `${draft.id}-copy`, title: `${draft.title} 복사` });
                  setRevision(0);
                }}
              >
                복제
              </Button>
              {saved ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void save(!saved.archived)}
                  disabled={busy}
                >
                  {saved.archived ? "보관 해제" : "보관"}
                </Button>
              ) : null}
              <Button size="xs" variant="outline" onClick={() => setCanvas(!canvas)}>
                {canvas ? "단계 폼" : "연결 캔버스"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {revision ? `불러온 버전 v${revision}` : "새 정의"} ·{" "}
              {dirty ? "저장하지 않은 변경 있음" : "저장된 버전"} · 계획 단계 최대 24개 · 현재
              병렬·시도 설정 유지
            </p>
            {canvas ? (
              <Suspense fallback={<p>캔버스를 불러오는 중…</p>}>
                <WorkflowCanvas
                  definition={draft}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  disabled={busy}
                />
              </Suspense>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {draft.nodes.map((entry) => (
                <Button
                  key={entry.id}
                  size="xs"
                  variant={entry.id === selectedId ? "default" : "outline"}
                  onClick={() => setSelectedId(entry.id)}
                >
                  {entry.title}
                </Button>
              ))}
              <Button
                size="xs"
                variant="outline"
                disabled={draft.nodes.length >= 24}
                onClick={() => {
                  const id = `step-${randomUUID()}`;
                  setDraft({
                    ...draft,
                    nodes: [
                      ...draft.nodes,
                      {
                        id,
                        title: "새 단계",
                        kind: "implementation",
                        agent: "codex",
                        participantId: null,
                        task: "목표: {{goal}}",
                        dependsOn: [],
                        successCriteria: [],
                        skills: [],
                      },
                    ],
                  });
                  setSelectedId(id);
                }}
              >
                단계 추가
              </Button>
            </div>
            {node ? (
              <div className="grid gap-3 rounded-xl border p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs">
                    단계 이름
                    <Input
                      value={node.title}
                      onChange={(event) => updateNode({ title: event.target.value })}
                    />
                  </label>
                  <label className="grid gap-1 text-xs">
                    역할
                    <select
                      className={selectClass}
                      value={node.agent}
                      onChange={(event) =>
                        updateNode({ agent: event.target.value as WorkflowNode["agent"] })
                      }
                    >
                      <option value="fable">총괄 역할</option>
                      <option value="codex">구현 역할</option>
                      <option value="grok">조사 역할</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs">
                    작업 종류
                    <select
                      className={selectClass}
                      value={node.kind}
                      onChange={(event) =>
                        updateNode({ kind: event.target.value as WorkflowNode["kind"] })
                      }
                    >
                      {["orchestration", "research", "implementation", "debug"].map((kind) => (
                        <option key={kind}>{kind}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs">
                    참가자 ID (실행 프로필의 참가자)
                    <Input
                      value={node.participantId ?? ""}
                      onChange={(event) =>
                        updateNode({ participantId: event.target.value || null })
                      }
                    />
                  </label>
                </div>
                <p className="text-xs text-muted-foreground break-all">단계 ID: {node.id}</p>
                <label className="grid gap-1 text-xs">
                  작업 내용 · 입력은 {"{{이름}}"}
                  <Textarea
                    value={node.task}
                    onChange={(event) => updateNode({ task: event.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-xs">
                  완료 기준 (한 줄에 하나)
                  <Textarea
                    value={node.successCriteria.join("\n")}
                    onChange={(event) =>
                      updateNode({
                        successCriteria: event.target.value.split(/\r?\n/).filter(Boolean),
                      })
                    }
                  />
                </label>
                <fieldset className="grid gap-1 text-xs">
                  <legend>선행 단계</legend>
                  {draft.nodes
                    .filter((entry) => entry.id !== node.id)
                    .map((entry) => (
                      <label key={entry.id} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={node.dependsOn.includes(entry.id)}
                          onChange={(event) =>
                            updateNode({
                              dependsOn: event.target.checked
                                ? [...node.dependsOn, entry.id]
                                : node.dependsOn.filter((id) => id !== entry.id),
                            })
                          }
                        />
                        {entry.title}
                      </label>
                    ))}
                </fieldset>
                <label className="grid gap-1 text-xs">
                  연결할 스킬
                  <select
                    className={selectClass}
                    value={skillPath}
                    onChange={(event) => setSkillPath(event.target.value)}
                  >
                    <option value="">선택하세요</option>
                    {skillCatalog.data?.skills.map((skill) => (
                      <option
                        key={`${skill.provider}:${skill.path}`}
                        value={`${skill.provider}:${skill.path}`}
                        disabled={!skill.enabled || !["both", "manual"].includes(skill.invocation)}
                      >
                        {skill.provider} · {skill.name}
                        {!skill.enabled
                          ? " · 비활성/오류"
                          : skill.invocation === "model"
                            ? " · 자동 호출 전용"
                            : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {(() => {
                  const skill = skillCatalog.data?.skills.find(
                    (entry) => `${entry.provider}:${entry.path}` === skillPath,
                  );
                  return skill ? (
                    <div className="grid gap-2 text-xs">
                      <p>{skill.description}</p>
                      <p className="break-all">
                        {skill.path} · {skill.digest.slice(0, 12)}
                      </p>
                      {skill.diagnostics.map((message) => (
                        <p key={message} role="alert">
                          {message}
                        </p>
                      ))}
                      <div className="flex gap-2">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={
                            !skill.enabled || !["codex", "claudeAgent"].includes(skill.provider)
                          }
                          onClick={() => connectSkill(skill, "native")}
                        >
                          네이티브로 연결
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={!skill.enabled || skill.nativeOnly}
                          onClick={() => connectSkill(skill, "instructions")}
                        >
                          지침으로 연결
                        </Button>
                      </div>
                    </div>
                  ) : null;
                })()}
                {node.skills.map((skill, index) => (
                  <div
                    key={skillKeys[node.id]?.[index]}
                    className="grid gap-1 rounded border p-2 text-xs"
                  >
                    <strong>
                      {skill.name} · {skill.mode === "native" ? "네이티브 호출" : "지침 전달"} ·{" "}
                      {skill.digest.slice(0, 12)}
                    </strong>
                    <Input
                      aria-label={`${skill.name} 인자`}
                      value={skill.arguments}
                      onChange={(event) =>
                        updateNode({
                          skills: node.skills.map((entry, i) =>
                            i === index ? { ...entry, arguments: event.target.value } : entry,
                          ),
                        })
                      }
                    />
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setSkillKeys((current) => ({
                          ...current,
                          [node.id]: (current[node.id] ?? []).filter((_, i) => i !== index),
                        }));
                        updateNode({ skills: node.skills.filter((_, i) => i !== index) });
                      }}
                    >
                      연결 해제
                    </Button>
                  </div>
                ))}
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={draft.nodes.length === 1}
                  onClick={() => {
                    setDraft({
                      ...draft,
                      nodes: draft.nodes
                        .filter((entry) => entry.id !== node.id)
                        .map((entry) => ({
                          ...entry,
                          dependsOn: entry.dependsOn.filter((id) => id !== node.id),
                        })),
                    });
                    setSelectedId(draft.nodes.find((entry) => entry.id !== node.id)?.id ?? "");
                  }}
                >
                  단계 삭제
                </Button>
              </div>
            ) : null}
            <fieldset className="grid gap-2 rounded-xl border p-3">
              <legend className="text-sm font-medium">워크플로 입력</legend>
              {draft.inputs.map((input, index) => (
                <div key={inputKeys[index]} className="grid gap-2 sm:grid-cols-4">
                  <Input
                    aria-label="입력 이름"
                    value={input.name}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        inputs: draft.inputs.map((entry, i) =>
                          i === index ? { ...entry, name: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label="입력 표시 이름"
                    value={input.label}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        inputs: draft.inputs.map((entry, i) =>
                          i === index ? { ...entry, label: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                  <select
                    aria-label="입력 형식"
                    className={selectClass}
                    value={input.type}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        inputs: draft.inputs.map((entry, i) =>
                          i === index
                            ? { ...entry, type: event.target.value as typeof input.type }
                            : entry,
                        ),
                      })
                    }
                  >
                    {["string", "number", "boolean", "path"].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={input.required}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          inputs: draft.inputs.map((entry, i) =>
                            i === index ? { ...entry, required: event.target.checked } : entry,
                          ),
                        })
                      }
                    />
                    필수
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setInputKeys((current) => current.filter((_, i) => i !== index));
                        setDraft({ ...draft, inputs: draft.inputs.filter((_, i) => i !== index) });
                      }}
                    >
                      삭제
                    </Button>
                  </label>
                  <Input
                    className="sm:col-span-2"
                    aria-label={`${input.label} 기본값`}
                    placeholder="기본값"
                    value={input.defaultValue}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        inputs: draft.inputs.map((entry, i) =>
                          i === index ? { ...entry, defaultValue: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                  <Input
                    className="sm:col-span-2"
                    aria-label={`${input.label} 실행 입력`}
                    placeholder={`${input.label} 실행 입력`}
                    value={values[input.name] ?? input.defaultValue}
                    onChange={(event) => {
                      setValues({ ...values, [input.name]: event.target.value });
                      setConfirmedConfiguration(null);
                    }}
                  />
                </div>
              ))}
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setInputKeys((current) => [...current, randomUUID()]);
                  setDraft({
                    ...draft,
                    inputs: [
                      ...draft.inputs,
                      {
                        name: `input${draft.inputs.length + 1}`,
                        label: "새 입력",
                        type: "string",
                        required: false,
                        defaultValue: "",
                      },
                    ],
                  });
                }}
              >
                입력 추가
              </Button>
            </fieldset>
            <ExecutionProfileSelect
              environmentId={project.environmentId}
              value={profileId}
              onChange={setProfileId}
            />
            <p className="text-xs text-muted-foreground">
              현재 요청 모드:{" "}
              {requestMode === "ask-first"
                ? "질문하기"
                : requestMode === "conditions"
                  ? "조건 확인"
                  : "바로 실행"}
              . 프로필을 선택하지 않으면 프로젝트에서 선택한 기본 모델과 기존 역할의 권한·계획
              모드로 실행합니다.
            </p>
            {preview?.issues.map((issue) => (
              <p key={`${issue.path}:${issue.message}`} className="text-xs text-destructive">
                {issue.path}: {issue.message}
              </p>
            ))}
            <details className="text-xs">
              <summary>실행할 단계와 입력 확인</summary>
              {preview?.nodes.map((entry) => (
                <pre className="mt-2 whitespace-pre-wrap rounded bg-muted p-2" key={entry.id}>
                  {entry.title}
                  {"\n"}
                  {entry.task}
                  {"\n"}
                  {entry.successCriteria.join("\n")}
                </pre>
              ))}
            </details>
            {requestMode === "conditions" ? (
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={conditionsConfirmed}
                  onChange={(event) =>
                    setConfirmedConfiguration(event.target.checked ? configuration : null)
                  }
                />
                현재 입력과 단계 구성을 확인했습니다.
              </label>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={
                  busy ||
                  dirty ||
                  !saved ||
                  (!profiles[profileId] && !project.defaultModelSelection) ||
                  saved.archived ||
                  !preview?.valid ||
                  (requestMode === "conditions" && !conditionsConfirmed)
                }
                onClick={() => void start()}
              >
                저장된 v{saved?.revision ?? "?"} 실행
              </Button>
              {startRequest.current ? (
                <p className="text-xs">
                  시작 결과가 미확인이면 같은 입력으로 다시 확인하세요. 중복 실행은 요청 ID로
                  방지합니다.
                </p>
              ) : null}
            </div>
            <details className="grid gap-2 text-xs">
              <summary>정의 가져오기·내보내기 / AI 초안</summary>
              <p className="my-2 text-muted-foreground">
                JSON 정의를 검증해 폼과 캔버스에 불러옵니다. AI가 만든 초안도 같은 검사를 거칩니다.
              </p>
              <Textarea
                aria-label="워크플로 JSON"
                className="min-h-40 font-mono text-xs"
                value={json}
                onChange={(event) => setJson(event.target.value)}
              />
              <div className="mt-2 flex gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    try {
                      setJson(serialize(draft));
                      setError(null);
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    }
                  }}
                >
                  내보내기
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    try {
                      load(decodeWorkflowJson(json));
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : "정의 형식을 확인하세요.");
                    }
                  }}
                >
                  검증 후 불러오기
                </Button>
              </div>
            </details>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            기본 템플릿 또는 저장한 워크플로를 선택하세요.
          </p>
        )}
        <details className="grid gap-2 border-t pt-4">
          <summary className="cursor-pointer text-sm font-medium">
            이전 실행의 저장된 단계 불러오기
          </summary>
          {overview.data?.runs.map((run) => (
            <Button key={run.id} size="xs" variant="ghost" onClick={() => setSelectedRunId(run.id)}>
              {run.workflow.title} v{run.workflow.definitionRevision}
            </Button>
          ))}
        </details>
        {selectedRunId ? (
          <WorkflowRunDetails
            project={project}
            runId={selectedRunId}
            onEdit={(version) => {
              load(version);
              setRevision(
                overview.data?.definitions.find((entry) => entry.id === version.id)?.revision ?? 0,
              );
            }}
          />
        ) : null}
      </fieldset>
    </SectionCard>
  );
}
