import { generateKeyPairSync, sign } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthAccessWriteScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpApiTest } from "effect/unstable/httpapi";
import { describe, expect, it, vi } from "vite-plus/test";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { createGoogleAccountAuth } from "./GoogleAccountAuth.ts";
import { makeAuthHttpApiLayer } from "./http.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

function makeSignedGoogleIdToken(input: {
  readonly privateKey: import("node:crypto").KeyObject;
  readonly aud: string;
  readonly nonce: string;
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // @effect-diagnostics-next-line globalDate:off -- JWT exp/iat must match real verifier clock.
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", kid: "test-key" });
  const payload = encode({
    iss: "https://accounts.google.com",
    sub: input.sub,
    aud: input.aud,
    nonce: input.nonce,
    email: input.email,
    email_verified: true,
    name: input.name,
    iat: now,
    exp: now + 300,
  });
  const body = `${header}.${payload}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), input.privateKey).toString("base64url")}`;
}

function makeMemorySecretStore() {
  const store = new Map<string, Uint8Array>();
  const layer = Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) => Effect.sync(() => Option.fromNullishOr(store.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        store.set(name, new Uint8Array(value));
      }),
    create: (name, value) =>
      Effect.sync(() => {
        store.set(name, new Uint8Array(value));
      }),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = store.get(name);
        if (existing) return existing;
        const created = new Uint8Array(bytes).fill(7);
        store.set(name, created);
        return created;
      }),
    remove: (name) =>
      Effect.sync(() => {
        store.delete(name);
      }),
  });
  return { store, layer };
}

