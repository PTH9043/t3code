import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import {
  ProjectId,
  WorkspaceCollaborationRunId,
  type WorkspaceCollaborationRun,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DevelopmentGit from "./WorkspaceDevelopmentGit.ts";
import { checkOrchestraDelivery } from "./WorkspaceOrchestraDelivery.ts";
import { buildInitialWorkspaceTaskGraph } from "./workspaceTaskGraph.ts";
const at = "2026-10-21T00:00:00.000Z";
function run(
  kind: "implementation" | "research",
  commands: readonly string[],
  worktree: string | null = null,
): WorkspaceCollaborationRun {
  const graph = buildInitialWorkspaceTaskGraph("test");
  return {
    id: WorkspaceCollaborationRunId.make("run"),
    projectId: ProjectId.make("project"),
    source: "user",
    scheduleId: null,
    incidentId: null,
    task: "test",
    status: "running",
    steps: [],
    graph: {
      ...graph,
      status: "completed",
      nodes: graph.nodes.map((node) => ({
        ...node,
        kind,
        status: "completed",
        worktreePath: worktree,
      })),
    },
    meeting: null,
    orchestra: {
      maxParallel: 2,
      isolateWorktrees: worktree !== null,
      completionCheck: true,
      verificationCommands: commands,
    },
    finalOutput: "AI claimed completion",
    error: null,
    createdAt: at,
    updatedAt: at,
  };
}
const live = DevelopmentGit.layer.pipe(Layer.provide(ProcessRunner.layer));
const testLayer = (prefix: string) =>
  live.pipe(
    Layer.provideMerge(ServerConfig.layerTest("D:/repo", { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );
it.effect(
  "uses real Git ancestry, exit codes and logs, and rechecks the combined checkout after integration",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const cwd = path.join(temp, "repo");
      const worker = path.join(temp, "worker");
      yield* fs.makeDirectory(cwd);
      const git = yield* DevelopmentGit.WorkspaceDevelopmentGit;
      yield* git.git(cwd, ["init", "-b", "main"]);
      yield* git.git(cwd, ["config", "user.email", "test@example.invalid"]);
      yield* git.git(cwd, ["config", "user.name", "test"]);
      yield* fs.writeFileString(path.join(cwd, "base.txt"), "base");
      yield* git.git(cwd, ["add", "."]);
      yield* git.git(cwd, ["commit", "-m", "base"]);
      yield* git.git(cwd, ["worktree", "add", "-b", "worker", worker]);
      yield* fs.writeFileString(path.join(worker, "feature.txt"), "feature");
      const command = (yield* HostProcessPlatform) === "win32" ? "exit /b 0" : "exit 0";
      expect(
        (yield* checkOrchestraDelivery(run("implementation", [command], worker), cwd, at)).status,
      ).toBe("awaiting-integration");
      yield* git.git(worker, ["add", "."]);
      yield* git.git(worker, ["commit", "-m", "feature"]);
      expect(
        (yield* checkOrchestraDelivery(run("implementation", [command], worker), cwd, at)).status,
      ).toBe("awaiting-integration");
      yield* git.git(cwd, ["merge", "--ff-only", "worker"]);
      const passed = yield* checkOrchestraDelivery(
        run("implementation", [command], worker),
        cwd,
        at,
      );
      expect(passed.status).toBe("passed");
      expect(passed.commands[0]?.exitCode).toBe(0);
      expect(yield* fs.readFileString(passed.commands[0]!.logPath)).toContain("exitCode");
      const failed = yield* checkOrchestraDelivery(
        run("implementation", [(yield* HostProcessPlatform) === "win32" ? "exit /b 7" : "exit 7"]),
        cwd,
        at,
      );
      expect(failed.status).toBe("failed");
      expect(failed.commands[0]?.exitCode).toBe(7);
      expect((yield* checkOrchestraDelivery(run("implementation", []), cwd, at)).status).toBe(
        "needs-verification",
      );
      yield* git.git(cwd, ["worktree", "remove", worker]);
    }).pipe(Effect.provide(testLayer("t3-orchestra-delivery-")), Effect.scoped),
);
it.effect(
  "does not trust a research label when files changed and rejects forbidden verification shells",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const cwd = path.join(temp, "repo");
      yield* fs.makeDirectory(cwd);
      const git = yield* DevelopmentGit.WorkspaceDevelopmentGit;
      yield* git.git(cwd, ["init", "-b", "main"]);
      yield* git.git(cwd, ["config", "user.email", "test@example.invalid"]);
      yield* git.git(cwd, ["config", "user.name", "test"]);
      yield* fs.writeFileString(path.join(cwd, "base.txt"), "base");
      yield* git.git(cwd, ["add", "."]);
      yield* git.git(cwd, ["commit", "-m", "base"]);
      const baseline = yield* git.inspect(cwd);
      const research = run("research", []);
      const unchanged = {
        ...research,
        graph: { ...research.graph!, workspaceBaseline: baseline.fingerprint },
      };
      expect((yield* checkOrchestraDelivery(unchanged, cwd, at)).status).toBe("passed");
      yield* fs.writeFileString(path.join(cwd, "new.txt"), "unexpected edit");
      expect((yield* checkOrchestraDelivery(unchanged, cwd, at)).status).toBe("needs-verification");
      const forbidden = yield* checkOrchestraDelivery(
        run("implementation", ["pwsh -File forbidden.ps1"]),
        cwd,
        at,
      );
      expect(forbidden.status).toBe("failed");
      expect(forbidden.commands).toHaveLength(0);
    }).pipe(Effect.provide(testLayer("t3-orchestra-research-")), Effect.scoped),
);
