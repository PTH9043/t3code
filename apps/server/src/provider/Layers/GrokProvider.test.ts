import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import { buildInitialGrokProviderSnapshot, checkGrokProviderStatus } from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const writeFakeGrokCli = (
  dir: string,
  options: { readonly stdout?: string; readonly stderr?: string; readonly exitCode: number },
) => {
  const stdoutLiteral = encodeJsonString(options.stdout ?? "");
  const stderrLiteral = encodeJsonString(options.stderr ?? "");
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scriptPath = path.join(dir, "grok-mock.mjs");
    yield* fs.writeFileString(
      scriptPath,
      [
        `const out = ${stdoutLiteral};`,
        `const err = ${stderrLiteral};`,
        `if (out) process.stdout.write(out);`,
        `if (err) process.stderr.write(err);`,
        `process.exit(${options.exitCode});`,
      ].join("\n"),
    );

    if (process.platform === "win32") {
      const cmdPath = path.join(dir, "grok.cmd");
      yield* fs.writeFileString(
        cmdPath,
        `@echo off\r\n"${process.execPath}" "%~dp0grok-mock.mjs" %*\r\n`,
      );
      return cmdPath;
    }

    const binPath = path.join(dir, "grok");
    yield* fs.writeFileString(
      binPath,
      ["#!/bin/sh", `exec "${process.execPath}" "${scriptPath}" "$@"`, ""].join("\n"),
    );
    yield* fs.chmod(binPath, 0o755);
    return binPath;
  });
};

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = yield* writeFakeGrokCli(dir, {
            stderr: `${secretStderr}\n`,
            exitCode: 2,
          });

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect(
    "reports unauthenticated warning immediately when GROK_HOME has no auth.json or API key",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-unauth-" });
            const grokHome = path.join(dir, "empty-home");
            yield* fs.makeDirectory(grokHome, { recursive: true });
            const grokPath = yield* writeFakeGrokCli(dir, {
              stdout: "grok 1.0.46\n",
              exitCode: 0,
            });

            return yield* checkGrokProviderStatus(
              decodeGrokSettings({ enabled: true, binaryPath: grokPath, homePath: grokHome }),
              { PATH: process.env.PATH },
            );
          }),
        );

        expect(snapshot.status).toBe("warning");
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("1.0.46");
        expect(snapshot.auth).toEqual({ status: "unauthenticated" });
        expect(snapshot.message).toContain("Grok 로그인");
      }),
  );

  it.effect("reports OAuth email metadata and ACP failure when authenticated via auth.json", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-oauth-" });
          const grokHome = path.join(dir, "oauth-home");
          yield* fs.makeDirectory(grokHome, { recursive: true });
          yield* fs.writeFileString(
            path.join(grokHome, "auth.json"),
            `{"https://auth.x.ai::u1":{"key":"tok","refresh_token":"ref","auth_mode":"oidc","email":"grok.user@example.com","expires_at":"2099-01-01T00:00:00Z"}}`,
          );
          const grokPath = yield* writeFakeGrokCli(dir, {
            stdout: "grok-cli 0.0.99\n",
            exitCode: 0,
          });

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath, homePath: grokHome }),
            { PATH: process.env.PATH },
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "oauth",
        label: "Grok OAuth",
        email: "grok.user@example.com",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );

  it.effect("reports xAI API key authentication when XAI_API_KEY is present", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-apikey-" });
          const grokHome = path.join(dir, "empty-home");
          yield* fs.makeDirectory(grokHome, { recursive: true });
          const grokPath = yield* writeFakeGrokCli(dir, {
            stdout: "grok 1.0.46\n",
            exitCode: 0,
          });

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath, homePath: grokHome }),
            { PATH: process.env.PATH, XAI_API_KEY: "xai-test-key" },
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "apiKey",
        label: "xAI API 키",
      });
    }),
  );
});
