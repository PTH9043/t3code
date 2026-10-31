import { useRef, useState } from "react";
import { InboxIcon } from "lucide-react";
import {
  WorkspaceTaskRecipeDefinition,
  type WorkspaceTaskInputs,
  type WorkspaceTaskAction,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  starterTaskRecipes,
  taskInboxActions,
  taskInboxActionLabels,
  taskInboxStatus,
} from "@t3tools/client-runtime/state/task-inbox";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Dialog, DialogHeader, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import { ExecutionProfileSelect } from "./ExecutionProfiles";
import {
  SectionCard,
  formatTimestamp,
  notifyCommandFailure,
  notifySuccess,
} from "./controlCenterShared";

const SELECT = "w-full rounded-md border border-input bg-background p-2 text-sm";
const decode = Schema.decodeUnknownOption(WorkspaceTaskRecipeDefinition);

function TaskDetail({
  project,
  taskId,
  close,
}: {
  project: EnvironmentProject;
  taskId: string;
  close: () => void;
}) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.taskInboxTask({
      environmentId: project.environmentId,
      input: { projectId: project.id, taskId },
    }),
  );
  const task = result.data;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="w-full max-w-4xl">
        <DialogHeader>
          <DialogTitle>자동 업무 실행 자료</DialogTitle>
          <DialogDescription>업무 입력, 현재 시도와 실제 결과 확인 기록</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-3 overflow-auto px-6 pb-6 text-sm">
          {result.error ? (
            <p role="alert" className="text-destructive">
              {result.error}
            </p>
          ) : null}
          {task ? (
            <>
              <p>
                {task.recipe.name} v{task.recipe.revision} · {taskInboxStatus[task.status]} · 시도{" "}
                {task.attempt + 1}
              </p>
              <p className="break-all text-xs">
                출처 {task.source} · 이벤트 {task.externalId} · {formatTimestamp(task.updatedAt)}
              </p>
              {Object.entries(task.inputs).map(([key, value]) => (
                <p key={key} className="whitespace-pre-wrap break-words">
                  <strong>{key}</strong>: {value}
                </p>
              ))}
              {task.error ? <p className="text-destructive">{task.error}</p> : null}
              {task.receipts.map((receipt) => (
                <details
                  key={`${receipt.kind}:${receipt.label}:${receipt.observedAt}:${receipt.sha256}`}
                  className="rounded border p-3"
                >
                  <summary className="cursor-pointer break-all">
                    {receipt.passed ? "통과" : "실패"} · {receipt.label}
                  </summary>
                  <p className="mt-2 text-xs">
                    {formatTimestamp(receipt.observedAt)} · 종료 코드{" "}
                    {receipt.exitCode ?? "해당 없음"}
                  </p>
                  {receipt.sha256 ? (
                    <p className="break-all text-xs">SHA-256 {receipt.sha256}</p>
                  ) : null}
                  <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                    {receipt.output}
                  </pre>
                </details>
              ))}
              <pre className="whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
                {task.output || "아직 저장된 최종 출력이 없습니다."}
              </pre>
            </>
          ) : !result.error ? (
            <p>실행 자료를 불러오는 중…</p>
          ) : null}
          <Button variant="outline" onClick={result.refresh}>
            자료 새로고침
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function RecipeEditor({
  project,
  recipe,
  saved,
  close,
}: {
  project: EnvironmentProject;
  recipe: WorkspaceTaskRecipeDefinition;
  saved: () => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState(recipe);
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const profiles = useEnvironmentSettings(
    project.environmentId,
    (settings) => settings.executionProfiles,
  );
  const saveRecipe = useAtomCommand(orchestrationEnvironment.saveTaskRecipe, {
    reportFailure: false,
  });
  const update = <K extends keyof WorkspaceTaskRecipeDefinition>(
    key: K,
    value: WorkspaceTaskRecipeDefinition[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const parameterKeys = useRef(recipe.parameters.map(() => randomUUID()));
  const artifactKeys = useRef(recipe.artifacts.map(() => randomUUID()));
  const updateParameters = (items: WorkspaceTaskRecipeDefinition["parameters"]) => {
    if (items.length !== draft.parameters.length) {
      const previousKeys = parameterKeys.current;
      parameterKeys.current = items.map(
        (item) => previousKeys[draft.parameters.indexOf(item)] ?? randomUUID(),
      );
    }
    update("parameters", items);
  };
  const updateArtifacts = (items: WorkspaceTaskRecipeDefinition["artifacts"]) => {
    if (items.length !== draft.artifacts.length) {
      const previousKeys = artifactKeys.current;
      artifactKeys.current = items.map(
        (item) => previousKeys[draft.artifacts.indexOf(item)] ?? randomUUID(),
      );
    }
    update("artifacts", items);
  };
  const save = async () => {
    if (profileId && !profiles[profileId]) {
      setError("선택한 실행 프로필이 삭제됐습니다. 다시 선택하세요.");
      return;
    }
    const decoded = decode({
      ...draft,
      name: draft.name.trim(),
      executionProfile: profileId ? (profiles[profileId] ?? null) : draft.executionProfile,
    });
    if (decoded._tag === "None") {
      setError(
        "이름·지시문·입력 항목과 명령의 형식을 확인하세요. 입력은 최대 12개, 검증 명령은 최대 8개입니다.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await saveRecipe({
        environmentId: project.environmentId,
        input: { projectId: project.id, recipe: decoded.value },
      });
      if (!notifyCommandFailure(result, "업무 양식 저장 실패")) {
        saved();
        close();
        notifySuccess("새 버전의 업무 양식을 저장했습니다.");
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="w-full max-w-3xl">
        <DialogHeader>
          <DialogTitle>자동 업무 양식 편집</DialogTitle>
          <DialogDescription>
            입력·실행 방법·성공 조건을 저장합니다. 이미 접수한 작업은 원래 버전을 유지합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-auto px-6 pb-6 text-sm">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <label className="grid gap-1">
            양식 이름
            <Input
              value={draft.name}
              onChange={(event) => update("name", event.currentTarget.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => update("enabled", event.currentTarget.checked)}
            />
            새 작업 접수 허용
          </label>
          <label className="grid gap-1">
            작업 지시
            <Textarea
              value={draft.taskTemplate}
              onChange={(event) => update("taskTemplate", event.currentTarget.value)}
            />
            <span className="text-xs text-muted-foreground">
              입력 항목을 {"{{topic}}"} 형태로 참조할 수 있습니다.
            </span>
          </label>
          <div className="space-y-2">
            <p className="font-medium">입력 항목</p>
            {draft.parameters.map((field, index) => (
              <div
                key={parameterKeys.current[index]}
                className="grid gap-2 rounded border p-2 sm:grid-cols-2"
              >
                <Input
                  aria-label={`입력 ${index + 1} 이름`}
                  placeholder="영문 이름: topic"
                  value={field.name}
                  onChange={(event) =>
                    updateParameters(
                      draft.parameters.map((item, i) =>
                        i === index ? { ...item, name: event.currentTarget.value } : item,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={`입력 ${index + 1} 표시 이름`}
                  placeholder="표시 이름: 조사 주제"
                  value={field.label}
                  onChange={(event) =>
                    updateParameters(
                      draft.parameters.map((item, i) =>
                        i === index ? { ...item, label: event.currentTarget.value } : item,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={`입력 ${index + 1} 기본값`}
                  placeholder="기본값"
                  value={field.defaultValue}
                  onChange={(event) =>
                    updateParameters(
                      draft.parameters.map((item, i) =>
                        i === index ? { ...item, defaultValue: event.currentTarget.value } : item,
                      ),
                    )
                  }
                />
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(event) =>
                        updateParameters(
                          draft.parameters.map((item, i) =>
                            i === index ? { ...item, required: event.currentTarget.checked } : item,
                          ),
                        )
                      }
                    />
                    필수
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => updateParameters(draft.parameters.filter((_, i) => i !== index))}
                  >
                    항목 삭제
                  </Button>
                </div>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={draft.parameters.length >= 12}
              onClick={() =>
                updateParameters([
                  ...draft.parameters,
                  {
                    name: `input${draft.parameters.length + 1}`,
                    label: "입력",
                    required: true,
                    defaultValue: "",
                  },
                ])
              }
            >
              입력 항목 추가
            </Button>
          </div>
          <label className="grid gap-1">
            실행 방법
            <select
              className={SELECT}
              value={draft.execution}
              onChange={(event) =>
                update("execution", event.currentTarget.value === "script" ? "script" : "agent")
              }
            >
              <option value="agent">AI에 업무 배정</option>
              <option value="script">AI 없이 명령 실행</option>
            </select>
          </label>
          {draft.execution === "agent" ? (
            <>
              <ExecutionProfileSelect
                environmentId={project.environmentId}
                value={profileId}
                onChange={setProfileId}
              />
              <p className="text-xs text-muted-foreground">
                현재 저장된 프로필: {draft.executionProfile?.name ?? "프로젝트 기본 역할"}. 선택한
                프로필의 버전과 검증 명령도 함께 보관합니다.
              </p>
              {draft.executionProfile ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setProfileId("");
                    update("executionProfile", null);
                  }}
                >
                  프로젝트 기본 역할 사용
                </Button>
              ) : null}
            </>
          ) : (
            <label className="grid gap-1">
              실행 명령
              <Input
                value={draft.script}
                placeholder="node scripts/process-files.cjs"
                onChange={(event) => update("script", event.currentTarget.value)}
              />
            </label>
          )}
          <div className="space-y-2">
            <label className="grid gap-1">
              AI 호출 전 확인
              <select
                className={SELECT}
                value={draft.precheck.kind}
                onChange={(event) =>
                  update(
                    "precheck",
                    event.currentTarget.value === "files"
                      ? { kind: "files", paths: ["input.json"] }
                      : event.currentTarget.value === "command"
                        ? { kind: "command", command: "node scripts/check-changes.cjs" }
                        : { kind: "none" },
                  )
                }
              >
                <option value="none">항상 실행</option>
                <option value="files">파일 내용이 바뀔 때 실행</option>
                <option value="command">확인 명령이 변경을 보고할 때 실행</option>
              </select>
            </label>
            {draft.precheck.kind === "files" ? (
              <label className="grid gap-1">
                확인할 상대 경로 · 한 줄에 하나
                <Textarea
                  value={draft.precheck.paths.join("\n")}
                  onChange={(event) =>
                    update("precheck", {
                      kind: "files",
                      paths: event.currentTarget.value.split(/\r?\n/).filter(Boolean),
                    })
                  }
                />
              </label>
            ) : null}
            {draft.precheck.kind === "command" ? (
              <label className="grid gap-1">
                변화 확인 명령
                <Input
                  value={draft.precheck.command}
                  onChange={(event) =>
                    update("precheck", { kind: "command", command: event.currentTarget.value })
                  }
                />
                <span className="text-xs text-muted-foreground">
                  읽기 전용 명령을 사용하세요. 종료 코드 0과{" "}
                  {'{"changed": true 또는 false, "context": "선택 자료"}'} JSON 출력이 필요합니다.
                </span>
              </label>
            ) : null}
          </div>
          <label className="grid gap-1">
            실제 검증 명령 · 한 줄에 하나
            <Textarea
              value={draft.verificationCommands.join("\n")}
              placeholder="프로젝트의 관련 테스트 명령"
              onChange={(event) =>
                update(
                  "verificationCommands",
                  event.currentTarget.value.split(/\r?\n/).filter(Boolean),
                )
              }
            />
          </label>
          <div className="space-y-2">
            <p className="font-medium">필수 산출물</p>
            {draft.artifacts.map((artifact, index) => (
              <div key={artifactKeys.current[index]} className="grid gap-2 rounded border p-2">
                <Input
                  aria-label={`산출물 ${index + 1} 경로`}
                  value={artifact.path}
                  placeholder="reports/result.json"
                  onChange={(event) =>
                    updateArtifacts(
                      draft.artifacts.map((item, i) =>
                        i === index ? { ...item, path: event.currentTarget.value } : item,
                      ),
                    )
                  }
                />
                <select
                  className={SELECT}
                  aria-label={`산출물 ${index + 1} 형식`}
                  value={artifact.format}
                  onChange={(event) =>
                    updateArtifacts(
                      draft.artifacts.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              format: event.currentTarget.value === "json" ? "json" : "text",
                            }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="text">비어 있지 않은 텍스트</option>
                  <option value="json">JSON 파일</option>
                </select>
                {artifact.format === "json" ? (
                  <Input
                    aria-label={`산출물 ${index + 1} JSON 필수 필드`}
                    value={artifact.requiredKeys.join(", ")}
                    placeholder="필수 필드: inputs, outputs"
                    onChange={(event) =>
                      updateArtifacts(
                        draft.artifacts.map((item, i) =>
                          i === index
                            ? {
                                ...item,
                                requiredKeys: event.currentTarget.value
                                  .split(",")
                                  .map((key) => key.trim())
                                  .filter(Boolean),
                              }
                            : item,
                        ),
                      )
                    }
                  />
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updateArtifacts(draft.artifacts.filter((_, i) => i !== index))}
                >
                  산출물 삭제
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={draft.artifacts.length >= 10}
              onClick={() =>
                updateArtifacts([
                  ...draft.artifacts,
                  { path: "reports/result.md", format: "text", requiredKeys: [] },
                ])
              }
            >
              산출물 추가
            </Button>
            <p className="text-xs text-muted-foreground">
              프로젝트 루트 기준으로 검사하며 실행 전과 내용이 같은 파일은 통과하지 않습니다. AI
              업무에 검증 명령·산출물이 없으면 검증 대기로 남습니다.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Windows 명령은 CMD로 실행합니다. 명령에는 입력값을 직접 삽입하지 않으며 스크립트에서
            T3_TASK_INPUTS_JSON 환경 변수를 읽을 수 있습니다.
          </p>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "저장 중…" : "새 버전 저장"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

export function WorkspaceTaskInboxSection({ project }: { project: EnvironmentProject }) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.taskInbox({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const [selected, setSelected] = useState("");
  const [inputs, setInputs] = useState<WorkspaceTaskInputs>({});
  const [externalId, setExternalId] = useState("");
  const [source, setSource] = useState("manual");
  const [editor, setEditor] = useState<WorkspaceTaskRecipeDefinition | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = useAtomCommand(orchestrationEnvironment.submitInboxTask, { reportFailure: false });
  const act = useAtomCommand(orchestrationEnvironment.actOnInboxTask, { reportFailure: false });
  const recipe = result.data?.recipes.find((item) => item.id === selected);

  const choose = (id: string) => {
    setSelected(id);
    setInputs({});
  };
  const send = async () => {
    if (!recipe || !recipe.enabled) return;
    setBusy(true);
    try {
      const response = await submit({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          recipeId: recipe.id,
          recipeRevision: recipe.revision,
          inputs,
          source: source.trim() || "manual",
          externalId: externalId.trim() || randomUUID(),
        },
      });
      if (!notifyCommandFailure(response, "업무 접수 실패")) {
        result.refresh();
        setExternalId("");
        notifySuccess("업무를 접수했습니다. 프로젝트의 기존 작업이 끝나면 실행합니다.");
      }
    } finally {
      setBusy(false);
    }
  };
  const action = async (taskId: string, value: WorkspaceTaskAction["action"]) => {
    setBusy(true);
    try {
      const response = await act({
        environmentId: project.environmentId,
        input: { projectId: project.id, taskId, action: value },
      });
      if (!notifyCommandFailure(response, "업무 상태 변경 실패")) result.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionCard
        id="project-task-inbox"
        icon={InboxIcon}
        title="자동 업무 접수함"
        description="저장한 양식으로 업무를 접수합니다. 변화 확인, AI 배정, 명령 실행과 결과 검사를 기록합니다."
        action={
          <Button size="sm" variant="outline" onClick={result.refresh}>
            새로고침
          </Button>
        }
      >
        {result.error ? (
          <p role="alert" className="text-sm text-destructive">
            {result.error}
          </p>
        ) : null}
        <div className="space-y-4">
          <p className="text-sm">
            전체 {result.data?.totalTasks ?? 0} · 결과 검사 통과 {result.data?.completed ?? 0} · AI
            생략 {result.data?.aiSkipped ?? 0} · 진행·보류 {result.data?.waiting ?? 0}
          </p>
          <div className="flex flex-wrap gap-2">
            {starterTaskRecipes.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant="outline"
                onClick={() => setEditor({ ...item, id: `recipe-${randomUUID()}` })}
              >
                {item.name} 양식 만들기
              </Button>
            ))}
          </div>
          <label className="grid gap-1 text-sm">
            업무 양식
            <select
              className={SELECT}
              value={selected}
              onChange={(event) => choose(event.currentTarget.value)}
            >
              <option value="">저장된 양식 선택</option>
              {result.data?.recipes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} v{item.revision}
                  {item.enabled ? "" : " · 접수 중지"}
                </option>
              ))}
            </select>
          </label>
          {recipe ? (
            <div className="space-y-3 rounded border p-3">
              <Button size="sm" variant="outline" onClick={() => setEditor(recipe)}>
                양식 편집·접수 상태 변경
              </Button>
              {recipe.parameters.map((field) => (
                <label key={field.name} className="grid gap-1 text-sm">
                  {field.label}
                  {field.required ? " *" : ""}
                  <Textarea
                    value={inputs[field.name] ?? field.defaultValue}
                    onChange={(event) =>
                      setInputs((current) => ({
                        ...current,
                        [field.name]: event.currentTarget.value,
                      }))
                    }
                  />
                </label>
              ))}
              <details className="text-sm">
                <summary className="cursor-pointer">외부 이벤트 식별</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1">
                    출처
                    <Input
                      value={source}
                      onChange={(event) => setSource(event.currentTarget.value)}
                    />
                  </label>
                  <label className="grid gap-1">
                    이벤트 ID · 비우면 새 작업
                    <Input
                      value={externalId}
                      onChange={(event) => setExternalId(event.currentTarget.value)}
                    />
                  </label>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  같은 출처·이벤트 ID·입력은 한 번만 접수합니다. 수정된 이벤트에는 새 ID를
                  사용하세요.
                </p>
              </details>
              <Button disabled={busy || !recipe.enabled} onClick={() => void send()}>
                업무 접수
              </Button>
            </div>
          ) : null}
          <div className="space-y-2">
            {result.data?.tasks.map((task) => (
              <div key={task.id} className="space-y-2 rounded border p-3 text-sm">
                <p className="font-medium">
                  {task.recipeName} v{task.recipeRevision} · {taskInboxStatus[task.status]}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {task.source} · {task.externalId} · 시도 {task.attempt + 1} ·{" "}
                  {formatTimestamp(task.updatedAt)}
                </p>
                {task.error ? <p className="text-xs text-destructive">{task.error}</p> : null}
                {task.status === "needs-verification" ? (
                  <p className="text-xs text-muted-foreground">
                    양식에 성공 확인 조건을 추가하고 새 업무로 접수하세요. 이 기록은 원래 양식
                    버전을 유지합니다.
                  </p>
                ) : null}
                {task.status === "delivery-unknown" ? (
                  <p className="text-xs text-muted-foreground">
                    이미 반영된 변경이 있는지 확인하세요. 새 시도는 업무를 다시 수행합니다.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setDetail(task.id)}>
                    입력·실행 자료
                  </Button>
                  {taskInboxActions(task.status, !!task.runId).map((value) => (
                    <Button
                      key={value}
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void action(task.id, value)}
                    >
                      {taskInboxActionLabels[value]}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {result.data?.totalTasks ? (
            <p className="text-xs text-muted-foreground">
              최근 최대 50건을 표시합니다. 이전 시도의 상태와 실행 자료도 서버 원장에 보존합니다.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              양식을 저장하고 첫 업무를 접수하세요. 예약에서도 저장한 양식을 사용할 수 있습니다.
            </p>
          )}
        </div>
      </SectionCard>
      {editor ? (
        <RecipeEditor
          key={editor.id}
          project={project}
          recipe={editor}
          saved={result.refresh}
          close={() => setEditor(null)}
        />
      ) : null}
      {detail ? (
        <TaskDetail project={project} taskId={detail} close={() => setDetail(null)} />
      ) : null}
    </>
  );
}
