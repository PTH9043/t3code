// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { type MuseSettings, TextGenerationError } from "@t3tools/contracts";

import {
  MUSE_CLOUD_STDIN_SEND_SCRIPT,
  resolveMuseCloudBinaryPath,
  resolveMuseCloudPythonPath,
} from "../provider/Drivers/MuseCloudHome.ts";
import { extractMuseCloudReplyText } from "../provider/Layers/MuseCloudAdapter.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const MUSE_CLOUD_TEXT_GEN_TIMEOUT_MS = 120_000;
const MAX_ARGV_TEXT_GEN_FALLBACK_CHARS = 16_000;
const isTextGenerationError = Schema.is(TextGenerationError);

function runMuseCloudPythonStdin(input: {
  readonly pythonPath: string;
  readonly prompt: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<
  { readonly code: number; readonly stdout: string; readonly stderr: string },
  Error
> {
  return Effect.callback((resume) => {
    const child = NodeChildProcess.spawn(
      input.pythonPath,
      ["-c", MUSE_CLOUD_STDIN_SEND_SCRIPT, "", "110"],
      {
        env: {
          ...input.environment,
          MUSE_NO_UPDATE_CHECK: "1",
          PYTHONIOENCODING: "utf-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      resume(Effect.fail(err));
    });
    child.on("close", (code) => {
      resume(Effect.succeed({ code: code ?? 1, stdout, stderr }));
    });
    child.stdin?.on("error", () => {
      // Ignore EPIPE.
    });
    child.stdin?.end(input.prompt, "utf8");
    return Effect.sync(() => {
      try {
        if (!child.killed && child.exitCode === null) {
          child.kill();
        }
      } catch {
        // Ignore.
      }
    });
  });
}

export const makeMuseCloudTextGeneration = Effect.fn("makeMuseCloudTextGeneration")(function* (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runCloudJson = <S extends Schema.Top>({
    operation,
    prompt,
    outputSchemaJson,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    prompt: string;
    outputSchemaJson: S;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const pythonPath = resolveMuseCloudPythonPath(museSettings.cloudBinaryPath);
      const outputOption = yield* (
        pythonPath
          ? runMuseCloudPythonStdin({ pythonPath, prompt, environment })
          : Effect.gen(function* () {
              const command = resolveMuseCloudBinaryPath(museSettings.cloudBinaryPath);
              const safePrompt =
                prompt.length > MAX_ARGV_TEXT_GEN_FALLBACK_CHARS
                  ? prompt.slice(0, MAX_ARGV_TEXT_GEN_FALLBACK_CHARS)
                  : prompt;
              const spawnCmd = yield* resolveSpawnCommand(
                command,
                ["send", safePrompt, "--wait", "110"],
                { env: environment },
              );
              return yield* spawnAndCollect(
                command,
                ChildProcess.make(spawnCmd.command, spawnCmd.args, {
                  env: {
                    ...environment,
                    PYTHONIOENCODING: "utf-8",
                  },
                  shell: spawnCmd.shell,
                }),
              ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
            })
      ).pipe(
        Effect.timeoutOption(MUSE_CLOUD_TEXT_GEN_TIMEOUT_MS),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "muse.ai cloud text generation process failed.",
              cause,
            }),
        ),
      );

      if (Option.isNone(outputOption)) {
        return yield* new TextGenerationError({
          operation,
          detail: "muse.ai cloud text generation timed out.",
        });
      }
      if (outputOption.value.code !== 0) {
        return yield* new TextGenerationError({
          operation,
          detail: `muse.ai cloud returned exit code ${outputOption.value.code}.`,
        });
      }

      const trimmed = extractMuseCloudReplyText(outputOption.value.stdout).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail: "muse.ai cloud returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "muse.ai cloud returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "muse.ai cloud text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("MuseCloudTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runCloudJson({
        operation: "generateCommitMessage",
        prompt,
        outputSchemaJson: outputSchema,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("MuseCloudTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runCloudJson({
        operation: "generatePrContent",
        prompt,
        outputSchemaJson: outputSchema,
      });
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("MuseCloudTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runCloudJson({
        operation: "generateBranchName",
        prompt,
        outputSchemaJson: outputSchema,
      });
      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("MuseCloudTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runCloudJson({
        operation: "generateThreadTitle",
        prompt,
        outputSchemaJson: outputSchema,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
