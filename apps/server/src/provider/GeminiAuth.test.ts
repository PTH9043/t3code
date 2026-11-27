// @effect-diagnostics nodeBuiltinImport:off

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import {
  GeminiAuth,
  extractGeminiAuthorizationUrl,
  layer as GeminiAuthLayer,
  stripTerminalControlSequences,
} from "./GeminiAuth.ts";

const AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=t3-test&scope=email%20profile&state=state-1";
const GEMINI_INSTANCE_ID = ProviderInstanceId.make("gemini");
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
          binaryPath: "agy-test",
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
    ).toBe(AUTHORIZATION_URL);
  });

  it("preserves the OAuth URL produced by the native CLI", () => {
    const url = AUTHORIZATION_URL.replace("/v2/", "/");
    expect(extractGeminiAuthorizationUrl(url)).toBe(url);
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
});

it.layer(NodeServices.layer)("Antigravity CLI Google login", (it) => {
  for (const exitCode of [0, 1]) {
    it.effect(`uses the official login command and respects exit code ${exitCode}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-login-" });
          const fake = new FakePtyAdapter();
          fake.process.onWrite = () => fake.process.emitExit({ exitCode, signal: null });
          yield* Effect.gen(function* () {
            const auth = yield* GeminiAuth;
            const begun = yield* auth.begin(GEMINI_INSTANCE_ID);
            expect(begun.authorizationUrl).toBe(AUTHORIZATION_URL);
            const invocation = fake.spawnInputs[0]!;
            expect(invocation.shell).toMatch(/agy(?:\.exe)?$/i);
            expect(invocation.args).toContain("--gemini-dir");
            expect(invocation.cwd).toContain(home);
            expect(invocation.args?.[0]).toBe("acp");
            expect(invocation.args).toContain("--login");
            const result = yield* auth.complete(begun.sessionId, "sample-code").pipe(Effect.result);
            expect(result._tag).toBe(exitCode === 0 ? "Success" : "Failure");
            expect(fake.process.writes).toEqual(["sample-code\r"]);
          }).pipe(Effect.provide(makeGeminiAuthTestLayer(fake, home)));
        }),
      ),
    );
  }

  it.effect("cancels the login process and rejects a later answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cancel-" });
        const fake = new FakePtyAdapter();
        yield* Effect.gen(function* () {
          const auth = yield* GeminiAuth;
          const begun = yield* auth.begin(GEMINI_INSTANCE_ID);
          yield* auth.cancel(begun.sessionId);
          expect(fake.process.killSignals).toEqual(["SIGTERM"]);
          const result = yield* auth.complete(begun.sessionId, "late-code").pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(fake.process.writes).toHaveLength(0);
        }).pipe(Effect.provide(makeGeminiAuthTestLayer(fake, home)));
      }),
    ),
  );

  it.effect(
    "succeeds when browser loopback callback exits cleanly with code 0 before manual code submission",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-loopback-" });
          const fake = new FakePtyAdapter();
          yield* Effect.gen(function* () {
            const auth = yield* GeminiAuth;
            const begun = yield* auth.begin(GEMINI_INSTANCE_ID);
            expect(begun.authorizationUrl).toBe(AUTHORIZATION_URL);
            fake.process.emitExit({ exitCode: 0, signal: null });
            const result = yield* auth.complete(begun.sessionId, "").pipe(Effect.result);
            expect(result._tag).toBe("Success");
            expect(fake.process.writes).toHaveLength(0);
          }).pipe(Effect.provide(makeGeminiAuthTestLayer(fake, home)));
        }),
      ),
  );
});
