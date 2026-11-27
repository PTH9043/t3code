// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { appendHostAuditEntry } from "../../orchestration/HostApprovalGate.ts";
import { ExternalLauncher } from "../../process/externalLauncher.ts";
import type { McpInvocationScope } from "../McpInvocationContext.ts";

export class WorkspaceLaunchAppError extends Schema.TaggedErrorClass<WorkspaceLaunchAppError>()(
  "WorkspaceLaunchAppError",
  {
    message: Schema.String,
  },
) {}

export const WorkspaceLaunchAppInput = Schema.Struct({
  target: TrimmedNonEmptyString,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
  kind: Schema.optionalKey(Schema.Literals(["auto", "app", "file-manager", "url"])),
});
export type WorkspaceLaunchAppInput = typeof WorkspaceLaunchAppInput.Type;

export const WorkspaceLaunchAppResult = Schema.Struct({
  launched: Schema.Literal(true),
  kind: Schema.Literals(["app", "file-manager", "url"]),
  target: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  pid: Schema.optionalKey(Schema.Int),
  note: Schema.String,
});
export type WorkspaceLaunchAppResult = typeof WorkspaceLaunchAppResult.Type;

export interface DetachedLaunchRequest {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly windowsVerbatimArguments?: boolean;
}

export type DetachedAppSpawner = (
  request: DetachedLaunchRequest,
) => Promise<{ readonly pid?: number | undefined }>;

