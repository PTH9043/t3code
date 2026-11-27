// @effect-diagnostics nodeBuiltinImport:off - Test creates temp skill directories directly.
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { discoverGeminiSkills, syncAntigravityIsolatedSkillsConfig } from "./GeminiSkills.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, folder: string, name: string, description: string) {
  const dir = NodePath.join(root, folder);
  NodeFs.mkdirSync(dir, { recursive: true });
  NodeFs.writeFileSync(
    NodePath.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nRun steps.\n`,
    "utf8",
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      NodeFs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows handle release delay
    }
  }
});

describe("GeminiSkills", () => {
  it("syncs isolated --gemini-dir/config/skills.json with flattened POSIX paths and plugins without overwriting global home", () => {
    const fakeHome = createTempDir("t3-gemini-home-");
    const globalConfigDir = NodePath.join(fakeHome, ".gemini", "config");
    const globalPluginsDir = NodePath.join(globalConfigDir, "plugins", "demo-plugin", "skills");
    NodeFs.mkdirSync(globalPluginsDir, { recursive: true });
    const globalManifest = NodePath.join(globalConfigDir, "skills.json");
    NodeFs.writeFileSync(globalManifest, '{"entries":[{"path":"~/.custom-skills"}]}\n', "utf8");
    NodeFs.writeFileSync(
      NodePath.join(globalConfigDir, "config.json"),
      JSON.stringify({ plugins: { "demo-plugin": { enabled: true } } }),
      "utf8",
    );

    const isolatedGeminiDir = NodePath.join(fakeHome, "isolated", ".gemini");
    syncAntigravityIsolatedSkillsConfig({
      geminiDir: isolatedGeminiDir,
      userHomeDir: fakeHome,
    });

    const syncedPath = NodePath.join(isolatedGeminiDir, "config", "skills.json");
    expect(NodeFs.existsSync(syncedPath)).toBe(true);
    const parsed = JSON.parse(NodeFs.readFileSync(syncedPath, "utf8")) as {
      inherits?: Array<{ path: string }>;
      entries?: Array<{ path: string }>;
    };
    expect(parsed.inherits).toBeUndefined();
    expect(parsed.entries?.every((entry) => !entry.path.startsWith("~"))).toBe(true);
    expect(parsed.entries?.some((entry) => entry.path.endsWith("/.custom-skills"))).toBe(true);
    expect(
      parsed.entries?.some((entry) => entry.path.endsWith("/plugins/demo-plugin/skills")),
    ).toBe(true);
    expect(parsed.entries?.some((entry) => entry.path.endsWith("/.claude/skills"))).toBe(true);
    expect(parsed.entries?.some((entry) => entry.path.endsWith("/.codex/skills"))).toBe(true);
    expect(NodeFs.existsSync(NodePath.join(isolatedGeminiDir, "config", "plugins.json"))).toBe(
      true,
    );

    // Calling against global ~/.gemini itself must never overwrite the user's global manifest
    syncAntigravityIsolatedSkillsConfig({
      geminiDir: NodePath.join(fakeHome, ".gemini"),
      userHomeDir: fakeHome,
    });
    expect(NodeFs.readFileSync(globalManifest, "utf8")).toBe(
      '{"entries":[{"path":"~/.custom-skills"}]}\n',
    );
  });

  it("discovers builtin, plugin, shared global, isolated, and project skills while filtering user-invocable: false", async () => {
    const fakeHome = createTempDir("t3-gemini-disc-home-");
    const workspace = createTempDir("t3-gemini-disc-ws-");
    const isolatedGeminiDir = NodePath.join(fakeHome, "t3-state", "inst-1", ".gemini");

    writeSkill(
      NodePath.join(fakeHome, ".gemini", "antigravity", "builtin", "skills"),
      "agy-builtin",
      "agy-builtin",
      "From Builtin",
    );
    writeSkill(
      NodePath.join(fakeHome, ".gemini", "config", "plugins", "dak-plugin", "skills"),
      "dak-setup",
      "dak:setup",
      "From Enabled Plugin",
    );
    writeSkill(
      NodePath.join(fakeHome, ".gemini", "config", "plugins", "disabled-plugin", "skills"),
      "disabled-skill",
      "disabled-skill",
      "Should Be Ignored",
    );
    NodeFs.writeFileSync(
      NodePath.join(fakeHome, ".gemini", "config", "config.json"),
      JSON.stringify({
        plugins: {
          "dak-plugin": { enabled: true },
          "disabled-plugin": { enabled: false },
        },
      }),
      "utf8",
    );
    const nonInvocableDir = NodePath.join(fakeHome, ".gemini", "skills", "model-only");
    NodeFs.mkdirSync(nonInvocableDir, { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(nonInvocableDir, "SKILL.md"),
      "---\nname: model-only\ndescription: Hidden\nuser-invocable: false\n---\nBody\n",
      "utf8",
    );

    writeSkill(
      NodePath.join(fakeHome, ".codex", "skills"),
      "codex-only",
      "codex-only",
      "From Codex",
    );
    writeSkill(
      NodePath.join(fakeHome, ".codex", "skills"),
      ".system",
      "hidden-sys",
      "Should be skipped",
    );
    writeSkill(
      NodePath.join(fakeHome, ".claude", "skills"),
      "claude-only",
      "claude-only",
      "From Claude",
    );
    writeSkill(
      NodePath.join(fakeHome, ".claude", "skills"),
      "shared-skill",
      "shared-skill",
      "From Claude",
    );
    writeSkill(
      NodePath.join(isolatedGeminiDir, "skills"),
      "shared-skill",
      "shared-skill",
      "From Isolated",
    );
    writeSkill(
      NodePath.join(workspace, ".agents", "skills"),
      "shared-skill",
      "shared-skill",
      "From Project",
    );
    writeSkill(
      NodePath.join(workspace, ".gemini", "skills"),
      "gemini-ws",
      "gemini-ws",
      "From Workspace Gemini",
    );

    const skills = await Effect.runPromise(
      discoverGeminiSkills(
        { homePath: "" },
        {
          geminiDir: isolatedGeminiDir,
          cwd: workspace,
          userHomeDir: fakeHome,
          environment: {},
        },
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    expect(byName.has("hidden-sys")).toBe(false);
    expect(byName.has("disabled-skill")).toBe(false);
    expect(byName.has("model-only")).toBe(false);
    expect(byName.get("agy-builtin")).toMatchObject({
      scope: "system",
      description: "From Builtin",
    });
    expect(byName.get("dak:setup")).toMatchObject({
      scope: "user",
      description: "From Enabled Plugin",
    });
    expect(byName.get("codex-only")?.description).toBe("From Codex");
    expect(byName.get("claude-only")?.description).toBe("From Claude");
    expect(byName.get("shared-skill")).toMatchObject({
      scope: "project",
      description: "From Project",
    });
    expect(byName.get("gemini-ws")).toMatchObject({
      scope: "project",
      description: "From Workspace Gemini",
    });
  });
});
