// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import {
  ExtensionError,
  type ExtensionAction,
  type ExtensionActionInput,
  type ExtensionCatalog,
  type ExtensionEntry,
  type ManagedMcpProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveClaudeSdkExecutablePath } from "../provider/Drivers/ClaudeExecutable.ts";

const providers = ["codex", "claudeAgent", "grok"] as const;
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const string = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function pluginActionsFromHelp(
  provider: ManagedMcpProvider,
  help: string,
): ExtensionAction[] {
  const command = (name: string) => new RegExp(`^\\s{2,}${name}(?:\\|[^\\s]+)?\\s`, "m").test(help);
  return (["install", "update", "enable", "disable", "uninstall"] as const).filter((action) =>
    command(
      provider === "codex"
        ? action === "install"
          ? "add"
          : action === "uninstall"
            ? "remove"
            : action
        : action,
    ),
  );
}

export function pluginEntriesFromJson(
  provider: ManagedMcpProvider,
  payload: unknown,
  actions: ExtensionAction[],
): ExtensionEntry[] {
  const top = record(payload);
  if (!Array.isArray(payload) && !Array.isArray(top?.installed) && !Array.isArray(top?.plugins))
    throw new Error("지원하지 않는 플러그인 목록 형식입니다.");
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(top?.installed)
      ? top.installed
      : Array.isArray(top?.plugins)
        ? top.plugins
        : [];
  return rows.slice(0, 200).flatMap((value) => {
    const item = record(value);
    if (!item) return [];
    const name = string(item.name) ?? string(item.id);
    if (!name) return [];
    const id =
      string(item.pluginId) ??
      string(item.id) ??
      `${name}${string(item.marketplaceName) ? `@${item.marketplaceName}` : ""}`;
    const source =
      string(item.source) ??
      string(record(item.source)?.path) ??
      string(record(item.source)?.source) ??
      string(item.marketplaceName) ??
      "CLI 등록";
    const scope =
      item.scope === "project" || item.scope === "local" || item.scope === "managed"
        ? item.scope
        : "user";
    return [
      {
        id,
        name,
        kind: "plugin" as const,
        provider,
        source,
        version: string(item.version),
        enabled: item.enabled !== false,
        scope,
        actions: scope === "managed" ? [] : actions,
      },
    ];
  });
}

export function pluginActionArgs(input: ExtensionActionInput): string[] {
  if (
    input.target.startsWith("-") ||
    ["\r", "\n", "\0"].some((value) => input.target.includes(value))
  )
    throw new Error("플러그인 이름 또는 출처를 확인하세요.");
  const action =
    input.provider === "codex"
      ? input.action === "install"
        ? "add"
        : input.action === "uninstall"
          ? "remove"
          : input.action
      : input.action;
  return [
    ...(input.provider === "grok" ? ["--no-auto-update"] : []),
    "plugin",
    action,
    input.target,
    ...(input.provider === "grok" && input.action === "install" && input.trust ? ["--trust"] : []),
    ...(input.provider === "claudeAgent"
      ? ["--json", "--scope", input.scope ?? (input.workspaceRoot ? "project" : "user")]
      : input.provider === "codex"
        ? ["--json"]
        : []),
  ];
}

const makeContext = Effect.fn("ExtensionManager.context")(function* (workspaceRoot?: string) {
  const config = yield* ServerConfig;
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.make();
  const cwd = path.resolve(workspaceRoot ?? config.cwd);
  const home = NodeOS.homedir();
  const codexHomeValue =
    settings.providers.codex.homePath || process.env.CODEX_HOME || path.join(home, ".codex");
  const codexHome = path.resolve(
    codexHomeValue === "~"
      ? home
      : /^~[/\\]/.test(codexHomeValue)
        ? path.join(home, codexHomeValue.slice(2))
        : codexHomeValue,
  );
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const grokHome = process.env.GROK_HOME || path.join(home, ".grok");
  const userRoots = {
    codex: path.join(codexHome, "skills"),
    claudeAgent: path.join(claudeHome, "skills"),
    grok: path.join(grokHome, "skills"),
  };
  const projectRoot = (provider: ManagedMcpProvider) =>
    path.join(cwd, provider === "claudeAgent" ? ".claude" : ".agents", "skills");
  const native = Effect.fn("ExtensionManager.native")(function* (
    provider: ManagedMcpProvider,
    args: string[],
  ) {
    const binary =
      provider === "claudeAgent"
        ? yield* resolveClaudeSdkExecutablePath(
            settings.providers.claudeAgent.binaryPath,
            process.env,
          )
        : settings.providers[provider].binaryPath;
    const isScript = /\.[cm]?js$/i.test(binary);
    const result = yield* runner.run({
      command: isScript ? process.execPath : binary,
      args: [...(isScript ? [binary] : []), ...args],
      cwd,
      env: {
        ...process.env,
        ...(isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ...(provider === "codex" ? { CODEX_HOME: codexHome } : {}),
      },
      stdin: "",
      timeout: "90 seconds",
      maxOutputBytes: 1024 * 1024,
    });
    if (result.code !== 0)
      return yield* new ExtensionError({
        message: (result.stderr || result.stdout || "CLI 실행에 실패했습니다.").slice(-2000),
      });
    return result.stdout;
  });
  return { config, fs, path, cwd, native, userRoots, projectRoot, claudeHome, home };
});

const Receipt = Schema.Struct({
  source: Schema.String,
  name: Schema.String,
  provider: Schema.Literals(providers),
  installedAt: Schema.String,
  version: Schema.optionalKey(Schema.String),
});
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(Receipt));
const isExtensionError = Schema.is(ExtensionError);

