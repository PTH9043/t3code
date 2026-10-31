import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - FileSystem.symlink cannot request the junction type required by this Windows fixture.
import * as NodeFSP from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { WORKSPACE_EVIDENCE_MAX_BYTES } from "@t3tools/contracts";
import { captureVerificationArtifacts } from "./WorkspaceVerificationArtifacts.ts";
import { readAutomationEvidence } from "./workspaceAutomation.ts";
import { state, workspace } from "./workspaceDevelopmentFixtures.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jW7kAAAAASUVORK5CYII=",
  "base64",
);
it.effect(
  "keeps immutable verification snapshots after the original output changes and rejects modified snapshots",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const cwd = path.join(temp, "검증 작업실");
      const database = path.join(temp, "runtime", "state.sqlite");
      const directory = path.join(path.dirname(database), "workspace-development", "evidence");
      yield* fs.makeDirectory(cwd);
      yield* fs.writeFile(path.join(cwd, "화면.png"), png);
      yield* fs.writeFileString(
        path.join(cwd, "보고서.html"),
        "<h1>검증 당시 결과</h1><p>API_KEY=sk-private-token</p>",
      );
      const artifacts = yield* captureVerificationArtifacts(
        cwd,
        ["화면.png", "보고서.html"],
        directory,
      );
      expect(artifacts.every((a) => !a.error)).toBe(true);
      expect(artifacts[0]?.sha256).toBe(NodeCrypto.createHash("sha256").update(png).digest("hex"));
      yield* fs.writeFileString(path.join(cwd, "보고서.html"), "다른 결과");
      yield* fs.remove(path.join(cwd, "화면.png"));
      const withEvidence = {
        ...state,
        verifications: [
          {
            id: "v-artifacts",
            workspaceId: workspace.id,
            candidateSha: "candidate",
            generation: 1,
            requirementRevision: 1,
            targetSha: "target",
            commands: [],
            status: "passed" as const,
            verifiedAt: "2026-10-11T12:00:00Z",
            artifacts,
          },
        ],
      };
      const input = {
        projectId: state.projectId,
        kind: "verification-artifact" as const,
        recordId: "v-artifacts",
        index: 0,
        label: "ignored",
      };
      const image = yield* readAutomationEvidence(withEvidence, input, database);
      expect(image.mediaType).toBe("image/png");
      expect(image.contents).toBe(png.toString("base64"));
      const html = yield* readAutomationEvidence(withEvidence, { ...input, index: 1 }, database);
      expect(html.contents).toContain("검증 당시 결과");
      expect(html.contents).not.toContain("sk-private-token");
      expect(html.encoding).toBe("utf8");
      yield* fs.writeFileString(artifacts[0]!.snapshotPath!, "changed");
      expect(
        (yield* readAutomationEvidence(withEvidence, input, database).pipe(Effect.flip)).message,
      ).toContain("달라졌습니다");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "records missing, unsupported, oversized and escaped files without reading outside the verification checkout",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const cwd = path.join(temp, "checkout");
      const outside = path.join(temp, "outside");
      yield* fs.makeDirectory(cwd);
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(path.join(outside, "secret.html"), "outside secret");
      yield* Effect.promise(() => NodeFSP.symlink(outside, path.join(cwd, "linked"), "junction"));
      yield* fs.writeFileString(path.join(cwd, "wrong.png"), "not an image");
      yield* fs.writeFileString(
        path.join(cwd, "large.txt"),
        "x".repeat(WORKSPACE_EVIDENCE_MAX_BYTES + 1),
      );
      const artifacts = yield* captureVerificationArtifacts(
        cwd,
        [
          "missing.pdf",
          "../outside/secret.html",
          "linked/secret.html",
          "large.txt",
          "wrong.png",
          "run.exe",
          path.join(outside, "secret.html"),
        ],
        path.join(temp, "snapshots"),
      );
      expect(artifacts).toHaveLength(7);
      expect(artifacts.every((a) => a.error && !a.snapshotPath)).toBe(true);
      expect(artifacts[2]?.error).toContain("작업실 밖");
      expect(artifacts[3]?.error).toContain("4 MiB");
      expect(artifacts[4]?.error).toContain("파일 형식");
      expect(yield* fs.exists(path.join(temp, "snapshots"))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "bounds the evidence count and total bytes and refuses invalid UTF-8 and empty files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const cwd = path.join(temp, "checkout");
      yield* fs.makeDirectory(cwd);
      yield* fs.writeFileString(
        path.join(cwd, "full.txt"),
        "x".repeat(WORKSPACE_EVIDENCE_MAX_BYTES),
      );
      yield* fs.writeFileString(path.join(cwd, "extra.txt"), "extra");
      yield* fs.writeFileString(path.join(cwd, "empty.txt"), "");
      yield* fs.writeFile(path.join(cwd, "invalid.html"), new Uint8Array([255]));
      const artifacts = yield* captureVerificationArtifacts(
        cwd,
        ["full.txt", "full.txt", "full.txt", "full.txt", "extra.txt", "empty.txt", "invalid.html"],
        path.join(temp, "snapshots"),
      );
      expect(artifacts.slice(0, 4).every((a) => !a.error)).toBe(true);
      expect(artifacts[4]?.error).toContain("16 MiB");
      expect(artifacts[5]?.error).toContain("비어 있습니다");
      expect(artifacts[6]?.error).toContain("UTF-8");
      expect(
        (yield* captureVerificationArtifacts(
          cwd,
          Array(9).fill("extra.txt"),
          path.join(temp, "snapshots"),
        ).pipe(Effect.flip)).message,
      ).toContain("최대 8개");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
