import { describe, expect, it } from "vite-plus/test";
import {
  acpPromptTokenConsumption,
  claudeTokenConsumption,
  codexTokenConsumption,
  makeClaudeModelUsageLedger,
  openCodeTokenConsumption,
  restoreClaudeModelUsageLedger,
  serializeClaudeModelUsageLedger,
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
  it("records Antigravity ACP usage when cachedReadTokens is reported separately from uncached inputTokens", () => {
    const [usage] = acpPromptTokenConsumption({
      provider: "gemini",
      requestId: "agy-cached-1",
      model: "gemini-4-neon",
      result: {
        stopReason: "end_turn",
        usage: {
          inputTokens: 154463,
          cachedReadTokens: 149786,
          cachedWriteTokens: 0,
          outputTokens: 761,
          thoughtTokens: 424,
          totalTokens: 305010,
        },
      },
    });
    expect(usage?.counts).toEqual({
      total: 305010,
      input: 304249,
      output: 761,
      cacheRead: 149786,
      cacheWrite: 0,
      reasoning: 424,
    });
    expect(usage?.isFinal).toBe(true);
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
  describe("Claude modelUsage ledger", () => {
    const modelEntry = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
      inputTokens: input,
      outputTokens: output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
    });
    const result = (uuid: string, modelUsage: Record<string, unknown>, extra = {}) => ({
      uuid,
      session_id: "session-1",
      is_error: false,
      // Main loop only: the conductor's own turn, never the worker.
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage,
      ...extra,
    });

    it("splits running totals into per-turn, per-model spend that includes subagents", () => {
      const ledger = makeClaudeModelUsageLedger();
      const first = claudeTokenConsumption(
        result("r1", { "claude-fable-5-2": modelEntry(10, 5, 100, 20) }),
        ledger,
      );
      expect(first).toEqual([
        {
          sourceId: "claude:session-1:r1:claude-fable-5-2",
          mode: "execution-total",
          provider: "claude",
          model: "claude-fable-5-2",
          isFinal: true,
          includesNativeChildren: true,
          counts: {
            total: 135,
            input: 130,
            output: 5,
            cacheRead: 100,
            cacheWrite: 20,
            reasoning: null,
          },
        },
      ]);
      const second = claudeTokenConsumption(
        result("r2", {
          "claude-fable-5-2": modelEntry(15, 9, 200, 20),
          "claude-opus-5-5": {
            ...modelEntry(400, 80, 1000, 50),
            canonicalModel: "claude-opus-5-5",
          },
        }),
        ledger,
      );
      expect(second.map((observation) => [observation.model, observation.counts])).toEqual([
        [
          "claude-fable-5-2",
          { total: 109, input: 105, output: 4, cacheRead: 100, cacheWrite: 0, reasoning: null },
        ],
        [
          "claude-opus-5-5",
          {
            total: 1530,
            input: 1450,
            output: 80,
            cacheRead: 1000,
            cacheWrite: 50,
            reasoning: null,
          },
        ],
      ]);
      // A turn that spent nothing on a model reports nothing for it.
      const third = claudeTokenConsumption(
        result("r3", {
          "claude-fable-5-2": modelEntry(20, 10, 200, 20),
          "claude-opus-5-5": modelEntry(400, 80, 1000, 50),
        }),
        ledger,
      );
      expect(third.map((observation) => [observation.model, observation.counts.total])).toEqual([
        ["claude-fable-5-2", 6],
      ]);
    });

    it("re-baselines when the running totals reset", () => {
      const ledger = makeClaudeModelUsageLedger();
      claudeTokenConsumption(result("r1", { main: modelEntry(1000, 100) }), ledger);
      const afterClear = claudeTokenConsumption(result("r2", { main: modelEntry(30, 3) }), ledger);
      expect(afterClear.map((observation) => observation.counts.total)).toEqual([33]);
    });

    it("leaves the ledger alone on a zeroed crash result", () => {
      const ledger = makeClaudeModelUsageLedger();
      claudeTokenConsumption(result("r1", { main: modelEntry(100, 10) }), ledger);
      expect(
        claudeTokenConsumption(
          result("crash", { main: modelEntry(0, 0) }, { is_error: true }),
          ledger,
        ),
      ).toEqual([]);
      const next = claudeTokenConsumption(result("r2", { main: modelEntry(150, 20) }), ledger);
      expect(next.map((observation) => observation.counts.total)).toEqual([60]);
    });

    it("falls back to main-loop usage when modelUsage is unusable", () => {
      const ledger = makeClaudeModelUsageLedger();
      const [observation] = claudeTokenConsumption(
        result("r1", { main: { contextWindow: 200_000 } }),
        ledger,
      );
      expect(observation?.sourceId).toBe("claude:session-1:r1");
      expect(observation?.counts.total).toBe(15);
      expect(observation?.includesNativeChildren).toBeUndefined();
    });

    it("does not count main-loop usage again when modelUsage did not move", () => {
      const ledger = makeClaudeModelUsageLedger();
      claudeTokenConsumption(result("r1", { main: modelEntry(100, 10) }), ledger);
      expect(claudeTokenConsumption(result("r2", { main: modelEntry(100, 10) }), ledger)).toEqual(
        [],
      );
    });

    it("prevents cumulative modelUsage double-counting on resumed session first turn and restores serialized ledger", () => {
      // Simulate a resumed Claude session whose legacy resumeCursor had no saved ledger:
      // modelUsage contains 60M cumulative opus + 34,680 dormant haiku from earlier turns,
      // while ResultMessage.usage contains only the current turn's 1,250 tokens.
      const resumedFirstTurn = {
        uuid: "resumed-1",
        session_id: "sess-resume",
        is_error: false,
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 50,
          output_tokens: 100,
        },
        modelUsage: {
          "claude-opus-5-5": {
            inputTokens: 1_000_000,
            cacheReadInputTokens: 58_000_000,
            cacheCreationInputTokens: 500_000,
            outputTokens: 500_000,
          },
          "claude-haiku-5-5": {
            inputTokens: 1_680,
            cacheReadInputTokens: 30_000,
            cacheCreationInputTokens: 2_000,
            outputTokens: 1_000,
          },
        },
      };

      const freshLedger = makeClaudeModelUsageLedger();
      const firstObs = claudeTokenConsumption(resumedFirstTurn, freshLedger, {
        resumedSession: true,
      });
      // Must NOT record 60M opus or 34,680 haiku — only the single turn's 1,250 tokens!
      expect(firstObs).toHaveLength(1);
      expect(firstObs[0]?.counts.total).toBe(1250);
      expect(freshLedger.size).toBe(2);

      // Next turn in same process (or restored in a later process after restart) reports exact delta
      const serialized = serializeClaudeModelUsageLedger(freshLedger);
      const restored = restoreClaudeModelUsageLedger(serialized);
      const secondTurn = {
        uuid: "resumed-2",
        session_id: "sess-resume",
        is_error: false,
        usage: {
          input_tokens: 200,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 0,
          output_tokens: 300,
        },
        modelUsage: {
          "claude-opus-5-5": {
            inputTokens: 1_000_200,
            cacheReadInputTokens: 58_002_000,
            cacheCreationInputTokens: 500_000,
            outputTokens: 500_300,
          },
          "claude-haiku-5-5": {
            inputTokens: 1_680,
            cacheReadInputTokens: 30_000,
            cacheCreationInputTokens: 2_000,
            outputTokens: 1_000,
          },
        },
      };
      const secondObs = claudeTokenConsumption(secondTurn, restored, {
        resumedSession: true,
      });
      // Only opus moved (+2,500); dormant haiku must NOT appear!
      expect(secondObs).toHaveLength(1);
      expect(secondObs[0]?.model).toBe("claude-opus-5-5");
      expect(secondObs[0]?.counts.total).toBe(2500);
    });
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
