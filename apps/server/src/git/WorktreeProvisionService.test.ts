import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as WorktreeProvisionService from "./WorktreeProvisionService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { ServerConfig } from "../config.ts";

const localRef = (name: string, worktreePath: string | null) => ({
  name,
  current: false,
  isDefault: false,
  worktreePath,
});

const refsResult = (refs: ReadonlyArray<ReturnType<typeof localRef>>) => ({
  refs,
  isRepo: true,
  hasPrimaryRemote: false,
  nextCursor: null,
  totalCount: refs.length,
});

/** Plain recorders instead of vi.fn so both lint configurations accept them. */
function makeGitRecorder(input: {
  readonly refs?: ReadonlyArray<ReturnType<typeof localRef>>;
  readonly createdPath?: string;
  readonly remoteBaseSha?: string;
}) {
  const calls: Array<{ readonly method: string; readonly request: unknown }> = [];
  const record = (method: string, request: unknown) => calls.push({ method, request });
  const gitWorkflow: Partial<GitWorkflowService.GitWorkflowService["Service"]> = {
    listRefs: ((request: unknown) => {
      record("listRefs", request);
      return Effect.succeed(refsResult(input.refs ?? []) as never);
    }) as never,
    createWorktree: ((request: { readonly refName: string; readonly newRefName?: string }) => {
      record("createWorktree", request);
      return Effect.succeed({
        worktree: {
          path: input.createdPath ?? "E:/worktrees/repo/fresh",
          refName: request.newRefName ?? request.refName,
        },
      } as never);
    }) as never,
    remoteExists: ((request: unknown) => {
      record("remoteExists", request);
      return Effect.succeed(input.remoteBaseSha !== (undefined as never));
    }) as never,
    fetchRemote: ((request: unknown) => {
      record("fetchRemote", request);
      return Effect.void;
    }) as never,
    resolveRemoteTrackingCommit: ((request: unknown) => {
      record("resolveRemoteTrackingCommit", request);
      return Effect.succeed({
        commitSha: input.remoteBaseSha ?? "deadbeef",
        remoteRefName: "origin/main",
      } as never);
    }) as never,
  };
  const callsFor = (method: string) => calls.filter((call) => call.method === method);
  return { gitWorkflow, calls, callsFor };
}

function makeLayer(input: {
  readonly gitWorkflow?: Partial<GitWorkflowService.GitWorkflowService["Service"]>;
  readonly processRunner?: Partial<ProcessRunner.ProcessRunner["Service"]>;
  readonly platform?: NodeJS.Platform;
}) {
  return WorktreeProvisionService.layer.pipe(
    Layer.provide(Layer.mock(GitWorkflowService.GitWorkflowService)({ ...input.gitWorkflow })),
    Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({ ...input.processRunner })),
    Layer.provide(Layer.succeed(HostProcessPlatform, input.platform ?? "linux")),
    Layer.provide(NodeServices.layer),
  );
}

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-orch-wt-" });
}).pipe(Effect.provide(NodeServices.layer));

