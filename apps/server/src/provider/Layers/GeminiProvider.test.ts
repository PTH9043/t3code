import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { GeminiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";

import {
  buildInitialGeminiProviderSnapshot,
  checkGeminiProviderStatus,
  geminiAcpStartupFailureMessage,
} from "./GeminiProvider.ts";

const decodeGeminiSettings = Schema.decodeSync(GeminiSettings);

describe("Gemini service eligibility", () => {
  it("explains Google's consumer CLI retirement for defects and typed failures", () => {
    const error = new Error(
      "This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products.",
    );
    for (const cause of [Cause.die(error), Cause.fail(error)]) {
      expect(geminiAcpStartupFailureMessage(cause)).toContain("개인 계정");
      expect(geminiAcpStartupFailureMessage(cause)).toContain("지원을 종료");
    }
  });
  it("does not expose unknown startup error contents in the client status", () => {
    const message = geminiAcpStartupFailureMessage(Cause.die(new Error("secret-key")));
    expect(message).toContain("ACP startup failed");
    expect(message).not.toContain("secret-key");
  });
});

describe("buildInitialGeminiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when Gemini is disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGeminiProviderSnapshot(
        decodeGeminiSettings({ enabled: false }),
      );

      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
    }),
  );

  it.effect("returns a pending snapshot with model switching semantics", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGeminiProviderSnapshot(
        decodeGeminiSettings({ enabled: true }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.message).toContain("Checking Gemini");
    }),
  );
});

it.layer(NodeServices.layer)("checkGeminiProviderStatus", (it) => {
  it.effect("reports a missing configured binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGeminiProviderStatus(
        decodeGeminiSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/gemini-binary",
        }),
      );

      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("does not start ACP before a Google account is connected", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGeminiProviderStatus(
        decodeGeminiSettings({
          enabled: true,
          binaryPath: process.execPath,
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth).toMatchObject({
        status: "unauthenticated",
        type: "oauth-personal",
        label: "Google",
      });
      expect(snapshot.message).toContain("Google account");
    }),
  );
});
