// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  MUSE_LOGIN_ENV,
  MUSE_NO_AUTO_UPDATE_ENV,
  makeMuseEnvironment,
  readMuseAuthSummary,
  resolveMuseBinaryPath,
  resolveMuseConfigDir,
} from "./MuseHome.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("MuseHome", () => {
  it("resolves native muse-bin executable via .muse-version inside MUSE_INSTALL_DIR", () => {
    const installDir = makeTempDir("t3-muse-bin-");
    const ext = process.platform === "win32" ? ".exe" : "";
    const binPath = NodePath.join(installDir, `muse-bin-1.4.25-R9361.1${ext}`);
    NodeFs.writeFileSync(NodePath.join(installDir, ".muse-version"), "1.4.25-R9361.1\n");
    NodeFs.writeFileSync(binPath, "");

    const resolved = resolveMuseBinaryPath("muse", {
      MUSE_INSTALL_DIR: installDir,
    });
    expect(resolved).toBe(binPath);
  });

  it("isolates XDG directories and disables auto-update/auto-login when homePath is set", async () => {
    const home = makeTempDir("t3-muse-home-");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const env = yield* makeMuseEnvironment({ homePath: home }, { PATH: "x" });
        const configDir = yield* resolveMuseConfigDir({ homePath: home }, env);
        return { env, configDir };
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.env[MUSE_NO_AUTO_UPDATE_ENV]).toBe("1");
    expect(result.env[MUSE_LOGIN_ENV]).toBe("0");
    expect(result.env.XDG_CONFIG_HOME).toBe(NodePath.join(home, "config"));
    expect(result.env.XDG_DATA_HOME).toBe(NodePath.join(home, "data"));
    expect(result.env.XDG_STATE_HOME).toBe(NodePath.join(home, "state"));
    expect(result.configDir).toBe(NodePath.join(home, "config", "muse"));
  });

  it("summarizes Meta OAuth credentials from auth.json without leaking tokens", async () => {
    const configDir = makeTempDir("t3-muse-auth-");
    NodeFs.writeFileSync(
      NodePath.join(configDir, "auth.json"),
      JSON.stringify({
        providers: {
          meta: {
            mechanism: "oauth",
            access_token: "super-secret-access-token",
            refresh_token: "super-secret-refresh-token",
            expires_at_ms: 1_900_000_000_000,
            user_email: "dev@example.com",
            user_full_name: "Muse Tester",
          },
        },
      }),
    );

    const summary = await Effect.runPromise(
      readMuseAuthSummary(configDir).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(summary.exists).toBe(true);
    expect(summary.authenticated).toBe(true);
    expect(summary.expired).toBe(false);
    expect(summary.hasRefreshToken).toBe(true);
    expect(summary.mechanism).toBe("oauth");
    expect(summary.email).toBe("dev@example.com");
    expect(summary.fullName).toBe("Muse Tester");
    expect(JSON.stringify(summary)).not.toContain("super-secret");
  });

  it("returns unauthenticated when auth.json is missing", async () => {
    const configDir = makeTempDir("t3-muse-empty-");
    const summary = await Effect.runPromise(
      readMuseAuthSummary(configDir).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(summary.exists).toBe(false);
    expect(summary.authenticated).toBe(false);
  });
});
