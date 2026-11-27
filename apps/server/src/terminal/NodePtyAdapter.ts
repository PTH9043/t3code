import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as PtyAdapter from "./PtyAdapter.ts";
import {
  windowsTerminalProcessGroup,
  type WindowsTerminalProcessGroup,
} from "../process/windowsJobObject.ts";

export class NodePtyModuleLoadError extends Schema.TaggedErrorClass<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = NodeModule.createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") return;
  if (didEnsureSpawnHelperExecutable) return;

  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (!helperPath) return;
  didEnsureSpawnHelperExecutable = true;

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  // Best-effort: avoid FileSystem.stat in packaged mode where some fs metadata can be missing.
  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;
  private readonly platform: NodeJS.Platform;
  private readonly processGroup: WindowsTerminalProcessGroup | null;
  private readonly disposeTrackingExitListener: (() => void) | null;
  private trackedPid: number | null = null;

  constructor(
    process: import("node-pty").IPty,
    platform: NodeJS.Platform,
    processGroup: WindowsTerminalProcessGroup | null = null,
    shellLabel?: string,
  ) {
    this.process = process;
    this.platform = platform;
    this.processGroup = platform === "win32" ? processGroup : null;

    if (this.processGroup) {
      this.syncTrackedPid(shellLabel);
      const exitDisposable = this.process.onExit(() => {
        this.untrackPid();
      });
      this.disposeTrackingExitListener = () => {
        exitDisposable.dispose();
      };
    } else {
      this.disposeTrackingExitListener = null;
    }
  }

  private syncTrackedPid(label?: string): number {
    const pid = this.process.pid;
    if (this.processGroup && pid > 0 && pid !== this.trackedPid) {
      if (this.trackedPid !== null) {
        this.processGroup.unregister(this.trackedPid);
      }
      if (this.processGroup.register(pid, label)) {
        this.trackedPid = pid;
      }
    }
    return pid;
  }

  private untrackPid(): void {
    if (!this.processGroup) return;
    if (this.trackedPid !== null) {
      this.processGroup.unregister(this.trackedPid);
      this.trackedPid = null;
    }
    const currentPid = this.process.pid;
    if (currentPid > 0) {
      this.processGroup.unregister(currentPid);
    }
  }

  get pid(): number {
    return this.syncTrackedPid();
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    const pid = this.syncTrackedPid();
    // node-pty rejects named signals on Windows; its no-argument kill closes ConPTY.
    this.process.kill(this.platform === "win32" ? undefined : signal);
    if (this.platform === "win32" && this.processGroup) {
      const targetPid = pid > 0 ? pid : this.trackedPid;
      this.untrackPid();
      this.disposeTrackingExitListener?.();
      if (targetPid !== null && targetPid > 0) {
        void this.processGroup.terminatePid(targetPid);
      }
    }
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      this.untrackPid();
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }
}

export interface NodePtyAdapterOptions {
  readonly processGroup?: WindowsTerminalProcessGroup | null;
}

export const make = Effect.fn("NodePtyAdapter.make")(function* (
  loadNodePtyModule: NodePtyModuleLoader = () => import("node-pty"),
  options?: NodePtyAdapterOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const processGroup =
    options?.processGroup === undefined ? windowsTerminalProcessGroup : options.processGroup;

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(Effect.orDie);

  const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
    ensureNodePtySpawnHelperExecutable().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessArchitecture, architecture),
      Effect.orElseSucceed(() => undefined),
    ),
  );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      yield* ensureNodePtySpawnHelperExecutableCached;
      const ptyProcess = yield* Effect.try({
        try: () =>
          nodePty.spawn(input.shell, input.args ?? [], {
            ...(platform === "win32" && input.useConptyDll ? { useConptyDll: true } : {}),
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env: input.env,
            name: platform === "win32" ? "xterm-color" : "xterm-256color",
          }),
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "node-pty",
            shell: input.shell,
            cause,
          }),
      });
      return new NodePtyProcess(ptyProcess, platform, processGroup, input.shell);
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
