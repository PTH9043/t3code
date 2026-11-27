/**
 * GeminiSkills — filesystem discovery and isolated-home manifest syncing for
 * Antigravity CLI (`agy acp`) skills across global, account-isolated, and
 * workspace scopes.
 *
 * Antigravity discovers global skills from `<geminiDir>/config/skills` and
 * `<geminiDir>/config/skills.json`, and workspace skills from `.agents/skills`
 * and `.gemini/skills`. Because T3 isolates each Antigravity account under its
 * own `--gemini-dir`, syncing `<geminiDir>/config/skills.json` lets every T3
 * Antigravity account natively use the user's installed global skills via
 * progressive disclosure without copying files or touching auth credentials.
 *
 * @module provider/Drivers/GeminiSkills
 */
// @effect-diagnostics nodeBuiltinImport:off - Local JSON manifest sync and home path resolution.
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { GeminiSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type GeminiSkillScope = "system" | "user" | "project";

interface SkillsJsonPathEntry {
  readonly path: string;
  readonly include_only?: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
}

interface SkillsJsonManifest {
  readonly inherits?: ReadonlyArray<SkillsJsonPathEntry>;
  readonly entries?: ReadonlyArray<SkillsJsonPathEntry>;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly name?: string;
      readonly description?: string;
      readonly userInvocable: boolean;
    };

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const userInvocable = record["user-invocable"] !== false;
  return {
    kind: "parsed",
    userInvocable,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function resolveManifestPath(rawPath: string, baseDir: string, userHome: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return userHome;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return NodePath.resolve(userHome, trimmed.slice(2));
  }
  if (NodePath.isAbsolute(trimmed)) {
    return NodePath.resolve(trimmed);
  }
  return NodePath.resolve(baseDir, trimmed);
}

function matchesAnyPattern(name: string, patterns: ReadonlyArray<string> | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const raw of patterns) {
    try {
      if (new RegExp(raw).test(name)) return true;
    } catch {
      if (name === raw) return true;
    }
  }
  return false;
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    if (!NodeFs.existsSync(filePath)) return undefined;
    const parsed: unknown = JSON.parse(NodeFs.readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function discoverEnabledPluginSkillDirs(configDir: string): ReadonlyArray<string> {
  const pluginsRoot = NodePath.join(configDir, "plugins");
  if (!NodeFs.existsSync(pluginsRoot)) return [];
  const configJson = readJsonRecord(NodePath.join(configDir, "config.json"));
  const pluginsPreference =
    configJson && typeof configJson.plugins === "object" && configJson.plugins !== null
      ? (configJson.plugins as Record<string, unknown>)
      : {};
  let pluginEntries: string[] = [];
  try {
    pluginEntries = NodeFs.readdirSync(pluginsRoot).sort();
  } catch {
    return [];
  }
  const skillDirs: string[] = [];
  for (const pluginName of pluginEntries) {
    if (pluginName.startsWith(".")) continue;
    const pluginDir = NodePath.join(pluginsRoot, pluginName);
    const pref = pluginsPreference[pluginName];
    const prefRecord =
      typeof pref === "object" && pref !== null && !Array.isArray(pref)
        ? (pref as Record<string, unknown>)
        : undefined;
    if (prefRecord?.enabled === false) continue;
    if (prefRecord?.enabled !== true) {
      const manifest = readJsonRecord(NodePath.join(pluginDir, "plugin.json"));
      if (manifest?.disabled === true) continue;
    }
    const pluginSkillsDir = NodePath.join(pluginDir, "skills");
    if (NodeFs.existsSync(pluginSkillsDir)) {
      skillDirs.push(pluginSkillsDir);
    }
  }
  return skillDirs;
}

function writeJsonFileIfChanged(filePath: string, value: unknown): void {
  const payload = JSON.stringify(value, null, 2);
  if (NodeFs.existsSync(filePath)) {
    const existing = NodeFs.readFileSync(filePath, "utf8");
    if (existing.trim() === payload.trim()) {
      return;
    }
  }
  NodeFs.writeFileSync(filePath, `${payload}\n`, "utf8");
}

/**
 * Ensures an isolated Antigravity `--gemini-dir` has `<geminiDir>/config/skills.json`
 * and `<geminiDir>/config/plugins.json` manifests referencing the account's own skills,
 * enabled global plugins, and the user's shared global skill directories using resolved
 * absolute POSIX paths (avoiding Windows `agy` tilde-expansion errors without copying files
 * or modifying auth credentials).
 */
export function syncAntigravityIsolatedSkillsConfig(input: {
  readonly geminiDir: string;
  readonly userHomeDir?: string;
}): void {
  const userHome = NodePath.resolve(input.userHomeDir ?? NodeOS.homedir());
  const geminiDir = NodePath.resolve(input.geminiDir);
  const userGlobalGeminiDir = NodePath.resolve(userHome, ".gemini");
  const userGlobalConfigDir = NodePath.join(userGlobalGeminiDir, "config");
  const configDir = NodePath.join(geminiDir, "config");
  const targetManifestPath = NodePath.join(configDir, "skills.json");
  const targetPluginsManifestPath = NodePath.join(configDir, "plugins.json");
  const targetConfigJsonPath = NodePath.join(configDir, "config.json");
  const userGlobalManifestPath = NodePath.join(userGlobalConfigDir, "skills.json");

  // Never overwrite the user's own global ~/.gemini/config/skills.json if geminiDir is already ~/.gemini.
  if (geminiDir.toLowerCase() === userGlobalGeminiDir.toLowerCase()) {
    return;
  }

  const seenEntryPaths = new Set<string>();
  const entries: SkillsJsonPathEntry[] = [];
  const pushEntry = (entry: SkillsJsonPathEntry) => {
    const posix = toPosixPath(entry.path);
    const key = posix.toLowerCase();
    if (seenEntryPaths.has(key)) return;
    seenEntryPaths.add(key);
    entries.push({ ...entry, path: posix });
  };

  // List highest-specificity account directory first followed by shared global & plugin roots.
  pushEntry({ path: NodePath.join(geminiDir, "skills"), exclude: ["^\\."] });
  pushEntry({ path: NodePath.join(userGlobalConfigDir, "skills"), exclude: ["^\\."] });
  for (const pluginSkillDir of discoverEnabledPluginSkillDirs(userGlobalConfigDir)) {
    pushEntry({ path: pluginSkillDir, exclude: ["^\\."] });
  }
  pushEntry({ path: NodePath.join(userGlobalGeminiDir, "skills"), exclude: ["^\\."] });
  pushEntry({ path: NodePath.join(userHome, ".agents", "skills"), exclude: ["^\\."] });
  pushEntry({ path: NodePath.join(userHome, ".claude", "skills"), exclude: ["^\\."] });
  pushEntry({ path: NodePath.join(userHome, ".codex", "skills"), exclude: ["^\\."] });

  // Flatten inherited global `skills.json` entries into resolved absolute POSIX paths
  // because Windows `agy.exe` fails on `~/` paths inside inherited manifests.
  for (const resolved of readManifestEntries(userGlobalManifestPath, userHome, new Set())) {
    pushEntry({
      path: resolved.directory,
      ...(resolved.includeOnly ? { include_only: resolved.includeOnly } : {}),
      ...(resolved.exclude ? { exclude: resolved.exclude } : {}),
    });
  }

  try {
    NodeFs.mkdirSync(configDir, { recursive: true });
    writeJsonFileIfChanged(targetManifestPath, { entries });

    const userGlobalPluginsDir = NodePath.join(userGlobalConfigDir, "plugins");
    if (NodeFs.existsSync(userGlobalPluginsDir)) {
      writeJsonFileIfChanged(targetPluginsManifestPath, {
        entries: [{ path: toPosixPath(userGlobalPluginsDir), exclude: ["^\\."] }],
      });
      const globalConfig = readJsonRecord(NodePath.join(userGlobalConfigDir, "config.json"));
      const globalPlugins =
        globalConfig && typeof globalConfig.plugins === "object" && globalConfig.plugins !== null
          ? (globalConfig.plugins as Record<string, unknown>)
          : undefined;
      if (globalPlugins && Object.keys(globalPlugins).length > 0) {
        const existingIsolatedConfig = readJsonRecord(targetConfigJsonPath) ?? {};
        const existingPlugins =
          typeof existingIsolatedConfig.plugins === "object" &&
          existingIsolatedConfig.plugins !== null &&
          !Array.isArray(existingIsolatedConfig.plugins)
            ? (existingIsolatedConfig.plugins as Record<string, unknown>)
            : {};
        writeJsonFileIfChanged(targetConfigJsonPath, {
          ...existingIsolatedConfig,
          plugins: {
            ...globalPlugins,
            ...existingPlugins,
          },
        });
      }
    }
  } catch {
    // Best-effort: never block Antigravity launch if the isolated config dir is read-only.
  }
}

export const resolveGeminiDirPath = Effect.fn("resolveGeminiDirPath")(function* (
  config: Pick<GeminiSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  geminiDirOverride?: string,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  if (geminiDirOverride && geminiDirOverride.trim().length > 0) {
    return path.resolve(geminiDirOverride.trim());
  }
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath), ".gemini");
  }
  const envHome = environment.GEMINI_HOME?.trim() ?? "";
  if (envHome.length > 0) {
    return cwd ? path.resolve(cwd, envHome) : path.resolve(envHome);
  }
  return path.join(NodeOS.homedir(), ".gemini");
});

