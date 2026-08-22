import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

/**
 * Codex only lets `request_user_input` through in Plan mode unless this
 * feature is on, so in Default mode the model's question came back as
 * "request_user_input is unavailable in Default mode" and it fell back to
 * plain prose — no selectable question, unlike Claude's AskUserQuestion.
 *
 * Written as `-c features.…` rather than `--enable …`: an unknown `--enable`
 * name is fatal (`Error: Unknown feature flag`), which would take down every
 * Codex session the day the flag graduates or is renamed, while an unknown
 * `-c features.…` key is ignored. Ours goes first so a user's own launch args
 * can still turn it back off.
 */
export const CODEX_DEFAULT_MODE_QUESTION_ARGS: ReadonlyArray<string> = [
  "-c",
  "features.default_mode_request_user_input=true",
];

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...CODEX_DEFAULT_MODE_QUESTION_ARGS,
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};
