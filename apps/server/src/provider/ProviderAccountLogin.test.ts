import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { isBrowserLoginDriver } from "./ProviderAccountLogin.ts";

describe("provider account login", () => {
  it("subscription CLI providers support browser login", () => {
    for (const driver of ["codex", "claudeAgent", "cursor", "grok", "gemini"]) {
      expect(isBrowserLoginDriver(ProviderDriverKind.make(driver))).toBe(true);
    }
    expect(isBrowserLoginDriver(ProviderDriverKind.make("ollama"))).toBe(false);
    // OpenCode's `auth login` is a TUI — there is no headless browser login
    // path. Google in opencode is API-key only.
    expect(isBrowserLoginDriver(ProviderDriverKind.make("opencode"))).toBe(false);
  });
});
