import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    threadTokenUsage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-token-usage",
      tag: ORCHESTRATION_WS_METHODS.getThreadTokenUsage,
      staleTimeMs: 1_000,
    }),
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
    workspaceKnowledge: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-knowledge",
      tag: ORCHESTRATION_WS_METHODS.listWorkspaceKnowledge,
      staleTimeMs: 1_000,
    }),
    workspaceRag: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-rag",
      tag: ORCHESTRATION_WS_METHODS.searchWorkspaceRag,
      staleTimeMs: 1_000,
    }),
    workspacePrompt: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-prompt",
      tag: ORCHESTRATION_WS_METHODS.composeWorkspacePrompt,
      staleTimeMs: 1_000,
    }),
    workspaceAgentRoles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-agent-roles",
      tag: ORCHESTRATION_WS_METHODS.listWorkspaceAgentRoles,
      staleTimeMs: 1_000,
    }),
    workspaceCollaborationRuns: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-collaboration-runs",
      tag: ORCHESTRATION_WS_METHODS.listWorkspaceCollaborationRuns,
      staleTimeMs: 1_000,
    }),
    workspaceSchedules: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-schedules",
      tag: ORCHESTRATION_WS_METHODS.listWorkspaceSchedules,
      staleTimeMs: 1_000,
    }),
    workspaceRuntime: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-runtime",
      tag: ORCHESTRATION_WS_METHODS.subscribeWorkspaceRuntime,
    }),
    workspaceProgramCandidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-program-candidates",
      tag: ORCHESTRATION_WS_METHODS.discoverWorkspacePrograms,
      staleTimeMs: 30_000,
    }),
    workspacePrograms: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-programs",
      tag: ORCHESTRATION_WS_METHODS.listWorkspacePrograms,
      staleTimeMs: 500,
    }),
    workspaceProgramRuns: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-program-runs",
      tag: ORCHESTRATION_WS_METHODS.listWorkspaceProgramRuns,
      staleTimeMs: 500,
    }),
    workspaceIncidents: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workspace-incidents",
      tag: ORCHESTRATION_WS_METHODS.listWorkspaceIncidents,
      staleTimeMs: 500,
    }),
    cleanupWorkspaceWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:orchestration:cleanup-workspace-worktree",
      tag: ORCHESTRATION_WS_METHODS.cleanupWorkspaceWorktree,
    }),
    sharedLibraryStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:shared-library-status",
      tag: ORCHESTRATION_WS_METHODS.getSharedLibraryStatus,
      staleTimeMs: 2_000,
    }),
    syncSharedLibrary: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:orchestration:sync-shared-library",
      tag: ORCHESTRATION_WS_METHODS.syncSharedLibrary,
    }),
  };
}
