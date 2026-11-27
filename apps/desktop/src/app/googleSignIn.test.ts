import { describe, expect, it, vi } from "vite-plus/test";

import {
  authenticateGoogleToT3,
  createGoogleSignInController,
  googleEnrollmentStatus,
  type signInWithGoogle,
} from "./googleSignIn.ts";

describe("desktop Google sign-in controller", () => {
  it("rejects concurrent attempts, cancels the active attempt, and allows a retry", async () => {
    const authenticate: typeof signInWithGoogle = async ({ signal }) =>
      await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    const controller = createGoogleSignInController(authenticate);
    const input = { clientId: "test-client", openExternal: async () => true };

    const first = controller.start(input);
    await expect(controller.start(input)).rejects.toThrow("이미 진행 중");
    controller.cancel();
    await expect(first).rejects.toThrow("cancelled");

    const second = controller.start(input);
    controller.cancel();
    await expect(second).rejects.toThrow("cancelled");
  });

  it("keeps only a verified, unexpired identity and clears it on sign-out", async () => {
    const identity = { subject: "google-subject", expiresAt: "2099-01-01T00:00:00.000Z" };
    const controller = createGoogleSignInController(async () => identity);
    const input = { clientId: "test-client", openExternal: async () => true };
    expect(controller.status()).toBeNull();
    await expect(controller.start(input)).resolves.toEqual(identity);
    expect(controller.status()).toEqual(identity);
    controller.signOut();
    expect(controller.status()).toBeNull();

    const expired = createGoogleSignInController(async () => ({
      subject: "expired-subject",
      expiresAt: "2000-01-01T00:00:00.000Z",
    }));
    await expired.start(input);
    expect(expired.status()).toBeNull();
  });
});

describe("Google authentication to T3", () => {
  const identity = { subject: "subject-1", expiresAt: "2099-01-01T00:00:00.000Z" };

  it("enrolls with the same paired session and binds Google login to the server challenge", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ clientId: "client", challenge: "nonce" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ subject: "subject-1" })));
    const authenticate = vi.fn(async () => ({ identity, idToken: "google-token" }));
    await expect(
      authenticateGoogleToT3({
        mode: "enroll",
        baseUrl: "http://127.0.0.1:3000",
        clientId: "client",
        bearerToken: "paired-session",
        fetcher,
        authenticate,
      }),
    ).resolves.toEqual({ identity });
    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "client", nonce: "nonce" }),
    );
    expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/auth/google/enroll/challenge",
      "/api/auth/google/enroll",
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init.headers.authorization).toBe("Bearer paired-session");
      expect(init.redirect).toBe("error");
    }
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
      challenge: "nonce",
      idToken: "google-token",
    });
  });

  it("exchanges the registered identity for an environment session without a pairing credential", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ clientId: "client", challenge: "nonce" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "server-bearer" })));
    const authenticate = vi.fn(async () => ({ identity, idToken: "google-token" }));
    await expect(
      authenticateGoogleToT3({
        mode: "login",
        baseUrl: "http://127.0.0.1:3000",
        fetcher,
        authenticate,
      }),
    ).resolves.toEqual({ identity, accessToken: "server-bearer" });
    expect(fetcher.mock.calls[1]![0]).toBe("http://127.0.0.1:3000/api/auth/google/token");
    expect(fetcher.mock.calls[1]![1].credentials).toBe("include");
    expect(fetcher.mock.calls[1]![1].headers.authorization).toBeUndefined();
  });

  it("registers using the current browser session without replacing its privileges", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ clientId: "client", challenge: "nonce" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ subject: "subject-1" })));
    await authenticateGoogleToT3({
      mode: "enroll",
      baseUrl: "t3code://app/",
      clientId: "client",
      fetcher,
      authenticate: async () => ({ identity, idToken: "google-token" }),
    });
    expect(fetcher.mock.calls[0]![0]).toBe("t3code://app/api/auth/google/enroll/challenge");
    expect(fetcher.mock.calls[0]![1].credentials).toBe("include");
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBeUndefined();
  });

  it("reads the server enrollment state through the current authenticated session", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ registered: true })));
    await expect(
      googleEnrollmentStatus({ baseUrl: "http://127.0.0.1:3000", bearerToken: "paired", fetcher }),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/auth/google/enrollment",
      expect.objectContaining({ headers: { authorization: "Bearer paired" } }),
    );
  });

  it("rejects changed client IDs and mismatched enrolled subjects", async () => {
    const authenticate = vi.fn(async () => ({ identity, idToken: "google-token" }));
    const changedClient = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ clientId: "other", challenge: "nonce" })),
      );
    await expect(
      authenticateGoogleToT3({
        mode: "enroll",
        baseUrl: "http://127.0.0.1",
        clientId: "client",
        bearerToken: "paired",
        fetcher: changedClient,
        authenticate,
      }),
    ).rejects.toThrow();
    expect(authenticate).not.toHaveBeenCalled();
    const wrongSubject = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ clientId: "client", challenge: "nonce" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ subject: "other" })));
    await expect(
      authenticateGoogleToT3({
        mode: "enroll",
        baseUrl: "http://127.0.0.1",
        clientId: "client",
        bearerToken: "paired",
        fetcher: wrongSubject,
        authenticate,
      }),
    ).rejects.toThrow();
  });
});
