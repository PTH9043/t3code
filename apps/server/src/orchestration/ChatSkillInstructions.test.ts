import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { mergeSharedChatSkills, readChatSkillInstructions } from "./ChatSkillInstructions.ts";

it("shares personal skills across AIs and lets the active AI and the project win", () => {
  const skill = (name: string, path: string, scope: string) => ({
    name,
    path,
    scope,
    enabled: true,
  });
  const claudeResume = skill("resume", "/home/me/.claude/skills/resume/SKILL.md", "user");
  const claudeShared = skill("shared", "/home/me/.claude/skills/shared/SKILL.md", "user");
  const claudeBuiltin = skill("builtin", "/opt/claude/skills/builtin/SKILL.md", "system");
  const codexShared = skill("shared", "/home/me/.codex/skills/shared/SKILL.md", "user");
  const codexSystem = skill(
    "imagegen",
    "/home/me/.codex/skills/.system/imagegen/SKILL.md",
    "system",
  );
  const codexStale = skill("stale", "/work/other/.agents/skills/stale/SKILL.md", "project");
  const projectPlan = skill("plan", "/work/app/.agents/skills/plan/SKILL.md", "project");
  const projectResume = skill("resume", "/work/app/.agents/skills/resume/SKILL.md", "project");
  const providers = [
    { instanceId: "claude", skills: [claudeResume, claudeShared, claudeBuiltin] },
    { instanceId: "codex", skills: [codexShared, codexSystem, codexStale] },
    { instanceId: "opencode", skills: [] },
  ];

  // An AI with no skills of its own still gets everyone's personal skills.
  assert.deepEqual(
    mergeSharedChatSkills({
      providers,
      activeInstanceId: "opencode",
      projectSkills: [projectPlan],
    }),
    [claudeResume, claudeShared, projectPlan],
  );
  // The active AI keeps its own copy and its built-ins; the project wins by name.
  assert.deepEqual(
    mergeSharedChatSkills({
      providers,
      activeInstanceId: "codex",
      projectSkills: [projectResume],
    }),
    [projectResume, codexShared, codexSystem],
  );
});

it.layer(NodeServices.layer)("chat skill instructions", (it) => {
  it.effect("hands a mentioned skill's body, without its frontmatter, to the turn input", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-chat-skill-instructions-" });
      const add = (name: string, text: string) =>
        Effect.gen(function* () {
          const directory = path.join(base, name);
          yield* fs.makeDirectory(directory, { recursive: true });
          const file = path.join(directory, "SKILL.md");
          yield* fs.writeFileString(file, text);
          return { name, path: file };
        });
      const review = yield* add(
        "review",
        "---\nname: review\ndescription: Review text\n---\n\n# Review\nRead references/rules.md first.\n",
      );
      const plain = yield* add("plain", "No frontmatter here.");
      const empty = yield* add("empty", "---\nname: empty\n---\n");
      const missing = { name: "missing", path: path.join(base, "missing", "SKILL.md") };

      const text = yield* readChatSkillInstructions([review, plain, empty, missing]);
      assert.isDefined(text);
      assert.include(
        text,
        `<t3_skill name="review" directory="${path.join(base, "review")}">\n# Review\nRead references/rules.md first.\n</t3_skill>`,
      );
      assert.include(text, "No frontmatter here.");
      assert.notInclude(text, "description: Review text");
      // A skill with nothing to say, or one that cannot be read, adds no block.
      assert.notInclude(text, 'name="empty"');
      assert.notInclude(text, 'name="missing"');
    }),
  );

  it.effect("returns nothing when no skill has instructions", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.isUndefined(yield* readChatSkillInstructions([]));
      assert.isUndefined(
        yield* readChatSkillInstructions([
          { name: "gone", path: path.join("nowhere", "SKILL.md") },
        ]),
      );
    }),
  );

  it.effect("cuts an oversized skill and says where the rest is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-chat-skill-instructions-" });
      const file = path.join(base, "SKILL.md");
      yield* fs.writeFileString(file, "x".repeat(70_000));
      const text = yield* readChatSkillInstructions([{ name: "big", path: file }]);
      assert.isDefined(text);
      assert.isBelow(text.length, 61_000);
      assert.include(text, "전체 내용은 SKILL.md에 있습니다.");
    }),
  );
});
