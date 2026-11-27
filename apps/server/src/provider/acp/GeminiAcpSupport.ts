import {
  createAndRecordClassifierTelemetry,
  type GeminiSettings,
  type ModelSelection,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { AntigravityLaunch } from "../Drivers/AntigravityLaunch.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type GeminiAcpRuntimeSettings = Pick<GeminiSettings, "binaryPath">;

interface GeminiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly geminiSettings: GeminiAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly launch?: AntigravityLaunch | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
}

function isNativeAgyExecutable(command: string): boolean {
  const normalized = command.trim().replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return basename === "agy" || basename === "agy.exe";
}

export function buildGeminiAcpSpawnInput(
  geminiSettings: GeminiAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  launch?: AntigravityLaunch,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  const command = launch?.command ?? geminiSettings?.binaryPath ?? "agy";
  const baseArgs = [...(launch?.args ?? ["acp", "--process-per-session"])];
  // Strictly gate `--dangerously-skip-permissions` to explicit `full-access` sessions
  // on the native `agy` binary so approval-required / supervised / mock sessions are untouched.
  const args =
    runtimeMode === "full-access" &&
    isNativeAgyExecutable(command) &&
    !baseArgs.includes("--dangerously-skip-permissions")
      ? [...baseArgs, "--dangerously-skip-permissions"]
      : baseArgs;
  return {
    command,
    args,
    cwd,
    ...(environment ? { env: environment, extendEnv: false } : {}),
  };
}

