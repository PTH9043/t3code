/**
 * ExternalLauncher - external application launch service interface.
 *
 * Owns process launch helpers for browser URLs and workspace paths
 * in configured editor integrations.
 *
 * @module ExternalLauncher
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import {
  EDITORS,
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  type EditorId,
  type LaunchEditorInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

// ==============================
// Definitions
// ==============================

export {
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  isExternalLauncherError,
} from "@t3tools/contracts";
export type { LaunchEditorInput };
interface EditorLaunch {
  readonly editor: EditorId;
  readonly target: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface ProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

interface TargetPathAndPosition {
  readonly path: string;
  readonly line: string;
  readonly column: Option.Option<string>;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

const DETACHED_IGNORE_STDIO_OPTIONS = {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

const BrowserLaunchEnvConfig = Config.all({
  SYSTEMROOT: Config.string("SYSTEMROOT").pipe(Config.option),
  windir: Config.string("windir").pipe(Config.option),
  WSL_DISTRO_NAME: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
  WSL_INTEROP: Config.string("WSL_INTEROP").pipe(Config.option),
  SSH_CONNECTION: Config.string("SSH_CONNECTION").pipe(Config.option),
  SSH_TTY: Config.string("SSH_TTY").pipe(Config.option),
  container: Config.string("container").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const CommandLookupEnvConfig = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  path: Config.string("path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
  SYSTEMROOT: Config.string("SYSTEMROOT").pipe(Config.option),
  windir: Config.string("windir").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const readBrowserLaunchEnv = BrowserLaunchEnvConfig.pipe(Effect.orElseSucceed(() => ({})));
const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

function parseTargetPathAndPosition(target: string): Option.Option<TargetPathAndPosition> {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return Option.none();
  }

  return Option.some({
    path: match[1],
    line: match[2],
    column: Option.fromUndefinedOr(match[3]),
  });
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return Option.isSome(parsedTarget) ? ["--goto", target] : [target];
    case "line-column":
      return Option.match(parsedTarget, {
        onNone: () => [target],
        onSome: ({ path, line, column }) => [
          "--line",
          line,
          ...Option.match(column, {
            onNone: () => [],
            onSome: (value) => ["--column", value],
          }),
          path,
        ],
      });
  }
}

function resolveEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  return [...baseArgs, ...resolveCommandEditorArgs(editor, target)];
}

const resolveAvailableCommand = Effect.fn("externalLauncher.resolveAvailableCommand")(function* (
  commands: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> {
  for (const command of commands) {
    if (yield* isCommandAvailable(command, { env })) {
      return Option.some(command);
    }
  }
  return Option.none();
});

function shouldUseWindowsBrowserFromWsl(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): boolean {
  return (
    platform === "linux" &&
    (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) &&
    env.SSH_CONNECTION === undefined &&
    env.SSH_TTY === undefined &&
    env.container === undefined
  );
}

function resolveWindowsBrowserLaunch(target: string, command: string): ProcessLaunch {
  return {
    command,
    args: [target],
    options: {
      detached: true,
      shell: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  };
}

function windowsExplorerPath(env: NodeJS.ProcessEnv = {}): string {
  return `${env.SYSTEMROOT || env.windir || String.raw`C:\Windows`}\\explorer.exe`;
}

function fileManagerCommandsForPlatform(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): ReadonlyArray<string> {
  switch (platform) {
    case "darwin":
      return ["open"];
    case "win32":
      return [windowsExplorerPath(env), "explorer"];
    default:
      return ["xdg-open"];
  }
}

function buildBrowserLaunch(
  target: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): ProcessLaunch {
  if (platform === "darwin") {
    return {
      command: "open",
      args: [target],
      options: DETACHED_IGNORE_STDIO_OPTIONS,
    };
  }

  if (platform === "win32") {
    return resolveWindowsBrowserLaunch(target, windowsExplorerPath(env));
  }

  if (shouldUseWindowsBrowserFromWsl(platform, env)) {
    return resolveWindowsBrowserLaunch(target, "/mnt/c/Windows/explorer.exe");
  }

  return {
    command: "xdg-open",
    args: [target],
    options: DETACHED_IGNORE_STDIO_OPTIONS,
  };
}

const buildAvailableEditors = Effect.fn("externalLauncher.buildAvailableEditors")(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<EditorId>, never, FileSystem.FileSystem | Path.Path> {
  const candidates = yield* Effect.forEach(
    EDITORS,
    (editor) =>
      Effect.gen(function* () {
        if (editor.commands === null) {
          const command = yield* resolveAvailableCommand(
            fileManagerCommandsForPlatform(platform, env),
            env,
          );
          return Option.isSome(command) ? editor.id : null;
        }
        const command = yield* resolveAvailableCommand(editor.commands, env);
        return Option.isSome(command) ? editor.id : null;
      }),
    { concurrency: "unbounded" },
  );
  return candidates.filter((editor) => editor !== null);
});

const resolveBrowserLaunch = Effect.fn("externalLauncher.resolveBrowserLaunch")(function* (
  target: string,
) {
  const platform = yield* HostProcessPlatform;
  const env = yield* readBrowserLaunchEnv;
  return buildBrowserLaunch(target, platform, env);
});

const resolveAvailableEditors = Effect.fn("externalLauncher.resolveAvailableEditors")(function* () {
  const platform = yield* HostProcessPlatform;
  const env = yield* readCommandLookupEnv;
  return yield* buildAvailableEditors(platform, env);
});

// Editor discovery walks PATH for every known editor and runs for every
// client connect (the server config embeds the available editors). Memoize
// the discovered set for a bounded window so repeat connects skip even the
// per-command cache lookups in @t3tools/shared/shell.
//
// This deliberately does not use `Effect.cachedWithTTL`: that memoizes the
// first caller's Exit whatever it is, including an interrupt. Callers run this
// on the connection fiber under a timeout (`resolveAvailableEditorsForConfig`),
// so one client disconnecting mid-scan would cache the interrupt and replay it
// to every later connect for the whole TTL, breaking `server.getConfig`
// permanently. Storing only on success means an interrupted scan leaves the
// cache untouched and the next connect simply rescans.
// Expiry uses the monotonic clock (Clock.currentTimeNanos), matching the
// command-resolution cache in @t3tools/shared/shell, so a backward wall-clock
// adjustment cannot keep an expired entry alive.
const EDITOR_DISCOVERY_CACHE_TTL_NANOS = 300_000_000_000n;

interface EditorDiscoveryCacheEntry {
  readonly editors: ReadonlyArray<EditorId>;
  readonly expiresAtNanos: bigint;
}

/**
 * ExternalLauncher - Service tag for browser/editor launch operations.
 */
