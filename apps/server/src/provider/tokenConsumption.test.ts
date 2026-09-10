import { describe, expect, it } from "vite-plus/test";
import { claudeTokenConsumption, codexTokenConsumption } from "./tokenConsumption.ts";

describe("native token consumption", () => {
  it("does not present a zeroed crash result as a measured free execution", () => {
    const result = {
      uuid: "crash",
      session_id: "session",
      is_error: true,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    expect(claudeTokenConsumption(result)).toEqual([]);
    expect(claudeTokenConsumption({ ...result, is_error: false })[0]?.counts.total).toBe(0);
  });
  it("uses Codex total rather than the last context and never adds cached or reasoning subsets", () => {
    const [observation] = codexTokenConsumption("native-1", {
      totalTokens: 125463,
      inputTokens: 125068,
      cachedInputTokens: 121344,
      outputTokens: 395,
      reasoningOutputTokens: 90,
    });
    expect(observation?.counts).toEqual({
      total: 125463,
      input: 125068,
      output: 395,
      cacheRead: 121344,
      cacheWrite: null,
      reasoning: 90,
    });
    expect(observation?.mode).toBe("cumulative");
  });
  it("normalizes Claude input cache categories once and ignores cumulative modelUsage", () => {
    const [observation] = claudeTokenConsumption({
      uuid: "result-1",
      session_id: "session-1",
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 30,
        output_tokens: 7,
      },
      modelUsage: { model: { inputTokens: 90000, outputTokens: 4000 } },
    });
    expect(observation?.counts).toEqual({
      total: 157,
      input: 150,
      output: 7,
      cacheRead: 100,
      cacheWrite: 30,
      reasoning: null,
    });
    expect(observation?.sourceId).toBe("claude:session-1:result-1");
  });
  it("keeps missing, malformed, negative and unsafe usage unreported", () => {
    expect(claudeTokenConsumption(undefined)).toEqual([]);
    expect(
      claudeTokenConsumption({
        uuid: "x",
        session_id: "y",
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ).toEqual([]);
    expect(codexTokenConsumption("x", { totalTokens: -1 })).toEqual([]);
    expect(
      codexTokenConsumption("x", {
        totalTokens: Number.MAX_SAFE_INTEGER + 1,
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      }),
    ).toEqual([]);
  });
});
