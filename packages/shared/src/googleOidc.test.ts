import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createGoogleOidcRequest,
  exchangeGoogleOidcCode,
  readGoogleOidcCallback,
  verifyGoogleOidcIdentity,
} from "./googleOidc.ts";

const clientId = "test-client.apps.googleusercontent.com";
const redirectUri = "http://127.0.0.1:43121/oauth2/callback";

describe("Google desktop OpenID Connect", () => {
  it("binds the Google authorization request to the server-issued nonce", async () => {
    const request = await createGoogleOidcRequest({
      clientId,
      redirectUri,
      nonce: "server-challenge",
    });
    expect(request.nonce).toBe("server-challenge");
    expect(new URL(request.authorizationUrl).searchParams.get("nonce")).toBe("server-challenge");
    await expect(createGoogleOidcRequest({ clientId, redirectUri, nonce: "" })).rejects.toThrow();
  });
  it("creates independent state, nonce, and S256 PKCE values for each request", async () => {
    const request = await createGoogleOidcRequest({ clientId, redirectUri });
    const other = await createGoogleOidcRequest({ clientId, redirectUri });
    const url = new URL(request.authorizationUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe(request.state);
    expect(url.searchParams.get("nonce")).toBe(request.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(request.verifier),
    );
    expect(url.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
    expect(new Set([request.state, request.nonce, request.verifier, other.state]).size).toBe(4);
    expect(url.href).not.toContain(request.verifier);
  });

  it("requires a loopback redirect URI and a client ID", async () => {
    await expect(createGoogleOidcRequest({ clientId: "", redirectUri })).rejects.toThrow();
    await expect(
      createGoogleOidcRequest({ clientId, redirectUri: "https://example.com/callback" }),
    ).rejects.toThrow();
    await expect(
      createGoogleOidcRequest({ clientId, redirectUri: "http://127.0.0.1/callback" }),
    ).rejects.toThrow();
  });

  it("accepts only a callback with the expected path and exactly one matching state and code", async () => {
    const request = await createGoogleOidcRequest({ clientId, redirectUri });
    const callback = new URL(redirectUri);
    callback.searchParams.set("state", request.state);
    callback.searchParams.set("code", "one-time-code");
    expect(readGoogleOidcCallback(callback.href, request)).toBe("one-time-code");
    callback.searchParams.append("state", "second-state");
    expect(() => readGoogleOidcCallback(callback.href, request)).toThrow();
    callback.searchParams.delete("state");
    callback.searchParams.set("state", "wrong-state");
    expect(() => readGoogleOidcCallback(callback.href, request)).toThrow();
    callback.searchParams.set("state", request.state);
    callback.pathname = "/wrong";
    expect(() => readGoogleOidcCallback(callback.href, request)).toThrow();
  });

  it("exchanges the code only with Google's token endpoint and does not return other tokens", async () => {
    const request = await createGoogleOidcRequest({ clientId, redirectUri });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id_token: "id-token", access_token: "access-token" }), {
        status: 200,
      }),
    );
    expect(await exchangeGoogleOidcCode({ code: "one-time-code", request, fetcher })).toBe(
      "id-token",
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = options?.body as URLSearchParams;
    expect(body.get("code_verifier")).toBe(request.verifier);
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(body.get("code")).toBe("one-time-code");
  });

  it("verifies the signature, issuer, audience, expiry and nonce before returning identity", async () => {
    const request = await createGoogleOidcRequest({ clientId, redirectUri });
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    const keyResolver = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] });
    const token = (claims: Record<string, unknown> = {}) =>
      new SignJWT({
        nonce: request.nonce,
        email: "person@example.test",
        email_verified: true,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://accounts.google.com")
        .setAudience(clientId)
        .setSubject("google-subject")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const identity = await verifyGoogleOidcIdentity({
      idToken: await token(),
      request,
      keyResolver,
    });
    expect(identity).toMatchObject({
      subject: "google-subject",
      email: "person@example.test",
    });
    expect(Date.parse(identity.expiresAt)).toBeGreaterThan(Date.now());
    await expect(
      verifyGoogleOidcIdentity({ idToken: await token({ nonce: "wrong" }), request, keyResolver }),
    ).rejects.toThrow();
    await expect(
      verifyGoogleOidcIdentity({
        idToken: await token({ azp: "other-client" }),
        request,
        keyResolver,
      }),
    ).rejects.toThrow();
    expect(
      await verifyGoogleOidcIdentity({
        idToken: await token({ email_verified: false }),
        request,
        keyResolver,
      }),
    ).toMatchObject({ subject: "google-subject" });
    await expect(
      verifyGoogleOidcIdentity({
        idToken: await token(),
        request: { ...request, clientId: "another-client" },
        keyResolver,
      }),
    ).rejects.toThrow();
    const expired = await new SignJWT({ nonce: request.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience(clientId)
      .setSubject("google-subject")
      .setIssuedAt()
      .setExpirationTime(1)
      .sign(privateKey);
    await expect(
      verifyGoogleOidcIdentity({ idToken: expired, request, keyResolver }),
    ).rejects.toThrow();
  });
});
