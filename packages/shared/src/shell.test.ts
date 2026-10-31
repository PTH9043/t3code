import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { it as effectIt } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  extractPathFromShellOutput,
  isCommandAvailable,
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  npmNodeScriptFromShim,
  readEnvironmentFromLoginShell,
  readEnvironmentFromWindowsShell,
  readPathFromLaunchctl,
  readPathFromLoginShell,
  resolveCommandPath,
  resolveKnownWindowsCliDirs,
  resolveSpawnCommand,
  resolveWindowsEnvironment,
  SpawnExecutableResolution,
  WindowsShellEnvironment,
  type WindowsShellEnvironmentReader,
} from "./shell.ts";

const withWindowsEnvironmentMocks = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  readEnvironment: WindowsShellEnvironmentReader,
) => effect.pipe(Effect.provideService(WindowsShellEnvironment, readEnvironment));

describe("extractPathFromShellOutput", () => {
  it("extracts the path between capture markers", () => {
    expect(
      extractPathFromShellOutput(
        "__T3CODE_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__T3CODE_PATH_END__\n",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("ignores shell startup noise around the capture markers", () => {
    expect(
      extractPathFromShellOutput(
        "Welcome to fish\n__T3CODE_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__T3CODE_PATH_END__\nBye\n",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("returns null when the markers are missing", () => {
    expect(extractPathFromShellOutput("/opt/homebrew/bin /usr/bin")).toBeNull();
  });
});

describe("readPathFromLoginShell", () => {
  it("uses a shell-agnostic printenv PATH probe", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__T3CODE_ENV_PATH_START__\n/a:/b\n__T3CODE_ENV_PATH_END__\n");

    expect(readPathFromLoginShell("/opt/homebrew/bin/fish", execFile)).toBe("/a:/b");
    expect(execFile).toHaveBeenCalledTimes(1);

    const firstCall = execFile.mock.calls[0] as
      | [string, ReadonlyArray<string>, { encoding: "utf8"; timeout: number }]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected execFile to be called");
    }

    const [shell, args, options] = firstCall;
    expect(shell).toBe("/opt/homebrew/bin/fish");
    expect(args).toHaveLength(2);
    expect(args?.[0]).toBe("-ilc");
    expect(args?.[1]).toContain("printenv PATH || true");
    expect(args?.[1]).toContain("__T3CODE_ENV_PATH_START__");
    expect(args?.[1]).toContain("__T3CODE_ENV_PATH_END__");
    expect(options).toEqual({ encoding: "utf8", timeout: 5000 });
  });
});

describe("readPathFromLaunchctl", () => {
  it("returns a trimmed PATH value from launchctl", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "  /opt/homebrew/bin:/usr/bin  \n");

    expect(readPathFromLaunchctl(execFile)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(execFile).toHaveBeenCalledWith("/bin/launchctl", ["getenv", "PATH"], {
      encoding: "utf8",
      timeout: 2000,
    });
  });

  it("returns undefined when launchctl is unavailable", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => {
      throw new Error("spawn /bin/launchctl ENOENT");
    });

    expect(readPathFromLaunchctl(execFile)).toBeUndefined();
  });
});

describe("readEnvironmentFromLoginShell", () => {
  it("extracts multiple environment variables from a login shell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "/tmp/secretive.sock",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("omits environment variables that are missing or empty", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
    });
  });

  it("preserves surrounding whitespace in captured values", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      ["__T3CODE_ENV_CUSTOM_VAR_START__", "  padded value  ", "__T3CODE_ENV_CUSTOM_VAR_END__"].join(
        "\n",
      ),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  padded value  ",
    });
  });
});

describe("listLoginShellCandidates", () => {
  it("returns env shell, user shell, then the platform fallback without duplicates", () => {
    expect(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
    ]);
  });

  it("falls back to the platform default when no shells are available", () => {
    expect(listLoginShellCandidates("linux", undefined, "")).toEqual(["/bin/bash"]);
  });
});

