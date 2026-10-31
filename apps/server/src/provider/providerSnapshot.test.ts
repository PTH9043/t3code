import { describe, expect, it } from "@effect/vitest";
import type { ModelCapabilities } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import { ProcessSpawnError, runHiddenWindowsProcess } from "../processRunner.ts";

import {
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
} from "./providerSnapshot.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          isCustom: false,
          capabilities,
        },
      ],
      [" opus "],
      capabilities,
    );

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-8", "opus"]);
    expect(models[1]?.isCustom).toBe(true);
  });
});

describe("ProviderCommandNotFoundError", () => {
  it("classifies normalized platform failures without parsing messages", () => {
    expect(
      isCommandMissingCause(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "arbitrary host detail",
        }),
      ),
    ).toBe(true);
    expect(isCommandMissingCause(new Error("spawn provider ENOENT"))).toBe(false);
    expect(
      isCommandMissingCause(
        new ProcessSpawnError({
          command: "provider",
          argumentCount: 1,
          cause: Object.assign(new Error("missing"), { code: "ENOENT" }),
        }),
      ),
    ).toBe(true);
  });

  it.effect("retains safe failed-command diagnostics without process output", () => {
    const stderr = "'codex' is not recognized: secret-token-value";
    const hidden = vi.fn(() =>
      Effect.succeed({
        stdout: "",
        stderr,
        code: ChildProcessSpawner.ExitCode(9009),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ) as unknown as typeof runHiddenWindowsProcess;
    return Effect.gen(function* () {
      const error = yield* spawnAndCollect(
        "C:\\tools\\codex.cmd",
        ChildProcess.make("codex", ["--version"]),
        hidden,
      ).pipe(
        Effect.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
          ),
        ),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.flip,
      );

      if (error._tag !== "ProviderCommandNotFoundError") {
        throw new Error(`Unexpected error: ${error._tag}`);
      }

      expect(error.binaryPath).toBe("C:\\tools\\codex.cmd");
      expect(error.exitCode).toBe(9009);
      expect(error.stdoutLength).toBe(0);
      expect(error.stderrLength).toBe(stderr.length);
      expect(error.message).toBe(
        "Provider command C:\\tools\\codex.cmd was not found (exit code 9009).",
      );
      expect(isCommandMissingCause(error)).toBe(true);
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(error.message).not.toContain("secret-token-value");
    });
  });

  it.effect(
    "uses hidden Windows execution for provider status commands with the original options",
    () => {
      const hidden = vi.fn(() =>
        Effect.succeed({
          stdout: "1.2.3",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      ) as unknown as typeof runHiddenWindowsProcess;
      const env = { PATH: "C:\\provider", PROVIDER: "value" };
      return Effect.gen(function* () {
        const result = yield* spawnAndCollect(
          "gemini",
          ChildProcess.make("gemini.cmd", ["--version"], { shell: true, env }),
          hidden,
        ).pipe(
          Effect.provide(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
            ),
          ),
          Effect.provideService(HostProcessPlatform, "win32"),
        );
        expect(result).toEqual({ stdout: "1.2.3", stderr: "", code: 0 });
        expect(hidden).toHaveBeenCalledWith(
          expect.objectContaining({
            command: "gemini.cmd",
            args: ["--version"],
            shell: true,
            env,
            replaceEnv: true,
            maxOutputBytes: Number.POSITIVE_INFINITY,
          }),
        );
      });
    },
  );
});
