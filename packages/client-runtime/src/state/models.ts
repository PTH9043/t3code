import type {
  EnvironmentId,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

export interface EnvironmentProject extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

export interface EnvironmentThreadShell extends OrchestrationThreadShell {
  readonly environmentId: EnvironmentId;
}

export type EnvironmentMessage = OrchestrationMessage;

export interface EnvironmentThread extends OrchestrationThread {
  readonly environmentId: EnvironmentId;
}

export function scopeProject(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentProject {
  return { ...project, environmentId };
}

export function scopeThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThreadShell,
): EnvironmentThreadShell {
  return { ...thread, environmentId };
}

export function scopeThread(
  environmentId: EnvironmentId,
  thread: OrchestrationThread,
): EnvironmentThread {
  return { ...thread, environmentId };
}

/**
 * Whether a conversation is one an orchestra run executes a node in. A run
 * needs a provider session per parallel node, and a session needs a
 * conversation — so these exist for the run's machinery, not because the person
 * started them. Every conversation list leaves them out; the run's own
 * conversation is where they are listed and opened.
 */
export function isOrchestraNodeThread(thread: {
  readonly orchestraRunThreadId?: ThreadId | null | undefined;
}): boolean {
  return (thread.orchestraRunThreadId ?? null) !== null;
}

export function selectEnvironmentThreadShell(
  snapshot: OrchestrationShellSnapshot | null,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): EnvironmentThreadShell | null {
  const thread = snapshot?.threads.find((candidate) => candidate.id === threadId) ?? null;
  return thread ? scopeThreadShell(environmentId, thread) : null;
}
