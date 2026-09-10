// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { GeminiSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  decodeGeminiFileKeychainOAuthCredentials,
  ensureGeminiOAuthSettings,
  hasGeminiAccessAndRefreshTokens,
  makeGeminiContinuationGroupKey,
  makeGeminiEnvironment,
  readGeminiAccountEmail,
  readGeminiAuthState,
  resolveGeminiHomePath,
} from "./GeminiHome.ts";

const decodeGeminiSettings = Schema.decodeSync(GeminiSettings);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const instanceId = ProviderInstanceId.make("gemini-work");

function encryptGeminiFileKeychain(input: {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly service?: string;
  readonly account?: string;
}): string {
  const service = input.service ?? "gemini-cli-oauth";
  const account = input.account ?? "main-account";
  const storedCredentials = JSON.stringify({
    serverName: "main-account",
    token: {
      accessToken: input.accessToken,
      ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
      tokenType: "Bearer",
    },
    updatedAt: 1_700_000_000_000,
  });
  const plaintext = JSON.stringify({ [service]: { [account]: storedCredentials } });
  const encryptionKey = NodeCrypto.scryptSync(
    "gemini-cli-oauth",
    `${NodeOS.hostname()}-${NodeOS.userInfo().username}-gemini-cli`,
    32,
  );
  const iv = Buffer.from("000102030405060708090a0b", "hex");
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", encryptionKey, iv, {
    authTagLength: 16,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

describe("GeminiHome", () => {
  it("uses an instance-owned home by default", () => {
    const stateDir = NodePath.resolve("state");
    const input = {
      settings: decodeGeminiSettings({}),
      instanceId,
      stateDir,
    };
    const expected = NodePath.join(stateDir, "provider-instances", instanceId, "gemini-home");

    expect(resolveGeminiHomePath(input)).toBe(expected);
    expect(makeGeminiContinuationGroupKey(input)).toBe(`gemini:home:${expected}`);
  });

  it("uses a configured home and removes ambient non-OAuth credentials", () => {
    const homePath = NodePath.resolve("custom-gemini-home");
    const settings = decodeGeminiSettings({
      homePath,
      googleCloudProject: "configured-project",
    });
    const environment = makeGeminiEnvironment({
      settings,
      instanceId,
      stateDir: NodePath.resolve("state"),
      baseEnv: {
        KEEP_ME: "yes",
        HOME: "/ambient/home",
        USERPROFILE: "C:\\ambient-home",
        GEMINI_CLI_HOME: "/ambient/gemini",
        GEMINI_API_KEY: "gemini-secret",
        GOOGLE_API_KEY: "google-secret",
        GOOGLE_APPLICATION_CREDENTIALS: "/ambient/application-credentials.json",
        GOOGLE_CLOUD_ACCESS_TOKEN: "ambient-access-token",
        GOOGLE_CLOUD_PROJECT: "ambient-project",
        GOOGLE_CLOUD_PROJECT_ID: "ambient-project-id",
        GOOGLE_CLOUD_QUOTA_PROJECT: "ambient-quota-project",
        GOOGLE_GENAI_USE_GCA: "true",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GEMINI_CLI_USE_COMPUTE_ADC: "true",
        GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: "ambient-encrypted-storage",
        GEMINI_FORCE_FILE_STORAGE: "ambient-file-storage",
      },
    });

    expect(environment).toMatchObject({
      KEEP_ME: "yes",
      HOME: "/ambient/home",
      USERPROFILE: "C:\\ambient-home",
      GEMINI_CLI_HOME: homePath,
      GOOGLE_CLOUD_PROJECT: "configured-project",
      NO_BROWSER: "true",
      GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: "true",
      GEMINI_FORCE_FILE_STORAGE: "true",
    });
    expect(environment.GEMINI_API_KEY).toBeUndefined();
    expect(environment.GOOGLE_API_KEY).toBeUndefined();
    expect(environment.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(environment.GOOGLE_CLOUD_ACCESS_TOKEN).toBeUndefined();
    expect(environment.GOOGLE_CLOUD_PROJECT_ID).toBeUndefined();
    expect(environment.GOOGLE_CLOUD_QUOTA_PROJECT).toBeUndefined();
    expect(environment.GOOGLE_GENAI_USE_GCA).toBeUndefined();
    expect(environment.GOOGLE_GENAI_USE_VERTEXAI).toBeUndefined();
    expect(environment.GEMINI_CLI_USE_COMPUTE_ADC).toBeUndefined();
  });

  it("does not retain an ambient Cloud project when none is configured", () => {
    const environment = makeGeminiEnvironment({
      settings: decodeGeminiSettings({}),
      instanceId,
      stateDir: NodePath.resolve("state"),
      baseEnv: { GOOGLE_CLOUD_PROJECT: "ambient-project" },
    });

    expect(environment.GOOGLE_CLOUD_PROJECT).toBeUndefined();
  });

  it("safely decodes and validates Gemini CLI FileKeychain OAuth credentials", () => {
    const encrypted = encryptGeminiFileKeychain({
      accessToken: "file-access-token",
      refreshToken: "file-refresh-token",
    });
    const credentials = Option.getOrThrow(decodeGeminiFileKeychainOAuthCredentials(encrypted));

    expect(credentials).toEqual({
      accessToken: "file-access-token",
      refreshToken: "file-refresh-token",
    });
    expect(hasGeminiAccessAndRefreshTokens(credentials)).toBe(true);
    expect(
      hasGeminiAccessAndRefreshTokens(
        Option.getOrThrow(
          decodeGeminiFileKeychainOAuthCredentials(
            encryptGeminiFileKeychain({ accessToken: "access-only" }),
          ),
        ),
      ),
    ).toBe(false);

    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("0") ? "1" : "0"}`;
    expect(Option.isNone(decodeGeminiFileKeychainOAuthCredentials(tampered))).toBe(true);
    expect(
      Option.isNone(
        decodeGeminiFileKeychainOAuthCredentials(
          encryptGeminiFileKeychain({
            accessToken: "wrong-service-token",
            service: "another-service",
          }),
        ),
      ),
    ).toBe(true);
  });
});

it.layer(NodeServices.layer)("Gemini OAuth home files", (it) => {
  it.effect("merges oauth-personal into settings without replacing unrelated settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-gemini-home-",
        });
        const settingsPath = NodePath.join(homePath, ".gemini", "settings.json");
        yield* fileSystem.makeDirectory(NodePath.dirname(settingsPath), { recursive: true });
        yield* fileSystem.writeFileString(
          settingsPath,
          '{"ui":{"theme":"Dracula"},"security":{"auth":{"enforcedType":"oauth-personal"}}}',
        );

        yield* ensureGeminiOAuthSettings({ homePath });

        expect(decodeJson(yield* fileSystem.readFileString(settingsPath))).toEqual({
          ui: { theme: "Dracula" },
          security: {
            auth: {
              enforcedType: "oauth-personal",
              selectedType: "oauth-personal",
            },
          },
        });
      }),
    ),
  );

  it.effect("does not treat Google account metadata alone as authenticated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-gemini-account-",
        });
        const dataDirectory = NodePath.join(homePath, ".gemini");
        yield* fileSystem.makeDirectory(dataDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          NodePath.join(dataDirectory, "google_accounts.json"),
          '{"active":"person@example.test","old":[]}',
        );

        expect(yield* readGeminiAuthState({ homePath })).toEqual({
          authenticated: false,
          hasAccessToken: false,
          hasRefreshToken: false,
        });
        expect(yield* readGeminiAccountEmail({ homePath })).toBeUndefined();

        yield* fileSystem.writeFileString(
          NodePath.join(dataDirectory, "oauth_creds.json"),
          '{"refresh_token":"valid-refresh-token"}',
        );
        expect(yield* readGeminiAuthState({ homePath })).toEqual({
          authenticated: true,
          hasAccessToken: false,
          hasRefreshToken: true,
          email: "person@example.test",
        });
      }),
    ),
  );

  it.effect("recognizes instance-local encrypted FileKeychain credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-gemini-file-keychain-",
        });
        const dataDirectory = NodePath.join(homePath, ".gemini");
        yield* fileSystem.makeDirectory(dataDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          NodePath.join(dataDirectory, "gemini-credentials.json"),
          encryptGeminiFileKeychain({
            accessToken: "encrypted-access-token",
            refreshToken: "encrypted-refresh-token",
          }),
        );
        yield* fileSystem.writeFileString(
          NodePath.join(dataDirectory, "google_accounts.json"),
          '{"active":"encrypted@example.test"}',
        );

        expect(yield* readGeminiAuthState({ homePath })).toEqual({
          authenticated: true,
          hasAccessToken: true,
          hasRefreshToken: true,
          email: "encrypted@example.test",
        });
      }),
    ),
  );

  it.effect("ignores a tampered encrypted credential file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-gemini-corrupt-keychain-",
        });
        const dataDirectory = NodePath.join(homePath, ".gemini");
        yield* fileSystem.makeDirectory(dataDirectory, { recursive: true });
        const encrypted = encryptGeminiFileKeychain({
          accessToken: "encrypted-access-token",
          refreshToken: "encrypted-refresh-token",
        });
        const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("0") ? "1" : "0"}`;
        yield* fileSystem.writeFileString(
          NodePath.join(dataDirectory, "gemini-credentials.json"),
          tampered,
        );

        expect(yield* readGeminiAuthState({ homePath })).toEqual({
          authenticated: false,
          hasAccessToken: false,
          hasRefreshToken: false,
        });
      }),
    ),
  );

  it.effect("falls back to the OAuth id_token email claim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-gemini-token-",
        });
        const dataDirectory = NodePath.join(homePath, ".gemini");
        yield* fileSystem.makeDirectory(dataDirectory, { recursive: true });
        const payload = Buffer.from('{"email":"token@example.test"}').toString("base64url");
        yield* fileSystem.writeFileString(
          NodePath.join(dataDirectory, "oauth_creds.json"),
          `{"access_token":"valid-access-token","id_token":"header.${payload}.signature"}`,
        );

        expect(yield* readGeminiAccountEmail({ homePath })).toBe("token@example.test");
      }),
    ),
  );
});