export const makeGeminiAcpRuntime = (
  input: GeminiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        closeSessionOnRelease: true,
        spawn: buildGeminiAcpSpawnInput(
          input.geminiSettings,
          input.cwd,
          input.environment,
          input.launch,
          input.runtimeMode,
        ),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

type SessionSetup =
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;
type Config = EffectAcpSchema.SessionConfigOption;
const modelOption = (options: readonly Config[]) =>
  options.find((opt) => opt.type === "select" && (opt.category === "model" || opt.id === "model"));
const isThinking = (opt: Config) =>
  opt.type === "select" &&
  (opt.category === "thought_level" ||
    /^(thinking[-_]level|thought[-_]level|effort|reasoning[-_]effort)$/i.test(opt.id));
const choices = (opt?: Config) =>
  opt?.type === "select"
    ? opt.options.flatMap((row) => ("value" in row ? [row] : [...row.options]))
    : [];
export function resolveGeminiAcpBaseModelId(model: string | null | undefined): string {
  return model?.trim() || "auto";
}
export function currentGeminiModelIdFromSessionSetup(setup: SessionSetup) {
  const opt = modelOption(setup.configOptions ?? []);
  return opt?.type === "select" ? opt.currentValue : (setup.models?.currentModelId ?? undefined);
}

function thinkingCapabilitiesFromConfig(config: readonly Config[]) {
  const thinking = config.find(isThinking);
  return createModelCapabilities({
    optionDescriptors:
      thinking?.type === "select"
        ? [
            {
              id: thinking.id,
              label: thinking.name,
              type: "select",
              currentValue: thinking.currentValue,
              options: choices(thinking).map((v) => ({ id: v.value, label: v.name })),
            },
          ]
        : [],
  });
}

export function antigravityModels(
  setup: SessionSetup,
  configByModel?: ReadonlyMap<string, readonly Config[]>,
): readonly ServerProviderModel[] {
  const config = setup.configOptions ?? [];
  const models = choices(modelOption(config)).map((c) => ({ slug: c.value, name: c.name }));
  const current = currentGeminiModelIdFromSessionSetup(setup);
  const currentCapabilities = thinkingCapabilitiesFromConfig(config);
  return models.map((row) => {
    const probed = configByModel?.get(row.slug);
    return {
      ...row,
      capabilities: probed
        ? thinkingCapabilitiesFromConfig(probed)
        : row.slug === current
          ? currentCapabilities
          : createModelCapabilities({ optionDescriptors: [] }),
      isCustom: false,
    };
  });
}

export function discoverAntigravityModels(
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">,
  setup: SessionSetup,
): Effect.Effect<readonly ServerProviderModel[]> {
  return Effect.gen(function* () {
    const config = setup.configOptions ?? [];
    const picker = modelOption(config);
    const current = currentGeminiModelIdFromSessionSetup(setup);
    const advertised = choices(picker);
    if (!picker || advertised.length <= 1) {
      return antigravityModels(setup);
    }
    const configByModel = new Map<string, readonly Config[]>();
    if (current) configByModel.set(current, config);
    let switched = false;
    for (const choice of advertised) {
      if (choice.value === current) continue;
      const reply = yield* runtime.setConfigOption(picker.id, choice.value).pipe(Effect.option);
      if (reply._tag === "Some") {
        switched = true;
        configByModel.set(choice.value, reply.value.configOptions);
      }
    }
    // Restore the session's initial model so discovery never mutates the profile default.
    if (switched && current) {
      yield* runtime.setConfigOption(picker.id, current).pipe(Effect.ignore);
    }
    return antigravityModels(setup, configByModel);
  });
}

export function extractCoreUserTaskForThoughtRouting(prompt: string | undefined): string {
  if (!prompt) return "";
  const taskMarker = prompt.lastIndexOf("## 현재 사용자 작업");
  const sliced = taskMarker >= 0 ? prompt.slice(taskMarker + "## 현재 사용자 작업".length) : prompt;
  return sliced
    .replace(/<t3_[a-z0-9_]+(?:\s[^>]*)?>[\s\S]*?<\/t3_[a-z0-9_]+>/giu, "")
    .replace(/<subordinate_models>[\s\S]*?<\/subordinate_models>/giu, "")
    .trim();
}

export type GeminiThoughtLevel = "low" | "medium" | "high" | "xhigh";
export type GeminiTurnThoughtPhase = "route" | "tool_loop" | "plan" | "final_audit";

const FINAL_AUDIT_PHASE_PATTERN =
  /(?:최종\s*(?:검증|감사|판정|리뷰|점검)|보안\s*(?:감사|검토)|아키텍처\s*(?:검토|감사|리뷰)|final\s+(?:audit|review|verification|sign-?off)|security\s+audit|adversarial\s+review)/iu;

export function inferGeminiTurnPhase(input: {
  readonly interactionMode?: string | undefined;
  readonly prompt?: string | undefined;
  readonly complexityProfile?:
    | "trivial"
    | "focused-lookup"
    | "standard-dev"
    | "deep-architectural"
    | undefined;
}): GeminiTurnThoughtPhase {
  const coreTask = extractCoreUserTaskForThoughtRouting(input.prompt);
  if (coreTask && FINAL_AUDIT_PHASE_PATTERN.test(coreTask)) {
    return "final_audit";
  }
  if (input.interactionMode === "plan" || input.complexityProfile === "deep-architectural") {
    return "plan";
  }
  if (input.complexityProfile === "trivial") {
    return "route";
  }
  return "tool_loop";
}

export function recommendPhaseThoughtLevel(
  phase: GeminiTurnThoughtPhase,
  availableLevels?: ReadonlyArray<string>,
): GeminiThoughtLevel {
  const desired: GeminiThoughtLevel =
    phase === "route"
      ? "low"
      : phase === "tool_loop"
        ? "medium"
        : phase === "plan"
          ? "high"
          : "xhigh";
  let resolved: GeminiThoughtLevel = desired;
  let fallbackUsed = false;
  let ruleId = `thought.${phase}.direct`;

  if (availableLevels && availableLevels.length > 0 && !availableLevels.includes(desired)) {
    if (desired === "xhigh") {
      if (availableLevels.includes("high")) {
        resolved = "high";
        fallbackUsed = true;
        ruleId = "thought.xhigh_fallback_high";
      } else if (availableLevels.includes("medium")) {
        resolved = "medium";
        fallbackUsed = true;
        ruleId = "thought.xhigh_fallback_medium";
      }
    }
  }

  createAndRecordClassifierTelemetry({
    classifier: "gemini_thought_level",
    decision: resolved,
    confidence: fallbackUsed ? 0.7 : 0.92,
    fallbackUsed,
    ruleId,
    signalSource: fallbackUsed ? "fallback" : "heuristic",
  });
  return resolved;
}

export function recommendGeminiTurnThoughtLevel(
  complexityProfile: "trivial" | "focused-lookup" | "standard-dev" | "deep-architectural",
  options?: {
    readonly phase?: GeminiTurnThoughtPhase | undefined;
    readonly interactionMode?: string | undefined;
    readonly prompt?: string | undefined;
    readonly availableLevels?: ReadonlyArray<string> | undefined;
  },
): GeminiThoughtLevel {
  if (options?.phase) {
    return recommendPhaseThoughtLevel(options.phase, options.availableLevels);
  }
  if (options?.interactionMode || options?.prompt) {
    const inferred = inferGeminiTurnPhase({
      interactionMode: options.interactionMode,
      prompt: options.prompt,
      complexityProfile,
    });
    return recommendPhaseThoughtLevel(inferred, options.availableLevels);
  }
  switch (complexityProfile) {
    case "trivial":
      return "low";
    case "focused-lookup":
    case "standard-dev":
      return "medium";
    case "deep-architectural":
      return "high";
  }
}

export function applyGeminiAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly options?: ModelSelection["options"];
  /** Best-effort auto-throttled thought_level applied only when no explicit thinking option was given and the active model supports it. */
  readonly autoThoughtLevel?: GeminiThoughtLevel | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}) {
  return Effect.gen(function* () {
    const config = yield* input.runtime.getConfigOptions;
    const model = modelOption(config);
    const requested = input.requestedModelId;
    let active = model?.type === "select" ? model.currentValue : input.currentModelId;
    // Old T3 rooms store "auto" as the provider-default sentinel. Never send it as an invented slug.
    if (
      requested &&
      requested !== active &&
      !(requested === "auto" && !choices(model).some((c) => c.value === requested))
    ) {
      if (model && choices(model).some((c) => c.value === requested)) {
        const reply = yield* input.runtime.setConfigOption(model.id, requested);
        const confirmed = modelOption(reply.configOptions);
        if (confirmed?.type !== "select" || confirmed.currentValue !== requested) {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: "Antigravity did not confirm the selected model.",
          });
        }
      } else {
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: "Antigravity did not offer the requested model for this profile.",
        });
      }
      active = requested;
    }
    if (!active) {
      return yield* new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Antigravity did not advertise an active model for this profile.",
      });
    }
    let hasExplicitThinking = false;
    for (const choice of input.options ?? []) {
      const currentConfig = yield* input.runtime.getConfigOptions;
      if (!currentConfig.some((opt) => opt.id === choice.id && isThinking(opt))) {
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: "Antigravity did not offer the selected thinking option.",
        });
      }
      hasExplicitThinking = true;
      const reply = yield* input.runtime.setConfigOption(choice.id, choice.value);
      if (
        !reply.configOptions.some(
          (opt) => opt.id === choice.id && opt.currentValue === choice.value,
        )
      ) {
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: "Antigravity did not confirm the selected thinking level.",
        });
      }
    }
    if (!hasExplicitThinking && input.autoThoughtLevel) {
      const currentConfig = yield* input.runtime.getConfigOptions;
      const thinkingOpt = currentConfig.find(isThinking);
      if (thinkingOpt?.type === "select") {
        const available = choices(thinkingOpt).map((item) => item.value);
        const target = available.includes(input.autoThoughtLevel)
          ? input.autoThoughtLevel
          : input.autoThoughtLevel === "xhigh" && available.includes("high")
            ? "high"
            : input.autoThoughtLevel === "low" && available.includes("minimal")
              ? "minimal"
              : undefined;
        if (target && thinkingOpt.currentValue !== target) {
          yield* input.runtime.setConfigOption(thinkingOpt.id, target).pipe(Effect.ignore);
        }
      }
    }
    return active;
  }).pipe(Effect.mapError(input.mapError));
}
