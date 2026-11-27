import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ExternalLauncher } from "../../process/externalLauncher.ts";
import type { McpInvocationScope } from "../McpInvocationContext.ts";
import {
  type DetachedLaunchRequest,
  WorkspaceLaunchAppError,
  buildDetachedAppLaunchRequest,
  containsForbiddenPowerShellReference,
  runWorkspaceLaunchApp,
} from "./workspaceLaunchApp.ts";

const makeScope = (overrides: Partial<McpInvocationScope> = {}): McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-launch-test"),
  threadId: ThreadId.make("thread-launch-test"),
  providerSessionId: "session-launch-test",
  providerInstanceId: ProviderInstanceId.make("gemini"),
  runtimeMode: "full-access",
  interactionMode: "default",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
  ...overrides,
});

it("detects forbidden PowerShell invocations in target or args", () => {
  expect(containsForbiddenPowerShellReference("powershell.exe", [])).toBe(true);
  expect(
    containsForbiddenPowerShellReference(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [],
    ),
  ).toBe(true);
  expect(containsForbiddenPowerShellReference("pwsh", ["-Command", "echo hi"])).toBe(true);
  expect(containsForbiddenPowerShellReference("D:\\scripts\\run.ps1", [])).toBe(true);
  expect(containsForbiddenPowerShellReference("cmd.exe", ["/c", "powershell -c dir"])).toBe(true);
  expect(
    containsForbiddenPowerShellReference("D:\\__auto_airdrop\\web_login.cmd", ["yakkamon"]),
  ).toBe(false);
});

it("builds a visible cmd.exe start command for Windows .cmd scripts and direct spawn for .exe", () => {
  const cmdRequest = buildDetachedAppLaunchRequest({
    platform: "win32",
    target: "D:/__auto_airdrop/web_login.cmd",
    args: ["yakkamon"],
    cwd: "D:/__auto_airdrop",
    env: { SYSTEMROOT: "C:\\Windows" },
  });
  expect(cmdRequest.command).toBe("C:\\Windows\\System32\\cmd.exe");
  expect(cmdRequest.windowsVerbatimArguments).toBe(true);
  expect(cmdRequest.args).toEqual([
    "/d",
    "/c",
    "start",
    '""',
    "/D",
    '"D:\\__auto_airdrop"',
    '"D:\\__auto_airdrop\\web_login.cmd"',
    '"yakkamon"',
  ]);

  const exeRequest = buildDetachedAppLaunchRequest({
    platform: "win32",
    target: "C:/Program Files/App/app.exe",
    args: ["--open"],
    cwd: "C:/Program Files/App",
  });
  expect(exeRequest.command).toBe("C:\\Program Files\\App\\app.exe");
  expect(exeRequest.args).toEqual(["--open"]);
  expect(exeRequest.windowsVerbatimArguments).toBeUndefined();
});

it.effect("launches a Windows .cmd script visibly on the host desktop in full-access mode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launch-cmd-" });
    const scriptPath = path.join(dir, "web_login.cmd");
    yield* fs.writeFileString(scriptPath, "@echo off\r\necho hello\r\n");

    const captured: DetachedLaunchRequest[] = [];
    const result = yield* runWorkspaceLaunchApp({
      scope: makeScope({ executionCwd: dir }),
      request: { target: "web_login.cmd", args: ["arc"] },
      env: { SYSTEMROOT: "C:\\Windows" },
      spawnDetached: async (req) => {
        captured.push(req);
        return { pid: 43210 };
      },
    }).pipe(Effect.provide(Layer.succeed(HostProcessPlatform, "win32")));

    expect(result.launched).toBe(true);
    expect(result.kind).toBe("app");
    expect(result.pid).toBe(43210);
    expect(captured.length).toBe(1);
    expect(captured[0]?.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(captured[0]?.args).toContain('"arc"');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("opens directories via ExternalLauncher file-manager and URLs via browser", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launch-dir-" });
    const launchedEditors: Array<{ editor: string; cwd: string }> = [];
    const launchedUrls: string[] = [];

    const launcherLayer = Layer.succeed(ExternalLauncher, {
      resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
      launchBrowser: (target) =>
        Effect.sync(() => {
          launchedUrls.push(target);
        }),
      launchEditor: (input) =>
        Effect.sync(() => {
          launchedEditors.push(input);
        }),
    });

    const folderResult = yield* runWorkspaceLaunchApp({
      scope: makeScope(),
      request: { target: dir },
    }).pipe(Effect.provide(launcherLayer));

    expect(folderResult.kind).toBe("file-manager");
    expect(launchedEditors).toEqual([{ editor: "file-manager", cwd: folderResult.target }]);

    const urlResult = yield* runWorkspaceLaunchApp({
      scope: makeScope(),
      request: { target: "http://127.0.0.1:13773/" },
    }).pipe(Effect.provide(launcherLayer));

    expect(urlResult.kind).toBe("url");
    expect(launchedUrls).toEqual(["http://127.0.0.1:13773/"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses launch outside full-access mode, in plan mode, or for PowerShell targets", () =>
  Effect.gen(function* () {
    const restricted = yield* runWorkspaceLaunchApp({
      scope: makeScope({ runtimeMode: "approval-required" }),
      request: { target: "http://127.0.0.1:13773/" },
    }).pipe(Effect.flip);
    expect(restricted).toBeInstanceOf(WorkspaceLaunchAppError);
    expect(restricted.message).toContain("full-access");

    const planBlocked = yield* runWorkspaceLaunchApp({
      scope: makeScope({ interactionMode: "plan" }),
      request: { target: "http://127.0.0.1:13773/" },
    }).pipe(Effect.flip);
    expect(planBlocked).toBeInstanceOf(WorkspaceLaunchAppError);
    expect(planBlocked.message).toContain("계획 모드");

    const psBlocked = yield* runWorkspaceLaunchApp({
      scope: makeScope(),
      request: { target: "D:\\scripts\\launch.ps1" },
    }).pipe(Effect.flip);
    expect(psBlocked).toBeInstanceOf(WorkspaceLaunchAppError);
    expect(psBlocked.message).toContain("PowerShell");
  }).pipe(Effect.provide(NodeServices.layer)),
);
