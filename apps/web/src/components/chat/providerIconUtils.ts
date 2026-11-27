import { ProviderDriverKind } from "@t3tools/contracts";
import {
  AntigravityIcon,
  AntseedIcon,
  ClaudeAI,
  CursorIcon,
  DeepSeekIcon,
  ExaoneIcon,
  Gemini,
  GlmIcon,
  GrokIcon,
  Icon,
  KimiIcon,
  MuseIcon,
  OllamaIcon,
  OpenAI,
  OpenCodeIcon,
  QwenIcon,
} from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("muse")]: MuseIcon,
  [ProviderDriverKind.make("gemini")]: AntigravityIcon,
};

/**
 * OpenAI-compatible API connections (`apiConnection.providerId`) map to their
 * own brand when we know it — an `antseed_local` row should not look like a
 * plain OpenCode row, and OpenAI API / EXAONE / Ollama / DeepSeek profiles each
 * keep their own brand icon.
 * Returns `undefined` for unknown ids so the caller keeps the driver icon.
 */
export const API_CONNECTION_ICON_BY_PROVIDER_ID: Partial<Record<string, Icon>> = {
  t3_antseed: AntseedIcon,
  t3_deepseek: DeepSeekIcon,
  t3_glm: GlmIcon,
  t3_openai: OpenAI,
  t3_exaone: ExaoneIcon,
  t3_ollama: OllamaIcon,
};

export const API_CONNECTION_LABEL_BY_PROVIDER_ID: Partial<Record<string, string>> = {
  t3_antseed: "Antseed",
  t3_deepseek: "DeepSeek",
  t3_glm: "GLM",
  t3_openai: "OpenAI API",
  t3_exaone: "EXAONE",
  t3_ollama: "Ollama",
};

/** Read `apiConnection.providerId` off an opaque instance config blob. */
export function readApiConnectionProviderId(config: unknown): string | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const connection = (config as Record<string, unknown>)["apiConnection"];
  if (connection === null || typeof connection !== "object") return undefined;
  const providerId = (connection as Record<string, unknown>)["providerId"];
  return typeof providerId === "string" && providerId.length > 0 ? providerId : undefined;
}

/**
 * Best-effort brand inference for callers that never see the config blob.
 * The connection dialog stamps both `instanceId` (`antseed_<uuid>`) and
 * `apiConnection.providerId` (`t3_antseed`) so matching either keeps the
 * right brand badge on every surface.
 */
const ANTSEED_INSTANCE_ID_PATTERN = /^(?:antseed|antseed_|t3_antseed)/i;
const DEEPSEEK_INSTANCE_ID_PATTERN = /^(?:deepseek|deepseek_|t3_deepseek)/i;
const GLM_INSTANCE_ID_PATTERN = /^(?:glm|glm_|t3_glm)/i;
const OPENAI_API_INSTANCE_ID_PATTERN = /^(?:openai_api|t3_openai)/i;
const EXAONE_INSTANCE_ID_PATTERN = /^(?:exaone|exaone_|t3_exaone)/i;
const OLLAMA_INSTANCE_ID_PATTERN = /^(?:ollama|ollama[-_]|t3_ollama)/i;

export function inferApiConnectionProviderId(instanceId: string | undefined): string | undefined {
  if (instanceId === undefined) return undefined;
  const normalized = instanceId.trim();
  if (ANTSEED_INSTANCE_ID_PATTERN.test(normalized)) return "t3_antseed";
  if (DEEPSEEK_INSTANCE_ID_PATTERN.test(normalized)) return "t3_deepseek";
  if (GLM_INSTANCE_ID_PATTERN.test(normalized)) return "t3_glm";
  if (OPENAI_API_INSTANCE_ID_PATTERN.test(normalized)) return "t3_openai";
  if (EXAONE_INSTANCE_ID_PATTERN.test(normalized)) return "t3_exaone";
  if (OLLAMA_INSTANCE_ID_PATTERN.test(normalized)) return "t3_ollama";
  return undefined;
}

