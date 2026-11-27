// @effect-diagnostics anyUnknownInErrorContext:off
import {
  COUNCIL_WS_METHODS,
  CouncilError,
  EnvironmentAuthorizationError,
  MISSION_CONTROL_WS_METHODS,
  MissionControlError,
  WORKSPACE_AGENT_CONTROL_WS_METHODS,
  WORKSPACE_AUTOMATION_WS_METHODS,
  WORKSPACE_DEVELOPMENT_WS_METHODS,
  WORKSPACE_MEMORY_WS_METHODS,
  WORKSPACE_RESEARCH_WS_METHODS,
  WORKSPACE_TASK_INBOX_WS_METHODS,
  WorkspaceAgentControlError,
  WorkspaceAutomationError,
  WorkspaceMemoryError,
  WorkspaceResearchError,
  WorkspaceTaskInboxError,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as ServerConfig from "../config.ts";
import { CouncilOrchestratorService } from "../orchestration/council/CouncilOrchestrator.ts";
import { MissionOrchestratorService } from "../t3x/missionControl/MissionOrchestratorService.ts";
import type * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { UpgradeRoomMemory, captureRoomMemory } from "../orchestration/UpgradeRoomMemory.ts";
import { WorkspaceAgentControl } from "../orchestration/WorkspaceAgentControl.ts";
import {
  automationOverview,
  collaborationThread,
  isWorkspaceAutomationError,
  readAutomationEvidence,
} from "../orchestration/workspaceAutomation.ts";
import type { WorkspaceDevelopment } from "../orchestration/WorkspaceDevelopment.ts";
import { WorkspaceMemory } from "../orchestration/WorkspaceMemory.ts";
import { WorkspaceTaskInbox } from "../orchestration/WorkspaceTaskInbox.ts";
import { GrokResearch } from "../research/GrokResearch.ts";

type WsRpcHandlersMap = Parameters<typeof WsRpcGroup.of>[0];

export type WorkspaceRpcMethodKeys =
  | (typeof WORKSPACE_RESEARCH_WS_METHODS)[keyof typeof WORKSPACE_RESEARCH_WS_METHODS]
  | (typeof COUNCIL_WS_METHODS)[keyof typeof COUNCIL_WS_METHODS]
  | (typeof MISSION_CONTROL_WS_METHODS)[keyof typeof MISSION_CONTROL_WS_METHODS]
  | (typeof WORKSPACE_MEMORY_WS_METHODS)[keyof typeof WORKSPACE_MEMORY_WS_METHODS]
  | (typeof WORKSPACE_DEVELOPMENT_WS_METHODS)[keyof typeof WORKSPACE_DEVELOPMENT_WS_METHODS]
  | (typeof WORKSPACE_AGENT_CONTROL_WS_METHODS)[keyof typeof WORKSPACE_AGENT_CONTROL_WS_METHODS]
  | (typeof WORKSPACE_TASK_INBOX_WS_METHODS)[keyof typeof WORKSPACE_TASK_INBOX_WS_METHODS]
  | (typeof WORKSPACE_AUTOMATION_WS_METHODS)[keyof typeof WORKSPACE_AUTOMATION_WS_METHODS];

export interface WorkspaceRpcHandlersDeps {
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
  readonly research: Option.Option<GrokResearch["Service"]>;
  readonly unavailableResearch: Effect.Effect<never, WorkspaceResearchError>;
  readonly council: Option.Option<CouncilOrchestratorService["Service"]>;
  readonly unavailableCouncil: Effect.Effect<never, CouncilError>;
  readonly missionControl: Option.Option<MissionOrchestratorService["Service"]>;
  readonly unavailableMissionControl: Effect.Effect<never, MissionControlError>;
  readonly workspaceMemory: Option.Option<WorkspaceMemory["Service"]>;
  readonly upgradeMemory: (typeof UpgradeRoomMemory)["Service"];
  readonly development: WorkspaceDevelopment["Service"];
  readonly agentControl: Option.Option<WorkspaceAgentControl["Service"]>;
  readonly unavailableAgentControl: Effect.Effect<never, WorkspaceAgentControlError>;
  readonly taskInbox: Option.Option<WorkspaceTaskInbox["Service"]>;
  readonly unavailableInbox: Effect.Effect<never, WorkspaceTaskInboxError>;
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly config: ServerConfig.ServerConfig["Service"];
}

export function makeWorkspaceRpcHandlers(
  deps: WorkspaceRpcHandlersDeps,
): Pick<WsRpcHandlersMap, WorkspaceRpcMethodKeys> {
  const {
    observeRpcEffect,
    observeRpcStream,
    research,
    unavailableResearch,
    council,
    unavailableCouncil,
    missionControl,
    unavailableMissionControl,
    workspaceMemory,
    upgradeMemory,
    development,
    agentControl,
    unavailableAgentControl,
    taskInbox,
    unavailableInbox,
    projectionSnapshotQuery,
    config,
  } = deps;

  return {
    [WORKSPACE_RESEARCH_WS_METHODS.status]: (input) =>
      observeRpcEffect(
        WORKSPACE_RESEARCH_WS_METHODS.status,
        Option.isSome(research) ? research.value.status(input.projectId) : unavailableResearch,
      ),
    [WORKSPACE_RESEARCH_WS_METHODS.run]: (input) =>
      observeRpcEffect(
        WORKSPACE_RESEARCH_WS_METHODS.run,
        Option.isSome(research) ? research.value.run(input) : unavailableResearch,
      ),
    [WORKSPACE_RESEARCH_WS_METHODS.configureKey]: (input) =>
      observeRpcEffect(
        WORKSPACE_RESEARCH_WS_METHODS.configureKey,
        Option.isSome(research)
          ? research.value.configureKey(input.apiKey, input.provider)
          : unavailableResearch,
      ),
    [COUNCIL_WS_METHODS.triage]: (input) =>
      observeRpcEffect(
        COUNCIL_WS_METHODS.triage,
        Option.isSome(council) ? council.value.triage(input) : unavailableCouncil,
      ),
    [COUNCIL_WS_METHODS.startAutoSeat]: (input) =>
      observeRpcEffect(
        COUNCIL_WS_METHODS.startAutoSeat,
        Option.isSome(council) ? council.value.startAutoSeat(input) : unavailableCouncil,
      ),
    [COUNCIL_WS_METHODS.getSession]: (input) =>
      observeRpcEffect(
        COUNCIL_WS_METHODS.getSession,
        Option.isSome(council) ? council.value.getSession(input.councilId) : unavailableCouncil,
      ),
    [COUNCIL_WS_METHODS.listThreadSessions]: (input) =>
      observeRpcEffect(
        COUNCIL_WS_METHODS.listThreadSessions,
        Option.isSome(council)
          ? council.value
              .listThreadSessions(input.threadId, input.limit)
              .pipe(Effect.map((sessions) => ({ sessions: [...sessions] })))
          : unavailableCouncil,
      ),
    [COUNCIL_WS_METHODS.approveOverride]: (input) =>
      observeRpcEffect(
        COUNCIL_WS_METHODS.approveOverride,
        Option.isSome(council) ? council.value.approveOverride(input) : unavailableCouncil,
      ),
    [COUNCIL_WS_METHODS.executePinnedSpec]: (input) =>
      observeRpcEffect(
        COUNCIL_WS_METHODS.executePinnedSpec,
        Option.isSome(council) ? council.value.executePinnedSpec(input) : unavailableCouncil,
      ),
    [COUNCIL_WS_METHODS.reverifyPinnedSpec]: (input) =>
      observeRpcEffect(
        COUNCIL_WS_METHODS.reverifyPinnedSpec,
        Option.isSome(council) ? council.value.reverifyPinnedSpec(input) : unavailableCouncil,
      ),
    [COUNCIL_WS_METHODS.abort]: (input) =>
      observeRpcEffect(
        COUNCIL_WS_METHODS.abort,
        Option.isSome(council) ? council.value.abort(input) : unavailableCouncil,
      ),
    [COUNCIL_WS_METHODS.subscribe]: (input) =>
      observeRpcStream(
        COUNCIL_WS_METHODS.subscribe,
        Option.isSome(council)
          ? council.value.subscribe(input.threadId)
          : Stream.fail(
              new CouncilError({
                code: "EXECUTION_FAILED",
                message: "다자간 위원회 서비스가 이 서버에 활성화되어 있지 않습니다.",
              }),
            ),
        { "rpc.aggregate": "orchestration" },
      ),
    [MISSION_CONTROL_WS_METHODS.getSnapshot]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.getSnapshot,
        Option.isSome(missionControl)
          ? missionControl.value.getSnapshot(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.subscribe]: (input) =>
      observeRpcStream(
        MISSION_CONTROL_WS_METHODS.subscribe,
        Option.isSome(missionControl)
          ? missionControl.value.subscribe(input)
          : Stream.fail(
              new MissionControlError({
                code: "UNAVAILABLE",
                message: "자율 미션 컨트롤 서비스가 이 서버에 활성화되어 있지 않습니다.",
              }),
            ),
        { "rpc.aggregate": "orchestration" },
      ),
    [MISSION_CONTROL_WS_METHODS.createMission]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.createMission,
        Option.isSome(missionControl)
          ? missionControl.value.createMission(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.cancelMission]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.cancelMission,
        Option.isSome(missionControl)
          ? missionControl.value.cancelMission(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.deleteMission]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.deleteMission,
        Option.isSome(missionControl)
          ? missionControl.value.deleteMission(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.decideApproval]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.decideApproval,
        Option.isSome(missionControl)
          ? missionControl.value.decideApproval(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.upsertCrewRole]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.upsertCrewRole,
        Option.isSome(missionControl)
          ? missionControl.value.upsertCrewRole(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.deleteCrewRole]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.deleteCrewRole,
        Option.isSome(missionControl)
          ? missionControl.value.deleteCrewRole(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.startSyncMeeting]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.startSyncMeeting,
        Option.isSome(missionControl)
          ? missionControl.value.startSyncMeeting(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.startRoundtableMeeting]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.startRoundtableMeeting,
        Option.isSome(missionControl)
          ? missionControl.value.startRoundtableMeeting(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.cancelMeeting]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.cancelMeeting,
        Option.isSome(missionControl)
          ? missionControl.value.cancelMeeting(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.deleteMeeting]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.deleteMeeting,
        Option.isSome(missionControl)
          ? missionControl.value.deleteMeeting(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.promoteMeetingToMission]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.promoteMeetingToMission,
        Option.isSome(missionControl)
          ? missionControl.value.promoteMeetingToMission(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.setSynapsePruned]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.setSynapsePruned,
        Option.isSome(missionControl)
          ? missionControl.value.setSynapsePruned(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.killSwitch]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.killSwitch,
        Option.isSome(missionControl)
          ? missionControl.value.killSwitch(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.generateDigestNow]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.generateDigestNow,
        Option.isSome(missionControl)
          ? missionControl.value.generateDigestNow(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.runHeartbeatCheck]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.runHeartbeatCheck,
        Option.isSome(missionControl)
          ? missionControl.value.runHeartbeatCheck(input)
          : unavailableMissionControl,
      ),
    [MISSION_CONTROL_WS_METHODS.inspectArtifact]: (input) =>
      observeRpcEffect(
        MISSION_CONTROL_WS_METHODS.inspectArtifact,
        Option.isSome(missionControl)
          ? missionControl.value.inspectArtifact(input)
          : unavailableMissionControl,
      ),
    [WORKSPACE_MEMORY_WS_METHODS.remember]: (input) =>
      observeRpcEffect(
        WORKSPACE_MEMORY_WS_METHODS.remember,
        Option.isSome(workspaceMemory)
          ? workspaceMemory.value
              .invoke(
                {
                  action: "remember",
                  projectId: input.projectId,
                  requestId: input.requestId,
                  topic: input.topic,
                  text: input.text,
                  scope: "project",
                },
                {
                  threadId: input.threadId,
                  ...(input.projectRoot === true ? { projectRoot: true as const } : {}),
                },
              )
              .pipe(
                Effect.tap(() => (upgradeMemory ? captureRoomMemory(upgradeMemory) : Effect.void)),
              )
          : Effect.fail(new WorkspaceMemoryError({ message: "기억 서비스를 사용할 수 없습니다." })),
      ),
    [WORKSPACE_MEMORY_WS_METHODS.forgetMessage]: (input) =>
      observeRpcEffect(
        WORKSPACE_MEMORY_WS_METHODS.forgetMessage,
        Option.isSome(workspaceMemory)
          ? workspaceMemory.value
              .invoke(
                { action: "forget-message", projectId: input.projectId, id: input.id },
                { threadId: input.threadId },
              )
              .pipe(
                Effect.tap(() => (upgradeMemory ? captureRoomMemory(upgradeMemory) : Effect.void)),
              )
          : Effect.fail(new WorkspaceMemoryError({ message: "기억 서비스를 사용할 수 없습니다." })),
      ),
    [WORKSPACE_DEVELOPMENT_WS_METHODS.get]: (input) =>
      observeRpcEffect(
        WORKSPACE_DEVELOPMENT_WS_METHODS.get,
        development.get(input.projectId).pipe(Effect.map((state) => ({ state }))),
      ),
    [WORKSPACE_AGENT_CONTROL_WS_METHODS.attention]: (input) =>
      observeRpcStream(
        WORKSPACE_AGENT_CONTROL_WS_METHODS.attention,
        Option.isSome(agentControl)
          ? agentControl.value.attention(input)
          : Stream.fromEffect(unavailableAgentControl),
      ),
    [WORKSPACE_AGENT_CONTROL_WS_METHODS.subscribe]: (input) =>
      observeRpcStream(
        WORKSPACE_AGENT_CONTROL_WS_METHODS.subscribe,
        Option.isSome(agentControl)
          ? agentControl.value.subscribe(input)
          : Stream.fromEffect(unavailableAgentControl),
      ),
    [WORKSPACE_AGENT_CONTROL_WS_METHODS.overview]: (input) =>
      observeRpcEffect(
        WORKSPACE_AGENT_CONTROL_WS_METHODS.overview,
        Option.isSome(agentControl) ? agentControl.value.overview(input) : unavailableAgentControl,
      ),
    [WORKSPACE_AGENT_CONTROL_WS_METHODS.action]: (input) =>
      observeRpcEffect(
        WORKSPACE_AGENT_CONTROL_WS_METHODS.action,
        Option.isSome(agentControl) ? agentControl.value.invoke(input) : unavailableAgentControl,
      ),
    [WORKSPACE_AGENT_CONTROL_WS_METHODS.evidence]: (input) =>
      observeRpcEffect(
        WORKSPACE_AGENT_CONTROL_WS_METHODS.evidence,
        Option.isSome(agentControl) ? agentControl.value.evidence(input) : unavailableAgentControl,
      ),
    [WORKSPACE_TASK_INBOX_WS_METHODS.subscribe]: (input) =>
      observeRpcStream(
        WORKSPACE_TASK_INBOX_WS_METHODS.subscribe,
        Option.isSome(taskInbox)
          ? taskInbox.value.subscribe(input.projectId)
          : Stream.fromEffect(unavailableInbox),
      ),
    [WORKSPACE_TASK_INBOX_WS_METHODS.overview]: (input) =>
      observeRpcEffect(
        WORKSPACE_TASK_INBOX_WS_METHODS.overview,
        Option.isSome(taskInbox) ? taskInbox.value.overview(input.projectId) : unavailableInbox,
      ),
    [WORKSPACE_TASK_INBOX_WS_METHODS.get]: (input) =>
      observeRpcEffect(
        WORKSPACE_TASK_INBOX_WS_METHODS.get,
        Option.isSome(taskInbox)
          ? taskInbox.value.get(input.projectId, input.taskId)
          : unavailableInbox,
      ),
    [WORKSPACE_TASK_INBOX_WS_METHODS.saveRecipe]: (input) =>
      observeRpcEffect(
        WORKSPACE_TASK_INBOX_WS_METHODS.saveRecipe,
        Option.isSome(taskInbox) ? taskInbox.value.saveRecipe(input) : unavailableInbox,
      ),
    [WORKSPACE_TASK_INBOX_WS_METHODS.submit]: (input) =>
      observeRpcEffect(
        WORKSPACE_TASK_INBOX_WS_METHODS.submit,
        Option.isSome(taskInbox) ? taskInbox.value.submit(input) : unavailableInbox,
      ),
    [WORKSPACE_TASK_INBOX_WS_METHODS.action]: (input) =>
      observeRpcEffect(
        WORKSPACE_TASK_INBOX_WS_METHODS.action,
        Option.isSome(taskInbox) ? taskInbox.value.action(input) : unavailableInbox,
      ),
    [WORKSPACE_AUTOMATION_WS_METHODS.overview]: (input) =>
      observeRpcEffect(
        WORKSPACE_AUTOMATION_WS_METHODS.overview,
        Effect.gen(function* () {
          if (
            !projectionSnapshotQuery.listWorkspaceCollaborationRuns ||
            !projectionSnapshotQuery.listWorkspaceSchedules
          ) {
            return yield* new WorkspaceAutomationError({
              message: "자동 작업 성과 조회를 사용할 수 없습니다.",
            });
          }
          const [developmentState, runList, scheduleList] = yield* Effect.all(
            [
              development.get(input.projectId),
              projectionSnapshotQuery.listWorkspaceCollaborationRuns(input),
              projectionSnapshotQuery.listWorkspaceSchedules(input),
            ],
            { concurrency: 3 },
          );
          const generatedAt = DateTime.formatIso(yield* DateTime.now);
          const base = automationOverview({
            projectId: input.projectId,
            generatedAt,
            runs: runList.runs,
            schedules: scheduleList.schedules,
            development: developmentState,
          });
          const selected = new Set(
            base.rows.filter((row) => row.source === "collaboration").map((row) => row.id),
          );
          const reports = yield* Effect.forEach(
            runList.runs.filter((run) => selected.has(`collaboration:${run.id}`)),
            (run) => {
              const threadId = collaborationThread(run);
              return threadId && projectionSnapshotQuery.getThreadTokenUsage
                ? projectionSnapshotQuery
                    .getThreadTokenUsage({ threadId, workId: `run:${run.id}` })
                    .pipe(Effect.map((report) => [`run:${run.id}`, report] as const))
                : Effect.succeed(null);
            },
            { concurrency: 4 },
          );
          const taskReports =
            developmentState && projectionSnapshotQuery.getThreadTokenUsage
              ? yield* Effect.forEach(
                  developmentState.tasks.filter((task) =>
                    base.rows.some((row) => row.id === `development:${task.id}`),
                  ),
                  (task) =>
                    projectionSnapshotQuery.getThreadTokenUsage!({
                      threadId: developmentState.conversationId,
                      workId: `run:${task.goalId ? `development-goal:${task.goalId}` : task.runId}`,
                      nodeId: task.id,
                    }).pipe(Effect.map((report) => [`development:${task.id}`, report] as const)),
                  { concurrency: 4 },
                )
              : [];
          return automationOverview({
            projectId: input.projectId,
            generatedAt,
            runs: runList.runs,
            schedules: scheduleList.schedules,
            development: developmentState,
            usage: new Map([...reports.filter((report) => report !== null), ...taskReports]),
          });
        }).pipe(
          Effect.mapError((cause) =>
            isWorkspaceAutomationError(cause)
              ? cause
              : new WorkspaceAutomationError({
                  message: "자동 작업 성과를 불러오지 못했습니다.",
                  cause,
                }),
          ),
        ),
      ),
    [WORKSPACE_AUTOMATION_WS_METHODS.evidence]: (input) =>
      observeRpcEffect(
        WORKSPACE_AUTOMATION_WS_METHODS.evidence,
        development.get(input.projectId).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceAutomationError({
                message: "검증 기록을 불러오지 못했습니다.",
                cause,
              }),
          ),
          Effect.flatMap((state) => readAutomationEvidence(state, input, config.dbPath)),
        ),
      ),
    [WORKSPACE_DEVELOPMENT_WS_METHODS.subscribe]: (input) =>
      observeRpcStream(
        WORKSPACE_DEVELOPMENT_WS_METHODS.subscribe,
        development.subscribe(input.projectId),
      ),
    [WORKSPACE_DEVELOPMENT_WS_METHODS.configure]: (input) =>
      observeRpcEffect(WORKSPACE_DEVELOPMENT_WS_METHODS.configure, development.configure(input)),
    [WORKSPACE_DEVELOPMENT_WS_METHODS.directInput]: (input) =>
      observeRpcEffect(
        WORKSPACE_DEVELOPMENT_WS_METHODS.directInput,
        development.directInput(input),
      ),
    [WORKSPACE_DEVELOPMENT_WS_METHODS.returnControl]: (input) =>
      observeRpcEffect(
        WORKSPACE_DEVELOPMENT_WS_METHODS.returnControl,
        development.returnControl(input),
      ),
    [WORKSPACE_DEVELOPMENT_WS_METHODS.goal]: (input) =>
      observeRpcEffect(WORKSPACE_DEVELOPMENT_WS_METHODS.goal, development.goal(input)),
  };
}
