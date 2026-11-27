import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthEnvironmentScope, GoogleAccountTier } from "@t3tools/contracts";
import { verifyGoogleOidcIdentity } from "@t3tools/shared/googleOidc";
import * as Duration from "effect/Duration";

import { DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES } from "./PairingGrantStore.ts";

export interface EnrolledGoogleAccount {
  readonly clientId: string;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly email?: string;
  readonly name?: string;
  readonly label?: string;
  readonly tier?: GoogleAccountTier;
  readonly driveBackupLinked?: boolean;
  readonly addedAt?: string;
  readonly lastUsedAt?: string;
  readonly isDefault?: boolean;
}

/** A valid Google token is not sufficient unless it matches the enrolled account. */
export function matchesEnrolledGoogleAccount(
  account: EnrolledGoogleAccount | null,
  clientId: string,
  subject: string,
): account is EnrolledGoogleAccount {
  return account !== null && account.clientId === clientId && account.subject === subject;
}

/** Looks up a matching enrolled account in a multi-account registry. */
export function findEnrolledGoogleAccount(
  accounts: ReadonlyArray<EnrolledGoogleAccount>,
  clientId: string,
  subject: string,
): EnrolledGoogleAccount | null {
  return (
    accounts.find((account) => account.clientId === clientId && account.subject === subject) ?? null
  );
}

type SignedChallenge = {
  readonly clientId: string;
  readonly ownerBinding: string | null;
  readonly expiresAt: number;
  readonly random: string;
};

/** Issues one-use challenges. Enrollment challenges are tied to the authenticated session. */
export function createGoogleAccountAuth(options?: {
  readonly now?: () => number;
  readonly keyResolver?: Parameters<typeof verifyGoogleOidcIdentity>[0]["keyResolver"];
}) {
  const used = new Map<string, number>();
  const signingKey = randomBytes(32);
  const now = options?.now ?? Date.now;
  const ttl = Duration.toMillis(DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES);
  const mac = (value: string) => createHmac("sha256", signingKey).update(value).digest();
  const ownerBinding = (ownerSessionId: string | null) =>
    ownerSessionId === null ? null : mac(`owner:${ownerSessionId}`).toString("base64url");

  function challenge(clientId: string, ownerSessionId: string | null) {
    const value: SignedChallenge = {
      clientId,
      ownerBinding: ownerBinding(ownerSessionId),
      expiresAt: now() + ttl,
      random: randomBytes(32).toString("base64url"),
    };
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    const nonce = `${payload}.${mac(payload).toString("base64url")}`;
    return { challenge: nonce, clientId };
  }

  async function verify(input: {
    readonly challenge: string;
    readonly idToken: string;
    readonly ownerSessionId: string | null;
    readonly expectedSubject?: string;
  }) {
    const [payload, signature, ...extra] = input.challenge.split(".");
    if (!payload || !signature || extra.length > 0)
      throw new Error("Invalid Google authentication challenge.");
    const expected = mac(payload);
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Invalid Google authentication challenge.");
    }
    const entry: SignedChallenge = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof entry.clientId !== "string" ||
      typeof entry.expiresAt !== "number" ||
      entry.expiresAt <= now() ||
      entry.ownerBinding !== ownerBinding(input.ownerSessionId)
    ) {
      throw new Error("Invalid Google authentication challenge.");
    }
    const identity = await verifyGoogleOidcIdentity({
      idToken: input.idToken,
      request: {
        clientId: entry.clientId,
        nonce: input.challenge,
        redirectUri: "",
        state: "",
        verifier: "",
        authorizationUrl: "",
      },
      ...(options?.keyResolver ? { keyResolver: options.keyResolver } : {}),
    });
    if (input.expectedSubject !== undefined && identity.subject !== input.expectedSubject) {
      throw new Error("Google account is not enrolled.");
    }
    for (const [nonce, expiresAt] of used) if (expiresAt <= now()) used.delete(nonce);
    if (entry.expiresAt <= now() || used.has(input.challenge)) {
      throw new Error("Google authentication challenge was used or expired.");
    }
    used.set(input.challenge, entry.expiresAt);
    return { identity, clientId: entry.clientId };
  }

  return { challenge, verify };
}
