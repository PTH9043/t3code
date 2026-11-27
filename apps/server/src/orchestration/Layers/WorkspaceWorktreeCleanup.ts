import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import {
  CommandId,
  OrchestrationWorktreeCleanupError,
  type ProjectId,
  type ThreadId,
  type WorkspaceCollaborationRun,
  type WorkspaceWorktreeCleanupInput,
  type WorkspaceWorktreeCleanupResult,
} from "@t3tools/contracts";
import { isOrchestraWorktreeBranch } from "@t3tools/shared/git";
import { cleanupProjectScript, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { WorktreeProvisionService } from "../../git/WorktreeProvisionService.ts";
import * as ReviewService from "../../review/ReviewService.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const REMOVE_ATTEMPTS = 3;
const REMOVE_RETRY_DELAY = "400 millis" as const;

/**
 * De-provisions orchestra write-chain worktrees (D7 lifecycle):
 * stop sessions → close terminals → remove the worktree (with a Windows
 * EBUSY/EPERM retry) → point the threads back at the project root → delete
 * the threads' checkpoint refs so the shared ref store does not accumulate
 * forever.
 *
 * A worktree still holding unmerged work is kept (`kept-dirty`), because a
 * pre-merge worktree having a diff is the normal state — the dashboard shows
 * it as awaiting review instead of deleting the person's changes.
 */
export class WorkspaceWorktreeCleanup extends Context.Service<
  WorkspaceWorktreeCleanup,
  {
    /** Clean one worktree of a run. `force` removes even a dirty worktree. */
    readonly cleanupWorktree: (input: {
      readonly run: WorkspaceCollaborationRun;
      readonly worktreePath: string;
      readonly force: boolean;
    }) => Effect.Effect<WorkspaceWorktreeCleanupResult, OrchestrationWorktreeCleanupError>;
    /** RPC entry: resolve the run from its ref, then clean one worktree. */
    readonly cleanupByRef: (
      input: WorkspaceWorktreeCleanupInput,
    ) => Effect.Effect<WorkspaceWorktreeCleanupResult, OrchestrationWorktreeCleanupError>;
    /** Best-effort cleanup of every worktree a terminal run left behind. */
    readonly cleanupRunWorktrees: (run: WorkspaceCollaborationRun) => Effect.Effect<void>;
    /**
     * Startup sweep: reconcile `t3code/orch-` worktrees against live runs and
     * reclaim the orphans a crash kept the live-event cleanup from seeing.
     */
    readonly sweepOrphans: () => Effect.Effect<void>;
  }
>()("t3/orchestration/Layers/WorkspaceWorktreeCleanup") {}

export const make = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const review = yield* ReviewService.ReviewService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const runRepository = yield* ProjectionWorkspaceCollaborationRunRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const worktreeProvisionOpt = yield* Effect.serviceOption(WorktreeProvisionService);
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  // One teardown at a time: parallel `git worktree remove` calls fight over
  // the repository lock, and a sweep may fire while a run-terminal cleanup runs.
  const cleanupLock = yield* Semaphore.make(1);

  const cleanupError = (message: string, cause?: unknown) =>
    new OrchestrationWorktreeCleanupError(cause === undefined ? { message } : { message, cause });

  const directoryExists = (path: string) =>
    fileSystem.stat(path).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const bestEffort = <A, E>(label: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`WorkspaceWorktreeCleanup: ${label} failed`, { cause }),
      ),
      Effect.asVoid,
    );

  const threadsForWorktree = Effect.fn("WorkspaceWorktreeCleanup.threadsForWorktree")(function* (
    worktreePath: string,
  ) {
    const shell = yield* projectionSnapshotQuery
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => cleanupError("Failed to load the thread snapshot.", cause)));
    return shell.threads
      .filter((thread) => thread.worktreePath === worktreePath)
      .map((thread) => thread.id);
  });

  const hasUnmergedWork = Effect.fn("WorkspaceWorktreeCleanup.hasUnmergedWork")(function* (
    worktreePath: string,
  ) {
    const preview = yield* review
      .getDiffPreview({ cwd: worktreePath })
      .pipe(
        Effect.mapError((cause) =>
          cleanupError(`Could not inspect worktree '${worktreePath}' before removal.`, cause),
        ),
      );
    return preview.sources.some((source) => source.diff.trim().length > 0);
  });

  const removeWorktreeWithRetry = Effect.fn("WorkspaceWorktreeCleanup.removeWorktreeWithRetry")(
    function* (input: { readonly projectCwd: string; readonly worktreePath: string }) {
      // Windows holds EBUSY/EPERM locks for a beat after sessions and
      // terminals close; a short retry outlives them.
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt++) {
        const result = yield* gitWorkflow
          .removeWorktree({ cwd: input.projectCwd, path: input.worktreePath, force: true })
          .pipe(
            Effect.map(() => null),
            Effect.catch((error) => Effect.succeed(error)),
          );
        if (result === null) return;
        lastError = result;
        if (attempt < REMOVE_ATTEMPTS) yield* Effect.sleep(REMOVE_RETRY_DELAY);
      }
      if (yield* directoryExists(input.worktreePath)) {
        return yield* cleanupError(
          `Could not remove worktree '${input.worktreePath}' after ${REMOVE_ATTEMPTS} attempts.`,
          lastError,
        );
      }
      // The directory is already gone (manual delete); unregister the stale
      // worktree record best-effort and move on to the bookkeeping.
      yield* Effect.logInfo("WorkspaceWorktreeCleanup: worktree directory was already gone", {
        worktreePath: input.worktreePath,
      });
    },
  );

  const detachThread = Effect.fn("WorkspaceWorktreeCleanup.detachThread")(function* (
    threadId: ThreadId,
    projectCwd: string,
  ) {
    // Without this, opening the node's conversation later starts a session in
    // a deleted cwd.
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.make(yield* randomUUID),
      threadId,
      worktreePath: null,
    });
    const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(threadId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    if (context === null || context.checkpoints.length === 0) return;
    yield* checkpointStore.deleteCheckpointRefs({
      cwd: projectCwd,
      checkpointRefs: context.checkpoints.map((checkpoint) => checkpoint.checkpointRef),
    });
  });

  const cleanupPath = Effect.fn("WorkspaceWorktreeCleanup.cleanupPath")(function* (input: {
    readonly projectId: ProjectId;
    readonly worktreePath: string;
    readonly force: boolean;
  }) {
    const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
      Effect.mapError((cause) => cleanupError("Failed to load the Workspace.", cause)),
      Effect.flatMap((option) =>
        Option.isSome(option)
          ? Effect.succeed(option.value)
          : cleanupError(`Workspace '${input.projectId}' does not exist.`),
      ),
    );
    if (!input.force && (yield* directoryExists(input.worktreePath))) {
      if (yield* hasUnmergedWork(input.worktreePath)) {
        return {
          status: "kept-dirty",
          detail:
            "병합되지 않은 변경이 남아 있어 worktree를 보존했습니다. diff를 검토한 뒤 병합하거나 강제 정리하세요.",
        } satisfies WorkspaceWorktreeCleanupResult;
      }
    }
    const threadIds = yield* threadsForWorktree(input.worktreePath);
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        bestEffort(`stop session ${threadId}`, providerService.stopSession({ threadId })).pipe(
          Effect.andThen(
            bestEffort(`close terminals ${threadId}`, terminalManager.close({ threadId })),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    const cleanupHook = cleanupProjectScript(project.scripts ?? []);
    if (
      cleanupHook !== null &&
      Option.isSome(worktreeProvisionOpt) &&
      worktreeProvisionOpt.value.runCleanupGate !== undefined &&
      (yield* directoryExists(input.worktreePath))
    ) {
      yield* bestEffort(
        `cleanup hook '${cleanupHook.name}'`,
        worktreeProvisionOpt.value
          .runCleanupGate({
            script: {
              id: cleanupHook.id,
              name: cleanupHook.name,
              command: cleanupHook.command,
            },
            env: projectScriptRuntimeEnv({
              project: { cwd: project.workspaceRoot },
              worktreePath: input.worktreePath,
            }),
            worktreePath: input.worktreePath,
          })
          .pipe(
            Effect.flatMap((gate) =>
              gate.status === "ok"
                ? Effect.void
                : Effect.logWarning("WorkspaceWorktreeCleanup: cleanup hook returned non-zero", {
                    script: cleanupHook.name,
                    worktreePath: input.worktreePath,
                    exitCode: gate.exitCode,
                    timedOut: gate.timedOut,
                    outputTail: gate.outputTail,
                  }),
            ),
          ),
      );
    }
    yield* removeWorktreeWithRetry({
      projectCwd: project.workspaceRoot,
      worktreePath: input.worktreePath,
    });
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        bestEffort(`detach thread ${threadId}`, detachThread(threadId, project.workspaceRoot)),
      { concurrency: 1, discard: true },
    );
    return { status: "removed", detail: null } satisfies WorkspaceWorktreeCleanupResult;
  });

  const cleanupWorktree = Effect.fn("WorkspaceWorktreeCleanup.cleanupWorktree")(function* (input: {
    readonly run: WorkspaceCollaborationRun;
    readonly worktreePath: string;
    readonly force: boolean;
  }) {
    const owned =
      input.run.graph?.nodes.some((node) => node.worktreePath === input.worktreePath) ?? false;
    if (!owned) {
      return yield* cleanupError(
        `Worktree '${input.worktreePath}' does not belong to run '${input.run.id}'.`,
      );
    }
    return yield* cleanupLock.withPermits(1)(
      cleanupPath({
        projectId: input.run.projectId,
        worktreePath: input.worktreePath,
        force: input.force,
      }),
    );
  });

  const cleanupByRef = Effect.fn("WorkspaceWorktreeCleanup.cleanupByRef")(function* (
    input: WorkspaceWorktreeCleanupInput,
  ) {
    const run = yield* runRepository
      .getById({ projectId: input.projectId, runId: input.runId })
      .pipe(
        Effect.mapError((cause) => cleanupError("Failed to load the collaboration run.", cause)),
        Effect.flatMap((option) =>
          Option.isSome(option) && option.value.projectId === input.projectId
            ? Effect.succeed(option.value)
            : cleanupError(
                `Run '${input.runId}' does not exist in Workspace '${input.projectId}'.`,
              ),
        ),
      );
    return yield* cleanupWorktree({
      run,
      worktreePath: input.worktreePath,
      force: input.force === true,
    });
  });

  const cleanupRunWorktrees = Effect.fn("WorkspaceWorktreeCleanup.cleanupRunWorktrees")(function* (
    run: WorkspaceCollaborationRun,
  ) {
    const paths = [
      ...new Set(
        (run.graph?.nodes ?? [])
          .map((node) => node.worktreePath)
          .filter((path): path is string => path !== null),
      ),
    ];
    yield* Effect.forEach(
      paths,
      (worktreePath) =>
        cleanupLock
          .withPermits(1)(cleanupPath({ projectId: run.projectId, worktreePath, force: false }))
          .pipe(
            Effect.flatMap((result) =>
              result.status === "kept-dirty"
                ? Effect.logInfo("WorkspaceWorktreeCleanup: kept a dirty run worktree", {
                    runId: run.id,
                    worktreePath,
                  })
                : Effect.logInfo("WorkspaceWorktreeCleanup: removed a run worktree", {
                    runId: run.id,
                    worktreePath,
                  }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("WorkspaceWorktreeCleanup: run worktree cleanup failed", {
                runId: run.id,
                worktreePath,
                cause,
              }),
            ),
          ),
      { concurrency: 1, discard: true },
    );
  });

  const sweepOrphans = Effect.fn("WorkspaceWorktreeCleanup.sweepOrphans")(function* () {
    const shell = yield* projectionSnapshotQuery.getShellSnapshot();
    const listRuns = projectionSnapshotQuery.listWorkspaceCollaborationRuns;
    if (listRuns === undefined) return;
    for (const project of shell.projects) {
      const refs = yield* gitWorkflow
        .listRefs({ cwd: project.workspaceRoot, refKind: "local", refresh: true })
        .pipe(Effect.orElseSucceed(() => null));
      if (refs === null || !refs.isRepo) continue;
      const orchestraWorktrees = refs.refs.filter(
        (ref) => !ref.isRemote && ref.worktreePath !== null && isOrchestraWorktreeBranch(ref.name),
      );
      if (orchestraWorktrees.length === 0) continue;
      const runs = yield* listRuns({ projectId: project.id }).pipe(
        Effect.map((result) => result.runs),
        Effect.orElseSucceed(() => null),
      );
      if (runs === null) continue;
      const livePaths = new Set(
        runs
          .filter((run) => !["completed", "failed", "cancelled"].includes(run.status))
          .flatMap((run) => (run.graph?.nodes ?? []).map((node) => node.worktreePath))
          .filter((path): path is string => path !== null),
      );
      for (const ref of orchestraWorktrees) {
        const worktreePath = ref.worktreePath;
        if (worktreePath === null || livePaths.has(worktreePath)) continue;
        yield* cleanupLock
          .withPermits(1)(cleanupPath({ projectId: project.id, worktreePath, force: false }))
          .pipe(
            Effect.flatMap((result) =>
              Effect.logInfo("WorkspaceWorktreeCleanup: swept an orphan worktree", {
                projectId: project.id,
                worktreePath,
                outcome: result.status,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("WorkspaceWorktreeCleanup: orphan sweep failed for a worktree", {
                projectId: project.id,
                worktreePath,
                cause,
              }),
            ),
          );
      }
    }
  });

  return WorkspaceWorktreeCleanup.of({
    cleanupWorktree,
    cleanupByRef,
    cleanupRunWorktrees,
    sweepOrphans: () =>
      sweepOrphans().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("WorkspaceWorktreeCleanup: orphan sweep failed", { cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(WorkspaceWorktreeCleanup, make);
