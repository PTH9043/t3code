import { expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The mock checks Node-specific spawn options.
import type * as NodeChildProcess from "node:child_process";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "./processRunner.ts";
const decodeBackgroundOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ argument: Schema.String, body: Schema.String, flag: Schema.String }),
  ),
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
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("output");
      expect(execFile).toHaveBeenCalledWith(
        "^C:\\provider\\opencode.CMD^",
        ["^models^", "^--verbose^"],
        expect.objectContaining({
          shell: true,
          windowsHide: true,
          env: environment,
          maxBuffer: Number.POSITIVE_INFINITY,
        }),
        expect.any(Function),
      );
    }),
);
