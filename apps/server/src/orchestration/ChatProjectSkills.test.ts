import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkflowChatSkillCatalog } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { discoverChatProjectSkills, selectMentionedChatSkills } from "./ChatProjectSkills.ts";

it.layer(NodeServices.layer)("chat project skills", (it) => {
  it.effect(
    "discovers only the current directory's manually invocable skills including gemini",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-chat-project-skills-" });
        const project = path.join(base, "project");
        const other = path.join(base, "other");
        const add = (root: string, provider: string, name: string, text: string) =>
          Effect.gen(function* () {
            const directory = path.join(root, provider, "skills", name);
            yield* fs.makeDirectory(directory, { recursive: true });
            yield* fs.writeFileString(path.join(directory, "SKILL.md"), text);
          });
        yield* add(
          project,
          ".agents",
          "resume",
          "---\nname: resume\ndescription: Write applications\n---\nBody",
        );
        yield* add(
          project,
          ".claude",
          "review",
          "---\nname: review\ndescription: Review text\n---\nBody",
        );
        yield* add(
          project,
          ".gemini",
          "agy-skill",
          "---\nname: dak:setup\ndescription: Plugin skill\n---\nBody",
        );
        yield* add(
          project,
          ".agents",
          "hidden",
          "---\nname: hidden\nuser-invocable: false\n---\nBody",
        );
        yield* add(project, ".agents", "broken", "---\nname: [broken\n---\nBody");
        yield* add(other, ".agents", "other-only", "---\nname: other-only\n---\nBody");
        const current = yield* discoverChatProjectSkills(project);
        assert.deepEqual(
          current.codex.map((skill) => skill.name),
          ["resume"],
        );
        assert.deepEqual(
          current.claudeAgent.map((skill) => skill.name),
          ["review"],
        );
        assert.deepEqual(
          current.gemini.map((skill) => skill.name),
          ["review", "resume", "dak:setup"],
        );
        assert.deepEqual(
          current.grok.map((skill) => skill.name),
          ["resume", "review", "dak:setup"],
        );
        const decoded = yield* Schema.decodeUnknownEffect(WorkflowChatSkillCatalog)(current);
        assert.deepEqual(
          decoded.gemini.map((skill) => skill.name),
          ["review", "resume", "dak:setup"],
        );
        assert.deepEqual(
          selectMentionedChatSkills("Run $dak:setup and $resume please", decoded.gemini).map(
            (skill) => skill.name,
          ),
          ["dak:setup", "resume"],
        );
        assert.equal(current.codex[0]?.description, "Write applications");
        assert.deepEqual(
          (yield* discoverChatProjectSkills(other)).codex.map((skill) => skill.name),
          ["other-only"],
        );
      }),
  );
  it.effect("includes the owning project Codex skills with worktree skills taking precedence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-chat-skills-worktree-" });
      const project = path.join(base, "project");
      const worktree = path.join(base, "worktree");
      const add = (root: string, name: string) =>
        Effect.gen(function* () {
          const folder = path.join(root, ".agents", "skills", name);
          yield* fs.makeDirectory(folder, { recursive: true });
          yield* fs.writeFileString(path.join(folder, "SKILL.md"), `---\nname: ${name}\n---\nBody`);
        });
      yield* add(project, "resume");
      yield* add(project, "shared");
      yield* add(worktree, "shared");
      for (const [root, name] of [
        [project, "claude-root"],
        [project, "claude-shared"],
        [worktree, "claude-shared"],
      ] as const) {
        const folder = path.join(root, ".claude", "skills", name);
        yield* fs.makeDirectory(folder, { recursive: true });
        yield* fs.writeFileString(path.join(folder, "SKILL.md"), `---\nname: ${name}\n---\nBody`);
      }
      const claude = (yield* discoverChatProjectSkills(worktree, project)).claudeAgent;
      assert.deepEqual(
        claude.map((skill) => skill.name),
        ["claude-root", "claude-shared"],
      );
      assert.equal(
        claude.find((skill) => skill.name === "claude-shared")?.path,
        path.join(worktree, ".claude", "skills", "claude-shared", "SKILL.md"),
      );
      const skills = (yield* discoverChatProjectSkills(worktree, project)).codex;
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["resume", "shared"],
      );
      assert.equal(
        skills.find((skill) => skill.name === "shared")?.path,
        path.join(worktree, ".agents", "skills", "shared", "SKILL.md"),
      );
      assert.deepEqual(selectMentionedChatSkills("$resume and $shared; `$not-real`", skills), [
        { name: "resume", path: path.join(project, ".agents", "skills", "resume", "SKILL.md") },
        { name: "shared", path: path.join(worktree, ".agents", "skills", "shared", "SKILL.md") },
      ]);
      assert.deepEqual(
        selectMentionedChatSkills("$shared $resume $shared", skills).map((skill) => skill.name),
        ["shared", "resume"],
      );
      assert.deepEqual(
        selectMentionedChatSkills(
          "`$resume`\n```\n$shared\n```\n~~~\n$resume\n~~~\n    $resume\n$shared-extra",
          skills,
        ),
        [],
      );
    }),
  );
});
