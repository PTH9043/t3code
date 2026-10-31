import { expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import { manageExtension } from "./ExtensionManager.ts";
import {
  pluginActionsFromHelp,
  pluginActionArgs,
  pluginEntriesFromJson,
} from "./ExtensionManager.ts";

it("derives supported actions from each installed CLI without inventing Codex toggle commands", () => {
  expect(
    pluginActionsFromHelp("codex", "  add  Install\n  list  List\n  remove  Uninstall"),
  ).toEqual(["install", "uninstall"]);
  expect(
    pluginActionsFromHelp(
      "claudeAgent",
      "  install|i  Install\n  update  Update\n  enable  Enable\n  disable  Disable\n  uninstall  Remove",
    ),
  ).toEqual(["install", "update", "enable", "disable", "uninstall"]);
  expect(
    pluginActionArgs({ provider: "codex", action: "install", target: "docs@official" }),
  ).toEqual(["plugin", "add", "docs@official", "--json"]);
  expect(
    pluginActionArgs({
      provider: "grok",
      action: "install",
      target: "https://github.com/example/plugin",
      trust: true,
    }),
  ).toEqual([
    "--no-auto-update",
    "plugin",
    "install",
    "https://github.com/example/plugin",
    "--trust",
  ]);
  expect(() =>
    pluginActionArgs({ provider: "grok", action: "install", target: "--debug" }),
  ).toThrow();
});

it("preserves origin, state and scope from differing native plugin list formats", () => {
  expect(
    pluginEntriesFromJson(
      "codex",
      {
        installed: [
          {
            pluginId: "docs@official",
            name: "docs",
            enabled: false,
            version: "1.2",
            source: { path: "/plugins/docs" },
          },
        ],
      },
      ["uninstall"],
    ),
  ).toMatchObject([
    { id: "docs@official", source: "/plugins/docs", enabled: false, version: "1.2", scope: "user" },
  ]);
  expect(
    pluginEntriesFromJson(
      "claudeAgent",
      [{ name: "docs", scope: "project", source: "official" }],
      ["update"],
    ),
  ).toMatchObject([{ scope: "project", source: "official" }]);
  expect(() => pluginEntriesFromJson("grok", { ignored: "unknown format" }, [])).toThrow(
    "목록 형식",
  );
  expect(
    pluginActionArgs({
      provider: "claudeAgent",
      action: "uninstall",
      target: "docs@official",
      scope: "local",
      workspaceRoot: "/project",
    }),
  ).toEqual(["plugin", "uninstall", "docs@official", "--json", "--scope", "local"]);
});

effectIt.effect(
  "installs, updates, disables, reenables and removes only its managed project skill",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-skill-" });
      const source = path.join(temp, "source", "sample");
      const project = path.join(temp, "project");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.makeDirectory(project);
      yield* fs.writeFileString(path.join(source, "SKILL.md"), "# Original");
      const layer = Layer.mergeAll(Config.layerTest(project, temp), Settings.layerTest());
      const run = (
        action: "install" | "update" | "enable" | "disable" | "uninstall",
        target: string,
      ) =>
        manageExtension({
          workspaceRoot: project,
          provider: "grok",
          kind: "skill",
          action,
          target,
        }).pipe(Effect.provide(layer));
      const installed = path.join(project, ".agents", "skills", "sample");
      const disabled = path.join(project, ".agents", "skills-disabled", "sample");
      yield* run("install", source);
      expect(yield* fs.readFileString(path.join(installed, "SKILL.md"))).toBe("# Original");
      expect((yield* run("install", source).pipe(Effect.result))._tag).toBe("Failure");
      yield* fs.writeFileString(path.join(source, "SKILL.md"), "# Updated");
      yield* run("update", installed);
      expect(yield* fs.readFileString(path.join(installed, "SKILL.md"))).toBe("# Updated");
      yield* run("disable", installed);
      expect(yield* fs.exists(installed)).toBe(false);
      expect(yield* fs.exists(path.join(disabled, "SKILL.md"))).toBe(true);
      yield* run("enable", disabled);
      expect(yield* fs.exists(installed)).toBe(true);
      expect((yield* run("uninstall", source).pipe(Effect.result))._tag).toBe("Failure");
      const unmanaged = path.join(project, ".agents", "skills", "unmanaged");
      yield* fs.makeDirectory(unmanaged);
      yield* fs.writeFileString(path.join(unmanaged, "SKILL.md"), "Keep");
      expect((yield* run("uninstall", unmanaged).pipe(Effect.result))._tag).toBe("Failure");
      yield* run("uninstall", installed);
      expect(yield* fs.exists(installed)).toBe(false);
      expect(yield* fs.readFileString(path.join(source, "SKILL.md"))).toBe("# Updated");
      expect(yield* fs.exists(unmanaged)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
