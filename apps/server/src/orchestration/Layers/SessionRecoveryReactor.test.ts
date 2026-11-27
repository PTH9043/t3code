import {
  EventId,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkspaceCollaborationRunId,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type WorkspaceCollaborationRun,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeRecoveryDeliveryJournal } from "../recoveryDeliveryJournal.ts";

import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivity,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { SessionRecoveryReactor } from "../Services/SessionRecoveryReactor.ts";
import { orphanedBackgroundWork, SessionRecoveryReactorLive } from "./SessionRecoveryReactor.ts";

const at = "2026-08-17T00:00:00.000Z";
const projectId = ProjectId.make("workspace-r");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude-a"),
  model: "claude-fable",
};

function session(input: {
  readonly threadId: ThreadId;
  readonly status: OrchestrationSession["status"];
  readonly activeTurnId?: TurnId | null;
}): OrchestrationSession {
  return {
    threadId: input.threadId,
    status: input.status,
    providerName: "claude",
    runtimeMode: "full-access",
    activeTurnId: input.activeTurnId ?? null,
    lastError: null,
    updatedAt: at,
  } as OrchestrationSession;
}

function threadShell(input: {
  readonly id: string;
  readonly session: OrchestrationSession | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): OrchestrationThreadShell {
  return {
    id: ThreadId.make(input.id),
    projectId,
    title: input.id,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: input.session,
    latestUserMessageAt: null,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
  } as OrchestrationThreadShell;
}

function activity(input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt?: string;
  readonly sequence?: number;
}): ProjectionThreadActivity {
  return {
    activityId: EventId.make(input.id),
    threadId: input.threadId,
    turnId: null,
    tone: "info",
    kind: input.kind,
    summary: input.kind,
    payload: input.payload,
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    createdAt: input.createdAt ?? at,
  };
}

function mcpMonitorActivity(input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly server?: string;
  readonly status?: string;
  readonly resultError?: boolean;
  readonly output?: unknown;
  readonly durationMs?: number;
}): ProjectionThreadActivity {
  return activity({
    id: input.id,
    threadId: input.threadId,
    kind: "tool.completed",
    createdAt: input.createdAt,
    payload: {
      itemType: "mcp_tool_call",
      data: {
        item: {
          type: "mcpToolCall",
          server: input.server ?? "t3-claude-tools",
          tool: "Monitor",
          status: input.status ?? "completed",
          error: null,
          durationMs: input.durationMs ?? 1621,
          result: {
            isError: input.resultError ?? false,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  input.output ?? {
                    taskId: "synthetic-watch",
                    timeoutMs: 1_800_000,
                    persistent: false,
                  },
                ),
              },
            ],
          },
        },
      },
    },
  });
}

it.effect(
  "recognizes only unexpired successful Monitor candidates and suppresses explicit terminal evidence",
  () =>
    Effect.sync(() => {
      const threadId = ThreadId.make("synthetic-monitor");
      const createdAt = "2026-11-12T01:25:23.262Z";
      const now = Date.parse(createdAt) + 60_000;
      const monitor = mcpMonitorActivity({ id: "monitor", threadId, createdAt });
      const found = orphanedBackgroundWork([monitor], now);
      expect(found.mcpMonitors).toEqual([
        {
          taskId: "synthetic-watch",
          startedAt: "2026-11-12T01:25:21.641Z",
          expiresAt: "2026-11-12T01:55:21.641Z",
        },
      ]);
      expect(
        orphanedBackgroundWork([monitor], Date.parse("2026-11-12T01:55:21.641Z")).mcpMonitors,
      ).toEqual([]);
      for (const rejected of [
        mcpMonitorActivity({ id: "other", threadId, createdAt, server: "other-server" }),
        mcpMonitorActivity({ id: "failed", threadId, createdAt, status: "failed" }),
        mcpMonitorActivity({ id: "mcp-error", threadId, createdAt, resultError: true }),
        mcpMonitorActivity({
          id: "persistent",
          threadId,
          createdAt,
          output: { taskId: "synthetic-watch", timeoutMs: 0, persistent: true },
        }),
        mcpMonitorActivity({
          id: "ended",
          threadId,
          createdAt,
          output: {
            taskId: "synthetic-watch",
            timeoutMs: 60_000,
            persistent: false,
            status: "failed",
          },
        }),
        mcpMonitorActivity({
          id: "output-error",
          threadId,
          createdAt,
          output: {
            taskId: "synthetic-watch",
            timeoutMs: 60_000,
            persistent: false,
            error: "failed",
          },
        }),
        mcpMonitorActivity({
          id: "over-limit",
          threadId,
          createdAt,
          output: { taskId: "synthetic-watch", timeoutMs: 3_600_001, persistent: false },
        }),
      ])
        expect(orphanedBackgroundWork([rejected], now).mcpMonitors).toEqual([]);

      const stop = (
        status: string,
        isError: boolean,
        server = "t3-claude-tools",
        text = "stopped",
      ) =>
        activity({
          id: `stop-${status}-${isError}-${server}`,
          threadId,
          kind: "tool.completed",
          createdAt: "2026-11-12T01:26:00.000Z",
          payload: {
            itemType: "mcp_tool_call",
            data: {
              item: {
                type: "mcpToolCall",
                server,
                tool: "TaskStop",
                status,
                error: null,
                arguments: { task_id: "synthetic-watch" },
                result: { isError, content: [{ type: "text", text }] },
              },
            },
          },
        });
      expect(
        orphanedBackgroundWork([monitor, stop("failed", false)], now).mcpMonitors,
      ).toHaveLength(1);
      expect(
        orphanedBackgroundWork([monitor, stop("completed", true)], now).mcpMonitors,
      ).toHaveLength(1);
      expect(
        orphanedBackgroundWork(
          [monitor, stop("completed", false, "t3-claude-tools", '{"error":"failed"}')],
          now,
        ).mcpMonitors,
      ).toHaveLength(1);
      expect(
        orphanedBackgroundWork([monitor, stop("completed", false, "other-server")], now)
          .mcpMonitors,
      ).toHaveLength(1);
      expect(orphanedBackgroundWork([monitor, stop("completed", false)], now).mcpMonitors).toEqual(
        [],
      );
      expect(
        orphanedBackgroundWork(
          [
            monitor,
            activity({
              id: "ended-task",
              threadId,
              kind: "task.completed",
              createdAt: "2026-11-12T01:26:00.000Z",
              payload: { taskId: "synthetic-watch", status: "failed" },
            }),
          ],
          now,
        ).mcpMonitors,
      ).toEqual([]);
      expect(
        orphanedBackgroundWork(
          [
            monitor,
            activity({
              id: "updated-task",
              threadId,
              kind: "task.updated",
              createdAt: "2026-11-12T01:26:00.000Z",
              payload: { taskId: "synthetic-watch", status: "completed" },
            }),
          ],
          now,
        ).mcpMonitors,
      ).toEqual([]);
      expect(
        orphanedBackgroundWork(
          [
            monitor,
            activity({
              id: "recovered",
              threadId,
              kind: "session.recovered",
              createdAt: "2026-11-12T01:26:00.000Z",
              payload: {},
            }),
          ],
          now,
        ).mcpMonitors,
      ).toEqual([]);
    }),
);