const receiptName = ".t3-installed-skill.json";

export const getExtensionCatalog = Effect.fn("ExtensionManager.catalog")(function* (
  workspaceRoot?: string,
) {
  const context = yield* makeContext(workspaceRoot);
  const { fs, path, native } = context;
  const entries: ExtensionEntry[] = [];
  const statuses = yield* Effect.forEach(
    providers,
    (provider) =>
      Effect.gen(function* () {
        const help = yield* native(provider, [
          ...(provider === "grok" ? ["--no-auto-update"] : []),
          "plugin",
          "--help",
        ]);
        const actions = pluginActionsFromHelp(provider, help);
        const output = yield* native(provider, [
          ...(provider === "grok" ? ["--no-auto-update"] : []),
          "plugin",
          "list",
          "--json",
        ]);
        const payload = yield* Effect.try({
          try: () => parseJson(output.trim()),
          catch: () => new ExtensionError({ message: "플러그인 목록이 올바른 JSON이 아닙니다." }),
        });
        const installed = yield* Effect.try({
          try: () => pluginEntriesFromJson(provider, payload, actions),
          catch: (cause) =>
            new ExtensionError({
              message: cause instanceof Error ? cause.message : "플러그인 목록 형식을 확인하세요.",
            }),
        });
        entries.push(...installed);
        return { provider, actions, error: null };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ provider, actions: [] as ExtensionAction[], error: error.message }),
        ),
      ),
    { concurrency: 2 },
  );
  for (const provider of providers) {
    const roots = [
      { root: context.userRoots[provider], scope: "user" as const },
      ...(workspaceRoot
        ? [{ root: context.projectRoot(provider), scope: "project" as const }]
        : []),
      ...(provider === "grok"
        ? [
            { root: path.join(context.claudeHome, "skills"), scope: "user" as const },
            ...(workspaceRoot
              ? [{ root: path.join(context.cwd, ".claude", "skills"), scope: "project" as const }]
              : []),
            { root: path.join(context.home, ".agents", "skills"), scope: "user" as const },
          ]
        : provider === "codex"
          ? [{ root: path.join(context.home, ".agents", "skills"), scope: "user" as const }]
          : []),
    ];
    for (const { root, scope } of roots) {
      for (const enabled of [true, false]) {
        const location = enabled ? root : `${root}-disabled`;
        const folders = yield* fs
          .readDirectory(location)
          .pipe(Effect.orElseSucceed(() => [] as string[]));
        for (const folder of folders.slice(0, 150)) {
          const directory = path.join(location, folder);
          if (!(yield* fs.exists(path.join(directory, "SKILL.md")))) continue;
          const installed = yield* fs.readFileString(path.join(directory, receiptName)).pipe(
            Effect.flatMap(decodeReceipt),
            Effect.orElseSucceed(() => null),
          );
          const managed = installed?.provider === provider;
          entries.push({
            id: directory,
            name: folder,
            kind: "skill",
            provider,
            source: installed?.source ?? directory,
            version: installed?.version ?? null,
            enabled,
            scope,
            actions: managed ? ["update", enabled ? "disable" : "enable", "uninstall"] : [],
          });
        }
      }
    }
  }
  return { entries: entries.slice(0, 600), providers: statuses } satisfies ExtensionCatalog;
});