const POWERSHELL_TOKEN_PATTERN =
  /(?:^|[\\/\s"'`])(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)(?:$|[\\/\s"'`])|\.ps1(?:$|[\s"'`])/i;

const HTTP_URL_PATTERN = /^https?:\/\//i;
const WINDOWS_SCRIPT_EXTENSIONS = new Set([".cmd", ".bat"]);
const WINDOWS_DIRECT_EXTENSIONS = new Set([".exe", ".com"]);

export function containsForbiddenPowerShellReference(
  target: string,
  args: ReadonlyArray<string>,
): boolean {
  if (POWERSHELL_TOKEN_PATTERN.test(target)) return true;
  for (const arg of args) {
    if (POWERSHELL_TOKEN_PATTERN.test(arg)) return true;
  }
  return false;
}

function unwrapFileUriIfNeeded(raw: string, platform: NodeJS.Platform): string {
  if (!raw.toLowerCase().startsWith("file:")) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol.toLowerCase() !== "file:") return raw;
    const decoded = decodeURIComponent(parsed.pathname);
    if (platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(decoded)) {
      return decoded.slice(1).replaceAll("/", "\\");
    }
    return decoded;
  } catch {
    return raw;
  }
}

function quoteWindowsVerbatimArg(value: string): string {
  const escaped = value.replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function resolveWindowsCmdExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const comspec = env.COMSPEC?.trim() || env.ComSpec?.trim();
  if (comspec) return comspec;
  const systemRoot = env.SYSTEMROOT?.trim() || env.windir?.trim() || String.raw`C:\Windows`;
  return `${systemRoot}\\System32\\cmd.exe`;
}

export function buildDetachedAppLaunchRequest(input: {
  readonly platform: NodeJS.Platform;
  readonly target: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): DetachedLaunchRequest {
  if (input.platform !== "win32") {
    return {
      command: input.target,
      args: [...input.args],
      cwd: input.cwd,
    };
  }

  const normalizedTarget = input.target.replaceAll("/", "\\");
  const normalizedCwd = input.cwd.replaceAll("/", "\\");
  const ext = NodePath.win32.extname(normalizedTarget).toLowerCase();

  if (WINDOWS_DIRECT_EXTENSIONS.has(ext)) {
    return {
      command: normalizedTarget,
      args: [...input.args],
      cwd: normalizedCwd,
    };
  }

  // Use `cmd.exe /d /c start "" /D "<cwd>" "<target>" ...args` so interactive
  // `.cmd`/`.bat` scripts and Windows file associations open a real visible
  // window on the user's interactive desktop (WinSta0\Default) and survive
  // after this MCP tool call and provider turn finish.
  const cmdExe = resolveWindowsCmdExecutable(input.env);
  const startArgs = [
    "/d",
    "/c",
    "start",
    '""',
    "/D",
    quoteWindowsVerbatimArg(normalizedCwd),
    quoteWindowsVerbatimArg(normalizedTarget),
    ...input.args.map(quoteWindowsVerbatimArg),
  ];
  return {
    command: cmdExe,
    args: startArgs,
    cwd: normalizedCwd,
    windowsVerbatimArguments: true,
  };
}

export const defaultDetachedAppSpawner: DetachedAppSpawner = (request) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const child = NodeChildProcess.spawn(request.command, [...request.args], {
      cwd: request.cwd,
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: false,
      ...(request.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ pid: child.pid });
    });
  });

function resolveLocalPath(
  rawPath: string,
  baseCwd: string | undefined,
  platform: NodeJS.Platform,
  resolvePosix: (...segments: Array<string>) => string,
): string {
  const cleaned = unwrapFileUriIfNeeded(rawPath.trim(), platform);
  if (platform === "win32") {
    const winTarget = cleaned.replaceAll("/", "\\");
    if (/^[A-Za-z]:\\/.test(winTarget) || winTarget.startsWith("\\\\")) {
      return NodePath.win32.normalize(winTarget);
    }
    return baseCwd
      ? NodePath.win32.resolve(baseCwd.replaceAll("/", "\\"), winTarget)
      : NodePath.win32.resolve(winTarget);
  }
  return baseCwd ? resolvePosix(baseCwd, cleaned) : resolvePosix(cleaned);
}

function parseHttpUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export const runWorkspaceLaunchApp = Effect.fn("workspaceLaunchApp.run")(function* (input: {
  readonly scope: McpInvocationScope;
  readonly request: WorkspaceLaunchAppInput;
  readonly fallbackCwd?: string | undefined;
  readonly spawnDetached?: DetachedAppSpawner;
  readonly env?: NodeJS.ProcessEnv;
}): Effect.fn.Return<WorkspaceLaunchAppResult, WorkspaceLaunchAppError> {
  const { scope, request } = input;
  const args = request.args ?? [];

  if (scope.runtimeMode !== "full-access") {
    return yield* new WorkspaceLaunchAppError({
      message:
        "프로그램을 사용자 화면에 직접 실행하려면 이 대화의 권한이 전체 권한(full-access)이어야 합니다.",
    });
  }
  if (scope.interactionMode === "plan") {
    return yield* new WorkspaceLaunchAppError({
      message: "계획 모드에서는 외부 프로그램이나 창을 직접 실행하지 않습니다.",
    });
  }
  if (containsForbiddenPowerShellReference(request.target, args)) {
    return yield* new WorkspaceLaunchAppError({
      message:
        "사용자 필수 지침에 따라 PowerShell(powershell.exe, pwsh.exe, .ps1)은 실행할 수 없습니다.",
    });
  }

  const platform = yield* HostProcessPlatform;
  const fileSystemOpt = yield* Effect.serviceOption(FileSystem.FileSystem);
  const pathOpt = yield* Effect.serviceOption(Path.Path);
  const externalLauncher = yield* Effect.serviceOption(ExternalLauncher);
  const sqlOpt = yield* Effect.serviceOption(SqlClient.SqlClient);

  const recordHostLaunchAudit = (
    kind: "url" | "file-manager" | "app",
    target: string,
    command: string,
    launchArgs: ReadonlyArray<string>,
    pid?: number,
  ) =>
    Option.isSome(sqlOpt)
      ? appendHostAuditEntry({
          kind: "approval.executed",
          actorId: scope.providerInstanceId,
          actorKind: "agent",
          resource: target,
          payload: {
            tool: "workspace_launch_app",
            threadId: scope.threadId,
            kind,
            command,
            args: launchArgs,
            ...(pid !== undefined ? { pid } : {}),
          },
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sqlOpt.value),
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.void;

  const requestedKind = request.kind ?? "auto";
  const isUrlTarget =
    requestedKind === "url" || (requestedKind === "auto" && HTTP_URL_PATTERN.test(request.target));

  if (isUrlTarget) {
    const parsedUrl = parseHttpUrl(request.target);
    if (!parsedUrl) {
      return yield* new WorkspaceLaunchAppError({
        message: `유효한 HTTP/HTTPS URL이 아닙니다: ${request.target}`,
      });
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return yield* new WorkspaceLaunchAppError({
        message: `http:// 또는 https:// URL만 브라우저로 열 수 있습니다: ${request.target}`,
      });
    }
    if (Option.isNone(externalLauncher)) {
      return yield* new WorkspaceLaunchAppError({
        message: "외부 브라우저 실행 서비스를 사용할 수 없습니다.",
      });
    }
    yield* externalLauncher.value.launchBrowser(parsedUrl.toString()).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceLaunchAppError({
            message: `브라우저로 URL을 열지 못했습니다: ${cause.message}`,
          }),
      ),
    );
    yield* recordHostLaunchAudit("url", parsedUrl.toString(), "browser", [parsedUrl.toString()]);
    return {
      launched: true as const,
      kind: "url" as const,
      target: parsedUrl.toString(),
      command: "browser",
      args: [parsedUrl.toString()],
      note: "T3 호스트 데스크톱에서 기본 브라우저로 URL을 열었습니다.",
    } satisfies WorkspaceLaunchAppResult;
  }

  if (Option.isNone(fileSystemOpt)) {
    return yield* new WorkspaceLaunchAppError({
      message: "호스트 파일시스템 서비스를 사용할 수 없습니다.",
    });
  }
  const fileSystem = fileSystemOpt.value;
  const pathResolve = Option.isSome(pathOpt) ? pathOpt.value.resolve : NodePath.resolve;
  const pathDirname = Option.isSome(pathOpt) ? pathOpt.value.dirname : NodePath.dirname;
  const pathExtname = Option.isSome(pathOpt) ? pathOpt.value.extname : NodePath.extname;

  const baseCwd = scope.executionCwd ?? input.fallbackCwd;
  const resolvedTarget = resolveLocalPath(request.target, baseCwd, platform, pathResolve);
  const targetStat = yield* fileSystem.stat(resolvedTarget).pipe(Effect.option);
  if (Option.isNone(targetStat)) {
    return yield* new WorkspaceLaunchAppError({
      message: `실행할 경로를 찾을 수 없습니다: ${resolvedTarget}`,
    });
  }

  const shouldOpenFileManager =
    requestedKind === "file-manager" || targetStat.value.type === "Directory";
  if (shouldOpenFileManager) {
    if (Option.isNone(externalLauncher)) {
      return yield* new WorkspaceLaunchAppError({
        message: "파일 탐색기 실행 서비스를 사용할 수 없습니다.",
      });
    }
    yield* externalLauncher.value
      .launchEditor({ editor: "file-manager", cwd: resolvedTarget })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceLaunchAppError({
              message: `파일 탐색기로 경로를 열지 못했습니다: ${cause.message}`,
            }),
        ),
      );
    yield* recordHostLaunchAudit("file-manager", resolvedTarget, "file-manager", [resolvedTarget]);
    return {
      launched: true as const,
      kind: "file-manager" as const,
      target: resolvedTarget,
      command: "file-manager",
      args: [resolvedTarget],
      note: "T3 호스트 데스크톱의 파일 탐색기에서 폴더를 열었습니다.",
    } satisfies WorkspaceLaunchAppResult;
  }

  const defaultDir =
    platform === "win32" ? NodePath.win32.dirname(resolvedTarget) : pathDirname(resolvedTarget);
  const resolvedCwd = request.cwd
    ? resolveLocalPath(request.cwd, baseCwd, platform, pathResolve)
    : defaultDir;
  const cwdStat = yield* fileSystem.stat(resolvedCwd).pipe(Effect.option);
  if (Option.isNone(cwdStat) || cwdStat.value.type !== "Directory") {
    return yield* new WorkspaceLaunchAppError({
      message: `작업 폴더(cwd)를 찾을 수 없습니다: ${resolvedCwd}`,
    });
  }

  const launchRequest = buildDetachedAppLaunchRequest({
    platform,
    target: resolvedTarget,
    args,
    cwd: resolvedCwd,
    ...(input.env ? { env: input.env } : {}),
  });
  const spawnDetached = input.spawnDetached ?? defaultDetachedAppSpawner;
  const spawned = yield* Effect.tryPromise({
    try: () => spawnDetached(launchRequest),
    catch: (cause) =>
      new WorkspaceLaunchAppError({
        message:
          cause instanceof Error
            ? `프로그램을 실행하지 못했습니다: ${cause.message}`
            : "프로그램을 실행하지 못했습니다.",
      }),
  });

  const ext =
    platform === "win32"
      ? NodePath.win32.extname(resolvedTarget).toLowerCase()
      : pathExtname(resolvedTarget).toLowerCase();
  const isBatch = platform === "win32" && WINDOWS_SCRIPT_EXTENSIONS.has(ext);
  const pid =
    typeof spawned.pid === "number" && Number.isInteger(spawned.pid) ? spawned.pid : undefined;
  yield* recordHostLaunchAudit(
    "app",
    resolvedTarget,
    launchRequest.command,
    launchRequest.args,
    pid,
  );
  return {
    launched: true as const,
    kind: "app" as const,
    target: resolvedTarget,
    cwd: resolvedCwd,
    command: launchRequest.command,
    args: [...launchRequest.args],
    ...(pid !== undefined ? { pid } : {}),
    note: isBatch
      ? "T3 호스트의 실제 사용자 데스크톱(WinSta0\\Default)에서 새 창으로 배치 스크립트를 실행했습니다."
      : "T3 호스트의 실제 사용자 데스크톱에서 프로그램을 분리 실행했습니다.",
  } satisfies WorkspaceLaunchAppResult;
});
