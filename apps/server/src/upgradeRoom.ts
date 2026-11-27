// @effect-diagnostics-next-line nodeBuiltinImport:off -- Launcher paths use Windows semantics, including in cross-platform tests.
import { win32 } from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import {
  CommandId,
  ProjectId,
  ThreadId,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WORKSPACE_DEVELOPMENT_WS_METHODS,
  WORKSPACE_WORKFLOW_WS_METHODS,
  WORKSPACE_MEMORY_WS_METHODS,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

export const upgradeRoomIds = {
  projectId: ProjectId.make("autousage-upgrade-project"),
  threadId: ThreadId.make("autousage-upgrade-room"),
};
export const upgradeProjectCommandId = CommandId.make("bootstrap:autousage-upgrade-project");

export function resolveUpgradeRoom(
  root: string | undefined,
  primary: string | undefined,
  baseDir: string,
  explicitHome: boolean,
) {
  if (root === undefined && primary === undefined) return undefined;
  const projectRoot = "D:/__NewAutoUsage";
  const primaryHome = "E:/NewAutoUsage";
  const same = (a: string, b: string) => win32.relative(a, b) === "";
  const absoluteDrive = (p: string) => /^[a-z]:[/\\]/i.test(p);
  if (
    !root ||
    !primary ||
    !absoluteDrive(root) ||
    !absoluteDrive(primary) ||
    !same(root, projectRoot) ||
    !same(primary, primaryHome)
  )
    throw new Error("Invalid dedicated upgrade project or primary home.");
  if (
    !explicitHome ||
    !absoluteDrive(baseDir) ||
    !same(baseDir, win32.join(primaryHome, "upgrade-room"))
  )
    throw new Error("An independent explicit T3 home is required for the upgrade room.");
  return { projectRoot, primaryHome };
}

/** Validate existing state paths before creating files, including a redirected SQLite WAL. */
export const verifyUpgradePaths = Effect.fn("verifyUpgradePaths")(function* (
  projectRoot: string,
  primaryHome: string,
  statePaths: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const target of [projectRoot, primaryHome, ...statePaths]) {
    // The roots must exist. The launcher can start the room with a fresh data directory.
    if (target !== projectRoot && target !== primaryHome && !(yield* fs.exists(target))) continue;
    const resolved = yield* fs.realPath(target);
    const info = yield* fs.stat(target);
    if (
      path.relative(target, resolved) !== "" ||
      (info.type === "File" && Option.getOrElse(info.nlink, () => 1) !== 1)
    )
      return yield* Effect.die(new Error("The upgrade room path is redirected."));
  }
});

export function validUpgradeState(
  state: Pick<OrchestrationReadModel, "projects" | "threads">,
  root: string,
) {
  return (
    state.projects.every(
      (p) =>
        p.id === upgradeRoomIds.projectId &&
        !p.deletedAt &&
        win32.relative(p.workspaceRoot, root) === "",
    ) &&
    state.threads.every(
      (t) =>
        t.id === upgradeRoomIds.threadId &&
        t.projectId === upgradeRoomIds.projectId &&
        !t.deletedAt &&
        !t.archivedAt &&
        !t.worktreePath &&
        !t.orchestraRunThreadId,
    )
  );
}

export function upgradeRoomAllowsCommand(
  command: ClientOrchestrationCommand | OrchestrationCommand,
  internal = false,
) {
  if (
    internal &&
    "projectId" in command &&
    command.projectId === upgradeRoomIds.projectId &&
    (command.type === "project.knowledge.item.upsert" ||
      command.type === "project.knowledge.item.archive" ||
      command.type === "project.knowledge.usage.record")
  )
    return true;
  if (!("threadId" in command) || command.threadId !== upgradeRoomIds.threadId) return false;
  switch (command.type) {
    case "thread.create":
      return (
        command.projectId === upgradeRoomIds.projectId &&
        !command.importedConversation &&
        !command.orchestraRunThreadId &&
        command.worktreePath === null &&
        command.branch === null
      );
    case "thread.turn.start":
      return (
        !!command.modelSelection &&
        !command.bootstrap &&
        command.inputOrigin !== "automation" &&
        !command.desktopAssistantCharacter &&
        (!command.sourceProposedPlan || command.sourceProposedPlan.threadId === command.threadId)
      );
    case "thread.meta.update":
      return !command.worktreePath && !command.regenerateTitle;
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.turn.interrupt":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.session.stop":
    case "thread.checkpoint.revert":
      return true;
    case "thread.session.set":
    case "thread.message.assistant.delta":
    case "thread.message.assistant.complete":
    case "thread.proposed-plan.upsert":
    case "thread.turn.diff.complete":
    case "thread.activity.append":
    case "thread.revert.complete":
      return internal;
    default:
      return false;
  }
}

