import { assert, it } from "@effect/vitest";

import {
  applyPreferredCodexDefaultModel,
  codexAccountUsage,
  legacyCodexModelSlugs,
  mapCodexModelCapabilities,
} from "./CodexProvider.ts";

it("keeps the two newest Codex version lines current and folds the rest into legacy", () => {
  const catalog = [
    { model: "gpt-6-astra", upgrade: null },
    { model: "gpt-5.6-sol", upgrade: null },
    { model: "gpt-5.6-terra", upgrade: null },
    { model: "gpt-5.6-luna", upgrade: null },
    { model: "gpt-5.5", upgrade: null },
    { model: "gpt-5.4-mini", upgrade: "gpt-5.6-luna" },
    { model: "gpt-5.3-codex-spark", upgrade: null },
  ];

  assert.deepStrictEqual([...legacyCodexModelSlugs(catalog)].sort(), [
    "gpt-5.3-codex-spark",
    "gpt-5.4-mini",
    "gpt-5.5",
  ]);
});

it("treats a model Codex points at a successor as legacy even on the newest line", () => {
  const catalog = [
    { model: "gpt-6-astra", upgrade: null },
    { model: "gpt-6-nova", upgrade: "gpt-6-astra" },
    { model: "gpt-5.6-sol", upgrade: null },
  ];

  assert.deepStrictEqual([...legacyCodexModelSlugs(catalog)], ["gpt-6-nova"]);
});

it("keeps everything current when the catalog has only one or two version lines", () => {
  const catalog = [
    { model: "gpt-5.6-sol", upgrade: null },
    { model: "gpt-5.6-terra", upgrade: null },
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
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
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
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("keeps Codex's own current default over the preferred ranking", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "gpt-6-astra",
      name: "GPT-6-Astra",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-6-astra");
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
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
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
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
