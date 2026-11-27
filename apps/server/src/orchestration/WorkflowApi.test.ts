import {
  ClientOrchestrationCommand,
  ServerSettingsError,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceMeetingParticipantId,
  type WorkspaceAgentRole,
  type ThreadModelTeam,
} from "@t3tools/contracts";
import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { workflowDefaults } from "@t3tools/shared/workflow";
import { OrchestrationLayerLive } from "./runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { makeWorkspaceWorkflow } from "./WorkflowApi.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { ProviderCommandReactorLive } from "./Layers/ProviderCommandReactor.ts";
import { ProviderCommandReactor } from "./Services/ProviderCommandReactor.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { resolveTurnDelegateTeam } from "../provider/subagentSelection.ts";
import { WorkspaceWorkflowStore } from "../persistence/WorkspaceWorkflowStore.ts";
import { compileWorkflowRun } from "./workspaceWorkflow.ts";
import {
  parseWorkflowAssignments,
  workflowNeedsAssignment,
} from "./workspaceWorkflowAssignment.ts";
import { resolveNodeAssignmentRoute } from "./workspaceMeeting.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { WorkspaceMemory } from "./WorkspaceMemory.ts";
import { WorktreeProvisionService } from "../git/WorktreeProvisionService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { WorkspaceAgentExecutor } from "./Services/WorkspaceAgentExecutor.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { makeWorkspaceCollaborationReactor } from "./Layers/WorkspaceCollaborationReactor.ts";
import { OrchestrationTurnWaitLive } from "./Layers/OrchestrationTurnWait.ts";
import { WorkspaceWorktreeCleanup } from "./Layers/WorkspaceWorktreeCleanup.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { WorkspaceDevelopmentGit } from "./WorkspaceDevelopmentGit.ts";

const encodeJsonFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJsonFixture = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const now = "2026-10-26T00:00:00.000Z";
const layer = it.layer(
  OrchestrationLayerLive.pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(WorkspaceMemory.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-test-" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  ),
);
let nextId = 0;
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-workspace-" });
  const projectId = ProjectId.make(`workflow-test-${++nextId}`);
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`create:${projectId}`),
    projectId,
    title: "Workflow test",
    workspaceRoot,
    defaultModelSelection: null,
    createdAt: now,
  });
  for (const role of ["coordinator", "implementer", "researcher"] as WorkspaceAgentRole[]) {
    yield* engine.dispatch({
      type: "project.agent-role.upsert",
      commandId: CommandId.make(`role:${projectId}:${role}`),
      projectId,
      role,
      displayName: role,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      instructions: "Keep user conditions",
      enabled: true,
      createdAt: now,
    });
  }
  const selectedThreadId = ThreadId.make(`${projectId}:selected-test-thread`);
  const secondThreadId = ThreadId.make(`${projectId}:second-test-thread`);
  for (const threadId of [selectedThreadId, secondThreadId]) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId,
      title: "Selected test conversation",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
  }
  const api = yield* makeWorkspaceWorkflow;
  const definition = workflowDefaults()[0]!;
  const saved = yield* api.save({ projectId, definition, expectedRevision: 0, archived: false });
  return { projectId, workspaceRoot, engine, api, saved, selectedThreadId, secondThreadId };
});

const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const pendingTeamSeed = Effect.fn("test.pendingTeamSeed")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ sequence: number; event_type: string; status: string; run_id: string }>`
    SELECT e.sequence, e.event_type, r.status, json_extract(e.payload_json,'$.run.id') AS run_id
    FROM pending_thread_model_team_seeds p
    JOIN orchestration_events e ON e.sequence=p.event_sequence
    JOIN orchestration_command_receipts r ON r.command_id=e.command_id AND r.result_sequence=e.sequence
    WHERE p.thread_id=${threadId}`;
});

function teamDraft(projectId: ProjectId, threadId: ThreadId) {
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "answer" };
  const team: ThreadModelTeam = {
    threadId,
    answeringInstanceId: modelSelection.instanceId,
    forModel: modelSelection.model,
    members: [
      { instanceId: ProviderInstanceId.make("codex"), model: "room-only-model", role: "scout" },
    ],
  };
  const createThread = {
    projectId,
    title: "Draft",
    modelSelection,
    runtimeMode: "approval-required" as const,
    interactionMode: "plan" as const,
    branch: null,
    worktreePath: null,
    createdAt: now,
    modelTeams: [team],
  };
  return { team, createThread };
}

