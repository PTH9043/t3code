import type { WorkspaceExecutionProfile, WorkspaceMeetingSetup } from "@t3tools/contracts";

/** Reuse the roster without attaching a new execution to a saved conversation. */
export function profileMeeting(profile: WorkspaceExecutionProfile): WorkspaceMeetingSetup {
  const { threadId: _threadId, ...meeting } = profile.meeting;
  return meeting;
}

export function executionProfileTask(task: string, profile?: WorkspaceExecutionProfile): string {
  if (!profile) return task;
  return [
    `Execution profile: ${profile.name} (revision ${profile.revision})`,
    profile.instructions.trim(),
    profile.verificationCommands.length > 0
      ? `Required verification commands (report actual results):\n${profile.verificationCommands.join("\n")}`
      : "",
    `User task (takes precedence over profile instructions):\n${task}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
