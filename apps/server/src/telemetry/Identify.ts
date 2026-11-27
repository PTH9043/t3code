import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const TelemetryIdentitySource = Schema.Literals(["codex", "claude", "anonymous"]);
export type TelemetryIdentitySource = typeof TelemetryIdentitySource.Type;

export class TelemetryIdentityReadError extends Schema.TaggedErrorClass<TelemetryIdentityReadError>()(
  "TelemetryIdentityReadError",
  {
    source: TelemetryIdentitySource,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.source} telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryIdentityDecodeError extends Schema.TaggedErrorClass<TelemetryIdentityDecodeError>()(
  "TelemetryIdentityDecodeError",
  {
    source: Schema.Literals(["codex", "claude"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.source} telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdGenerationError extends Schema.TaggedErrorClass<TelemetryAnonymousIdGenerationError>()(
  "TelemetryAnonymousIdGenerationError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate anonymous telemetry identity for '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdPersistenceError extends Schema.TaggedErrorClass<TelemetryAnonymousIdPersistenceError>()(
  "TelemetryAnonymousIdPersistenceError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist anonymous telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryIdentityHashError extends Schema.TaggedErrorClass<TelemetryIdentityHashError>()(
  "TelemetryIdentityHashError",
  {
    source: TelemetryIdentitySource,
    algorithm: Schema.Literal("SHA-256"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to hash ${this.source} telemetry identity with ${this.algorithm}.`;
  }
}

/**
 * Hard-disabled in this fork: never read third-party provider credential files
 * (such as Codex/Claude auth files), never hash account IDs, and never create
 * or persist an anonymous device identifier on disk.
 */
export const getTelemetryIdentifierForHome = (
  _homeDirectory: string,
): Effect.Effect<string | null> => Effect.succeed(null);

export const getTelemetryIdentifier: Effect.Effect<string | null> = Effect.succeed(null);
