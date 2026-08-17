import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

type CommandType = ClientOrchestrationCommand["type"];
type CommandOf<T extends CommandType> = Extract<ClientOrchestrationCommand, { readonly type: T }>;
type CommandInput<T extends CommandType> = Omit<
  CommandOf<T>,
  "type" | "commandId" | "createdAt"
> & {
  readonly commandId?: CommandId;
} & ("createdAt" extends keyof CommandOf<T>
    ? {
        readonly createdAt?: CommandOf<T>["createdAt"];
      }
    : {});

export type CreateProjectInput = CommandInput<"project.create">;
export type UpdateProjectInput = CommandInput<"project.meta.update">;
export type UpdateWorkspaceControlInput = CommandInput<"project.workspace-control.update">;
export type MarkWorkspaceRuntimeViewedInput = CommandInput<"project.runtime.view">;
export type UpsertWorkspaceKnowledgeItemInput = CommandInput<"project.knowledge.item.upsert">;
export type ArchiveWorkspaceKnowledgeItemInput = CommandInput<"project.knowledge.item.archive">;
export type UpsertWorkspaceAgentRoleInput = CommandInput<"project.agent-role.upsert">;
export type RemoveWorkspaceAgentRoleInput = CommandInput<"project.agent-role.remove">;
export type RequestWorkspaceCollaborationRunInput =
  CommandInput<"project.collaboration.run.request">;
export type CancelWorkspaceCollaborationRunInput = CommandInput<"project.collaboration.run.cancel">;
export type AnswerWorkspaceCollaborationRunInput = CommandInput<"project.collaboration.run.answer">;
export type InterjectWorkspaceCollaborationRunInput =
  CommandInput<"project.collaboration.run.interject">;
export type UpsertWorkspaceScheduleInput = CommandInput<"project.schedule.upsert">;
export type RemoveWorkspaceScheduleInput = CommandInput<"project.schedule.remove">;
export type UpsertWorkspaceProgramInput = CommandInput<"project.program.upsert">;
export type RemoveWorkspaceProgramInput = CommandInput<"project.program.remove">;
export type StartWorkspaceProgramInput = CommandInput<"project.program.start">;
export type StopWorkspaceProgramInput = CommandInput<"project.program.stop">;
export type RestartWorkspaceProgramInput = CommandInput<"project.program.restart">;
export type StartWorkspaceProgramIntegrityInput = CommandInput<"project.program.integrity.start">;
export type StopWorkspaceProgramIntegrityInput = CommandInput<"project.program.integrity.stop">;
export type RequestWorkspaceIncidentRepairInput =
  CommandInput<"project.program.incident.repair.request">;
export type ResolveWorkspaceIncidentInput = CommandInput<"project.program.incident.resolve">;
export type DeleteProjectInput = CommandInput<"project.delete">;
export type CreateThreadInput = CommandInput<"thread.create">;
export type DeleteThreadInput = CommandInput<"thread.delete">;
export type ArchiveThreadInput = CommandInput<"thread.archive">;
export type UnarchiveThreadInput = CommandInput<"thread.unarchive">;
export type SettleThreadInput = CommandInput<"thread.settle">;
export type UnsettleThreadInput = CommandInput<"thread.unsettle">;
export type SnoozeThreadInput = CommandInput<"thread.snooze">;
export type UnsnoozeThreadInput = CommandInput<"thread.unsnooze">;
export type PinThreadInput = CommandInput<"thread.pin">;
export type UnpinThreadInput = CommandInput<"thread.unpin">;
export type ReorderPinnedThreadInput = CommandInput<"thread.pin.reorder">;
export type UpdateThreadMetadataInput = CommandInput<"thread.meta.update">;
export type SetThreadRuntimeModeInput = CommandInput<"thread.runtime-mode.set">;
export type SetThreadInteractionModeInput = CommandInput<"thread.interaction-mode.set">;
export type StartThreadTurnInput = CommandInput<"thread.turn.start">;
export type InterruptThreadTurnInput = CommandInput<"thread.turn.interrupt">;
export type RespondToThreadApprovalInput = CommandInput<"thread.approval.respond">;
export type RespondToThreadUserInputInput = CommandInput<"thread.user-input.respond">;
export type RevertThreadCheckpointInput = CommandInput<"thread.checkpoint.revert">;
export type StopThreadSessionInput = CommandInput<"thread.session.stop">;

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;
type CommandEffect = Effect.Effect<
  EnvironmentRpcSuccess<DispatchTag>,
  EnvironmentRpcFailure<DispatchTag> | EnvironmentRpcUnavailableError,
  Crypto.Crypto | EnvironmentSupervisor
