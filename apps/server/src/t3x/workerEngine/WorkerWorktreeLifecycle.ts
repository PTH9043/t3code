// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import type {
  WorkerTaskRecord,
  WorkerWorktreeActionResult,
  WorkerWorktreeDiffResult,
  WorkerWorktreeMode,
  WorkerWorktreeState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { WorkerEngineError, type WorkerEngineStore } from "./WorkerEngineStore.ts";

const MAX_DIFF_PATCH_BYTES = 64 * 1024;

interface GitExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<GitExecResult, WorkerEngineError> {
  return Effect.callback<GitExecResult, WorkerEngineError>((resume) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (
          error &&
          typeof (error as NodeJS.ErrnoException).code === "string" &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          resume(
            Effect.fail(
              new WorkerEngineError({
                code: "worktree_error",
                message: "git executable was not found on PATH.",
              }),
            ),
          );
          return;
        }
        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resume(
          Effect.succeed({
            code: exitCode,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          }),
        );
      },
    );
    return Effect.sync(() => {
      child.kill();
    });
  });
}

function parseModifiedFilesFromStatus(statusPorcelain: string): string[] {
  const files: string[] = [];
  for (const line of statusPorcelain.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const rawPath = line.slice(3).trim();
    const renamed = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()! : rawPath;
    if (renamed && !files.includes(renamed)) {
      files.push(renamed);
    }
  }
  return files;
}