export class ExternalLauncher extends Context.Service<
  ExternalLauncher,
  {
    readonly resolveAvailableEditors: () => Effect.Effect<ReadonlyArray<EditorId>>;
    /** Launch a URL target in the default browser. */
    readonly launchBrowser: (target: string) => Effect.Effect<void, ExternalLauncherError>;
    /**
     * Launch a workspace path in a selected editor integration.
     *
     * Launches the editor as a detached process so server startup is not blocked.
     */
    readonly launchEditor: (input: LaunchEditorInput) => Effect.Effect<void, ExternalLauncherError>;
  }
>()("t3/process/externalLauncher") {}

// ==============================
// Implementations
// ==============================

const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: LaunchEditorInput,
): Effect.fn.Return<EditorLaunch, ExternalLauncherError, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcessPlatform;
  const env = yield* readCommandLookupEnv;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.editor": input.editor,
    "externalLauncher.cwd": input.cwd,
    "externalLauncher.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new ExternalLauncherUnknownEditorError({ editor: input.editor });
  }

  if (editorDef.commands) {
    const command = Option.getOrElse(
      yield* resolveAvailableCommand(editorDef.commands, env),
      () => editorDef.commands[0],
    );
    return {
      editor: editorDef.id,
      target: input.cwd,
      command,
      args: resolveEditorArgs(editorDef, input.cwd),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  const parsedTarget = parseTargetPathAndPosition(input.cwd);
  const rawTarget = Option.match(parsedTarget, {
    onNone: () => input.cwd,
    onSome: ({ path: stripped }) => stripped,
  });
  const normalizedTarget = normalizeFileManagerTarget(rawTarget, platform);
  const statInfo = yield* fileSystem.stat(normalizedTarget).pipe(Effect.option);
  const isFile = Option.isSome(statInfo) && statInfo.value.type === "File";
  const fallbackParent = Option.isNone(statInfo)
    ? yield* Effect.suspend(() => {
        const parent = dirnameForPlatform(normalizedTarget, platform, path);
        if (!parent || parent === normalizedTarget) return Effect.succeed(Option.none<string>());
        return fileSystem.stat(parent).pipe(
          Effect.map((info) => (info.type === "Directory" ? Option.some(parent) : Option.none())),
          Effect.orElseSucceed(() => Option.none<string>()),
        );
      })
    : Option.none<string>();

  const finalTarget = Option.getOrElse(fallbackParent, () => normalizedTarget);
  const args = resolveFileManagerArgs({
    platform,
    target: finalTarget,
    isFile: Option.isNone(fallbackParent) && isFile,
    dirname: (value) => dirnameForPlatform(value, platform, path),
  });

  const fileManagerCommands = fileManagerCommandsForPlatform(platform, env);
  const fileManagerCommand = Option.getOrElse(
    yield* resolveAvailableCommand(fileManagerCommands, env),
    () => fileManagerCommands[0] ?? "explorer",
  );

  return {
    editor: editorDef.id,
    target: finalTarget,
    command: fileManagerCommand,
    args,
  };
});

