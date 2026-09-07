import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  GitCommandError,
  ProjectId,
  ThreadId,
  WorkspaceCollaborationRunId,
  type WorkspaceCollaborationRun,
} from "@t3tools/contracts";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ReviewService from "../../review/ReviewService.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as WorkspaceWorktreeCleanupModule from "./WorkspaceWorktreeCleanup.ts";

const { WorkspaceWorktreeCleanup } = WorkspaceWorktreeCleanupModule;

const projectId = ProjectId.make("workspace-a");
const runId = WorkspaceCollaborationRunId.make("run-a");
const threadId = ThreadId.make("thread-1");
const workspaceRoot = "D:/repo";

const runWithWorktree = (
  worktreePath: string,
  status: WorkspaceCollaborationRun["status"] = "completed",
): WorkspaceCollaborationRun =>
  ({
    id: runId,
    projectId,
    status,
    graph: {
      nodes: [
        { id: "write-a", worktreePath, branch: "t3code/orch-runa-1", threadId },
        { id: "read-b", worktreePath: null, branch: null, threadId: null },
      ],
    },
  }) as unknown as WorkspaceCollaborationRun;

const preview = (cwd: string, diff: string) => ({
  cwd,
  generatedAt: "2026-09-07T00:00:00.000Z",
  sources: [
    {
      id: "working-tree",
      kind: "working-tree" as const,
      title: "Working tree",
      baseRef: null,
      headRef: null,
      diff,
      diffHash: "0",
      truncated: false,
    },
  ],
});

interface HarnessOptions {
  readonly worktreePath: string;
  readonly diff?: string;
  readonly removeFailuresBeforeSuccess?: number;
  readonly runs?: ReadonlyArray<WorkspaceCollaborationRun>;
  readonly localRefs?: ReadonlyArray<{ name: string; worktreePath: string | null }>;
}

