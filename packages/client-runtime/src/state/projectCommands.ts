import { type EnvironmentId, type ProjectReadFileResult, WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import {
  type ArchiveWorkspaceKnowledgeItemInput,
  type CancelWorkspaceCollaborationRunInput,
  type CreateProjectInput,
  type DeleteProjectInput,
  type RemoveWorkspaceAgentRoleInput,
  type RemoveWorkspaceScheduleInput,
  type RequestWorkspaceCollaborationRunInput,
  type UpdateProjectInput,
  type UpdateWorkspaceControlInput,
  type MarkWorkspaceRuntimeViewedInput,
  type UpsertWorkspaceAgentRoleInput,
  type UpsertWorkspaceKnowledgeItemInput,
  type UpsertWorkspaceScheduleInput,
  type UpsertWorkspaceProgramInput,
  type RemoveWorkspaceProgramInput,
  type StartWorkspaceProgramInput,
  type StopWorkspaceProgramInput,
  type RestartWorkspaceProgramInput,
  type StartWorkspaceProgramIntegrityInput,
  type StopWorkspaceProgramIntegrityInput,
  type RequestWorkspaceIncidentRepairInput,
  type ResolveWorkspaceIncidentInput,
  archiveWorkspaceKnowledgeItem,
  cancelWorkspaceCollaborationRun,
  createProject,
  deleteProject,
  removeWorkspaceAgentRole,
  removeWorkspaceSchedule,
  requestWorkspaceCollaborationRun,
  updateProject,
  updateWorkspaceControl,
  markWorkspaceRuntimeViewed,
  upsertWorkspaceAgentRole,
  upsertWorkspaceKnowledgeItem,
  upsertWorkspaceSchedule,
  upsertWorkspaceProgram,
  removeWorkspaceProgram,
  startWorkspaceProgram,
  stopWorkspaceProgram,
  restartWorkspaceProgram,
  startWorkspaceProgramIntegrity,
  stopWorkspaceProgramIntegrity,
  requestWorkspaceIncidentRepair,
  resolveWorkspaceIncident,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateWorkspaceControlInput,
  MarkWorkspaceRuntimeViewedInput,
  UpsertWorkspaceKnowledgeItemInput,
  ArchiveWorkspaceKnowledgeItemInput,
  UpsertWorkspaceAgentRoleInput,
  RemoveWorkspaceAgentRoleInput,
  RequestWorkspaceCollaborationRunInput,
  CancelWorkspaceCollaborationRunInput,
  UpsertWorkspaceScheduleInput,
  RemoveWorkspaceScheduleInput,
  UpsertWorkspaceProgramInput,
  RemoveWorkspaceProgramInput,
  StartWorkspaceProgramInput,
  StopWorkspaceProgramInput,
  RestartWorkspaceProgramInput,
  StartWorkspaceProgramIntegrityInput,
  StopWorkspaceProgramIntegrityInput,
  RequestWorkspaceIncidentRepairInput,
  ResolveWorkspaceIncidentInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  return {
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    updateWorkspaceControl: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update-workspace-control",
      execute: (input: UpdateWorkspaceControlInput) => updateWorkspaceControl(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    markWorkspaceRuntimeViewed: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:mark-workspace-runtime-viewed",
      execute: (input: MarkWorkspaceRuntimeViewedInput) => markWorkspaceRuntimeViewed(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    upsertWorkspaceKnowledgeItem: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:upsert-workspace-knowledge-item",
      execute: (input: UpsertWorkspaceKnowledgeItemInput) => upsertWorkspaceKnowledgeItem(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    archiveWorkspaceKnowledgeItem: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:archive-workspace-knowledge-item",
      execute: (input: ArchiveWorkspaceKnowledgeItemInput) => archiveWorkspaceKnowledgeItem(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    upsertWorkspaceAgentRole: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:upsert-workspace-agent-role",
      execute: (input: UpsertWorkspaceAgentRoleInput) => upsertWorkspaceAgentRole(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    removeWorkspaceAgentRole: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:remove-workspace-agent-role",
      execute: (input: RemoveWorkspaceAgentRoleInput) => removeWorkspaceAgentRole(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    requestWorkspaceCollaborationRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:request-workspace-collaboration-run",
      execute: (input: RequestWorkspaceCollaborationRunInput) =>
        requestWorkspaceCollaborationRun(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    cancelWorkspaceCollaborationRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:cancel-workspace-collaboration-run",
      execute: (input: CancelWorkspaceCollaborationRunInput) =>
        cancelWorkspaceCollaborationRun(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    upsertWorkspaceSchedule: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:upsert-workspace-schedule",
      execute: (input: UpsertWorkspaceScheduleInput) => upsertWorkspaceSchedule(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    removeWorkspaceSchedule: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:remove-workspace-schedule",
      execute: (input: RemoveWorkspaceScheduleInput) => removeWorkspaceSchedule(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    upsertWorkspaceProgram: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:upsert-workspace-program",
      execute: (input: UpsertWorkspaceProgramInput) => upsertWorkspaceProgram(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    removeWorkspaceProgram: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:remove-workspace-program",
      execute: (input: RemoveWorkspaceProgramInput) => removeWorkspaceProgram(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    startWorkspaceProgram: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:start-workspace-program",
      execute: (input: StartWorkspaceProgramInput) => startWorkspaceProgram(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    stopWorkspaceProgram: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:stop-workspace-program",
      execute: (input: StopWorkspaceProgramInput) => stopWorkspaceProgram(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    restartWorkspaceProgram: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:restart-workspace-program",
      execute: (input: RestartWorkspaceProgramInput) => restartWorkspaceProgram(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    startWorkspaceProgramIntegrity: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:start-workspace-program-integrity",
      execute: (input: StartWorkspaceProgramIntegrityInput) =>
        startWorkspaceProgramIntegrity(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    stopWorkspaceProgramIntegrity: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:stop-workspace-program-integrity",
      execute: (input: StopWorkspaceProgramIntegrityInput) => stopWorkspaceProgramIntegrity(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    requestWorkspaceIncidentRepair: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:request-workspace-incident-repair",
      execute: (input: RequestWorkspaceIncidentRepairInput) =>
        requestWorkspaceIncidentRepair(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    resolveWorkspaceIncident: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:resolve-workspace-incident",
      execute: (input: ResolveWorkspaceIncidentInput) => resolveWorkspaceIncident(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
  };
}
