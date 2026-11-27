import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { SessionConfigOption } from "effect-acp/schema";
import {
  antigravityModels,
  applyGeminiAcpModelSelection,
  buildGeminiAcpSpawnInput,
  discoverAntigravityModels,
  extractCoreUserTaskForThoughtRouting,
  recommendGeminiTurnThoughtLevel,
} from "./GeminiAcpSupport.ts";

const options = (model: string, effort = "low"): SessionConfigOption[] => [
  {
    id: "native-picker",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: model,
    options: [
      {
        group: "account",
        name: "Account",
        options: [
          { value: "a", name: "Model A" },
          { value: "b", name: "Model B" },
        ],
      },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    type: "select",
    category: "thought_level",
    currentValue: effort,
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

it("uses the same native account profile for discovery, prompting and explicit login", () => {
  const launch = {
    command: "/bin/agy",
    args: [
      "acp",
      "--gemini-dir",
      "/account/.gemini",
      "--app-data-dir",
      "antigravity-cli",
      "--process-per-session",
    ],
    profileDirectory: "/account/.gemini/antigravity-cli",
  };
  const env = { PATH: "/bin" };
  expect(buildGeminiAcpSpawnInput({ binaryPath: "gemini" }, "/work", env, launch)).toEqual({
    command: launch.command,
    args: launch.args,
    cwd: "/work",
    env,
    extendEnv: false,
  });
  // Full-access on native agy appends --dangerously-skip-permissions; approval-required never does.
  expect(
    buildGeminiAcpSpawnInput({ binaryPath: "gemini" }, "/work", env, launch, "full-access").args,
  ).toEqual([...launch.args, "--dangerously-skip-permissions"]);
  expect(
    buildGeminiAcpSpawnInput({ binaryPath: "gemini" }, "/work", env, launch, "approval-required")
      .args,
  ).toEqual(launch.args);
  // Non-agy mock launchers never receive --dangerously-skip-permissions.
  expect(
    buildGeminiAcpSpawnInput(
      { binaryPath: "/tmp/fake-gemini.mjs" },
      "/work",
      env,
      undefined,
      "full-access",
    ).args,
  ).toEqual(["acp", "--process-per-session"]);
});

it("lists the advertised grouped models and only verified model options", () => {
  const models = antigravityModels({ sessionId: "test", configOptions: options("a") });
  expect(models.map((model) => [model.slug, model.name])).toEqual([
    ["a", "Model A"],
    ["b", "Model B"],
  ]);
  expect(models[0]?.capabilities?.optionDescriptors?.[0]?.id).toBe("thinking");
  expect(models[1]?.capabilities?.optionDescriptors ?? []).toEqual([]);
  expect(antigravityModels({ sessionId: "test" })).toEqual([]);
});

it.effect("sets and confirms exact negotiated model and reasoning without substituting", () =>
  Effect.gen(function* () {
    const calls: (string | boolean)[][] = [];
    let model = "a",
      effort = "low";
    const runtime = {
      getConfigOptions: Effect.sync(() => options(model, effort)),
      setConfigOption: (id: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push([id, value]);
          if (id === "native-picker") model = String(value);
          if (id === "thinking") effort = String(value);
          return { configOptions: options(model, effort) };
        }),
    };
    const select = (requestedModelId: string) =>
      applyGeminiAcpModelSelection({
        runtime,
        currentModelId: "a",
        requestedModelId,
        mapError: (cause) => cause.message,
      });
    expect(yield* select("auto")).toBe("a");
    expect(yield* Effect.flip(select("other-provider-model"))).toContain("did not offer");
    expect(calls).toEqual([]);
    expect(
      yield* applyGeminiAcpModelSelection({
        runtime,
        currentModelId: "a",
        requestedModelId: "b",
        options: [{ id: "thinking", value: "high" }],
        mapError: (cause) => cause.message,
      }),
    ).toBe("b");
    expect(calls).toEqual([
      ["native-picker", "b"],
      ["thinking", "high"],
    ]);
    const refused = yield* Effect.flip(
      applyGeminiAcpModelSelection({
        runtime: {
          ...runtime,
          setConfigOption: () => Effect.succeed({ configOptions: options("b") }),
        },
        currentModelId: "b",
        requestedModelId: "a",
        mapError: (cause) => cause.message,
      }),
    );
    expect(refused).toContain("did not confirm");
  }),
);

it.effect(
  "discovers per-model thinking options across all advertised models and restores the initial model",
  () =>
    Effect.gen(function* () {
      const calls: (string | boolean)[][] = [];
      const perModel: Record<string, SessionConfigOption[]> = {
        a: options("a", "high"),
        b: [
          options("b", "low")[0]!,
          {
            id: "thinking",
            name: "Thinking",
            type: "select",
            category: "thought_level",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
            ],
          },
        ],
      };
      const runtime = {
        setConfigOption: (id: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push([id, value]);
            return { configOptions: perModel[String(value)] ?? options(String(value)) };
          }),
      };
      const discovered = yield* discoverAntigravityModels(runtime, {
        sessionId: "test",
        configOptions: perModel.a!,
      });
      expect(
        discovered.map((m) => {
          const desc = m.capabilities?.optionDescriptors?.[0];
          return [m.slug, desc?.type === "select" ? desc.options.length : 0];
        }),
      ).toEqual([
        ["a", 2],
        ["b", 2],
      ]);
      expect(discovered[1]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
        id: "thinking",
        currentValue: "medium",
      });
      expect(calls).toEqual([
        ["native-picker", "b"],
        ["native-picker", "a"],
      ]);
    }),
);

