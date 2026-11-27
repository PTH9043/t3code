import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "~/connection/runtime";

export const wikiLinks = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.getWorkspaceWikiLinks,
  label: "knowledge:links",
  idleTtlMs: 0,
});
export const wikiRevisions = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.listWorkspaceKnowledgeRevisions,
  label: "knowledge:revisions",
  idleTtlMs: 0,
});
export const wikiRevision = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeRevision,
  label: "knowledge:revision",
  idleTtlMs: 0,
});
export const editWikiDocument = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.editWorkspaceKnowledge,
  label: "knowledge:edit",
});
export const restoreWikiDocument = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: ORCHESTRATION_WS_METHODS.restoreWorkspaceKnowledge,
  label: "knowledge:restore",
});