function readManifestEntries(
  manifestPath: string,
  userHome: string,
  visited: Set<string>,
): ReadonlyArray<{
  readonly directory: string;
  readonly includeOnly?: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
}> {
  const resolvedPath = NodePath.resolve(manifestPath);
  const key = resolvedPath.toLowerCase();
  if (visited.has(key) || !NodeFs.existsSync(resolvedPath)) {
    return [];
  }
  visited.add(key);

  let parsed: unknown;
  try {
    parsed = JSON.parse(NodeFs.readFileSync(resolvedPath, "utf8"));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const manifest = parsed as SkillsJsonManifest;
  const baseDir = NodePath.dirname(resolvedPath);
  const results: Array<{
    readonly directory: string;
    readonly includeOnly?: ReadonlyArray<string>;
    readonly exclude?: ReadonlyArray<string>;
  }> = [];

  if (Array.isArray(manifest.inherits)) {
    for (const parent of manifest.inherits) {
      if (!parent || typeof parent.path !== "string" || !parent.path.trim()) continue;
      const parentPath = resolveManifestPath(parent.path, baseDir, userHome);
      results.push(...readManifestEntries(parentPath, userHome, visited));
    }
  }
  if (Array.isArray(manifest.entries)) {
    for (const entry of manifest.entries) {
      if (!entry || typeof entry.path !== "string" || !entry.path.trim()) continue;
      results.push({
        directory: resolveManifestPath(entry.path, baseDir, userHome),
        ...(Array.isArray(entry.include_only) ? { includeOnly: entry.include_only } : {}),
        ...(Array.isArray(entry.exclude) ? { exclude: entry.exclude } : {}),
      });
    }
  }
  return results;
}

/**
 * Enumerates Antigravity skills from shared global roots (`skills.json` +
 * `~/.codex`, `~/.claude`, `~/.agents`, `~/.gemini`), the account's isolated
 * `--gemini-dir`, and the current workspace (`.agents/skills`, `.gemini/skills`).
 *
 * Precedence on name collision (later overwrites earlier):
 * shared global -> user ~/.gemini -> account-isolated geminiDir -> project workspace.
 */
export const discoverGeminiSkills = Effect.fn("discoverGeminiSkills")(function* (
  config: Pick<GeminiSettings, "homePath">,
  options?: {
    readonly geminiDir?: string;
    readonly cwd?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly userHomeDir?: string;
  },
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = options?.environment ?? process.env;
  const userHome = NodePath.resolve(options?.userHomeDir ?? NodeOS.homedir());
  const geminiDir = yield* resolveGeminiDirPath(
    config,
    environment,
    options?.geminiDir,
    options?.cwd,
  );

  // Ordered lowest -> highest precedence so Map.set resolves name collisions cleanly.
  const scanRoots: Array<{
    readonly directory: string;
    readonly scope: GeminiSkillScope;
    readonly includeOnly?: ReadonlyArray<string>;
    readonly exclude?: ReadonlyArray<string>;
  }> = [];

  const seenDirs = new Set<string>();
  const pushRoot = (root: {
    readonly directory: string;
    readonly scope: GeminiSkillScope;
    readonly includeOnly?: ReadonlyArray<string>;
    readonly exclude?: ReadonlyArray<string>;
  }) => {
    const key = `${root.scope}:${NodePath.resolve(root.directory).toLowerCase()}`;
    if (seenDirs.has(key)) return;
    seenDirs.add(key);
    scanRoots.push(root);
  };

  // 0. Built-in Antigravity skills (`scope: "system"` — shown only when Antigravity is selected)
  pushRoot({
    directory: path.join(userHome, ".gemini", "antigravity", "builtin", "skills"),
    scope: "system",
    exclude: ["^\\."],
  });
  pushRoot({
    directory: path.join(userHome, ".gemini", "antigravity-cli", "builtin", "skills"),
    scope: "system",
    exclude: ["^\\."],
  });

  // 1. Lowest user priority: shared user roots from other harnesses
  pushRoot({
    directory: path.join(userHome, ".codex", "skills"),
    scope: "user",
    exclude: ["^\\."],
  });
  pushRoot({
    directory: path.join(userHome, ".claude", "skills"),
    scope: "user",
    exclude: ["^\\."],
  });
  pushRoot({
    directory: path.join(userHome, ".agents", "skills"),
    scope: "user",
    exclude: ["^\\."],
  });

  // 2. Global Antigravity roots + enabled plugins + skills.json manifest entries
  const globalManifest = path.join(userHome, ".gemini", "config", "skills.json");
  const globalManifestEntries = readManifestEntries(globalManifest, userHome, new Set());
  for (const entry of [...globalManifestEntries].reverse()) {
    pushRoot({ ...entry, scope: "user" });
  }
  for (const pluginSkillDir of discoverEnabledPluginSkillDirs(
    path.join(userHome, ".gemini", "config"),
  )) {
    pushRoot({ directory: pluginSkillDir, scope: "user", exclude: ["^\\."] });
  }
  pushRoot({
    directory: path.join(userHome, ".gemini", "skills"),
    scope: "user",
    exclude: ["^\\."],
  });
  pushRoot({
    directory: path.join(userHome, ".gemini", "config", "skills"),
    scope: "user",
    exclude: ["^\\."],
  });

  // 3. Account-isolated geminiDir (if distinct from ~/.gemini)
  const isolatedManifest = path.join(geminiDir, "config", "skills.json");
  const isolatedEntries = readManifestEntries(isolatedManifest, userHome, new Set());
  for (const entry of [...isolatedEntries].reverse()) {
    pushRoot({ ...entry, scope: "user" });
  }
  for (const pluginSkillDir of discoverEnabledPluginSkillDirs(path.join(geminiDir, "config"))) {
    pushRoot({ directory: pluginSkillDir, scope: "user", exclude: ["^\\."] });
  }
  pushRoot({
    directory: path.join(geminiDir, "config", "skills"),
    scope: "user",
    exclude: ["^\\."],
  });
  pushRoot({ directory: path.join(geminiDir, "skills"), scope: "user", exclude: ["^\\."] });

  // 4. Highest priority: workspace project roots
  if (options?.cwd) {
    pushRoot({
      directory: path.join(options.cwd, ".agents", "skills"),
      scope: "project",
      exclude: ["^\\."],
    });
    pushRoot({
      directory: path.join(options.cwd, ".gemini", "skills"),
      scope: "project",
      exclude: ["^\\."],
    });
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of scanRoots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      if (entry.startsWith(".")) continue;
      if (root.exclude && matchesAnyPattern(entry, root.exclude)) continue;
      if (
        root.includeOnly &&
        root.includeOnly.length > 0 &&
        !matchesAnyPattern(entry, root.includeOnly)
      ) {
        continue;
      }
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) continue;

      const frontmatter = parseSkillFrontmatter(contents);
      if (frontmatter.kind === "malformed") continue;
      if (frontmatter.kind === "parsed" && !frontmatter.userInvocable) continue;

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) continue;

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
