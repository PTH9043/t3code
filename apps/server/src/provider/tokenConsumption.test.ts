import { describe, expect, it } from "vite-plus/test";
import {
  acpPromptTokenConsumption,
  claudeTokenConsumption,
  codexTokenConsumption,
  openCodeTokenConsumption,
} from "./tokenConsumption.ts";

describe("native token consumption", () => {
  it("accounts for OpenCode/DeepSeek cache input once and keeps the native response identity", () => {
    const message = {
      id: "message-1",
      sessionID: "session-1",
      role: "assistant",
      providerID: "deepseek",
      modelID: "deepseek-chat",
      time: { completed: 1000 },
      tokens: { total: 157, input: 20, output: 7, reasoning: 3, cache: { read: 100, write: 30 } },
    };
    const [usage] = openCodeTokenConsumption(message);
    expect(usage?.counts).toEqual({
      total: 157,
      input: 150,
      output: 7,
      reasoning: 3,
      cacheRead: 100,
      cacheWrite: 30,
    });
    expect(usage?.model).toBe("deepseek/deepseek-chat");
    expect(usage?.sourceId).toBe(openCodeTokenConsumption({ ...message })[0]?.sourceId);
    expect(openCodeTokenConsumption({ ...message, time: {} })).toEqual([]);
    expect(
      openCodeTokenConsumption({ ...message, tokens: { ...message.tokens, total: 158 } }),
    ).toEqual([]);
    expect(
      openCodeTokenConsumption({ ...message, tokens: { ...message.tokens, input: -1 } }),
    ).toEqual([]);
  });
  it("uses ACP prompt usage without treating context occupancy or missing cache data as a hit", () => {
    const input = {
      provider: "gemini" as const,
      requestId: "request-1",
      model: "gemini-model",
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 },
      },
    };
    expect(acpPromptTokenConsumption(input)[0]?.counts).toEqual({
      total: 120,
      input: 100,
      output: 20,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
    });
    expect(
      acpPromptTokenConsumption({
        ...input,
        result: { used: 100, size: 1000, cost: { amount: 1 } },
      }),
    ).toEqual([]);
    expect(
      acpPromptTokenConsumption({
        ...input,
        result: { ...input.result, usage: { ...input.result.usage, cachedReadTokens: 101 } },
      }),
    ).toEqual([]);
    expect(
      acpPromptTokenConsumption({
        ...input,
        result: { ...input.result, stopReason: "cancelled" },
      })[0]?.isFinal,
    ).toBe(false);
    expect(
      acpPromptTokenConsumption({ ...input, requestId: "steer-request" })[0]?.sourceId,
    ).not.toBe(acpPromptTokenConsumption(input)[0]?.sourceId);
  });
  it("preserves optional Codex cache writes and rejects overlapping cache subsets", () => {
    const total = {
      totalTokens: 120,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 30,
      reasoningOutputTokens: 5,
    };
    expect(codexTokenConsumption("native", total)[0]?.counts).toEqual({
      total: 120,
      input: 100,
      output: 20,
      cacheRead: 60,
      cacheWrite: 30,
      reasoning: 5,
    });
    expect(
      codexTokenConsumption("native", { ...total, cacheWriteInputTokens: 0 })[0]?.counts.cacheWrite,
    ).toBe(0);
    expect(codexTokenConsumption("native", { ...total, cacheWriteInputTokens: 41 })).toEqual([]);
    expect(codexTokenConsumption("native", { ...total, cacheWriteInputTokens: -1 })).toEqual([]);
  });
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
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
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
      cacheWrite5m: 10,
      cacheWrite1h: 20,
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
  it("keeps measured totals when optional Claude TTL details are malformed", () => {
    for (const cache_creation of [
      null,
      { ephemeral_5m_input_tokens: -1 },
      { ephemeral_1h_input_tokens: 31 },
    ]) {
      expect(
        claudeTokenConsumption({
          uuid: "ttl",
          session_id: "session",
          usage: {
            input_tokens: 20,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 30,
            output_tokens: 7,
            cache_creation,
          },
        })[0]?.counts,
      ).toEqual({
        total: 157,
        input: 150,
        output: 7,
        cacheRead: 100,
        cacheWrite: 30,
        reasoning: null,
      });
    }
  });
});