layer("Workflow command/event/projection integration", (it) => {
  for (const kind of ["direct meeting", "saved workflow"] as const) {
    it.effect(
      "seeds a new conversation on accepted " + kind + " without changing participants",
      () =>
        Effect.gen(function* () {
          const { projectId, api, saved } = yield* setup;
          const threadId = ThreadId.make(projectId + ":workflow-draft");
          const { team, createThread } = teamDraft(projectId, threadId);
          const settings = yield* ServerSettingsService;
          const chair = {
            id: WorkspaceMeetingParticipantId.make("chair"),
            displayName: "Coordinator",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "meeting-chair",
            },
          };
          const input = {
            projectId,
            threadId,
            requestId: "first-work",
            bootstrap: { createThread: { ...createThread, customSubordinateTeam: team.members } },
            ...(kind === "direct meeting"
              ? {
                  task: "meeting task",
                  meeting: {
                    mode: "fixed-rounds" as const,
                    participants: [chair],
                    chairParticipantId: chair.id,
                    maxRounds: 0,
                    userInLoop: false,
                  },
                }
              : {
                  definitionId: saved.id,
                  revision: saved.revision,
                  values: { goal: "workflow task" },
                }),
          };
          const run = yield* api.start(input);
          const context = run.workflow ?? run.runContext;
          expect(context?.initialModelTeams).toEqual([team]);
          expect(context?.customSubordinateTeam).toEqual(team.members);
          if (kind === "direct meeting")
            expect(run.meeting?.participants[0]?.modelSelection).toEqual(chair.modelSelection);
          else
            expect(
              run.workflow?.roleBindings.map((role) => role.modelSelection.model),
            ).not.toContain("room-only-model");
          const persisted = yield* settings.getSettings;
          expect(persisted.threadModelTeams.filter((row) => row.threadId === threadId)).toEqual([
            team,
          ]);
          expect(persisted.threadSubordinateTeams[threadId]).toEqual(team.members);
          expect(
            resolveTurnDelegateTeam(persisted, { ...team, forModel: "switched-parent" }),
          ).toMatchObject({
            source: "room",
            members: team.members,
          });
          yield* settings.updateSettings({ threadModelTeamUpdate: { ...team, members: null } });
          expect((yield* api.start(input)).id).toBe(run.id);
          expect(
            (yield* settings.getSettings).threadModelTeams.filter(
              (row) => row.threadId === threadId,
            ),
          ).toEqual([]);
          const sql = yield* SqlClient.SqlClient;
          const events = yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM orchestration_events
          WHERE event_type='project.collaboration-run-requested' AND command_id=${"workflow-start:" + run.id}`;
          expect(events[0]?.count).toBe(1);
        }),
    );
  }

  for (const kind of ["direct", "definition"] as const) {
    it.effect(
      "captures the global answer style for a " +
        kind +
        " workflow unless the conversation has its own",
      () =>
        Effect.gen(function* () {
          const { projectId, api, saved, selectedThreadId } = yield* setup;
          const settings = yield* ServerSettingsService;
          const own = {
            preset: "concise" as const,
            tone: "",
            length: "",
            explanation: "",
            instructions: "room answer style",
          };
          const global = {
            ...own,
            preset: "professional" as const,
            instructions: "global answer style",
          };
          yield* settings.updateSettings({ globalResponseStyle: global });
          const input = {
            projectId,
            threadId: selectedThreadId,
            requestId: "global-style",
            ...(kind === "direct"
              ? { task: "global work" }
              : {
                  definitionId: saved.id,
                  revision: saved.revision,
                  values: { goal: "global work" },
                }),
          };
          const run = yield* api.start(input);
          expect((run.workflow ?? run.runContext)?.responseStyle).toEqual(global);
          yield* settings.updateSettings({ globalResponseStyle: null });
          const resumed = yield* api.start(input);
          expect((resumed.workflow ?? resumed.runContext)?.responseStyle).toEqual(global);
          const next = yield* api.start({ ...input, requestId: "global-style-cleared" });
          expect((next.workflow ?? next.runContext)?.responseStyle).toBeNull();
          yield* settings.updateSettings({
            globalResponseStyle: global,
            threadResponseStyles: { [selectedThreadId]: own },
          });
          const custom = yield* api.start({ ...input, requestId: "room-style" });
          expect((custom.workflow ?? custom.runContext)?.responseStyle).toEqual(own);
          // A stored style that asks for nothing is not an override.
          yield* settings.updateSettings({
            threadResponseStyles: {
              [selectedThreadId]: { ...own, preset: "default", instructions: "" },
            },
          });
          const blank = yield* api.start({ ...input, requestId: "blank-room-style" });
          expect((blank.workflow ?? blank.runContext)?.responseStyle).toEqual(global);
        }),
    );

    it.effect(
      "applies a first-request style to a new " + kind + " workflow and keeps later edits",
      () =>
        Effect.gen(function* () {
          const { projectId, api, saved, selectedThreadId } = yield* setup;
          const threadId = ThreadId.make(projectId + ":style-only");
          const { modelTeams: _teams, ...creation } = teamDraft(projectId, threadId).createThread;
          const style = {
            preset: "professional" as const,
            tone: "warm",
            length: "short",
            explanation: "facts",
            instructions: "first request style",
          };
          const settings = yield* ServerSettingsService;
          const input = {
            projectId,
            threadId,
            requestId: "style-only",
            bootstrap: { createThread: { ...creation, responseStyle: style } },
            ...(kind === "direct"
              ? { task: "first work" }
              : {
                  definitionId: saved.id,
                  revision: saved.revision,
                  values: { goal: "first work" },
                }),
          };
          const run = yield* api.start(input);
          const context = run.workflow ?? run.runContext;
          expect(context?.responseStyle).toEqual(style);
          expect((yield* settings.getSettings).threadResponseStyles[threadId]).toEqual(style);
          expect(yield* pendingTeamSeed(threadId)).toEqual([]);
          const later = { ...style, instructions: "user edit" };
          yield* settings.updateSettings({ threadResponseStyles: { [threadId]: later } });
          expect((yield* api.start(input)).id).toBe(run.id);
          expect((yield* settings.getSettings).threadResponseStyles[threadId]).toEqual(later);
          expect(
            (yield* api
              .start({ ...input, threadId: selectedThreadId, requestId: "foreign-style" })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* settings.getSettings).threadResponseStyles[selectedThreadId],
          ).toBeUndefined();
        }),
    );
  }

  it.effect(
    "rejects foreign rooms and duplicate or cross-room draft scopes before creating a room",
    () =>
      Effect.gen(function* () {
        const { projectId, api, selectedThreadId } = yield* setup;
        const threadId = ThreadId.make(projectId + ":invalid-draft");
        const { team, createThread } = teamDraft(projectId, threadId);
        const submit = (target: ThreadId, teams: ThreadModelTeam[]) =>
          api
            .start({
              projectId,
              threadId: target,
              requestId: "invalid-first",
              task: "test",
              bootstrap: { createThread: { ...createThread, modelTeams: teams } },
            })
            .pipe(Effect.result);
        expect(
          (yield* submit(threadId, [team, { ...team, forModel: team.forModel.toUpperCase() }]))
            ._tag,
        ).toBe("Failure");
        expect((yield* submit(threadId, [{ ...team, threadId: selectedThreadId }]))._tag).toBe(
          "Failure",
        );
        const query = yield* ProjectionSnapshotQuery;
        expect((yield* query.getThreadRuntimeContext(threadId))._tag).toBe("None");
        expect(
          (yield* submit(selectedThreadId, [{ ...team, threadId: selectedThreadId }]))._tag,
        ).toBe("Failure");
        const settings = yield* ServerSettingsService;
        expect(
          (yield* settings.getSettings).threadModelTeams.some(
            (row) => row.threadId === selectedThreadId,
          ),
        ).toBe(false);
      }),
  );

  it.effect(
    "seeds only after acceptance and recovers a failed publication using the accepted run snapshot",
    () =>
      Effect.gen(function* () {
        const { projectId, engine, api } = yield* setup;
        const threadId = ThreadId.make(projectId + ":retry-draft");
        const { team, createThread } = teamDraft(projectId, threadId);
        const input = {
          projectId,
          threadId,
          requestId: "retry-team",
          task: "first work",
          bootstrap: { createThread },
        };
        const refused = yield* makeWorkspaceWorkflow.pipe(
          Effect.provideService(OrchestrationEngineService, {
            ...engine,
            dispatch: (command) =>
              command.type === "project.collaboration.run.request"
                ? Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: "fixture rejection",
                    }),
                  )
                : engine.dispatch(command),
          }),
        );
        expect((yield* refused.start(input).pipe(Effect.result))._tag).toBe("Failure");
        const settings = yield* ServerSettingsService;
        expect(yield* pendingTeamSeed(threadId)).toEqual([]);
        expect(
          (yield* settings.getSettings).threadModelTeams.some((row) => row.threadId === threadId),
        ).toBe(false);
        const interrupted = yield* makeWorkspaceWorkflow.pipe(
          Effect.provideService(ServerSettingsService, {
            ...settings,
            initializeThreadModelTeams: () =>
              Effect.fail(
                new ServerSettingsError({
                  settingsPath: "fixture",
                  operation: "write-file",
                  cause: "fixture failure",
                }),
              ),
          }),
        );
        expect((yield* interrupted.start(input).pipe(Effect.flip)).message).toContain(
          "작업은 접수",
        );
        expect(
          (yield* settings.getSettings).threadModelTeams.some((row) => row.threadId === threadId),
        ).toBe(false);
        const pending = yield* pendingTeamSeed(threadId);
        expect(pending).toEqual([
          expect.objectContaining({
            event_type: "project.collaboration-run-requested",
            status: "accepted",
          }),
        ]);
        yield* settings.updateSettings({ threadModelTeamUpdate: { ...team, members: [] } });
        const restored = yield* api.start(input);
        expect(pending[0]?.run_id).toBe(restored.id);
        expect(yield* pendingTeamSeed(threadId)).toEqual([]);
        expect(restored.runContext?.initialModelTeams).toEqual([team]);
        expect(
          (yield* settings.getSettings).threadModelTeams.find((row) => row.threadId === threadId)
            ?.members,
        ).toEqual([]);
        const changed = {
          ...input,
          bootstrap: { createThread: { ...createThread, modelTeams: [{ ...team, members: [] }] } },
        };
        expect((yield* api.start(changed).pipe(Effect.result))._tag).toBe("Failure");
        yield* engine.dispatch({
          type: "thread.delete",
          threadId,
          commandId: CommandId.make(projectId + ":delete-draft"),
        });
        expect((yield* interrupted.start(input)).id).toBe(restored.id);
      }),
  );

  it.effect(
    "restores accepted workflow and direct draft teams at startup without resubmission",
    () =>
      Effect.gen(function* () {
        const { projectId, saved, engine } = yield* setup;
        const settings = yield* ServerSettingsService;
        const unavailable = yield* makeWorkspaceWorkflow.pipe(
          Effect.provideService(ServerSettingsService, {
            ...settings,
            initializeThreadModelTeams: () =>
              Effect.fail(
                new ServerSettingsError({
                  settingsPath: "fixture",
                  operation: "write-file",
                  cause: "simulated interrupted write",
                }),
              ),
          }),
        );
        const survivors: ThreadModelTeam[] = [];
        for (const kind of ["direct", "saved", "deleted"] as const) {
          const threadId = ThreadId.make(projectId + ":crash-" + kind);
          const { team, createThread } = teamDraft(projectId, threadId);
          const result = yield* unavailable
            .start({
              projectId,
              threadId,
              requestId: kind,
              bootstrap: { createThread },
              ...(kind === "saved"
                ? { definitionId: saved.id, revision: saved.revision, values: { goal: "recover" } }
                : { task: "recover" }),
            })
            .pipe(Effect.flip);
          expect(result.message).toContain("작업은 접수");
          expect(yield* pendingTeamSeed(threadId)).toHaveLength(1);
          if (kind === "deleted") {
            yield* engine.dispatch({
              type: "thread.delete",
              threadId,
              commandId: CommandId.make(threadId + ":delete"),
            });
            expect(yield* pendingTeamSeed(threadId)).toEqual([]);
          } else survivors.push(team);
        }
        const restart = Effect.gen(function* () {
          const reactor = yield* ProviderCommandReactor;
          yield* reactor.start();
          yield* reactor.drain;
        }).pipe(
          Effect.provide(
            ProviderCommandReactorLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(ProviderService)({}),
                  Layer.mock(ProviderRegistry)({}),
                  Layer.mock(GitWorkflowService)({}),
                  Layer.mock(TextGeneration)({}),
                  Layer.mock(VcsStatusBroadcaster)({}),
                ),
              ),
            ),
          ),
          Effect.scoped,
        );
        const roomTeams = Effect.map(settings.getSettings, (s) =>
          s.threadModelTeams.filter((team) => team.threadId.startsWith(projectId + ":crash-")),
        );
        expect(yield* roomTeams).toEqual([]);
        yield* restart;
        expect(yield* roomTeams).toHaveLength(survivors.length);
        for (const team of survivors) {
          expect(yield* roomTeams).toContainEqual(team);
          expect(yield* pendingTeamSeed(team.threadId)).toEqual([]);
        }
        yield* settings.updateSettings({
          threadModelTeamUpdate: { ...survivors[0]!, members: null },
        });
        yield* restart;
        expect(yield* roomTeams).toEqual(survivors.slice(1));
      }),
  );

  for (const conflict of [
    "foreign room",
    "earlier ordinary turn",
    "earlier workflow",
    "outbox insert failure",
  ] as const) {
    it.effect("atomically rejects a draft seed after " + conflict, () =>
      Effect.gen(function* () {
        const { projectId, selectedThreadId, engine } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make(projectId + ":guarded");
        const { team, createThread } = teamDraft(projectId, threadId);
        let attempted: CommandId | undefined;
        const racingApi = yield* makeWorkspaceWorkflow.pipe(
          Effect.provideService(OrchestrationEngineService, {
            ...engine,
            dispatch: (command) =>
              Effect.gen(function* () {
                if (command.type !== "project.collaboration.run.request")
                  return yield* engine.dispatch(command);
                attempted = command.commandId;
                if (conflict === "foreign room") {
                  if (!command.runContext) throw new Error("Expected a direct workflow context");
                  return yield* engine.dispatch({
                    ...command,
                    runContext: {
                      ...command.runContext,
                      threadId: selectedThreadId,
                      initialModelTeams: [{ ...team, threadId: selectedThreadId }],
                    },
                  });
                }
                if (conflict === "earlier ordinary turn") {
                  yield* engine.dispatch({
                    type: "thread.turn.start",
                    commandId: CommandId.make(threadId + ":competing-turn"),
                    threadId,
                    message: {
                      messageId: MessageId.make(threadId + ":message"),
                      role: "user",
                      text: "existing work",
                      attachments: [],
                    },
                    runtimeMode: "approval-required",
                    interactionMode: "plan",
                    createdAt: now,
                  });
                } else if (conflict === "earlier workflow") {
                  yield* engine.dispatch({
                    type: "project.collaboration.run.request",
                    commandId: CommandId.make(threadId + ":competing-workflow"),
                    projectId,
                    runId: WorkspaceCollaborationRunId.make(threadId + ":competing-run"),
                    task: "existing work",
                    createdAt: now,
                    runContext: { threadId, requestDigest: "existing-work" },
                  });
                } else {
                  // Force the real INSERT to violate the unique thread constraint.
                  yield* sql`INSERT INTO pending_thread_model_team_seeds(thread_id,event_sequence)
              SELECT ${threadId},sequence FROM orchestration_events WHERE stream_id=${threadId} AND event_type='thread.created'`.pipe(
                    Effect.orDie,
                  );
                }
                return yield* engine.dispatch(command);
              }),
          }),
        );
        expect(
          (yield* racingApi
            .start({
              projectId,
              threadId,
              requestId: "guard",
              task: "first work",
              bootstrap: { createThread },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        if (!attempted) throw new Error("The seeded request did not reach dispatch");
        expect(
          yield* sql`SELECT 1 FROM orchestration_events WHERE command_id=${attempted}`,
        ).toEqual([]);
        expect(
          yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id=${attempted} AND status='accepted'`,
        ).toEqual([]);
        const pending = yield* pendingTeamSeed(threadId);
        expect(pending.map((row) => row.event_type)).toEqual(
          conflict === "outbox insert failure" ? ["thread.created"] : [],
        );
        expect(yield* pendingTeamSeed(selectedThreadId)).toEqual([]);
        const settings = yield* ServerSettingsService;
        expect(
          (yield* settings.getSettings).threadModelTeams.some(
            (row) => row.threadId === threadId || row.threadId === selectedThreadId,
          ),
        ).toBe(false);
      }),
    );
  }

  it.effect("does not accept a server-owned draft seed in the generic client run request", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("fixture"),
        threadId = ThreadId.make("fixture-thread");
      const { team } = teamDraft(projectId, threadId);
      const decoded = yield* decodeClientCommand({
        type: "project.collaboration.run.request",
        commandId: "spoofed",
        runId: "spoofed",
        projectId,
        task: "task",
        createdAt: now,
        runContext: { threadId, requestDigest: "fixture", initialModelTeams: [team] },
      });
      expect(decoded).toMatchObject({
        type: "project.collaboration.run.request",
        runContext: { threadId },
      });
      expect(
        decoded.type === "project.collaboration.run.request" && decoded.runContext,
      ).not.toHaveProperty("initialModelTeams");
    }),
  );
  it.effect("keeps ordinary workflows available without a conversation", () =>
    Effect.gen(function* () {
      const { projectId, api, saved } = yield* setup;
      const direct = yield* api.start({
        projectId,
        task: "ordinary task",
        requestId: "ordinary-no-conversation",
      });
      expect(direct.meeting).toBeNull();
      expect(direct.runContext?.threadId).toBeUndefined();
      expect(direct.runContext?.roleBindings?.[0]?.runtimeMode).toBe("approval-required");
      const planned = yield* api.start({
        projectId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "ordinary workflow" },
        requestId: "ordinary-saved-no-conversation",
      });
      expect(planned.meeting).toBeNull();
      expect(planned.workflow?.threadId).toBeUndefined();
      expect(planned.workflow?.roleBindings[0]?.interactionMode).toBe("plan");
    }),
  );
  it.effect(
    "records missing worker providers without changing their models or blocking independent work",
    () =>
      Effect.gen(function* () {
        const { projectId, selectedThreadId } = yield* setup;
        const registry = {
          getInstance: (id: ProviderInstanceId) =>
            Effect.succeed(
              id === "missing-researcher"
                ? undefined
                : ({ instanceId: id, enabled: true } as never),
            ),
          listUnavailable: Effect.succeed([]),
        } as unknown as ProviderInstanceRegistry["Service"];
        const api = yield* makeWorkspaceWorkflow.pipe(
          Effect.provideService(ProviderInstanceRegistry, registry),
        );
        const selection = (instanceId: string, model: string) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          model,
        });
        const models = {
          coordinator: selection("codex", "coordinator"),
          implementer: selection("antseed-local", "implementer"),
          researcher: selection("missing-researcher", "deepseek"),
        };
        const run = yield* api.start({
          projectId,
          threadId: selectedThreadId,
          task: "외부 자료 조사",
          requestId: "missing-provider",
          roleModels: models,
        });
        expect(
          run.runContext?.roleBindings?.find((entry) => entry.role === "researcher")
            ?.modelSelection,
        ).toEqual(models.researcher);
        expect(run.runContext?.providerWarnings).toHaveLength(1);
        expect(run.runContext?.providerWarnings?.[0]).toMatchObject({
          role: "researcher",
          modelSelection: models.researcher,
        });
        expect(run.runContext?.providerWarnings?.[0]?.message).toContain("등록되어 있지 않습니다");
      }),
  );

  it.effect("preserves a missing worker warning on a saved workflow", () =>
    Effect.gen(function* () {
      const { projectId, saved, selectedThreadId } = yield* setup;
      const registry = {
        getInstance: (id: ProviderInstanceId) =>
          Effect.succeed(
            id === "missing-researcher" ? undefined : ({ instanceId: id, enabled: true } as never),
          ),
        listUnavailable: Effect.succeed([]),
      } as unknown as ProviderInstanceRegistry["Service"];
      const api = yield* makeWorkspaceWorkflow.pipe(
        Effect.provideService(ProviderInstanceRegistry, registry),
      );
      const selected = { instanceId: ProviderInstanceId.make("codex"), model: "model" };
      const missing = {
        instanceId: ProviderInstanceId.make("missing-researcher"),
        model: "research",
      };
      const run = yield* api.start({
        projectId,
        threadId: selectedThreadId,
        definitionId: saved.id,
        revision: 1,
        values: { goal: "fixture" },
        requestId: "saved-missing-provider",
        roleModels: { coordinator: selected, implementer: selected, researcher: missing },
      });
      expect(run.workflow?.providerWarnings).toHaveLength(1);
      expect(run.workflow?.providerWarnings?.[0]).toMatchObject({
        role: "researcher",
        modelSelection: missing,
      });
    }),
  );

  it.effect("rejects an unavailable coordinator before attempting to plan", () =>
    Effect.gen(function* () {
      const { projectId } = yield* setup;
      const registry = {
        getInstance: () => Effect.succeed(undefined),
        listUnavailable: Effect.succeed([]),
      } as unknown as ProviderInstanceRegistry["Service"];
      const api = yield* makeWorkspaceWorkflow.pipe(
        Effect.provideService(ProviderInstanceRegistry, registry),
      );
      const selected = { instanceId: ProviderInstanceId.make("missing"), model: "test" };
      const error = yield* api
        .start({
          projectId,
          task: "task",
          requestId: "missing-chair",
          roleModels: { coordinator: selected, implementer: selected, researcher: selected },
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("coordinator");
    }),
  );

  it.effect("discovers chat skills from the thread worktree and rejects another project", () =>
    Effect.gen(function* () {
      const { projectId, workspaceRoot, engine, api } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktree = yield* fs.makeTempDirectoryScoped({ prefix: "t3-chat-skill-worktree-" });
      const directory = path.join(worktree, ".agents", "skills", "sample");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "SKILL.md"),
        "---\nname: sample\ndescription: Sample\n---\nBody",
      );
      const parent = path.join(workspaceRoot, ".agents", "skills", "parent-only");
      yield* fs.makeDirectory(parent, { recursive: true });
      yield* fs.writeFileString(path.join(parent, "SKILL.md"), "---\nname: parent-only\n---\nBody");
      const threadId = ThreadId.make(`${projectId}:skill-thread`);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: "Skill chat",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "chat-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: worktree,
        createdAt: now,
      });
      const found = yield* api.chatSkills({ projectId, threadId });
      expect(found.codex.map((skill) => skill.name)).toEqual(["parent-only", "sample"]);
      expect(
        (yield* api.chatSkills({ projectId })).codex.some((skill) => skill.name === "sample"),
      ).toBe(false);
      const other = ProjectId.make(`${projectId}:other`);
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`${other}:create`),
        projectId: other,
        title: "Other",
        workspaceRoot: worktree,
        defaultModelSelection: null,
        createdAt: now,
      });
      expect(
        Exit.isFailure(yield* Effect.exit(api.chatSkills({ projectId: other, threadId }))),
      ).toBe(true);
    }),
  );
  it.effect("starts a draft conversation using its selected model and prepared worktree", () =>
    Effect.gen(function* () {
      const { projectId } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const worktreePath = yield* fs.makeTempDirectoryScoped({
        prefix: "workflow-draft-worktree-",
      });
      const threadId = ThreadId.make(`${projectId}:draft-thread`);
      const setupCalls: string[] = [];
      const api = yield* makeWorkspaceWorkflow.pipe(
        Effect.provideService(
          WorktreeProvisionService,
          WorktreeProvisionService.of({
            provision: () =>
              Effect.succeed({ worktreePath, refName: "draft-branch", reused: false }),
            runSetupGate: () => Effect.succeed({ status: "ok" }),
          }),
        ),
        Effect.provideService(
          ProjectSetupScriptRunner,
          ProjectSetupScriptRunner.of({
            runForThread: (input) =>
              Effect.sync(() => {
                setupCalls.push(input.worktreePath);
                return { status: "no-script" as const };
              }),
          }),
        ),
      );
      const participant = {
        id: WorkspaceMeetingParticipantId.make("draft-supervisor"),
        displayName: "Supervisor",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "supervisor" },
      };
      const selected = { instanceId: ProviderInstanceId.make("codex"), model: "chat-model" };
      const run = yield* api.start({
        projectId,
        threadId,
        task: "초안에서 요청한 통합 작업",
        requestId: "draft-integrated",
        meeting: {
          mode: "fixed-rounds",
          participants: [participant],
          chairParticipantId: participant.id,
          maxRounds: 0,
          userInLoop: false,
        },
        orchestra: { maxParallel: 1, isolateWorktrees: false, executionMode: "persistent" },
        bootstrap: {
          createThread: {
            projectId,
            title: "초안 대화",
            modelSelection: selected,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            createdAt: now,
          },
          prepareWorktree: {
            projectCwd: "ignored-client-path",
            baseBranch: "main",
            branch: "draft-branch",
          },
          runSetupScript: true,
        },
      });
      const query = yield* ProjectionSnapshotQuery;
      const thread = yield* query.getThreadRuntimeContext(threadId, { messages: true });
      expect(thread._tag).toBe("Some");
      if (thread._tag !== "Some") return;
      expect(thread.value.modelSelection).toEqual(selected);
      expect(thread.value.worktreePath).toBe(worktreePath);
      expect(
        thread.value.messages.some((message) => message.text === "초안에서 요청한 통합 작업"),
      ).toBe(true);
      expect(run.meeting?.threadId).toBe(threadId);
      expect(setupCalls).toEqual([worktreePath]);
    }),
  );
  it.effect(
    "records the original integrated request and its folder in the current conversation",
    () =>
      Effect.gen(function* () {
        const { projectId, engine, api } = yield* setup;
        const threadId = ThreadId.make(`${projectId}:meeting-chat`);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "Meeting chat",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "chat-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        const participant = {
          id: WorkspaceMeetingParticipantId.make("chair"),
          displayName: "Supervisor",
          roleDescription: "방향과 검증",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "supervisor" },
        };
        const input = {
          projectId,
          threadId,
          task: "현재 대화의 통합 작업을 진행해라",
          requestId: "request-in-chat",
          meeting: {
            mode: "fixed-rounds" as const,
            participants: [participant],
            chairParticipantId: participant.id,
            maxRounds: 0,
            userInLoop: false,
          },
          orchestra: {
            maxParallel: 1,
            isolateWorktrees: false,
            executionMode: "persistent" as const,
          },
        };
        const run = yield* api.start(input);
        const replay = yield* api.start(input);
        expect(replay.id).toBe(run.id);
        expect(Exit.isFailure(yield* Effect.exit(api.start({ ...input, task: "바뀐 목표" })))).toBe(
          true,
        );
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ text: string; folder: string | null }>`SELECT m.text,f.folder
        FROM projection_thread_messages m LEFT JOIN workspace_memory_v2_message_folders f
          ON f.message_id=m.message_id AND f.project_id=${projectId}
        WHERE m.thread_id=${threadId} AND m.message_id=${`workflow-request:${run.id}`}`;
        expect(rows).toEqual([{ text: input.task, folder: "" }]);
        expect(run.orchestra?.executionMode).toBe("persistent");
        expect(run.meeting?.participants[0]?.roleDescription).toBe("방향과 검증");
      }),
  );
  it.effect("records the selected draft and existing conversations in their verified folders", () =>
    Effect.gen(function* () {
      const { projectId, workspaceRoot, engine, api } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workspaceRoot, "apps", "web"), { recursive: true });
      yield* fs.makeDirectory(path.join(workspaceRoot, "apps", "server"), { recursive: true });
      const selected = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "user-selected",
        options: [{ id: "reasoningEffort", value: "medium" }],
      };
      const chair = {
        id: WorkspaceMeetingParticipantId.make("chair"),
        displayName: "Supervisor",
        modelSelection: selected,
      };
      const meeting = {
        mode: "fixed-rounds" as const,
        participants: [chair],
        chairParticipantId: chair.id,
        maxRounds: 0,
        userInLoop: false,
      };
      const original = "원래 사용자 요청: `apps/web` 폴더의 NEBULA 검증을 진행하세요.";
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM projection_threads WHERE project_id=${projectId}`;
      const withoutThread = yield* api
        .start({ projectId, requestId: "no-conversation", task: original, meeting })
        .pipe(Effect.flip);
      expect(withoutThread.message).toContain("대화를 선택");
      const after = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM projection_threads WHERE project_id=${projectId}`;
      expect(after).toEqual(before);
      const selectedDraft = ThreadId.make(`${projectId}:selected-draft`);
      const input = {
        projectId,
        threadId: selectedDraft,
        requestId: "new-folder-conversation",
        task: "가공된 작업 목표",
        userMessage: original,
        meeting,
        runtimeMode: "approval-required" as const,
        interactionMode: "plan" as const,
        bootstrap: {
          createThread: {
            projectId,
            title: "Selected draft",
            modelSelection: selected,
            runtimeMode: "approval-required" as const,
            interactionMode: "plan" as const,
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
        },
      };
      const [run, replay] = yield* Effect.all([api.start(input), api.start(input)], {
        concurrency: "unbounded",
      });
      expect(replay.id).toBe(run.id);
      const threadId = run.meeting?.threadId;
      expect(threadId).toBe(selectedDraft);
      if (!threadId) return;
      const rows = yield* sql<{ text: string; folder: string | null }>`SELECT m.text,f.folder
        FROM projection_thread_messages m LEFT JOIN workspace_memory_v2_message_folders f
          ON f.message_id=m.message_id AND f.project_id=${projectId}
        WHERE m.thread_id=${threadId} AND m.message_id=${`workflow-request:${run.id}`}`;
      expect(rows).toEqual([{ text: original, folder: "apps/web" }]);
      const query = yield* ProjectionSnapshotQuery;
      const thread = yield* query.getThreadRuntimeContext(threadId, { messages: true });
      expect(thread._tag).toBe("Some");
      if (thread._tag !== "Some") return;
      expect(thread.value.modelSelection).toEqual(selected);
      expect(thread.value.runtimeMode).toBe("approval-required");
      expect(thread.value.interactionMode).toBe("plan");
      const memory = yield* WorkspaceMemory;
      const saved = yield* memory.invoke(
        {
          projectId,
          action: "remember",
          requestId: "new-folder-note",
          topic: "NEBULACANARY",
          text: "NEBULACANARY saved in the selected folder",
          scope: "project",
        },
        { threadId, agentReported: true },
      );
      expect(yield* decodeJsonFixture(saved)).toMatchObject({
        saved: true,
      });
      const search = yield* memory.invoke(
        { projectId, action: "search", query: "NEBULACANARY" },
        { threadId },
      );
      expect(search).toContain("NEBULACANARY saved in the selected folder");

      const existing = ThreadId.make(`${projectId}:existing-folder`);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${existing}:create`),
        threadId: existing,
        projectId,
        title: "Existing conversation",
        modelSelection: selected,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      const priorMessage = MessageId.make(`${existing}:prior`);
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(`${existing}:prior`),
        threadId: existing,
        messageId: priorMessage,
        text: "이 대화는 `apps/server` 에서 진행합니다.",
        createdAt: now,
      });
      yield* memory.contextPaths({
        projectId,
        threadId: existing,
        messageId: priorMessage,
        cwd: workspaceRoot,
        recordCurrent: true,
      });
      const continued = yield* api.start({
        projectId,
        threadId: existing,
        requestId: "existing-folder-conversation",
        task: input.task,
        meeting: { ...meeting, runtimeMode: "approval-required", interactionMode: "plan" },
        userMessage: "기존 대화에서 그대로 이어서 확인하세요.",
      });
      expect(continued.meeting?.threadId).toBe(existing);
      expect(continued.meeting?.runtimeMode).toBe("full-access");
      expect(continued.meeting?.interactionMode).toBe("default");
      expect(continued.meeting?.participants[0]?.modelSelection).toEqual(selected);
      const existingRows = yield* sql<{
        text: string;
        folder: string | null;
      }>`SELECT m.text,f.folder
        FROM projection_thread_messages m LEFT JOIN workspace_memory_v2_message_folders f
          ON f.message_id=m.message_id AND f.project_id=${projectId}
        WHERE m.thread_id=${existing} AND m.message_id=${`workflow-request:${continued.id}`}`;
      expect(existingRows).toEqual([
        { text: "기존 대화에서 그대로 이어서 확인하세요.", folder: "apps/server" },
      ]);
      const outsideFolder = yield* memory.invoke(
        { projectId, action: "search", query: "NEBULACANARY" },
        { threadId: existing },
      );
      expect(outsideFolder).not.toContain("NEBULACANARY saved in the selected folder");
      const other = yield* setup;
      const crossProject = yield* memory
        .invoke(
          { projectId: other.projectId, action: "search", query: "NEBULACANARY" },
          { threadId },
        )
        .pipe(Effect.flip);
      expect(crossProject.message).toContain("현재 프로젝트의 대화만");

      const ambiguous = yield* api.start({
        ...input,
        threadId: ThreadId.make(`${projectId}:ambiguous-draft`),
        requestId: "ambiguous-folder-conversation",
        userMessage: "`apps/web` 과 `apps/server` 를 모두 확인하세요.",
      });
      const ambiguousThread = ambiguous.meeting?.threadId;
      expect(ambiguousThread).toBeTruthy();
      if (!ambiguousThread) return;
      const unresolved = yield* memory
        .invoke(
          {
            projectId,
            action: "remember",
            requestId: "ambiguous-folder-note",
            topic: "ambiguous",
            text: "No folder should be guessed",
            scope: "project",
          },
          { threadId: ambiguousThread, agentReported: true },
        )
        .pipe(Effect.flip);
      expect(unresolved.message).toContain("작업 폴더가 기록되지 않아");

      const conflicting = {
        ...input,
        threadId: ThreadId.make(`${projectId}:conflicting-draft`),
        requestId: "concurrent-different-original",
      };
      const outcomes = yield* Effect.all(
        [
          Effect.exit(api.start({ ...conflicting, userMessage: "원문 A: `apps/web` 확인" })),
          Effect.exit(api.start({ ...conflicting, userMessage: "원문 B: `apps/server` 확인" })),
        ],
        { concurrency: "unbounded" },
      );
      const accepted = outcomes.flatMap((outcome, index) =>
        Exit.isSuccess(outcome) ? [{ index, run: outcome.value }] : [],
      );
      expect(accepted).toHaveLength(1);
      const winner = accepted[0];
      if (!winner?.run.meeting?.threadId) return;
      const winnerRows = yield* sql<{ text: string; folder: string | null }>`SELECT m.text,f.folder
        FROM projection_thread_messages m LEFT JOIN workspace_memory_v2_message_folders f
          ON f.message_id=m.message_id AND f.project_id=${projectId}
        WHERE m.thread_id=${winner.run.meeting.threadId} AND m.message_id=${`workflow-request:${winner.run.id}`}`;
      const expected = [
        { text: "원문 A: `apps/web` 확인", folder: "apps/web" },
        { text: "원문 B: `apps/server` 확인", folder: "apps/server" },
      ];
      expect(winnerRows).toEqual([expected[winner.index]]);
    }),
  );
  it.effect("records the original saved workflow request in the selected draft", () =>
    Effect.gen(function* () {
      const { projectId, workspaceRoot, api, saved } = yield* setup;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workspaceRoot, "apps", "web"), { recursive: true });
      const chair = {
        id: WorkspaceMeetingParticipantId.make("saved-chair"),
        displayName: "Supervisor",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "selected" },
      };
      const text = "저장된 단계의 원문: `apps/web` 을 확인해 주세요.";
      const draft = ThreadId.make(`${projectId}:saved-selected-draft`);
      const run = yield* api.start({
        projectId,
        threadId: draft,
        requestId: "saved-workflow-new-conversation",
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "가공된 목표" },
        userMessage: text,
        bootstrap: {
          createThread: {
            projectId,
            title: "Selected saved-workflow draft",
            modelSelection: chair.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "plan",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
        },
        meeting: {
          mode: "fixed-rounds",
          participants: [chair],
          chairParticipantId: chair.id,
          maxRounds: 0,
          userInLoop: false,
        },
      });
      const threadId = run.meeting?.threadId;
      expect(threadId).toBe(draft);
      expect(run.meeting?.runtimeMode).toBe("approval-required");
      expect(run.meeting?.interactionMode).toBe("plan");
      expect(run.workflow?.threadId).toBe(threadId);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ text: string; folder: string | null }>`SELECT m.text,f.folder
        FROM projection_thread_messages m LEFT JOIN workspace_memory_v2_message_folders f
          ON f.message_id=m.message_id AND f.project_id=${projectId}
        WHERE m.thread_id=${threadId} AND m.message_id=${`workflow-request:${run.id}`}`;
      expect(rows).toEqual([{ text, folder: "apps/web" }]);
    }),
  );
  it.effect("does not hide a queued normal turn behind the integrated request message", () =>
    Effect.gen(function* () {
      const { projectId, engine, api } = yield* setup;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const threadId = ThreadId.make(`${projectId}:queued-before-meeting`);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: "Queued normal work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "chat-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`${threadId}:normal-turn`),
        threadId,
        message: {
          messageId: MessageId.make(`${threadId}:normal-message`),
          role: "user",
          text: "Existing work",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      });
      const chair = {
        id: WorkspaceMeetingParticipantId.make("chair"),
        displayName: "Supervisor",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "supervisor" },
      };
      const integratedRequest = {
        projectId,
        threadId,
        requestId: "blocked-by-queued-turn",
        task: "Start integrated work",
        meeting: {
          mode: "fixed-rounds" as const,
          participants: [chair],
          chairParticipantId: chair.id,
          maxRounds: 0,
          userInLoop: false,
        },
      };
      const error = yield* api.start(integratedRequest).pipe(Effect.flip);
      expect(error.message).toContain("현재 대화의 작업이나 질문이 끝난 뒤");
      const stillBusy = yield* api.start(integratedRequest).pipe(Effect.flip);
      expect(stillBusy.message).toContain("현재 대화의 작업이나 질문이 끝난 뒤");
      const changed = yield* api
        .start({ ...integratedRequest, task: "Different request" })
        .pipe(Effect.flip);
      expect(changed.message).toContain("원문을 확인하지 못했습니다");
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`${threadId}:normal-failed`),
        threadId,
        session: {
          threadId,
          status: "error",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Normal turn failed",
          updatedAt: createdAt,
        },
        createdAt,
      });
      const [resumed, repeated] = yield* Effect.all(
        [api.start(integratedRequest), api.start(integratedRequest)],
        { concurrency: "unbounded" },
      );
      expect(resumed.meeting?.threadId).toBe(threadId);
      expect(repeated.id).toBe(resumed.id);
      const sql = yield* SqlClient.SqlClient;
      const [count] = yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM projection_workspace_collaboration_runs WHERE run_id=${resumed.id}`;
      expect(count?.count).toBe(1);
    }),
  );

  it.effect(
    "allows only one queued integrated run in a conversation and retries after it ends",
    () =>
      Effect.gen(function* () {
        const { projectId, engine, api } = yield* setup;
        const threadId = ThreadId.make(`${projectId}:one-integrated-at-a-time`);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "One chat",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "chat-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        const chair = {
          id: WorkspaceMeetingParticipantId.make("chair"),
          displayName: "Supervisor",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "supervisor" },
        };
        const meeting = {
          mode: "fixed-rounds" as const,
          participants: [chair],
          chairParticipantId: chair.id,
          maxRounds: 0,
          userInLoop: false,
        };
        const first = yield* api.start({
          projectId,
          threadId,
          requestId: "first-run",
          task: "First",
          meeting,
        });
        const second = { projectId, threadId, requestId: "second-run", task: "Second", meeting };
        expect((yield* api.start(second).pipe(Effect.flip)).message).toContain(
          "통합 작업이 진행 중입니다",
        );
        yield* engine.dispatch({
          type: "project.collaboration.run.update",
          commandId: CommandId.make(`${first.id}:completed`),
          run: { ...first, status: "cancelled", updatedAt: now },
        });
        const accepted = yield* api.start(second);
        expect(accepted.id).not.toBe(first.id);
        expect(accepted.meeting?.threadId).toBe(threadId);
      }),
  );

  it.effect("rechecks pending questions after reconciliation and retries once resolved", () =>
    Effect.gen(function* () {
      const { projectId, engine, api } = yield* setup;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const threadId = ThreadId.make(`${projectId}:question-before-meeting`);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: "Question waiting",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "chat-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      const appendQuestion = (kind: "user-input.requested" | "user-input.resolved") =>
        engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`${threadId}:${kind}`),
          threadId,
          activity: {
            id: EventId.make(`${threadId}:${kind}`),
            kind,
            tone: "info",
            summary: kind,
            payload: { requestId: "pending-question" },
            turnId: null,
            createdAt,
          },
          createdAt,
        });
      yield* appendQuestion("user-input.requested");
      // A rejected command rebuilds the same lightweight read model used at startup.
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`${threadId}:unrelated-failure`),
          threadId: ThreadId.make("missing-thread"),
          title: "missing",
        })
        .pipe(Effect.flip);
      const chair = {
        id: WorkspaceMeetingParticipantId.make("chair"),
        displayName: "Supervisor",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "supervisor" },
      };
      const request = {
        projectId,
        threadId,
        requestId: "pending-question-retry",
        task: "Start integrated work",
        meeting: {
          mode: "fixed-rounds" as const,
          participants: [chair],
          chairParticipantId: chair.id,
          maxRounds: 0,
          userInLoop: false,
        },
      };
      expect((yield* api.start(request).pipe(Effect.flip)).message).toContain(
        "현재 대화의 작업이나 질문이 끝난 뒤",
      );
      yield* appendQuestion("user-input.resolved");
      expect((yield* api.start(request)).meeting?.threadId).toBe(threadId);
    }),
  );

  it.effect(
    "keeps simultaneous conversation runs independent through real command projections",
    () =>
      Effect.gen(function* () {
        const { projectId, engine, api } = yield* setup;
        const threads = ["first", "second"].map((id) => ThreadId.make(`${projectId}:${id}`));
        for (const threadId of threads) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId,
            title: threadId,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "chat-model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          });
        }
        const supervisor = {
          id: WorkspaceMeetingParticipantId.make("supervisor"),
          displayName: "Supervisor",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "supervisor" },
        };
        const meeting = {
          mode: "fixed-rounds" as const,
          participants: [supervisor],
          chairParticipantId: supervisor.id,
          maxRounds: 0,
          userInLoop: false,
        };
        const first = yield* api.start({
          projectId,
          threadId: threads[0]!,
          requestId: "independent-first",
          task: "First task",
          meeting,
          orchestra: { maxParallel: 1, isolateWorktrees: false, executionMode: "persistent" },
        });
        const second = yield* api.start({
          projectId,
          threadId: threads[1]!,
          requestId: "independent-second",
          task: "Second task",
          meeting,
          orchestra: { maxParallel: 1, isolateWorktrees: false, executionMode: "persistent" },
        });
        for (const run of [first, second]) {
          yield* engine.dispatch({
            type: "project.collaboration.run.update",
            commandId: CommandId.make(`${run.id}:running`),
            run: { ...run, status: "running" },
          });
        }
        yield* engine.dispatch({
          type: "project.collaboration.run.interject",
          commandId: CommandId.make("independent-first-instruction"),
          projectId,
          runId: first.id,
          text: "첫 대화에만 추가한 지시",
          createdAt: now,
        });
        yield* engine.dispatch({
          type: "project.collaboration.run.cancel",
          commandId: CommandId.make("independent-first-stop"),
          projectId,
          runId: first.id,
          createdAt: now,
        });
        const stopped = yield* api.getRun({ projectId, runId: first.id });
        const unaffected = yield* api.getRun({ projectId, runId: second.id });
        expect(stopped.status).toBe("cancel-requested");
        expect(stopped.meeting?.interjections.map((item) => item.text)).toEqual([
          "첫 대화에만 추가한 지시",
        ]);
        expect(unaffected.status).toBe("running");
        expect(unaffected.meeting?.threadId).toBe(threads[1]);
        expect(unaffected.meeting?.interjections).toEqual([]);
      }),
  );
  it.effect(
    "executes and stops independent conversations with real projections and a simulated model",
    () =>
      Effect.gen(function* () {
        const { projectId, workspaceRoot, engine, api } = yield* setup;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(workspaceRoot, "apps", "web"), { recursive: true });
        yield* fs.makeDirectory(path.join(workspaceRoot, "apps", "server"), { recursive: true });
        const threads = ["actor-first", "actor-second", "actor-fresh", "actor-ambiguous"].map(
          (id) => ThreadId.make(`${projectId}:${id}`),
        );
        for (const threadId of threads) {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId,
            title: threadId,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "chat-model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          });
        }
        const supervisor = {
          id: WorkspaceMeetingParticipantId.make("supervisor"),
          displayName: "Supervisor",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "simulated" },
        };
        const meeting = {
          mode: "fixed-rounds" as const,
          participants: [supervisor],
          chairParticipantId: supervisor.id,
          maxRounds: 0,
          userInLoop: false,
        };
        const first = yield* api.start({
          projectId,
          threadId: threads[0]!,
          requestId: "actor-first",
          task: "First task",
          meeting,
          orchestra: {
            maxParallel: 1,
            isolateWorktrees: false,
            executionMode: "persistent",
            verificationCommands: ["simulated-check"],
          },
        });
        const second = yield* api.start({
          projectId,
          threadId: threads[1]!,
          requestId: "actor-second",
          task: "Second task",
          meeting,
          orchestra: {
            maxParallel: 1,
            isolateWorktrees: false,
            executionMode: "persistent",
            verificationCommands: ["simulated-check"],
          },
        });
        const fresh = yield* api.start({
          projectId,
          threadId: threads[2]!,
          requestId: "actor-fresh-folder",
          task: "NEBULAREACTOR 작업",
          userMessage: "원래 요청: `apps/web` 의 NEBULAREACTOR 작업을 수행하세요.",
          meeting,
          orchestra: {
            maxParallel: 1,
            isolateWorktrees: false,
            executionMode: "persistent",
            verificationCommands: ["simulated-check"],
          },
        });
        const ambiguous = yield* api.start({
          projectId,
          threadId: threads[3]!,
          requestId: "actor-ambiguous-folder",
          task: "분류되지 않은 작업",
          userMessage: "`apps/web` 과 `apps/server` 를 함께 확인하세요.",
          meeting,
          orchestra: {
            maxParallel: 1,
            isolateWorktrees: false,
            executionMode: "persistent",
            verificationCommands: ["simulated-check"],
          },
        });
        const bothStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const started = new Set<string>();
        const fake = Layer.succeed(WorkspaceAgentExecutor, {
          execute: (input) =>
            Effect.gen(function* () {
              if (input.prompt.startsWith("# Workspace Meeting Plan")) {
                if (input.execution.runId === first.id || input.execution.runId === second.id) {
                  started.add(input.execution.runId);
                  if (started.size === 2) yield* Deferred.succeed(bothStarted, undefined);
                  yield* Deferred.await(release);
                }
                return `<t3_task_graph>${yield* encodeJsonFixture({
                  summary: "Plan",
                  nextAction: "Execute",
                  nodes: [
                    {
                      id: "research",
                      kind: "research",
                      participantId: "supervisor",
                      title: "Research",
                      task: "Investigate",
                      goal: "Verify",
                      context: "Task",
                      input: "Request",
                      constraints: [],
                      expectedOutput: "Evidence",
                      successCriteria: ["Evidence provided"],
                      dependsOn: [],
                      priority: 1,
                    },
                  ],
                }).pipe(Effect.orDie)}</t3_task_graph>`;
              }
              if (input.prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다"))
                return '<t3_persistent_verdict>{"decision":"complete","summary":"검증 완료"}</t3_persistent_verdict>';
              if (input.prompt.includes("Return one strict receipt between <t3_validation>"))
                return '<t3_validation>{"verdict":"pass","confidence":"high","summary":"검증 완료","evidence":["근거 확인"],"failureClassification":null,"nextAction":"종합","followUpNodes":[]}</t3_validation>';
              if (input.prompt.includes("Return one strict payload between <t3_synthesis>"))
                return '<t3_synthesis>{"finalOutput":"결과","confidence":"high","conflictDetected":false,"nextAction":"완료","repairApproved":null,"memoryCandidates":[]}</t3_synthesis>';
              return "Evidence obtained.";
            }),
        });
        const stubs = Layer.mergeAll(
          fake,
          OrchestrationTurnWaitLive,
          Layer.mock(ProviderInstanceRegistry)({
            getInstance: (instanceId) =>
              Effect.succeed({
                instanceId,
                driverKind: "codex",
                enabled: true,
                snapshot: { getSnapshot: Effect.succeed({}) },
              } as never),
            listInstances: Effect.succeed([]),
          }),
          Layer.mock(WorktreeProvisionService)({
            runSetupGate: () => Effect.succeed({ status: "ok" }),
          }),
          Layer.mock(GitWorkflowService)({}),
          Layer.mock(WorkspaceDevelopmentGit)({
            inspect: () =>
              Effect.succeed({
                sha: "base",
                branch: "main",
                commonDirectory: "repo",
                clean: true,
                fingerprint: "current",
              }),
            verify: (_cwd, commands) =>
              Effect.succeed({
                passed: true,
                artifacts: [],
                commands: commands.map((command) => ({
                  ...command,
                  exitCode: 0,
                  timedOut: false,
                  logPath: "simulated.log",
                })),
              }),
          }),
          Layer.mock(WorkspaceWorktreeCleanup)({
            cleanupRunWorktrees: () => Effect.void,
            sweepOrphans: () => Effect.void,
          }),
        );
        const reactor = yield* makeWorkspaceCollaborationReactor.pipe(Effect.provide(stubs));
        yield* reactor.start();
        yield* Deferred.await(bothStarted);
        yield* engine.dispatch({
          type: "project.collaboration.run.cancel",
          commandId: CommandId.make("actor-first-stop"),
          projectId,
          runId: first.id,
          createdAt: now,
        });
        yield* Deferred.succeed(release, undefined);
        yield* reactor.drain;
        expect((yield* api.getRun({ projectId, runId: first.id })).status).toBe("cancelled");
        const completed = yield* api.getRun({ projectId, runId: second.id });
        expect(completed.status).toBe("completed");
        expect(completed.finalOutput).toBe("검증 완료");
        expect(completed.graph?.delivery?.status).toBe("passed");
        const sql = yield* SqlClient.SqlClient;
        const notes = yield* sql<{ folder: string; text: string }>`SELECT
        json_extract(source_json,'$.folder') AS folder,text FROM workspace_memory_v2
        WHERE project_id=${projectId} AND origin='assistant' AND status='observed'`;
        expect(notes.some((note) => note.folder === "" && note.text.includes("검증 완료"))).toBe(
          true,
        );
        const freshCompleted = yield* api.getRun({ projectId, runId: fresh.id });
        expect(freshCompleted.status).toBe("completed");
        expect(freshCompleted.meeting?.threadId).toBeTruthy();
        expect(
          notes.some((note) => note.folder === "apps/web" && note.text.includes("NEBULAREACTOR")),
        ).toBe(true);
        const memory = yield* WorkspaceMemory;
        const search = yield* memory.invoke(
          { projectId, action: "search", query: "NEBULAREACTOR" },
          { threadId: freshCompleted.meeting!.threadId! },
        );
        expect(search).toContain("NEBULAREACTOR");
        const ambiguousCompleted = yield* api.getRun({ projectId, runId: ambiguous.id });
        expect(ambiguousCompleted.status).toBe("completed");
        const warnings = yield* sql<{ kind: string }>`SELECT kind FROM projection_thread_activities
          WHERE thread_id=${ambiguousCompleted.meeting!.threadId!} AND kind='workspace.memory.save-failed'`;
        expect(warnings).toHaveLength(1);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "starts an AI-planned run through the unified API with the selected model and policy",
    () =>
      Effect.gen(function* () {
        const { projectId, engine, api } = yield* setup;
        const threadId = ThreadId.make(`${projectId}:unified-chat`);
        const selected = { instanceId: ProviderInstanceId.make("codex"), model: "user-selected" };
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "Unified chat",
          modelSelection: selected,
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        const input = {
          projectId,
          task: "Build the requested feature",
          requestId: "unified-auto",
          threadId,
          roleModels: { coordinator: selected, implementer: selected, researcher: selected },
          runtimeMode: "full-access" as const,
          interactionMode: "plan" as const,
          requestMode: "ask-first" as const,
        };
        const run = yield* api.start(input);
        expect(run.workflow).toBeNull();
        expect(run.runContext?.threadId).toBe(threadId);
        expect(run.runContext?.requestMode).toBe("ask-first");
        expect(
          run.runContext?.roleBindings
            ?.filter((role) => role.enabled)
            .map((role) => ({
              model: role.modelSelection.model,
              runtimeMode: role.runtimeMode,
              interactionMode: role.interactionMode,
            })),
        ).toEqual([
          { model: "user-selected", runtimeMode: "full-access", interactionMode: "plan" },
          { model: "user-selected", runtimeMode: "full-access", interactionMode: "plan" },
          { model: "user-selected", runtimeMode: "full-access", interactionMode: "plan" },
        ]);
        expect((yield* api.start(input)).id).toBe(run.id);
        expect(
          Exit.isFailure(yield* Effect.exit(api.start({ ...input, task: "Different task" }))),
        ).toBe(true);
        const overview = yield* api.overview({ projectId });
        expect(overview.allRuns?.find((item) => item.id === run.id)).toMatchObject({
          title: input.task,
          workflowRevision: null,
          control: "active",
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              api.start({
                ...input,
                requestId: "needs-confirmation",
                requestMode: "conditions",
                conditionsConfirmed: false,
              }),
            ),
          ),
        ).toBe(true);
      }),
  );
  it.effect(
    "uses the same run controls for an AI-planned task and preserves a newer pause against stale updates",
    () =>
      Effect.gen(function* () {
        const { projectId, engine, api, selectedThreadId } = yield* setup;
        const runId = WorkspaceCollaborationRunId.make(`${projectId}:ai-task`);
        yield* engine.dispatch({
          type: "project.collaboration.run.request",
          commandId: CommandId.make(`${runId}:start`),
          projectId,
          runId,
          task: "Plan and implement the task",
          runContext: { threadId: selectedThreadId, requestDigest: "control-fixture" },
          createdAt: now,
        });
        const initial = yield* api.getRun({ projectId, runId });
        expect(initial.workflow).toBeNull();
        expect(initial.runControl).toMatchObject({ control: "active", controlRevision: 0 });
        const paused = yield* api.control({
          projectId,
          runId,
          expectedRevision: 0,
          action: "pause",
        });
        expect(paused.runControl).toMatchObject({ control: "pause-requested", controlRevision: 1 });
        yield* engine.dispatch({
          type: "project.collaboration.run.update",
          commandId: CommandId.make(`${runId}:late-update`),
          run: { ...initial, status: "running" },
        });
        expect((yield* api.getRun({ projectId, runId })).runControl).toMatchObject({
          control: "pause-requested",
          controlRevision: 1,
        });
        const resumed = yield* api.control({
          projectId,
          runId,
          expectedRevision: 1,
          action: "resume",
        });
        expect(resumed.runControl).toMatchObject({ control: "active", controlRevision: 2 });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              api.control({ projectId, runId, expectedRevision: 1, action: "pause" }),
            ),
          ),
        ).toBe(true);
      }),
  );
  it.effect("requires confirmed delivery evidence before retrying an AI-planned step", () =>
    Effect.gen(function* () {
      const { projectId, engine, api, saved, selectedThreadId, secondThreadId } = yield* setup;
      const selected = { instanceId: ProviderInstanceId.make("codex"), model: "selected" };
      const planned = yield* api.start({
        projectId,
        threadId: selectedThreadId,
        task: "AI planned",
        requestId: "retry-auto",
        roleModels: { coordinator: selected, implementer: selected, researcher: selected },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const savedRun = yield* api.start({
        projectId,
        threadId: secondThreadId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "fixture" },
        requestId: "retry-template",
      });
      const graph = compileWorkflowRun(savedRun);
      const failed = {
        ...planned,
        status: "failed" as const,
        graph: {
          ...graph,
          status: "failed" as const,
          nodes: graph.nodes.map((node) =>
            node.id === "analyze"
              ? { ...node, status: "failed" as const, error: "fixture", completedAt: now }
              : node,
          ),
        },
      };
      yield* engine.dispatch({
        type: "project.collaboration.run.update",
        commandId: CommandId.make(`${planned.id}:failed`),
        run: failed,
      });
      const retry = {
        projectId,
        runId: planned.id,
        expectedRevision: 0,
        action: "retry" as const,
        nodeId: "analyze",
      };
      expect(Exit.isFailure(yield* Effect.exit(api.control(retry)))).toBe(true);
      const delivery = {
        projectId,
        runId: planned.id,
        nodeId: "analyze",
        executionId: `${planned.id}:analyze:1`,
        createdAt: now,
      };
      yield* engine.dispatch({
        type: "project.workflow.delivery",
        commandId: CommandId.make(`${planned.id}:intent`),
        ...delivery,
        phase: "submitting",
        confirmed: false,
      });
      expect(Exit.isFailure(yield* Effect.exit(api.control(retry)))).toBe(true);
      yield* engine.dispatch({
        type: "project.workflow.delivery",
        commandId: CommandId.make(`${planned.id}:stopped`),
        ...delivery,
        phase: "stopped",
        confirmed: true,
      });
      const retried = yield* api.control(retry);
      expect(retried.runControl?.executionRevision).toBe(1);
      expect(retried.graph?.nodes.find((node) => node.id === "analyze")?.status).toBe("queued");
      yield* engine.dispatch({
        type: "project.collaboration.run.update",
        commandId: CommandId.make(`${planned.id}:late-failure`),
        run: failed,
      });
      expect((yield* api.getRun({ projectId, runId: planned.id })).status).toBe("running");
    }),
  );
  it.effect("pins selected role models and an existing chat without changing project roles", () =>
    Effect.gen(function* () {
      const { projectId, api, saved, engine } = yield* setup;
      const threadId = ThreadId.make(`${projectId}:chat`);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${projectId}:chat`),
        threadId,
        projectId,
        title: "Existing chat",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "chat-model" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "project.agent-role.upsert",
        commandId: CommandId.make(`${projectId}:disable-coordinator`),
        projectId,
        role: "coordinator",
        displayName: "Fable",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "old-model" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        instructions: "Keep project instructions",
        enabled: false,
        createdAt: now,
      });
      const models = {
        coordinator: { instanceId: ProviderInstanceId.make("codex"), model: "lead" },
        implementer: { instanceId: ProviderInstanceId.make("codex"), model: "build" },
        researcher: { instanceId: ProviderInstanceId.make("codex"), model: "research" },
      };
      const input = {
        projectId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "model fixture" },
        requestId: "role-models",
        threadId,
        roleModels: models,
        runtimeMode: "auto-accept-edits" as const,
        interactionMode: "default" as const,
      };
      const run = yield* api.start(input);
      expect(run.workflow?.threadId).toBe(threadId);
      for (const role of ["coordinator", "implementer", "researcher"] as const) {
        expect(run.workflow?.roleBindings.find((entry) => entry.role === role)).toMatchObject({
          enabled: true,
          displayName: models[role].model,
          modelSelection: models[role],
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
        });
      }
      expect(compileWorkflowRun(run).nodes.some((node) => node.kind === "validation")).toBe(true);
      expect((yield* api.start(input)).id).toBe(run.id);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            api.start({ ...input, roleModels: { ...models, coordinator: models.implementer } }),
          ),
        ),
      ).toBe(true);
      const query = yield* ProjectionSnapshotQuery;
      const savedRoles = yield* query.listWorkspaceAgentRoles!({ projectId });
      expect(savedRoles.roles.find((entry) => entry.role === "coordinator")).toMatchObject({
        enabled: false,
        displayName: "Fable",
        modelSelection: { model: "old-model" },
        instructions: "Keep project instructions",
      });
      const same = {
        coordinator: models.coordinator,
        implementer: models.coordinator,
        researcher: models.coordinator,
      };
      const singleRun = yield* api.start({ ...input, roleModels: same, requestId: "single-model" });
      expect(
        singleRun.workflow?.roleBindings
          .filter((role) => role.enabled)
          .map((role) => role.modelSelection.model),
      ).toEqual(["lead", "lead", "lead"]);
      for (const node of compileWorkflowRun(singleRun).nodes) {
        expect(
          resolveNodeAssignmentRoute({
            node,
            meeting: singleRun.meeting,
            bindings: singleRun.workflow!.roleBindings,
          })?.modelSelection,
        ).toEqual(models.coordinator);
      }
    }),
  );
  it.effect("rejects an execution thread from a different project", () =>
    Effect.gen(function* () {
      const { projectId, api, saved, engine } = yield* setup;
      const foreign = yield* setup;
      const threadId = ThreadId.make(`${foreign.projectId}:chat`);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${foreign.projectId}:thread`),
        threadId,
        projectId: foreign.projectId,
        title: "Foreign chat",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            api.start({
              projectId,
              definitionId: saved.id,
              revision: saved.revision,
              values: { goal: "fixture" },
              requestId: "foreign-chat",
              threadId,
            }),
          ),
        ),
      ).toBe(true);
    }),
  );
  it.effect("keeps saved workflow execution inside the selected meeting roster", () =>
    Effect.gen(function* () {
      const { projectId, api, saved, engine } = yield* setup;
      const participants = ["first", "second"].map((id) => ({
        id: WorkspaceMeetingParticipantId.make(id),
        displayName: id,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: `${id}-meeting` },
      }));
      const threadId = ThreadId.make(`${projectId}:selected-meeting`);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: "Selected meeting",
        modelSelection: participants[0]!.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      const chosen = { instanceId: ProviderInstanceId.make("codex"), model: "workflow-model" };
      const input = {
        projectId,
        threadId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "meeting workflow" },
        requestId: "meeting-role-models",
        meeting: {
          mode: "fixed-rounds" as const,
          participants,
          chairParticipantId: participants[0]!.id,
          maxRounds: 0,
          userInLoop: false,
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
        },
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
      };
      const roleModels = { coordinator: chosen, implementer: chosen, researcher: chosen };
      expect(Exit.isFailure(yield* Effect.exit(api.start({ ...input, roleModels })))).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            api.start({
              projectId,
              requestId: "mixed-dynamic",
              task: "task",
              meeting: input.meeting,
              roleModels,
            }),
          ),
        ),
      ).toBe(true);
      const run = yield* api.start(input);
      expect(run.meeting?.participants).toEqual(participants);
      const graph = compileWorkflowRun(run);
      expect(graph.nodes.filter((node) => node.id !== "plan").length).toBeGreaterThan(0);
      expect(
        graph.nodes
          .filter((node) => node.id !== "plan")
          .every((node) => node.participantId === participants[0]!.id),
      ).toBe(true);
      const originalNodes = run.workflow!.definition.nodes;
      const pinned = {
        ...run,
        workflow: {
          ...run.workflow!,
          definition: {
            ...run.workflow!.definition,
            nodes: originalNodes.map((node, index) =>
              index === 0 ? { ...node, participantId: String(participants[0]!.id) } : node,
            ),
          },
        },
      };
      const unassigned = pinned.workflow.definition.nodes.filter(
        (node) => node.participantId === null,
      );
      expect(workflowNeedsAssignment(pinned)).toBe(unassigned.length > 0);
      const encoded = (entries: Array<{ nodeId: string; participantId: string }>) =>
        `<t3_workflow_assignments>${JSON.stringify({ assignments: entries })}</t3_workflow_assignments>`;
      const valid = unassigned.map((node) => ({
        nodeId: node.id,
        participantId: String(participants[1]!.id),
      }));
      const choices = parseWorkflowAssignments(pinned, encoded(valid));
      const allocated = compileWorkflowRun(pinned, choices);
      expect(allocated.nodes.find((node) => node.id === originalNodes[0]!.id)?.participantId).toBe(
        participants[0]!.id,
      );
      for (const node of unassigned)
        expect(allocated.nodes.find((entry) => entry.id === node.id)?.participantId).toBe(
          participants[1]!.id,
        );
      expect(() =>
        parseWorkflowAssignments(
          pinned,
          encoded([{ nodeId: originalNodes[0]!.id, participantId: String(participants[1]!.id) }]),
        ),
      ).toThrow();
      if (valid.length > 0) {
        expect(() => compileWorkflowRun(pinned, new Map())).toThrow(
          "미지정 단계와 일치하지 않습니다",
        );
        expect(() =>
          compileWorkflowRun(
            pinned,
            new Map([...choices, [originalNodes[0]!.id, participants[1]!.id]]),
          ),
        ).toThrow("미지정 단계와 일치하지 않습니다");
        expect(() => parseWorkflowAssignments(pinned, encoded([]))).toThrow();
        expect(() => parseWorkflowAssignments(pinned, encoded([...valid, valid[0]!]))).toThrow();
        expect(() =>
          parseWorkflowAssignments(
            pinned,
            encoded(valid.map((entry) => ({ ...entry, participantId: "outside" }))),
          ),
        ).toThrow();
      }
      expect(() =>
        compileWorkflowRun({
          ...run,
          workflow: {
            ...run.workflow!,
            definition: {
              ...run.workflow!.definition,
              nodes: run.workflow!.definition.nodes.map((node) => ({
                ...node,
                participantId: "not-in-roster",
              })),
            },
          },
        }),
      ).toThrow("must use a selected meeting participant");
    }),
  );
  it.effect("keeps the chosen roster and profile while applying the chat policy", () =>
    Effect.gen(function* () {
      const { projectId, api, saved, engine } = yield* setup;
      const participants = ["seat-a", "seat-b"].map((id) => ({
        id: WorkspaceMeetingParticipantId.make(id),
        displayName: id,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "fixture-model",
          options: [{ id: "effort", value: "high" }],
        },
      }));
      const profile = {
        id: "chosen-profile",
        name: "Chosen profile",
        revision: 3,
        instructions: "Keep profile instructions",
        verificationCommands: [],
        meeting: {
          mode: "fixed-rounds" as const,
          participants,
          chairParticipantId: participants[0]!.id,
          threadId: ThreadId.make("stale-profile-thread"),
          maxRounds: 0,
          userInLoop: true,
          allowAdditionalWorkers: true,
          runtimeMode: "auto-accept-edits" as const,
          interactionMode: "default" as const,
        },
        orchestra: { maxParallel: 6, isolateWorktrees: false },
      };
      const outsider = { instanceId: ProviderInstanceId.make("codex"), model: "outside-roster" };
      const noThreadSaved = yield* api
        .start({
          projectId,
          definitionId: saved.id,
          revision: saved.revision,
          values: { goal: "profile without selected conversation" },
          requestId: "profile-without-chat",
          executionProfile: profile,
        })
        .pipe(Effect.flip);
      expect(noThreadSaved.message).toContain("대화를 선택");
      const noThreadDirect = yield* api
        .start({
          projectId,
          task: "profile without selected conversation",
          requestId: "profile-direct-without-chat",
          executionProfile: profile,
        })
        .pipe(Effect.flip);
      expect(noThreadDirect.message).toContain("대화를 선택");
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            api.start({
              projectId,
              task: "profile mixed roles",
              requestId: "profile-mixed-roles",
              executionProfile: profile,
              roleModels: { coordinator: outsider, implementer: outsider, researcher: outsider },
            }),
          ),
        ),
      ).toBe(true);
      const selectedProfileThreads = ["saved", "direct"].map((name) =>
        ThreadId.make(`${projectId}:selected-profile-${name}`),
      );
      for (const threadId of selectedProfileThreads) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "Selected profile chat",
          modelSelection: participants[0]!.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
      }
      const run = yield* api.start({
        projectId,
        threadId: selectedProfileThreads[0]!,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "profile fixture" },
        requestId: "chat-roster",
        executionProfile: profile,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      expect(run.meeting?.participants).toEqual(participants);
      expect(run.meeting?.threadId).toBe(selectedProfileThreads[0]);
      expect(run.meeting?.threadId).not.toBe(profile.meeting.threadId);
      expect(run.workflow?.threadId).toBe(run.meeting?.threadId);
      expect(run.meeting?.allowAdditionalWorkers).toBe(true);
      expect(run.meeting?.runtimeMode).toBe("full-access");
      expect(run.meeting?.interactionMode).toBe("default");
      expect(run.orchestra?.maxParallel).toBe(6);
      const auto = yield* api.start({
        projectId,
        threadId: selectedProfileThreads[1]!,
        task: "profile auto task",
        requestId: "profile-auto",
        executionProfile: profile,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      expect(auto.meeting?.participants).toEqual(participants);
      expect(auto.meeting?.threadId).toBe(selectedProfileThreads[1]);
      expect(auto.meeting?.threadId).not.toBe(profile.meeting.threadId);
      expect(auto.runContext?.threadId).toBe(auto.meeting?.threadId);
      expect(auto.meeting?.allowAdditionalWorkers).toBe(true);
      expect(auto.meeting?.runtimeMode).toBe("full-access");
      expect(auto.runContext?.roleBindings).toBeUndefined();
      const profileThreads = ["planned", "auto"].map((name) =>
        ThreadId.make(`${projectId}:profile-${name}`),
      );
      for (const [index, threadId] of profileThreads.entries()) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "Profile chat",
          modelSelection: participants[0]!.modelSelection,
          runtimeMode: index === 0 ? "approval-required" : "full-access",
          interactionMode: index === 0 ? "plan" : "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
      }
      const plannedInChat = yield* api.start({
        projectId,
        threadId: profileThreads[0]!,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "profile chat" },
        requestId: "profile-planned-in-chat",
        executionProfile: profile,
        requestMode: "ask-first",
      });
      const autoInChat = yield* api.start({
        projectId,
        threadId: profileThreads[1]!,
        task: "profile task in chat",
        requestId: "profile-auto-in-chat",
        executionProfile: profile,
      });
      expect(plannedInChat.meeting?.threadId).toBe(profileThreads[0]);
      expect(autoInChat.meeting?.threadId).toBe(profileThreads[1]);
      expect(plannedInChat.meeting?.runtimeMode).toBe("approval-required");
      expect(plannedInChat.meeting?.interactionMode).toBe("plan");
      expect(plannedInChat.meeting?.phase).toBe("clarifying");
      expect(autoInChat.meeting?.runtimeMode).toBe("full-access");
      expect(autoInChat.meeting?.interactionMode).toBe("default");
      expect(plannedInChat.meeting?.participants[0]?.modelSelection).toEqual(
        participants[0]!.modelSelection,
      );
      const query = yield* ProjectionSnapshotQuery;
      const selectedThread = yield* query.getThreadRuntimeContext(profileThreads[0]!);
      expect(selectedThread._tag).toBe("Some");
      if (selectedThread._tag === "Some")
        expect(selectedThread.value).toMatchObject({
          modelSelection: participants[0]!.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
      const competing = yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("profile-chat-competing"),
          threadId: profileThreads[1]!,
          message: {
            messageId: MessageId.make("profile-chat-competing"),
            role: "user",
            text: "ordinary",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        })
        .pipe(Effect.flip);
      expect(competing.message).toContain("통합 작업이 진행 중입니다");
    }),
  );
  it.effect("keeps chat permissions without changing role accounts or project defaults", () =>
    Effect.gen(function* () {
      const { projectId, api, saved, selectedThreadId, secondThreadId } = yield* setup;
      const input = {
        projectId,
        threadId: selectedThreadId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "chat workflow" },
        requestId: "chat-policy",
        runtimeMode: "auto-accept-edits" as const,
        interactionMode: "default" as const,
        requestMode: "ask-first" as const,
      };
      const run = yield* api.start(input);
      expect(run.workflow?.roleBindings).toHaveLength(3);
      for (const role of run.workflow!.roleBindings) {
        expect(role.runtimeMode).toBe("auto-accept-edits");
        expect(role.interactionMode).toBe("default");
        expect(role.modelSelection).toEqual({ instanceId: "codex", model: "fixture-model" });
        expect(role.instructions).toBe("Keep user conditions");
      }
      expect((yield* api.start(input)).id).toBe(run.id);
      expect(
        Exit.isFailure(yield* Effect.exit(api.start({ ...input, runtimeMode: "full-access" }))),
      ).toBe(true);
      const inherited = yield* api.start({
        projectId,
        threadId: secondThreadId,
        definitionId: saved.id,
        revision: saved.revision,
        values: input.values,
        requestId: "project-policy-still-preserved",
      });
      expect(
        inherited.workflow?.roleBindings.every(
          (role) => role.runtimeMode === "approval-required" && role.interactionMode === "plan",
        ),
      ).toBe(true);
    }),
  );
  it.effect("finds a pinned skill in an older version without trusting a new snapshot path", () =>
    Effect.gen(function* () {
      const { projectId, saved, engine } = yield* setup;
      const store = yield* WorkspaceWorkflowStore;
      const binding = {
        name: "fixture",
        path: "/original/SKILL.md",
        provider: "codex" as const,
        digest: "a".repeat(64),
        arguments: "old",
        mode: "native" as const,
        snapshotPath: "/cache/digest/source/SKILL.md",
      };
      const oldVersion = {
        ...saved,
        revision: 2,
        digest: "b".repeat(64),
        nodes: saved.nodes.map((node, index) =>
          index === 0 ? { ...node, skills: [binding] } : node,
        ),
      };
      yield* engine.dispatch({
        type: "project.workflow.save",
        commandId: CommandId.make(`${projectId}:skill-v2`),
        projectId,
        definition: oldVersion,
        expectedRevision: 1,
      });
      yield* engine.dispatch({
        type: "project.workflow.save",
        commandId: CommandId.make(`${projectId}:skill-v3`),
        projectId,
        definition: { ...saved, revision: 3, digest: "c".repeat(64) },
        expectedRevision: 2,
      });
      expect((yield* store.get(projectId, saved.id))?.nodes[0]?.skills).toHaveLength(0);
      expect(
        yield* store.retainedBinding(projectId, saved.id, { ...binding, arguments: "new" }),
      ).toEqual(binding);
      expect(
        yield* store.retainedBinding(projectId, saved.id, {
          ...binding,
          snapshotPath: "/untrusted/SKILL.md",
        }),
      ).toBeNull();
      expect(yield* store.retainedBinding(projectId, "another-workflow", binding)).toBeNull();
      expect(
        yield* store.retainedBinding(ProjectId.make("another-project"), saved.id, binding),
      ).toBeNull();
    }),
  );
  it.effect(
    "rejects unknown retry, preserves completed nodes and fences late results after retry",
    () =>
      Effect.gen(function* () {
        const { projectId, api, saved, engine, selectedThreadId } = yield* setup;
        const run = yield* api.start({
          projectId,
          threadId: selectedThreadId,
          definitionId: saved.id,
          revision: 1,
          values: { goal: "retry fixture" },
          requestId: "retry-generation",
        });
        const graph = compileWorkflowRun(run);
        const failed: typeof run = {
          ...run,
          status: "failed",
          graph: {
            ...graph,
            status: "failed",
            nodes: graph.nodes.map((node) =>
              node.status === "completed"
                ? node
                : { ...node, status: "failed", error: "fixture", completedAt: now },
            ),
          },
        };
        yield* engine.dispatch({
          type: "project.collaboration.run.update",
          commandId: CommandId.make(`${run.id}:failed`),
          run: failed,
        });
        const delivery = {
          projectId,
          runId: run.id,
          nodeId: "analyze",
          executionId: `${run.id}:analyze:1`,
          createdAt: now,
        };
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${run.id}:intent`),
          ...delivery,
          phase: "submitting",
          confirmed: false,
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              api.control({
                projectId,
                runId: run.id,
                expectedRevision: 0,
                action: "retry",
                nodeId: "analyze",
              }),
            ),
          ),
        ).toBe(true);
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${run.id}:stopped`),
          ...delivery,
          phase: "stopped",
          confirmed: true,
        });
        const retried = yield* api.control({
          projectId,
          runId: run.id,
          expectedRevision: 0,
          action: "retry",
          nodeId: "analyze",
        });
        expect(retried.workflow?.executionRevision).toBe(1);
        expect(retried.graph?.nodes.find((node) => node.id === "plan")?.output).toBe(
          graph.nodes.find((node) => node.id === "plan")?.output,
        );
        expect(retried.graph?.nodes.find((node) => node.id === "analyze")?.status).toBe("queued");
        expect(retried.graph?.nodes.find((node) => node.id === "execute")?.status).toBe("blocked");
        yield* engine.dispatch({
          type: "project.collaboration.run.update",
          commandId: CommandId.make(`${run.id}:late-result`),
          run: failed,
        });
        const current = yield* api.getRun({ projectId, runId: run.id });
        expect(current.status).toBe("running");
        expect(current.workflow?.executionRevision).toBe(1);
        const summary = (yield* api.overview({ projectId })).runs[0]!;
        expect(summary.status).toBe("running");
        expect(summary.counts.completed).toBe(1);
        expect("graph" in summary).toBe(false);
      }),
  );
  it.effect(
    "stores immutable versions in the existing event stream and rejects concurrent stale saves",
    () =>
      Effect.gen(function* () {
        const { projectId, api, saved } = yield* setup;
        const events = yield* OrchestrationEventStore;
        const store = yield* WorkspaceWorkflowStore;
        const next = yield* api.save({
          projectId,
          definition: { ...saved, title: "Updated" },
          expectedRevision: 1,
          archived: false,
        });
        expect(next.revision).toBe(2);
        expect((yield* store.get(projectId, saved.id, 1))?.title).toBe(saved.title);
        const stale = yield* Effect.exit(
          api.save({ projectId, definition: saved, expectedRevision: 1, archived: false }),
        );
        expect(Exit.isFailure(stale)).toBe(true);
        const rows = yield* Stream.runCollect(events.readAll());
        expect(
          Array.from(rows).filter(
            (event) => event.aggregateId === projectId && event.type === "project.workflow-saved",
          ),
        ).toHaveLength(2);
      }),
  );

  it.effect("deduplicates starts, rejects changed duplicate input and pins role permissions", () =>
    Effect.gen(function* () {
      const { projectId, api, saved } = yield* setup;
      const input = {
        projectId,
        definitionId: saved.id,
        revision: saved.revision,
        values: { goal: "fixture goal" },
        requestId: "same-start",
        requestMode: "ask-first" as const,
      };
      const first = yield* api.start(input);
      expect(first.workflow?.requestDigest).toBe(
        "4ffa5a2dcfe9d3a9deba91800b110378ea4dc16951da5b46a026a5569486a765",
      );
      const repeated = yield* api.start(input);
      expect(repeated.id).toBe(first.id);
      expect((yield* api.overview({ projectId })).runs).toHaveLength(1);
      expect(
        first.workflow?.roleBindings.every(
          (role) => role.runtimeMode === "approval-required" && role.interactionMode === "plan",
        ),
      ).toBe(true);
      expect(first.workflow?.requestMode).toBe("ask-first");
      expect(
        Exit.isFailure(yield* Effect.exit(api.start({ ...input, values: { goal: "different" } }))),
      ).toBe(true);
      const graph = compileWorkflowRun(first);
      expect(
        graph.nodes.some(
          (node) => node.id === "analyze" && node.handoff.task.includes("fixture goal"),
        ),
      ).toBe(true);
      expect(graph.nodes.some((node) => node.kind === "validation")).toBe(true);
      expect(graph.nodes.some((node) => node.kind === "synthesis")).toBe(true);
    }),
  );

  it.effect("preserves pause and resume revisions and rejects stale controls", () =>
    Effect.gen(function* () {
      const { projectId, api, saved, selectedThreadId } = yield* setup;
      const run = yield* api.start({
        projectId,
        threadId: selectedThreadId,
        definitionId: saved.id,
        revision: 1,
        values: { goal: "pause fixture" },
        requestId: "pause-start",
      });
      const paused = yield* api.control({
        projectId,
        runId: run.id,
        expectedRevision: 0,
        action: "pause",
      });
      expect(paused.workflow?.control).toBe("pause-requested");
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            api.control({ projectId, runId: run.id, expectedRevision: 0, action: "resume" }),
          ),
        ),
      ).toBe(true);
      const resumed = yield* api.control({
        projectId,
        runId: run.id,
        expectedRevision: 1,
        action: "resume",
      });
      expect(resumed.workflow?.control).toBe("active");
      expect(resumed.workflow?.controlRevision).toBe(2);
      const cancelled = yield* api.control({
        projectId,
        runId: run.id,
        expectedRevision: 2,
        action: "cancel",
      });
      expect(cancelled.status).toBe("cancel-requested");
    }),
  );

  it.effect("retains archived versions and requires the selected condition confirmation", () =>
    Effect.gen(function* () {
      const { projectId, api, saved, selectedThreadId } = yield* setup;
      const input = {
        projectId,
        threadId: selectedThreadId,
        definitionId: saved.id,
        revision: 1,
        values: { goal: "fixture" },
        requestId: "conditions-start",
        requestMode: "conditions" as const,
      };
      expect(Exit.isFailure(yield* Effect.exit(api.start(input)))).toBe(true);
      const run = yield* api.start({ ...input, conditionsConfirmed: true });
      expect(run.workflow?.requestMode).toBe("conditions");
      yield* api.save({ projectId, definition: saved, expectedRevision: 1, archived: true });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            api.start({ ...input, requestId: "archived", conditionsConfirmed: true }),
          ),
        ),
      ).toBe(true);
      expect(run.workflow?.definition.revision).toBe(1);
    }),
  );

  it.effect(
    "records submission intent before delivery and keeps unknown attempts unsafe for retry",
    () =>
      Effect.gen(function* () {
        const { projectId, api, saved, engine, selectedThreadId } = yield* setup;
        const run = yield* api.start({
          projectId,
          threadId: selectedThreadId,
          definitionId: saved.id,
          revision: 1,
          values: { goal: "delivery fixture" },
          requestId: "delivery-start",
        });
        const store = yield* WorkspaceWorkflowStore;
        const executionId = `${run.id}:analyze:1`;
        const base = { projectId, runId: run.id, nodeId: "analyze", executionId, createdAt: now };
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${executionId}:intent`),
          ...base,
          phase: "submitting",
          confirmed: false,
        });
        expect(yield* store.retrySafe(run.id, "analyze")).toBe(false);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              engine.dispatch({
                type: "project.workflow.delivery",
                commandId: CommandId.make(`${executionId}:duplicate`),
                ...base,
                phase: "submitting",
                confirmed: false,
              }),
            ),
          ),
        ).toBe(true);
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${executionId}:accepted`),
          ...base,
          phase: "accepted",
          confirmed: false,
        });
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${executionId}:unknown-stop`),
          ...base,
          phase: "stopped",
          confirmed: false,
        });
        expect(yield* store.retrySafe(run.id, "analyze")).toBe(false);
        yield* engine.dispatch({
          type: "project.workflow.delivery",
          commandId: CommandId.make(`${executionId}:confirmed-stop`),
          ...base,
          phase: "stopped",
          confirmed: true,
        });
        expect(yield* store.retrySafe(run.id, "analyze")).toBe(true);
      }),
  );
});
