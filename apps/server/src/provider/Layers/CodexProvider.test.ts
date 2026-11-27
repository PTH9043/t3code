import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  CODEX_UNVERIFIED_NETWORK_MESSAGE,
  codexAccountUsage,
  isCodexTransientNetworkError,
  legacyCodexModelSlugs,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it("keeps only the newest Codex version line current and folds older lines into legacy", () => {
  const catalog = [
    { model: "gpt-6.2-sol", upgrade: null },
    { model: "gpt-6.2-astra", upgrade: null },
    { model: "gpt-6.1-sol", upgrade: null },
    { model: "gpt-6.1-terra", upgrade: null },
    { model: "gpt-6-astra", upgrade: null },
    { model: "gpt-5.6-terra", upgrade: null },
    { model: "gpt-5.4-mini", upgrade: "gpt-5.6-luna" },
    { model: "gpt-5.3-codex-spark", upgrade: null },
  ];

  assert.deepStrictEqual([...legacyCodexModelSlugs(catalog)].sort(), [
    "gpt-5.3-codex-spark",
    "gpt-5.4-mini",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
  ]);
});

it("folds older 5.6 models into legacy on free catalogs where 6.0 is the newest line", () => {
  const catalog = [
    { model: "gpt-6-luna", upgrade: null },
    { model: "gpt-5.6-terra", upgrade: null },
    { model: "gpt-5.6-luna", upgrade: null },
  ];

  assert.deepStrictEqual([...legacyCodexModelSlugs(catalog)].sort(), [
    "gpt-5.6-luna",
    "gpt-5.6-terra",
  ]);
});

it("treats a model Codex points at a successor as legacy even on the newest line", () => {
  const catalog = [
    { model: "gpt-6.2-sol", upgrade: null },
    { model: "gpt-6.2-preview", upgrade: "gpt-6.2-sol" },
  ];

  assert.deepStrictEqual([...legacyCodexModelSlugs(catalog)], ["gpt-6.2-preview"]);
});

it("keeps everything current when the catalog has only one version line", () => {
  const catalog = [
    { model: "gpt-6.2-sol", upgrade: null },
    { model: "gpt-6.2-astra", upgrade: null },
    { model: "codex-mini-latest", upgrade: null },
  ];

  assert.deepStrictEqual(legacyCodexModelSlugs(catalog).size, 0);
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-6.1-terra", name: "GPT-6.1-Terra", isCustom: false, capabilities: null },
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      isDefault: true,
      isLegacy: true,
      capabilities: null,
    },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-6.1-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("keeps Codex's own current default over the preferred ranking", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "gpt-6.2-astra",
      name: "GPT-6.2-Astra",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "gpt-6.2-sol", name: "GPT-6.2-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-6.2-astra");
});

it("prefers gpt-6.2-sol over gpt-6.1-terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-6.1-terra", name: "GPT-6.1-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-6.2-sol", name: "GPT-6.2-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-6.2-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-6.2-sol", name: "gpt-6.2-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("projects Codex lifetime tokens and quota windows into account usage", () => {
  const usage = codexAccountUsage(
    {
      account: { account: null, requiresOpenaiAuth: false },
      version: "1.2.3",
      models: [],
      skills: [],
      rateLimits: {
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 25, resetsAt: 1_775_779_200, windowDurationMins: 300 },
          secondary: { usedPercent: 48, windowDurationMins: 10_080 },
          credits: { balance: "15", hasCredits: true, unlimited: false },
        },
      },
      tokenUsage: {
        summary: {
          lifetimeTokens: 8_765_432,
          currentStreakDays: 12,
          peakDailyTokens: 345_678,
        },
      },
    },
    "2026-08-09T03:00:00.000Z",
  );

  assert.deepStrictEqual(usage, {
    source: "provider",
    updatedAt: "2026-08-09T03:00:00.000Z",
    sessionTokens: 0,
    sessionCount: 0,
    activeSessionCount: 0,
    lifetimeTokens: 8_765_432,
    currentStreakDays: 12,
    peakDailyTokens: 345_678,
    planType: "pro",
    primary: {
      usedPercent: 25,
      resetsAt: 1_775_779_200,
      windowDurationMinutes: 300,
    },
    secondary: { usedPercent: 48, windowDurationMinutes: 10_080 },
    credits: { balance: "15", hasCredits: true, unlimited: false },
  });
});

it("classifies Codex network/routing timeout errors as unverified warnings instead of hard errors", () => {
  assert.strictEqual(
    isCodexTransientNetworkError(new Error("workspace routing discovery timed out")),
    true,
  );
  assert.strictEqual(
    isCodexTransientNetworkError(new Error("connect ETIMEDOUT 104.18.0.1:443")),
    true,
  );
  assert.strictEqual(isCodexTransientNetworkError(new Error("invalid config schema")), false);
});

it.effect(
  "treats unverifiedReason snapshots from Codex probe as warning with unverified guidance",
  () =>
    Effect.gen(function* () {
      const codexSettings = yield* Schema.decodeEffect(CodexSettings)({ enabled: true });
      const snapshot = yield* checkCodexProviderStatus(codexSettings, () =>
        Effect.succeed({
          account: { account: null, requiresOpenaiAuth: false },
          version: "0.118.0",
          models: [],
          skills: [],
          unverifiedReason: "workspace routing discovery timed out",
        }),
      );

      assert.strictEqual(snapshot.installed, true);
      assert.strictEqual(snapshot.status, "warning");
      assert.strictEqual(snapshot.auth.status, "unknown");
      assert.strictEqual(snapshot.message, CODEX_UNVERIFIED_NETWORK_MESSAGE);
    }).pipe(Effect.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}))),
);