it.effect(
  "recovers only successful future wakeups and respects later cancellation or room revocation",
  () =>
    Effect.sync(() => {
      const threadId = ThreadId.make("scheduled-room");
      const atMs = Date.parse(at);
      const wake = (id: string, input: unknown, failed = false, mcp = false) =>
        activity({
          id,
          threadId,
          kind: "tool.completed",
          createdAt: at,
          payload: mcp
            ? {
                itemType: "mcp_tool_call",
                data: {
                  item: {
                    type: "mcpToolCall",
                    server: "t3-claude-tools",
                    tool: "ScheduleWakeup",
                    status: "completed",
                    arguments: input,
                    result: { isError: failed, content: [{ type: "text", text: "OK" }] },
                  },
                },
              }
            : { data: { toolName: "ScheduleWakeup", input, result: { is_error: failed } } },
        });
      for (const mcp of [false, true]) {
        const scheduled = wake("a", { delaySeconds: 600 }, false, mcp);
        expect(orphanedBackgroundWork([scheduled], atMs).wakeupScheduledFor).not.toBeNull();
        expect(orphanedBackgroundWork([scheduled], atMs, atMs).wakeupScheduledFor).toBeNull();
        expect(orphanedBackgroundWork([scheduled], atMs + 600_000).wakeupScheduledFor).toBeNull();
        expect(
          orphanedBackgroundWork([wake("a", { delaySeconds: 600 }, true, mcp)], atMs)
            .wakeupScheduledFor,
        ).toBeNull();
        expect(
          orphanedBackgroundWork([scheduled, wake("b", { stop: true }, false, mcp)], atMs)
            .wakeupScheduledFor,
        ).toBeNull();
        expect(
          orphanedBackgroundWork([scheduled, wake("b", { stop: true }, true, mcp)], atMs)
            .wakeupScheduledFor,
        ).not.toBeNull();
      }
    }),
);

function recoveryMessage(input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly createdAt: string;
}): ProjectionThreadMessage {
  return {
    messageId: MessageId.make(input.id),
    threadId: input.threadId,
    turnId: null,
    role: "user",
    text: "[자동 복구] 서버가 재시작되면서 직전 턴이 중단되었습니다.",
    isStreaming: false,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function makeHarness(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly enabledWatches?: readonly ThreadId[];
  readonly resumableRuns?: ReadonlyArray<WorkspaceCollaborationRun>;
  readonly activities?: ReadonlyArray<ProjectionThreadActivity>;
  readonly messages?: ReadonlyArray<ProjectionThreadMessage>;
  readonly afterFirstActivityRead?: () => void;
}) {
  return Effect.gen(function* () {
    const dispatchedRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    let sequence = 0;
    const engine = {
      latestSequence: Effect.succeed(1),
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(dispatchedRef, (current) => [...current, command]).pipe(
          Effect.map(() => ({ sequence: ++sequence })),
        ),
    } as unknown as OrchestrationEngineShape;
    const query = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [],
          threads: input.threads,
          updatedAt: at,
        }),
    } as unknown as ProjectionSnapshotQueryShape;
    const repository = {
      listResumable: () => Effect.succeed(input.resumableRuns ?? []),
    } as unknown as ProjectionWorkspaceCollaborationRunRepository["Service"];
    let activityReads = 0;
    const activityRepository = {
      listByThreadIdAndKinds: ({ threadId }: { readonly threadId: ThreadId }) =>
        Effect.sync(() => {
          const result = (input.activities ?? []).filter((row) => row.threadId === threadId);
          if (++activityReads === 1) input.afterFirstActivityRead?.();
          return result;
        }),
    } as unknown as ProjectionThreadActivityRepository["Service"];

    const messageRepository = {
      listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
        Effect.succeed((input.messages ?? []).filter((row) => row.threadId === threadId)),
    } as unknown as ProjectionThreadMessageRepository["Service"];

    const layer = SessionRecoveryReactorLive.pipe(
      Layer.provideMerge(
        ServerSettingsService.layerTest({ backgroundWatchThreadIds: input.enabledWatches ?? [] }),
      ),
      Layer.provideMerge(Layer.succeed(ProjectionThreadMessageRepository, messageRepository)),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
      Layer.provideMerge(Layer.succeed(ProjectionWorkspaceCollaborationRunRepository, repository)),
      Layer.provideMerge(Layer.succeed(ProjectionThreadActivityRepository, activityRepository)),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );
    return { dispatchedRef, layer };
  });
}

