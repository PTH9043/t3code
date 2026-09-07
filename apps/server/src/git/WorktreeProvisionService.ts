import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import type { GitCommandError, GitManagerServiceError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ProcessRunner from "../processRunner.ts";

export interface WorktreeProvisionInput {
  readonly projectCwd: string;
  /** The branch the worktree forks from (and merges back into). */
  readonly baseBranch: string;
  /**
   * The branch checked out in the worktree. Null keeps the legacy bootstrap
   * edge where the worktree checks out `baseBranch` itself (detached when the
   * base resolved to a commit).
   */
  readonly branch: string | null;
  /** Fetch origin and fork from the remote-tracking commit when it exists. */
  readonly startFromOrigin?: boolean | undefined;
  /**
   * A previously stored worktree path, spelled exactly as an earlier
   * provision returned it. When the directory still exists it is reused
   * verbatim — never re-derived or re-normalized, because on a junctioned
   * drive a second spelling of the same directory makes cwd comparisons fail
   * and restarts sessions in a loop.
   */
  readonly existingWorktreePath?: string | null | undefined;
  /**
   * Look the branch up first and reattach to it instead of colliding on
   * `-b`. The reactor's deterministic chain branches need this to survive a
   * crash between branch creation and persisting the path; the bootstrap's
   * random branch names never collide, so it keeps the single-call path.
   */
  readonly reattachExisting?: boolean | undefined;
}

export interface WorktreeProvisionResult {
  readonly worktreePath: string;
  readonly refName: string;
  readonly reused: boolean;
}

export interface WorktreeSetupScript {
  readonly id: string;
  readonly name: string;
  readonly command: string;
}

export type WorktreeSetupGateResult =
  | { readonly status: "ok" }
  | {
      readonly status: "failed";
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly outputTail: string;
    };

const SETUP_TIMEOUT = "10 minutes";
const SETUP_OUTPUT_TAIL = 2_000;

/**
 * Base resolution + idempotent `git worktree add`, extracted from the ws.ts
 * bootstrap so the collaboration reactor can provision write-chain worktrees
 * through the same pipeline. Thread wiring stays with the caller: the
 * bootstrap creates the thread first and patches it via `thread.meta.update`,
 * while the reactor provisions first and passes `worktreePath` straight into
 * `thread.create`.
 *
 * `runSetupGate` is the reactor-side replacement for the PTY setup runner,
 * which fires a command into a terminal and never observes its exit. Chain
 * nodes must not start on a checkout whose dependencies failed to install, so
 * the gate runs the script directly and reports the exit code. Gates run one
 * at a time — parallel pnpm installs fight over the store lock.
 */
export class WorktreeProvisionService extends Context.Service<
  WorktreeProvisionService,
  {
    readonly provision: (
      input: WorktreeProvisionInput,
    ) => Effect.Effect<WorktreeProvisionResult, GitCommandError | GitManagerServiceError>;
    readonly runSetupGate: (input: {
      readonly script: WorktreeSetupScript;
      readonly env?: NodeJS.ProcessEnv | undefined;
      readonly worktreePath: string;
    }) => Effect.Effect<WorktreeSetupGateResult>;
  }
>()("t3/git/WorktreeProvisionService") {}

export const make = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const setupGateLock = yield* Semaphore.make(1);

  const directoryExists = (path: string) =>
    fileSystem.stat(path).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const resolveBaseRef = Effect.fn("WorktreeProvisionService.resolveBaseRef")(function* (input: {
    readonly projectCwd: string;
    readonly baseBranch: string;
    readonly startFromOrigin: boolean;
  }) {
    // Repos without an origin remote fall back to the local base branch
    // instead of failing the whole provision on `git fetch origin`.
    const startFromOrigin =
      input.startFromOrigin &&
      (yield* gitWorkflow.remoteExists({ cwd: input.projectCwd, remoteName: "origin" }));
    if (!startFromOrigin) return input.baseBranch;
    yield* gitWorkflow.fetchRemote({ cwd: input.projectCwd, remoteName: "origin" });
    const resolved = yield* gitWorkflow.resolveRemoteTrackingCommit({
      cwd: input.projectCwd,
      refName: input.baseBranch,
      fallbackRemoteName: "origin",
    });
    return resolved.commitSha;
  });

  const provision = Effect.fn("WorktreeProvisionService.provision")(function* (
    input: WorktreeProvisionInput,
  ) {
    if (
      input.existingWorktreePath != null &&
      (yield* directoryExists(input.existingWorktreePath))
    ) {
      return {
        worktreePath: input.existingWorktreePath,
        refName: input.branch ?? input.baseBranch,
        reused: true,
      };
    }

    if (input.reattachExisting === true && input.branch !== null) {
      // A crash between `worktree add -b` and persisting the path leaves the
      // branch (and possibly the worktree) behind; a second `-b` would fail.
      // Reattach instead of colliding.
      const refs = yield* gitWorkflow.listRefs({
        cwd: input.projectCwd,
        query: input.branch,
        refKind: "local",
        refresh: true,
      });
      const existing = refs.refs.find((ref) => !ref.isRemote && ref.name === input.branch);
      if (existing !== undefined) {
        if (existing.worktreePath !== null && (yield* directoryExists(existing.worktreePath))) {
          return { worktreePath: existing.worktreePath, refName: existing.name, reused: true };
        }
        const attached = yield* gitWorkflow.createWorktree({
          cwd: input.projectCwd,
          refName: input.branch,
          path: null,
        });
        return {
          worktreePath: attached.worktree.path,
          refName: attached.worktree.refName,
          reused: false,
        };
      }
    }

    const baseRef = yield* resolveBaseRef({
      projectCwd: input.projectCwd,
      baseBranch: input.baseBranch,
      startFromOrigin: input.startFromOrigin === true,
    });
    const created = yield* gitWorkflow.createWorktree({
      cwd: input.projectCwd,
      refName: baseRef,
      ...(input.branch !== null ? { newRefName: input.branch, baseRefName: input.baseBranch } : {}),
      path: null,
    });
    return {
      worktreePath: created.worktree.path,
      refName: created.worktree.refName,
      reused: false,
    };
  });

  const runSetupGate = Effect.fn("WorktreeProvisionService.runSetupGate")(function* (input: {
    readonly script: WorktreeSetupScript;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly worktreePath: string;
  }) {
    const shell =
      platform === "win32"
        ? {
            command: process.env.ComSpec?.trim() || "cmd.exe",
            args: ["/d", "/s", "/c", input.script.command],
          }
        : { command: process.env.SHELL?.trim() || "/bin/sh", args: ["-lc", input.script.command] };
    const result = yield* processRunner
      .run({
        command: shell.command,
        args: shell.args,
        cwd: input.worktreePath,
        ...(input.env !== undefined ? { env: input.env } : {}),
        timeout: SETUP_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
      })
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({ code: null, timedOut: false, stdout: "", stderr: String(error) }),
        ),
      );
    if (!result.timedOut && result.code === 0) {
      return { status: "ok" } satisfies WorktreeSetupGateResult;
    }
    return {
      status: "failed",
      exitCode: typeof result.code === "number" ? result.code : null,
      timedOut: result.timedOut,
      outputTail: (result.stderr || result.stdout).slice(-SETUP_OUTPUT_TAIL).trim(),
    } satisfies WorktreeSetupGateResult;
  });

  return WorktreeProvisionService.of({
    provision,
    runSetupGate: (input) => setupGateLock.withPermits(1)(runSetupGate(input)),
  });
});

export const layer = Layer.effect(WorktreeProvisionService, make);
