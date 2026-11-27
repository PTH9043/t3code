import * as Schema from "effect/Schema";

export const MIN_COMPLETION_MAX_AUTO_FIX_ATTEMPTS = 1;
export const MAX_COMPLETION_MAX_AUTO_FIX_ATTEMPTS = 5;
export const DEFAULT_COMPLETION_MAX_AUTO_FIX_ATTEMPTS = 3;

export const MIN_COMPLETION_COMMAND_TIMEOUT_SECONDS = 10;
export const MAX_COMPLETION_COMMAND_TIMEOUT_SECONDS = 1800;
export const DEFAULT_COMPLETION_COMMAND_TIMEOUT_SECONDS = 120;

export const CompletionMaxAutoFixAttempts = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
    maximum: MAX_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
  }),
);
export type CompletionMaxAutoFixAttempts = typeof CompletionMaxAutoFixAttempts.Type;

export const CompletionCommandTimeoutSeconds = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_COMPLETION_COMMAND_TIMEOUT_SECONDS,
    maximum: MAX_COMPLETION_COMMAND_TIMEOUT_SECONDS,
  }),
);
export type CompletionCommandTimeoutSeconds = typeof CompletionCommandTimeoutSeconds.Type;

const Commands = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
).check(Schema.isMaxLength(6));

export const WorkspaceCompletionAutomation = Schema.Struct({
  enabled: Schema.Boolean,
  formatCommands: Commands,
  verificationCommands: Commands,
  saveResult: Schema.Boolean,
  followUpTask: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8000))),
  maxAutoFixAttempts: Schema.optionalKey(CompletionMaxAutoFixAttempts),
  commandTimeoutSeconds: Schema.optionalKey(CompletionCommandTimeoutSeconds),
});
export type WorkspaceCompletionAutomation = typeof WorkspaceCompletionAutomation.Type;

export interface ResolvedCompletionAutomationLimits {
  readonly maxAutoFixAttempts: number;
  readonly commandTimeoutSeconds: number;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Resolves persisted completion automation limits with 100% backward-compatible
 * defaults for legacy database records that omit the newer optional fields.
 */
export function resolveCompletionAutomationLimits(
  config?: Pick<
    WorkspaceCompletionAutomation,
    "maxAutoFixAttempts" | "commandTimeoutSeconds"
  > | null,
): ResolvedCompletionAutomationLimits {
  return {
    maxAutoFixAttempts: clampInteger(
      config?.maxAutoFixAttempts,
      MIN_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
      MAX_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
      DEFAULT_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
    ),
    commandTimeoutSeconds: clampInteger(
      config?.commandTimeoutSeconds,
      MIN_COMPLETION_COMMAND_TIMEOUT_SECONDS,
      MAX_COMPLETION_COMMAND_TIMEOUT_SECONDS,
      DEFAULT_COMPLETION_COMMAND_TIMEOUT_SECONDS,
    ),
  };
}

export const DEFAULT_COMPLETION_AUTOMATION: WorkspaceCompletionAutomation = {
  enabled: false,
  formatCommands: [],
  verificationCommands: [],
  saveResult: true,
  followUpTask: null,
  maxAutoFixAttempts: DEFAULT_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
  commandTimeoutSeconds: DEFAULT_COMPLETION_COMMAND_TIMEOUT_SECONDS,
};

export const WorkspaceAutomationCheck = Schema.Struct({
  phase: Schema.Literals(["format", "verification"]),
  command: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  passed: Schema.Boolean,
  output: Schema.String,
  startedAt: Schema.String,
  completedAt: Schema.String,
});
export type WorkspaceAutomationCheck = typeof WorkspaceAutomationCheck.Type;