>;

function commandId(input: { readonly commandId?: CommandId }) {
  return Effect.gen(function* () {
    if (input.commandId !== undefined) {
      return input.commandId;
    }
    const crypto = yield* Crypto.Crypto;
    return yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make));
  });
}

function timestampedCommandMetadata(input: {
  readonly commandId?: CommandId;
  readonly createdAt?: string;
}) {
  return Effect.all({
    commandId: commandId(input),
    createdAt:
      input.createdAt === undefined
        ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
        : Effect.succeed(input.createdAt),
  });
}

function dispatch(command: ClientOrchestrationCommand) {
  return request(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
}

export const createProject: (input: CreateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createProject",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "project.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const updateProject: (input: UpdateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.meta.update",
    commandId: yield* commandId(input),
  });
});

export const updateWorkspaceControl: (input: UpdateWorkspaceControlInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.updateWorkspaceControl")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "project.workspace-control.update",
      commandId: yield* commandId(input),
    });
  });

export const markWorkspaceRuntimeViewed: (input: MarkWorkspaceRuntimeViewedInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.markWorkspaceRuntimeViewed")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.runtime.view",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const upsertWorkspaceKnowledgeItem: (
  input: UpsertWorkspaceKnowledgeItemInput,
) => CommandEffect = Effect.fn("EnvironmentCommands.upsertWorkspaceKnowledgeItem")(
  function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.knowledge.item.upsert",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  },
);

export const archiveWorkspaceKnowledgeItem: (
  input: ArchiveWorkspaceKnowledgeItemInput,
) => CommandEffect = Effect.fn("EnvironmentCommands.archiveWorkspaceKnowledgeItem")(
  function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.knowledge.item.archive",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  },
);

export const upsertWorkspaceAgentRole: (input: UpsertWorkspaceAgentRoleInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.upsertWorkspaceAgentRole")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.agent-role.upsert",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const removeWorkspaceAgentRole: (input: RemoveWorkspaceAgentRoleInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.removeWorkspaceAgentRole")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.agent-role.remove",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const requestWorkspaceCollaborationRun: (
  input: RequestWorkspaceCollaborationRunInput,
) => CommandEffect = Effect.fn("EnvironmentCommands.requestWorkspaceCollaborationRun")(
  function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.collaboration.run.request",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  },
);

export const cancelWorkspaceCollaborationRun: (
  input: CancelWorkspaceCollaborationRunInput,
) => CommandEffect = Effect.fn("EnvironmentCommands.cancelWorkspaceCollaborationRun")(
  function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.collaboration.run.cancel",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  },
);

export const answerWorkspaceCollaborationRun: (
  input: AnswerWorkspaceCollaborationRunInput,
) => CommandEffect = Effect.fn("EnvironmentCommands.answerWorkspaceCollaborationRun")(
  function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.collaboration.run.answer",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  },
);

export const interjectWorkspaceCollaborationRun: (
  input: InterjectWorkspaceCollaborationRunInput,
) => CommandEffect = Effect.fn("EnvironmentCommands.interjectWorkspaceCollaborationRun")(
  function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.collaboration.run.interject",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  },
);

export const upsertWorkspaceSchedule: (input: UpsertWorkspaceScheduleInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.upsertWorkspaceSchedule")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.schedule.upsert",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const removeWorkspaceSchedule: (input: RemoveWorkspaceScheduleInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.removeWorkspaceSchedule")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.schedule.remove",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const upsertWorkspaceProgram: (input: UpsertWorkspaceProgramInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.upsertWorkspaceProgram")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.program.upsert",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });
export const removeWorkspaceProgram: (input: RemoveWorkspaceProgramInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.removeWorkspaceProgram")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.program.remove",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });
export const startWorkspaceProgram: (input: StartWorkspaceProgramInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.startWorkspaceProgram")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.program.start",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });
export const stopWorkspaceProgram: (input: StopWorkspaceProgramInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.stopWorkspaceProgram",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "project.program.stop",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});
export const restartWorkspaceProgram: (input: RestartWorkspaceProgramInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.restartWorkspaceProgram")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.program.restart",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });
export const startWorkspaceProgramIntegrity: (
  input: StartWorkspaceProgramIntegrityInput,
) => CommandEffect = Effect.fn("EnvironmentCommands.startWorkspaceProgramIntegrity")(
  function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.program.integrity.start",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  },
);
export const stopWorkspaceProgramIntegrity: (
  input: StopWorkspaceProgramIntegrityInput,
) => CommandEffect = Effect.fn("EnvironmentCommands.stopWorkspaceProgramIntegrity")(
  function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.program.integrity.stop",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  },
);
export const requestWorkspaceIncidentRepair: (
  input: RequestWorkspaceIncidentRepairInput,
) => CommandEffect = Effect.fn("EnvironmentCommands.requestWorkspaceIncidentRepair")(
  function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.program.incident.repair.request",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  },
);
export const resolveWorkspaceIncident: (input: ResolveWorkspaceIncidentInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.resolveWorkspaceIncident")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "project.program.incident.resolve",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const deleteProject: (input: DeleteProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.delete",
    commandId: yield* commandId(input),
  });
});

