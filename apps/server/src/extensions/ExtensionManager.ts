// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import {
  ClaudeSettings,
  CodexSettings,
  ExtensionError,
  GeminiSettings,
  GrokSettings,
  ProviderInstanceId,
  SkillSecurityReport,
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
import { resolveAntigravityLaunch } from "../provider/Drivers/AntigravityLaunch.ts";
import { resolveClaudeSdkExecutablePath } from "../provider/Drivers/ClaudeExecutable.ts";
import { resolveClaudeConfigDirPath } from "../provider/Drivers/ClaudeSkills.ts";
import { syncAntigravityIsolatedSkillsConfig } from "../provider/Drivers/GeminiSkills.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { downloadGitHubSkill, parseGitHubSkillSource } from "./GitHubSkillSource.ts";
import { BUNDLED_SKILLS } from "./BundledSkills.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  failedSkillSecurityScan,
  inspectSkillSecurity,
  validateStagedSkillDocument,
} from "./SkillSecurity.ts";
import {
  acquireSkillMutationLock,
  releaseSkillMutationLock,
  listInterruptedSkillTargets,
  SkillMutationLockBusyError,
  type SkillMutationLock,
} from "./SkillMutationLock.ts";
import {
  listSkillRecoveryTargets,
  recoverSkillBackup,
  writeSkillBackupManifest,
} from "./SkillBackupRecovery.ts";

const providers = ["codex", "claudeAgent", "gemini", "grok"] as const;
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeGeminiSettings = Schema.decodeUnknownSync(GeminiSettings);
const decodeGrokSettings = Schema.decodeUnknownSync(GrokSettings);
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

