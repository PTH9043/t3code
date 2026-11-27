import { describe, expect, it, vi } from "vite-plus/test";
import { GOOGLE_DRIVE_FILE_SCOPE } from "@t3tools/shared/googleOidc";
import {
  authenticateGoogleToT3,
  bindDriveBackupAccountInT3,
  configureGoogleOAuthAppInT3,
  listGoogleAccountsFromT3,
  removeGoogleFromT3,
  revokeGoogleDrivePermissionInT3,
  runServerManagedGoogleOAuthInT3,
  setDefaultGoogleAccountInT3,
} from "./googleSignIn.ts";

describe("desktop googleSignIn multi-account & Drive backup bridge", () => {
  it("reuses stored clientId on second enrollment and passes Drive offline scope + refreshToken", async () => {
    const requests: Array<{ path: string; body?: string }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const bodyStr = typeof init?.body === "string" ? init.body : undefined;
      requests.push({
        path: parsed.pathname + parsed.search,
        ...(bodyStr ? { body: bodyStr } : {}),
      });

      if (parsed.pathname === "/api/auth/google/enroll/challenge") {
        return new Response(
          JSON.stringify({
            challenge: "nonce-1",
            clientId: "saved-client.apps.googleusercontent.com",
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname === "/api/auth/google/enroll") {
        return new Response(
          JSON.stringify({ subject: "sub-ultra", account: { subject: "sub-ultra" } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const authenticate = vi.fn(async (input) => {
      expect(input.clientId).toBe("saved-client.apps.googleusercontent.com");
      expect(input.extraScopes).toEqual([GOOGLE_DRIVE_FILE_SCOPE]);
      expect(input.accessType).toBe("offline");
      expect(input.prompt).toBe("select_account consent");
      return {
        identity: {
          subject: "sub-ultra",
          email: "ultra@example.com",
          expiresAt: "2099-01-01T00:00:00Z",
        },
        idToken: "id-token-1",
        refreshToken: "1//refresh-drive",
      };
    });

    const res = await authenticateGoogleToT3({
      mode: "enroll",
      baseUrl: "http://127.0.0.1:13773/",
      label: "메인 Ultra",
      tier: "ultra",
      linkDriveBackup: true,
      clientSecret: "sec-1",
      bearerToken: "bearer-1",
      fetcher,
      authenticate,
    });

    expect(res.identity.subject).toBe("sub-ultra");
    const enrollReq = requests.find((r) => r.path === "/api/auth/google/enroll");
    expect(enrollReq?.body).toContain('"driveRefreshToken":"1//refresh-drive"');
    expect(enrollReq?.body).toContain('"tier":"ultra"');
    expect(enrollReq?.body).toContain('"label":"메인 Ultra"');
  });

  it("supports listing, setting default, binding Drive backup, and removing single vs all accounts", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      const p = new URL(url).pathname;
      calls.push(p);
      if (p === "/api/auth/google/enrollment") {
        return new Response(
          JSON.stringify({
            registered: true,
            defaultSubject: "sub-1",
            defaultClientId: "cid-1",
            hasClientSecret: true,
            accounts: [
              {
                subject: "sub-1",
                clientId: "cid-1",
                email: "a@example.com",
                driveBackupLinked: true,
                addedAt: "2026-11-27T00:00:00Z",
                isDefault: true,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (p === "/api/auth/google/accounts/default") {
        return new Response(JSON.stringify({ account: { subject: "sub-1" }, accounts: [] }), {
          status: 200,
        });
      }
      if (p === "/api/auth/google/accounts/drive-bind") {
        return new Response(JSON.stringify({ bound: true, email: "a@example.com" }), {
          status: 200,
        });
      }
      if (p === "/api/auth/google/accounts/remove" || p === "/api/auth/google/unenroll") {
        return new Response(JSON.stringify({ removed: true, accounts: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const listed = await listGoogleAccountsFromT3({ baseUrl: "http://127.0.0.1:13773/", fetcher });
    expect(listed.accounts).toHaveLength(1);
    expect(listed.defaultClientId).toBe("cid-1");

    await setDefaultGoogleAccountInT3({
      baseUrl: "http://127.0.0.1:13773/",
      subject: "sub-1",
      fetcher,
    });
    const bound = await bindDriveBackupAccountInT3({
      baseUrl: "http://127.0.0.1:13773/",
      subject: "sub-1",
      fetcher,
    });
    expect(bound).toEqual({ bound: true, email: "a@example.com" });

    expect(
      await removeGoogleFromT3({ baseUrl: "http://127.0.0.1:13773/", subject: "sub-1", fetcher }),
    ).toBe(true);
    expect(await removeGoogleFromT3({ baseUrl: "http://127.0.0.1:13773/", fetcher })).toBe(true);
    expect(calls).toEqual([
      "/api/auth/google/enrollment",
      "/api/auth/google/accounts/default",
      "/api/auth/google/accounts/drive-bind",
      "/api/auth/google/accounts/remove",
      "/api/auth/google/unenroll",
    ]);
  });

  it("supports server-managed OAuth config, adding accounts, incremental Drive permission, and revoking Drive", async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      requests.push({ path, ...(body ? { body } : {}) });

      if (path === "/api/auth/google/oauth/config") {
        return new Response(
          JSON.stringify({ configured: true, clientId: "cid-app", hasClientSecret: true }),
          { status: 200 },
        );
      }
      if (path === "/api/auth/google/oauth/start") {
        return new Response(
          JSON.stringify({
            challenge: "chal-2",
            clientId: "cid-app",
            ...(body?.subject === "sub-2" ? { loginHint: "two@example.com" } : {}),
          }),
          { status: 200 },
        );
      }
      if (path === "/api/auth/google/oauth/exchange") {
        return new Response(
          JSON.stringify({
            subject: "sub-2",
            account: {
              subject: "sub-2",
              clientId: "cid-app",
              email: "two@example.com",
              driveBackupLinked: Boolean(body?.grantDrive),
              addedAt: "2026-11-27T00:00:00Z",
              isDefault: false,
            },
          }),
          { status: 200 },
        );
      }
      if (path === "/api/auth/google/accounts/drive-revoke") {
        return new Response(
          JSON.stringify({
            revoked: true,
            accounts: [
              {
                subject: "sub-2",
                clientId: "cid-app",
                email: "two@example.com",
                driveBackupLinked: false,
                addedAt: "2026-11-27T00:00:00Z",
                isDefault: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const cfg = await configureGoogleOAuthAppInT3({
      baseUrl: "http://127.0.0.1:13773/",
      clientId: "cid-app",
      clientSecret: "sec-app",
      bearerToken: "tok-1",
      fetcher,
    });
    expect(cfg).toEqual({ configured: true, clientId: "cid-app", hasClientSecret: true });

    const receiveCode = vi.fn(async (codeInput) => {
      if (codeInput.accessType === "offline") {
        expect(codeInput.prompt).toBe("consent");
        expect(codeInput.loginHint).toBe("two@example.com");
        expect(codeInput.extraScopes).toEqual([GOOGLE_DRIVE_FILE_SCOPE]);
        expect(codeInput.includeGrantedScopes).toBe(true);
      } else {
        expect(codeInput.prompt).toBe("select_account");
        expect(codeInput.includeGrantedScopes).toBe(true);
      }
      return {
        code: "auth-code-9",
        codeVerifier: "verifier-9",
        redirectUri: "http://127.0.0.1:45678/oauth2/callback",
      };
    });

    const added = await runServerManagedGoogleOAuthInT3({
      baseUrl: "http://127.0.0.1:13773/",
      bearerToken: "tok-1",
      fetcher,
      receiveCode,
    });
    expect(added.subject).toBe("sub-2");
    expect(added.driveBackupLinked).toBe(false);

    const granted = await runServerManagedGoogleOAuthInT3({
      baseUrl: "http://127.0.0.1:13773/",
      subject: "sub-2",
      grantDrive: true,
      bearerToken: "tok-1",
      fetcher,
      receiveCode,
    });
    expect(granted.driveBackupLinked).toBe(true);

    const revoked = await revokeGoogleDrivePermissionInT3({
      baseUrl: "http://127.0.0.1:13773/",
      subject: "sub-2",
      bearerToken: "tok-1",
      fetcher,
    });
    expect(revoked.revoked).toBe(true);
    expect(revoked.accounts[0]?.driveBackupLinked).toBe(false);
    expect(requests.map((r) => r.path)).toEqual([
      "/api/auth/google/oauth/config",
      "/api/auth/google/oauth/start",
      "/api/auth/google/oauth/exchange",
      "/api/auth/google/oauth/start",
      "/api/auth/google/oauth/exchange",
      "/api/auth/google/accounts/drive-revoke",
    ]);
  });
});
