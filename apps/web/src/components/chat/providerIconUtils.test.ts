import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  AntigravityIcon,
  AntseedIcon,
  ClaudeAI,
  DeepSeekIcon,
  ExaoneIcon,
  Gemini,
  GlmIcon,
  GrokIcon,
  KimiIcon,
  OllamaIcon,
  OpenAI,
  OpenCodeIcon,
  QwenIcon,
} from "../Icons";
import {
  getModelBrandIcon,
  getModelOrProviderIcon,
  getProviderInstanceIcon,
} from "./providerIconUtils";

const OPENCODE = ProviderDriverKind.make("opencode");
const GEMINI = ProviderDriverKind.make("gemini");

describe("providerIconUtils", () => {
  it("maps each registered API account and Antigravity driver to its distinct brand icon", () => {
    expect(getProviderInstanceIcon(GEMINI, undefined, "gemini")).toBe(AntigravityIcon);
    expect(getProviderInstanceIcon(OPENCODE, undefined, "openai_api_123")).toBe(OpenAI);
    expect(getProviderInstanceIcon(OPENCODE, { apiConnection: { providerId: "t3_openai" } })).toBe(
      OpenAI,
    );
    expect(getProviderInstanceIcon(OPENCODE, undefined, "exaone_123")).toBe(ExaoneIcon);
    expect(getProviderInstanceIcon(OPENCODE, { apiConnection: { providerId: "t3_exaone" } })).toBe(
      ExaoneIcon,
    );
    expect(getProviderInstanceIcon(OPENCODE, undefined, "ollama-local")).toBe(OllamaIcon);
    expect(getProviderInstanceIcon(OPENCODE, undefined, "antseed_local")).toBe(AntseedIcon);
    expect(getProviderInstanceIcon(OPENCODE, undefined, "deepseek_123")).toBe(DeepSeekIcon);
    expect(getProviderInstanceIcon(OPENCODE, undefined, "opencode")).toBe(OpenCodeIcon);
  });

  it("maps individual multi-provider models to their own model-family brand icons", () => {
    expect(getModelBrandIcon("opencode-go/deepseek-v4.1-flash")).toBe(DeepSeekIcon);
    expect(getModelBrandIcon("t3_antseed/deepseek/deepseek-v4.1-flash-1017")).toBe(DeepSeekIcon);
    expect(getModelBrandIcon("t3_ollama/qwen2.5-coder:14b")).toBe(QwenIcon);
    expect(getModelBrandIcon("t3_exaone/k-exaone_v2.5")).toBe(ExaoneIcon);
    expect(getModelBrandIcon("claude-opus-5-5")).toBe(ClaudeAI);
    expect(getModelBrandIcon("gemini-4-neon")).toBe(Gemini);
    expect(getModelBrandIcon("gpt-oss-120b-medium")).toBe(OpenAI);
    expect(getModelBrandIcon("t3_openai/gpt-5.4")).toBe(OpenAI);
    expect(getModelBrandIcon("o3-mini")).toBe(OpenAI);
    expect(getModelBrandIcon("t3_antseed/kimi-k3.1-pro")).toBe(KimiIcon);
    expect(getModelBrandIcon("glm-4.5")).toBe(GlmIcon);
    expect(getModelBrandIcon("grok-4")).toBe(GrokIcon);
  });

  it("prefers model brand icon and falls back to account icon for orchestra task rows", () => {
    expect(
      getModelOrProviderIcon({
        instanceId: "opencode",
        model: "opencode-go/deepseek-v4.1-flash",
      }),
    ).toBe(DeepSeekIcon);
    expect(
      getModelOrProviderIcon({
        driverKind: GEMINI,
        instanceId: "gemini",
        model: "claude-opus-5-5",
      }),
    ).toBe(ClaudeAI);
    expect(
      getModelOrProviderIcon({
        driverKind: GEMINI,
        instanceId: "gemini",
        model: "auto",
      }),
    ).toBe(AntigravityIcon);
    expect(
      getModelOrProviderIcon({
        instanceId: "antseed_local",
        model: "t3_antseed/custom-unlisted",
      }),
    ).toBe(AntseedIcon);
  });
});