function parseModifiedFilesFromNameOnly(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface PreparedWorktree {
  readonly worktreeMode: WorkerWorktreeMode;
  readonly worktreePath: string | null;
  readonly worktreeBranch: string | null;
  readonly worktreeBaseRef: string | null;
  readonly worktreeState: WorkerWorktreeState;
  readonly effectiveCwd: string;
}

export interface WorktreeReviewSummary {
  readonly hasChanges: boolean;
  readonly statusShort: string;
  readonly diffStat: string;
  readonly filesModified: ReadonlyArray<string>;
}

export function makeWorkerWorktreeLifecycle(store: WorkerEngineStore) {
  const resolveGitRepoRoot = (cwd: string) =>
    Effect.gen(function* () {
      if (!NodeFs.existsSync(cwd)) return null;
      const res = yield* runGit(cwd, ["rev-parse", "--show-toplevel"]).pipe(
        Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })),
      );
      if (res.code !== 0) return null;
      const root = res.stdout.trim();
      return root.length > 0 ? NodePath.resolve(root) : null;
    });

  const resolveBaseBranch = (repoRoot: string, requestedBaseBranch?: string) =>
    Effect.gen(function* () {
      if (requestedBaseBranch?.trim()) return requestedBaseBranch.trim();
      const sym = yield* runGit(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
      if (sym.code === 0 && sym.stdout.trim().length > 0) {
        return sym.stdout.trim();
      }
      const rev = yield* runGit(repoRoot, ["rev-parse", "HEAD"]);
      return rev.code === 0 && rev.stdout.trim().length > 0 ? rev.stdout.trim() : "HEAD";
    });

  const prepareWorktree = (input: {
    readonly cwd: string;
    readonly taskId: string;
    readonly mode: WorkerWorktreeMode;
    readonly baseBranch?: string | undefined;
  }): Effect.Effect<PreparedWorktree, WorkerEngineError> =>
    Effect.gen(function* () {
      if (input.mode !== "isolated") {
        return {
          worktreeMode: "current",
          worktreePath: null,
          worktreeBranch: null,
          worktreeBaseRef: null,
          worktreeState: "none",
          effectiveCwd: input.cwd,
        };
      }

      const repoRoot = yield* resolveGitRepoRoot(input.cwd);
      if (!repoRoot) {
        return {
          worktreeMode: "current",
          worktreePath: null,
          worktreeBranch: null,
          worktreeBaseRef: null,
          worktreeState: "none",
          effectiveCwd: input.cwd,
        };
      }

      const baseRef = yield* resolveBaseBranch(repoRoot, input.baseBranch);
      const shortId = input.taskId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-12);
      const branch = `t3code/worker-${shortId}`;
      const worktreeContainer = NodePath.join(repoRoot, ".t3-worktrees");
      const worktreePath = NodePath.join(worktreeContainer, `worker-${shortId}`);

      NodeFs.mkdirSync(worktreeContainer, { recursive: true });

      if (NodeFs.existsSync(worktreePath)) {
        return {
          worktreeMode: "isolated",
          worktreePath,
          worktreeBranch: branch,
          worktreeBaseRef: baseRef,
          worktreeState: "active",
          effectiveCwd: worktreePath,
        };
      }

      const branchExists = yield* runGit(repoRoot, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      const addArgs =
        branchExists.code === 0
          ? ["worktree", "add", worktreePath, branch]
          : ["worktree", "add", "-b", branch, worktreePath, baseRef];

      const addResult = yield* runGit(repoRoot, addArgs);
      if (addResult.code !== 0) {
        return yield* new WorkerEngineError({
          code: "worktree_error",
          message: `Failed to create isolated git worktree '${worktreePath}': ${addResult.stderr.trim() || addResult.stdout.trim()}`,
        });
      }

      return {
        worktreeMode: "isolated",
        worktreePath,
        worktreeBranch: branch,
        worktreeBaseRef: baseRef,
        worktreeState: "active",
        effectiveCwd: worktreePath,
      };
    });

  const collectDiff = (
    task: WorkerTaskRecord,
  ): Effect.Effect<WorkerWorktreeDiffResult, WorkerEngineError> =>
    Effect.gen(function* () {
      const targetCwd = task.worktreePath ?? task.cwd;
      if (!targetCwd || !NodeFs.existsSync(targetCwd)) {
        return {
          taskId: task.taskId,
          worktreePath: task.worktreePath,
          worktreeBranch: task.worktreeBranch,
          worktreeBaseRef: task.worktreeBaseRef,
          worktreeState: task.worktreeState,
          statusShort: "",
          diffStat: "",
          diffPatch: "",
          filesModified: [],
        };
      }

      const statusRes = yield* runGit(targetCwd, ["status", "--porcelain"]);
      const statusShort = statusRes.stdout.trimEnd();
      const dirtyFiles = parseModifiedFilesFromStatus(statusShort);

      const baseRef = task.worktreeBaseRef ?? "HEAD";
      const committedNamesRes = task.worktreeBaseRef
        ? yield* runGit(targetCwd, ["diff", "--name-only", `${baseRef}...HEAD`])
        : { code: 0, stdout: "", stderr: "" };
      const committedFiles =
        committedNamesRes.code === 0
          ? parseModifiedFilesFromNameOnly(committedNamesRes.stdout)
          : [];

      const filesModified = [...new Set([...committedFiles, ...dirtyFiles])];

      const statCommitted = task.worktreeBaseRef
        ? (yield* runGit(targetCwd, ["diff", "--stat", `${baseRef}...HEAD`])).stdout.trim()
        : "";
      const statWorking = (yield* runGit(targetCwd, ["diff", "--stat"])).stdout.trim();
      const diffStat = [statCommitted, statWorking].filter(Boolean).join("\n");

      const patchCommitted = task.worktreeBaseRef
        ? (yield* runGit(targetCwd, ["diff", `${baseRef}...HEAD`])).stdout
        : "";
      const patchWorking = (yield* runGit(targetCwd, ["diff"])).stdout;
      const combinedPatch = [patchCommitted, patchWorking].filter(Boolean).join("\n");
      const diffPatch =
        combinedPatch.length > MAX_DIFF_PATCH_BYTES
          ? `${combinedPatch.slice(0, MAX_DIFF_PATCH_BYTES)}\n... [truncated]`
          : combinedPatch;

      return {
        taskId: task.taskId,
        worktreePath: task.worktreePath,
        worktreeBranch: task.worktreeBranch,
        worktreeBaseRef: task.worktreeBaseRef,
        worktreeState: task.worktreeState,
        statusShort,
        diffStat,
        diffPatch,
        filesModified,
      };
    });

  /** Marks completed isolated worktree as `review_ready` without deleting it. */
  const finalizeForReview = (
    task: WorkerTaskRecord,
  ): Effect.Effect<WorktreeReviewSummary, WorkerEngineError> =>
    Effect.gen(function* () {
      const diff = yield* collectDiff(task);
      if (task.worktreePath && task.worktreeState === "active") {
        yield* store.updateTaskWorktree({
          taskId: task.taskId,
          worktreeState: "review_ready",
        });
      }
      return {
        hasChanges: diff.filesModified.length > 0 || diff.statusShort.length > 0,
        statusShort: diff.statusShort,
        diffStat: diff.diffStat,
        filesModified: diff.filesModified,
      };
    });

  const inspectDiff = (
    taskId: string,
  ): Effect.Effect<WorkerWorktreeDiffResult, WorkerEngineError> =>
    Effect.gen(function* () {
      const task = yield* store.getTask(taskId);
      if (!task) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Task '${taskId}' not found.`,
        });
      }
      return yield* collectDiff(task);
    });

  const removeWorktreeAndBranch = (repoRoot: string, worktreePath: string, branch: string | null) =>
    Effect.gen(function* () {
      if (NodeFs.existsSync(worktreePath)) {
        const rmRes = yield* runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
        if (rmRes.code !== 0 && NodeFs.existsSync(worktreePath)) {
          NodeFs.rmSync(worktreePath, { recursive: true, force: true });
          yield* runGit(repoRoot, ["worktree", "prune"]).pipe(Effect.ignore);
        }
      } else {
        yield* runGit(repoRoot, ["worktree", "prune"]).pipe(Effect.ignore);
      }
      if (branch) {
        yield* runGit(repoRoot, ["branch", "-D", branch]).pipe(Effect.ignore);
      }
    });

  const mergeWorktree = (
    taskId: string,
    options?: {
      readonly onValidate?: (worktreePath: string) => Effect.Effect<void, WorkerEngineError>;
      readonly onCleanup?: (worktreePath: string) => Effect.Effect<void>;
    },
  ): Effect.Effect<WorkerWorktreeActionResult, WorkerEngineError> =>
    Effect.gen(function* () {
      const task = yield* store.getTask(taskId);
      if (!task) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Task '${taskId}' not found.`,
        });
      }
      if (!task.worktreePath || !task.worktreeBranch) {
        return yield* new WorkerEngineError({
          code: "invalid_state",
          message: `Task '${taskId}' has no isolated worktree to merge.`,
        });
      }
      if (task.worktreeState === "merged" || task.worktreeState === "discarded") {
        return yield* new WorkerEngineError({
          code: "invalid_state",
          message: `Task '${taskId}' worktree is already '${task.worktreeState}'.`,
        });
      }
      if (!NodeFs.existsSync(task.worktreePath)) {
        return yield* new WorkerEngineError({
          code: "worktree_error",
          message: `Worktree directory '${task.worktreePath}' does not exist on disk.`,
        });
      }

      const repoRoot = yield* resolveGitRepoRoot(task.cwd);
      if (!repoRoot) {
        return yield* new WorkerEngineError({
          code: "worktree_error",
          message: `Base cwd '${task.cwd}' is not a git repository.`,
        });
      }

      // Optional validation gate before merging.
      if (options?.onValidate) {
        yield* options.onValidate(task.worktreePath);
      }

      // Commit any unstaged/untracked changes in the worker worktree onto the worker branch.
      const statusRes = yield* runGit(task.worktreePath, ["status", "--porcelain"]);
      if (statusRes.stdout.trim().length > 0) {
        const addRes = yield* runGit(task.worktreePath, ["add", "-A"]);
        if (addRes.code !== 0) {
          return yield* new WorkerEngineError({
            code: "worktree_error",
            message: `Failed to stage worker worktree changes: ${addRes.stderr.trim()}`,
          });
        }
        const commitRes = yield* runGit(task.worktreePath, [
          "-c",
          "user.name=T3 Worker Engine",
          "-c",
          "user.email=t3-worker@local",
          "commit",
          "-m",
          `worker(${task.taskId}): ${task.role} changes`,
        ]);
        if (commitRes.code !== 0) {
          return yield* new WorkerEngineError({
            code: "worktree_error",
            message: `Failed to commit worker worktree changes: ${commitRes.stderr.trim() || commitRes.stdout.trim()}`,
          });
        }
      }

      // Merge worker branch into base repository.
      const mergeRes = yield* runGit(repoRoot, [
        "-c",
        "user.name=T3 Worker Engine",
        "-c",
        "user.email=t3-worker@local",
        "merge",
        "--no-ff",
        task.worktreeBranch,
        "-m",
        `Merge ${task.worktreeBranch} (task ${task.taskId})`,
      ]);
      if (mergeRes.code !== 0) {
        yield* runGit(repoRoot, ["merge", "--abort"]).pipe(Effect.ignore);
        return yield* new WorkerEngineError({
          code: "conflict",
          message: `Merge conflict while merging '${task.worktreeBranch}' into base repo; worktree preserved for manual inspection. ${mergeRes.stderr.trim() || mergeRes.stdout.trim()}`,
        });
      }

      const headSha = (yield* runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim() || null;

      if (options?.onCleanup) {
        yield* options.onCleanup(task.worktreePath).pipe(Effect.ignore);
      }
      yield* removeWorktreeAndBranch(repoRoot, task.worktreePath, task.worktreeBranch);
      yield* store.updateTaskWorktree({
        taskId: task.taskId,
        worktreeState: "merged",
      });

      return {
        taskId: task.taskId,
        action: "merge",
        worktreeState: "merged",
        mergedCommit: headSha,
        message: `Merged '${task.worktreeBranch}' and cleaned up worktree.`,
      };
    });

  const discardWorktree = (
    taskId: string,
    options?: {
      readonly onCleanup?: (worktreePath: string) => Effect.Effect<void>;
    },
  ): Effect.Effect<WorkerWorktreeActionResult, WorkerEngineError> =>
    Effect.gen(function* () {
      const task = yield* store.getTask(taskId);
      if (!task) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Task '${taskId}' not found.`,
        });
      }
      if (!task.worktreePath && !task.worktreeBranch) {
        return yield* new WorkerEngineError({
          code: "invalid_state",
          message: `Task '${taskId}' has no isolated worktree to discard.`,
        });
      }
      if (task.worktreeState === "merged" || task.worktreeState === "discarded") {
        return {
          taskId: task.taskId,
          action: "discard",
          worktreeState: task.worktreeState,
          message: `Worktree already '${task.worktreeState}'.`,
        };
      }

      const repoRoot = yield* resolveGitRepoRoot(task.cwd);
      if (options?.onCleanup && task.worktreePath) {
        yield* options.onCleanup(task.worktreePath).pipe(Effect.ignore);
      }
      if (repoRoot && task.worktreePath) {
        yield* removeWorktreeAndBranch(repoRoot, task.worktreePath, task.worktreeBranch);
      } else if (task.worktreePath && NodeFs.existsSync(task.worktreePath)) {
        NodeFs.rmSync(task.worktreePath, { recursive: true, force: true });
      }

      yield* store.updateTaskWorktree({
        taskId: task.taskId,
        worktreeState: "discarded",
      });

      return {
        taskId: task.taskId,
        action: "discard",
        worktreeState: "discarded",
        message: `Discarded worktree and branch '${task.worktreeBranch ?? ""}'.`,
      };
    });

  return {
    prepareWorktree,
    finalizeForReview,
    inspectDiff,
    mergeWorktree,
    discardWorktree,
  };
}

export type WorkerWorktreeLifecycle = ReturnType<typeof makeWorkerWorktreeLifecycle>;
