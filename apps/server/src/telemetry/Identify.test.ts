import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";

import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

it("preserves exact telemetry identity causes without deriving messages from them", () => {
  const decodeCause = new Error("private nested decode details");
  const decodeError = new Identify.TelemetryIdentityDecodeError({
    source: "codex",
    filePath: "/tmp/auth.json",
    cause: decodeCause,
  });
  const readCause = new Error("private nested read details");
  const readError = new Identify.TelemetryIdentityReadError({
    source: "anonymous",
    filePath: "/tmp/anonymous-id",
    cause: readCause,
  });

  assert.strictEqual(decodeError.cause, decodeCause);
  assert.strictEqual(readError.cause, readCause);
  assert.notInclude(decodeError.message, decodeCause.message);
  assert.notInclude(readError.message, readCause.message);
});

it.layer(NodeServices.layer)("telemetry identity (hard-disabled)", (it) => {
  it.effect(
    "never reads Codex/Claude credential files, never hashes account IDs, and never creates anonymous-id",
    () => {
      const logs: CapturedLog[] = [];
      const logger = makeCaptureLogger(logs);

      return Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDirectory = path.join(config.baseDir, "home");
        const codexAuthPath = path.join(homeDirectory, ".codex", "auth.json");
        const claudeJsonPath = path.join(homeDirectory, ".claude.json");

        yield* fileSystem.makeDirectory(path.dirname(codexAuthPath), { recursive: true });
        yield* fileSystem.writeFileString(
          codexAuthPath,
          '{"tokens":{"account_id":"acct_secret_codex_123"}}',
        );
        yield* fileSystem.writeFileString(claudeJsonPath, '{"userID":"claude_secret_user_456"}');

        const identifierForHome = yield* Identify.getTelemetryIdentifierForHome(homeDirectory);
        const identifierDefault = yield* Identify.getTelemetryIdentifier;

        assert.isNull(identifierForHome);
        assert.isNull(identifierDefault);
        assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
        assert.equal(logs.length, 0);
      }).pipe(
        Effect.provide(
          Layer.merge(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-telemetry-identify-blocked-",
            }),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );
    },
  );

  it.effect("ignores persisted anonymous-id and malformed auth files with zero I/O or logs", () => {
    const logs: CapturedLog[] = [];
    const logger = makeCaptureLogger(logs);

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");
      const codexAuthPath = path.join(homeDirectory, ".codex", "auth.json");

      yield* fileSystem.makeDirectory(path.dirname(codexAuthPath), { recursive: true });
      yield* fileSystem.writeFileString(codexAuthPath, "{invalid-json");
      yield* fileSystem.writeFileString(config.anonymousIdPath, "persisted-anonymous-id");

      const identifier = yield* Identify.getTelemetryIdentifierForHome(homeDirectory);

      assert.isNull(identifier);
      assert.equal(logs.length, 0);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-telemetry-identify-noop-",
          }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });
});
