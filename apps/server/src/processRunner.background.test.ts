import { expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The mock checks Node-specific spawn options.
import type * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Exercise native Windows background process fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Fixtures use paths passed to native child processes.
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "./processRunner.ts";
const decodeBackgroundOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ argument: Schema.String, body: Schema.String, flag: Schema.String }),
  ),
);
const decodeStringArray = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const background = ProcessRunner.layer.pipe(
  Layer.provide(
    Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
      spawn: () => Effect.die("Background verification must use the explicit hidden spawn path"),
    }),
  ),
);
it.effect(
  "runs a hidden Windows verification with literal arguments, stdin, environment and real exit code",
  () =>
    Effect.gen(function* () {
      const executable = yield* HostProcessExecutablePath;
      const runner = yield* ProcessRunner.ProcessRunner;
      const result = yield* runner.run({
        command: executable,
        args: [
          "-e",
          "let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({argument:process.argv[1],body,flag:process.env.T3_BACKGROUND_TEST}));console.error('stderr');process.exitCode=7;});",
          "한글 & literal argument",
        ],
        stdin: "input text",
        env: { T3_BACKGROUND_TEST: "set" },
        background: true,
      });
      expect(result.code).toBe(7);
      expect(yield* decodeBackgroundOutput(result.stdout)).toEqual({
        argument: "한글 & literal argument",
        body: "input text",
        flag: "set",
      });
      expect(result.stderr.trim()).toBe("stderr");
    }).pipe(Effect.provide(background), Effect.provideService(HostProcessPlatform, "win32")),
);
it.effect(
  "rejects oversized hidden-process output instead of recording a false successful check",
  () =>
    Effect.gen(function* () {
      const executable = yield* HostProcessExecutablePath;
      const runner = yield* ProcessRunner.ProcessRunner;
      const failure = yield* runner
        .run({
          command: executable,
          args: ["-e", "process.stdout.write('x'.repeat(10000))"],
          background: true,
          maxOutputBytes: 64,
        })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("ProcessOutputLimitError");
    }).pipe(Effect.provide(background), Effect.provideService(HostProcessPlatform, "win32")),
);

it.effect(
  "preserves quoted cmd scripts so an explicit failing Node command cannot become a successful string literal",
  () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "win32") return;
      const runner = yield* ProcessRunner.ProcessRunner;
      const result = yield* runner.run({
        command: "cmd.exe",
        args: ["/d", "/s", "/c", 'node -e "console.log(7);process.exit(7)"'],
        background: true,
      });
      expect(result.code).toBe(7);
      expect(result.stdout.trim()).toBe("7");
    }).pipe(Effect.provide(background)),
);

it.effect("preserves literal arguments through a hidden custom Windows batch wrapper", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) !== "win32") return;
    const executable = yield* HostProcessExecutablePath;
    const tempRoot = NodeFS.realpathSync(NodeOS.tmpdir());
    const temporary = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(tempRoot, "t3-hidden-batch-"))),
      (directory) =>
        Effect.sync(() => {
          const resolved = NodeFS.realpathSync(directory);
          if (
            NodePath.dirname(resolved).toLowerCase() !== tempRoot.toLowerCase() ||
            !NodePath.basename(resolved).startsWith("t3-hidden-batch-")
          )
            throw new Error("Refusing to remove an unexpected test directory");
          NodeFS.rmSync(resolved, { recursive: true, force: true });
        }),
    );
    const shim = NodePath.join(temporary, "wrapper with spaces.cmd");
    const script = NodePath.join(temporary, "arguments.js");
    NodeFS.writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)))\n");
    NodeFS.writeFileSync(shim, `@echo off\r\n"${executable}" "%~dp0arguments.js" %*\r\n`);
    const expected = ["with spaces", "alpha&beta", "한글", "plain"];
    const resolved = yield* resolveSpawnCommand(shim, expected);
    expect(resolved.shell).toBe(true);
    const result = yield* ProcessRunner.runHiddenWindowsProcess(resolved);
    expect(result.code, result.stderr).toBe(0);
    expect(yield* decodeStringArray(result.stdout.trim())).toEqual(expected);
  }).pipe(Effect.scoped),
);

it.effect(
  "passes background shell options and the exact environment to Windows process creation",
  () =>
    Effect.gen(function* () {
      const environment = { PATH: "C:\\provider", CUSTOM: "value" };
      const execFile = vi.fn(
        (
          _command: string,
          _args: ReadonlyArray<string>,
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          queueMicrotask(() => callback(null, "output", ""));
          return { stdin: { end: () => undefined }, exitCode: 0 };
        },
      ) as unknown as typeof NodeChildProcess.execFile;
      const result = yield* ProcessRunner.runHiddenWindowsProcess(
        {
          command: "^C:\\provider\\opencode.CMD^",
          args: ["^models^", "^--verbose^"],
          shell: true,
          env: environment,
          replaceEnv: true,
          maxOutputBytes: Number.POSITIVE_INFINITY,
        },
        execFile,
      ).pipe(
        Effect.provideService(HostProcessEnvironment, {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
        }),
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("output");
      expect(execFile).toHaveBeenCalledWith(
        "C:\\Windows\\System32\\cmd.exe",
        ["/d", "/s", "/c", '"^C:\\provider\\opencode.CMD^ ^models^ ^--verbose^"'],
        expect.objectContaining({
          shell: false,
          windowsVerbatimArguments: true,
          windowsHide: true,
          env: environment,
          maxBuffer: Number.POSITIVE_INFINITY,
        }),
        expect.any(Function),
      );
    }),
);
