import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  __resetDesktopPrimaryAuthForTests,
  readDesktopPrimaryBearerToken,
  resetDesktopPrimaryBearerToken,
} from "./desktopAuth";

describe("desktop primary auth", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("reuses the main-process bearer token across renderer requests", async () => {
    const getLocalEnvironmentBearerToken = vi.fn().mockResolvedValue("desktop-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
  });

  it("does not require desktop auth in a browser", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });

  it("reloads the main-process token after the authenticated identity changes", async () => {
    const getLocalEnvironmentBearerToken = vi
      .fn()
      .mockResolvedValueOnce("paired")
      .mockResolvedValueOnce("google");
    window.desktopBridge = { getLocalEnvironmentBearerToken } as unknown as DesktopBridge;
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("paired");
    resetDesktopPrimaryBearerToken();
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("google");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(2);
  });

  it("does not request a network bearer token for the direct native desktop", async () => {
    const getLocalEnvironmentBearerToken = vi.fn();
    Object.assign(window, {
      location: new URL("t3code-dev://app/control-center"),
      desktopBridge: {
        directRpc: {},
        getLocalEnvironmentBearerToken,
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            runningDistro: null,
            directRpc: true,
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
          },
        ],
      },
    });
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
    expect(getLocalEnvironmentBearerToken).not.toHaveBeenCalled();
  });
});