describe("WorktreeProvisionService.provision", () => {
  it.effect("verifies the actual Git worktree and rejects a different directory", () => {
    const gitLayer = GitVcsDriver.layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-git-config-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-real-worktree-" });
      const repo = path.join(root, "repo");
      const tree = path.join(root, "tree");
      const other = path.join(root, "other");
      yield* fs.makeDirectory(repo);
      yield* fs.makeDirectory(other);
      const git = (args: readonly string[]) =>
        driver.execute({ operation: "worktree-recovery-test", cwd: repo, args, timeoutMs: 10_000 });
      yield* git(["init"]);
      yield* git(["config", "user.name", "T3 Test"]);
      yield* git(["config", "user.email", "t3-test@example.invalid"]);
      yield* git(["commit", "--allow-empty", "-m", "initial"]);
      yield* git(["worktree", "add", "-b", "t3-recovery-test", tree, "HEAD"]);
      yield* Effect.gen(function* () {
        const service = yield* WorktreeProvisionService.WorktreeProvisionService;
        assert.isTrue(
          yield* service.verifyExisting!({
            projectCwd: repo,
            worktreePath: tree,
            branch: "t3-recovery-test",
          }),
        );
        assert.isFalse(
          yield* service.verifyExisting!({
            projectCwd: repo,
            worktreePath: other,
            branch: "t3-recovery-test",
          }),
        );
        assert.isFalse(
          yield* service.verifyExisting!({
            projectCwd: repo,
            worktreePath: tree,
            branch: "not-the-branch",
          }),
        );
      }).pipe(Effect.provide(makeLayer({ gitWorkflow: { listRefs: driver.listRefs } })));
    }).pipe(Effect.provide(gitLayer));
  });
  it.effect("verifies a recorded path still belongs to the requested local branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const owned = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owned-tree-" });
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3-other-tree-" });
      const git = makeGitRecorder({ refs: [localRef("t3/owned", owned)] });
      yield* Effect.gen(function* () {
        const service = yield* WorktreeProvisionService.WorktreeProvisionService;
        assert.isTrue(
          yield* service.verifyExisting!({
            projectCwd: "/project",
            worktreePath: owned,
            branch: "t3/owned",
          }),
        );
        assert.isFalse(
          yield* service.verifyExisting!({
            projectCwd: "/project",
            worktreePath: other,
            branch: "t3/owned",
          }),
        );
        assert.isFalse(
          yield* service.verifyExisting!({
            projectCwd: "/project",
            worktreePath: owned,
            branch: "t3/other",
          }),
        );
        assert.equal(git.callsFor("createWorktree").length, 0);
      }).pipe(Effect.provide(makeLayer({ gitWorkflow: git.gitWorkflow })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("reuses a stored worktree path whose directory still exists, without git calls", () => {
    const git = makeGitRecorder({});
    return Effect.gen(function* () {
      const existingDir = yield* makeTempDir;
      const service = yield* WorktreeProvisionService.WorktreeProvisionService;
      const result = yield* service.provision({
        projectCwd: "D:/repo",
        baseBranch: "main",
        branch: "t3code/orch-run1-1",
        existingWorktreePath: existingDir,
        reattachExisting: true,
      });
      assert.deepEqual(result, {
        worktreePath: existingDir,
        refName: "t3code/orch-run1-1",
        reused: true,
      });
      assert.equal(git.calls.length, 0);
    }).pipe(Effect.provide(makeLayer({ gitWorkflow: git.gitWorkflow })));
  });

  it.effect("reattaches to an existing branch instead of colliding on -b", () => {
    const git = makeGitRecorder({
      refs: [localRef("t3code/orch-run1-1", null)],
      createdPath: "E:/worktrees/repo/reattached",
    });
    return Effect.gen(function* () {
      const service = yield* WorktreeProvisionService.WorktreeProvisionService;
      const result = yield* service.provision({
        projectCwd: "D:/repo",
        baseBranch: "main",
        branch: "t3code/orch-run1-1",
        reattachExisting: true,
      });
      assert.deepEqual(result, {
        worktreePath: "E:/worktrees/repo/reattached",
        refName: "t3code/orch-run1-1",
        reused: false,
      });
      // No `newRefName`: the branch already exists, `-b` would fail.
      assert.deepEqual(git.callsFor("createWorktree")[0]?.request, {
        cwd: "D:/repo",
        refName: "t3code/orch-run1-1",
        path: null,
      });
    }).pipe(Effect.provide(makeLayer({ gitWorkflow: git.gitWorkflow })));
  });

  it.effect("adopts the branch's registered worktree when its directory exists", () =>
    Effect.gen(function* () {
      const existingDir = yield* makeTempDir;
      const git = makeGitRecorder({ refs: [localRef("t3code/orch-run1-1", existingDir)] });
      yield* Effect.gen(function* () {
        const service = yield* WorktreeProvisionService.WorktreeProvisionService;
        const result = yield* service.provision({
          projectCwd: "D:/repo",
          baseBranch: "main",
          branch: "t3code/orch-run1-1",
          reattachExisting: true,
        });
        assert.deepEqual(result, {
          worktreePath: existingDir,
          refName: "t3code/orch-run1-1",
          reused: true,
        });
        assert.equal(git.callsFor("createWorktree").length, 0);
      }).pipe(Effect.provide(makeLayer({ gitWorkflow: git.gitWorkflow })));
    }),
  );

  it.effect("forks a fresh branch from the origin-resolved base", () => {
    const git = makeGitRecorder({
      remoteBaseSha: "abc123",
      createdPath: "E:/worktrees/repo/fresh",
    });
    return Effect.gen(function* () {
      const service = yield* WorktreeProvisionService.WorktreeProvisionService;
      const result = yield* service.provision({
        projectCwd: "D:/repo",
        baseBranch: "main",
        branch: "t3code/orch-run1-1",
        startFromOrigin: true,
        reattachExisting: true,
      });
      assert.equal(result.reused, false);
      assert.equal(result.worktreePath, "E:/worktrees/repo/fresh");
      assert.deepEqual(git.callsFor("createWorktree")[0]?.request, {
        cwd: "D:/repo",
        refName: "abc123",
        newRefName: "t3code/orch-run1-1",
        baseRefName: "main",
        path: null,
      });
      assert.equal(git.callsFor("fetchRemote").length, 1);
    }).pipe(Effect.provide(makeLayer({ gitWorkflow: git.gitWorkflow })));
  });

  it.effect("keeps the bootstrap single-call path when reattach is not requested", () => {
    const git = makeGitRecorder({ createdPath: "/tmp/wt" });
    return Effect.gen(function* () {
      const service = yield* WorktreeProvisionService.WorktreeProvisionService;
      yield* service.provision({
        projectCwd: "/tmp/project",
        baseBranch: "main",
        branch: "t3code/abcd1234",
        startFromOrigin: true,
      });
      assert.equal(git.callsFor("listRefs").length, 0);
      assert.deepEqual(git.callsFor("createWorktree")[0]?.request, {
        cwd: "/tmp/project",
        refName: "main",
        newRefName: "t3code/abcd1234",
        baseRefName: "main",
        path: null,
      });
    }).pipe(Effect.provide(makeLayer({ gitWorkflow: git.gitWorkflow })));
  });
});

