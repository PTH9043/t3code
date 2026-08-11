import {
  ORCHESTRATION_WS_METHODS,
  type WorkspaceKnowledgeListInput,
  type WorkspacePromptComposeInput,
  type WorkspaceRagSearchInput,
  type WorkspaceAgentRoleListInput,
  type WorkspaceCollaborationRunListInput,
  type WorkspaceScheduleListInput,
  type WorkspaceProgramListInput,
  type WorkspaceProgramRunListInput,
  type WorkspaceIncidentListInput,
  type WorkspaceRuntimeSnapshotInput,
} from "@t3tools/contracts";

import { request } from "../rpc/client.ts";

/** Query knowledge for one explicit Workspace. There is intentionally no global list operation. */
export const listWorkspaceKnowledge = (input: WorkspaceKnowledgeListInput) =>
  request(ORCHESTRATION_WS_METHODS.listWorkspaceKnowledge, input);

/** Retrieve derived context from one explicit Workspace only. */
export const searchWorkspaceRag = (input: WorkspaceRagSearchInput) =>
  request(ORCHESTRATION_WS_METHODS.searchWorkspaceRag, input);

/** Compose one Workspace's directives, goals, prompts, memory, and RAG context. */
export const composeWorkspacePrompt = (input: WorkspacePromptComposeInput) =>
  request(ORCHESTRATION_WS_METHODS.composeWorkspacePrompt, input);

/** List role/account bindings owned by one explicit Workspace. */
export const listWorkspaceAgentRoles = (input: WorkspaceAgentRoleListInput) =>
  request(ORCHESTRATION_WS_METHODS.listWorkspaceAgentRoles, input);

/** List durable collaboration runs for one Workspace. */
export const listWorkspaceCollaborationRuns = (input: WorkspaceCollaborationRunListInput) =>
  request(ORCHESTRATION_WS_METHODS.listWorkspaceCollaborationRuns, input);

/** List unattended schedules for one Workspace. */
export const listWorkspaceSchedules = (input: WorkspaceScheduleListInput) =>
  request(ORCHESTRATION_WS_METHODS.listWorkspaceSchedules, input);

export const discoverWorkspacePrograms = (input: WorkspaceProgramListInput) =>
  request(ORCHESTRATION_WS_METHODS.discoverWorkspacePrograms, input);

export const listWorkspacePrograms = (input: WorkspaceProgramListInput) =>
  request(ORCHESTRATION_WS_METHODS.listWorkspacePrograms, input);

export const listWorkspaceProgramRuns = (input: WorkspaceProgramRunListInput) =>
  request(ORCHESTRATION_WS_METHODS.listWorkspaceProgramRuns, input);

export const listWorkspaceIncidents = (input: WorkspaceIncidentListInput) =>
  request(ORCHESTRATION_WS_METHODS.listWorkspaceIncidents, input);

/** Derive the current operating state and evidence for one explicit Workspace. */
export const getWorkspaceRuntime = (input: WorkspaceRuntimeSnapshotInput) =>
  request(ORCHESTRATION_WS_METHODS.getWorkspaceRuntime, input);