const makeContext = Effect.fn("ExtensionManager.context")(function* (
  workspaceRoot?: string,
  instanceId?: ProviderInstanceId,
  expectedProvider?: ManagedMcpProvider,
) {
  const config = yield* ServerConfig;
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.make();
  const cwd = path.resolve(workspaceRoot ?? config.cwd);
  const home = NodeOS.homedir();
  const explicit = settings.providerInstances;
  const selection = instanceId === undefined ? undefined : explicit[instanceId];
  const defaultProvider = providers.find((provider) => provider === instanceId);
  const selectedProvider = selection?.driver ?? defaultProvider;
  if (
    instanceId !== undefined &&
    (!selectedProvider || !providers.includes(selectedProvider as ManagedMcpProvider))
  )
    return yield* new ExtensionError({ message: "선택한 확장 도구 계정을 찾을 수 없습니다." });
  if (expectedProvider && selectedProvider && expectedProvider !== selectedProvider)
    return yield* new ExtensionError({ message: "선택한 계정과 제공자가 일치하지 않습니다." });
  if (
    !instanceId &&
    expectedProvider &&
    explicit[ProviderInstanceId.make(expectedProvider)] &&
    explicit[ProviderInstanceId.make(expectedProvider)]?.driver !== expectedProvider
  )
    return yield* new ExtensionError({
      message: "이 제공자의 기본 계정을 찾을 수 없습니다. 계정을 선택하세요.",
    });
  const envelopes = Object.fromEntries(
    providers.map((provider) => [
      provider,
      selectedProvider === provider && selection
        ? selection
        : explicit[ProviderInstanceId.make(provider)]?.driver === provider
          ? explicit[ProviderInstanceId.make(provider)]
          : undefined,
    ]),
  );
  const environments = Object.fromEntries(
    providers.map((provider) => [
      provider,
      mergeProviderInstanceEnvironment(envelopes[provider]?.environment),
    ]),
  ) as Record<ManagedMcpProvider, NodeJS.ProcessEnv>;
  const decoded = yield* Effect.try({
    try: () => ({
      codex: decodeCodexSettings(
        envelopes.codex ? (envelopes.codex.config ?? {}) : settings.providers.codex,
      ),
      claudeAgent: decodeClaudeSettings(
        envelopes.claudeAgent
          ? (envelopes.claudeAgent.config ?? {})
          : settings.providers.claudeAgent,
      ),
      gemini: decodeGeminiSettings(
        envelopes.gemini ? (envelopes.gemini.config ?? {}) : settings.providers.gemini,
      ),
      grok: decodeGrokSettings(
        envelopes.grok ? (envelopes.grok.config ?? {}) : settings.providers.grok,
      ),
    }),
    catch: () => new ExtensionError({ message: "선택한 계정의 설정을 읽지 못했습니다." }),
  });
  const codexLayout = yield* resolveCodexHomeLayout(decoded.codex);
  const codexHomeValue =
    decoded.codex.homePath || environments.codex.CODEX_HOME || path.join(home, ".codex");
  const codexHome =
    codexLayout.mode === "authOverlay"
      ? codexLayout.sharedHomePath
      : path.resolve(
          codexHomeValue === "~"
            ? home
            : /^~[/\\]/.test(codexHomeValue)
              ? path.join(home, codexHomeValue.slice(2))
              : codexHomeValue,
        );
  const claudeHome = yield* resolveClaudeConfigDirPath(
    decoded.claudeAgent,
    environments.claudeAgent,
    cwd,
  );
  const geminiInstanceId =
    selectedProvider === "gemini" && instanceId ? instanceId : ProviderInstanceId.make("gemini");
  const geminiLaunch = resolveAntigravityLaunch({
    settings: decoded.gemini,
    instanceId: geminiInstanceId,
    stateDir: config.stateDir,
  });
  const geminiCustomHome = decoded.gemini.homePath.trim().length > 0;
  const geminiHome = geminiCustomHome ? geminiLaunch.geminiDir : path.join(home, ".gemini");
  const grokHomeValue =
    decoded.grok.homePath.trim() || environments.grok.GROK_HOME || path.join(home, ".grok");
  const grokHome = path.resolve(
    grokHomeValue === "~"
      ? home
      : /^~[/\\]/.test(grokHomeValue)
        ? path.join(home, grokHomeValue.slice(2))
        : grokHomeValue,
  );
  const userRoots = {
    codex: path.join(codexHome, "skills"),
    claudeAgent: path.join(claudeHome, "skills"),
    gemini: path.join(geminiHome, "skills"),
    grok: path.join(grokHome, "skills"),
  };
  const projectRoot = (provider: ManagedMcpProvider) =>
    path.join(
      cwd,
      provider === "claudeAgent" ? ".claude" : provider === "gemini" ? ".gemini" : ".agents",
      "skills",
    );
  const native = Effect.fn("ExtensionManager.native")(function* (
    provider: ManagedMcpProvider,
    args: string[],
  ) {
    const binary =
      provider === "claudeAgent"
        ? yield* resolveClaudeSdkExecutablePath(
            decoded.claudeAgent.binaryPath,
            environments.claudeAgent,
          )
        : provider === "gemini"
          ? geminiLaunch.command
          : decoded[provider].binaryPath;
    const isScript = /\.[cm]?js$/i.test(binary);
    const geminiCustomUserRoot = geminiCustomHome
      ? path.dirname(geminiLaunch.geminiDir)
      : undefined;
    const result = yield* runner.run({
      command: isScript ? process.execPath : binary,
      args: [...(isScript ? [binary] : []), ...args],
      cwd,
      env: {
        ...environments[provider],
        ...(isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ...(provider === "codex" ? { CODEX_HOME: codexLayout.effectiveHomePath ?? codexHome } : {}),
        ...(provider === "claudeAgent" ? { CLAUDE_CONFIG_DIR: claudeHome } : {}),
        ...(provider === "grok" ? { GROK_HOME: grokHome } : {}),
        ...(provider === "gemini" && geminiCustomUserRoot
          ? { HOME: geminiCustomUserRoot, USERPROFILE: geminiCustomUserRoot }
          : {}),
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
  const instances = providers.flatMap((provider) => {
    const defaultId = ProviderInstanceId.make(provider);
    const base = explicit[defaultId];
    const defaultLabel = provider === "gemini" ? "Antigravity 기본 계정" : `${provider} 기본 계정`;
    return [
      ...(base && base.driver !== provider
        ? []
        : [
            {
              instanceId: defaultId,
              provider,
              displayName: base?.displayName ?? defaultLabel,
            },
          ]),
      ...Object.entries(explicit).flatMap(([id, entry]) =>
        id !== provider && entry.driver === provider
          ? [
              {
                instanceId: ProviderInstanceId.make(id),
                provider,
                displayName: entry.displayName ?? id,
              },
            ]
          : [],
      ),
    ];
  });
  return {
    config,
    fs,
    path,
    cwd,
    native,
    userRoots,
    projectRoot,
    claudeHome,
    geminiHome,
    geminiLaunch,
    home,
    selectedProvider,
    instances,
  };
});

const ReceiptFields = {
  source: Schema.String,
  name: Schema.String,
  provider: Schema.Literals(providers),
  installedAt: Schema.String,
  version: Schema.optionalKey(Schema.String),
};
const Receipt = Schema.Struct({
  ...ReceiptFields,
  securityScan: Schema.optionalKey(SkillSecurityReport),
});
const decodeReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([Receipt, Schema.Struct(ReceiptFields)])),
);
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(Receipt));
const isExtensionError = Schema.is(ExtensionError);

const receiptName = ".t3-installed-skill.json";

export const getExtensionCatalog = Effect.fn("ExtensionManager.catalog")(function* (
  workspaceRoot?: string,
  instanceId?: ProviderInstanceId,
) {
  const context = yield* makeContext(workspaceRoot, instanceId);
  const { fs, path, native } = context;
  const visibleProviders = instanceId
    ? providers.filter((provider) => provider === context.selectedProvider)
    : providers.filter((provider) =>
        context.instances.some((entry) => entry.instanceId === provider),
      );
  const recoveryWarnings: string[] = [];
  const recoveryRoots = new Set(
    visibleProviders.flatMap((provider) => [
      context.userRoots[provider],
      ...(workspaceRoot ? [context.projectRoot(provider)] : []),
    ]),
  );
  const recoveryPlatform = yield* HostProcessPlatform;
  for (const root of recoveryRoots) {
    const names = yield* Effect.tryPromise(() =>
      Promise.all([listInterruptedSkillTargets(root), listSkillRecoveryTargets(root)]),
    ).pipe(
      Effect.map(([locks, backups]) => [...new Set([...locks, ...backups])].slice(0, 128)),
      Effect.orElseSucceed(() => [] as string[]),
    );
    for (const name of names) {
      const attempted = yield* Effect.gen(function* () {
        const lock = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              acquireSkillMutationLock(root, name, { platform: recoveryPlatform, timeoutMs: 0 }),
            catch: (cause) =>
              cause instanceof SkillMutationLockBusyError
                ? cause
                : new ExtensionError({ message: "스킬 복구 잠금을 확인하지 못했습니다." }),
          }),
          (owned) => Effect.promise(() => releaseSkillMutationLock(owned)),
        );
        yield* Effect.tryPromise({
          try: () => recoverSkillBackup(root, name, recoveryPlatform, lock),
          catch: (cause) =>
            new ExtensionError({
              message: cause instanceof Error ? cause.message : "스킬 백업을 확인하지 못했습니다.",
            }),
        });
      }).pipe(Effect.scoped, Effect.result);
      if (
        attempted._tag === "Failure" &&
        !(attempted.failure instanceof SkillMutationLockBusyError)
      )
        recoveryWarnings.push(attempted.failure.message);
    }
  }
  const entries: ExtensionEntry[] = [];
  const statuses = yield* Effect.forEach(
    visibleProviders,
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
  for (const provider of visibleProviders) {
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
          : provider === "gemini"
            ? [
                {
                  root: path.join(context.geminiHome, "config", "skills"),
                  scope: "user" as const,
                },
                { root: path.join(context.home, ".agents", "skills"), scope: "user" as const },
                ...(workspaceRoot
                  ? [
                      {
                        root: path.join(context.cwd, ".agents", "skills"),
                        scope: "project" as const,
                      },
                    ]
                  : []),
              ]
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
            ...(managed && "securityScan" in installed && installed.securityScan
              ? { securityScan: installed.securityScan }
              : {}),
          });
        }
      }
    }
  }
  return {
    entries: entries.slice(0, 600),
    providers: statuses,
    instances: context.instances,
    ...(recoveryWarnings.length ? { recoveryWarnings: [...new Set(recoveryWarnings)] } : {}),
  } satisfies ExtensionCatalog;
});

