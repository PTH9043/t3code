import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { isBrowserLoginDriver } from "./ProviderAccountLogin.ts";

describe("provider account login", () => {
  it("only codex and claudeAgent support browser login", () => {
    expect(isBrowserLoginDriver(ProviderDriverKind.make("codex"))).toBe(true);
    expect(isBrowserLoginDriver(ProviderDriverKind.make("claudeAgent"))).toBe(true);
    expect(isBrowserLoginDriver(ProviderDriverKind.make("gemini"))).toBe(false);
    expect(isBrowserLoginDriver(ProviderDriverKind.make("opencode"))).toBe(false);
  });
});
