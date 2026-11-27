import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { parse as parseYaml } from "yaml";
import {
  WorkspaceWorkflowError,
  type SkillBinding,
  type SkillMetadata,
  type SkillResourceDigest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";

const sha = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const isWorkflowError = Schema.is(WorkspaceWorkflowError);
const portable = new Set([
  "name",
  "description",
  "argument-hint",
  "compatibility",
  "license",
  "metadata",
  "disable-model-invocation",
  "user-invocable",
]);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function parseWorkflowSkill(text: string, fallbackName: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const meta = frontmatter ? object(parseYaml(frontmatter[1] ?? "")) : {};
  const name = typeof meta.name === "string" ? meta.name.trim() : fallbackName;
  const manual = meta["user-invocable"] !== false;
  const model = meta["disable-model-invocation"] !== true;
  const extensions = Object.fromEntries(Object.entries(meta).filter(([key]) => !portable.has(key)));
  const tools = meta["allowed-tools"];
  return {
    name,
    description: typeof meta.description === "string" ? meta.description : "",
    invocation: manual
      ? model
        ? ("both" as const)
        : ("manual" as const)
      : model
        ? ("model" as const)
        : ("disabled" as const),
    argumentHint: typeof meta["argument-hint"] === "string" ? meta["argument-hint"] : "",
    compatibility: typeof meta.compatibility === "string" ? meta.compatibility : "",
    allowedTools: Array.isArray(tools)
      ? tools.filter((tool): tool is string => typeof tool === "string")
      : typeof tools === "string"
        ? tools.split(/[,\s]+/).filter(Boolean)
        : [],
    nativeOnly: Object.keys(extensions).length > 0,
    extensions,
  };
}

export function workflowSkillSupport(
  metadata: ReturnType<typeof parseWorkflowSkill>,
  mode: SkillBinding["mode"],
  driver: string,
  policy: { runtimeMode: string; model: string; allowAdditionalWorkers: boolean },
) {
  if (!["both", "manual"].includes(metadata.invocation)) return "직접 호출할 수 없는 스킬입니다.";
  if (mode === "instructions")
    return metadata.nativeOnly ? "제공자 전용 기능을 지침 전달로 대체할 수 없습니다." : null;
  if (!["codex", "claudeAgent", "gemini"].includes(driver))
    return `${driver}의 고정 native 스킬 호출은 지원되지 않습니다.`;
  if ((driver === "codex" || driver === "gemini") && metadata.nativeOnly)
    return `${driver === "gemini" ? "Antigravity" : "Codex"}가 이 스킬의 제공자 전용 확장을 지원하지 않습니다.`;
  if (driver === "claudeAgent") {
    const supported = new Set([
      "allowed-tools",
      "context",
      "agent",
      "model",
      "hooks",
      "arguments",
      "background",
      "when_to_use",
      "paths",
    ]);
    if (Object.keys(metadata.extensions).some((key) => !supported.has(key)))
      return "현재 Claude SDK에서 검증하지 않은 스킬 확장이 있습니다.";
    if (
      (metadata.extensions.context === "fork" || metadata.extensions.agent) &&
      !policy.allowAdditionalWorkers
    )
      return "이 스킬의 별도 작업자는 현재 참가자 설정에서 허용되지 않습니다.";
    if (
      metadata.extensions.model &&
      metadata.extensions.model !== "inherit" &&
      metadata.extensions.model !== policy.model
    )
      return "스킬의 모델 지정이 현재 선택한 모델과 다릅니다.";
    if (
      (metadata.allowedTools.length || metadata.extensions.hooks) &&
      policy.runtimeMode !== "full-access"
    )
      return "현재 제한 권한에서 스킬의 도구 자동 허용·hook을 적용할 수 없습니다.";
  }
  return null;
}

export const makeWorkflowSkills = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* Effect.serviceOption(ServerSettingsService);
  const config = yield* ServerConfig;
  const failure = (cause: unknown) =>
    isWorkflowError(cause)
      ? cause
      : new WorkspaceWorkflowError({
          message: cause instanceof Error ? cause.message : "스킬 파일을 확인하지 못했습니다.",
          cause,
        });
  const manifest = Effect.fn("WorkflowSkills.manifest")(function* (skillPath: string) {
    const root = yield* fs.realPath(path.dirname(skillPath));
    const resources: SkillResourceDigest[] = [];
    const seen = new Set<string>();
    const visit = (directory: string): Effect.Effect<void, WorkspaceWorkflowError> =>
      Effect.gen(function* () {
        const real = yield* fs.realPath(directory);
        const relative = path.relative(root, real);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          return yield* new WorkspaceWorkflowError({
            message: "스킬 자원이 폴더 밖을 참조합니다.",
          });
        if (seen.has(real))
          return yield* new WorkspaceWorkflowError({
            message: "스킬 자원에 순환 연결이 있습니다.",
          });
        seen.add(real);
        const entries = yield* fs.readDirectory(directory);
        for (const entry of entries.toSorted()) {
          const item = path.join(directory, entry);
          const realItem = yield* fs.realPath(item);
          const relativeItem = path.relative(root, realItem);
          if (
            relativeItem === ".." ||
            relativeItem.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativeItem)
          )
            return yield* new WorkspaceWorkflowError({
              message: "스킬 자원이 폴더 밖을 참조합니다.",
            });
          const info = yield* fs.stat(item);
          if (info.type === "Directory") yield* visit(item);
          else if (info.type === "File") {
            const hash = NodeCrypto.createHash("sha256");
            let bytes = 0;
            yield* Stream.runForEach(fs.stream(item), (chunk) =>
              Effect.sync(() => {
                bytes += chunk.byteLength;
                hash.update(chunk);
              }),
            );
            resources.push({
              path: path.relative(root, item).split(path.sep).join("/"),
              sha256: hash.digest("hex"),
              bytes,
            });
          } else
            return yield* new WorkspaceWorkflowError({
              message: "지원하지 않는 스킬 자원 형식입니다.",
            });
        }
        seen.delete(real);
      }).pipe(Effect.mapError(failure));
    yield* visit(root);
    resources.sort((a, b) => a.path.localeCompare(b.path));
    return { root, resources, digest: sha(encodeJson(resources)) };
  }, Effect.mapError(failure));

  const catalog = Effect.fn("WorkflowSkills.catalog")(function* (cwd: string) {
    if (Option.isNone(settingsService))
      return yield* new WorkspaceWorkflowError({
        message: "스킬 설정 서비스를 사용할 수 없습니다.",
      });
    const settings = yield* settingsService.value.getSettings;
    const home = NodeOS.homedir();
    const resolveHome = (value: string | undefined, fallback: string) =>
      path.resolve(cwd, expandHomePath(value?.trim() || fallback));
    const roots: Array<{ directory: string; provider: string; scope: string }> = [];
    const add = (provider: string, userHome: string, projectDirectory: string) => {
      roots.push({ directory: path.join(userHome, "skills"), provider, scope: "user" });
      roots.push({
        directory: path.join(cwd, projectDirectory, "skills"),
        provider,
        scope: "project",
      });
    };
    add(
      "codex",
      resolveHome(
        settings.providers.codex.homePath || process.env.CODEX_HOME,
        path.join(home, ".codex"),
      ),
      ".agents",
    );
    add(
      "claudeAgent",
      resolveHome(
        settings.providers.claudeAgent.homePath || process.env.CLAUDE_CONFIG_DIR,
        path.join(home, ".claude"),
      ),
      ".claude",
    );
    add("gemini", resolveHome(process.env.GEMINI_HOME, path.join(home, ".gemini")), ".gemini");
    roots.push({
      directory: path.join(cwd, ".agents", "skills"),
      provider: "gemini",
      scope: "project",
    });
    roots.push({
      directory: path.join(home, ".gemini", "config", "skills"),
      provider: "gemini",
      scope: "user",
    });
    roots.push({
      directory: path.join(
        config.stateDir,
        "provider-instances",
        "gemini",
        "antigravity-home",
        ".gemini",
        "skills",
      ),
      provider: "gemini",
      scope: "user",
    });
    roots.push({
      directory: path.join(
        config.stateDir,
        "provider-instances",
        "gemini",
        "antigravity-home",
        ".gemini",
        "config",
        "skills",
      ),
      provider: "gemini",
      scope: "user",
    });
    roots.push({
      directory: path.join(home, ".agents", "skills"),
      provider: "gemini",
      scope: "user",
    });
    add("grok", resolveHome(process.env.GROK_HOME, path.join(home, ".grok")), ".agents");
    roots.push({
      directory: path.join(home, ".agents", "skills"),
      provider: "codex",
      scope: "user",
    });
    roots.push({
      directory: path.join(home, ".agents", "skills"),
      provider: "grok",
      scope: "user",
    });
    for (const instance of Object.values(settings.providerInstances)) {
      if (!instance || !["codex", "claudeAgent", "gemini"].includes(instance.driver)) continue;
      const value = object(instance.config).homePath;
      if (typeof value === "string" && value.trim())
        add(
          instance.driver,
          instance.driver === "gemini"
            ? path.join(resolveHome(value, home), ".gemini")
            : resolveHome(value, home),
          instance.driver === "claudeAgent"
            ? ".claude"
            : instance.driver === "gemini"
              ? ".gemini"
              : ".agents",
        );
    }
    const skills: SkillMetadata[] = [];
    const unique = new Set<string>();
    for (const root of roots) {
      for (const enabled of [true, false]) {
        const directory = enabled ? root.directory : `${root.directory}-disabled`;
        const entries = yield* fs
          .readDirectory(directory)
          .pipe(Effect.orElseSucceed(() => [] as string[]));
        for (const entry of entries.toSorted()) {
          const folders =
            entry === ".system"
              ? (yield* fs
                  .readDirectory(path.join(directory, entry))
                  .pipe(Effect.orElseSucceed(() => [] as string[]))).map((child) =>
                  path.join(entry, child),
                )
              : [entry];
          for (const folder of folders) {
            const skillPath = path.join(directory, folder, "SKILL.md");
            if (!(yield* fs.exists(skillPath))) continue;
            const key = `${root.provider}:${skillPath}`;
            if (unique.has(key)) continue;
            unique.add(key);
            const found = yield* Effect.gen(function* () {
              const text = yield* fs.readFileString(skillPath);
              const metadata = yield* Effect.try({
                try: () => parseWorkflowSkill(text, path.basename(folder)),
                catch: failure,
              });
              const files = yield* manifest(skillPath);
              return {
                ...metadata,
                path: skillPath,
                provider: root.provider,
                scope: root.scope,
                enabled,
                diagnostics: [],
                digest: files.digest,
              } satisfies SkillMetadata;
            }).pipe(
              Effect.catch((error) =>
                Effect.succeed({
                  name: path.basename(folder),
                  description: "",
                  path: skillPath,
                  provider: root.provider,
                  scope: root.scope,
                  enabled: false,
                  invocation: "disabled" as const,
                  argumentHint: "",
                  compatibility: "",
                  allowedTools: [],
                  nativeOnly: false,
                  extensions: {},
                  diagnostics: [failure(error).message],
                  digest: "",
                } satisfies SkillMetadata),
              ),
            );
            skills.push(found);
          }
        }
      }
    }
    return { skills, truncated: false };
  }, Effect.mapError(failure));

  const pin = Effect.fn("WorkflowSkills.pin")(
    function* (binding: SkillBinding, metadata: SkillMetadata) {
      if (!metadata.enabled || !["both", "manual"].includes(metadata.invocation))
        return yield* new WorkspaceWorkflowError({ message: "직접 호출할 수 없는 스킬입니다." });
      if (metadata.digest !== binding.digest)
        return yield* new WorkspaceWorkflowError({
          message: "스킬 자원이 변경되었습니다. 최신 스킬을 다시 선택해 저장하세요.",
        });
      if (binding.mode === "instructions" && metadata.nativeOnly)
        return yield* new WorkspaceWorkflowError({
          message:
            "이 스킬은 제공자 전용 기능을 사용합니다. 설명 전달 방식으로 대체할 수 없습니다.",
        });
      const files = yield* manifest(binding.path);
      if (files.digest !== binding.digest)
        return yield* new WorkspaceWorkflowError({
          message: "스킬을 고정하는 동안 원본이 바뀌었습니다.",
        });
      const destination = path.join(config.stateDir, "workflow-skills", files.digest);
      if (yield* fs.exists(destination)) {
        const existing = yield* manifest(path.join(destination, "source", "SKILL.md"));
        if (existing.digest !== files.digest)
          return yield* new WorkspaceWorkflowError({
            message: "기존 스킬 스냅샷이 변경되었습니다. 실행 중인 버전을 덮어쓰지 않습니다.",
          });
        return {
          ...binding,
          name: metadata.name,
          snapshotPath: path.join(destination, "source", "SKILL.md"),
          resources: files.resources,
        } satisfies SkillBinding;
      }
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      const staging = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: path.dirname(destination), prefix: "pin-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      for (const resource of files.resources) {
        const target = path.join(staging, "source", resource.path);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.copyFile(path.join(files.root, resource.path), target);
      }
      const copied = yield* manifest(path.join(staging, "source", "SKILL.md"));
      if (copied.digest !== files.digest)
        return yield* new WorkspaceWorkflowError({
          message: "고정된 스킬 자원의 해시가 다릅니다.",
        });
      yield* fs.rename(staging, destination).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!(yield* fs.exists(destination))) return yield* error;
            if (
              (yield* manifest(path.join(destination, "source", "SKILL.md"))).digest !==
              files.digest
            )
              return yield* new WorkspaceWorkflowError({
                message: "동시에 생성된 스킬 스냅샷의 해시가 다릅니다.",
              });
          }),
        ),
      );
      return {
        ...binding,
        name: metadata.name,
        snapshotPath: path.join(destination, "source", "SKILL.md"),
        resources: files.resources,
      } satisfies SkillBinding;
    },
    Effect.mapError(failure),
    Effect.scoped,
  );

  const materialize = Effect.fn("WorkflowSkills.materialize")(
    function* (
      bindings: readonly SkillBinding[],
      driver: string,
      policy: { runtimeMode: string; model: string; allowAdditionalWorkers: boolean },
    ) {
      const native: Array<{ name: string; path: string }> = [];
      const plugins: string[] = [];
      const instructions: string[] = [];
      for (const binding of bindings) {
        if (!binding.snapshotPath)
          return yield* new WorkspaceWorkflowError({
            message: "실행 스킬의 고정 파일이 없습니다.",
          });
        const snapshot = yield* manifest(binding.snapshotPath);
        if (snapshot.digest !== binding.digest)
          return yield* new WorkspaceWorkflowError({
            message: "실행 스킬의 고정 자원이 변경되었습니다. 실행을 중단합니다.",
          });
        const text = yield* fs.readFileString(binding.snapshotPath);
        const metadata = yield* Effect.try({
          try: () => parseWorkflowSkill(text, binding.name),
          catch: failure,
        });
        const unsupported = workflowSkillSupport(metadata, binding.mode, driver, policy);
        if (unsupported) return yield* new WorkspaceWorkflowError({ message: unsupported });
        if (binding.mode === "instructions") {
          if (metadata.nativeOnly)
            return yield* new WorkspaceWorkflowError({
              message: "제공자 전용 스킬을 설명 전달 방식으로 실행할 수 없습니다.",
            });
          instructions.push(
            `## Skill: ${binding.name}\nArguments: ${binding.arguments}\nResource root: ${snapshot.root}\n${text}\nRead referenced resources from the pinned resource root only when needed. Do not run scripts merely because they are listed.`,
          );
        } else if (driver === "codex") {
          if (metadata.nativeOnly)
            return yield* new WorkspaceWorkflowError({
              message: "Codex가 이 스킬의 제공자 전용 확장을 지원하지 않습니다.",
            });
          native.push({ name: binding.name, path: binding.snapshotPath });
          instructions.push(
            `Use the selected native skill $${binding.name}. Arguments: ${binding.arguments}. Keep the current permissions and request mode.`,
          );
        } else if (driver === "claudeAgent") {
          const pluginName = `t3-workflow-${binding.digest}`;
          const plugin = path.join(config.stateDir, "workflow-skills", binding.digest, "plugin");
          const pluginManifest = encodeJson({
            name: pluginName,
            version: "1.0.0",
            description: "Pinned workflow skill",
          });
          if (!(yield* fs.exists(plugin))) {
            const staging = yield* Effect.acquireRelease(
              fs.makeTempDirectory({ directory: path.dirname(plugin), prefix: "native-" }),
              (directory) =>
                fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
            );
            const skillDirectory = path.join(staging, "skills", "selected");
            for (const resource of snapshot.resources) {
              const target = path.join(skillDirectory, resource.path);
              yield* fs.makeDirectory(path.dirname(target), { recursive: true });
              yield* fs.copyFile(path.join(snapshot.root, resource.path), target);
            }
            yield* fs.makeDirectory(path.join(staging, ".claude-plugin"), { recursive: true });
            yield* fs.writeFileString(
              path.join(staging, ".claude-plugin", "plugin.json"),
              pluginManifest,
            );
            yield* fs.rename(staging, plugin).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (!(yield* fs.exists(plugin))) return yield* error;
                }),
              ),
            );
          }
          if (
            (yield* manifest(path.join(plugin, "skills", "selected", "SKILL.md"))).digest !==
              binding.digest ||
            (yield* fs.readFileString(path.join(plugin, ".claude-plugin", "plugin.json"))) !==
              pluginManifest
          )
            return yield* new WorkspaceWorkflowError({
              message: "고정 native 플러그인이 변경되었습니다.",
            });
          plugins.push(plugin);
          instructions.push(
            `Invoke the native Skill tool with skill ${pluginName}:${metadata.name} and arguments ${binding.arguments}. Keep the user's selected permissions, request mode and participant policy.`,
          );
        } else if (driver === "gemini") {
          if (metadata.nativeOnly)
            return yield* new WorkspaceWorkflowError({
              message: "Antigravity가 이 스킬의 제공자 전용 확장을 지원하지 않습니다.",
            });
          instructions.push(
            `## Skill: ${binding.name}\nArguments: ${binding.arguments}\nResource root: ${snapshot.root}\n${text}\nRead referenced resources from the pinned resource root only when needed. Do not run scripts merely because they are listed.`,
          );
        } else
          return yield* new WorkspaceWorkflowError({
            message: `${driver}의 고정 native 스킬 호출은 지원되지 않습니다. 지원 상태를 확인하고 방식을 직접 선택하세요.`,
          });
      }
      return { native, plugins, instructions: instructions.join("\n\n") };
    },
    Effect.mapError(failure),
    Effect.scoped,
  );
  return { catalog, manifest, pin, materialize };
});