function dirnameForPlatform(value: string, platform: NodeJS.Platform, path: Path.Path): string {
  if (platform !== "win32") {
    return path.dirname(value);
  }
  const normalized = value.replaceAll("/", "\\").replace(/\\+$/, "");
  if (/^[A-Za-z]:$/.test(normalized)) {
    return `${normalized}\\`;
  }
  const idx = normalized.lastIndexOf("\\");
  if (idx < 0) return normalized;
  const parent = normalized.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

function normalizeFileManagerTarget(target: string, platform: NodeJS.Platform): string {
  const trimmed = target.trim();
  if (platform !== "win32") {
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
  }
  const backslashed = trimmed.replaceAll("/", "\\");
  // Keep drive root like "D:\" intact; strip trailing backslashes on subfolders because explorer.exe is strict.
  if (/^[A-Za-z]:\\+$/.test(backslashed)) {
    return `${backslashed.slice(0, 2)}\\`;
  }
  return backslashed.replace(/\\+$/, "");
}

function resolveFileManagerArgs(input: {
  readonly platform: NodeJS.Platform;
  readonly target: string;
  readonly isFile: boolean;
  readonly dirname: (value: string) => string;
}): ReadonlyArray<string> {
  if (input.platform === "win32") {
    return input.isFile ? [`/select,${input.target}`] : [input.target];
  }
  if (input.platform === "darwin") {
    return input.isFile ? ["-R", input.target] : [input.target];
  }
  return [input.isFile ? input.dirname(input.target) : input.target];
}

const launchAndUnref = Effect.fn("externalLauncher.launchAndUnref")(function* (
  launch: ProcessLaunch,
  onError: (cause: unknown) => ExternalLauncherError,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(launch.command, launch.args, launch.options);

  yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
    Effect.mapError(onError),
  );
});

const launchBrowser = Effect.fn("externalLauncher.launchBrowser")(function* (
  target: string,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const launch = yield* resolveBrowserLaunch(target);
  return yield* launchAndUnref(
    launch,
    (cause) =>
      new ExternalLauncherBrowserSpawnError({
        target,
        command: launch.command,
        args: launch.args,
        cause,
      }),
  );
});

export class WindowsFileManagerSpawnError extends Data.TaggedError("WindowsFileManagerSpawnError")<{
  readonly cause: unknown;
}> {}

export type WindowsFileManagerSpawnerFn = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}) => Effect.Effect<void, WindowsFileManagerSpawnError>;

const defaultWindowsFileManagerSpawner: WindowsFileManagerSpawnerFn = (input) =>
  Effect.callback<void, WindowsFileManagerSpawnError>((resume) => {
    let settled = false;
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      detached: true,
      shell: input.shell,
      stdio: "ignore",
      // Explicit windowsHide: false so explorer.exe receives SW_SHOWNORMAL
      // instead of inheriting NodeChildProcessSpawner's hardcoded windowsHide: true.
      windowsHide: false,
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(new WindowsFileManagerSpawnError({ cause: error })));
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resume(Effect.void);
    });
  });

export const WindowsFileManagerSpawner = Context.Reference<WindowsFileManagerSpawnerFn>(
  "t3/process/externalLauncher/WindowsFileManagerSpawner",
  {
    defaultValue: () => defaultWindowsFileManagerSpawner,
  },
);