const manageSkill = Effect.fn("ExtensionManager.skill")(function* (
  input: ExtensionActionInput,
  context: Effect.Success<ReturnType<typeof makeContext>>,
) {
  const { fs, path } = context;
  const root = input.workspaceRoot
    ? context.projectRoot(input.provider)
    : context.userRoots[input.provider];
  const receipt = (directory: string) =>
    fs.readFileString(path.join(directory, receiptName)).pipe(
      Effect.flatMap(decodeReceipt),
      Effect.mapError(
        () => new ExtensionError({ message: "프로그램에서 설치한 스킬만 변경할 수 있습니다." }),
      ),
    );
  const target = path.resolve(input.target);
  const managedTarget = [root, `${root}-disabled`].some(
    (parent) => path.dirname(target) === path.resolve(parent),
  );
  if (input.action !== "install" && !managedTarget)
    return yield* new ExtensionError({ message: "스킬 경로가 선택한 설치 범위에 없습니다." });
  const existing = input.action === "install" ? null : yield* receipt(target);
  if (existing && existing.provider !== input.provider)
    return yield* new ExtensionError({ message: "이 스킬은 다른 제공자가 관리합니다." });
  if (input.action === "enable" || input.action === "disable") {
    const destination = path.join(
      input.action === "enable" ? root : `${root}-disabled`,
      path.basename(target),
    );
    if (destination === target) return;
    if (yield* fs.exists(destination))
      return yield* new ExtensionError({ message: "같은 이름의 스킬이 이미 있습니다." });
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.rename(target, destination);
    return;
  }
  if (input.action === "uninstall") {
    yield* fs.remove(target, { recursive: true });
    return;
  }
  const source = path.resolve(existing?.source ?? target);
  if (!(yield* fs.exists(path.join(source, "SKILL.md"))))
    return yield* new ExtensionError({
      message: "출처 폴더에 SKILL.md가 없습니다. 스킬 폴더의 절대 경로를 입력하세요.",
    });
  const name = existing?.name ?? path.basename(source);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name))
    return yield* new ExtensionError({
      message: "스킬 폴더 이름은 영문·숫자·밑줄·하이픈이어야 합니다.",
    });
  const destination = existing ? target : path.join(root, name);
  if (!existing && (yield* fs.exists(destination)))
    return yield* new ExtensionError({ message: "같은 이름의 스킬이 이미 설치되어 있습니다." });
  if (
    source === destination ||
    source.startsWith(`${destination}${path.sep}`) ||
    destination.startsWith(`${source}${path.sep}`)
  )
    return yield* new ExtensionError({
      message: "출처와 설치 폴더는 서로 포함되지 않아야 합니다.",
    });
  yield* fs.makeDirectory(path.dirname(root), { recursive: true });
  const stage = yield* fs.makeTempDirectoryScoped({
    directory: path.dirname(root),
    prefix: ".t3-skill-stage-",
  });
  const staged = path.join(stage, name);
  yield* Effect.tryPromise(() =>
    NodeFSP.cp(source, staged, {
      recursive: true,
      dereference: false,
      filter: (file) => path.basename(file) !== ".git",
    }),
  );
  const installedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const skillText = yield* fs.readFileString(path.join(staged, "SKILL.md"));
  const version = /^\s*version:\s*["']?([^\r\n"']+)["']?\s*$/m
    .exec(skillText.slice(0, 16_000))?.[1]
    ?.trim();
  const encoded = yield* encodeReceipt({
    source,
    name,
    provider: input.provider,
    installedAt,
    ...(version ? { version } : {}),
  });
  yield* fs.writeFileString(path.join(staged, receiptName), encoded);
  yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
  const previous = path.join(stage, "previous");
  if (existing) yield* fs.rename(destination, previous);
  yield* fs
    .rename(staged, destination)
    .pipe(
      Effect.catch((error) =>
        (existing ? fs.rename(previous, destination) : Effect.void).pipe(
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
});

export const manageExtension = Effect.fn("ExtensionManager.manage")(
  function* (input: ExtensionActionInput) {
    const context = yield* makeContext(input.workspaceRoot);
    if (input.kind === "skill") yield* manageSkill(input, context);
    else {
      const help = yield* context.native(input.provider, [
        ...(input.provider === "grok" ? ["--no-auto-update"] : []),
        "plugin",
        "--help",
      ]);
      if (!pluginActionsFromHelp(input.provider, help).includes(input.action))
        return yield* new ExtensionError({
          message: "설치된 CLI가 이 플러그인 작업을 지원하지 않습니다.",
        });
      const args = yield* Effect.try({
        try: () => pluginActionArgs(input),
        catch: (cause) =>
          new ExtensionError({
            message: cause instanceof Error ? cause.message : "설치 대상을 확인하세요.",
          }),
      });
      const output = yield* context.native(input.provider, args);
      return {
        message: output.trim().slice(-2000) || "작업을 완료했습니다. 새 AI 세션부터 적용됩니다.",
      };
    }
    return { message: "스킬 변경을 저장했습니다. 새 AI 세션부터 적용됩니다." };
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    isExtensionError(cause)
      ? cause
      : new ExtensionError({
          message: "확장 도구 변경에 실패했습니다. 출처와 설치 경로를 확인하세요.",
        }),
  ),
);
