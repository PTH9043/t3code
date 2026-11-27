// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  MUSE_CLOUD_COOKIES_FILENAME,
  MUSE_CLOUD_NO_UPDATE_CHECK_ENV,
  MUSE_CLOUD_SESSION_COOKIE,
  MUSE_CLOUD_STDIN_SEND_SCRIPT,
  MUSE_CLOUD_TOKENS_FILENAME,
  formatMuseNetscapeCookieJar,
  makeMuseCloudContinuationGroupKey,
  makeMuseCloudEnvironment,
  parseMuseCloudCookies,
  readMuseCloudAuthSummary,
  resolveMuseCloudConfigDir,
  resolveMuseCloudPythonPath,
  writeMuseCloudCookiesFile,
} from "./MuseCloudHome.ts";

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

describe("MuseCloudHome", () => {
  it("parses Netscape, Cookie header, JSON object/array, and bare hatch_sess tokens", () => {
    const netscape = [
      "# Netscape HTTP Cookie File",
      "#HttpOnly_.muse.ai\tTRUE\t/\tTRUE\t2147483647\thatch_sess\tsecret_netscape_token_123456",
      ".muse.ai\tTRUE\t/\tTRUE\t0\tother\tabc",
    ].join("\n");
    const parsedNetscape = parseMuseCloudCookies(netscape);
    expect(parsedNetscape).toHaveLength(2);
    expect(parsedNetscape[0]).toMatchObject({
      domain: ".muse.ai",
      name: MUSE_CLOUD_SESSION_COOKIE,
      value: "secret_netscape_token_123456",
      expires: 2147483647,
    });

    const header = parseMuseCloudCookies(
      "Cookie: foo=bar; hatch_sess=secret_header_token_abcdef1234; baz=1",
    );
    expect(header.find((c) => c.name === MUSE_CLOUD_SESSION_COOKIE)?.value).toBe(
      "secret_header_token_abcdef1234",
    );

    const jsonArray = parseMuseCloudCookies(
      JSON.stringify([
        { domain: ".google.com", name: "SID", value: "ignore_me" },
        {
          domain: ".muse.ai",
          name: "hatch_sess",
          value: "secret_json_array_token_9999",
          expires: 2147483600,
        },
      ]),
    );
    expect(jsonArray).toHaveLength(1);
    expect(jsonArray[0]?.value).toBe("secret_json_array_token_9999");

    const jsonObj = parseMuseCloudCookies(
      JSON.stringify({ hatch_sess: "secret_json_obj_token_8888" }),
    );
    expect(jsonObj[0]?.value).toBe("secret_json_obj_token_8888");

    const bare = parseMuseCloudCookies("bare_secret_token_abcdef1234567890");
    expect(bare).toHaveLength(1);
    expect(bare[0]?.name).toBe(MUSE_CLOUD_SESSION_COOKIE);
    expect(bare[0]?.value).toBe("bare_secret_token_abcdef1234567890");

    // Round-trip through Netscape formatter
    const formatted = formatMuseNetscapeCookieJar(jsonArray);
    const reparsed = parseMuseCloudCookies(formatted);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]?.value).toBe("secret_json_array_token_9999");
  });

  it("writes Netscape cookies.txt, clears stale tokens.json, and summarizes without leaking secrets", async () => {
    const configDir = makeTempDir("t3-muse-cloud-cfg-");
    const tokensPath = NodePath.join(configDir, MUSE_CLOUD_TOKENS_FILENAME);
    NodeFs.writeFileSync(tokensPath, JSON.stringify({ stale: true }));

    const emptySummary = await Effect.runPromise(
      readMuseCloudAuthSummary(configDir).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(emptySummary.exists).toBe(false);
    expect(emptySummary.authenticated).toBe(false);

    const cookiesPath = await Effect.runPromise(
      writeMuseCloudCookiesFile(configDir, [
        {
          domain: ".muse.ai",
          path: "/",
          secure: true,
          expires: 2_500_000_000,
          name: MUSE_CLOUD_SESSION_COOKIE,
          value: "super_secret_cloud_cookie_value_12345",
        },
      ]).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(cookiesPath).toBe(NodePath.join(configDir, MUSE_CLOUD_COOKIES_FILENAME));
    expect(NodeFs.existsSync(tokensPath)).toBe(false);

    const validSummary = await Effect.runPromise(
      readMuseCloudAuthSummary(configDir).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(validSummary.exists).toBe(true);
    expect(validSummary.authenticated).toBe(true);
    expect(validSummary.expired).toBe(false);
    expect(validSummary.cookieCount).toBe(1);
    expect(JSON.stringify(validSummary)).not.toContain("super_secret");

    // Expired cookie detection
    await Effect.runPromise(
      writeMuseCloudCookiesFile(configDir, [
        {
          domain: ".muse.ai",
          path: "/",
          secure: true,
          expires: 1_000_000,
          name: MUSE_CLOUD_SESSION_COOKIE,
          value: "expired_secret_cloud_cookie_value_12345",
        },
      ]).pipe(Effect.provide(NodeServices.layer)),
    );
    const expiredSummary = await Effect.runPromise(
      readMuseCloudAuthSummary(configDir).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(expiredSummary.exists).toBe(true);
    expect(expiredSummary.authenticated).toBe(false);
    expect(expiredSummary.expired).toBe(true);
  });

  it("isolates HOME/USERPROFILE and disables update check when homePath is configured", async () => {
    const home = makeTempDir("t3-muse-cloud-home-");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const env = yield* makeMuseCloudEnvironment({ homePath: home }, { PATH: "x" });
        const configDir = yield* resolveMuseCloudConfigDir({ homePath: home }, env);
        const groupKey = yield* makeMuseCloudContinuationGroupKey({ homePath: home }, env);
        return { env, configDir, groupKey };
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(result.env[MUSE_CLOUD_NO_UPDATE_CHECK_ENV]).toBe("1");
    expect(result.env.PYTHONIOENCODING).toBe("utf-8");
    expect(result.env.PYTHONUTF8).toBeUndefined();
    expect(result.env.HOME).toBe(home);
    expect(result.env.USERPROFILE).toBe(home);
    expect(result.configDir).toBe(NodePath.join(home, ".config", "muse-cli"));
    expect(result.groupKey).toBe(`muse:cloud:${NodePath.join(home, ".config", "muse-cli")}`);
  });

  it("skips uv python bridge for custom script paths and exposes valid stdin bridge script", () => {
    expect(resolveMuseCloudPythonPath("C:\\tmp\\fake-muse-cli.mjs")).toBeUndefined();
    expect(MUSE_CLOUD_STDIN_SEND_SCRIPT).toContain("sys.stdin.buffer.read()");
    expect(MUSE_CLOUD_STDIN_SEND_SCRIPT).toContain("cli.cmd_send");
  });
});
