// @effect-diagnostics nodeBuiltinImport:off
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

export const writeMockLauncher = Effect.fn("writeMockLauncher")(function* (
  scriptPath: string,
  script: string,
) {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.promise(async () => {
    await NodeFSP.writeFile(scriptPath, `#!/usr/bin/env node\n${script}`, "utf8");
    if (platform === "win32") {
      const commandPath = scriptPath.replace(/\.mjs$/, ".cmd");
      await NodeFSP.writeFile(
        commandPath,
        `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${NodePath.basename(scriptPath)}" %*`,
        "utf8",
      );
      return commandPath;
    }
    await NodeFSP.chmod(scriptPath, 0o755);
    return scriptPath;
  });
});
