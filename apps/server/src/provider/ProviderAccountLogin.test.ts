import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  beginGrokDeviceAuth,
  cancelGrokDeviceAuth,
  connectOpenCodeGoAccountAtPath,
  extractGrokDeviceAuthPrompt,
  isBrowserLoginDriver,
  loginProviderAccount,
  waitGrokDeviceAuth,
} from "./ProviderAccountLogin.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const writeMockGrokAuthCli = (
  dir: string,
  options: {
    readonly email: string;
    readonly userId: string;
    readonly deviceMode?: "complete" | "hang";
    readonly deviceDelayMs?: number;
  },
) => {
  const emailLit = encodeJsonString(options.email);
  const userIdLit = encodeJsonString(options.userId);
  const modeLit = encodeJsonString(options.deviceMode ?? "complete");
  const delayMs = options.deviceDelayMs ?? 120;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scriptPath = path.join(dir, `mock-grok-${options.userId}.mjs`);
    yield* fs.writeFileString(
      scriptPath,
      [
        `import * as fs from "node:fs";`,
        `import * as path from "node:path";`,
        `const args = process.argv.slice(2);`,
        `const grokHome = process.env.GROK_HOME;`,
        `if (!grokHome) { process.stderr.write("missing GROK_HOME\\n"); process.exit(3); }`,
        `if (process.env.XAI_API_KEY) { process.stderr.write("unexpected XAI_API_KEY\\n"); process.exit(4); }`,
        `const writeAuth = () => {`,
        `  fs.mkdirSync(grokHome, { recursive: true });`,
        `  const payload = {`,
        `    ["https://auth.x.ai::" + ${userIdLit}]: {`,
        `      key: "mock-access-token",`,
        `      refresh_token: "mock-refresh-token",`,
        `      auth_mode: "oidc",`,
        `      email: ${emailLit},`,
        `      user_id: ${userIdLit},`,
        `      expires_at: "2099-01-01T00:00:00.000000000Z",`,
        `    },`,
        `  };`,
        `  fs.writeFileSync(path.join(grokHome, "auth.json"), JSON.stringify(payload, null, 2));`,
        `};`,
        `if (args.includes("--device-auth")) {`,
        `  process.stdout.write("Open this URL in your browser to approve:\\nhttps://auth.x.ai/device\\nCode: GROK-2026\\nWaiting for approval...\\n");`,
        `  if (${modeLit} === "hang") {`,
        `    setInterval(() => {}, 1000);`,
        `  } else {`,
        `    setTimeout(() => { writeAuth(); process.exit(0); }, ${delayMs});`,
        `  }`,
        `} else if (args.includes("--oauth")) {`,
        `  writeAuth();`,
        `  process.exit(0);`,
        `} else {`,
        `  process.stderr.write("unknown args: " + args.join(" ") + "\\n");`,
        `  process.exit(2);`,
        `}`,
      ].join("\n"),
    );

    if (process.platform === "win32") {
      const cmdPath = path.join(dir, `mock-grok-${options.userId}.cmd`);
      yield* fs.writeFileString(
        cmdPath,
        `@echo off\r\n"${process.execPath}" "%~dp0mock-grok-${options.userId}.mjs" %*\r\n`,
      );
      return cmdPath;
    }
    const shPath = path.join(dir, `mock-grok-${options.userId}.sh`);
    yield* fs.writeFileString(
      shPath,
      ["#!/bin/sh", `exec "${process.execPath}" "${scriptPath}" "$@"`, ""].join("\n"),
    );
    yield* fs.chmod(shPath, 0o755);
    return shPath;
  });
};

describe("provider account login", () => {
  it("subscription CLI providers support browser login", () => {
    for (const driver of ["codex", "claudeAgent", "cursor", "grok"]) {
      expect(isBrowserLoginDriver(ProviderDriverKind.make(driver))).toBe(true);
    }
    expect(isBrowserLoginDriver(ProviderDriverKind.make("gemini"))).toBe(false);
    // opencode authenticates with an API key written to auth.json, not a
    // browser-driven CLI login, so it is excluded from the browser login specs.
    expect(isBrowserLoginDriver(ProviderDriverKind.make("opencode"))).toBe(false);
    expect(isBrowserLoginDriver(ProviderDriverKind.make("ollama"))).toBe(false);
  });

  it("extracts Grok device-auth URL and one-time code from CLI output", () => {
    expect(
      extractGrokDeviceAuthPrompt(
        "\u001b[36mOpen this URL in your browser to approve:\u001b[0m\r\n  https://auth.x.ai/device\r\n  Code: \u001b[1mABCD-1234\u001b[0m\r\nWaiting for approval...",
      ),
    ).toEqual({
      verificationUrl: "https://auth.x.ai/device",
      userCode: "ABCD-1234",
    });

    expect(
      extractGrokDeviceAuthPrompt(
        "Visit https://auth.x.ai/device?user_code=wxyz-9876 to authorize this device.",
      ),
    ).toEqual({
      verificationUrl: "https://auth.x.ai/device?user_code=wxyz-9876",
      userCode: "WXYZ-9876",
    });

    expect(extractGrokDeviceAuthPrompt("Starting device login...")).toBeUndefined();
  });
});

