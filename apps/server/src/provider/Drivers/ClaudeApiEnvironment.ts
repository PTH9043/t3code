import {
  CLAUDE_API_KEY_ENV,
  CLAUDE_API_WORKSPACE_ENV,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const NON_CONSOLE_ROUTING_VARIABLES = [
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

/** Isolate a Console API instance from inherited subscription and gateway settings. */
export function makeClaudeApiEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result = { ...mergeProviderInstanceEnvironment(environment, baseEnv) };
  const blocked = new Set<string>([
    ...NON_CONSOLE_ROUTING_VARIABLES,
    CLAUDE_API_KEY_ENV,
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  ]);
  for (const name of Object.keys(result)) {
    if (blocked.has(name.toUpperCase())) delete result[name];
  }
  const apiKey = [...(environment ?? [])]
    .reverse()
    .find((variable) => variable.name.toUpperCase() === CLAUDE_API_KEY_ENV);
  result[CLAUDE_API_KEY_ENV] = apiKey?.value.trim() ?? "";
  const workspace = [...(environment ?? [])]
    .reverse()
    .find((variable) => variable.name.toUpperCase() === CLAUDE_API_WORKSPACE_ENV)
    ?.value.trim();
  if (workspace && /^wrkspc_[A-Za-z0-9_-]{1,128}$/.test(workspace)) {
    result.ANTHROPIC_CUSTOM_HEADERS = `anthropic-workspace-id: ${workspace}`;
  }
  result.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
  return result;
}

/** The SDK must confirm this exact credential source before prompts are sent. */
export function isClaudeConsoleApiAccount(
  account:
    | { readonly apiKeySource?: string | undefined; readonly apiProvider?: string | undefined }
    | undefined,
): boolean {
  return account?.apiKeySource === "ANTHROPIC_API_KEY" && account.apiProvider === "firstParty";
}
