import { HttpClientError, HttpClientRequest } from "effect/unstable/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PrimaryEnvironmentRequestError, retryTransientBootstrap } from "./auth";
import {
  isDesktopEnvironmentBootstrapPendingError,
  isPrimaryEnvironmentProtocolUnsupportedError,
  readPrimaryEnvironmentTarget,
} from "./target";

function transportFailure(): HttpClientError.HttpClientError {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: HttpClientRequest.get("http://127.0.0.1:13773/api/auth/session"),
      description: "Failed to fetch",
    }),
  });
}

function wrap(cause: unknown): PrimaryEnvironmentRequestError {
  return PrimaryEnvironmentRequestError.fromCause({
    operation: "fetch-session-state",
    cause,
  });
}

describe("retryTransientBootstrap", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries a wrapped transport failure until the backend answers", async () => {
    let attempts = 0;
    const result = await retryTransientBootstrap(async () => {
      attempts += 1;
      if (attempts < 3) {
        // Every call site wraps before the retry loop sees the failure, so the
        // wrapper is what the classifier has to look through.
        throw wrap(transportFailure());
      }
      return "session";
    });

    expect(result).toBe("session");
    expect(attempts).toBe(3);
  });

  it("retries a wrapped bootstrap-not-published failure", async () => {
    let attempts = 0;
    const result = await retryTransientBootstrap(async () => {
      attempts += 1;
      if (attempts < 2) {
        vi.stubGlobal("window", {
          location: { origin: "t3code-dev://app" },
          desktopBridge: { getLocalEnvironmentBootstraps: () => [] },
        });
        try {
          readPrimaryEnvironmentTarget();
        } catch (error) {
          throw wrap(error);
        }
      }
      return "session";
    });

    expect(result).toBe("session");
    expect(attempts).toBe(2);
  });

  it("does not retry a failure that is not transport-level", async () => {
    let attempts = 0;
    const failure = wrap(new Error("boom"));

    await expect(
      retryTransientBootstrap(async () => {
        attempts += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});

describe("readPrimaryEnvironmentTarget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a desktop bootstrap that has not been published yet as pending", () => {
    vi.stubGlobal("window", {
      location: { origin: "t3code-dev://app" },
      desktopBridge: { getLocalEnvironmentBootstraps: () => [] },
    });

    let thrown: unknown;
    try {
      readPrimaryEnvironmentTarget();
    } catch (error) {
      thrown = error;
    }

    expect(isDesktopEnvironmentBootstrapPendingError(thrown)).toBe(true);
  });

  it("keeps reporting an unsupported window origin outside the desktop shell", () => {
    vi.stubGlobal("window", {
      location: { origin: "file:///tmp/t3code/" },
    });

    let thrown: unknown;
    try {
      readPrimaryEnvironmentTarget();
    } catch (error) {
      thrown = error;
    }

    expect(isPrimaryEnvironmentProtocolUnsupportedError(thrown)).toBe(true);
  });
});
