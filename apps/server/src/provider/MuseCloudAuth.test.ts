// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { MUSE_CLOUD_COOKIES_FILENAME } from "./Drivers/MuseCloudHome.ts";
import {
  closeCdpBrowserQuietly,
  importMuseCloudCookies,
  pollMuseCookiesFromCdp,
  probeMuseCdp,
} from "./MuseCloudAuth.ts";

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

/** Encode a single unmasked server-to-client RFC6455 text frame. */
function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  if (len < 126) {
    return Buffer.concat([Buffer.from([0x81, len]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(len, 2);
  return Buffer.concat([header, payload]);
}

/** Decode a single masked client-to-server RFC6455 text frame. */
function decodeMaskedWsTextFrame(buf: Buffer): string | undefined {
  if (buf.length < 6) return undefined;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 8) return undefined;
    len = buf.readUInt16BE(2);
    offset = 4;
  }
  if (!masked || buf.length < offset + 4 + len) return undefined;
  const mask = buf.subarray(offset, offset + 4);
  const data = buf.subarray(offset + 4, offset + 4 + len);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    out[i] = data[i]! ^ mask[i % 4]!;
  }
  return out.toString("utf8");
}

function startFakeCdpServer(cookies: ReadonlyArray<Record<string, unknown>>) {
  return new Promise<{
    readonly port: number;
    readonly getCloseCalled: () => boolean;
    readonly close: () => Promise<void>;
  }>((resolve, reject) => {
    const upgradedSockets = new Set<NodeNet.Socket>();
    let closeCalled = false;
    const server = NodeHttp.createServer((req, res) => {
      if (req.url === "/json/version") {
        const addr = server.address() as NodeNet.AddressInfo;
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        res.end(
          JSON.stringify({
            Browser: "FakeChrome/130",
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/fake`,
          }),
        );
        return;
      }
      res.writeHead(404, { Connection: "close" });
      res.end();
    });

    server.on("upgrade", (req, socket) => {
      upgradedSockets.add(socket as NodeNet.Socket);
      socket.on("close", () => {
        upgradedSockets.delete(socket as NodeNet.Socket);
      });
      const key = req.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = NodeCrypto.createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "\r\n",
        ].join("\r\n"),
      );

      socket.on("data", (chunk: Buffer) => {
        const text = decodeMaskedWsTextFrame(chunk);
        if (!text) return;
        const msg = JSON.parse(text) as { id: number; method: string };
        if (msg.method === "Storage.getCookies") {
          socket.write(encodeWsTextFrame(JSON.stringify({ id: msg.id, result: { cookies } })));
        } else if (msg.method === "Browser.close") {
          closeCalled = true;
          socket.write(encodeWsTextFrame(JSON.stringify({ id: msg.id, result: {} })));
        }
      });
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as NodeNet.AddressInfo;
      resolve({
        port: addr.port,
        getCloseCalled: () => closeCalled,
        close: () =>
          new Promise<void>((done) => {
            for (const s of upgradedSockets) {
              try {
                s.destroy();
              } catch {
                // Ignore.
              }
            }
            upgradedSockets.clear();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

describe("MuseCloudAuth", () => {
  it("captures only muse.ai cookies over loopback CDP and filters expired or foreign cookies", async () => {
    const validServer = await startFakeCdpServer([
      {
        domain: ".google.com",
        name: "SID",
        value: "google_sid_should_not_be_captured",
        expires: 2_500_000_000,
      },
      {
        domain: ".muse.ai",
        name: "hatch_sess",
        value: "valid_cdp_hatch_session_token_9876",
        path: "/",
        secure: true,
        expires: 2_500_000_000,
      },
      { domain: "muse.ai", name: "theme", value: "dark", path: "/", secure: true, expires: 0 },
    ]);
    try {
      const captured = await pollMuseCookiesFromCdp(validServer.port, 1_800_000_000);
      expect(captured).toBeDefined();
      expect(captured).toHaveLength(2);
      expect(captured!.some((c) => c.domain.includes("google.com"))).toBe(false);
      expect(captured!.find((c) => c.name === "hatch_sess")?.value).toBe(
        "valid_cdp_hatch_session_token_9876",
      );
    } finally {
      await validServer.close();
    }

    const expiredServer = await startFakeCdpServer([
      {
        domain: ".muse.ai",
        name: "hatch_sess",
        value: "expired_cdp_hatch_session_token_9876",
        expires: 1_700_000_000,
      },
    ]);
    try {
      const expired = await pollMuseCookiesFromCdp(expiredServer.port, 1_800_000_000);
      expect(expired).toBeUndefined();
      // Browser is still reachable even without a valid hatch_sess cookie yet
      const probed = await probeMuseCdp(expiredServer.port, 1_800_000_000);
      expect(probed).toEqual({ reachable: true });
      await closeCdpBrowserQuietly(expiredServer.port);
      expect(expiredServer.getCloseCalled()).toBe(true);
    } finally {
      await expiredServer.close();
    }

    // Closed port reports reachable: false
    const closedProbe = await probeMuseCdp(expiredServer.port, 1_800_000_000);
    expect(closedProbe).toEqual({ reachable: false });
  });

  it("imports cookies, verifies via muse-cli status, persists cloud instance, and restores backup on failure", async () => {
    const workDir = makeTempDir("t3-muse-cloud-import-");
    const fakeCliScript = NodePath.join(workDir, "fake-muse-cli.mjs");
    NodeFs.writeFileSync(
      fakeCliScript,
      `
import fs from "node:fs";
import path from "node:path";

const home = process.env.USERPROFILE || process.env.HOME;
const cookiesFile = path.join(home, ".config", "muse-cli", "cookies.txt");
const content = fs.existsSync(cookiesFile) ? fs.readFileSync(cookiesFile, "utf8") : "";
if (content.includes("GOOD_SESSION_TOKEN_123456")) {
  console.log(JSON.stringify({
    vm_id: "vm-cloud-001",
    sessions: 2,
    identity: { email: "my.google@gmail.com", name: "My Google" }
  }));
  process.exit(0);
}
console.error("Invalid session cookie");
process.exit(2);
`,
    );

    const envLayer = Layer.mergeAll(
      ServerSettingsService.layerTest({
        providers: {
          muse: {
            cloudBinaryPath: fakeCliScript,
          },
        },
      }),
      ServerConfig.layerTest(workDir, workDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    // 1. Add a new muse.ai cloud account
    const added = await Effect.runPromise(
      Effect.gen(function* () {
        const res = yield* importMuseCloudCookies({
          cookies: "hatch_sess=GOOD_SESSION_TOKEN_123456",
          displayName: "내 muse.ai",
        });
        const settings = yield* ServerSettingsService;
        const latest = yield* settings.getSettings;
        return { res, latest };
      }).pipe(Effect.provide(envLayer)),
    );

    expect(added.res.driver).toBe("muse");
    expect(added.res.email).toBe("my.google@gmail.com");
    expect(added.res.displayName).toBe("내 muse.ai");
    const savedInstance = added.latest.providerInstances[added.res.instanceId];
    expect(savedInstance?.driver).toBe("muse");
    expect(savedInstance?.enabled).toBe(true);
    expect((savedInstance?.config as Record<string, unknown>)?.backendMode).toBe("cloud");

    // 2. Re-auth with bad cookie must fail and preserve previous valid cookies.txt
    const cookiesPath = NodePath.join(
      added.res.homePath!,
      ".config",
      "muse-cli",
      MUSE_CLOUD_COOKIES_FILENAME,
    );
    const beforeFailure = NodeFs.readFileSync(cookiesPath, "utf8");
    const failedExit = await Effect.runPromise(
      Effect.exit(
        importMuseCloudCookies({
          instanceId: added.res.instanceId,
          cookies: "hatch_sess=BAD_SESSION_TOKEN_999999",
        }),
      ).pipe(Effect.provide(envLayer)),
    );
    expect(Exit.isFailure(failedExit)).toBe(true);
    expect(NodeFs.readFileSync(cookiesPath, "utf8")).toBe(beforeFailure);

    // 3. Re-auth default "muse" slot directly into cloud backend
    const defaultSlotResult = await Effect.runPromise(
      Effect.gen(function* () {
        const res = yield* importMuseCloudCookies({
          instanceId: ProviderInstanceId.make("muse"),
          cookies: "hatch_sess=GOOD_SESSION_TOKEN_123456",
        });
        const settings = yield* ServerSettingsService;
        const latest = yield* settings.getSettings;
        return { res, latest };
      }).pipe(Effect.provide(envLayer)),
    );
    expect(String(defaultSlotResult.res.instanceId)).toBe("muse");
    expect(
      (
        defaultSlotResult.latest.providerInstances[ProviderInstanceId.make("muse")]
          ?.config as Record<string, unknown>
      )?.backendMode,
    ).toBe("cloud");
  });
});