const launchEditorProcess = Effect.fn("externalLauncher.launchEditorProcess")(function* (
  launch: EditorLaunch,
): Effect.fn.Return<
  void,
  ExternalLauncherError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const platform = yield* HostProcessPlatform;
  const env = yield* readCommandLookupEnv;
  if (!(yield* isCommandAvailable(launch.command, { env }))) {
    return yield* new ExternalLauncherCommandNotFoundError({
      editor: launch.editor,
      command: launch.command,
    });
  }

  const spawnCommand = yield* resolveSpawnCommand(launch.command, launch.args, { env });
  if (platform === "win32" && launch.editor === "file-manager") {
    const spawnVisible = yield* WindowsFileManagerSpawner;
    yield* spawnVisible({
      command: spawnCommand.command,
      args: spawnCommand.args,
      shell: spawnCommand.shell,
    }).pipe(
      Effect.mapError(
        (error) =>
          new ExternalLauncherEditorSpawnError({
            editor: launch.editor,
            target: launch.target,
            command: spawnCommand.command,
            args: spawnCommand.args,
            cause: error.cause,
          }),
      ),
    );
    return;
  }

  yield* launchAndUnref(
    {
      command: spawnCommand.command,
      args: spawnCommand.args,
      options: {
        detached: true,
        shell: spawnCommand.shell,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    },
    (cause) =>
      new ExternalLauncherEditorSpawnError({
        editor: launch.editor,
        target: launch.target,
        command: spawnCommand.command,
        args: spawnCommand.args,
        cause,
      }),
  );
});

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const provideCommandResolutionServices = <A, E, R>(
    effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const editorDiscoveryCache = yield* Ref.make<Option.Option<EditorDiscoveryCacheEntry>>(
    Option.none(),
  );
  const inFlightDiscovery = yield* Ref.make<
    Option.Option<Deferred.Deferred<ReadonlyArray<EditorId>>>
  >(Option.none());

  const cachedAvailableEditors = Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos;
    const entry = yield* Ref.get(editorDiscoveryCache);
    if (Option.isSome(entry) && entry.value.expiresAtNanos > nowNanos) {
      return entry.value.editors;
    }
    const freshDeferred = yield* Deferred.make<ReadonlyArray<EditorId>>();
    type ClaimResult = {
      readonly isLeader: boolean;
      readonly deferred: Deferred.Deferred<ReadonlyArray<EditorId>>;
    };
    const existingOrFresh: ClaimResult = yield* Ref.modify(
      inFlightDiscovery,
      (
        current,
      ): readonly [ClaimResult, Option.Option<Deferred.Deferred<ReadonlyArray<EditorId>>>] =>
        Option.isSome(current)
          ? [{ isLeader: false, deferred: current.value }, current]
          : [{ isLeader: true, deferred: freshDeferred }, Option.some(freshDeferred)],
    );
    if (!existingOrFresh.isLeader) {
      return yield* Deferred.await(existingOrFresh.deferred);
    }
    return yield* provideCommandResolutionServices(resolveAvailableEditors()).pipe(
      Effect.tap((editors) =>
        Effect.gen(function* () {
          const completedAtNanos = yield* Clock.currentTimeNanos;
          yield* Ref.set(
            editorDiscoveryCache,
            Option.some({
              editors,
              expiresAtNanos: completedAtNanos + EDITOR_DISCOVERY_CACHE_TTL_NANOS,
            }),
          );
          yield* Deferred.succeed(freshDeferred, editors);
        }),
      ),
      Effect.onInterrupt(() =>
        Ref.update(inFlightDiscovery, (current) =>
          Option.isSome(current) && current.value === freshDeferred ? Option.none() : current,
        ).pipe(Effect.andThen(Deferred.interrupt(freshDeferred))),
      ),
      Effect.ensuring(
        Ref.update(inFlightDiscovery, (current) =>
          Option.isSome(current) && current.value === freshDeferred ? Option.none() : current,
        ),
      ),
    );
  });

  return ExternalLauncher.of({
    resolveAvailableEditors: () => cachedAvailableEditors,
    launchBrowser: (target) =>
      launchBrowser(target).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    launchEditor: (input) =>
      provideCommandResolutionServices(
        Effect.flatMap(resolveEditorLaunch(input), (launch) =>
          launchEditorProcess(launch).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(ExternalLauncher, make);
