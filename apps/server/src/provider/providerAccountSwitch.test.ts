import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  chooseAutomaticAccount,
  hasSpendableCredits,
  isActualRateLimitFailure,
} from "./providerAccountSwitch.ts";
import { account } from "./testUtils/providerAccountFixture.ts";

describe("account auto switch policy", () => {
  const selection: ModelSelection = {
    instanceId: ProviderInstanceId.make("current"),
    model: "selected-model",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const settings = { codex: true, claudeAgent: false };
  const weekly = account("weekly", {
    usage: { ...account("base").usage!, secondary: { usedPercent: 75 } },
  });
  const choose = (
    providers: ReadonlyArray<ServerProvider>,
    blockedInstanceIds?: ReadonlySet<string>,
  ) =>
    chooseAutomaticAccount({
      selection,
      providers,
      settings,
      nowMs: 0,
      ...(blockedInstanceIds ? { blockedInstanceIds } : {}),
    });

  it("keeps spending current credits after weekly exhaustion", () => {
    expect(
      choose([
        account("current", {
          usage: { ...account("base").usage!, credits: { balance: "62500", hasCredits: true } },
        }),
        weekly,
      ]),
    ).toBeUndefined();
  });
  it("prefers weekly allowance over a credits-only account", () => {
    expect(
      choose([
        account("current"),
        account("credits", { usage: { ...account("base").usage!, credits: { balance: "5" } } }),
        weekly,
      ])?.instanceId,
    ).toBe("weekly");
  });
  it("falls back to spendable credits when no weekly allowance remains", () => {
    expect(
      choose([
        account("current"),
        account("credits", { usage: { ...account("base").usage!, credits: { hasCredits: true } } }),
      ])?.instanceId,
    ).toBe("credits");
  });
  it("real 429 blocks even unlimited credits and skips other rate-limited accounts", () => {
    const current = account("current", {
      usage: { ...account("base").usage!, credits: { unlimited: true } },
    });
    expect(
      choose(
        [current, weekly, account("other", { usage: undefined })],
        new Set(["current", "weekly"]),
      )?.instanceId,
    ).toBe("other");
  });
  it("does not treat unknown quota or the hidden Codex 5h value as weekly exhaustion", () => {
    expect(choose([account("current", { usage: undefined }), weekly])).toBeUndefined();
    expect(
      choose([
        account("current", {
          usage: {
            ...account("base").usage!,
            primary: { usedPercent: 100, windowDurationMinutes: 300 },
            secondary: { usedPercent: 20 },
          },
        }),
        weekly,
      ]),
    ).toBeUndefined();
  });
  it("uses each provider toggle independently", () => {
    expect(choose([account("current"), weekly])?.instanceId).toBe("weekly");
    const claude = ProviderDriverKind.make("claudeAgent");
    const providers = [
      account("current", { driver: claude }),
      account("other", { driver: claude, usage: undefined }),
    ];
    expect(
      chooseAutomaticAccount({
        selection,
        providers,
        settings: { codex: false, claudeAgent: true },
        nowMs: 0,
      })?.instanceId,
    ).toBe("other");
    expect(chooseAutomaticAccount({ selection, providers, settings, nowMs: 0 })).toBeUndefined();
    expect(
      chooseAutomaticAccount({
        selection,
        providers: [account("current"), weekly],
        settings: { codex: false, claudeAgent: true },
        nowMs: 0,
      }),
    ).toBeUndefined();
  });
  it("rejects unavailable accounts, other drivers, and different models", () => {
    const candidates = [
      account("disabled", { enabled: false }),
      account("missing", { installed: false }),
      account("auth", { auth: { status: "unauthenticated" } }),
      account("error", { status: "error" }),
      account("model", { models: [] }),
      account("other_driver", { driver: ProviderDriverKind.make("claudeAgent") }),
      account("unsupported", { availability: "unavailable" }),
    ];
    expect(choose([account("current"), ...candidates])).toBeUndefined();
  });
  it("treats a known elapsed reset as quota available", () => {
    const provider = account("current", {
      usage: { ...account("base").usage!, secondary: { usedPercent: 100, resetsAt: 1 } },
    });
    expect(
      chooseAutomaticAccount({ selection, providers: [provider, weekly], settings, nowMs: 2_000 }),
    ).toBeUndefined();
  });
  it("requires usable credits, not a stale balance contrary to hasCredits", () => {
    expect(hasSpendableCredits({ balance: "62,500", hasCredits: true })).toBe(true);
    expect(hasSpendableCredits({ balance: "0", hasCredits: true })).toBe(false);
    expect(hasSpendableCredits({ balance: "20", hasCredits: false })).toBe(false);
    expect(hasSpendableCredits({ balance: "unknown" })).toBe(false);
  });
  it("recognizes actual protocol 429 errors without mistaking quota percentages or prose", () => {
    for (const message of [
      "HTTP 429",
      "unexpected status 429",
      "status code: 429",
      "429 Too Many Requests",
      "Too Many Requests",
    ])
      expect(isActualRateLimitFailure(message)).toBe(true);
    for (const message of ["credits 429", "weekly quota 100%", "429 tokens processed", null])
      expect(isActualRateLimitFailure(message)).toBe(false);
  });
});
