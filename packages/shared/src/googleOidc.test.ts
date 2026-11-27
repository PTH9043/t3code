import { describe, expect, it, vi } from "vite-plus/test";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  createGoogleOidcRequest,
  exchangeGoogleOidcCodeDetailed,
  revokeGoogleToken,
} from "./googleOidc.ts";

describe("googleOidc multi-account & Drive scope extensions", () => {
  it("defaults prompt=select_account and supports loginHint, extraScopes, and offline access", async () => {
    const req = await createGoogleOidcRequest({
      clientId: "client-123.apps.googleusercontent.com",
      redirectUri: "http://127.0.0.1:43210/oauth2/callback",
      loginHint: "ultra@example.com",
      extraScopes: [GOOGLE_DRIVE_FILE_SCOPE],
      accessType: "offline",
      prompt: "select_account consent",
    });

    const parsed = new URL(req.authorizationUrl);
    expect(parsed.searchParams.get("prompt")).toBe("select_account consent");
    expect(parsed.searchParams.get("login_hint")).toBe("ultra@example.com");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("scope")).toContain("openid email profile");
    expect(parsed.searchParams.get("scope")).toContain(GOOGLE_DRIVE_FILE_SCOPE);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("includes optional client_secret during code exchange and returns refresh_token when present", async () => {
    const req = await createGoogleOidcRequest({
      clientId: "client-123.apps.googleusercontent.com",
      redirectUri: "http://127.0.0.1:43210/oauth2/callback",
    });

    let capturedBody = "";
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ id_token: "id-tok-abc", refresh_token: "1//refresh-xyz" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const exchanged = await exchangeGoogleOidcCodeDetailed({
      code: "auth-code-1",
      request: req,
      clientSecret: "desktop-secret-999",
      fetcher,
    });

    expect(capturedBody).toContain("client_secret=desktop-secret-999");
    expect(capturedBody).toContain(`code_verifier=${encodeURIComponent(req.verifier)}`);
    expect(exchanged).toEqual({
      idToken: "id-tok-abc",
      refreshToken: "1//refresh-xyz",
    });
  });

  it("sets include_granted_scopes=true for incremental Drive authorization and revokes tokens", async () => {
    const req = await createGoogleOidcRequest({
      clientId: "client-123.apps.googleusercontent.com",
      redirectUri: "http://127.0.0.1:43210/oauth2/callback",
      loginHint: "second@example.com",
      extraScopes: [GOOGLE_DRIVE_FILE_SCOPE],
      accessType: "offline",
      prompt: "consent",
      includeGrantedScopes: true,
    });
    const parsed = new URL(req.authorizationUrl);
    expect(parsed.searchParams.get("include_granted_scopes")).toBe("true");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("login_hint")).toBe("second@example.com");

    let revokedUrl = "";
    let revokedBody = "";
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      revokedUrl = String(url);
      revokedBody = String(init?.body ?? "");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    expect(await revokeGoogleToken({ token: "1//revoke-me", fetcher })).toBe(true);
    expect(revokedUrl).toBe("https://oauth2.googleapis.com/revoke");
    expect(revokedBody).toBe("token=1%2F%2Frevoke-me");
    expect(await revokeGoogleToken({ token: "   ", fetcher })).toBe(false);
  });
});
