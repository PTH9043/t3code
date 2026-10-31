import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  WorkspaceCollaborationRunId,
  WorkflowDefinition,
  WorkspaceWorkflowError,
  type WorkflowSave,
  type WorkflowStart,
  type WorkflowControl,
  type ProjectId,
  type WorkflowVersion,
  type WorkflowRunLookup,
  type WorkspaceWorkflowContext,
} from "@t3tools/contracts";
import { previewWorkflow, workflowDefaults } from "@t3tools/shared/workflow";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { WorkspaceWorkflowStore } from "../persistence/WorkspaceWorkflowStore.ts";
import { makeWorkflowSkills } from "./WorkflowSkills.ts";

const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isWorkflowError = Schema.is(WorkspaceWorkflowError);
const decodeDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const failure = (cause: unknown) =>
  isWorkflowError(cause)
    ? cause
    : new WorkspaceWorkflowError({
        message: cause instanceof Error ? cause.message : "워크플로 요청을 처리하지 못했습니다.",
        cause,
      });
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makeWorkspaceWorkflow = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const store = yield* WorkspaceWorkflowStore;
  const crypto = yield* Crypto.Crypto;
  const skills = yield* makeWorkflowSkills;
  const project = Effect.fn("WorkspaceWorkflow.project")(function* (projectId: ProjectId) {
    const found = yield* query.getProjectShellById(projectId);
    if (Option.isNone(found))
      return yield* new WorkspaceWorkflowError({ message: "프로젝트를 찾을 수 없습니다." });
    return found.value;
  }, Effect.mapError(failure));
  const overview = Effect.fn("WorkspaceWorkflow.overview")(function* ({
    projectId,
  }: {
    projectId: ProjectId;
  }) {
    yield* project(projectId);
    const definitions = yield* store.list(projectId);
    const runs = yield* store.listRunSummaries(projectId);
    const allRuns = yield* store.listAiTaskRuns(projectId);
    return { definitions, defaults: workflowDefaults(), runs, allRuns };
  }, Effect.mapError(failure));
  const save = Effect.fn("WorkspaceWorkflow.save")(function* (input: WorkflowSave) {
    const owner = yield* project(input.projectId);
    const raw = yield* decodeDefinition(input.definition).pipe(Effect.mapError(failure));
    const structural = previewWorkflow(raw, {}, { allowMissingRequired: true });
    if (!structural.valid)
      return yield* new WorkspaceWorkflowError({
        message: structural.issues.map((issue) => issue.message).join("\n"),
      });
    const previous = yield* store.get(input.projectId, raw.id);
    if ((previous?.revision ?? 0) !== input.expectedRevision)
      return yield* new WorkspaceWorkflowError({
        message: "워크플로 버전이 바뀌었습니다. 최신 버전을 불러온 뒤 저장하세요.",
      });
    const catalog = raw.nodes.some((node) => node.skills.length > 0)
      ? yield* skills.catalog(owner.workspaceRoot)
      : { skills: [] };
    const nodes = yield* Effect.forEach(raw.nodes, (node) =>
      Effect.gen(function* () {
        const bindings = yield* Effect.forEach(node.skills, (binding) =>
          Effect.gen(function* () {
            const retained = previous?.nodes
              .flatMap((entry) => entry.skills)
              .find(
                (entry) =>
                  entry.digest === binding.digest &&
                  entry.path === binding.path &&
                  entry.provider === binding.provider &&
                  entry.mode === binding.mode &&
                  entry.snapshotPath === binding.snapshotPath,
              );
            const pinned = retained?.snapshotPath
              ? retained
              : yield* store.retainedBinding(input.projectId, raw.id, binding);
            if (pinned?.snapshotPath) return { ...pinned, arguments: binding.arguments };
            const found = catalog.skills.find(
              (entry) => entry.path === binding.path && entry.provider === binding.provider,
            );
            if (!found)
              return yield* new WorkspaceWorkflowError({
                message: `스킬 ${binding.name}의 설치 경로를 확인할 수 없습니다.`,
              });
            return yield* skills.pin(binding, found);
          }),
        );
        return { ...node, skills: bindings };
      }),
    );
    const definition = { ...raw, nodes };
    const version: WorkflowVersion = {
      ...definition,
      revision: input.expectedRevision + 1,
      archived: input.archived,
      digest: digest(definition),
      createdAt: yield* nowIso,
    };
    yield* engine.dispatch({
      type: "project.workflow.save",
      commandId: CommandId.make(
        `workflow-save:${input.projectId}:${version.id}:${version.revision}:${version.digest}:${version.archived}`,
      ),
      projectId: input.projectId,
      definition: version,
      expectedRevision: input.expectedRevision,
    });
    const stored = yield* store.get(input.projectId, version.id, version.revision);
    if (!stored)
      return yield* new WorkspaceWorkflowError({
        message: "저장 결과가 아직 확인되지 않았습니다.",
      });
    return stored;
  }, Effect.mapError(failure));
  const start = Effect.fn("WorkspaceWorkflow.start")(function* (input: WorkflowStart) {
    yield* project(input.projectId);
    if (input.requestMode === "conditions" && input.conditionsConfirmed !== true)
      return yield* new WorkspaceWorkflowError({
        message: "조건 확인 모드입니다. 입력과 단계 구성을 확인한 뒤 실행하세요.",
      });
    if (input.definitionId === undefined) {
      if (!input.task?.trim())
        return yield* new WorkspaceWorkflowError({ message: "작업 목표를 입력하세요." });
      if (!query.listWorkspaceAgentRoles || !query.listWorkspaceCollaborationRuns)
        return yield* new WorkspaceWorkflowError({
          message: "기존 협업 실행 경로를 사용할 수 없습니다.",
        });
      if (
        input.threadId !== undefined &&
        input.meeting?.threadId !== undefined &&
        input.threadId !== input.meeting.threadId
      )
        return yield* new WorkspaceWorkflowError({
          message: "실행 채팅방과 회의 채팅방이 다릅니다.",
        });
      const runId = WorkspaceCollaborationRunId.make(
        `workflow-${digest([input.projectId, input.requestId])}`,
      );
      const requestDigest = digest({
        task: input.task,
        executionProfile: input.executionProfile ?? null,
        meeting: input.meeting ?? null,
        orchestra: input.orchestra ?? null,
        requestMode: input.requestMode ?? "direct",
        runtimeMode: input.runtimeMode ?? null,
        interactionMode: input.interactionMode ?? null,
        roleModels: input.roleModels ?? null,
        threadId: input.threadId ?? null,
      });
      const getRun = Effect.map(
        query.listWorkspaceCollaborationRuns({ projectId: input.projectId, runId }),
        (result) => result.runs.find((run) => run.id === runId),
      );
      const previous = yield* getRun;
      if (previous) {
        if (previous.runContext?.requestDigest !== requestDigest)
          return yield* new WorkspaceWorkflowError({
            message: "같은 시작 요청 ID에 다른 입력이 있습니다. 새 요청으로 실행하세요.",
          });
        return previous;
      }
      const now = yield* nowIso;
      const roles = yield* query.listWorkspaceAgentRoles({ projectId: input.projectId });
      const policy = {
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
      };
      let roleBindings = roles.roles.map((role) => ({ ...role, ...policy }));
      if (input.roleModels) {
        const selections = input.roleModels;
        for (const role of ["coordinator", "implementer", "researcher"] as const) {
          const previousRole = roleBindings.find((entry) => entry.role === role);
          const runtimeMode = input.runtimeMode ?? previousRole?.runtimeMode;
          const interactionMode = input.interactionMode ?? previousRole?.interactionMode;
          if (runtimeMode === undefined || interactionMode === undefined)
            return yield* new WorkspaceWorkflowError({
              message: `현재 ${role} 역할의 권한·계획 모드를 확인할 수 없습니다.`,
            });
          roleBindings = [
            ...roleBindings.filter((entry) => entry.role !== role),
            {
              projectId: input.projectId,
              role,
              displayName: selections[role].model,
              modelSelection: selections[role],
              runtimeMode,
              interactionMode,
              instructions: previousRole?.instructions ?? "",
              enabled: true,
              updatedAt: now,
            },
          ];
        }
      }
      const meeting = input.meeting
        ? {
            ...input.meeting,
            ...policy,
            ...(input.requestMode === undefined
              ? {}
              : { askFirst: input.requestMode === "ask-first" }),
            ...(input.threadId ? { threadId: input.threadId } : {}),
          }
        : undefined;
      const executionProfile = input.executionProfile
        ? {
            ...input.executionProfile,
            meeting: {
              ...input.executionProfile.meeting,
              ...meeting,
              ...policy,
              ...(input.requestMode === undefined
                ? {}
                : { askFirst: input.requestMode === "ask-first" }),
              ...(input.threadId ? { threadId: input.threadId } : {}),
            },
          }
        : undefined;
      yield* engine.dispatch({
        type: "project.collaboration.run.request",
        commandId: CommandId.make(`workflow-start:${runId}`),
        projectId: input.projectId,
        runId,
        task: input.task,
        runContext: {
          requestDigest,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.roleModels || (!meeting && !executionProfile) ? { roleBindings } : {}),
          requestMode: input.requestMode ?? "direct",
        },
        ...(executionProfile ? { executionProfile } : {}),
        ...(meeting ? { meeting } : {}),
        ...(input.orchestra ? { orchestra: input.orchestra } : {}),
        createdAt: now,
      });
      const run = yield* getRun;
      if (!run || run.runContext?.requestDigest !== requestDigest)
        return yield* new WorkspaceWorkflowError({
          message: "실행 결과를 대조하지 못했습니다. 같은 요청 ID로 다시 확인하세요.",
        });
      return run;
    }
    if (input.task !== undefined || input.revision === undefined || input.values === undefined)
      return yield* new WorkspaceWorkflowError({
        message: "저장된 단계와 작업 목표를 확인하세요.",
      });
    const values = input.values;
    const definition = yield* store.get(input.projectId, input.definitionId, input.revision);
    const latest = yield* store.get(input.projectId, input.definitionId);
    if (!definition || latest?.archived)
      return yield* new WorkspaceWorkflowError({
        message: "실행할 워크플로 버전을 찾을 수 없거나 보관된 정의입니다.",
      });
    const preview = previewWorkflow(definition, values);
    if (!preview.valid)
      return yield* new WorkspaceWorkflowError({
        message: preview.issues.map((issue) => issue.message).join("\n"),
      });
    if (!query.listWorkspaceAgentRoles || !query.listWorkspaceCollaborationRuns)
      return yield* new WorkspaceWorkflowError({
        message: "기존 협업 실행 경로를 사용할 수 없습니다.",
      });
    const runId = WorkspaceCollaborationRunId.make(
      `workflow-${digest([input.projectId, input.requestId])}`,
    );
    const requestDigest = digest({
      definitionId: definition.id,
      revision: definition.revision,
      values,
      executionProfile: input.executionProfile ?? null,
      meeting: input.meeting ?? null,
      orchestra: input.orchestra ?? null,
      requestMode: input.requestMode ?? "direct",
      ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
      ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
      ...(input.roleModels === undefined ? {} : { roleModels: input.roleModels }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    });
    const getRun = Effect.map(
      query.listWorkspaceCollaborationRuns({
        projectId: input.projectId,
        workflowOnly: true,
        runId,
      }),
      (result) => result.runs.find((run) => run.id === runId),
    );
    const previous = yield* getRun;
    if (previous) {
      if (previous.workflow?.requestDigest !== requestDigest)
        return yield* new WorkspaceWorkflowError({
          message: "같은 시작 요청 ID에 다른 입력이 있습니다. 새 요청으로 실행하세요.",
        });
      return previous;
    }
    const roles = yield* query.listWorkspaceAgentRoles({ projectId: input.projectId });
    if (input.roleModels && definition.nodes.some((node) => node.participantId !== null))
      return yield* new WorkspaceWorkflowError({
        message:
          "참가자가 지정된 단계가 있어 역할별 모델을 적용할 수 없습니다. 단계의 참가자 지정을 해제하거나 기존 참가자 설정을 사용하세요.",
      });
    const policy = {
      ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
      ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
    };
    if (
      input.threadId !== undefined &&
      input.meeting?.threadId !== undefined &&
      input.meeting.threadId !== input.threadId
    )
      return yield* new WorkspaceWorkflowError({
        message: "실행 채팅방과 회의 채팅방이 다릅니다.",
      });
    const executionProfile = input.executionProfile
      ? {
          ...input.executionProfile,
          meeting: {
            ...input.executionProfile.meeting,
            ...policy,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          },
        }
      : undefined;
    const meeting = input.meeting
      ? {
          ...input.meeting,
          ...policy,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        }
      : undefined;
    const now = yield* nowIso;
    let roleBindings = roles.roles.map((role) => ({ ...role, ...policy }));
    if (input.roleModels) {
      const selections = input.roleModels;
      for (const role of ["coordinator", "implementer", "researcher"] as const) {
        const previousRole = roleBindings.find((entry) => entry.role === role);
        const runtimeMode = input.runtimeMode ?? previousRole?.runtimeMode;
        const interactionMode = input.interactionMode ?? previousRole?.interactionMode;
        if (runtimeMode === undefined || interactionMode === undefined)
          return yield* new WorkspaceWorkflowError({
            message: `현재 권한·계획 모드를 확인할 수 없습니다. 채팅방에서 워크플로를 실행하거나 ${role} 역할의 권한을 먼저 설정하세요.`,
          });
        roleBindings = [
          ...roleBindings.filter((entry) => entry.role !== role),
          {
            projectId: input.projectId,
            role,
            displayName: selections[role].model,
            modelSelection: selections[role],
            runtimeMode,
            interactionMode,
            instructions: previousRole?.instructions ?? "",
            enabled: true,
            updatedAt: now,
          },
        ];
      }
    }
    const workflow: WorkspaceWorkflowContext = {
      definitionId: definition.id,
      definitionRevision: definition.revision,
      definitionDigest: definition.digest,
      title: definition.title,
      definition,
      values,
      nodeSkills: definition.nodes.map((node, index) => ({
        nodeId: node.id,
        skills: node.skills.map((skill, skillIndex) => ({
          ...skill,
          arguments: preview.nodes[index]!.skillArguments[skillIndex]!,
        })),
      })),
      roleBindings,
      ...(input.roleModels === undefined ? {} : { roleModels: input.roleModels }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      control: "active",
      controlRevision: 0,
      updatedAt: now,
      requestDigest,
      requestMode: input.requestMode ?? "direct",
    };
    yield* engine.dispatch({
      type: "project.collaboration.run.request",
      commandId: CommandId.make(`workflow-start:${runId}`),
      projectId: input.projectId,
      runId,
      task: definition.title,
      workflow,
      ...(executionProfile ? { executionProfile } : {}),
      ...(meeting ? { meeting } : {}),
      ...(input.orchestra ? { orchestra: input.orchestra } : {}),
      createdAt: now,
    });
    const run = yield* getRun;
    if (!run || run.workflow?.requestDigest !== requestDigest)
      return yield* new WorkspaceWorkflowError({
        message: "실행 결과를 대조하지 못했습니다. 같은 요청 ID로 다시 확인하세요.",
      });
    return run;
  }, Effect.mapError(failure));
  const control = Effect.fn("WorkspaceWorkflow.control")(function* (input: WorkflowControl) {
    yield* project(input.projectId);
    yield* engine.dispatch({
      type: "project.collaboration.run.control",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      ...input,
      createdAt: yield* nowIso,
    });
    if (!query.listWorkspaceCollaborationRuns)
      return yield* new WorkspaceWorkflowError({ message: "실행 결과를 조회할 수 없습니다." });
    const run = (yield* query.listWorkspaceCollaborationRuns({
      projectId: input.projectId,
      runId: input.runId,
    })).runs.find((entry) => entry.id === input.runId);
    if (!run) return yield* new WorkspaceWorkflowError({ message: "실행을 찾을 수 없습니다." });
    return run;
  }, Effect.mapError(failure));
  return {
    overview,
    save,
    start,
    control,
    getRun: Effect.fn("WorkspaceWorkflow.getRun")(function* (input: WorkflowRunLookup) {
      yield* project(input.projectId);
      if (!query.listWorkspaceCollaborationRuns)
        return yield* new WorkspaceWorkflowError({
          message: "실행 조회 경로를 사용할 수 없습니다.",
        });
      const run = (yield* query.listWorkspaceCollaborationRuns(input)).runs[0];
      if (!run)
        return yield* new WorkspaceWorkflowError({
          message: "이 프로젝트의 워크플로 실행을 찾을 수 없습니다.",
        });
      return run;
    }, Effect.mapError(failure)),
    preview: Effect.fn("WorkspaceWorkflow.preview")(function* (input: {
      projectId: ProjectId;
      definition: WorkflowDefinition;
      values: Readonly<Record<string, string>>;
    }) {
      yield* project(input.projectId);
      return previewWorkflow(input.definition, input.values);
    }, Effect.mapError(failure)),
    skills: Effect.fn("WorkspaceWorkflow.skills")(function* ({
      projectId,
    }: {
      projectId: ProjectId;
    }) {
      return yield* skills.catalog((yield* project(projectId)).workspaceRoot);
    }, Effect.mapError(failure)),
  };
});