/** Records every side effect in order so the D7 sequence itself is assertable. */
function makeHarness(options: HarnessOptions) {
  const events: string[] = [];
  let removeFailuresLeft = options.removeFailuresBeforeSuccess ?? 0;
  const layer = WorkspaceWorktreeCleanupModule.layer.pipe(
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        removeWorktree: ((input: { readonly cwd: string; readonly path: string }) => {
          if (removeFailuresLeft > 0) {
            removeFailuresLeft -= 1;
            events.push("remove:fail");
            return Effect.fail(
              new GitCommandError({
                operation: "removeWorktree",
                command: "worktree",
                cwd: input.cwd,
                detail: "EBUSY",
              }),
            );
          }
          events.push(`remove:${input.path}`);
          return Effect.void;
        }) as never,
        listRefs: (() =>
          Effect.succeed({
            refs: (options.localRefs ?? []).map((ref) => ({
              name: ref.name,
              current: false,
              isDefault: false,
              worktreePath: ref.worktreePath,
            })),
            isRepo: true,
            hasPrimaryRemote: false,
            nextCursor: null,
            totalCount: (options.localRefs ?? []).length,
          } as never)) as never,
      }),
    ),
    Layer.provide(
      Layer.mock(ReviewService.ReviewService)({
        getDiffPreview: ((input: { readonly cwd: string }) =>
          Effect.succeed(preview(input.cwd, options.diff ?? "") as never)) as never,
      }),
    ),
    Layer.provide(
      Layer.mock(CheckpointStore.CheckpointStore)({
        deleteCheckpointRefs: ((input: { readonly checkpointRefs: ReadonlyArray<string> }) => {
          events.push(`refs:${input.checkpointRefs.join(",")}`);
          return Effect.void;
        }) as never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderService)({
        stopSession: ((input: { readonly threadId: string }) => {
          events.push(`stop:${input.threadId}`);
          return Effect.void;
        }) as never,
      }),
    ),
    Layer.provide(
      Layer.mock(TerminalManager.TerminalManager)({
        close: ((input: { readonly threadId: string }) => {
          events.push(`terminal:${input.threadId}`);
          return Effect.void;
        }) as never,
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: ((command: {
          readonly type: string;
          readonly threadId?: string;
          readonly worktreePath?: string | null;
        }) => {
          if (command.type === "thread.meta.update") {
            events.push(`meta:${command.threadId}:${String(command.worktreePath)}`);
          }
          return Effect.succeed({ sequence: 1 } as never);
        }) as never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: (() =>
          Effect.succeed(
            Option.some({ id: projectId, workspaceRoot, scripts: [] }),
          ) as never) as never,
        getShellSnapshot: (() =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [{ id: projectId, workspaceRoot, scripts: [] }],
            threads: [
              { id: threadId, projectId, worktreePath: options.worktreePath },
              { id: ThreadId.make("thread-other"), projectId, worktreePath: null },
            ],
            updatedAt: "2026-09-07T00:00:00.000Z",
          } as never)) as never,
        getThreadCheckpointContext: ((id: string) =>
          Effect.succeed(
            Option.some({
              threadId: id,
              projectId,
              workspaceRoot,
              worktreePath: options.worktreePath,
              checkpoints: [
                { checkpointRef: `refs/t3/checkpoints/${id}/turn/1` },
                { checkpointRef: `refs/t3/checkpoints/${id}/turn/2` },
              ],
            }),
          ) as never) as never,
        listWorkspaceCollaborationRuns: (() =>
          Effect.succeed({ runs: options.runs ?? [] } as never)) as never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionWorkspaceCollaborationRunRepository)({
        getById: ((input: { readonly projectId: string; readonly runId: string }) =>
          Effect.succeed(
            Option.fromNullishOr(
              (options.runs ?? []).find(
                (run) => run.id === input.runId && run.projectId === input.projectId,
              ),
            ),
          ) as never) as never,
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { events, layer };
}

const makeTempDir = (prefix: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectory({ prefix });
  }).pipe(Effect.provide(NodeServices.layer));

describe("WorkspaceWorktreeCleanup", () => {
  it.effect("cleans a clean worktree in the D7 order", () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeTempDir("t3-orch-clean-");
      const run = runWithWorktree(worktreePath);
      const harness = makeHarness({ worktreePath });
      yield* Effect.gen(function* () {
        const cleanup = yield* WorkspaceWorktreeCleanup;
        const result = yield* cleanup.cleanupWorktree({ run, worktreePath, force: false });
        assert.deepEqual(result, { status: "removed", detail: null });
        assert.deepEqual(harness.events, [
          `stop:${threadId}`,
          `terminal:${threadId}`,
          `remove:${worktreePath}`,
          `meta:${threadId}:null`,
          `refs:refs/t3/checkpoints/${threadId}/turn/1,refs/t3/checkpoints/${threadId}/turn/2`,
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps a dirty worktree and touches nothing", () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeTempDir("t3-orch-dirty-");
      const run = runWithWorktree(worktreePath);
      const harness = makeHarness({ worktreePath, diff: "diff --git a/x b/x\n+1\n" });
      yield* Effect.gen(function* () {
        const cleanup = yield* WorkspaceWorktreeCleanup;
        const result = yield* cleanup.cleanupWorktree({ run, worktreePath, force: false });
        assert.equal(result.status, "kept-dirty");
        assert.deepEqual(harness.events, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("force removes a dirty worktree without the diff gate", () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeTempDir("t3-orch-force-");
      const run = runWithWorktree(worktreePath);
      const harness = makeHarness({ worktreePath, diff: "diff --git a/x b/x\n+1\n" });
      yield* Effect.gen(function* () {
        const cleanup = yield* WorkspaceWorktreeCleanup;
        const result = yield* cleanup.cleanupWorktree({ run, worktreePath, force: true });
        assert.equal(result.status, "removed");
        assert.ok(harness.events.includes(`remove:${worktreePath}`));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  // Live clock: the retry backoff is a real `Effect.sleep`, which the test
  // clock would park forever.
  it.live("retries a locked removal before giving up", () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeTempDir("t3-orch-retry-");
      const run = runWithWorktree(worktreePath);
      const harness = makeHarness({ worktreePath, removeFailuresBeforeSuccess: 2 });
      yield* Effect.gen(function* () {
        const cleanup = yield* WorkspaceWorktreeCleanup;
        const result = yield* cleanup.cleanupWorktree({ run, worktreePath, force: false });
        assert.equal(result.status, "removed");
        assert.deepEqual(
          harness.events.filter((event) => event.startsWith("remove")),
          ["remove:fail", "remove:fail", `remove:${worktreePath}`],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("rejects a worktree the run does not own", () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeTempDir("t3-orch-owned-");
      const run = runWithWorktree(worktreePath);
      const harness = makeHarness({ worktreePath });
      yield* Effect.gen(function* () {
        const cleanup = yield* WorkspaceWorktreeCleanup;
        const error = yield* cleanup
          .cleanupWorktree({ run, worktreePath: "E:/somewhere/else", force: false })
          .pipe(Effect.flip);
        assert.equal(error._tag, "OrchestrationWorktreeCleanupError");
        assert.deepEqual(harness.events, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("cleanupByRef resolves the run before cleaning", () =>
    Effect.gen(function* () {
      const worktreePath = yield* makeTempDir("t3-orch-byref-");
      const run = runWithWorktree(worktreePath);
      const harness = makeHarness({ worktreePath, runs: [run] });
      yield* Effect.gen(function* () {
        const cleanup = yield* WorkspaceWorktreeCleanup;
        const result = yield* cleanup.cleanupByRef({ projectId, runId, worktreePath });
        assert.equal(result.status, "removed");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("sweeps an orphan orchestra worktree but leaves a live run's alone", () =>
    Effect.gen(function* () {
      const orphanPath = yield* makeTempDir("t3-orch-orphan-");
      const livePath = yield* makeTempDir("t3-orch-live-");
      const liveRun = runWithWorktree(livePath, "running");
      const harness = makeHarness({
        worktreePath: orphanPath,
        runs: [liveRun],
        localRefs: [
          { name: "t3code/orch-runa-1", worktreePath: livePath },
          { name: "t3code/orch-runb-1", worktreePath: orphanPath },
          { name: "main", worktreePath: workspaceRoot },
        ],
      });
      yield* Effect.gen(function* () {
        const cleanup = yield* WorkspaceWorktreeCleanup;
        yield* cleanup.sweepOrphans();
        const removals = harness.events.filter((event) => event.startsWith("remove"));
        assert.deepEqual(removals, [`remove:${orphanPath}`]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