it.effect(
  "auto-throttles thought_level for neon when unset, skips unsupported models, and respects explicit options",
  () =>
    Effect.gen(function* () {
      const calls: (string | boolean)[][] = [];
      let model = "a";
      let effort = "high";
      const runtime = {
        getConfigOptions: Effect.sync(() => options(model, effort)),
        setConfigOption: (id: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push([id, value]);
            if (id === "native-picker") model = String(value);
            if (id === "thinking") effort = String(value);
            return { configOptions: options(model, effort) };
          }),
      };

      yield* applyGeminiAcpModelSelection({
        runtime,
        currentModelId: "a",
        requestedModelId: "a",
        autoThoughtLevel: "low",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([["thinking", "low"]]);

      // Explicit user thinking choice must override autoThoughtLevel.
      calls.length = 0;
      yield* applyGeminiAcpModelSelection({
        runtime,
        currentModelId: "a",
        requestedModelId: "a",
        options: [{ id: "thinking", value: "high" }],
        autoThoughtLevel: "low",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([["thinking", "high"]]);

      // Models without thinking options (e.g. orchestrator-neon) silently skip autoThoughtLevel.
      const noThinkingRuntime = {
        getConfigOptions: Effect.sync(() => [options("a", "high")[0]!]),
        setConfigOption: () => Effect.succeed({ configOptions: [options("a", "high")[0]!] }),
      };
      expect(
        yield* applyGeminiAcpModelSelection({
          runtime: noThinkingRuntime,
          currentModelId: "a",
          requestedModelId: "a",
          autoThoughtLevel: "low",
          mapError: (cause) => cause.message,
        }),
      ).toBe("a");

      expect(
        extractCoreUserTaskForThoughtRouting(
          "# 프로젝트 문맥\n...\n## 현재 사용자 작업\n확인했어?\n\n<t3_global_contract>긴 지침</t3_global_contract>",
        ),
      ).toBe("확인했어?");
      expect(recommendGeminiTurnThoughtLevel("trivial")).toBe("low");
      expect(recommendGeminiTurnThoughtLevel("focused-lookup")).toBe("medium");
      expect(recommendGeminiTurnThoughtLevel("deep-architectural")).toBe("high");
    }),
);
