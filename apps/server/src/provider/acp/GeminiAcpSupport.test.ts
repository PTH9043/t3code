import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGeminiAcpModelSelection,
  buildGeminiAcpSpawnInput,
  GEMINI_ACP_AUTH_METHOD_ID,
  resolveGeminiAcpBaseModelId,
} from "./GeminiAcpSupport.ts";

describe("Gemini ACP support", () => {
  it("uses the official ACP command and Google OAuth auth method", () => {
    const environment = { GEMINI_CLI_HOME: "/tmp/gemini-home" };

    expect(
      buildGeminiAcpSpawnInput(
        { binaryPath: "/usr/local/bin/gemini" },
        "/tmp/project",
        environment,
      ),
    ).toEqual({
      command: "/usr/local/bin/gemini",
      args: ["--acp"],
      cwd: "/tmp/project",
      env: environment,
    });
    expect(GEMINI_ACP_AUTH_METHOD_ID).toBe("oauth-personal");
  });

  it("defaults blank model selections to auto", () => {
    expect(resolveGeminiAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveGeminiAcpBaseModelId("   ")).toBe("auto");
    expect(resolveGeminiAcpBaseModelId("  gemini-2.5-pro  ")).toBe("gemini-2.5-pro");
  });
});

describe("applyGeminiAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("switches the session model only when requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const selected = yield* applyGeminiAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "gemini-2.5-pro",
        mapError: (cause) => cause.message,
      });

      expect(selected).toBe("gemini-2.5-pro");
      expect(modelCalls).toEqual(["gemini-2.5-pro"]);
    }),
  );

  it.effect("does not call session/set_model for the current model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const selected = yield* applyGeminiAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "auto",
        mapError: (cause) => cause.message,
      });

      expect(selected).toBe("auto");
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("maps session/set_model failures", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown model");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyGeminiAcpModelSelection({
          runtime,
          currentModelId: "auto",
          requestedModelId: "gemini-test",
          mapError: (cause) => cause.message,
        }),
      );

      expect(error).toBe(failure.message);
    }),
  );
});
