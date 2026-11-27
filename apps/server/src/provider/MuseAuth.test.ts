// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  beginMuseAuth,
  cancelMuseAuth,
  extractMuseElicitationPrompt,
  waitMuseAuth,
} from "./MuseAuth.ts";

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

describe("MuseAuth", () => {
  it("extracts verificationUrl and userCode from ACP elicitation/create payload", () => {
    const prompt = extractMuseElicitationPrompt({
      jsonrpc: "2.0",
      id: 0,
      method: "elicitation/create",
      params: {
        mode: "url",
        elicitationId: "abc",
        url: "https://auth.meta.com/oauth/device/?code=CFBQ-JKLM",
        requestId: 2,
        message: "Open the link to log in to Muse, and enter the code CFBQ-JKLM there.",
      },
    });
    expect(prompt).toEqual({
      requestId: 0,
      verificationUrl: "https://auth.meta.com/oauth/device/?code=CFBQ-JKLM",
      userCode: "CFBQ-JKLM",
    });

    expect(
      extractMuseElicitationPrompt({
        jsonrpc: "2.0",
        id: 0,
        method: "elicitation/create",
        params: { url: "http://insecure.example.com" },
      }),
    ).toBeUndefined();
  });

  it("completes ACP elicitation login flow and persists the new Muse instance", async () => {
    const workDir = makeTempDir("t3-muse-auth-e2e-");
    const fakeAcpScript = NodePath.join(workDir, "fake-muse-acp.mjs");
    NodeFs.writeFileSync(
      fakeAcpScript,
      `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: "muse-login", name: "Log in to Muse" }] } }) + "\\n");
  } else if (msg.method === "authenticate") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "elicitation/create",
      params: {
        mode: "url",
        url: "https://auth.meta.com/oauth/device/?code=TEST-1234",
        message: "Open the link to log in to Muse, and enter the code TEST-1234 there."
      }
    }) + "\\n");
  } else if (msg.id === 99 && msg.result?.action === "accept") {
    const authDir = path.join(process.env.XDG_CONFIG_HOME, "muse");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "auth.json"), JSON.stringify({
      providers: {
        meta: {
          mechanism: "oauth",
          access_token: "tok-12345",
          refresh_token: "ref-12345",
          expires_at_ms: Date.now() + 3_600_000,
          user_email: "google-user@example.com",
          user_full_name: "Google Muse User"
        }
      }
    }));
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }) + "\\n");
    process.exit(0);
  }
});
`,
    );

    const settingsLayer = ServerSettingsService.layerTest({
      providers: {
        muse: {
          binaryPath: fakeAcpScript,
        },
      },
    });
    const configLayer = ServerConfig.layerTest(workDir, workDir);
    const envLayer = Layer.mergeAll(settingsLayer, configLayer).pipe(
      Layer.provideMerge(NodeServices.layer),
    );

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* beginMuseAuth({ displayName: "Muse Google" });
        const finished = yield* waitMuseAuth({ sessionId: started.sessionId });
        const settings = yield* ServerSettingsService;
        const latest = yield* settings.getSettings;
        return { started, finished, latest };
      }).pipe(Effect.provide(envLayer)),
    );

    expect(outcome.started.verificationUrl).toBe(
      "https://auth.meta.com/oauth/device/?code=TEST-1234",
    );
    expect(outcome.started.userCode).toBe("TEST-1234");
    expect(outcome.finished.driver).toBe("muse");
    expect(outcome.finished.email).toBe("google-user@example.com");
    expect(outcome.finished.displayName).toBe("Muse Google");
    expect(outcome.latest.providerInstances[outcome.finished.instanceId]?.driver).toBe("muse");
    expect(outcome.latest.providerInstances[outcome.finished.instanceId]?.enabled).toBe(true);
  });

  it("cancels an in-flight Muse auth session cleanly", async () => {
    const workDir = makeTempDir("t3-muse-auth-cancel-");
    const fakeAcpScript = NodePath.join(workDir, "fake-muse-hang.mjs");
    NodeFs.writeFileSync(
      fakeAcpScript,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
  } else if (msg.method === "authenticate") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 77,
      method: "elicitation/create",
      params: { url: "https://auth.meta.com/oauth/device/?code=WAIT-9999", message: "code WAIT-9999" }
    }) + "\\n");
  }
});
setInterval(() => {}, 10_000);
`,
    );

    const envLayer = Layer.mergeAll(
      ServerSettingsService.layerTest({ providers: { muse: { binaryPath: fakeAcpScript } } }),
      ServerConfig.layerTest(workDir, workDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    const started = await Effect.runPromise(
      Effect.gen(function* () {
        const begin = yield* beginMuseAuth({});
        yield* cancelMuseAuth({ sessionId: begin.sessionId });
        return begin;
      }).pipe(Effect.provide(envLayer)),
    );

    expect(started.userCode).toBe("WAIT-9999");
  });
});
