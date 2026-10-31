import { describe, expect, it as test } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { SkillMetadata } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { makeWorkflowSkills, parseWorkflowSkill, workflowSkillSupport } from "./WorkflowSkills.ts";

const policy = { runtimeMode: "full-access", model: "fixture", allowAdditionalWorkers: false };
const text = (extra: string) =>
  `---\nname: fixture\ndescription: A controlled workflow skill.\n${extra}\n---\nRead references only when needed.\n`;
const cases = [
  ["portable Codex native", "", "native", "codex", true],
  ["portable Claude native", "", "native", "claudeAgent", true],
  ["Codex instructions", "", "instructions", "codex", true],
  ["Claude instructions", "", "instructions", "claudeAgent", true],
  ["Cursor instructions", "", "instructions", "cursor", true],
  ["OpenCode instructions", "", "instructions", "opencode", true],
  ["Grok instructions", "", "instructions", "grok", true],
  ["native allowed-tools keeps full access", "allowed-tools: Read", "native", "claudeAgent", true],
  [
    "model-only Codex cannot be selected manually",
    "user-invocable: false",
    "native",
    "codex",
    false,
  ],
  [
    "model-only Claude cannot be selected manually",
    "user-invocable: false",
    "native",
    "claudeAgent",
    false,
  ],
  [
    "model-only instructions cannot bypass policy",
    "user-invocable: false",
    "instructions",
    "codex",
    false,
  ],
  [
    "fully disabled native Codex",
    "user-invocable: false\ndisable-model-invocation: true",
    "native",
    "codex",
    false,
  ],
  [
    "fully disabled native Claude",
    "user-invocable: false\ndisable-model-invocation: true",
    "native",
    "claudeAgent",
    false,
  ],
  [
    "fully disabled instructions",
    "user-invocable: false\ndisable-model-invocation: true",
    "instructions",
    "grok",
    false,
  ],
  ["unsupported native Cursor", "", "native", "cursor", false],
  ["unsupported native OpenCode", "", "native", "opencode", false],
  ["manual-only Codex native", "disable-model-invocation: true", "native", "codex", true],
  ["manual-only Claude native", "disable-model-invocation: true", "native", "claudeAgent", true],
  ["argument hint remains metadata", "argument-hint: '[target]'", "instructions", "codex", true],
  [
    "compatibility remains visible",
    "compatibility: Requires a project checkout",
    "native",
    "codex",
    true,
  ],
  ["Claude fork is not silently flattened", "context: fork", "instructions", "codex", false],
  ["Codex does not silently ignore native hooks", "hooks: {}", "native", "codex", false],
  [
    "native model cannot override selection",
    "model: another-model",
    "native",
    "claudeAgent",
    false,
  ],
  [
    "native fork cannot add an unselected worker",
    "context: fork\nagent: Explore",
    "native",
    "claudeAgent",
    false,
  ],
] as const;

describe("24 workflow skill invocation and compatibility fixtures", () => {
  test.each(cases)("%s", (_name, extra, mode, driver, allowed) => {
    expect(
      workflowSkillSupport(parseWorkflowSkill(text(extra), "fallback"), mode, driver, policy) ===
        null,
    ).toBe(allowed);
  });
  test("keeps unknown frontmatter and rejects malformed YAML", () => {
    expect(parseWorkflowSkill(text("vendor-feature: enabled"), "fallback").extensions).toEqual({
      "vendor-feature": "enabled",
    });
    expect(() => parseWorkflowSkill(text("allowed-tools: ["), "fallback")).toThrow();
  });
  test("does not grant native automatic tools or hooks in limited mode", () => {
    expect(
      workflowSkillSupport(
        parseWorkflowSkill(text("allowed-tools: Read"), "fallback"),
        "native",
        "claudeAgent",
        { ...policy, runtimeMode: "approval-required" },
      ),
    ).not.toBeNull();
  });
});

const layer = it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-workflow-skills-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
);
layer("Pinned workflow skill resources", (it) => {
  it.effect(
    "pins source and references, reuses the same immutable copy and rejects tampering",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-source-" });
        yield* fs.makeDirectory(path.join(root, "references"));
        yield* fs.writeFileString(path.join(root, "SKILL.md"), text(""));
        yield* fs.writeFileString(path.join(root, "references", "details.md"), "original resource");
        const skills = yield* makeWorkflowSkills;
        const manifest = yield* skills.manifest(path.join(root, "SKILL.md"));
        const metadata: SkillMetadata = {
          ...parseWorkflowSkill(text(""), "fixture"),
          path: path.join(root, "SKILL.md"),
          scope: "project",
          provider: "codex",
          enabled: true,
          diagnostics: [],
          digest: manifest.digest,
        };
        const binding = {
          name: "fixture",
          path: metadata.path,
          provider: "codex",
          mode: "instructions" as const,
          arguments: "target",
          digest: manifest.digest,
        };
        const pinned = yield* skills.pin(binding, metadata);
        const repeated = yield* skills.pin(binding, metadata);
        expect(repeated.snapshotPath).toBe(pinned.snapshotPath);
        yield* fs.writeFileString(
          path.join(root, "references", "details.md"),
          "updated source resource",
        );
        expect((yield* skills.materialize([pinned], "codex", policy)).instructions).toContain(
          "Arguments: target",
        );
        expect(pinned.snapshotPath).toBeDefined();
        expect(
          yield* fs.readFileString(
            path.join(path.dirname(pinned.snapshotPath!), "references", "details.md"),
          ),
        ).toBe("original resource");
        yield* fs.writeFileString(pinned.snapshotPath!, "tampered");
        expect(
          Exit.isFailure(yield* Effect.exit(skills.materialize([pinned], "codex", policy))),
        ).toBe(true);
      }),
  );
  it.effect(
    "passes the pinned path to Codex native and builds a resource-complete Claude native plugin",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-skill-source-" });
        yield* fs.writeFileString(path.join(root, "SKILL.md"), text("argument-hint: '[target]'"));
        const skills = yield* makeWorkflowSkills;
        const manifest = yield* skills.manifest(path.join(root, "SKILL.md"));
        const metadata: SkillMetadata = {
          ...parseWorkflowSkill(text("argument-hint: '[target]'"), "fixture"),
          path: path.join(root, "SKILL.md"),
          scope: "project",
          provider: "codex",
          enabled: true,
          diagnostics: [],
          digest: manifest.digest,
        };
        const pinned = yield* skills.pin(
          {
            name: "fixture",
            path: metadata.path,
            provider: "codex",
            mode: "native",
            arguments: "selected target",
            digest: manifest.digest,
          },
          metadata,
        );
        expect((yield* skills.materialize([pinned], "codex", policy)).native).toEqual([
          { name: "fixture", path: pinned.snapshotPath },
        ]);
        const claude = yield* skills.materialize([pinned], "claudeAgent", policy);
        expect(claude.plugins).toHaveLength(1);
        expect(claude.instructions).toContain(`t3-workflow-${manifest.digest}:fixture`);
        expect(
          (yield* skills.manifest(path.join(claude.plugins[0]!, "skills", "selected", "SKILL.md")))
            .digest,
        ).toBe(manifest.digest);
      }),
  );
});
