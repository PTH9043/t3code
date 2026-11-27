import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  isCustomResponseStyle,
  MessageId,
  type ThreadId,
  ThreadModelTeam,
  ThreadTeamMember,
  ThreadResponseStyleSeed,
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
  type WorkspaceCollaborationRun,
  type WorkspaceProviderPreflightWarning,
} from "@t3tools/contracts";
import { previewWorkflow, workflowDefaults } from "@t3tools/shared/workflow";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { WorkspaceWorkflowStore } from "../persistence/WorkspaceWorkflowStore.ts";
import { makeWorkflowSkills } from "./WorkflowSkills.ts";
import { discoverChatProjectSkills } from "./ChatProjectSkills.ts";
import { WorkspaceMemory } from "./WorkspaceMemory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { WorktreeProvisionService } from "../git/WorktreeProvisionService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { workspaceProviderUnavailableMessage } from "./workspaceProviderAvailability.ts";
import { redactConversationRagSensitiveData } from "./workspaceConversationRag.ts";

const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isWorkflowError = Schema.is(WorkspaceWorkflowError);
const decodeAcceptedTeams = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ThreadModelTeam)),
);
const decodeCustomTeam = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ThreadTeamMember)),
);
const decodeStyleSeed = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadResponseStyleSeed));
const decodeDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const failure = (cause: unknown) =>
  isWorkflowError(cause)
    ? cause
    : new WorkspaceWorkflowError({
        message: cause instanceof Error ? cause.message : "워크플로 요청을 처리하지 못했습니다.",
        cause,
      });
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const makeWorkspaceWorkflow = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const store = yield* WorkspaceWorkflowStore;
  const crypto = yield* Crypto.Crypto;
  const skills = yield* makeWorkflowSkills;
  const memory = yield* Effect.serviceOption(WorkspaceMemory);
  const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
  const database = yield* Effect.serviceOption(SqlClient.SqlClient);
  const worktrees = yield* Effect.serviceOption(WorktreeProvisionService);
  const setupRunner = yield* Effect.serviceOption(ProjectSetupScriptRunner);
  const providerInstances = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const validateExplicitRoleModels = Effect.fn("WorkspaceWorkflow.validateExplicitRoleModels")(
    function* (models: WorkflowStart["roleModels"]) {
      const warnings: WorkspaceProviderPreflightWarning[] = [];
      if (!models || Option.isNone(providerInstances)) return warnings;
      for (const role of ["coordinator", "implementer", "researcher"] as const) {
        const message = yield* workspaceProviderUnavailableMessage({
          registry: providerInstances.value,
          modelSelection: models[role],
          role,
        });
        if (message === null) continue;
        const safeMessage = redactConversationRagSensitiveData(message).content.slice(0, 4_000);
        if (role === "coordinator")
          return yield* new WorkspaceWorkflowError({ message: safeMessage });
        warnings.push({ role, modelSelection: models[role], message: safeMessage });
      }
      return warnings;
    },
  );
  const project = Effect.fn("WorkspaceWorkflow.project")(function* (projectId: ProjectId) {
    const found = yield* query.getProjectShellById(projectId);
    if (Option.isNone(found))
      return yield* new WorkspaceWorkflowError({ message: "프로젝트를 찾을 수 없습니다." });
    return found.value;
  }, Effect.mapError(failure));
  const recordConversationRequest = Effect.fn("WorkspaceWorkflow.recordConversationRequest")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly runId: WorkspaceCollaborationRunId;
      readonly text: string;
      readonly createdAt: string;
      readonly workspaceRoot: string;
    }) {
      const conversation = yield* query.getThreadRuntimeContext(input.threadId);
      if (
        Option.isNone(conversation) ||
        conversation.value.projectId !== input.projectId ||
        conversation.value.deletedAt !== null ||
        conversation.value.archivedAt !== null
      )
        return yield* new WorkspaceWorkflowError({
          message: "현재 프로젝트의 대화에서 통합 작업을 시작하세요.",
        });
      const messageId = MessageId.make(`workflow-request:${input.runId}`);
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(`workflow-request:${input.runId}`),
        threadId: input.threadId,
        messageId,
        text: input.text,
        createdAt: input.createdAt,
      });
      const recordedThread = yield* query.getThreadRuntimeContext(input.threadId, {
        messages: true,
      });
      const recordedMessage = Option.isSome(recordedThread)
        ? recordedThread.value.messages.find((message) => message.id === messageId)
        : undefined;
      if (recordedMessage?.role !== "user" || recordedMessage.text !== input.text)
        return yield* new WorkspaceWorkflowError({
          message: "통합 작업 요청의 원문을 확인하지 못했습니다. 새 요청으로 실행하세요.",
        });
      if (Option.isSome(memory))
        yield* memory.value
          .contextPaths({
            projectId: input.projectId,
            threadId: input.threadId,
            messageId,
            cwd: conversation.value.worktreePath ?? input.workspaceRoot,
            recordCurrent: true,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("통합 작업 요청의 폴더 기억 범위를 기록하지 못했습니다.", {
                cause,
              }),
            ),
          );
      return recordedMessage.createdAt;
    },
  );
  const conversationPolicy = Effect.fn("WorkspaceWorkflow.conversationPolicy")(function* (
    input: WorkflowStart,
    threadId: ThreadId | undefined,
  ) {
    if (!input.meeting && !input.executionProfile)
      return {
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
      };
    if (!threadId)
      return yield* new WorkspaceWorkflowError({
        message: "현재 프로젝트의 대화를 선택한 뒤 통합 작업을 시작하세요.",
      });
    const thread = yield* query.getThreadRuntimeContext(threadId);
    if (
      Option.isNone(thread) ||
      thread.value.projectId !== input.projectId ||
      thread.value.deletedAt !== null ||
      thread.value.archivedAt !== null
    )
      return yield* new WorkspaceWorkflowError({
        message: "현재 프로젝트의 대화에서 통합 작업을 시작하세요.",
      });
    return {
      runtimeMode: input.runtimeMode ?? thread.value.runtimeMode,
      interactionMode: input.interactionMode ?? thread.value.interactionMode,
    };
  });
  const verifyDraftTeamOwner = Effect.fn("WorkspaceWorkflow.verifyDraftTeamOwner")(function* (
    threadId: ThreadId,
    runId: WorkspaceCollaborationRunId,
  ) {
    if (Option.isNone(database))
      return yield* new WorkspaceWorkflowError({
        message: "대화 팀을 보존할 서버 저장소를 사용할 수 없습니다.",
      });
    const sql = database.value;
    const [last] = yield* sql<{ event_type: string; command_id: string | null }>`
      SELECT event_type, command_id FROM orchestration_events
      WHERE aggregate_kind='thread' AND stream_id=${threadId}
        AND event_type IN ('thread.created','thread.deleted','thread.turn-start-requested')
      ORDER BY sequence DESC LIMIT 1`;
    if (
      last?.event_type !== "thread.created" ||
      last.command_id !== `workflow-bootstrap-create:${runId}`
    ) {
      return yield* new WorkspaceWorkflowError({
        message: "이 작업이 만든 초안 대화인지 확인할 수 없습니다.",
      });
    }
  });
  const applyAcceptedDraftTeams = Effect.fn("WorkspaceWorkflow.applyAcceptedDraftTeams")(function* (
    run: WorkspaceCollaborationRun,
  ) {
    const context = run.workflow ?? run.runContext;
    if (
      context?.customSubordinateTeam !== undefined ||
      context?.initialModelTeams?.length ||
      context?.initialResponseStyle
    ) {
      if (!context.threadId)
        return yield* new WorkspaceWorkflowError({
          message: "접수된 작업의 팀 대화를 확인할 수 없습니다.",
        });
      if (Option.isNone(database) || Option.isNone(serverSettings))
        return yield* new WorkspaceWorkflowError({
          message: "접수된 대화 팀을 저장할 서버 서비스를 사용할 수 없습니다.",
        });
      const sql = database.value;
      const [pending] = yield* sql<{
        event_sequence: number;
        teams_json: string | null;
        custom_json: string | null;
        style_json: string | null;
      }>`
        SELECT p.event_sequence, COALESCE(json_extract(e.payload_json, '$.run.workflow.initialModelTeams'),
          json_extract(e.payload_json, '$.run.runContext.initialModelTeams')) AS teams_json,
          COALESCE(json_extract(e.payload_json, '$.run.workflow.customSubordinateTeam'),
            json_extract(e.payload_json, '$.run.runContext.customSubordinateTeam')) AS custom_json,
          COALESCE(json_extract(e.payload_json, '$.run.workflow.initialResponseStyle'),
            json_extract(e.payload_json, '$.run.runContext.initialResponseStyle')) AS style_json
        FROM pending_thread_model_team_seeds AS p
        JOIN orchestration_events AS e ON e.sequence=p.event_sequence
        WHERE p.thread_id=${context.threadId} AND e.aggregate_kind='project'
          AND e.stream_id=${run.projectId} AND e.event_type='project.collaboration-run-requested'
          AND e.command_id=${"workflow-start:" + run.id}`;
      if (!pending) return run;
      const teams = pending.teams_json ? yield* decodeAcceptedTeams(pending.teams_json) : [];
      const custom = pending.custom_json ? yield* decodeCustomTeam(pending.custom_json) : undefined;
      const style = pending.style_json ? yield* decodeStyleSeed(pending.style_json) : undefined;
      yield* serverSettings.value
        .initializeThreadModelTeams(context.threadId, teams, style, custom)
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceWorkflowError({
                message:
                  "작업은 접수됐지만 대화 팀을 저장하지 못했습니다. 서버를 다시 시작하거나 같은 요청을 확인하면 저장을 재시도합니다.",
                cause,
              }),
          ),
        );
      yield* sql`DELETE FROM pending_thread_model_team_seeds
        WHERE thread_id=${context.threadId} AND event_sequence=${pending.event_sequence}`;
    }
    return run;
  });
  const prepareConversation = Effect.fn("WorkspaceWorkflow.prepareConversation")(function* (
    input: WorkflowStart,
    runId: WorkspaceCollaborationRunId,
    workspaceRoot: string,
  ) {
    const bootstrap = input.bootstrap;
    if (!bootstrap) return false;
    let created = false;
    const threadId = input.threadId;
    if (
      !threadId ||
      (bootstrap.createThread && bootstrap.createThread.projectId !== input.projectId)
    )
      return yield* new WorkspaceWorkflowError({
        message: "새 대화와 프로젝트 정보가 일치하지 않습니다.",
      });
    let thread = yield* query.getThreadRuntimeContext(threadId);
    if (Option.isNone(thread)) {
      if (!bootstrap.createThread)
        return yield* new WorkspaceWorkflowError({
          message: "작업을 시작할 대화를 찾을 수 없습니다.",
        });
      const {
        customSubordinateTeam: _customTeam,
        modelTeams: _modelTeams,
        responseStyle: _responseStyle,
        ...creation
      } = bootstrap.createThread;
      const creationReceipt = yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`workflow-bootstrap-create:${runId}`),
        threadId,
        ...creation,
      });
      created = creationReceipt.replayed !== true;
      thread = yield* query.getThreadRuntimeContext(threadId);
    }
    if (
      Option.isNone(thread) ||
      thread.value.projectId !== input.projectId ||
      thread.value.deletedAt !== null
    )
      return yield* new WorkspaceWorkflowError({
        message: "현재 프로젝트의 대화를 확인할 수 없습니다.",
      });
    if (
      bootstrap.createThread?.customSubordinateTeam !== undefined ||
      bootstrap.createThread?.modelTeams?.length ||
      bootstrap.createThread?.responseStyle
    )
      yield* verifyDraftTeamOwner(threadId, runId);
    if (bootstrap.prepareWorktree && !thread.value.worktreePath) {
      if (Option.isNone(worktrees))
        return yield* new WorkspaceWorkflowError({
          message: "대화 작업 폴더 준비 서비스를 사용할 수 없습니다.",
        });
      const prepared = yield* worktrees.value.provision({
        projectCwd: workspaceRoot,
        baseBranch: bootstrap.prepareWorktree.baseBranch,
        branch: bootstrap.prepareWorktree.branch ?? null,
        startFromOrigin: bootstrap.prepareWorktree.startFromOrigin,
      });
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`workflow-bootstrap-worktree:${runId}`),
        threadId,
        ...(bootstrap.createThread?.customSubordinateTeam !== undefined ||
        bootstrap.createThread?.modelTeams?.length ||
        bootstrap.createThread?.responseStyle
          ? { bootstrapCreateClaim: CommandId.make(`workflow-bootstrap-create:${runId}`) }
          : {}),
        branch: prepared.refName,
        worktreePath: prepared.worktreePath,
      });
      if (bootstrap.runSetupScript) {
        if (Option.isNone(setupRunner))
          return yield* new WorkspaceWorkflowError({
            message: "대화 작업 폴더의 준비 스크립트 서비스를 사용할 수 없습니다.",
          });
        yield* setupRunner.value
          .runForThread({
            threadId,
            projectId: input.projectId,
            projectCwd: workspaceRoot,
            worktreePath: prepared.worktreePath,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("대화 작업 폴더의 준비 스크립트를 시작하지 못했습니다.", { cause }),
            ),
          );
      }
    }
    return created;
  });
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
  const prepareStyledConversation = Effect.fn("WorkspaceWorkflow.prepareStyledConversation")(
    function* (
      input: WorkflowStart,
      runId: WorkspaceCollaborationRunId,
      root: string,
      conversationId: ThreadId | undefined,
    ) {
      const draftStyle = input.bootstrap?.createThread?.responseStyle;
      const settings = Option.isSome(serverSettings)
        ? yield* serverSettings.value.getSettings
        : null;
      const legacy = conversationId ? settings?.threadResponseStyles[conversationId] : undefined;
      const created = yield* prepareConversation(input, runId, root);
      // The style this conversation has once the first-request seed lands; a custom one wins over the global style.
      const room = draftStyle && (created || !legacy) ? draftStyle : legacy;
      const responseStyle =
        room && isCustomResponseStyle(room) ? room : (settings?.globalResponseStyle ?? null);
      return draftStyle
        ? {
            responseStyle,
            initialResponseStyle: {
              value: draftStyle,
              previous: created ? (legacy ?? null) : null,
            },
          }
        : { responseStyle };
    },
  );
  const start = Effect.fn("WorkspaceWorkflow.start")(function* (input: WorkflowStart) {
    const customSubordinateTeam = input.bootstrap?.createThread?.customSubordinateTeam;
    const draftTeams = input.bootstrap?.createThread?.modelTeams;
    const draftStyle = input.bootstrap?.createThread?.responseStyle;
    if (customSubordinateTeam !== undefined || draftTeams?.length || draftStyle) {
      if (Option.isNone(database) || Option.isNone(serverSettings))
        return yield* new WorkspaceWorkflowError({
          message: "대화 팀을 보존할 서버 저장소를 사용할 수 없습니다.",
        });
      const scopes = new Set<string>();
      for (const team of draftTeams ?? []) {
        const scope = stringify([team.answeringInstanceId, team.forModel.trim().toLowerCase()]);
        if (team.threadId !== input.threadId || scopes.has(scope))
          return yield* new WorkspaceWorkflowError({
            message: "초안 팀의 대화 ID가 다르거나 같은 응답 모델의 팀이 중복되었습니다.",
          });
        scopes.add(scope);
      }
    }
    const owner = yield* project(input.projectId);
    if (input.roleModels && (input.meeting || input.executionProfile))
      return yield* new WorkspaceWorkflowError({
        message:
          "통합 작업에서는 지정한 참가자 목록만 사용할 수 있습니다. 별도의 역할 모델을 함께 보내지 마세요.",
      });
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
        ...(input.userMessage === undefined ? {} : { userMessage: input.userMessage }),
        executionProfile: input.executionProfile ?? null,
        meeting: input.meeting ?? null,
        orchestra: input.orchestra ?? null,
        requestMode: input.requestMode ?? "direct",
        runtimeMode: input.runtimeMode ?? null,
        interactionMode: input.interactionMode ?? null,
        roleModels: input.roleModels ?? null,
        threadId: input.threadId ?? null,
        ...(input.bootstrap === undefined ? {} : { bootstrap: input.bootstrap }),
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
        return yield* applyAcceptedDraftTeams(previous);
      }
      const providerWarnings = yield* validateExplicitRoleModels(input.roleModels);
      const now = yield* nowIso;
      const conversationId = input.threadId ?? input.meeting?.threadId;
      if ((input.meeting || input.executionProfile) && !conversationId)
        return yield* new WorkspaceWorkflowError({
          message: "현재 프로젝트의 대화를 선택한 뒤 통합 작업을 시작하세요.",
        });
      const style = yield* prepareStyledConversation(
        input,
        runId,
        owner.workspaceRoot,
        conversationId,
      );
      const policy = yield* conversationPolicy(input, conversationId);
      let createdAt = now;
      if ((input.meeting || input.executionProfile) && conversationId)
        createdAt = yield* recordConversationRequest({
          projectId: input.projectId,
          threadId: conversationId,
          runId,
          text: input.userMessage ?? input.task,
          createdAt: now,
          workspaceRoot: owner.workspaceRoot,
        });
      const roles = yield* query.listWorkspaceAgentRoles({ projectId: input.projectId });
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
            ...(conversationId ? { threadId: conversationId } : {}),
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
              ...(conversationId ? { threadId: conversationId } : {}),
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
          ...style,
          ...(customSubordinateTeam !== undefined ? { customSubordinateTeam } : {}),
          ...(draftTeams?.length ? { initialModelTeams: draftTeams } : {}),
          ...(providerWarnings.length ? { providerWarnings } : {}),
          requestDigest,
          ...(conversationId ? { threadId: conversationId } : {}),
          ...(input.roleModels || (!meeting && !executionProfile) ? { roleBindings } : {}),
          requestMode: input.requestMode ?? "direct",
        },
        ...(executionProfile ? { executionProfile } : {}),
        ...(meeting ? { meeting } : executionProfile ? { meeting: executionProfile.meeting } : {}),
        ...(input.orchestra ? { orchestra: input.orchestra } : {}),
        createdAt: createdAt > now ? createdAt : now,
      });
      const run = yield* getRun;
      if (!run || run.runContext?.requestDigest !== requestDigest)
        return yield* new WorkspaceWorkflowError({
          message: "실행 결과를 대조하지 못했습니다. 같은 요청 ID로 다시 확인하세요.",
        });
      return yield* applyAcceptedDraftTeams(run);
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
      ...(input.userMessage === undefined ? {} : { userMessage: input.userMessage }),
      executionProfile: input.executionProfile ?? null,
      meeting: input.meeting ?? null,
      orchestra: input.orchestra ?? null,
      requestMode: input.requestMode ?? "direct",
      ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
      ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
      ...(input.roleModels === undefined ? {} : { roleModels: input.roleModels }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.bootstrap === undefined ? {} : { bootstrap: input.bootstrap }),
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
      return yield* applyAcceptedDraftTeams(previous);
    }
    const providerWarnings = yield* validateExplicitRoleModels(input.roleModels);
    const roles = yield* query.listWorkspaceAgentRoles({ projectId: input.projectId });
    if (input.roleModels && definition.nodes.some((node) => node.participantId !== null))
      return yield* new WorkspaceWorkflowError({
        message:
          "참가자가 지정된 단계가 있어 역할별 모델을 적용할 수 없습니다. 단계의 참가자 지정을 해제하거나 기존 참가자 설정을 사용하세요.",
      });
    if (
      input.threadId !== undefined &&
      input.meeting?.threadId !== undefined &&
      input.meeting.threadId !== input.threadId
    )
      return yield* new WorkspaceWorkflowError({
        message: "실행 채팅방과 회의 채팅방이 다릅니다.",
      });
    const conversationId = input.threadId ?? input.meeting?.threadId;
    if ((input.meeting || input.executionProfile) && !conversationId)
      return yield* new WorkspaceWorkflowError({
        message: "현재 프로젝트의 대화를 선택한 뒤 통합 작업을 시작하세요.",
      });
    const now = yield* nowIso;
    const style = yield* prepareStyledConversation(
      input,
      runId,
      owner.workspaceRoot,
      conversationId,
    );
    const policy = yield* conversationPolicy(input, conversationId);
    const baseExecutionProfile = input.executionProfile
      ? {
          ...input.executionProfile,
          meeting: {
            ...input.executionProfile.meeting,
            ...policy,
            ...(input.requestMode === undefined
              ? {}
              : { askFirst: input.requestMode === "ask-first" }),
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          },
        }
      : undefined;
    const baseMeeting = input.meeting
      ? {
          ...input.meeting,
          ...policy,
          ...(input.requestMode === undefined
            ? {}
            : { askFirst: input.requestMode === "ask-first" }),
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        }
      : undefined;
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
    const meeting =
      baseMeeting && conversationId ? { ...baseMeeting, threadId: conversationId } : baseMeeting;
    const executionProfile =
      baseExecutionProfile && conversationId
        ? {
            ...baseExecutionProfile,
            meeting: { ...baseExecutionProfile.meeting, threadId: conversationId },
          }
        : baseExecutionProfile;
    const workflow: WorkspaceWorkflowContext = {
      ...style,
      ...(customSubordinateTeam !== undefined ? { customSubordinateTeam } : {}),
      ...(draftTeams?.length ? { initialModelTeams: draftTeams } : {}),
      ...(providerWarnings.length ? { providerWarnings } : {}),
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
      ...(conversationId === undefined ? {} : { threadId: conversationId }),
      control: "active",
      controlRevision: 0,
      updatedAt: now,
      requestDigest,
      requestMode: input.requestMode ?? "direct",
    };
    let createdAt = now;
    if ((input.meeting || input.executionProfile) && conversationId)
      createdAt = yield* recordConversationRequest({
        projectId: input.projectId,
        threadId: conversationId,
        runId,
        text: input.userMessage ?? [definition.title, stringify(values)].join("\n"),
        createdAt: now,
        workspaceRoot: owner.workspaceRoot,
      });
    yield* engine.dispatch({
      type: "project.collaboration.run.request",
      commandId: CommandId.make(`workflow-start:${runId}`),
      projectId: input.projectId,
      runId,
      task: definition.title,
      workflow,
      ...(executionProfile ? { executionProfile } : {}),
      ...(meeting ? { meeting } : executionProfile ? { meeting: executionProfile.meeting } : {}),
      ...(input.orchestra ? { orchestra: input.orchestra } : {}),
      createdAt: createdAt > now ? createdAt : now,
    });
    const run = yield* getRun;
    if (!run || run.workflow?.requestDigest !== requestDigest)
      return yield* new WorkspaceWorkflowError({
        message: "실행 결과를 대조하지 못했습니다. 같은 요청 ID로 다시 확인하세요.",
      });
    return yield* applyAcceptedDraftTeams(run);
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
    chatSkills: Effect.fn("WorkspaceWorkflow.chatSkills")(function* (input: {
      projectId: ProjectId;
      threadId?: ThreadId | undefined;
    }) {
      const owner = yield* project(input.projectId);
      let cwd = owner.workspaceRoot;
      if (input.threadId) {
        const thread = yield* query.getThreadRuntimeContext(input.threadId);
        if (
          Option.isNone(thread) ||
          thread.value.projectId !== input.projectId ||
          thread.value.deletedAt !== null
        )
          return yield* new WorkspaceWorkflowError({
            message: "현재 프로젝트의 대화를 확인하세요.",
          });
        cwd = thread.value.worktreePath ?? cwd;
      }
      return yield* discoverChatProjectSkills(cwd, owner.workspaceRoot);
    }, Effect.mapError(failure)),
  };
});
