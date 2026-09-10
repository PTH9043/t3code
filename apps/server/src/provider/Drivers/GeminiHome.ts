// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { GeminiSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { expandHomePath } from "../../pathExpansion.ts";

const AMBIENT_GOOGLE_CREDENTIAL_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GEMINI_CLI_USE_COMPUTE_ADC",
  "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
  "GEMINI_FORCE_FILE_STORAGE",
] as const;

const GEMINI_OAUTH_KEYCHAIN_SERVICE = "gemini-cli-oauth";
const GEMINI_OAUTH_KEYCHAIN_ACCOUNT = "main-account";
let geminiFileKeychainEncryptionKey: Buffer | undefined;

function getGeminiFileKeychainEncryptionKey(): Buffer {
  return (geminiFileKeychainEncryptionKey ??= NodeCrypto.scryptSync(
    GEMINI_OAUTH_KEYCHAIN_SERVICE,
    `${NodeOS.hostname()}-${NodeOS.userInfo().username}-gemini-cli`,
    32,
  ));
}

function deleteEnvironmentKey(environment: NodeJS.ProcessEnv, key: string): void {
  for (const existingKey of Object.keys(environment)) {
    if (existingKey.toUpperCase() === key) delete environment[existingKey];
  }
}

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonObject = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject));
const decodeNestedJsonObject = Schema.decodeUnknownOption(JsonObject);
const encodeJsonObject = Schema.encodeEffect(Schema.fromJsonString(JsonObject));

const GeminiGoogleAccounts = Schema.Struct({
  active: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeGeminiGoogleAccounts = Schema.decodeUnknownOption(
  Schema.fromJsonString(GeminiGoogleAccounts),
);

const GeminiOAuthCredentials = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
});
const decodeGeminiOAuthCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(GeminiOAuthCredentials),
);

const GeminiFileKeychainOAuthCredentials = Schema.Struct({
  serverName: Schema.Literal(GEMINI_OAUTH_KEYCHAIN_ACCOUNT),
  token: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Schema.Number),
    tokenType: Schema.String,
    scope: Schema.optional(Schema.String),
  }),
  clientId: Schema.optional(Schema.String),
  tokenUrl: Schema.optional(Schema.String),
  mcpServerUrl: Schema.optional(Schema.String),
  updatedAt: Schema.Number,
});
const decodeGeminiFileKeychainOAuthCredentialsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(GeminiFileKeychainOAuthCredentials),
);

const GeminiFileKeychainData = Schema.Struct({
  [GEMINI_OAUTH_KEYCHAIN_SERVICE]: Schema.Struct({
    [GEMINI_OAUTH_KEYCHAIN_ACCOUNT]: Schema.String,
  }),
});
const decodeGeminiFileKeychainData = Schema.decodeUnknownOption(
  Schema.fromJsonString(GeminiFileKeychainData),
);

const GeminiIdTokenClaims = Schema.Struct({
  email: Schema.optional(Schema.String),
});
const decodeGeminiIdTokenClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(GeminiIdTokenClaims),
);

export interface GeminiHomeInput {
  readonly settings: Pick<GeminiSettings, "homePath">;
  readonly instanceId: ProviderInstanceId;
  readonly stateDir: string;
}

/**
 * Resolve the state root for one provider instance. Gemini CLI's `homedir()`
 * wrapper honors `GEMINI_CLI_HOME` and stores files below `<home>/.gemini`.
 */
export function resolveGeminiHomePath(input: GeminiHomeInput): string {
  const configuredHome = input.settings.homePath.trim();
  return NodePath.resolve(
    configuredHome.length > 0
      ? expandHomePath(configuredHome)
      : NodePath.join(input.stateDir, "provider-instances", input.instanceId, "gemini-home"),
  );
}