describe("authHttpApiLayer multi-Google OAuth & 1-click Drive permission flow", () => {
  it("stores OAuth app config in DPAPI, supports 2+ simultaneous Google accounts, incremental Drive grant, switch, and revoke while keeping login", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { store, layer: secretStoreLayer } = makeMemorySecretStore();
    const exchangedCalls: Array<{
      readonly code: string;
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly redirectUri: string;
    }> = [];
    const revokedTokens: Array<string> = [];

    const codeToAccount = new Map<
      string,
      {
        readonly sub: string;
        readonly email: string;
        readonly name: string;
        readonly refreshToken?: string;
      }
    >([
      ["code-first", { sub: "sub-1", email: "first@example.com", name: "First User" }],
      ["code-second", { sub: "sub-2", email: "second@example.com", name: "Second User" }],
      [
        "code-second-drive",
        {
          sub: "sub-2",
          email: "second@example.com",
          name: "Second User",
          refreshToken: "1//drive-refresh-sub-2",
        },
      ],
      [
        "code-first-drive",
        {
          sub: "sub-1",
          email: "first@example.com",
          name: "First User",
          refreshToken: "1//drive-refresh-sub-1",
        },
      ],
    ]);

    const authMiddleware: Context.Service.Shape<typeof EnvironmentAuthenticatedAuth> = (
      httpEffect,
    ) =>
      httpEffect.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, {
          sessionId: AuthSessionId.make("admin-session-1"),
          subject: "desktop-admin",
          method: "bearer-access-token",
          scopes: new Set<AuthEnvironmentScope>([AuthAccessWriteScope]),
          expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
        }),
      );

    const authApiLayer = makeAuthHttpApiLayer({
      createGoogleAuth: () => createGoogleAccountAuth({ keyResolver: async () => publicKey }),
      exchangeGoogleCode: vi.fn(async (input) => {
        exchangedCalls.push({
          code: input.code,
          clientId: input.request.clientId,
          ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
          redirectUri: input.request.redirectUri,
        });
        const entry = codeToAccount.get(input.code);
        if (!entry) throw new Error("unexpected test code");
        const idToken = makeSignedGoogleIdToken({
          privateKey,
          aud: input.request.clientId,
          nonce: input.request.nonce,
          sub: entry.sub,
          email: entry.email,
          name: entry.name,
        });
        return {
          idToken,
          ...(entry.refreshToken ? { refreshToken: entry.refreshToken } : {}),
        };
      }),
      revokeGoogleToken: vi.fn(async ({ token }) => {
        revokedTokens.push(token);
        return true;
      }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(EnvironmentHttpApi, ["auth"]);

        // 1. Initial unconfigured state
        const initial = yield* client.auth.googleEnrollment({ headers: {} });
        expect(initial.registered).toBe(false);
        expect(initial.oauthConfigured).toBe(false);
        expect(initial.activeDriveSubject).toBeNull();
        expect(initial.accounts).toEqual([]);

        // 2. Save OAuth app config once into DPAPI
        const savedCfg = yield* client.auth.googleOAuthConfig({
          headers: {},
          payload: {
            clientId: "desktop-app.apps.googleusercontent.com",
            clientSecret: "GOCSPX-test-secret",
          },
        });
        expect(savedCfg).toEqual({
          configured: true,
          clientId: "desktop-app.apps.googleusercontent.com",
          hasClientSecret: true,
        });

        // 3. Log in 1st Google account (no Drive scope yet)
        const start1 = yield* client.auth.googleOAuthStart({ headers: {}, payload: {} });
        expect(start1.clientId).toBe("desktop-app.apps.googleusercontent.com");
        const ex1 = yield* client.auth.googleOAuthExchange({
          headers: {},
          payload: {
            challenge: start1.challenge,
            code: "code-first",
            codeVerifier: "verifier-1",
            redirectUri: "http://127.0.0.1:41001/oauth2/callback",
          },
        });
        expect(ex1.account.email).toBe("first@example.com");
        expect(ex1.account.isDefault).toBe(true);
        expect(ex1.account.driveBackupLinked).toBe(false);

        // 4. Log in 2nd Google account simultaneously (1st remains logged in)
        const start2 = yield* client.auth.googleOAuthStart({ headers: {}, payload: {} });
        const ex2 = yield* client.auth.googleOAuthExchange({
          headers: {},
          payload: {
            challenge: start2.challenge,
            code: "code-second",
            codeVerifier: "verifier-2",
            redirectUri: "http://127.0.0.1:41002/oauth2/callback",
          },
        });
        expect(ex2.account.email).toBe("second@example.com");
        expect(ex2.account.isDefault).toBe(false);

        const afterTwo = yield* client.auth.googleEnrollment({ headers: {} });
        expect(afterTwo.accounts.map((a) => a.email)).toEqual([
          "first@example.com",
          "second@example.com",
        ]);
        expect(afterTwo.activeDriveSubject).toBeNull();

        // 5. Grant Drive permission on 2nd account via incremental OAuth
        const startDrive2 = yield* client.auth.googleOAuthStart({
          headers: {},
          payload: { subject: "sub-2", grantDrive: true },
        });
        expect(startDrive2.loginHint).toBe("second@example.com");
        const granted2 = yield* client.auth.googleOAuthExchange({
          headers: {},
          payload: {
            challenge: startDrive2.challenge,
            code: "code-second-drive",
            codeVerifier: "verifier-3",
            redirectUri: "http://127.0.0.1:41003/oauth2/callback",
            grantDrive: true,
          },
        });
        expect(granted2.account.driveBackupLinked).toBe(true);

        // Verify server used stored DPAPI clientSecret automatically & saved primary Drive secret
        expect(exchangedCalls[2]?.clientSecret).toBe("GOCSPX-test-secret");
        const primaryDriveRaw = store.get("drive_backup_gdrive_oauth");
        expect(primaryDriveRaw).toBeDefined();
        const decodeDrivePayload = Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              clientSecret: Schema.String,
              refreshToken: Schema.String,
              connectedEmail: Schema.String,
              subject: Schema.String,
            }),
          ),
        );
        const primaryDriveParsed = yield* decodeDrivePayload(
          new TextDecoder().decode(primaryDriveRaw!),
        );
        expect(primaryDriveParsed.refreshToken).toBe("1//drive-refresh-sub-2");
        expect(primaryDriveParsed.subject).toBe("sub-2");

        const afterGrant2 = yield* client.auth.googleEnrollment({ headers: {} });
        expect(afterGrant2.activeDriveSubject).toBe("sub-2");
        expect(afterGrant2.accounts).toHaveLength(2);

        // 6. Grant Drive on 1st account and switch active Drive backup target back to 2nd
        const startDrive1 = yield* client.auth.googleOAuthStart({
          headers: {},
          payload: { subject: "sub-1", grantDrive: true },
        });
        yield* client.auth.googleOAuthExchange({
          headers: {},
          payload: {
            challenge: startDrive1.challenge,
            code: "code-first-drive",
            codeVerifier: "verifier-4",
            redirectUri: "http://127.0.0.1:41004/oauth2/callback",
            grantDrive: true,
          },
        });
        expect((yield* client.auth.googleEnrollment({ headers: {} })).activeDriveSubject).toBe(
          "sub-1",
        );

        const rebound = yield* client.auth.googleBindDriveBackupAccount({
          headers: {},
          payload: { subject: "sub-2" },
        });
        expect(rebound).toEqual({ bound: true, email: "second@example.com" });
        expect((yield* client.auth.googleEnrollment({ headers: {} })).activeDriveSubject).toBe(
          "sub-2",
        );

        // 7. Revoke Drive permission on 2nd account — revokes token, clears primary, keeps login!
        const revoked = yield* client.auth.googleRevokeDriveAccount({
          headers: {},
          payload: { subject: "sub-2" },
        });
        expect(revoked.revoked).toBe(true);
        expect(revokedTokens).toEqual(["1//drive-refresh-sub-2"]);
        expect(store.has("drive_backup_gdrive_oauth_sub-2")).toBe(false);
        expect(store.has("drive_backup_gdrive_oauth")).toBe(false);
        expect(revoked.accounts).toHaveLength(2);
        expect(revoked.accounts.find((a) => a.subject === "sub-2")?.driveBackupLinked).toBe(false);
        expect(revoked.accounts.find((a) => a.subject === "sub-1")?.driveBackupLinked).toBe(true);

        // 8. Non-loopback redirectUri must be rejected
        const startBad = yield* client.auth.googleOAuthStart({ headers: {}, payload: {} });
        const badExit = yield* client.auth
          .googleOAuthExchange({
            headers: {},
            payload: {
              challenge: startBad.challenge,
              code: "code-first",
              codeVerifier: "verifier-bad",
              redirectUri: "https://evil.example/oauth2/callback",
            },
          })
          .pipe(Effect.exit);
        expect(badExit._tag).toBe("Failure");
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          authApiLayer.pipe(
            Layer.provide(
              Layer.succeed(
                Crypto.Crypto,
                Crypto.make({
                  randomBytes: (size) => new Uint8Array(size).fill(3),
                  digest: (_algorithm, data) => Effect.succeed(data),
                }),
              ),
            ),
            Layer.provide(secretStoreLayer),
            Layer.provide(
              Layer.succeed(
                EnvironmentAuth.EnvironmentAuth,
                {} as EnvironmentAuth.EnvironmentAuth["Service"],
              ),
            ),
            Layer.provide(
              Layer.succeed(SessionStore.SessionStore, {} as SessionStore.SessionStore["Service"]),
            ),
          ),
        ]),
        Effect.provideService(EnvironmentAuthenticatedAuth, authMiddleware),
        Effect.scoped,
      ),
    );
  });
});
