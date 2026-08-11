import { CommandId, ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(".", { prefix: "new-auto-usage-normalizer-" }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("Workspace control command normalization", (it) => {
  it.effect("creates a default isolated memory root below the server data directory", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectId = ProjectId.make("workspace-a");

      const normalized = yield* normalizeDispatchCommand({
        type: "project.create",
        commandId: CommandId.make("create-workspace-a"),
        projectId,
        title: "Workspace A",
        workspaceRoot: config.cwd,
        createdAt: "2031-01-01T00:00:00.000Z",
      });

      expect(normalized.type).toBe("project.create");
      if (normalized.type !== "project.create") return;
      const expectedRoot = path.join(
        config.baseDir,
        "workspaces",
        projectId,
        "memory",
        "long-term",
      );
      expect(normalized.longTermMemoryRoot).toBe(expectedRoot);
      expect(yield* fileSystem.exists(expectedRoot)).toBe(true);
    }),
  );
});
