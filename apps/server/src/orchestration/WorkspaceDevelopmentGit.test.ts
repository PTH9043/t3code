import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { layerTest as ConfigLayer } from "../config.ts";
import { layer as RunnerLayer } from "../processRunner.ts";
import { WorkspaceDevelopmentGit, layer as GitLayer } from "./WorkspaceDevelopmentGit.ts";

it.effect(
  "real Git keeps a reviewed SHA fixed, preserves dirty checkouts, and detects untracked content changes in Korean paths",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const testHostPlatform = yield* HostProcessPlatform;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-persistent-workspace-" });
      const root = path.join(temp, "한글 프로젝트 repo");
      yield* fs.makeDirectory(root);
      const dependencies = Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, testHostPlatform),
        ConfigLayer(root, path.join(temp, "runtime")),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      const gitLayer = GitLayer.pipe(
        Layer.provide(Layer.mergeAll(dependencies, RunnerLayer.pipe(Layer.provide(dependencies)))),
      );
      yield* Effect.gen(function* () {
        const git = yield* WorkspaceDevelopmentGit;
        yield* git.git(root, ["init", "-b", "main"]);
        yield* fs.writeFileString(
          path.join(root, "checks.test.mjs"),
          "import {test} from 'node:test';test('fixed candidate',()=>{});\n",
        );
        yield* git.git(root, ["add", "checks.test.mjs"]);
        yield* git.git(root, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@localhost",
          "commit",
          "-m",
          "A",
        ]);
        const a = yield* git.inspect(root);
        const fixed = yield* git.fixedCheckout(root, a.sha);
        yield* fs.writeFileString(path.join(root, "untracked 한글.txt"), "first");
        const first = yield* git.inspect(root);
        yield* fs.writeFileString(path.join(root, "untracked 한글.txt"), "second");
        const second = yield* git.inspect(root);
        expect(first.fingerprint).not.toBe(second.fingerprint);
        yield* git.git(root, ["add", "untracked 한글.txt"]);
        yield* git.git(root, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@localhost",
          "commit",
          "-m",
          "B",
        ]);
        expect((yield* git.inspect(root)).sha).not.toBe(a.sha);
        expect((yield* git.inspect(fixed)).sha).toBe(a.sha);
        const result = yield* git.verify(
          fixed,
          [{ command: process.execPath, args: ["--test"] }],
          "real-git",
        );
        expect(result.passed).toBe(true);
        expect(result.commands[0]?.exitCode).toBe(0);
        const evidenceResult = yield* git.verify(
          fixed,
          [
            {
              command: process.execPath,
              args: [
                "-e",
                "require('node:fs').writeFileSync('result.html','<h1>verified output</h1>')",
              ],
            },
          ],
          "real-git-evidence",
          ["result.html"],
        );
        expect(evidenceResult.passed).toBe(true);
        expect(evidenceResult.artifacts[0]?.mediaType).toBe("text/html");
        expect(yield* fs.readFileString(evidenceResult.artifacts[0]!.snapshotPath!)).toContain(
          "verified output",
        );
        const missingEvidence = yield* git.verify(
          fixed,
          [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
          "real-git-missing",
          ["missing.pdf"],
        );
        expect(missingEvidence.commands[0]?.exitCode).toBe(0);
        expect(missingEvidence.passed).toBe(false);
        expect(missingEvidence.artifacts[0]?.error).toBeTruthy();
        yield* fs.writeFileString(path.join(fixed, "untracked 보존.txt"), "keep me");
        yield* git.releaseCheckout(root, fixed);
        expect(yield* fs.exists(path.join(fixed, "untracked 보존.txt"))).toBe(true);
        expect(yield* fs.readFileString(path.join(fixed, "untracked 보존.txt"))).toBe("keep me");
      }).pipe(Effect.provide(gitLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  20_000,
);