function inferDriverKindFromInstanceId(
  instanceId: string | undefined,
): ProviderDriverKind | undefined {
  if (!instanceId) return undefined;
  const lower = instanceId.trim().toLowerCase();
  if (lower === "codex" || lower.startsWith("codex_") || lower.startsWith("codex-")) {
    return ProviderDriverKind.make("codex");
  }
  if (
    lower === "claudeagent" ||
    lower.startsWith("claudeagent_") ||
    lower.startsWith("claude_") ||
    lower.startsWith("claude-")
  ) {
    return ProviderDriverKind.make("claudeAgent");
  }
  if (
    lower === "gemini" ||
    lower.startsWith("gemini_") ||
    lower.startsWith("gemini-") ||
    lower.startsWith("antigravity")
  ) {
    return ProviderDriverKind.make("gemini");
  }
  if (lower === "opencode" || lower.startsWith("opencode_") || lower.startsWith("opencode-")) {
    return ProviderDriverKind.make("opencode");
  }
  if (lower === "cursor" || lower.startsWith("cursor_") || lower.startsWith("cursor-")) {
    return ProviderDriverKind.make("cursor");
  }
  if (lower === "grok" || lower.startsWith("grok_") || lower.startsWith("grok-")) {
    return ProviderDriverKind.make("grok");
  }
  if (lower === "muse" || lower.startsWith("muse_") || lower.startsWith("muse-")) {
    return ProviderDriverKind.make("muse");
  }
  return undefined;
}

/**
 * Resolve the brand icon for an individual model slug or display name so
 * multi-model hosts (OpenCode, Antseed, Antigravity) show DeepSeek / Qwen /
 * Claude / GPT / Gemini / GLM / Grok / EXAONE / Kimi icons per model.
 */
export function getModelBrandIcon(model: string | undefined): Icon | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const leaf = (trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed)
    .trim()
    .toLowerCase();
  if (!leaf) return null;
  if (leaf.includes("deepseek")) return DeepSeekIcon;
  if (leaf.includes("qwen")) return QwenIcon;
  if (leaf.includes("exaone")) return ExaoneIcon;
  if (
    leaf.includes("claude") ||
    /(?:^|[-_.\s])(opus|sonnet|haiku|fable)(?:$|[-_.\s0-9])/.test(leaf)
  ) {
    return ClaudeAI;
  }
  if (leaf.includes("gemini")) return Gemini;
  if (leaf.includes("glm")) return GlmIcon;
  if (leaf.includes("grok")) return GrokIcon;
  if (leaf.includes("muse")) return MuseIcon;
  if (leaf.includes("kimi") || leaf.includes("moonshot")) return KimiIcon;
  if (
    /^(?:gpt|chatgpt|codex)(?:$|[-_.\s0-9])/.test(leaf) ||
    /^o[134](?:$|[-_.])/.test(leaf) ||
    leaf.includes("codex")
  ) {
    return OpenAI;
  }
  return null;
}

/**
 * Resolve the brand icon for an instance. An OpenAI-compatible API connection
 * wins over the OpenCode driver icon so each saved connection keeps its own
 * brand in pickers, cards, and timelines. `instanceId` lets callers that only
 * carry the id (model picker entries, sidebar rows) still match the branded
 * connections created through the dedicated dialogs.
 */
export function getProviderInstanceIcon(
  driverKind: ProviderDriverKind,
  config: unknown,
  instanceId?: string,
): Icon | null {
  const providerId =
    readApiConnectionProviderId(config) ?? inferApiConnectionProviderId(instanceId);
  if (providerId !== undefined) {
    const connectionIcon = API_CONNECTION_ICON_BY_PROVIDER_ID[providerId];
    if (connectionIcon !== undefined) return connectionIcon;
  }
  return PROVIDER_ICON_BY_PROVIDER[driverKind] ?? null;
}

/**
 * Prefer the specific model family's brand icon when known; otherwise fall back
 * to the account/provider instance icon.
 */
export function getModelOrProviderIcon(input: {
  readonly driverKind?: ProviderDriverKind | undefined;
  readonly config?: unknown;
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
}): Icon | null {
  const modelIcon = getModelBrandIcon(input.model);
  if (modelIcon !== null) return modelIcon;
  const providerId =
    readApiConnectionProviderId(input.config) ?? inferApiConnectionProviderId(input.instanceId);
  if (providerId !== undefined) {
    const connectionIcon = API_CONNECTION_ICON_BY_PROVIDER_ID[providerId];
    if (connectionIcon !== undefined) return connectionIcon;
  }
  const effectiveDriver = input.driverKind ?? inferDriverKindFromInstanceId(input.instanceId);
  return effectiveDriver ? (PROVIDER_ICON_BY_PROVIDER[effectiveDriver] ?? null) : null;
}

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  isLegacy?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