describe("Grok multi-account OAuth and device-auth login", () => {
  it.live(
    "registers a new Grok OAuth account in an isolated GROK_HOME and persists binaryPath/homePath",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-login-" });
          const defaultHome = path.join(root, "default-grok-home");
          yield* fs.makeDirectory(defaultHome, { recursive: true });
          const mockCli = yield* writeMockGrokAuthCli(root, {
            email: "second@example.com",
            userId: "uid-second",
          });

          const layer = Layer.mergeAll(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-grok-login-cfg-" }),
            ServerSettings.layerTest({
              providers: {
                grok: {
                  enabled: true,
                  binaryPath: mockCli,
                  homePath: defaultHome,
                },
              },
            }),
          ).pipe(Layer.provideMerge(NodeServices.layer));

          const result = yield* Effect.gen(function* () {
            const loginResult = yield* loginProviderAccount({
              driver: "grok",
              displayName: "Grok Work",
              accentColor: "#2563eb",
            });
            const saved = yield* ServerSettings.ServerSettingsService.pipe(
              Effect.flatMap((svc) => svc.getSettings),
            );
            return { loginResult, saved };
          }).pipe(Effect.provide(layer));

          expect(result.loginResult.driver).toBe("grok");
          expect(result.loginResult.email).toBe("second@example.com");
          expect(result.loginResult.displayName).toBe("Grok Work");
          expect(result.loginResult.homePath).toBeTruthy();

          const stored = result.saved.providerInstances[result.loginResult.instanceId];
          expect(stored?.driver).toBe("grok");
          expect(stored?.displayName).toBe("Grok Work");
          expect(stored?.accentColor).toBe("#2563eb");
          expect(stored?.config).toMatchObject({
            binaryPath: mockCli,
            homePath: result.loginResult.homePath,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects duplicate Grok accounts with the same email and cleans up the temp home", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-dup-" });
        const defaultHome = path.join(root, "default-grok-home");
        yield* fs.makeDirectory(defaultHome, { recursive: true });
        yield* fs.writeFileString(
          path.join(defaultHome, "auth.json"),
          `{"https://auth.x.ai::u-existing":{"key":"tok","refresh_token":"ref","email":"Same@Example.com","user_id":"uid-same","expires_at":"2099-01-01T00:00:00Z"}}`,
        );
        const mockCli = yield* writeMockGrokAuthCli(root, {
          email: "same@example.com",
          userId: "uid-same",
        });

        const layer = Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-grok-dup-cfg-" }),
          ServerSettings.layerTest({
            providers: {
              grok: {
                enabled: true,
                binaryPath: mockCli,
                homePath: defaultHome,
              },
            },
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer));

        const outcome = yield* Effect.gen(function* () {
          const cfg = yield* ServerConfig.ServerConfig;
          const res = yield* loginProviderAccount({ driver: "grok" }).pipe(Effect.result);
          const instancesRoot = path.join(cfg.stateDir, "provider-instances");
          const existsRoot = yield* fs.exists(instancesRoot);
          const entries = existsRoot ? yield* fs.readDirectory(instancesRoot) : [];
          return { res, entries };
        }).pipe(Effect.provide(layer));

        expect(outcome.res._tag).toBe("Failure");
        if (outcome.res._tag === "Failure") {
          expect(outcome.res.failure.message).toContain("이미 등록된 Grok 계정");
        }
        // Any newly created grok-home inside provider-instances should have been removed.
        for (const entry of outcome.entries) {
          expect(entry.startsWith("grok_")).toBe(true);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "re-authenticates an existing Grok instance in place without creating a new instanceId",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-reauth-" });
          const defaultHome = path.join(root, "default-home");
          const workHome = path.join(root, "work-home");
          yield* fs.makeDirectory(defaultHome, { recursive: true });
          yield* fs.makeDirectory(workHome, { recursive: true });
          const mockCli = yield* writeMockGrokAuthCli(root, {
            email: "reauthed@example.com",
            userId: "uid-reauth",
          });
          const workId = ProviderInstanceId.make("grok_work");

          const layer = Layer.mergeAll(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-grok-reauth-cfg-" }),
            ServerSettings.layerTest({
              providers: {
                grok: { enabled: true, binaryPath: mockCli, homePath: defaultHome },
              },
              providerInstances: {
                [workId]: {
                  driver: ProviderDriverKind.make("grok"),
                  enabled: false,
                  displayName: "Grok Work Slot",
                  config: { binaryPath: mockCli, homePath: workHome },
                },
              },
            }),
          ).pipe(Layer.provideMerge(NodeServices.layer));

          const result = yield* loginProviderAccount({
            driver: "grok",
            instanceId: workId,
          }).pipe(Effect.provide(layer));

          expect(result.instanceId).toBe(workId);
          expect(result.email).toBe("reauthed@example.com");
          expect(result.displayName).toBe("Grok Work Slot");
          expect(result.homePath).toBe(path.resolve(workHome));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("completes Grok device-auth begin -> wait and supports clean cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-device-" });
        const defaultHome = path.join(root, "default-home");
        yield* fs.makeDirectory(defaultHome, { recursive: true });
        const completeCli = yield* writeMockGrokAuthCli(root, {
          email: "device.user@example.com",
          userId: "uid-device",
          deviceMode: "complete",
          deviceDelayMs: 120,
        });
        const hangCli = yield* writeMockGrokAuthCli(root, {
          email: "cancelled@example.com",
          userId: "uid-hang",
          deviceMode: "hang",
        });

        const completeLayer = Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-grok-dev-ok-" }),
          ServerSettings.layerTest({
            providers: { grok: { enabled: true, binaryPath: completeCli, homePath: defaultHome } },
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer));

        const okOutcome = yield* Effect.gen(function* () {
          const began = yield* beginGrokDeviceAuth({ displayName: "Grok Device" });
          const waited = yield* waitGrokDeviceAuth({ sessionId: began.sessionId });
          return { began, waited };
        }).pipe(Effect.provide(completeLayer));

        expect(okOutcome.began.verificationUrl).toBe("https://auth.x.ai/device");
        expect(okOutcome.began.userCode).toBe("GROK-2026");
        expect(okOutcome.waited.instanceId).toBe(okOutcome.began.instanceId);
        expect(okOutcome.waited.email).toBe("device.user@example.com");
        expect(okOutcome.waited.displayName).toBe("Grok Device");

        const cancelLayer = Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-grok-dev-cancel-" }),
          ServerSettings.layerTest({
            providers: { grok: { enabled: true, binaryPath: hangCli, homePath: defaultHome } },
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer));

        const cancelOutcome = yield* Effect.gen(function* () {
          const cfg = yield* ServerConfig.ServerConfig;
          const began = yield* beginGrokDeviceAuth({});
          const createdHome = path.join(
            cfg.stateDir,
            "provider-instances",
            String(began.instanceId),
            "grok-home",
          );
          expect(yield* fs.exists(createdHome)).toBe(true);
          yield* cancelGrokDeviceAuth({ sessionId: began.sessionId });
          return yield* fs.exists(createdHome);
        }).pipe(Effect.provide(cancelLayer));

        expect(cancelOutcome).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("OpenCode Go account registration", () => {
  it.effect("keeps other providers and probes without modifying the auth file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-auth-" });
      const authPath = path.join(root, "auth.json");
      const original = '{"other":{"type":"oauth","refresh":"preserve"}}';
      yield* fs.writeFileString(authPath, original);
      expect(yield* connectOpenCodeGoAccountAtPath({}, authPath)).toEqual({
        connected: false,
        keyRegistered: false,
      });
      expect(yield* fs.readFileString(authPath)).toBe(original);
      yield* connectOpenCodeGoAccountAtPath({ apiKey: "test-key" }, authPath);
      expect(decodeJson(yield* fs.readFileString(authPath))).toEqual({
        other: { type: "oauth", refresh: "preserve" },
        "opencode-go": { type: "api", key: "test-key" },
      });
      expect(yield* connectOpenCodeGoAccountAtPath({}, authPath)).toEqual({
        connected: true,
        keyRegistered: true,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not replace an invalid existing auth file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-auth-" });
      const authPath = path.join(root, "auth.json");
      const original = '{"other":';
      yield* fs.writeFileString(authPath, original);
      const result = yield* connectOpenCodeGoAccountAtPath({ apiKey: "test-key" }, authPath).pipe(
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(yield* fs.readFileString(authPath)).toBe(original);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not create a directory for a read-only probe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-auth-" });
      const directory = path.join(root, "missing");
      expect(yield* connectOpenCodeGoAccountAtPath({}, path.join(directory, "auth.json"))).toEqual({
        connected: false,
        keyRegistered: false,
      });
      expect(yield* fs.exists(directory)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("creates a new auth file when a key is provided", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-auth-" });
      const authPath = path.join(root, "new", "auth.json");
      expect(yield* connectOpenCodeGoAccountAtPath({ apiKey: "test-key" }, authPath)).toEqual({
        connected: true,
        keyRegistered: true,
      });
      expect(decodeJson(yield* fs.readFileString(authPath))).toEqual({
        "opencode-go": { type: "api", key: "test-key" },
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