export const createThread: (input: CreateThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createThread",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const deleteThread: (input: DeleteThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.delete",
    commandId: yield* commandId(input),
  });
});

export const archiveThread: (input: ArchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.archiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.archive",
    commandId: yield* commandId(input),
  });
});

export const unarchiveThread: (input: UnarchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unarchiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unarchive",
    commandId: yield* commandId(input),
  });
});

export const settleThread: (input: SettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.settleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.settle",
    commandId: yield* commandId(input),
  });
});

export const unsettleThread: (input: UnsettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsettleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsettle",
    commandId: yield* commandId(input),
  });
});

export const snoozeThread: (input: SnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.snoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.snooze",
    commandId: yield* commandId(input),
  });
});

export const unsnoozeThread: (input: UnsnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsnoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsnooze",
    commandId: yield* commandId(input),
  });
});

export const pinThread: (input: PinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.pinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin",
    commandId: yield* commandId(input),
  });
});

export const unpinThread: (input: UnpinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unpinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unpin",
    commandId: yield* commandId(input),
  });
});

export const reorderPinnedThread: (input: ReorderPinnedThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderPinnedThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin.reorder",
    commandId: yield* commandId(input),
  });
});

export const updateThreadMetadata: (input: UpdateThreadMetadataInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateThreadMetadata",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.meta.update",
    commandId: yield* commandId(input),
  });
});

export const setThreadRuntimeMode: (input: SetThreadRuntimeModeInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setThreadRuntimeMode",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.runtime-mode.set",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const setThreadInteractionMode: (input: SetThreadInteractionModeInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.setThreadInteractionMode")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.interaction-mode.set",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const startThreadTurn: (input: StartThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.startThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.start",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const interruptThreadTurn: (input: InterruptThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.interruptThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.interrupt",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const respondToThreadApproval: (input: RespondToThreadApprovalInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadApproval")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.approval.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const respondToThreadUserInput: (input: RespondToThreadUserInputInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadUserInput")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.user-input.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const revertThreadCheckpoint: (input: RevertThreadCheckpointInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.revertThreadCheckpoint")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.checkpoint.revert",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const stopThreadSession: (input: StopThreadSessionInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.stopThreadSession",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.session.stop",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});