const runSweep = <LayerError>(harness: {
  readonly layer: Layer.Layer<SessionRecoveryReactor, LayerError>;
}) =>
  Effect.gen(function* () {
    const reactor = yield* Effect.service(SessionRecoveryReactor);
    yield* reactor.start();
    yield* reactor.drain;
  }).pipe(Effect.provide(harness.layer), Effect.scoped);

it.live("requests a guarded status check for an unexpired MCP Monitor in a ready session", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("synthetic-ready-mcp");
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const monitor = mcpMonitorActivity({
      id: "mcp-monitor",
      threadId,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - 60_000)),
    });
    const harness = yield* makeHarness({
      enabledWatches: [threadId],
      threads: [threadShell({ id: threadId, session: session({ threadId, status: "ready" }) })],
      activities: [monitor],
    });
    yield* runSweep(harness);
    const commands = yield* Ref.get(harness.dispatchedRef);
    expect(commands).toHaveLength(1);
    const recovery = commands[0];
    if (recovery?.type !== "thread.background-recovery.start")
      throw new Error("expected guarded recovery");
    expect(recovery.activities.map((item) => item.kind)).toEqual(["session.recovered"]);
    expect(recovery.turn.message.text).toContain("종료 여부는 기록만으로 확정할 수 없습니다");
    expect(recovery.turn.message.text).toContain(
      "확인되지 않거나 종료·실패·기한 만료된 감시는 다시 시작하지 마세요",
    );
    expect(recovery.turn.message.text).toContain("synthetic-watch");
  }),
);

it.effect(
  "recovers only identified watches in opted-in rooms and preserves an independent foreground turn",
  () =>
    Effect.gen(function* () {
      const opted = ThreadId.make("opted-in");
      const off = ThreadId.make("off");
      const shellOnly = ThreadId.make("shell-only");
      const foreground = ThreadId.make("foreground");
      const threads = [opted, off, shellOnly, foreground].map((id) =>
        threadShell({
          id,
          session: session({
            threadId: id,
            status: id === foreground ? "running" : "ready",
            activeTurnId: id === foreground ? TurnId.make("ordinary") : null,
          }),
        }),
      );
      const activities = threads.flatMap(({ id }) => [
        ...["shell-a", "shell-b"].map((taskId) =>
          activity({
            id: id + taskId,
            threadId: id,
            kind: "task.started",
            createdAt: "2026-11-12T01:20:47.116Z",
            payload: { taskId, taskType: "local_bash", agentKind: "background", title: "monitor" },
          }),
        ),
        ...(id === shellOnly
          ? []
          : [
              activity({
                id: id + "-watch",
                threadId: id,
                kind: "task.started",
                payload: {
                  taskId: "identified-watch",
                  taskType: "monitor",
                  agentKind: "background",
                },
              }),
            ]),
      ]);
      const harness = yield* makeHarness({
        threads,
        activities,
        enabledWatches: [opted, shellOnly],
      });
      yield* runSweep(harness);
      const commands = yield* Ref.get(harness.dispatchedRef);
      const recoveries = commands.filter((c) => c.type === "thread.background-recovery.start");
      expect(recoveries.map((c) => c.threadId).sort()).toEqual([foreground, opted].sort());
      expect(recoveries.find((c) => c.threadId === foreground)?.turn.message.text).not.toContain(
        "identified-watch",
      );
      expect(recoveries.find((c) => c.threadId === opted)?.turn.message.text).toContain(
        "identified-watch",
      );
      for (const c of recoveries) expect(c.turn.message.text).not.toContain("shell-");
      const generic = commands.filter(
        (c) => c.type === "thread.activity.append" && c.threadId === shellOnly,
      );
      expect(generic).toHaveLength(2);
      for (const c of generic)
        expect(c).toMatchObject({
          activity: {
            kind: "task.completed",
            payload: { status: "interrupted", outcomeUnknown: true },
          },
        });
      expect(commands.some((c) => c.type === "thread.session.stop")).toBe(false);
    }),
);

it.effect("settles the phantom session and restarts the interrupted turn", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-interrupted");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-interrupted",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-1") }),
        }),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual(["thread.background-recovery.start"]);
    const recovery = dispatched[0];
    if (recovery?.type !== "thread.background-recovery.start")
      throw new Error("expected atomic recovery");
    expect(recovery.activities).toEqual([]);
    const turnStart = recovery.turn;
    expect(turnStart.threadId).toBe(threadId);
    expect(turnStart.inputOrigin).toBe("automation");
    expect(turnStart.message.text).toContain("자동 복구");
    expect(turnStart.modelSelection).toEqual(modelSelection);
  }),
);

it.effect("only settles a session that had no turn in flight", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-idle-start");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-idle-start",
          session: session({ threadId, status: "starting", activeTurnId: null }),
        }),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual(["thread.session.stop"]);
  }),
);

