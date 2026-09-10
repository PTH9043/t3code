// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import {
  GeminiAuth,
  extractGeminiAuthorizationUrl,
  hasValidGeminiOAuthCredentials,
  layer as GeminiAuthLayer,
  stripTerminalControlSequences,
} from "./GeminiAuth.ts";

const AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=t3-test&scope=email%20profile&state=state-1";
const AUTHORIZATION_URL_WITH_CONSENT =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=t3-test&scope=email+profile&state=state-1&prompt=consent+select_account";
const GEMINI_INSTANCE_ID = ProviderInstanceId.make("gemini");
const decodeTestSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      security: Schema.Struct({ auth: Schema.Struct({ selectedType: Schema.String }) }),
      theme: Schema.String,
    }),
  ),
);

function encryptGeminiFileKeychainCredentials(): string {
  const storedCredentials = JSON.stringify({
    serverName: "main-account",
    token: {
      accessToken: "encrypted-access-token",
      refreshToken: "encrypted-refresh-token",
      tokenType: "Bearer",
    },
    updatedAt: 1_700_000_000_000,
  });
  const plaintext = JSON.stringify({
    "gemini-cli-oauth": { "main-account": storedCredentials },
  });
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

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = 9_001;
  readonly writes: Array<string> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly firstWrite: Promise<string>;
  private resolveFirstWrite: (value: string) => void = () => {};
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private initialOutput: string | undefined;
  onWrite: ((data: string) => void) | undefined;

  constructor(initialOutput: string) {
    this.initialOutput = initialOutput;
    this.firstWrite = new Promise((resolve) => {
      this.resolveFirstWrite = resolve;
    });
  }

  write(data: string): void {
    this.writes.push(data);
    this.onWrite?.(data);
    this.resolveFirstWrite(data);
  }

  resize(_cols: number, _rows: number): void {}

  kill(signal?: string): void {
    this.killSignals.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    if (this.initialOutput !== undefined) {
      const initialOutput = this.initialOutput;
      this.initialOutput = undefined;
      callback(initialOutput);
    }
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

class FakePtyAdapter {
  readonly spawnInputs: Array<PtyAdapter.PtySpawnInput> = [];
  readonly process: FakePtyProcess;

  constructor(initialOutput: string = `Open this URL:\r\n${AUTHORIZATION_URL}\r\n`) {
    this.process = new FakePtyProcess(initialOutput);
  }

  readonly spawn = (
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> => {
    this.spawnInputs.push(input);
    return Effect.succeed(this.process);
  };
}

function makeGeminiAuthTestLayer(fakePty: FakePtyAdapter, homePath: string) {
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-gemini-auth-config-" }),
    ServerSettings.layerTest({
      providers: {
        gemini: {
          enabled: true,
          binaryPath: "gemini-test",
          homePath,
        },
      },
    }),
    Layer.succeed(PtyAdapter.PtyAdapter, { spawn: fakePty.spawn }),
  );
  return GeminiAuthLayer.pipe(Layer.provide(dependencies));
}

describe("GeminiAuth terminal output parsing", () => {
  it("strips ANSI CSI, OSC, and carriage-return control sequences", () => {
    expect(
      stripTerminalControlSequences(
        "\u001b]0;Gemini OAuth\u0007\u001b[32mGoogle login\u001b[0m\r\nready",
      ),
    ).toBe("Google login\nready");
  });

  it("extracts the official Google authorization URL from styled CLI output", () => {
    expect(
      extractGeminiAuthorizationUrl(
        `\u001b[36mOpen this URL:\u001b[0m\r\n\u001b[4m${AUTHORIZATION_URL}\u001b[0m`,
      ),
    ).toBe(AUTHORIZATION_URL_WITH_CONSENT);
  });

  it("ignores non-Google and malformed authorization URLs", () => {
    expect(
      extractGeminiAuthorizationUrl(
        "https://accounts.google.com.evil.example/o/oauth2/v2/auth?state=stolen",
      ),
    ).toBeUndefined();
    expect(
      extractGeminiAuthorizationUrl("https://example.test/o/oauth2/v2/auth?state=not-google"),
    ).toBeUndefined();
    expect(
      extractGeminiAuthorizationUrl("Gemini CLI is waiting for authorization"),
    ).toBeUndefined();
  });

  it("accepts only credentials containing access and refresh tokens", () => {
    expect(
      hasValidGeminiOAuthCredentials(
        '{"access_token":"new-access-token","refresh_token":"new-refresh-token"}',
      ),
    ).toBe(true);
    expect(
      hasValidGeminiOAuthCredentials('{"access_token":"   ","refresh_token":"new-refresh-token"}'),
    ).toBe(false);
    expect(hasValidGeminiOAuthCredentials('{"access_token":"missing-refresh-token"}')).toBe(false);
    expect(hasValidGeminiOAuthCredentials('{"refresh_token":"missing-access-token"}')).toBe(false);
    expect(hasValidGeminiOAuthCredentials("not-json")).toBe(false);
  });
});

it.layer(NodeServices.layer)("GeminiAuth OAuth lifecycle", (it) => {
  it.effect("preserves old OAuth credentials and settings on cancel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-gemini-auth-home-",
        });
        const dataDirectory = NodePath.join(homePath, ".gemini");
        const credentialPath = NodePath.join(dataDirectory, "oauth_creds.json");
        const settingsPath = NodePath.join(dataDirectory, "settings.json");
        const previousCredentials = '{"refresh_token":"old-refresh-token"}\n';
        const previousSettings =
          '{"security":{"auth":{"selectedType":"gemini-api-key"}},"theme":"old"}\n';
        yield* fileSystem.makeDirectory(dataDirectory, { recursive: true });
        yield* fileSystem.writeFileString(credentialPath, previousCredentials);
        yield* fileSystem.writeFileString(settingsPath, previousSettings);
        const fakePty = new FakePtyAdapter();

        yield* Effect.gen(function* () {
          const auth = yield* GeminiAuth;
          const begun = yield* auth.begin(GEMINI_INSTANCE_ID);

          expect(begun.authorizationUrl).toBe(AUTHORIZATION_URL_WITH_CONSENT);
          expect(yield* fileSystem.readFileString(credentialPath)).toBe(previousCredentials);
          expect(yield* fileSystem.readFileString(settingsPath)).toBe(previousSettings);
          expect(fakePty.spawnInputs).toHaveLength(1);
          expect(fakePty.spawnInputs[0]).toMatchObject({
            shell: "gemini-test",
            args: ["--skip-trust"],
            env: {
              NO_BROWSER: "true",
            },
          });
          const loginHomePath = fakePty.spawnInputs[0]?.env.GEMINI_CLI_HOME;
          expect(loginHomePath).toBeDefined();
          expect(fakePty.spawnInputs[0]?.cwd).toBe(
            NodePath.join(NodePath.dirname(loginHomePath!), "workspace"),
          );
          expect(fakePty.spawnInputs[0]?.cwd).not.toBe(process.cwd());
          expect(loginHomePath).not.toContain(homePath);

          yield* auth.cancel(begun.sessionId);

          expect(yield* fileSystem.readFileString(credentialPath)).toBe(previousCredentials);
          expect(yield* fileSystem.readFileString(settingsPath)).toBe(previousSettings);
          expect(yield* fileSystem.exists(loginHomePath!)).toBe(false);
          expect(fakePty.process.killSignals).toEqual(["SIGTERM"]);
        }).pipe(Effect.provide(makeGeminiAuthTestLayer(fakePty, homePath)));
      }),
    ),
  );

  it.effect("runs the Windows gemini.cmd shim through cmd.exe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-gemini-auth-win32-",
        });
        const fakePty = new FakePtyAdapter();

        yield* Effect.gen(function* () {
          const auth = yield* GeminiAuth;
          yield* auth.begin(GEMINI_INSTANCE_ID);

          expect(fakePty.spawnInputs).toHaveLength(1);
          const input = fakePty.spawnInputs[0]!;
          // node-pty cannot execute the .cmd shim directly; the login must run
          // through cmd.exe or it throws on Windows (the original bug).
          expect(input.shell.toLowerCase()).toContain("cmd");
          expect(input.args?.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
          const commandLine = input.args?.[3] ?? "";
          expect(commandLine).toContain("gemini.cmd");
          expect(commandLine).toContain("--skip-trust");
        }).pipe(
          Effect.provide(makeGeminiAuthTestLayer(fakePty, homePath)),
          Effect.provideService(HostProcessPlatform, "win32"),
          Effect.provideService(
            SpawnExecutableResolution,
            () => "C:\\Users\\dev\\AppData\\Roaming\\npm\\gemini.cmd",
          ),
        );
      }),
    ),
  );

  it.effect("keeps old credentials when the isolated login fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-gemini-auth-failure-",
        });
        const dataDirectory = NodePath.join(homePath, ".gemini");
        const credentialPath = NodePath.join(dataDirectory, "oauth_creds.json");
        const previousCredentials = '{"access_token":"old-access-token"}\n';
        yield* fileSystem.makeDirectory(dataDirectory, { recursive: true });
        yield* fileSystem.writeFileString(credentialPath, previousCredentials);
        const fakePty = new FakePtyAdapter();

        yield* Effect.gen(function* () {
          const auth = yield* GeminiAuth;
          const begun = yield* auth.begin(GEMINI_INSTANCE_ID);
          const completionFiber = yield* Effect.forkChild(
            auth.complete(begun.sessionId, "rejected-code"),
            { startImmediately: true },
          );

          expect(yield* Effect.promise(() => fakePty.process.firstWrite)).toBe("rejected-code\r");
          fakePty.process.emitData("Failed to authenticate with user code\r\n");
          const failure = yield* Fiber.join(completionFiber).pipe(Effect.flip);

          expect(failure.kind).toBe("authorization-failed");
          expect(yield* fileSystem.readFileString(credentialPath)).toBe(previousCredentials);
          expect(fakePty.process.killSignals).toEqual(["SIGTERM"]);
        }).pipe(Effect.provide(makeGeminiAuthTestLayer(fakePty, homePath)));
      }),
    ),
  );

  it.effect("atomically replaces credentials after the isolated login writes a valid token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-gemini-auth-success-",
        });
        const dataDirectory = NodePath.join(homePath, ".gemini");
        const credentialPath = NodePath.join(dataDirectory, "oauth_creds.json");
        const settingsPath = NodePath.join(dataDirectory, "settings.json");
        yield* fileSystem.makeDirectory(dataDirectory, { recursive: true });
        yield* fileSystem.writeFileString(credentialPath, '{"access_token":"old-access-token"}\n');
        yield* fileSystem.writeFileString(
          settingsPath,
          '{"security":{"auth":{"selectedType":"gemini-api-key"}},"theme":"old"}\n',
        );
        const fakePty = new FakePtyAdapter();

        yield* Effect.gen(function* () {
          const auth = yield* GeminiAuth;
          const begun = yield* auth.begin(GEMINI_INSTANCE_ID);
          const loginHomePath = fakePty.spawnInputs[0]?.env.GEMINI_CLI_HOME;
          expect(loginHomePath).toBeDefined();
          const stagedDataDirectory = NodePath.join(loginHomePath!, ".gemini");
          const stagedCredentialPath = NodePath.join(stagedDataDirectory, "oauth_creds.json");
          const newCredentials =
            '{"access_token":"new-access-token","refresh_token":"new-refresh-token"}\n';
          fakePty.process.onWrite = () => {
            NodeFS.writeFileSync(
              NodePath.join(stagedDataDirectory, "google_accounts.json"),
              '{"active":"new-account@example.test","old":[]}',
            );
            NodeFS.writeFileSync(stagedCredentialPath, newCredentials);
            fakePty.process.emitData("Waiting for authentication...\r\n");
          };

          const result = yield* auth.complete(begun.sessionId, "accepted-code");

          expect(fakePty.process.writes).toEqual(["accepted-code\r"]);
          expect(result).toEqual({
            instanceId: GEMINI_INSTANCE_ID,
            email: "new-account@example.test",
          });
          expect(yield* fileSystem.readFileString(credentialPath)).toBe(newCredentials);
          expect(decodeTestSettings(yield* fileSystem.readFileString(settingsPath))).toMatchObject({
            security: { auth: { selectedType: "oauth-personal" } },
            theme: "old",
          });
          expect(
            yield* fileSystem.readFileString(NodePath.join(dataDirectory, "google_accounts.json")),
          ).toBe('{"active":"new-account@example.test","old":[]}');
          expect(yield* fileSystem.exists(loginHomePath!)).toBe(false);
          expect(fakePty.process.killSignals).toEqual(["SIGTERM"]);
        }).pipe(Effect.provide(makeGeminiAuthTestLayer(fakePty, homePath)));
      }),
    ),
  );

  it.effect("promotes instance-local encrypted credentials produced by current Gemini CLI", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-gemini-auth-encrypted-",
        });
        const dataDirectory = NodePath.join(homePath, ".gemini");
        const legacyCredentialPath = NodePath.join(dataDirectory, "oauth_creds.json");
        const encryptedCredentialPath = NodePath.join(dataDirectory, "gemini-credentials.json");
        yield* fileSystem.makeDirectory(dataDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          legacyCredentialPath,
          '{"access_token":"old-access-token","refresh_token":"old-refresh-token"}\n',
        );
        const encryptedCredentials = encryptGeminiFileKeychainCredentials();
        const fakePty = new FakePtyAdapter();

        yield* Effect.gen(function* () {
          const auth = yield* GeminiAuth;
          const begun = yield* auth.begin(GEMINI_INSTANCE_ID);
          const loginHomePath = fakePty.spawnInputs[0]?.env.GEMINI_CLI_HOME;
          expect(loginHomePath).toBeDefined();
          const stagedDataDirectory = NodePath.join(loginHomePath!, ".gemini");
          fakePty.process.onWrite = () => {
            NodeFS.writeFileSync(
              NodePath.join(stagedDataDirectory, "google_accounts.json"),
              '{"active":"encrypted@example.test"}',
            );
            NodeFS.writeFileSync(
              NodePath.join(stagedDataDirectory, "gemini-credentials.json"),
              encryptedCredentials,
            );
            fakePty.process.emitData("Waiting for authentication...\r\n");
          };

          const result = yield* auth.complete(begun.sessionId, "accepted-encrypted-code");

          expect(result).toEqual({
            instanceId: GEMINI_INSTANCE_ID,
            email: "encrypted@example.test",
          });
          expect(yield* fileSystem.readFileString(encryptedCredentialPath)).toBe(
            encryptedCredentials,
          );
          expect(yield* fileSystem.exists(legacyCredentialPath)).toBe(false);
          expect(yield* fileSystem.exists(loginHomePath!)).toBe(false);
        }).pipe(Effect.provide(makeGeminiAuthTestLayer(fakePty, homePath)));
      }),
    ),
  );
});