describe("mergePathEntries", () => {
  it("prefers login-shell PATH entries and keeps inherited extras", () => {
    expect(
      mergePathEntries("/opt/homebrew/bin:/usr/bin", "/Users/test/.local/bin:/usr/bin", "darwin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });

  it("uses the platform-specific delimiter", () => {
    expect(mergePathEntries("C:\\Tools;C:\\Windows", "C:\\Windows;C:\\Git", "win32")).toBe(
      "C:\\Tools;C:\\Windows;C:\\Git",
    );
  });
});

describe("readEnvironmentFromWindowsShell", () => {
  it("reads only requested variables from hidden CMD output", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf16le"; timeout: number; windowsHide: true },
      ) => string
    >(() => "\uFEFFPath=C:\\사용자\\도구\r\nFNM_DIR=C:\\fnm=1\r\nOTHER=ignored\r\n");

    expect(readEnvironmentFromWindowsShell(["PATH", "FNM_DIR"], execFile)).toEqual({
      PATH: "C:\\사용자\\도구",
      FNM_DIR: "C:\\fnm=1",
    });
    expect(execFile).toHaveBeenCalledWith("cmd.exe", ["/d", "/u", "/c", "set"], {
      encoding: "utf16le",
      timeout: 5000,
      windowsHide: true,
    });
  });

  it("uses CMD even when legacy profile probing is requested", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf16le"; timeout: number; windowsHide: true },
      ) => string
    >(() => "PATH=C:\\Tools\r\n");

    expect(readEnvironmentFromWindowsShell(["PATH"], { loadProfile: true }, execFile)).toEqual({
      PATH: "C:\\Tools",
    });
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile.mock.calls[0]?.[0]).toBe("cmd.exe");
  });

  it("returns no values if the probe fails and rejects unsafe names", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf16le"; timeout: number; windowsHide: true },
      ) => string
    >(() => {
      throw new Error("CMD unavailable");
    });

    expect(readEnvironmentFromWindowsShell(["PATH"], execFile)).toEqual({});
    expect(() => readEnvironmentFromWindowsShell(["PATH&bad"], execFile)).toThrow(
      "Unsupported environment variable name",
    );
    expect(execFile).toHaveBeenCalledOnce();
  });

  // oxlint-disable-next-line t3code/no-global-process-runtime -- This integration check must use the actual host for CMD.
  it.skipIf(NodeOS.platform() !== "win32")("preserves Unicode from a real hidden CMD", () => {
    const name = "T3CODE_SHELL_TEST_UNICODE";
    const previous = process.env[name];
    process.env[name] = "C:\\사용자\\도구";
    try {
      expect(readEnvironmentFromWindowsShell([name])).toEqual({ [name]: "C:\\사용자\\도구" });
    } finally {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
  });
});

describe("mergePathValues", () => {
  it("dedupes case-insensitively on Windows while preserving preferred order", () => {
    expect(
      mergePathValues(
        'C:\\Users\\testuser\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs"',
        "c:\\users\\testuser\\appdata\\roaming\\npm;C:\\Windows\\System32",
        "win32",
      ),
    ).toBe(
      'C:\\Users\\testuser\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs";C:\\Windows\\System32',
    );
  });

  it("dedupes case-sensitively on POSIX", () => {
    expect(mergePathValues("/usr/local/bin:/usr/bin", "/usr/bin:/USR/BIN", "linux")).toBe(
      "/usr/local/bin:/usr/bin:/USR/BIN",
    );
  });
});

describe("resolveKnownWindowsCliDirs", () => {
  it("returns known Windows CLI install directories in priority order", () => {
    expect(
      resolveKnownWindowsCliDirs({
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
        USERPROFILE: "C:\\Users\\testuser",
      }),
    ).toEqual([
      "C:\\Users\\testuser\\AppData\\Roaming\\npm",
      "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
      "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
      "C:\\Users\\testuser\\AppData\\Local\\pnpm",
      "C:\\Users\\testuser\\.bun\\bin",
      "C:\\Users\\testuser\\scoop\\shims",
    ]);
  });
});

effectIt.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("returns false when PATH is empty", () =>
    Effect.gen(function* () {
      expect(
        yield* isCommandAvailable("definitely-not-installed", {
          env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        }).pipe(Effect.provideService(HostProcessPlatform, "win32")),
      ).toBe(false);
    }),
  );
});

