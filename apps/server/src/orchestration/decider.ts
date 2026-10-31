import {
  DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
  DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
  DEFAULT_WORKSPACE_CONTROL_SETTINGS,
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
  DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
  EventId,
  renderApprovedTaskConditions,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type WorkspaceMonitoringSettings,
  type WorkspaceOrchestraSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { executionProfileTask, profileMeeting } from "@t3tools/shared/executionProfile";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireActiveLongTermMemoryRootNonOverlapping,
  requireActiveProjectWorkspaceRootAbsent,
  requireCoherentMeetingSetup,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";
import { taskConditionsError } from "./taskConditions.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
function deliveryOrchestra(
  settings: WorkspaceOrchestraSettings | null,
  commands?: readonly string[],
): WorkspaceOrchestraSettings | null {
  return settings === null
    ? null
    : {
        ...settings,
        completionCheck: true,
        ...(commands === undefined ? {} : { verificationCommands: commands }),
      };
}

// Session adoption takes seconds; a user message still unadopted after this
// window is a failed/stale start, not pending work. Mirrors the client's
// QUEUED_TURN_START_GRACE_MS in client-runtime threadSettled.ts.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * Blocked-on-you work derived from the thread's retained activities: an
 * approval or user-input request with no later resolution for the same
 * requestId. The server-side twin of the shell's hasPendingApprovals /
 * hasPendingUserInput flags, which the decider read model does not carry.
 * The clearing rules MUST match ProjectionPipeline's pending accounting —
 * resolved activities always clear, respond.failed clears only when the
 * failure detail marks the request stale/unknown — or settle would be
 * rejected on threads whose shell flags read as clear.
 */
function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

// Scans the read model's activities, which the projector caps at the most
// recent 500. That bound is safe here: an OPEN approval/user-input request
// blocks its turn, so the thread cannot accumulate hundreds of later
// activities while one is outstanding — a request that has scrolled out of
// the window is one whose turn kept running, i.e. it was resolved or went
// stale. (The projection pipeline's pendingApprovalCount reads the same
// capped stream and stays consistent with this view.)
function hasOpenBlockingRequest(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

/**
 * A queued turn start — a user message no turn has picked up yet — is work
 * in flight even though session is still null (turn.start emits
 * message-sent + turn-start-requested; the session arrives later). Detection
 * mirrors the client's hasQueuedTurnStart: the newest user message is
 * strictly newer than every latestTurn timestamp (adoption stamps the new
 * turn's requestedAt with the message time, clearing this), and only within
 * the adoption grace window — historical threads whose last user message
 * postdates their turn timestamps (older-server data, mid-turn messages)
 * must not be blocked forever. A failed session start (status "error")
 * clears the block immediately.
 *
 * The age check is bounded on BOTH sides: message timestamps are
 * client-supplied, so a client clock ahead of the server yields a negative
 * age. Without the lower bound that negative age satisfies `<= grace` for
 * as long as the skew lasts, extending the block far past the intended two
 * minutes.
 */
function threadHasQueuedTurnStart(
  thread: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
    readonly latestTurn: {
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    } | null;
    readonly session: { readonly status: string } | null;
  },
  occurredAt: string,
): boolean {
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  );
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        );
  const queuedAgeMs = Date.parse(occurredAt) - latestUserMessageAtMs;
  return (
    thread.session?.status !== "error" &&
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

/**
 * Merge the person's monitoring edits over the stored settings. A plan the
 * person hands in is approved by definition — they wrote it — and replaces
 * whatever the AI had proposed; `plan: null` clears it and asks for nothing
 * until the switch is turned on again (the reactor proposes on "none").
 */
/**
 * The orchestra shape for a run whose request carries none of its own: the
 * project's stored defaults, when the person opted the project in. Schedules
 * and the integrity loop start runs with nobody at the keyboard, so this is
 * their only path into parallel execution and worktree isolation.
 */
function orchestraFromWorkspaceDefaults(
  project: OrchestrationProject,
): WorkspaceOrchestraSettings | null {
  const defaults = project.workspaceControl?.orchestra;
  if (defaults === undefined || !defaults.enabled) return null;
  return { maxParallel: defaults.maxParallel, isolateWorktrees: defaults.isolateWorktrees };
}

function applyMonitoringUserSettings(
  current: WorkspaceMonitoringSettings,
  update:
    | (Omit<
        WorkspaceMonitoringSettings,
        "threadId" | "plan" | "planStatus" | "turnLog" | "lastCheckedAt"
      > & {
        readonly plan?: WorkspaceMonitoringSettings["plan"];
      })
    | undefined,
  now: string,
): WorkspaceMonitoringSettings {
  if (update === undefined) return current;
  const base: WorkspaceMonitoringSettings = {
    ...current,
    enabled: update.enabled,
    autonomy: update.autonomy,
    checkIntervalSec: update.checkIntervalSec,
    aiTurnBudget: update.aiTurnBudget,
    modelSelection: update.modelSelection,
  };
  if (update.plan === undefined) return base;
  if (update.plan === null) return { ...base, plan: null, planStatus: "none" };
  return {
    ...base,
    plan: {
      ...update.plan,
      revision: (current.plan?.revision ?? 0) + 1,
      proposedAt: current.plan?.proposedAt ?? now,
      approvedAt: now,
    },
    planStatus: "approved",
  };
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });
      if (command.longTermMemoryRoot !== undefined) {
        yield* requireActiveLongTermMemoryRootNonOverlapping({
          readModel,
          command,
          longTermMemoryRoot: command.longTermMemoryRoot,
          exceptProjectId: command.projectId,
        });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          workspaceControl: {
            ...DEFAULT_WORKSPACE_CONTROL_SETTINGS,
            longTermMemoryRoot: command.longTermMemoryRoot ?? null,
            conversationRag:
              command.conversationRag ?? DEFAULT_WORKSPACE_CONTROL_SETTINGS.conversationRag,
            agentKnowledge:
              command.agentKnowledge ?? DEFAULT_WORKSPACE_CONTROL_SETTINGS.agentKnowledge,
          },
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workspaceRoot !== undefined) {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.workspace-control.update": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.longTermMemoryRoot !== null) {
        yield* requireActiveLongTermMemoryRootNonOverlapping({
          readModel,
          command,
          longTermMemoryRoot: command.longTermMemoryRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.workspace-control-updated",
        payload: {
          projectId: command.projectId,
          workspaceControl: {
            isolationMode: "strict",
            longTermMemoryRoot: command.longTermMemoryRoot,
            ...((command.completionAutomation ?? project.workspaceControl?.completionAutomation)
              ? {
                  completionAutomation:
                    command.completionAutomation ?? project.workspaceControl!.completionAutomation!,
                }
              : {}),
            ...(command.contextOptimization !== undefined
              ? { contextOptimization: command.contextOptimization }
              : project.workspaceControl?.contextOptimization !== undefined
                ? { contextOptimization: project.workspaceControl.contextOptimization }
                : {}),
            conversationRag:
              command.conversationRag ??
              project.workspaceControl?.conversationRag ??
              DEFAULT_WORKSPACE_CONTROL_SETTINGS.conversationRag,
            agentKnowledge:
              command.agentKnowledge ??
              project.workspaceControl?.agentKnowledge ??
              DEFAULT_WORKSPACE_CONTROL_SETTINGS.agentKnowledge,
            monitoring: applyMonitoringUserSettings(
              project.workspaceControl?.monitoring ?? DEFAULT_WORKSPACE_MONITORING_SETTINGS,
              command.monitoring,
              occurredAt,
            ),
            orchestra:
              command.orchestra ??
              project.workspaceControl?.orchestra ??
              DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
          },
          updatedAt: occurredAt,
        },
      };
    }

    // All monitoring mutations ride the existing workspace-control event: the
    // blob is already persisted and projected everywhere, and one event type
    // means the sidebar, control center, and reactor all see the same change.
    case "project.monitoring.plan.approve":
    case "project.monitoring.reanalyze":
    case "project.monitoring.plan.propose":
    case "project.monitoring.runtime.update": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const control = project.workspaceControl ?? DEFAULT_WORKSPACE_CONTROL_SETTINGS;
      const current = control.monitoring;
      const occurredAt = yield* nowIso;
      let monitoring: WorkspaceMonitoringSettings;
      switch (command.type) {
        case "project.monitoring.plan.approve": {
          if (current.planStatus !== "proposed" || current.plan === null) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Project '${command.projectId}' has no proposed monitoring plan to approve.`,
            });
          }
          if (current.plan.revision !== command.revision) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Monitoring plan revision ${command.revision} was replaced by revision ${current.plan.revision}.`,
            });
          }
          monitoring = {
            ...current,
            plan: { ...current.plan, approvedAt: occurredAt },
            planStatus: "approved",
          };
          break;
        }
        case "project.monitoring.reanalyze":
          // The old plan stays visible until the new proposal replaces it.
          monitoring = { ...current, planStatus: "none" };
          break;
        case "project.monitoring.plan.propose":
          monitoring = {
            ...current,
            plan: {
              ...command.plan,
              revision: (current.plan?.revision ?? 0) + 1,
              proposedAt: occurredAt,
              approvedAt: null,
            },
            planStatus: "proposed",
          };
          break;
        case "project.monitoring.runtime.update":
          monitoring = {
            ...current,
            ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
            ...(command.turnLog !== undefined ? { turnLog: command.turnLog } : {}),
            ...(command.lastCheckedAt !== undefined
              ? { lastCheckedAt: command.lastCheckedAt }
              : {}),
            ...(command.planStatus !== undefined && current.planStatus === "approved"
              ? { planStatus: command.planStatus }
              : {}),
          };
          break;
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.workspace-control-updated",
        payload: {
          projectId: command.projectId,
          workspaceControl: { ...control, monitoring },
          updatedAt: occurredAt,
        },
      };
    }

    case "project.runtime.view": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const currentViewedThrough = project.runtimeViewedThrough ?? null;
      const viewedThrough =
        currentViewedThrough !== null && currentViewedThrough > command.viewedThrough
          ? currentViewedThrough
          : command.viewedThrough;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.runtime-viewed",
        payload: {
          projectId: command.projectId,
          viewedThrough,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.knowledge.item.upsert": {
      if ((command.scope === "folder") !== (command.appliesToFolder != null)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Folder-scoped knowledge requires an applicable folder; other scopes cannot specify one.",
        });
      }
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.knowledge-item-upserted",
        payload: {
          projectId: command.projectId,
          itemId: command.itemId,
          kind: command.kind,
          title: command.title,
          content: command.content,
          status: command.status,
          origin: command.origin,
          relativeFolder: command.relativeFolder,
          scope: command.scope ?? "project",
          appliesToFolder: command.appliesToFolder?.replaceAll("\\", "/") ?? null,
          research: command.research ?? null,
          tags: command.tags,
          originalChars: command.originalChars ?? null,
          storedChars: command.storedChars ?? null,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.knowledge.item.archive": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.knowledge-item-archived",
        payload: {
          projectId: command.projectId,
          itemId: command.itemId,
          archivedAt: command.createdAt,
        },
      };
    }

    case "project.knowledge.usage.record": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.usedAt,
          commandId: command.commandId,
        })),
        type: "project.knowledge-usage-recorded",
        payload: {
          projectId: command.projectId,
          // Duplicates would double-count a single composition; the projection
          // adds one use per item per event.
          itemIds: [...new Set(command.itemIds)],
          usedAt: command.usedAt,
        },
      };
    }

    case "project.agent-role.upsert": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.agent-role-upserted",
        payload: {
          projectId: command.projectId,
          role: command.role,
          displayName: command.displayName,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          instructions: command.instructions,
          enabled: command.enabled,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.agent-role.remove": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.agent-role-removed",
        payload: {
          projectId: command.projectId,
          role: command.role,
          removedAt: command.createdAt,
        },
      };
    }

    case "project.workflow.run.request":
    case "project.collaboration.run.request": {
      const runProject = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const runThreadId = command.workflow?.threadId ?? command.runContext?.threadId;
      if (runThreadId) {
        const targetThread = yield* requireThreadNotArchived({
          readModel,
          command,
          threadId: runThreadId,
        });
        if (targetThread.projectId !== command.projectId || targetThread.deletedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "워크플로 실행 채팅방은 삭제되지 않았고 같은 프로젝트에 속해야 합니다.",
          });
        }
      }
      const meeting = command.executionProfile
        ? {
            ...profileMeeting(command.executionProfile),
            ...(command.meeting?.threadId ? { threadId: command.meeting.threadId } : {}),
            ...(command.meeting?.runtimeMode === undefined
              ? {}
              : { runtimeMode: command.meeting.runtimeMode }),
            ...(command.meeting?.interactionMode === undefined
              ? {}
              : { interactionMode: command.meeting.interactionMode }),
          }
        : command.meeting;
      const task = executionProfileTask(command.task, command.executionProfile);
      if (task.length > 20_000)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Task and execution profile exceed 20,000 characters.",
        });
      if (meeting !== undefined) {
        yield* requireCoherentMeetingSetup({
          commandType: command.type,
          participantIds: meeting.participants.map((participant) => participant.id),
          chairParticipantId: meeting.chairParticipantId,
        });
        if (meeting.threadId !== undefined) {
          const meetingThread = yield* requireThreadNotArchived({
            readModel,
            command,
            threadId: meeting.threadId,
          });
          if (meetingThread.projectId !== command.projectId) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Thread '${meeting.threadId}' belongs to another project; a meeting can only run in a conversation of its own project.`,
            });
          }
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.collaboration-run-requested",
        payload: {
          run: {
            id: command.runId,
            projectId: command.projectId,
            source: command.source ?? "user",
            scheduleId: null,
            incidentId: null,
            task,
            status: "queued",
            steps: [],
            graph: null,
            ...(command.workflow ? { workflow: command.workflow } : {}),
            ...(command.runContext ? { runContext: command.runContext } : {}),
            runControl: {
              control: command.workflow?.control ?? "active",
              controlRevision: command.workflow?.controlRevision ?? 0,
              ...(command.workflow?.executionRevision === undefined
                ? {}
                : { executionRevision: command.workflow.executionRevision }),
              updatedAt: command.createdAt,
            },
            // The setup is the roster and the rules; everything the meeting
            // accumulates starts empty and is server-owned from here on.
            meeting:
              meeting === undefined
                ? null
                : {
                    ...meeting,
                    phase: meeting.askFirst === true ? "clarifying" : "discussing",
                    threadId: meeting.threadId ?? null,
                    rounds: [],
                    pendingQuestion: null,
                    answers: [],
                    interjections: [],
                  },
            // Fixed here: a later settings change never re-shapes a run under way.
            orchestra: deliveryOrchestra(
              command.executionProfile?.orchestra ??
                command.orchestra ??
                orchestraFromWorkspaceDefaults(runProject),
              command.executionProfile?.verificationCommands,
            ),
            finalOutput: null,
            error: null,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
          // Only a person's request displaces the schedule by default; anything the server
          // starts for itself has to ask for that explicitly.
          preempt: command.preempt ?? (command.source ?? "user") === "user",
        },
      };
    }

    case "project.collaboration.run.schedule": {
      const scheduleProject = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const meeting = command.executionProfile
        ? profileMeeting(command.executionProfile)
        : undefined;
      const task = executionProfileTask(command.task, command.executionProfile);
      if (task.length > 20_000)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Task and execution profile exceed 20,000 characters.",
        });
      if (meeting)
        yield* requireCoherentMeetingSetup({
          commandType: command.type,
          participantIds: meeting.participants.map((participant) => participant.id),
          chairParticipantId: meeting.chairParticipantId,
        });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.collaboration-run-requested",
        payload: {
          run: {
            id: command.runId,
            projectId: command.projectId,
            source: "schedule",
            scheduleId: command.scheduleId,
            incidentId: null,
            task,
            status: "queued",
            steps: [],
            graph: null,
            meeting: meeting
              ? {
                  ...meeting,
                  phase: meeting.askFirst === true ? "clarifying" : "discussing",
                  threadId: null,
                  rounds: [],
                  pendingQuestion: null,
                  answers: [],
                  interjections: [],
                }
              : null,
            orchestra: deliveryOrchestra(
              command.executionProfile?.orchestra ??
                orchestraFromWorkspaceDefaults(scheduleProject),
              command.executionProfile?.verificationCommands,
            ),
            finalOutput: null,
            error: null,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
      };
    }

    case "project.collaboration.run.review":
    case "project.collaboration.run.verify": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      const base = yield* withEventBase({
        aggregateKind: "project",
        aggregateId: command.projectId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      });
      return command.type === "project.collaboration.run.review"
        ? {
            ...base,
            type: "project.collaboration-run-reviewed",
            payload: {
              projectId: command.projectId,
              runId: command.runId,
              expectedRevision: command.expectedRevision,
              edits: command.edits,
              approve: command.approve,
              reviewedAt: command.createdAt,
            },
          }
        : {
            ...base,
            type: "project.collaboration-verification-requested",
            payload: {
              projectId: command.projectId,
              runId: command.runId,
              verificationCommands: command.verificationCommands,
              requestedAt: command.createdAt,
            },
          };
    }

    case "project.collaboration.run.answer": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.collaboration-run-answered",
        payload: {
          projectId: command.projectId,
          runId: command.runId,
          question: command.question,
          questionRef: command.questionRef,
          answer: command.answer,
          ...(command.imageReferences ? { imageReferences: command.imageReferences } : {}),
          answeredAt: command.createdAt,
        },
      };
    }

    case "project.collaboration.run.interject": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.collaboration-run-interjected",
        payload: {
          projectId: command.projectId,
          runId: command.runId,
          text: command.text,
          interjectedAt: command.createdAt,
        },
      };
    }

    case "project.workflow.save": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.definition.createdAt,
          commandId: command.commandId,
        })),
        type: "project.workflow-saved",
        payload: {
          projectId: command.projectId,
          definition: command.definition,
          expectedRevision: command.expectedRevision,
        },
      };
    }
    case "project.workflow.delivery": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      const { type: _type, commandId: _id, ...payload } = command;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.workflow-delivery-recorded",
        payload,
      };
    }
    case "project.collaboration.run.control": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.collaboration-run-control-requested",
        payload: {
          projectId: command.projectId,
          runId: command.runId,
          expectedRevision: command.expectedRevision,
          action: command.action,
          ...(command.nodeId === undefined ? {} : { nodeId: command.nodeId }),
          createdAt: command.createdAt,
        },
      };
    }

    case "project.collaboration.run.cancel": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.collaboration-run-cancel-requested",
        payload: {
          projectId: command.projectId,
          runId: command.runId,
          cancelledAt: command.createdAt,
        },
      };
    }

    case "project.collaboration.run.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.run.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.run.projectId,
          occurredAt: command.run.updatedAt,
          commandId: command.commandId,
        })),
        type: "project.collaboration-run-upserted",
        payload: { run: command.run },
      };
    }

    case "project.schedule.upsert": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.schedule-upserted",
        payload: {
          scheduleId: command.scheduleId,
          projectId: command.projectId,
          title: command.title,
          task: command.task,
          enabled: command.enabled,
          timing: command.timing,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.schedule.remove": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.schedule-removed",
        payload: {
          scheduleId: command.scheduleId,
          projectId: command.projectId,
          removedAt: command.createdAt,
        },
      };
    }

    case "project.schedule.runtime.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        })),
        type: "project.schedule-runtime-updated",
        payload: {
          scheduleId: command.scheduleId,
          projectId: command.projectId,
          nextTriggerAt: command.nextTriggerAt,
          lastTriggeredAt: command.lastTriggeredAt,
          lastRunId: command.lastRunId,
          lastError: command.lastError,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "project.program.upsert": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.program-upserted",
        payload: {
          program: {
            id: command.programId,
            projectId: command.projectId,
            name: command.name,
            command: command.command,
            relativeDirectory: command.relativeDirectory,
            environmentVariableNames: command.environmentVariableNames,
            startPolicy: command.startPolicy,
            healthCheck: command.healthCheck,
            errorPatterns: command.errorPatterns,
            enabled: command.enabled,
            integrity: {
              ...DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
              enabled: command.integrityEnabled ?? false,
              validationCommands: command.integrityValidationCommands ?? [],
              requiredCleanPasses: command.integrityRequiredCleanPasses ?? 2,
              status: command.integrityEnabled === true ? "queued" : "disabled",
              updatedAt: command.createdAt,
            },
            hubMemory: command.hubMemory ?? DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
      };
    }

    case "project.program.remove":
    case "project.program.start":
    case "project.program.stop":
    case "project.program.restart": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      const eventType =
        command.type === "project.program.remove"
          ? "project.program-removed"
          : command.type === "project.program.start"
            ? "project.program-start-requested"
            : command.type === "project.program.stop"
              ? "project.program-stop-requested"
              : "project.program-restart-requested";
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: eventType,
        payload:
          command.type === "project.program.remove"
            ? {
                projectId: command.projectId,
                programId: command.programId,
                removedAt: command.createdAt,
              }
            : {
                projectId: command.projectId,
                programId: command.programId,
                requestedAt: command.createdAt,
              },
      } as OrchestrationEvent;
    }

    case "project.program.integrity.start":
    case "project.program.integrity.stop": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type:
          command.type === "project.program.integrity.start"
            ? "project.program-integrity-start-requested"
            : "project.program-integrity-stop-requested",
        payload: {
          projectId: command.projectId,
          programId: command.programId,
          requestedAt: command.createdAt,
        },
      } as OrchestrationEvent;
    }

    case "project.program.run.update": {
      yield* requireProject({ readModel, command, projectId: command.run.projectId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.run.projectId,
          occurredAt: command.run.updatedAt,
          commandId: command.commandId,
        })),
        type: "project.program-run-upserted",
        payload: { run: command.run },
      };
    }

    case "project.program.integrity.update": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.integrity.updatedAt ?? (yield* nowIso),
          commandId: command.commandId,
        })),
        type: "project.program-integrity-updated",
        payload: {
          projectId: command.projectId,
          programId: command.programId,
          integrity: command.integrity,
        },
      };
    }

    case "project.program.incident.upsert": {
      yield* requireProject({ readModel, command, projectId: command.incident.projectId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.incident.projectId,
          occurredAt: command.incident.updatedAt,
          commandId: command.commandId,
        })),
        type: "project.program-incident-upserted",
        payload: { incident: command.incident },
      };
    }

    case "project.program.incident.repair.request": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.program-incident-repair-requested",
        payload: {
          projectId: command.projectId,
          incidentId: command.incidentId,
          instruction: command.instruction,
          requestedAt: command.createdAt,
        },
      };
    }

    case "project.program.incident.resolve": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.program-incident-resolve-requested",
        payload: {
          projectId: command.projectId,
          incidentId: command.incidentId,
          requestedAt: command.createdAt,
        },
      };
    }

    case "project.collaboration.run.incident": {
      const incidentProject = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.collaboration-run-requested",
        payload: {
          run: {
            id: command.runId,
            projectId: command.projectId,
            source: "incident",
            scheduleId: null,
            incidentId: command.incidentId,
            task: command.task,
            status: "queued",
            steps: [],
            graph: null,
            // Incident repair is started by the integrity loop, not a person,
            // so the project's stored orchestra defaults decide the shape.
            meeting: null,
            orchestra: orchestraFromWorkspaceDefaults(incidentProject),
            finalOutput: null,
            error: null,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          orchestraRunThreadId: command.orchestraRunThreadId ?? null,
          ...(command.importedConversation
            ? { importedConversation: command.importedConversation }
            : {}),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const deletedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
      // Deleting the monitoring thread must not strand the loop on a dead id;
      // the next check creates a fresh one.
      const monitoredProject = readModel.projects.find(
        (project) => project.workspaceControl?.monitoring.threadId === command.threadId,
      );
      if (monitoredProject === undefined) return deletedEvent;
      const control = monitoredProject.workspaceControl ?? DEFAULT_WORKSPACE_CONTROL_SETTINGS;
      return [
        deletedEvent,
        {
          ...(yield* withEventBase({
            aggregateKind: "project",
            aggregateId: monitoredProject.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "project.workspace-control-updated",
          payload: {
            projectId: monitoredProject.id,
            workspaceControl: { ...control, monitoring: { ...control.monitoring, threadId: null } },
            updatedAt: occurredAt,
          },
        },
      ];
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Server-side twin of the client's canSettle session check: a stale
      // or raced client must not settle a thread whose session is coming
      // alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has an active session and cannot be settled`,
          }),
        );
      }
      // Pending approval / user-input requests are blocked-on-you work: a
      // raced or stale client must not park them behind a settled override
      // that would surface only after the request resolves.
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be settled`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be settled`,
          }),
        );
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled" as const,
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled ? thread.settledAt : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": it clears a pin the same way it
      // parks the thread. Without this, settling a pinned thread would only
      // stamp invisible state — the pin would hold the card in place until
      // a separate unpin.
      if (thread.pinnedAt == null) {
        return settledEvent;
      }
      return [
        settledEvent,
        {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned" as const,
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        },
      ];
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        );
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
          }),
        );
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        );
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.handoffMode !== undefined ? { handoffMode: command.handoffMode } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const conditionsError = taskConditionsError(command);
      if (conditionsError !== null)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: conditionsError,
        });
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          inputOrigin: command.inputOrigin ?? "user",
          text: command.taskConditions
            ? renderApprovedTaskConditions(command.taskConditions, command.message.text)
            : command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          ...(command.usageContext !== undefined ? { usageContext: command.usageContext } : {}),
          threadId: command.threadId,
          messageId: command.message.messageId,
          inputOrigin: command.inputOrigin ?? "user",
          modelSelection: command.modelSelection ?? targetThread.modelSelection,
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode:
            command.taskConditions?.mode === "inspect"
              ? "approval-required"
              : targetThread.runtimeMode,
          interactionMode:
            command.taskConditions?.mode === "inspect" ? "plan" : targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          ...(command.questionRequestId !== undefined
            ? { questionRequestId: command.questionRequestId }
            : {}),
          ...(command.stopBackground !== undefined
            ? { stopBackground: command.stopBackground }
            : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          ...(command.images ? { images: command.images } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      // Only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.message.user.append": {
      yield* requireThread({ readModel, command, threadId: command.threadId });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "user",
          inputOrigin: "user",
          text: command.text,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          ...(command.attachments !== undefined ? { attachments: command.attachments } : {}),
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