const manageSkillLocked = Effect.fn("ExtensionManager.skillLocked")(function* (
  input: ExtensionActionInput,
  context: Effect.Success<ReturnType<typeof makeContext>>,
  lock: SkillMutationLock,
) {
  const { fs, path } = context;
  const root =
    input.workspaceRoot && input.scope !== "user"
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
  const sourceValue = existing?.source ?? input.target;
  const bundled = Object.hasOwn(BUNDLED_SKILLS, sourceValue)
    ? BUNDLED_SKILLS[sourceValue as keyof typeof BUNDLED_SKILLS]
    : undefined;
  const remote = sourceValue.startsWith("https://")
    ? yield* Effect.try({
        try: () => parseGitHubSkillSource(sourceValue),
        catch: (cause) =>
          new ExtensionError({
            message: cause instanceof Error ? cause.message : "GitHub 주소를 확인하세요.",
          }),
      })
    : null;
  if (!bundled && sourceValue.startsWith("t3-skill:"))
    return yield* new ExtensionError({ message: "제공되지 않는 기본 스킬입니다." });
  const source = remote || bundled ? sourceValue : path.resolve(sourceValue);
  if (!remote && !bundled && !(yield* fs.exists(path.join(source, "SKILL.md"))))
    return yield* new ExtensionError({
      message: "출처 폴더에 SKILL.md가 없습니다. 스킬 폴더의 절대 경로를 입력하세요.",
    });
  const name =
    existing?.name ??
    (bundled ? bundled.name : remote ? remote.directory.split("/").at(-1)! : path.basename(source));
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name))
    return yield* new ExtensionError({
      message: "스킬 폴더 이름은 영문·숫자·밑줄·하이픈이어야 합니다.",
    });
  const destination = existing ? target : path.join(root, name);
  if (!existing && (yield* fs.exists(destination)))
    return yield* new ExtensionError({ message: "같은 이름의 스킬이 이미 설치되어 있습니다." });
  if (
    !remote &&
    !bundled &&
    (source === destination ||
      source.startsWith(`${destination}${path.sep}`) ||
      destination.startsWith(`${source}${path.sep}`))
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
  let revision: string | undefined;
  if (bundled) {
    yield* fs.makeDirectory(staged, { recursive: true });
    yield* fs.writeFileString(path.join(staged, "SKILL.md"), bundled.content);
  } else if (remote) {
    revision = yield* Effect.tryPromise({
      try: () => downloadGitHubSkill(remote, staged),
      catch: (cause) =>
        new ExtensionError({
          message: cause instanceof Error ? cause.message : "GitHub 스킬을 내려받지 못했습니다.",
        }),
    });
  } else {
    yield* Effect.tryPromise({
      try: async () => {
        // Resolve the selected root, but do not dereference links inside the skill.
        const realSource = await NodeFSP.realpath(source);
        await NodeFSP.mkdir(path.dirname(destination), { recursive: true });
        const realDestination = path.join(
          await NodeFSP.realpath(path.dirname(destination)),
          path.basename(destination),
        );
        const overlaps = (parent: string, child: string) => {
          const relative = path.relative(parent, child);
          return (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative))
          );
        };
        if (overlaps(realSource, realDestination) || overlaps(realDestination, realSource))
          throw new ExtensionError({ message: "출처와 설치 폴더는 서로 포함되지 않아야 합니다." });
        await NodeFSP.cp(realSource, staged, {
          recursive: true,
          dereference: false,
          filter: (file) => path.basename(file) !== ".git",
        });
      },
      catch: (cause) =>
        isExtensionError(cause)
          ? cause
          : new ExtensionError({ message: "로컬 스킬을 준비하지 못했습니다." }),
    });
  }
  const receiptPath = path.join(staged, receiptName);
  // The incoming copy cannot choose or redirect our management receipt.
  yield* Effect.tryPromise(() =>
    NodeFSP.unlink(receiptPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }),
  );
  const validateDocument = () =>
    Effect.tryPromise({
      try: () => validateStagedSkillDocument(staged),
      catch: () =>
        new ExtensionError({ message: "스킬의 SKILL.md가 읽을 수 있는 일반 파일인지 확인하세요." }),
    });
  const beforeScan = yield* validateDocument();
  const inspected = yield* Effect.tryPromise(() => inspectSkillSecurity(staged)).pipe(
    Effect.orElseSucceed(() => ({ report: failedSkillSecurityScan() })),
  );
  const afterScan = yield* validateDocument();
  if (beforeScan.digest !== afterScan.digest)
    return yield* new ExtensionError({
      message: "검사 중 SKILL.md가 바뀌어 설치하지 않았습니다. 다시 시도하세요.",
    });
  const installedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const recordedVersion = revision ?? beforeScan.version;
  const encoded = yield* encodeReceipt({
    source,
    name,
    provider: input.provider,
    installedAt,
    securityScan: inspected.report,
    ...(recordedVersion === undefined ? {} : { version: recordedVersion }),
  });
  yield* Effect.tryPromise(async () => {
    await NodeFSP.writeFile(receiptPath, encoded, { flag: "wx" });
  });
  yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
  if (!existing) {
    yield* fs.rename(staged, destination);
    return;
  }
  const published = yield* Effect.gen(function* () {
    const parent = path.resolve(path.dirname(destination));
    const backup = yield* fs.makeTempDirectory({ directory: parent, prefix: ".t3-skill-backup-" });
    if (
      path.dirname(path.resolve(backup)) !== parent ||
      !path.basename(backup).startsWith(".t3-skill-backup-")
    )
      return yield* new ExtensionError({ message: "스킬 백업 위치를 확인하지 못했습니다." });
    const previous = path.join(backup, "previous");
    const manifest = yield* Effect.tryPromise({
      try: () =>
        writeSkillBackupManifest({
          backup,
          destination,
          parent: path.dirname(destination) === path.resolve(root) ? "enabled" : "disabled",
          owner: lock.process,
          ownerToken: lock.owner,
        }),
      catch: () =>
        new ExtensionError({ message: "스킬 복구 기록을 만들지 못해 업데이트하지 않았습니다." }),
    }).pipe(Effect.result);
    if (manifest._tag === "Failure") {
      yield* fs.remove(backup, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
      return yield* manifest.failure;
    }
    const moved = yield* fs.rename(destination, previous).pipe(Effect.result);
    if (moved._tag === "Failure") {
      yield* fs.remove(backup, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
      return yield* Effect.fail(moved.failure);
    }
    const commit = yield* fs.rename(staged, destination).pipe(Effect.result);
    if (commit._tag === "Failure") {
      const restored = yield* fs.rename(previous, destination).pipe(Effect.result);
      if (restored._tag === "Failure")
        return yield* new ExtensionError({
          message: `스킬 업데이트와 원본 복원에 실패했습니다. 원본 백업이 보존된 위치: ${previous}`,
        });
      yield* fs.remove(backup, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
      return yield* new ExtensionError({ message: "스킬 업데이트에 실패해 원본을 복원했습니다." });
    }
    const cleanup = yield* fs.remove(backup, { recursive: true }).pipe(Effect.result);
    return cleanup._tag === "Failure"
      ? `스킬은 업데이트했지만 이전 백업을 정리하지 못했습니다. 백업 위치: ${previous}`
      : undefined;
  }).pipe(Effect.uninterruptible);
  return published;
});

const manageSkill = Effect.fn("ExtensionManager.skill")(function* (
  input: ExtensionActionInput,
  context: Effect.Success<ReturnType<typeof makeContext>>,
) {
  const { path } = context;
  const root =
    input.workspaceRoot && input.scope !== "user"
      ? context.projectRoot(input.provider)
      : context.userRoots[input.provider];
  let name: string;
  if (input.action === "install") {
    const bundled = Object.hasOwn(BUNDLED_SKILLS, input.target)
      ? BUNDLED_SKILLS[input.target as keyof typeof BUNDLED_SKILLS]
      : undefined;
    const remote = input.target.startsWith("https://")
      ? yield* Effect.try({
          try: () => parseGitHubSkillSource(input.target),
          catch: () => new ExtensionError({ message: "GitHub 스킬 폴더 주소를 확인하세요." }),
        })
      : null;
    if (!bundled && input.target.startsWith("t3-skill:"))
      return yield* new ExtensionError({ message: "제공되지 않는 기본 스킬입니다." });
    name = bundled
      ? bundled.name
      : remote
        ? remote.directory.split("/").at(-1)!
        : path.basename(path.resolve(input.target));
  } else {
    const target = path.resolve(input.target);
    if (![root, `${root}-disabled`].some((parent) => path.dirname(target) === path.resolve(parent)))
      return yield* new ExtensionError({ message: "스킬 경로가 선택한 설치 범위에 없습니다." });
    name = path.basename(target);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name))
    return yield* new ExtensionError({
      message: "스킬 폴더 이름은 영문·숫자·밑줄·하이픈이어야 합니다.",
    });
  const platform = yield* HostProcessPlatform;
  const lock = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquireSkillMutationLock(root, name, { platform }),
      catch: (cause) =>
        new ExtensionError({
          message:
            cause instanceof SkillMutationLockBusyError
              ? cause.message
              : "스킬 작업 잠금을 만들지 못했습니다.",
        }),
    }),
    (lock) => Effect.promise(() => releaseSkillMutationLock(lock)),
  );
  const recovered = yield* Effect.tryPromise({
    try: () => recoverSkillBackup(root, name, platform, lock),
    catch: (cause) =>
      new ExtensionError({
        message: cause instanceof Error ? cause.message : "스킬 백업을 확인하지 못했습니다.",
      }),
  });
  const result = yield* manageSkillLocked(input, context, lock).pipe(Effect.result);
  if (result._tag === "Failure") {
    if (recovered)
      return yield* new ExtensionError({
        message: `이전 스킬을 백업에서 복구했습니다. 백업은 보존됩니다: ${recovered}\n요청한 작업은 완료하지 못했습니다.`,
      });
    return yield* Effect.fail(result.failure);
  }
  return (
    result.success ??
    (recovered ? `이전 스킬을 복구했으며 백업을 보존했습니다: ${recovered}` : undefined)
  );
}, Effect.scoped);

export const manageExtension = Effect.fn("ExtensionManager.manage")(
  function* (input: ExtensionActionInput) {
    const context = yield* makeContext(
      input.workspaceRoot,
      input.providerInstanceId,
      input.provider,
    );
    if (input.kind === "skill") {
      const warning = yield* manageSkill(input, context);
      if (input.provider === "gemini") {
        syncAntigravityIsolatedSkillsConfig({ geminiDir: context.geminiLaunch.geminiDir });
      }
      return { message: warning ?? "스킬 변경을 저장했습니다. 새 AI 세션부터 적용됩니다." };
    } else {
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
      if (input.provider === "gemini") {
        syncAntigravityIsolatedSkillsConfig({ geminiDir: context.geminiLaunch.geminiDir });
      }
      return {
        message: output.trim().slice(-2000) || "작업을 완료했습니다. 새 AI 세션부터 적용됩니다.",
      };
    }
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