effectIt.layer(NodeServices.layer)("resolveCommandPath", (it) => {
  it.effect("fails when PATH is empty", () =>
    Effect.gen(function* () {
      const result = yield* resolveCommandPath("definitely-not-installed", {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(Effect.provideService(HostProcessPlatform, "win32"), Effect.result);

      expect(result._tag).toBe("Failure");
    }),
  );
});

effectIt.layer(NodeServices.layer)("resolveSpawnCommand", (it) => {
  it.effect(
    "bypasses cmd for stock npm shims with a long PATH and preserves literal arguments",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const shimPath = NodeURL.fileURLToPath(
          new URL("./fixtures/npm-node-shim.cmd", import.meta.url),
        );
        const args = ["--message", "hello & goodbye", "%PATH%", 'quote"value'];
        const command = yield* resolveSpawnCommand("example", args, {
          env: { PATH: "C:\\tool;".repeat(2000) },
        }).pipe(
          Effect.provideService(HostProcessPlatform, "win32"),
          Effect.provideService(SpawnExecutableResolution, (name) =>
            name === "example" ? shimPath : "C:\\node\\node.exe",
          ),
        );
        expect(command).toEqual({
          command: "C:\\node\\node.exe",
          args: [path.resolve(path.dirname(shimPath), "node_modules/example/bin/cli.js"), ...args],
          shell: false,
        });
        const original = yield* fileSystem.readFileString(shimPath);
        expect(
          npmNodeScriptFromShim(`echo custom behavior\n${original}`, shimPath),
        ).toBeUndefined();
      }).pipe(Effect.provide(NodePath.layerWin32)),
  );

  it.effect("runs Windows executables directly without a shell", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("node.exe", ["script.js", "hello & goodbye"], {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(Effect.provideService(HostProcessPlatform, "win32"));

      expect(command).toEqual({
        command: "node.exe",
        args: ["script.js", "hello & goodbye"],
        shell: false,
      });
    }),
  );

  it.effect("escapes the executable and arguments for Windows command shims", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand(
        "vp",
        ["run", "value & calc", "%PATH%", 'quote"value'],
        { env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" } },
      ).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(
          SpawnExecutableResolution,
          () => "C:\\Program Files\\npm & tools\\vp.cmd",
        ),
      );

      expect(command.shell).toBe(true);
      expect(command.command).not.toContain(" & ");
      expect(command.command).toContain("^&");
      expect(command.args).toEqual([
        '^"run^"',
        '^"value^ ^&^ calc^"',
        '^"^%PATH^%^"',
        '^"quote\\^"value^"',
      ]);
    }),
  );

  it.effect("resolves against the effective environment when extending host env", () =>
    Effect.gen(function* () {
      let resolvedEnvironment: NodeJS.ProcessEnv | undefined;
      yield* resolveSpawnCommand("codex", ["app-server"], {
        env: { CODEX_HOME: "C:\\Users\\tester\\.codex" },
        extendEnv: true,
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessEnvironment, {
          PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        }),
        Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) => {
          resolvedEnvironment = env;
          return "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd";
        }),
      );

      expect(resolvedEnvironment).toEqual({
        PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        CODEX_HOME: "C:\\Users\\tester\\.codex",
      });
    }),
  );

  it.effect("does not fall back to a shell for unresolved Windows commands", () =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand("missing & calc", ["unsafe & value"], {
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }).pipe(Effect.provideService(HostProcessPlatform, "win32"));

      expect(command).toEqual({
        command: "missing & calc",
        args: ["unsafe & value"],
        shell: false,
      });
    }),
  );
});

effectIt.layer(NodeServices.layer)("resolveWindowsEnvironment", (it) => {
  it.effect("merges the CMD PATH, inherited PATH and known CLI directories", () =>
    Effect.gen(function* () {
      const readEnvironment = vi.fn(() => ({
        PATH: "C:\\Shell\\Bin;C:\\Windows\\System32",
        FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
        FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
      }));
      expect(
        yield* withWindowsEnvironmentMocks(
          resolveWindowsEnvironment({
            PATH: "C:\\Windows\\System32",
            APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
            LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
            USERPROFILE: "C:\\Users\\testuser",
          }),
          readEnvironment,
        ),
      ).toEqual({
        PATH: [
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
          "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
          "C:\\Users\\testuser\\AppData\\Local\\pnpm",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Shell\\Bin",
          "C:\\Windows\\System32",
        ].join(";"),
        FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
        FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
      });
      expect(readEnvironment).toHaveBeenCalledOnce();
      expect(readEnvironment).toHaveBeenCalledWith(
        ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"],
        undefined,
      );
    }),
  );

  it.effect("keeps inherited and known paths if the CMD probe fails", () =>
    Effect.gen(function* () {
      const readEnvironment = vi.fn(() => {
        throw new Error("unavailable");
      });
      expect(
        yield* withWindowsEnvironmentMocks(
          resolveWindowsEnvironment({
            PATH: "C:\\Windows\\System32",
            APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
            USERPROFILE: "C:\\Users\\testuser",
          }),
          readEnvironment,
        ),
      ).toEqual({
        PATH: [
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Windows\\System32",
        ].join(";"),
      });
    }),
  );
});
