// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { MuseSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import {
  MUSE_CLOUD_SESSION_COOKIE,
  makeMuseCloudEnvironment,
  resolveMuseCloudConfigDir,
  writeMuseCloudCookiesFile,
} from "../Drivers/MuseCloudHome.ts";
import { extractMuseCloudReplyText, makeMuseCloudAdapter } from "./MuseCloudAdapter.ts";
import {
  MUSE_CLOUD_CHAT_MODEL,
  MUSE_CLOUD_MAIN_MODEL,
  checkMuseCloudProviderStatus,
  parseMuseCloudStatusJson,
} from "./MuseCloudProvider.ts";

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

describe("MuseCloudProvider", () => {
  it("parses muse-cli status JSON metadata", () => {
    const parsed = parseMuseCloudStatusJson(
      JSON.stringify({
        vm_id: "vm-abc123456789",
        sessions: 3,
        identity: {
          email: "cloud-user@gmail.com",
          name: "Cloud User",
        },
      }),
    );
    expect(parsed).toEqual({
      vmId: "vm-abc123456789",
      email: "cloud-user@gmail.com",
      displayName: "Cloud User",
      sessions: 3,
    });
    expect(parseMuseCloudStatusJson("not-json")).toBeUndefined();
  });

  it("extracts reply text from muse-cli send output formats", () => {
    expect(extractMuseCloudReplyText(JSON.stringify({ reply: { text: "Hello from VM" } }))).toBe(
      "Hello from VM",
    );
    expect(extractMuseCloudReplyText(JSON.stringify({ reply: { content: "Content reply" } }))).toBe(
      "Content reply",
    );
    expect(extractMuseCloudReplyText(JSON.stringify({ text: "Direct text" }))).toBe("Direct text");
    expect(extractMuseCloudReplyText("Plain text answer\n")).toBe("Plain text answer");
    expect(extractMuseCloudReplyText("   ")).toBe("");
  });

  it("reports unauthenticated without cookies and ready after valid cookies + status", async () => {
    const workDir = makeTempDir("t3-muse-cloud-probe-");
    const homeDir = NodePath.join(workDir, "home");
    const scriptPath = NodePath.join(workDir, "fake-muse-cli.mjs");
    const wrapperPath =
      process.platform === "win32"
        ? NodePath.join(workDir, "fake-muse-cli.cmd")
        : NodePath.join(workDir, "fake-muse-cli.sh");

    NodeFs.writeFileSync(
      scriptPath,
      `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("muse-cli 0.3.15");
  process.exit(0);
}
if (args[0] === "status") {
  if (process.env.FAKE_MUSE_EXPIRED === "1") {
    console.error("Session expired");
    process.exit(2);
  }
  console.log(JSON.stringify({
    vm_id: "vm-99887766",
    sessions: 1,
    identity: { email: "google.user@gmail.com", name: "Google User" }
  }));
  process.exit(0);
}
process.exit(1);
`,
    );

    if (process.platform === "win32") {
      NodeFs.writeFileSync(
        wrapperPath,
        `@echo off\r\n"${process.execPath}" "%~dp0fake-muse-cli.mjs" %*\r\n`,
      );
    } else {
      NodeFs.writeFileSync(
        wrapperPath,
        `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-muse-cli.mjs" "$@"\n`,
      );
      NodeFs.chmodSync(wrapperPath, 0o755);
    }

    const settings = Schema.decodeSync(MuseSettings)({
      enabled: true,
      backendMode: "cloud",
      cloudBinaryPath: wrapperPath,
      homePath: homeDir,
    });

    // 1. Without cookies -> unauthenticated
    const unauthSnap = await Effect.runPromise(
      Effect.gen(function* () {
        const env = yield* makeMuseCloudEnvironment(settings, process.env);
        return yield* checkMuseCloudProviderStatus(settings, env);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(unauthSnap.installed).toBe(true);
    expect(unauthSnap.version).toBe("0.3.15");
    expect(unauthSnap.auth.status).toBe("unauthenticated");
    expect(unauthSnap.models.map((m) => m.slug)).toEqual([
      MUSE_CLOUD_CHAT_MODEL,
      MUSE_CLOUD_MAIN_MODEL,
    ]);

    // 2. With valid cookies -> ready + email
    const readySnap = await Effect.runPromise(
      Effect.gen(function* () {
        const env = yield* makeMuseCloudEnvironment(settings, process.env);
        const configDir = yield* resolveMuseCloudConfigDir(settings, env);
        yield* writeMuseCloudCookiesFile(configDir, [
          {
            domain: ".muse.ai",
            path: "/",
            secure: true,
            expires: 2_500_000_000,
            name: MUSE_CLOUD_SESSION_COOKIE,
            value: "valid_cloud_session_cookie_123456",
          },
        ]);
        return yield* checkMuseCloudProviderStatus(settings, env);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(readySnap.status).toBe("ready");
    expect(readySnap.auth.status).toBe("authenticated");
    expect(readySnap.auth.email).toBe("google.user@gmail.com");

    // 3. Exit code 2 from status -> unauthenticated (expired)
    const expiredSnap = await Effect.runPromise(
      Effect.gen(function* () {
        const env = yield* makeMuseCloudEnvironment(settings, {
          ...process.env,
          FAKE_MUSE_EXPIRED: "1",
        });
        return yield* checkMuseCloudProviderStatus(settings, env);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(expiredSnap.status).toBe("warning");
    expect(expiredSnap.auth.status).toBe("unauthenticated");
  });

  it("sends 50KB+ prompts through MuseCloudAdapter without Windows ENAMETOOLONG", async () => {
    const workDir = makeTempDir("t3-muse-cloud-long-prompt-");
    const fakeCli = NodePath.join(workDir, "fake-send-cli.mjs");
    NodeFs.writeFileSync(
      fakeCli,
      `
const args = process.argv.slice(2);
if (args[0] === "session-start") {
  console.log(JSON.stringify({ session_id: "sess-long-1" }));
  process.exit(0);
}
if (args[0] === "send") {
  console.log(JSON.stringify({ reply: { text: "received:" + args[1].length } }));
  process.exit(0);
}
process.exit(1);
`,
    );

    const settings = Schema.decodeSync(MuseSettings)({
      enabled: true,
      backendMode: "cloud",
      cloudBinaryPath: fakeCli,
      homePath: workDir,
    });
    const envLayer = Layer.mergeAll(ServerConfig.layerTest(workDir, workDir)).pipe(
      Layer.provideMerge(NodeServices.layer),
    );
    const hugePrompt = "안녕".repeat(25_000); // 50,000 chars (> Windows 32,767 argv cap)

    const history = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeMuseCloudAdapter(settings, { environment: process.env });
          const threadId = ThreadId.make("thread-muse-cloud-long");
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("muse"),
            cwd: workDir,
            runtimeMode: "full-access",
          });
          yield* adapter.sendTurn({
            threadId,
            input: hugePrompt,
          });
          return yield* adapter.readThread(threadId);
        }),
      ).pipe(Effect.provide(envLayer)),
    );

    expect(history.turns).toHaveLength(1);
  });
});