export interface GeminiEnvironmentInput extends GeminiHomeInput {
  readonly settings: Pick<GeminiSettings, "homePath" | "googleCloudProject">;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Build the process environment used by Gemini CLI for one provider instance.
 *
 * OAuth must remain authoritative for this driver. Ambient API-key and Cloud
 * project variables would otherwise silently select a different Gemini auth
 * mode, so they are stripped before the instance-owned values are applied.
 */
export function makeGeminiEnvironment(input: GeminiEnvironmentInput): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...(input.baseEnv ?? process.env) };
  for (const key of AMBIENT_GOOGLE_CREDENTIAL_KEYS) {
    deleteEnvironmentKey(environment, key);
  }
  deleteEnvironmentKey(environment, "GEMINI_CLI_HOME");
  environment.GEMINI_CLI_HOME = resolveGeminiHomePath(input);
  // Authentication is initiated explicitly through T3's remote-safe URL/code
  // flow. Runtime ACP processes must never open a loopback browser on the
  // server when credentials are missing or expired.
  environment.NO_BROWSER = "true";
  // Gemini's OAuth storage otherwise prefers the machine-wide OS keychain.
  // Force the encrypted fallback so each GEMINI_CLI_HOME owns its credentials.
  environment.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE = "true";
  environment.GEMINI_FORCE_FILE_STORAGE = "true";

  const googleCloudProject = input.settings.googleCloudProject.trim();
  if (googleCloudProject.length > 0) {
    environment.GOOGLE_CLOUD_PROJECT = googleCloudProject;
  }
  return environment;
}

export function makeGeminiContinuationGroupKey(input: GeminiHomeInput): string {
  return `gemini:home:${resolveGeminiHomePath(input)}`;
}

function geminiDataDirectory(homePath: string): string {
  return NodePath.join(homePath, ".gemini");
}

export interface GeminiOAuthTokenState {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
}

function isEvenLengthHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

const decryptGeminiFileKeychain = Option.liftThrowable((encryptedContents: string): string => {
  const parts = encryptedContents.trim().split(":");
  if (parts.length !== 3) throw new Error("Invalid Gemini FileKeychain format");
  const [ivHex, authTagHex, ciphertextHex] = parts;
  if (
    ivHex === undefined ||
    authTagHex === undefined ||
    ciphertextHex === undefined ||
    !isEvenLengthHex(ivHex) ||
    !isEvenLengthHex(authTagHex) ||
    !isEvenLengthHex(ciphertextHex)
  ) {
    throw new Error("Invalid Gemini FileKeychain encoding");
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  if ((iv.length !== 12 && iv.length !== 16) || authTag.length !== 16) {
    throw new Error("Invalid Gemini FileKeychain nonce or authentication tag");
  }

  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    getGeminiFileKeychainEncryptionKey(),
    iv,
    {
      authTagLength: 16,
    },
  );
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertextHex, "hex", "utf8") + decipher.final("utf8");
});

/**
 * Decode Gemini CLI's encrypted FileKeychain entry for its primary Google
 * OAuth account. Invalid, truncated, foreign-machine, or tampered files return
 * `None` instead of throwing.
 */
export function decodeGeminiFileKeychainOAuthCredentials(
  encryptedContents: string,
): Option.Option<GeminiOAuthTokenState> {
  return Option.flatMap(decryptGeminiFileKeychain(encryptedContents), (decryptedContents) =>
    Option.flatMap(decodeGeminiFileKeychainData(decryptedContents), (keychain) =>
      Option.map(
        decodeGeminiFileKeychainOAuthCredentialsJson(
          keychain[GEMINI_OAUTH_KEYCHAIN_SERVICE][GEMINI_OAUTH_KEYCHAIN_ACCOUNT],
        ),
        (credentials) => ({
          accessToken: credentials.token.accessToken,
          ...(credentials.token.refreshToken
            ? { refreshToken: credentials.token.refreshToken }
            : {}),
        }),
      ),
    ),
  );
}

export function hasGeminiAccessAndRefreshTokens(credentials: GeminiOAuthTokenState): boolean {
  return (
    hasNonEmptyGeminiToken(credentials.accessToken) &&
    hasNonEmptyGeminiToken(credentials.refreshToken)
  );
}

function hasNonEmptyGeminiToken(token: string | undefined): token is string {
  return token !== undefined && token.trim().length > 0;
}

/**
 * Persist Gemini CLI's Google-login auth selection without replacing unrelated
 * user settings. The CLI still owns the OAuth token exchange and credential
 * files; this only pins the selected auth method to `oauth-personal`.
 */