it.effect("does not create a second recovery while its saved delivery is queued", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-saved-recovery");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: threadId,
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("old-turn") }),
        }),
      ],
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_events
        (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES (1, 'saved-recovery-event', 'thread', ${threadId}, 1, 'thread.turn-start-requested', ${at}, 'server',
          '{"messageId":"saved-recovery-message","inputOrigin":"automation"}', '{}')`;
      yield* makeRecoveryDeliveryJournal(sql).enqueue(
        {
          eventId: "saved-recovery-event",
          threadId,
          messageId: "saved-recovery-message",
          eventSequence: 1,
        },
        at,
      );
      const reactor = yield* Effect.service(SessionRecoveryReactor);
      yield* reactor.start();
      yield* reactor.drain;
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
    expect(yield* Ref.get(harness.dispatchedRef)).toEqual([]);
  }),
);

it.effect("does not resume an interrupted turn after the person stops the session", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-interrupted-stop-race");
    const threads = [
      threadShell({
        id: threadId,
        session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-1") }),
      }),
    ];
    const harness = yield* makeHarness({
      threads,
      afterFirstActivityRead: () => {
        threads[0] = threadShell({
          id: threadId,
          session: session({ threadId, status: "stopped" }),
        });
      },
    });
    yield* runSweep(harness);
    expect(yield* Ref.get(harness.dispatchedRef)).toEqual([]);
  }),
);

it.effect(
  "restarts the conversation to recover an interrupted background monitor after an idle turn",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-background-idle");
      const harness = yield* makeHarness({
        enabledWatches: [threadId],
        threads: [
          threadShell({
            id: threadId,
            session: session({ threadId, status: "running", activeTurnId: null }),
          }),
        ],
        activities: [
          activity({
            id: "monitor-start",
            threadId,
            kind: "task.started",
            payload: {
              taskId: "monitor-1",
              agentKind: "background",
              taskType: "monitor",
              title: "job status",
            },
            createdAt: at,
          }),
        ],
      });
      yield* runSweep(harness);
      const dispatched = yield* Ref.get(harness.dispatchedRef);
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.background-recovery.start",
      ]);
      const recovery = dispatched[0];
      if (recovery?.type !== "thread.background-recovery.start")
        throw new Error("expected atomic recovery");
      expect(recovery.activities.map((entry) => entry.kind)).toEqual([
        "task.completed",
        "session.recovered",
      ]);
      expect(recovery.turn.message.text).toContain("기존 지시와 대상 상태");
      expect(recovery.turn.message.text).toContain(`기록된 시작 ${at}`);
      expect(recovery.turn.message.text).toContain("중복 실행 없이 복구");
      expect(recovery.turn.message.text).toContain("중지된 감시는 다시 시작하지");
    }),
);

it.effect("does not restart a monitor that already completed before the server stopped", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-background-done");
    const harness = yield* makeHarness({
      enabledWatches: [threadId],
      threads: [
        threadShell({
          id: threadId,
          session: session({ threadId, status: "running", activeTurnId: null }),
        }),
      ],
      activities: [
        activity({
          id: "monitor-start",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "monitor-1",
            agentKind: "background",
            taskType: "monitor",
            title: "job status",
          },
          createdAt: "2026-08-17T00:00:01.000Z",
        }),
        activity({
          id: "monitor-done",
          threadId,
          kind: "task.completed",
          payload: { taskId: "monitor-1", status: "completed" },
          createdAt: "2026-08-17T00:00:02.000Z",
        }),
      ],
    });
    yield* runSweep(harness);
    expect((yield* Ref.get(harness.dispatchedRef)).map((command) => command.type)).toEqual([
      "thread.session.stop",
    ]);
  }),
);

it.effect("recovers a background monitor when the completed conversation session was ready", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-background-ready");
    const harness = yield* makeHarness({
      enabledWatches: [threadId],
      threads: [threadShell({ id: threadId, session: session({ threadId, status: "ready" }) })],
      activities: [
        activity({
          id: "monitor-start",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "monitor-1",
            agentKind: "background",
            taskType: "monitor",
            title: "job status",
          },
          createdAt: at,
        }),
      ],
    });
    yield* runSweep(harness);
    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual(["thread.background-recovery.start"]);
    const recovery = dispatched[0];
    if (recovery?.type !== "thread.background-recovery.start")
      throw new Error("expected atomic recovery");
    expect(recovery.turn.message.text).toContain("중복 실행 없이 복구");
  }),
);

it.effect("does not restart background work in an explicitly stopped session", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-background-stopped");
    const harness = yield* makeHarness({
      enabledWatches: [threadId],
      threads: [threadShell({ id: threadId, session: session({ threadId, status: "stopped" }) })],
      activities: [
        activity({
          id: "monitor-start",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "monitor-1",
            agentKind: "background",
            taskType: "monitor",
            title: "job status",
          },
          createdAt: at,
        }),
      ],
    });
    yield* runSweep(harness);
    expect(yield* Ref.get(harness.dispatchedRef)).toEqual([]);
  }),
);

it.effect("does not revive a ready monitor if the user stops its session during recovery", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-background-race");
    const threads = [
      threadShell({ id: threadId, session: session({ threadId, status: "ready" }) }),
    ];
    const harness = yield* makeHarness({
      enabledWatches: [threadId],
      threads,
      activities: [
        activity({
          id: "monitor-start",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "monitor-1",
            agentKind: "background",
            taskType: "monitor",
            title: "job status",
          },
          createdAt: at,
        }),
      ],
      afterFirstActivityRead: () => {
        threads[0] = threadShell({
          id: threadId,
          session: session({ threadId, status: "stopped" }),
        });
      },
    });
    yield* runSweep(harness);
    expect(yield* Ref.get(harness.dispatchedRef)).toEqual([]);
  }),
);

it.effect("does not revive a ready monitor owned by a resumable orchestra run", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-background-owned");
    const harness = yield* makeHarness({
      enabledWatches: [threadId],
      threads: [threadShell({ id: threadId, session: session({ threadId, status: "ready" }) })],
      resumableRuns: [
        {
          id: WorkspaceCollaborationRunId.make("run-owned"),
          projectId,
          meeting: { threadId },
        } as unknown as WorkspaceCollaborationRun,
      ],
      activities: [
        activity({
          id: "monitor-start",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "monitor-1",
            agentKind: "background",
            taskType: "monitor",
            title: "job status",
          },
          createdAt: at,
        }),
      ],
    });
    yield* runSweep(harness);
    expect(yield* Ref.get(harness.dispatchedRef)).toEqual([]);
  }),
);

it.effect("leaves healthy and stopped sessions alone", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-ready",
          session: session({ threadId: ThreadId.make("thread-ready"), status: "ready" }),
        }),
        threadShell({
          id: "thread-stopped",
          session: session({ threadId: ThreadId.make("thread-stopped"), status: "stopped" }),
        }),
        threadShell({ id: "thread-none", session: null }),
      ],
    });
    yield* runSweep(harness);

    expect(yield* Ref.get(harness.dispatchedRef)).toEqual([]);
  }),
);

it.effect("does not race the collaboration reactor for a resumable run's thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-meeting");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-meeting",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-m") }),
        }),
      ],
      resumableRuns: [
        {
          id: WorkspaceCollaborationRunId.make("run-m"),
          projectId,
          meeting: { threadId },
        } as unknown as WorkspaceCollaborationRun,
      ],
    });
    yield* runSweep(harness);

    // The phantom session still settles, but the collaboration reactor owns
    // restarting the work — no recovery turn here.
    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual(["thread.session.stop"]);
  }),
);

it.effect("does not inject a recovery turn into a resumable run's running attempt thread", () =>
  Effect.gen(function* () {
    const attemptThreadId = ThreadId.make("thread-graph-attempt");
    const stepThreadId = ThreadId.make("thread-legacy-step");
    const settledThreadId = ThreadId.make("thread-settled-attempt");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-graph-attempt",
          session: session({
            threadId: attemptThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-a"),
          }),
        }),
        threadShell({
          id: "thread-legacy-step",
          session: session({
            threadId: stepThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-s"),
          }),
        }),
        // A person kept chatting on a finished attempt's thread: the
        // collaboration reactor never re-drives it, so their interrupted
        // turn still gets the normal recovery restart.
        threadShell({
          id: "thread-settled-attempt",
          session: session({
            threadId: settledThreadId,
            status: "running",
            activeTurnId: TurnId.make("turn-user"),
          }),
        }),
      ],
      resumableRuns: [
        {
          id: WorkspaceCollaborationRunId.make("run-g"),
          projectId,
          meeting: null,
          graph: {
            nodes: [
              {
                attempts: [
                  { threadId: settledThreadId, status: "completed" },
                  { threadId: attemptThreadId, status: "running" },
                ],
              },
            ],
          },
          steps: [{ threadId: stepThreadId, status: "running" }],
        } as unknown as WorkspaceCollaborationRun,
      ],
    });
    yield* runSweep(harness);

    // The running attempt and step threads settle only — the collaboration
    // reactor owns resuming that work, and a recovery turn there would be
    // read back as node output. The settled attempt's thread still gets its
    // recovery turn.
    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.session.stop",
      "thread.session.stop",
      "thread.background-recovery.start",
    ]);
    const recovery = dispatched[2];
    if (recovery?.type !== "thread.background-recovery.start")
      throw new Error("expected atomic recovery");
    const turnStart = recovery.turn;
    expect(turnStart.threadId).toBe(settledThreadId);
  }),
);

it.effect(
  "does not inject a recovery turn into an orchestra node's fixed thread while it runs",
  () =>
    Effect.gen(function* () {
      const nodeThreadId = ThreadId.make("thread-orchestra-node");
      const harness = yield* makeHarness({
        threads: [
          threadShell({
            id: "thread-orchestra-node",
            session: session({
              threadId: nodeThreadId,
              status: "running",
              activeTurnId: TurnId.make("turn-n"),
            }),
          }),
        ],
        resumableRuns: [
          {
            id: WorkspaceCollaborationRunId.make("run-o"),
            projectId,
            meeting: null,
            graph: {
              nodes: [{ status: "running", threadId: nodeThreadId, attempts: [] }],
            },
            steps: [],
          } as unknown as WorkspaceCollaborationRun,
        ],
      });
      yield* runSweep(harness);

      const dispatched = yield* Ref.get(harness.dispatchedRef);
      expect(dispatched.map((command) => command.type)).toEqual(["thread.session.stop"]);
    }),
);

it.effect("closes the questions the dead session left open and tells the seat to ask again", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-asking");
    const old = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, "1 second"));
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-asking",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-1") }),
          hasPendingUserInput: true,
        }),
      ],
      activities: [
        // Answered before the restart: stays closed.
        activity({
          id: "a1",
          threadId,
          kind: "user-input.requested",
          payload: { requestId: "q-old" },
          createdAt: old,
        }),
        activity({
          id: "a2",
          threadId,
          kind: "user-input.resolved",
          payload: { requestId: "q-old" },
          createdAt: old,
        }),
        // Open when the server died: the provider no longer knows it.
        activity({
          id: "a3",
          threadId,
          kind: "user-input.requested",
          payload: { requestId: "q-open" },
          createdAt: old,
        }),
        // Already failed as stale once: nothing left to close.
        activity({
          id: "a4",
          threadId,
          kind: "user-input.requested",
          payload: { requestId: "q-stale" },
          createdAt: old,
        }),
        activity({
          id: "a5",
          threadId,
          kind: "provider.user-input.respond.failed",
          payload: { requestId: "q-stale", detail: "Stale pending user-input request: q-stale" },
          createdAt: old,
        }),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.activity.append",
      "thread.background-recovery.start",
    ]);
    const closed = dispatched[0];
    if (closed?.type !== "thread.activity.append") throw new Error("expected an activity append");
    expect(closed.activity.kind).toBe("user-input.resolved");
    expect(closed.activity.payload).toMatchObject({ requestId: "q-open", abandoned: true });
    const recovery = dispatched[1];
    if (recovery?.type !== "thread.background-recovery.start")
      throw new Error("expected atomic recovery");
    const turnStart = recovery.turn;
    expect(turnStart.message.text).toContain("같은 질문을 다시 해 주세요");
  }),
);

it.effect("keeps asynchronous question cards after a session restart", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("async-question");
    const old = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, "1 minute"));
    const harness = yield* makeHarness({
      threads: [threadShell({ id: "async-question", session: null, hasPendingUserInput: true })],
      activities: [
        activity({
          id: "async-request",
          threadId,
          kind: "user-input.requested",
          payload: { requestId: "async:question-1" },
          createdAt: old,
        }),
        activity({
          id: "text-question-request",
          threadId,
          kind: "user-input.requested",
          payload: { requestId: "text-question:question-2" },
          createdAt: old,
        }),
      ],
    });
    yield* runSweep(harness);
    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(
      dispatched.some(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "user-input.resolved",
      ),
    ).toBe(false);
  }),
);

it.effect("does not resume a turn while an EXAONE text question is awaiting an answer", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("text-question-interrupted");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: threadId,
          session: session({
            threadId,
            status: "running",
            activeTurnId: TurnId.make("active-turn"),
          }),
          hasPendingUserInput: true,
        }),
      ],
      activities: [
        activity({
          id: "text-question-open",
          threadId,
          kind: "user-input.requested",
          payload: { requestId: "text-question:active-turn" },
        }),
      ],
    });
    yield* runSweep(harness);
    const commands = yield* Ref.get(harness.dispatchedRef);
    expect(
      commands.some(
        (command) =>
          command.type === "thread.turn.start" ||
          command.type === "thread.background-recovery.start",
      ),
    ).toBe(false);
    expect(commands.some((command) => command.type === "thread.session.stop")).toBe(false);
    expect(
      commands.some(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "user-input.resolved",
      ),
    ).toBe(false);
  }),
);

it.effect("reports unresolved async answer delivery without closing questions or resending", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("async-delivery-warning");
    const requests = [
      "async:started",
      "async:accepted",
      "async:queued",
      "async:unsent",
      "async:queue-unsent",
      "async:resolved",
      "async:warned",
      "async:answered-after",
      "async:finished-after",
    ];
    const entries = requests.map((requestId, index) =>
      activity({
        id: `request-${index}`,
        threadId,
        kind: "user-input.requested",
        payload: { requestId },
        createdAt: "2026-08-17T00:00:00.000Z",
      }),
    );
    const add = (id: string, kind: string, payload: unknown) =>
      entries.push(
        activity({
          id,
          threadId,
          kind,
          payload,
          createdAt: "2026-08-17T00:00:01.000Z",
        }),
      );
    add("started", "provider.user-input.delivery.started", {
      requestId: "async:started",
      attemptId: "attempt-started",
    });
    add("accepted-start", "provider.user-input.delivery.started", {
      requestId: "async:accepted",
      attemptId: "attempt-accepted",
    });
    add("accepted-end", "provider.user-input.delivery.finished", {
      requestId: "async:accepted",
      attemptId: "attempt-accepted",
      outcome: "accepted",
    });
    add("queue", "provider.user-input.recovery.queued", {
      requestId: "async:queued",
      messageId: "message-queued",
    });
    add("unsent-start", "provider.user-input.delivery.started", {
      requestId: "async:unsent",
      attemptId: "attempt-unsent",
    });
    add("unsent-end", "provider.user-input.delivery.finished", {
      requestId: "async:unsent",
      attemptId: "attempt-unsent",
      outcome: "not-delivered",
    });
    add("queue-unsent", "provider.user-input.recovery.queued", {
      requestId: "async:queue-unsent",
      messageId: "message-unsent",
    });
    add("queue-not-sent", "provider.user-input.recovery.not-sent", {
      requestId: "async:queue-unsent",
      messageId: "message-unsent",
    });
    add("resolved-start", "provider.user-input.delivery.started", {
      requestId: "async:resolved",
      attemptId: "attempt-resolved",
    });
    add("resolved", "user-input.resolved", { requestId: "async:resolved" });
    add("warned-start", "provider.user-input.delivery.started", {
      requestId: "async:warned",
      attemptId: "attempt-warned",
    });
    add("warned", "provider.user-input.respond.failed", {
      requestId: "async:warned",
      code: "delivery-unknown-after-restart",
    });
    add("finished-after-start", "provider.user-input.delivery.started", {
      requestId: "async:finished-after",
      attemptId: "finished-after",
    });
    const harness = yield* makeHarness({
      threads: [threadShell({ id: threadId, session: null, hasPendingUserInput: true })],
      activities: entries,
      afterFirstActivityRead: () => {
        add("new-question", "user-input.requested", { requestId: "async:new" });
        add("new-start", "provider.user-input.delivery.started", {
          requestId: "async:new",
          attemptId: "new",
        });
        add("answered-after-start", "provider.user-input.delivery.started", {
          requestId: "async:answered-after",
          attemptId: "answered-after",
        });
        add("finished-after-end", "provider.user-input.delivery.finished", {
          requestId: "async:finished-after",
          attemptId: "finished-after",
          outcome: "not-delivered",
        });
      },
    });
    yield* runSweep(harness);
    const commands = yield* Ref.get(harness.dispatchedRef);
    const warnings = commands.flatMap((command) =>
      command.type === "thread.activity.append" &&
      command.activity.kind === "provider.user-input.respond.failed"
        ? [command.activity.payload]
        : [],
    );
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "async:started",
          code: "delivery-unknown-after-restart",
        }),
        expect.objectContaining({
          requestId: "async:accepted",
          code: "delivery-unknown-after-restart",
        }),
        expect.objectContaining({
          requestId: "async:queued",
          code: "delivery-unknown-after-restart",
        }),
      ]),
    );
    expect(warnings).toHaveLength(3);
    expect(
      commands.some(
        (command) =>
          command.type === "thread.turn.start" ||
          (command.type === "thread.activity.append" &&
            command.activity.kind === "user-input.resolved"),
      ),
    ).toBe(false);
  }),
);

it.effect("reports an uncertain async answer while settling an interrupted session", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("async-interrupted");
    const requestId = "async:interrupted";
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: threadId,
          session: session({ threadId, status: "running" }),
          hasPendingUserInput: true,
        }),
      ],
      activities: [
        activity({
          id: "interrupted-question",
          threadId,
          kind: "user-input.requested",
          payload: { requestId },
        }),
        activity({
          id: "interrupted-send",
          threadId,
          kind: "provider.user-input.delivery.started",
          payload: { requestId, attemptId: "attempt" },
        }),
      ],
    });
    yield* runSweep(harness);
    const commands = yield* Ref.get(harness.dispatchedRef);
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thread.session.stop" }),
        expect.objectContaining({
          type: "thread.activity.append",
          activity: expect.objectContaining({
            kind: "provider.user-input.respond.failed",
            payload: expect.objectContaining({ requestId, code: "delivery-unknown-after-restart" }),
          }),
        }),
      ]),
    );
    expect(
      commands.some(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "user-input.resolved",
      ),
    ).toBe(false);
  }),
);

it.effect("closes old questions in ready or stopped sessions without closing newer questions", () =>
  Effect.gen(function* () {
    const ready = ThreadId.make("ready-question");
    const stopped = ThreadId.make("stopped-question");
    const noSession = ThreadId.make("no-session-question");
    const old = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, "1 minute"));
    const activities = [
      activity({
        id: "a",
        threadId: ready,
        kind: "user-input.requested",
        payload: { requestId: "old-ready" },
        createdAt: old,
      }),
      activity({
        id: "c",
        threadId: stopped,
        kind: "user-input.requested",
        payload: { requestId: "old-stopped" },
        createdAt: old,
      }),
      activity({
        id: "d",
        threadId: noSession,
        kind: "user-input.requested",
        payload: { requestId: "old-no-session" },
        createdAt: old,
      }),
    ];
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: ready,
          session: session({ threadId: ready, status: "ready", activeTurnId: null }),
          hasPendingUserInput: true,
        }),
        threadShell({
          id: stopped,
          session: session({ threadId: stopped, status: "stopped", activeTurnId: null }),
          hasPendingUserInput: true,
        }),
        threadShell({ id: noSession, session: null, hasPendingUserInput: true }),
      ],
      activities,
      afterFirstActivityRead: () =>
        activities.push(
          activity({
            id: "b",
            threadId: ready,
            kind: "user-input.requested",
            payload: { requestId: "new-ready" },
            createdAt: old,
          }),
        ),
    });
    yield* runSweep(harness);
    const commands = yield* Ref.get(harness.dispatchedRef);
    expect(commands).toHaveLength(3);
    expect(commands.every((command) => command.type === "thread.activity.append")).toBe(true);
    expect(
      commands.flatMap((command) =>
        command.type === "thread.activity.append" ? [command.activity.payload] : [],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: "old-ready", abandoned: true }),
        expect.objectContaining({ requestId: "old-stopped", abandoned: true }),
        expect.objectContaining({ requestId: "old-no-session", abandoned: true }),
      ]),
    );
  }),
);

it.effect("marks background monitors and a pending self-wakeup as lost, and tells the seat", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-watching");
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const harness = yield* makeHarness({
      enabledWatches: [threadId],
      threads: [
        threadShell({
          id: "thread-watching",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-1") }),
        }),
      ],
      activities: [
        // A monitor that already ended normally: not reported.
        activity({
          id: "t1",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "done",
            agentKind: "background",
            taskType: "local_bash",
            title: "old",
          },
          createdAt: "2026-08-17T00:00:01.000Z",
        }),
        activity({
          id: "t2",
          threadId,
          kind: "task.completed",
          payload: { taskId: "done", status: "completed" },
          createdAt: "2026-08-17T00:00:02.000Z",
        }),
        // Two live watch loops.
        activity({
          id: "t3",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "m1",
            agentKind: "background",
            taskType: "local_bash",
            title: "log watch",
          },
          createdAt: "2026-08-17T00:00:03.000Z",
        }),
        activity({
          id: "t4",
          threadId,
          kind: "task.started",
          payload: {
            taskId: "m2",
            agentKind: "background",
            taskType: "monitor",
            title: "liveness",
          },
          createdAt: "2026-08-17T00:00:04.000Z",
        }),
        // An agent (not background) must not be counted as a monitor.
        activity({
          id: "t5",
          threadId,
          kind: "task.started",
          payload: { taskId: "a1", agentKind: "agent", taskType: "local_agent", title: "worker" },
          createdAt: "2026-08-17T00:00:05.000Z",
        }),
        // A self-wakeup scheduled 20 minutes out: still ahead of the sweep.
        activity({
          id: "t6",
          threadId,
          kind: "tool.completed",
          payload: {
            itemType: "dynamic_tool_call",
            detail: "ScheduleWakeup: {}",
            data: { toolName: "ScheduleWakeup", input: { delaySeconds: 1200, noop: false } },
          },
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 60_000)),
        }),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual(["thread.background-recovery.start"]);
    const recovery = dispatched[0];
    if (recovery?.type !== "thread.background-recovery.start")
      throw new Error("expected atomic recovery");
    const appended = recovery.activities;
    expect(appended.map((entry) => entry.kind)).toEqual([
      "task.completed",
      "task.completed",
      "session.recovered",
    ]);
    expect(appended.map((entry) => (entry.payload as { taskId?: string }).taskId)).toEqual([
      "m1",
      "m2",
      undefined,
    ]);
    const marker = appended[2]!.payload as {
      interruptedTasks: ReadonlyArray<{ taskId: string }>;
      wakeupScheduledFor: string | null;
    };
    expect(marker.interruptedTasks.map((task) => task.taskId)).toEqual(["m2"]);
    expect(appended[0]?.payload).toMatchObject({ taskId: "m1", outcomeUnknown: true });
    expect(recovery.turn.message.text).not.toContain("log watch");
    expect(marker.wakeupScheduledFor).not.toBeNull();
    expect(recovery.turn.message.text).toContain("백그라운드 감시 1개");
    expect(recovery.turn.message.text).toContain("자동 깨어남");
  }),
);

// The storm guard measures against the wall clock, which `it.effect`'s
// TestClock would freeze at the epoch — hence `it.live` for these two.
it.live("holds the recovery turn once restarts keep killing the same thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-storm");
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-storm",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-9") }),
        }),
      ],
      messages: [1, 2, 3].map((index) =>
        recoveryMessage({
          id: `recovery-${index}`,
          threadId,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - index * 60_000)),
        }),
      ),
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.session.stop",
      "thread.activity.append",
    ]);
    const marker = dispatched[1];
    if (marker?.type !== "thread.activity.append") throw new Error("expected a hold marker");
    expect(marker.activity.kind).toBe("session.recovery-held");
    expect(marker.activity.summary).toContain("자동 복구 보류");
  }),
);

it.live("recovery turns outside the storm window do not hold the thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-old-storm");
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-old-storm",
          session: session({ threadId, status: "running", activeTurnId: TurnId.make("turn-9") }),
        }),
      ],
      messages: [
        recoveryMessage({
          id: "recovery-recent",
          threadId,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - 60_000)),
        }),
        ...[1, 2, 3].map((index) =>
          recoveryMessage({
            id: `recovery-old-${index}`,
            threadId,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(now - (20 + index) * 60_000)),
          }),
        ),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched.map((command) => command.type)).toEqual(["thread.background-recovery.start"]);
  }),
);

it.live("closes stale pending approvals left on a ready thread after server restart", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-stale-approval");
    const harness = yield* makeHarness({
      threads: [
        threadShell({
          id: "thread-stale-approval",
          session: session({ threadId, status: "ready" }),
          hasPendingApprovals: true,
        }),
      ],
      activities: [
        activity({
          id: "req-1",
          threadId,
          kind: "approval.requested",
          payload: {
            requestId: "cnc_old:r1:seat_sub_0:per_1",
            requestType: "unknown",
            detail: "glob",
          },
          createdAt: "2026-08-17T00:00:01.000Z",
        }),
        activity({
          id: "req-2",
          threadId,
          kind: "approval.requested",
          payload: {
            requestId: "cnc_old:r1:seat_sub_1:per_2",
            requestType: "command_execution_approval",
          },
          createdAt: "2026-08-17T00:00:02.000Z",
        }),
        activity({
          id: "res-2",
          threadId,
          kind: "approval.resolved",
          payload: {
            requestId: "cnc_old:r1:seat_sub_1:per_2",
            decision: "accept",
          },
          createdAt: "2026-08-17T00:00:03.000Z",
        }),
      ],
    });
    yield* runSweep(harness);

    const dispatched = yield* Ref.get(harness.dispatchedRef);
    expect(dispatched).toHaveLength(1);
    const cmd = dispatched[0];
    if (cmd?.type !== "thread.activity.append")
      throw new Error("expected approval.resolved append");
    expect(cmd.activity.kind).toBe("approval.resolved");
    expect(cmd.activity.payload).toMatchObject({
      requestId: "cnc_old:r1:seat_sub_0:per_1",
      decision: "cancel",
      abandoned: true,
      timelineBypass: true,
    });
  }),
);

it.live(
  "cancels orphaned running orchestra blocks from dead runs while skipping resumable runs",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-orphaned-council");
      const deadBlock = {
        executionId: "cnc_dead:r1:seat_sub_0",
        ownerThreadId: threadId,
        runId: "cnc_dead",
        nodeId: "seat_sub_0",
        attempt: 1,
        messageId: MessageId.make("msg-dead-seat"),
        title: "다자간 위원회 R1 · CONTRARIAN_RED",
        displayName: "EXAONE",
        role: "verifier",
        kind: "validation",
        modelSelection,
        status: "running",
      };
      const resumableBlock = {
        ...deadBlock,
        executionId: "collab_live:node_1",
        runId: "collab_live",
        messageId: MessageId.make("msg-resumable-seat"),
      };
      const harness = yield* makeHarness({
        threads: [
          threadShell({
            id: "thread-orphaned-council",
            session: session({ threadId, status: "ready" }),
          }),
        ],
        resumableRuns: [
          {
            id: WorkspaceCollaborationRunId.make("collab_live"),
            status: "running",
            meeting: null,
            graph: null,
            steps: [],
          } as unknown as WorkspaceCollaborationRun,
        ],
        messages: [
          {
            messageId: MessageId.make("msg-dead-seat"),
            threadId,
            turnId: null,
            role: "assistant",
            text: "",
            isStreaming: true,
            createdAt: at,
            updatedAt: at,
          },
        ],
      });

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
        const deadBlockJson = yield* encodeJson(deadBlock);
        const resumableBlockJson = yield* encodeJson(resumableBlock);
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES
          ('act-dead-1', ${threadId}, NULL, 'info', 'orchestra.block', 'dead', ${deadBlockJson}, '2026-08-17T00:00:01.000Z'),
          ('act-live-1', ${threadId}, NULL, 'info', 'orchestra.block', 'live', ${resumableBlockJson}, '2026-08-17T00:00:02.000Z')
      `;
        const reactor = yield* Effect.service(SessionRecoveryReactor);
        yield* reactor.start();
        yield* reactor.drain;
      }).pipe(Effect.provide(harness.layer), Effect.scoped);

      const dispatched = yield* Ref.get(harness.dispatchedRef);
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.activity.append",
        "thread.message.assistant.complete",
      ]);
      const blockCmd = dispatched[0];
      if (blockCmd?.type !== "thread.activity.append") throw new Error("expected cancelled block");
      expect(blockCmd.activity.kind).toBe("orchestra.block");
      expect(blockCmd.activity.payload).toMatchObject({
        executionId: "cnc_dead:r1:seat_sub_0",
        messageId: "msg-dead-seat",
        status: "cancelled",
      });
      const completeCmd = dispatched[1];
      if (completeCmd?.type !== "thread.message.assistant.complete") {
        throw new Error("expected assistant complete");
      }
      expect(completeCmd.messageId).toBe(MessageId.make("msg-dead-seat"));
    }),
);
