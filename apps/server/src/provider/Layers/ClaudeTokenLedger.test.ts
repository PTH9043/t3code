import { describe, expect, it } from "@effect/vitest";
import {
  makeClaudeTokenUsageSnapshot,
  normalizeClaudeActiveTokenUsage,
  normalizeClaudeContextUsageApiSnapshot,
  resolveAuthoritativeContextWindow,
  resolveClaudePromptCacheTtlEnv,
} from "./ClaudeTokenLedger.ts";

describe("ClaudeTokenLedger (Wave 2-B4 & B-3)", () => {
  it("never clamps real token usage to a stale 200k contextWindow ceiling (262,261 stays 262,261)", () => {
    const snap = makeClaudeTokenUsageSnapshot({
      activeTokens: 265_324,
      inputTokens: 262_261,
      outputTokens: 3_063,
      contextWindow: 200_000,
    });
    expect(snap).toBeDefined();
    expect(snap?.usedTokens).toBe(265_324);
    expect(snap?.lastUsedTokens).toBe(265_324);
    expect(snap?.inputTokens).toBe(262_261);
    // Stale 200k ceiling is omitted rather than displaying a false 100% cap.
    expect(snap?.maxTokens).toBeUndefined();
  });

  it("preserves 1M contextWindow when activeTokens is within 1M", () => {
    const snap = normalizeClaudeActiveTokenUsage(
      {
        input_tokens: 2,
        cache_read_input_tokens: 81_777,
        cache_creation_input_tokens: 180_482,
        output_tokens: 3_063,
      },
      1_000_000,
    );
    expect(snap?.usedTokens).toBe(265_324);
    expect(snap?.inputTokens).toBe(262_261);
    expect(snap?.maxTokens).toBe(1_000_000);
  });

  it("enforces source precedence: model_usage_result > context_usage_api > catalog", () => {
    // 1. Start with catalog 200k -> context_usage_api 1M upgrades it
    const s1 = resolveAuthoritativeContextWindow({
      currentWindow: 200_000,
      currentSource: "catalog",
      incomingWindow: 1_000_000,
      incomingSource: "context_usage_api",
    });
    expect(s1).toEqual({ window: 1_000_000, source: "context_usage_api" });

    // 2. model_usage_result confirms 1M -> later context_usage_api 200k CANNOT downgrade it
    const s2 = resolveAuthoritativeContextWindow({
      currentWindow: 1_000_000,
      currentSource: "model_usage_result",
      incomingWindow: 200_000,
      incomingSource: "context_usage_api",
    });
    expect(s2).toEqual({ window: 1_000_000, source: "model_usage_result" });

    // 3. normalizeClaudeContextUsageApiSnapshot honors authoritative 1M window
    const apiSnap = normalizeClaudeContextUsageApiSnapshot(
      {
        totalTokens: 262_261,
        maxTokens: 200_000,
        percentage: 100,
        isAutoCompactEnabled: true,
        categories: [],
        model: "claude-opus-5-5",
        gridRows: [],
      } as unknown as Parameters<typeof normalizeClaudeContextUsageApiSnapshot>[0],
      undefined,
      1_000_000,
    );
    expect(apiSnap?.usedTokens).toBe(262_261);
    expect(apiSnap?.maxTokens).toBe(1_000_000);
  });

  it("maps promptCacheTtl and subagentPromptCacheTtl to official SDK env vars without clobbering user env", () => {
    expect(
      resolveClaudePromptCacheTtlEnv(
        { promptCacheTtl: "inherit", subagentPromptCacheTtl: "5m" },
        {},
      ),
    ).toEqual({
      CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m",
    });

    expect(
      resolveClaudePromptCacheTtlEnv(
        { promptCacheTtl: "1h", subagentPromptCacheTtl: "5m" },
        { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" },
      ),
    ).toEqual({
      CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m",
    });
  });
});
