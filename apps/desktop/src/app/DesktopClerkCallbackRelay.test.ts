// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  extractClerkCallbackUrl,
  isMatchingDesktopCallbackUrl,
  startDesktopClerkCallbackRelay,
  tryForwardClerkCallbackFromArgv,
} from "./DesktopClerkCallbackRelay.ts";

describe("DesktopClerkCallbackRelay", () => {
  const tempDirs: string[] = [];

  const mkTempDir = () => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-clerk-relay-"));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      try {
        NodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("extracts matching desktop deep-link callback URLs from argv", () => {
    expect(
      extractClerkCallbackUrl(
        ["electron.exe", "dist-electron/main.cjs", "t3code://app/?__clerk_handshake=abc"],
        "t3code",
      ),
    ).toBe("t3code://app/?__clerk_handshake=abc");

    expect(
      extractClerkCallbackUrl(
        ["electron.exe", "dist-electron/main.cjs", "t3code://evil/?x=1"],
        "t3code",
      ),
    ).toBeNull();

    expect(isMatchingDesktopCallbackUrl("https://evil.example/?x=1", "t3code")).toBe(false);
  });

  it("starts loopback relay, rejects invalid token/origin, forwards valid callback, and cleans up descriptor", async () => {
    const stateDir = mkTempDir();
    const received: string[] = [];
    const relay = await startDesktopClerkCallbackRelay({
      stateDir,
      scheme: "t3code",
      onCallback: (url) => received.push(url),
    });

    try {
      expect(NodeFs.existsSync(relay.relayFilePath)).toBe(true);

      // 1) Unauthorized token rejected (401)
      const unauth = await fetch(`http://127.0.0.1:${relay.descriptor.port}/callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ url: "t3code://app/?ok=1" }),
      });
      expect(unauth.status).toBe(401);

      // 2) Mismatched scheme/host rejected (400)
      const badUrl = await fetch(`http://127.0.0.1:${relay.descriptor.port}/callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${relay.descriptor.token}`,
        },
        body: JSON.stringify({ url: "t3code://evil/?ok=1" }),
      });
      expect(badUrl.status).toBe(400);

      // 3) Valid secondary argv forwarding succeeds
      const forwarded = await tryForwardClerkCallbackFromArgv({
        argv: ["electron.exe", "main.cjs", "t3code://app/?__clerk_handshake=xyz"],
        stateDir,
        scheme: "t3code",
      });
      expect(forwarded).toBe(true);
      expect(received).toEqual(["t3code://app/?__clerk_handshake=xyz"]);
    } finally {
      await relay.close();
    }

    expect(NodeFs.existsSync(relay.relayFilePath)).toBe(false);
  });
});