export const ensureGeminiOAuthSettings = Effect.fn("ensureGeminiOAuthSettings")(function* (input: {
  readonly homePath: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const settingsPath = NodePath.join(geminiDataDirectory(input.homePath), "settings.json");
  const rawSettings = yield* fileSystem
    .readFileString(settingsPath)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      ),
    );
  const settings = yield* decodeJsonObject(rawSettings);
  const security: Record<string, unknown> = Option.getOrElse(
    decodeNestedJsonObject(settings.security),
    () => ({}),
  );
  const auth: Record<string, unknown> = Option.getOrElse(
    decodeNestedJsonObject(security.auth),
    () => ({}),
  );
  if (auth.selectedType === "oauth-personal") return;
  const nextSettings = {
    ...settings,
    security: {
      ...security,
      auth: {
        ...auth,
        selectedType: "oauth-personal",
      },
    },
  };

  const encodedSettings = yield* encodeJsonObject(nextSettings);
  yield* writeFileStringAtomically({
    filePath: settingsPath,
    contents: `${encodedSettings}\n`,
  });
});

function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const encodedPayload = idToken.split(".")[1];
  if (!encodedPayload) return undefined;
  const decodedPayload = Encoding.decodeBase64UrlString(encodedPayload);
  if (decodedPayload._tag !== "Success") return undefined;
  const claims = decodeGeminiIdTokenClaims(decodedPayload.success);
  if (Option.isNone(claims)) return undefined;
  const email = claims.value.email?.trim();
  return email && email.length > 0 ? email : undefined;
}

export interface GeminiAuthState {
  readonly authenticated: boolean;
  readonly hasAccessToken: boolean;
  readonly hasRefreshToken: boolean;
  readonly email?: string;
}

/**
 * Read current or legacy Gemini CLI OAuth storage. Account metadata alone is
 * not proof of authentication after logout.
 */
export const readGeminiAuthState = Effect.fn("readGeminiAuthState")(function* (input: {
  readonly homePath: string;
}): Effect.fn.Return<GeminiAuthState, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const dataDirectory = geminiDataDirectory(input.homePath);

  const encryptedCredentialsRaw = yield* fileSystem
    .readFileString(NodePath.join(dataDirectory, "gemini-credentials.json"))
    .pipe(Effect.option);
  const encryptedCredentials = Option.flatMap(
    encryptedCredentialsRaw,
    decodeGeminiFileKeychainOAuthCredentials,
  );

  const legacyCredentialsRaw = yield* fileSystem
    .readFileString(NodePath.join(dataDirectory, "oauth_creds.json"))
    .pipe(Effect.option);
  const legacyCredentials = Option.flatMap(legacyCredentialsRaw, (contents) =>
    Option.map(decodeGeminiOAuthCredentials(contents), (credentials) => ({
      ...(credentials.access_token ? { accessToken: credentials.access_token } : {}),
      ...(credentials.refresh_token ? { refreshToken: credentials.refresh_token } : {}),
      ...(credentials.id_token ? { idToken: credentials.id_token } : {}),
    })),
  );
  const credentials = Option.orElse(encryptedCredentials, () => legacyCredentials);
  if (Option.isNone(credentials)) {
    return { authenticated: false, hasAccessToken: false, hasRefreshToken: false };
  }
  const hasAccessToken = hasNonEmptyGeminiToken(credentials.value.accessToken);
  const hasRefreshToken = hasNonEmptyGeminiToken(credentials.value.refreshToken);
  if (!hasAccessToken && !hasRefreshToken) {
    return { authenticated: false, hasAccessToken: false, hasRefreshToken: false };
  }

  const authState = {
    authenticated: true,
    hasAccessToken,
    hasRefreshToken,
  } as const;

  const accountsRaw = yield* fileSystem
    .readFileString(NodePath.join(dataDirectory, "google_accounts.json"))
    .pipe(Effect.option);
  if (Option.isSome(accountsRaw)) {
    const accounts = decodeGeminiGoogleAccounts(accountsRaw.value);
    if (Option.isSome(accounts)) {
      const active = accounts.value.active?.trim();
      if (active && active.length > 0) return { ...authState, email: active };
    }
  }

  const email = emailFromIdToken(credentials.value.idToken);
  return email ? { ...authState, email } : authState;
});

/** Best-effort identity read for OAuth completion UI. */
export const readGeminiAccountEmail = Effect.fn("readGeminiAccountEmail")(function* (input: {
  readonly homePath: string;
}): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem> {
  return (yield* readGeminiAuthState(input)).email;
});