export function upgradeModelAvailable(
  selection: ModelSelection,
  providers: readonly ServerProvider[],
) {
  return providers.some(
    (p) =>
      p.instanceId === selection.instanceId &&
      p.enabled &&
      p.installed &&
      p.availability !== "unavailable" &&
      p.status !== "error" &&
      p.status !== "disabled" &&
      p.auth.status !== "unauthenticated" &&
      p.models.some((m) => m.slug === selection.model),
  );
}

const roomMethods = new Set<string>([
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  ORCHESTRATION_WS_METHODS.checkTurnReceipt,
  ORCHESTRATION_WS_METHODS.subscribeShell,
  ORCHESTRATION_WS_METHODS.subscribeThread,
  ORCHESTRATION_WS_METHODS.getThreadTokenUsage,
  ORCHESTRATION_WS_METHODS.getTurnDiff,
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.serverGetConfig,
  WS_METHODS.serverProbe,
  WS_METHODS.serverGetSettings,
  WS_METHODS.serverGetBackgroundPolicy,
  WS_METHODS.subscribeBackgroundPolicy,
  WS_METHODS.serverReportClientActivity,
  WS_METHODS.projectsReadFile,
  WS_METHODS.projectsWriteFile,
  WS_METHODS.projectsSearchContents,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.projectsReadT3File,
  WS_METHODS.projectsListEntries,
  WS_METHODS.subscribeVcsStatus,
  WS_METHODS.vcsRefreshStatus,
  WS_METHODS.vcsListRefs,
  WS_METHODS.terminalOpen,
  WS_METHODS.terminalAttach,
  WS_METHODS.terminalClear,
  WS_METHODS.terminalWrite,
  WS_METHODS.terminalResize,
  WS_METHODS.terminalClose,
  WS_METHODS.terminalRestart,
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeTerminalMetadata,
  WS_METHODS.assetsCreateUrl,
  WS_METHODS.subscribeResourceTelemetry,
  ORCHESTRATION_WS_METHODS.listWorkspaceCollaborationRuns,
  ORCHESTRATION_WS_METHODS.getWorkspaceRuntime,
  ORCHESTRATION_WS_METHODS.subscribeWorkspaceRuntime,
  ORCHESTRATION_WS_METHODS.listWorkspaceKnowledge,
  ORCHESTRATION_WS_METHODS.searchWorkspaceRag,
  ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeDashboard,
  ORCHESTRATION_WS_METHODS.listWorkspaceKnowledgeRevisions,
  ORCHESTRATION_WS_METHODS.getWorkspaceKnowledgeRevision,
  ORCHESTRATION_WS_METHODS.composeWorkspacePrompt,
  ORCHESTRATION_WS_METHODS.getWorkspaceWikiLinks,
  WORKSPACE_DEVELOPMENT_WS_METHODS.get,
  WORKSPACE_WORKFLOW_WS_METHODS.chatSkills,
  WORKSPACE_MEMORY_WS_METHODS.forgetMessage,
  WORKSPACE_MEMORY_WS_METHODS.remember,
]);

export function upgradeRoomAllowsRpc(method: string, input: unknown, root: string) {
  if (!roomMethods.has(method)) return false;
  if (typeof input !== "object" || !input) return true;
  if ("resource" in input) return upgradeRoomAllowsRpc(method, input.resource, root);
  if (
    ("includeShared" in input && input.includeShared === true) ||
    ("includeSharedLibrary" in input && input.includeSharedLibrary === true)
  )
    return false;
  if (
    "cwd" in input &&
    (typeof input.cwd !== "string" ||
      !win32.isAbsolute(input.cwd) ||
      win32.relative(input.cwd, root) !== "")
  )
    return false;
  if ("worktreePath" in input && input.worktreePath != null) return false;
  return (
    (!("threadId" in input) || input.threadId === upgradeRoomIds.threadId) &&
    (!("projectId" in input) || input.projectId === upgradeRoomIds.projectId)
  );
}
