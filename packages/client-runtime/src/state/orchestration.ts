import {
  COUNCIL_WS_METHODS,
  MISSION_CONTROL_WS_METHODS,
  WORKSPACE_WORKFLOW_WS_METHODS,
} from "@t3tools/contracts";
import {
  WORKSPACE_AGENT_CONTROL_WS_METHODS,
  WORKSPACE_TASK_INBOX_WS_METHODS,
} from "@t3tools/contracts";
import {
  ORCHESTRATION_WS_METHODS,
  WORKSPACE_DEVELOPMENT_WS_METHODS,
  WORKSPACE_AUTOMATION_WS_METHODS,
  WORKSPACE_RESEARCH_WS_METHODS,
} from "@t3tools/contracts";
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
    workflowRun: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow-run",
      tag: WORKSPACE_WORKFLOW_WS_METHODS.getRun,
      idleTtlMs: 0,
    }),
    councilStream: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:council-stream",
      tag: COUNCIL_WS_METHODS.subscribe,
    }),
    threadCouncilSessions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:council-sessions",
      tag: COUNCIL_WS_METHODS.listThreadSessions,
      staleTimeMs: 1_000,
    }),
    councilTriage: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:council:triage",
      tag: COUNCIL_WS_METHODS.triage,
    }),
    startCouncilAutoSeat: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:council:start-auto-seat",
      tag: COUNCIL_WS_METHODS.startAutoSeat,
    }),
    approveCouncilOverride: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:council:approve-override",
      tag: COUNCIL_WS_METHODS.approveOverride,
    }),
    executeCouncilPinnedSpec: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:council:execute-pinned-spec",
      tag: COUNCIL_WS_METHODS.executePinnedSpec,
    }),
    reverifyCouncilPinnedSpec: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:council:reverify-pinned-spec",
      tag: COUNCIL_WS_METHODS.reverifyPinnedSpec,
    }),
    abortCouncil: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:council:abort",
      tag: COUNCIL_WS_METHODS.abort,
    }),
    missionControlSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mission-control:snapshot",
      tag: MISSION_CONTROL_WS_METHODS.getSnapshot,
      staleTimeMs: 1_000,
    }),
    missionControlStream: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:mission-control:stream",
      tag: MISSION_CONTROL_WS_METHODS.subscribe,
    }),
    createMission: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:create",
      tag: MISSION_CONTROL_WS_METHODS.createMission,
    }),
    cancelMission: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:cancel",
      tag: MISSION_CONTROL_WS_METHODS.cancelMission,
    }),
    deleteMission: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:delete",
      tag: MISSION_CONTROL_WS_METHODS.deleteMission,
    }),
    decideMissionApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:decide-approval",
      tag: MISSION_CONTROL_WS_METHODS.decideApproval,
    }),
    upsertMissionCrewRole: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:upsert-crew",
      tag: MISSION_CONTROL_WS_METHODS.upsertCrewRole,
    }),
    deleteMissionCrewRole: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:delete-crew",
      tag: MISSION_CONTROL_WS_METHODS.deleteCrewRole,
    }),
    startMissionSyncMeeting: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:sync-meeting",
      tag: MISSION_CONTROL_WS_METHODS.startSyncMeeting,
    }),
    startRoundtableMeeting: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:start-roundtable-meeting",
      tag: MISSION_CONTROL_WS_METHODS.startRoundtableMeeting,
    }),
    cancelMissionMeeting: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:cancel-meeting",
      tag: MISSION_CONTROL_WS_METHODS.cancelMeeting,
    }),
    deleteMissionMeeting: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:delete-meeting",
      tag: MISSION_CONTROL_WS_METHODS.deleteMeeting,
    }),
    promoteMeetingToMission: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:promote-meeting",
      tag: MISSION_CONTROL_WS_METHODS.promoteMeetingToMission,
    }),
    setMissionSynapsePruned: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:set-synapse-pruned",
      tag: MISSION_CONTROL_WS_METHODS.setSynapsePruned,
    }),
    setMissionKillSwitch: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:kill-switch",
      tag: MISSION_CONTROL_WS_METHODS.killSwitch,
    }),
    generateMissionDigestNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:digest-now",
      tag: MISSION_CONTROL_WS_METHODS.generateDigestNow,
    }),
    runMissionHeartbeatCheck: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:heartbeat",
      tag: MISSION_CONTROL_WS_METHODS.runHeartbeatCheck,
    }),
    inspectMissionArtifact: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mission-control:inspect-artifact",
      tag: MISSION_CONTROL_WS_METHODS.inspectArtifact,
    }),
    workspaceWorkflows: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflows",
      tag: WORKSPACE_WORKFLOW_WS_METHODS.overview,
      staleTimeMs: 1_000,
    }),
    workflowSkills: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow-skills",
      tag: WORKSPACE_WORKFLOW_WS_METHODS.skills,
      idleTtlMs: 0,
    }),
    chatProjectSkills: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:chat-project-skills",
      tag: WORKSPACE_WORKFLOW_WS_METHODS.chatSkills,
      idleTtlMs: 0,
    }),
    saveWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workflow:save",
      tag: WORKSPACE_WORKFLOW_WS_METHODS.save,
    }),
    previewWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workflow:preview",
      tag: WORKSPACE_WORKFLOW_WS_METHODS.preview,
    }),
    startWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workflow:start",
      tag: WORKSPACE_WORKFLOW_WS_METHODS.start,
    }),
    controlWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workflow:control",
      tag: WORKSPACE_WORKFLOW_WS_METHODS.control,
    }),
    workspaceAttention: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:attention",
      tag: WORKSPACE_AGENT_CONTROL_WS_METHODS.attention,
    }),
    workspaceAgentControl: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agent-control",
      tag: WORKSPACE_AGENT_CONTROL_WS_METHODS.subscribe,
    }),
    actOnAgentControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:agent-control",
      tag: WORKSPACE_AGENT_CONTROL_WS_METHODS.action,
    }),
    agentControlEvidence: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-control:evidence",
      tag: WORKSPACE_AGENT_CONTROL_WS_METHODS.evidence,
      idleTtlMs: 0,
    }),
    taskInbox: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:task-inbox",
      tag: WORKSPACE_TASK_INBOX_WS_METHODS.subscribe,
    }),
    taskInboxTask: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:task-inbox:task",
      tag: WORKSPACE_TASK_INBOX_WS_METHODS.get,
      staleTimeMs: 1000,
      idleTtlMs: 0,
    }),
    saveTaskRecipe: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:task-inbox:recipe",
      tag: WORKSPACE_TASK_INBOX_WS_METHODS.saveRecipe,
    }),
    submitInboxTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:task-inbox:submit",
      tag: WORKSPACE_TASK_INBOX_WS_METHODS.submit,
    }),
    actOnInboxTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:task-inbox:action",
      tag: WORKSPACE_TASK_INBOX_WS_METHODS.action,
    }),
    workspaceResearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workspace-research",
      tag: WORKSPACE_RESEARCH_WS_METHODS.status,
      staleTimeMs: 1_000,
    }),
    runWorkspaceResearch: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workspace-research:run",
      tag: WORKSPACE_RESEARCH_WS_METHODS.run,
    }),
    configureResearchKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workspace-research:key",
      tag: WORKSPACE_RESEARCH_WS_METHODS.configureKey,
    }),
    workspaceAutomation: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workspace-automation",
      tag: WORKSPACE_AUTOMATION_WS_METHODS.overview,
      staleTimeMs: 1_000,
    }),
    workspaceAutomationEvidence: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workspace-automation:evidence",
      tag: WORKSPACE_AUTOMATION_WS_METHODS.evidence,
      idleTtlMs: 0,
    }),
    developmentGoal: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workspace-development:goal",
      tag: WORKSPACE_DEVELOPMENT_WS_METHODS.goal,
    }),
    workspaceDevelopment: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:workspace-development",
      tag: WORKSPACE_DEVELOPMENT_WS_METHODS.subscribe,
    }),
    configureDevelopment: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workspace-development:configure",
      tag: WORKSPACE_DEVELOPMENT_WS_METHODS.configure,
    }),
    directDevelopmentInput: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workspace-development:direct",
      tag: WORKSPACE_DEVELOPMENT_WS_METHODS.directInput,
    }),
    returnDevelopmentControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workspace-development:return",
      tag: WORKSPACE_DEVELOPMENT_WS_METHODS.returnControl,
    }),
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
    exportWorkspaceKnowledge: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:orchestration:export-workspace-knowledge",
      tag: ORCHESTRATION_WS_METHODS.listWorkspaceKnowledge,
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
