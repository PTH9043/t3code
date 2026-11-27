import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { makeClaudeChatSkillPlugin } from "./ClaudeChatSkills.ts";

const layer = it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-chat-skills-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
);
layer("Claude conversation skill plugin", (it) => {
  it.effect("isolates copies, keeps active versions and removes its session directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skill-source-" });
      const file = path.join(source, "SKILL.md");
      yield* fs.makeDirectory(path.join(source, "references"));
      yield* fs.writeFileString(
        file,
        "---\nname: resume\ndescription: Write a resume.\n---\nOriginal",
      );
      yield* fs.writeFileString(path.join(source, "references", "facts.md"), "original fact");
      const plugin = yield* makeClaudeChatSkillPlugin(config.stateDir);
      const policy = { runtimeMode: "full-access", model: "fixture", allowAdditionalWorkers: true };
      expect(yield* plugin.install([{ name: "resume", path: file }], policy, true)).toEqual([
        { qualifiedName: `${plugin.name}:resume`, manualOnly: false },
      ]);
      const copied = path.join(plugin.root, "skills", "resume");
      expect(yield* fs.readFileString(path.join(copied, "references", "facts.md"))).toBe(
        "original fact",
      );
      yield* fs.writeFileString(path.join(source, "references", "facts.md"), "updated fact");
      expect(
        Exit.isFailure(
          yield* Effect.exit(plugin.install([{ name: "resume", path: file }], policy, false)),
        ),
      ).toBe(true);
      expect(yield* fs.readFileString(path.join(copied, "references", "facts.md"))).toBe(
        "original fact",
      );
      yield* plugin.install([{ name: "resume", path: file }], policy, true);
      expect(yield* fs.readFileString(path.join(copied, "references", "facts.md"))).toBe(
        "updated fact",
      );
      expect(
        (yield* fs.readDirectory(plugin.root)).filter((name) => name.startsWith("stage-")),
      ).toEqual([]);
      yield* plugin.dispose;
      expect(yield* fs.exists(plugin.root)).toBe(false);
    }),
  );
  it.effect("keeps selected permissions and model when a skill asks for different settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-policy-source-" });
      const file = path.join(source, "SKILL.md");
      const plugin = yield* makeClaudeChatSkillPlugin(config.stateDir);
      const policy = {
        runtimeMode: "approval-required",
        model: "chosen-model",
        allowAdditionalWorkers: true,
      };
      yield* fs.writeFileString(file, "---\nname: resume\nallowed-tools: Bash\n---\nBody");
      expect(
        Exit.isFailure(
          yield* Effect.exit(plugin.install([{ name: "resume", path: file }], policy, true)),
        ),
      ).toBe(true);
      yield* fs.writeFileString(file, "---\nname: resume\nmodel: different-model\n---\nBody");
      expect(
        Exit.isFailure(
          yield* Effect.exit(plugin.install([{ name: "resume", path: file }], policy, true)),
        ),
      ).toBe(true);
      yield* fs.writeFileString(
        file,
        "---\nname: resume\ndisable-model-invocation: true\n---\nBody",
      );
      expect(yield* plugin.install([{ name: "resume", path: file }], policy, true)).toEqual([
        { qualifiedName: `${plugin.name}:resume`, manualOnly: true },
      ]);
      yield* plugin.dispose;
    }),
  );
});
