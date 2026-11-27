// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { GrokSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  GROK_API_KEY_ENV,
  GROK_HOME_ENV,
  makeGrokContinuationGroupKey,
  makeGrokEnvironment,
  normalizeGrokEmail,
  readGrokAuthSummary,
  resolveGrokHomePath,
} from "./GrokHome.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

describe("GrokHome", () => {
  it.live("resolves homePath with priority config.homePath > env.GROK_HOME > ~/.grok", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fromConfig = yield* resolveGrokHomePath(
        decodeGrokSettings({ homePath: "/tmp/grok-config-home" }),
        { [GROK_HOME_ENV]: "/tmp/grok-env-home" },
      );
      expect(fromConfig).toBe(path.resolve("/tmp/grok-config-home"));

      const fromEnv = yield* resolveGrokHomePath(decodeGrokSettings({}), {
        [GROK_HOME_ENV]: "/tmp/grok-env-home",
      });
      expect(fromEnv).toBe(path.resolve("/tmp/grok-env-home"));

      const fromDefault = yield* resolveGrokHomePath(decodeGrokSettings({}), {});
      expect(fromDefault).toBe(path.resolve(path.join(NodeOS.homedir(), ".grok")));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("injects GROK_HOME only when homePath is configured and isolates continuation keys", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      const unchanged = yield* makeGrokEnvironment(decodeGrokSettings({}), baseEnv);
      expect(unchanged).toBe(baseEnv);

      const isolated = yield* makeGrokEnvironment(
        decodeGrokSettings({ homePath: "/tmp/grok-work" }),
        baseEnv,
      );
      expect(isolated[GROK_HOME_ENV]).toBe(path.resolve("/tmp/grok-work"));

      const keyA = yield* makeGrokContinuationGroupKey(
        decodeGrokSettings({ homePath: "/tmp/grok-a" }),
        {},
      );
      const keyB = yield* makeGrokContinuationGroupKey(
        decodeGrokSettings({ homePath: "/tmp/grok-b" }),
        {},
      );
      const keyApi = yield* makeGrokContinuationGroupKey(
        decodeGrokSettings({ homePath: "/tmp/grok-a" }),
        { [GROK_API_KEY_ENV]: "xai-test-key" },
      );
      expect(keyA).not.toBe(keyB);
      expect(keyA).not.toBe(keyApi);
      expect(keyApi).toContain(":apikey:");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads Grok auth.json metadata without leaking tokens and handles expiry states", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-home-" });

        const missing = yield* readGrokAuthSummary(path.join(root, "missing"));
        expect(missing.exists).toBe(false);
        expect(missing.authenticated).toBe(false);

        const validDir = path.join(root, "valid");
        yield* fs.makeDirectory(validDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(validDir, "auth.json"),
          `{
            "https://auth.x.ai::user-1": {
              "key": "secret-access-token",
              "refresh_token": "secret-refresh-token",
              "auth_mode": "oidc",
              "email": "Alpha@Example.com",
              "first_name": "Alpha",
              "user_id": "uid-alpha",
              "team_id": "tid-1",
              "expires_at": "2099-11-25T02:08:58.400420900Z"
            }
          }`,
        );
        const valid = yield* readGrokAuthSummary(validDir);
        expect(valid.exists).toBe(true);
        expect(valid.authenticated).toBe(true);
        expect(valid.expired).toBe(false);
        expect(valid.hasRefreshToken).toBe(true);
        expect(valid.email).toBe("Alpha@Example.com");
        expect(valid.userId).toBe("uid-alpha");
        expect(normalizeGrokEmail(valid.email)).toBe("alpha@example.com");
        expect(Object.values(valid).join(" ")).not.toContain("secret-access-token");
        expect(Object.values(valid).join(" ")).not.toContain("secret-refresh-token");

        // Expired token WITH refresh_token stays authenticated (CLI refreshes automatically).
        const refreshableDir = path.join(root, "refreshable");
        yield* fs.makeDirectory(refreshableDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(refreshableDir, "auth.json"),
          `{
            "https://auth.x.ai::user-2": {
              "key": "expired-token",
              "refresh_token": "still-refreshable",
              "email": "beta@example.com",
              "expires_at": "2020-01-01T00:00:00.000000000Z"
            }
          }`,
        );
        const refreshable = yield* readGrokAuthSummary(refreshableDir);
        expect(refreshable.authenticated).toBe(true);
        expect(refreshable.expired).toBe(true);
        expect(refreshable.hasRefreshToken).toBe(true);

        // Expired token WITHOUT refresh_token is unauthenticated.
        const expiredDir = path.join(root, "expired");
        yield* fs.makeDirectory(expiredDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(expiredDir, "auth.json"),
          `{
            "https://auth.x.ai::user-3": {
              "key": "expired-token",
              "email": "gamma@example.com",
              "expires_at": "2020-01-01T00:00:00Z"
            }
          }`,
        );
        const expired = yield* readGrokAuthSummary(expiredDir);
        expect(expired.exists).toBe(true);
        expect(expired.authenticated).toBe(false);
        expect(expired.expired).toBe(true);
        expect(expired.email).toBe("gamma@example.com");

        // Corrupt JSON fails safely as unauthenticated.
        const corruptDir = path.join(root, "corrupt");
        yield* fs.makeDirectory(corruptDir, { recursive: true });
        yield* fs.writeFileString(path.join(corruptDir, "auth.json"), "{not-valid-json");
        const corrupt = yield* readGrokAuthSummary(corruptDir);
        expect(corrupt.exists).toBe(true);
        expect(corrupt.authenticated).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