describe("WorktreeProvisionService.runSetupGate", () => {
  const script = { id: "setup", name: "Setup", command: "pnpm install" };

  const makeRunner = (output: {
    readonly code: number | null;
    readonly timedOut: boolean;
    readonly stdout?: string;
    readonly stderr?: string;
  }) => {
    const requests: Array<{
      readonly cwd?: string | undefined;
      readonly args: ReadonlyArray<string>;
    }> = [];
    const processRunner: Partial<ProcessRunner.ProcessRunner["Service"]> = {
      run: ((request: { readonly cwd?: string; readonly args: ReadonlyArray<string> }) => {
        requests.push({ cwd: request.cwd, args: request.args });
        return Effect.succeed({
          stdout: output.stdout ?? "",
          stderr: output.stderr ?? "",
          code: output.code,
          timedOut: output.timedOut,
          stdoutTruncated: false,
          stderrTruncated: false,
        } as never);
      }) as never,
    };
    return { processRunner, requests };
  };

  it.effect("passes the gate on exit 0 and runs the script in the worktree", () => {
    const runner = makeRunner({ code: 0, timedOut: false });
    return Effect.gen(function* () {
      const service = yield* WorktreeProvisionService.WorktreeProvisionService;
      const result = yield* service.runSetupGate({ script, worktreePath: "E:/worktrees/w1" });
      assert.deepEqual(result, { status: "ok" });
      assert.equal(runner.requests[0]?.cwd, "E:/worktrees/w1");
      assert.ok(runner.requests[0]?.args.includes("pnpm install"));
    }).pipe(Effect.provide(makeLayer({ processRunner: runner.processRunner })));
  });

  it.effect("fails the gate with the exit code and output tail", () => {
    const runner = makeRunner({
      code: 1,
      timedOut: false,
      stdout: "installing...",
      stderr: "ERR_PNPM_LOCKFILE mismatch",
    });
    return Effect.gen(function* () {
      const service = yield* WorktreeProvisionService.WorktreeProvisionService;
      const result = yield* service.runSetupGate({ script, worktreePath: "E:/worktrees/w1" });
      assert.deepEqual(result, {
        status: "failed",
        exitCode: 1,
        timedOut: false,
        outputTail: "ERR_PNPM_LOCKFILE mismatch",
      });
    }).pipe(Effect.provide(makeLayer({ processRunner: runner.processRunner })));
  });

  it.effect("reports a timeout as a failed gate", () => {
    const runner = makeRunner({ code: null, timedOut: true });
    return Effect.gen(function* () {
      const service = yield* WorktreeProvisionService.WorktreeProvisionService;
      const result = yield* service.runSetupGate({ script, worktreePath: "E:/worktrees/w1" });
      assert.equal(result.status, "failed");
      assert.equal(result.status === "failed" && result.timedOut, true);
    }).pipe(Effect.provide(makeLayer({ processRunner: runner.processRunner })));
  });

  it.effect("executes declarative validate and cleanup lifecycle gates (Orca hooks)", () => {
    const runner = makeRunner({ code: 0, timedOut: false });
    return Effect.gen(function* () {
      const service = yield* WorktreeProvisionService.WorktreeProvisionService;
      const val = yield* service.runValidateGate!({
        script: { id: "val", name: "Validate", command: "vp test run" },
        worktreePath: "E:/worktrees/w2",
      });
      const clean = yield* service.runCleanupGate!({
        script: { id: "cln", name: "Cleanup", command: "node cleanup.mjs" },
        worktreePath: "E:/worktrees/w2",
      });
      assert.deepEqual(val, { status: "ok" });
      assert.deepEqual(clean, { status: "ok" });
      assert.equal(runner.requests.length, 2);
      assert.ok(runner.requests[0]?.args.includes("vp test run"));
      assert.ok(runner.requests[1]?.args.includes("node cleanup.mjs"));
    }).pipe(Effect.provide(makeLayer({ processRunner: runner.processRunner })));
  });
});
