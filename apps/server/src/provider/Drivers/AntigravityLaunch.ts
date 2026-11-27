// @effect-diagnostics nodeBuiltinImport:off - Resolve the installed native provider binary and its per-account directories.
import { existsSync } from "node:fs";
import * as Path from "node:path";
import type {
  GeminiSettings,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { expandHomePath } from "../../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

export function resolveAntigravityLaunch(input: {
  readonly settings: Pick<GeminiSettings, "binaryPath" | "homePath">;
  readonly instanceId: ProviderInstanceId;
  readonly stateDir: string;
}) {
  const configured = input.settings.binaryPath.trim();
  const basename = Path.win32.basename(configured).toLowerCase();
  const windowsInstall =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? Path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe")
      : undefined;
  // A historical Gemini launcher (including a custom wrapper) cannot identify an agy executable.
  const command =
    configured && /^(agy|agy\.exe)$/.test(basename) && configured !== basename
      ? expandHomePath(configured)
      : windowsInstall && existsSync(windowsInstall)
        ? windowsInstall
        : process.platform === "win32"
          ? "agy.exe"
          : "agy";
  const home = input.settings.homePath.trim();
  const root = home
    ? expandHomePath(home)
    : Path.join(input.stateDir, "provider-instances", input.instanceId, "antigravity-home");
  const geminiDir = Path.resolve(root, ".gemini");
  return {
    command,
    args: [
      "acp",
      "--gemini-dir",
      geminiDir,
      "--app-data-dir",
      "antigravity-cli",
      "--process-per-session",
    ],
    geminiDir,
    profileDirectory: Path.join(geminiDir, "antigravity-cli"),
  };
}

export type AntigravityLaunch = ReturnType<typeof resolveAntigravityLaunch>;

export function makeAntigravityEnvironment(
  environment?: ProviderInstanceEnvironment,
  base = process.env,
) {
  const clean = { ...base };
  const credentials = new Set([
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AGY_ADC_AUTH",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GEMINI_CLI_HOME",
    "GEMINI_FORCE_FILE_STORAGE",
    "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
  ]);
  for (const key of Object.keys(clean)) if (credentials.has(key.toUpperCase())) delete clean[key];
  return mergeProviderInstanceEnvironment(environment, clean);
}
