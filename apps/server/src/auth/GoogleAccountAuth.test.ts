import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { createGoogleAccountAuth, matchesEnrolledGoogleAccount } from "./GoogleAccountAuth.ts";

describe("Google account login challenge", () => {
  it("binds a verified Google identity to the issuing session and permits one use", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const auth = createGoogleAccountAuth({ keyResolver: async () => publicKey });
    const issued = auth.challenge("client-a", "owner-session");
    const token = signedToken(privateKey, issued.challenge, "client-a");
    const verified = await auth.verify({
      challenge: issued.challenge,
      idToken: token,
      ownerSessionId: "owner-session",
    });
    expect(verified.identity.subject).toBe("account-a");
    expect(
      matchesEnrolledGoogleAccount(
        { clientId: "client-a", subject: "account-a", scopes: [] },
        verified.clientId,
        verified.identity.subject,
      ),
    ).toBe(true);
    expect(
      matchesEnrolledGoogleAccount(
        { clientId: "client-a", subject: "account-b", scopes: [] },
        verified.clientId,
        verified.identity.subject,
      ),
    ).toBe(false);
    expect(matchesEnrolledGoogleAccount(null, verified.clientId, verified.identity.subject)).toBe(
      false,
    );
    await expect(
      auth.verify({ challenge: issued.challenge, idToken: token, ownerSessionId: "owner-session" }),
    ).rejects.toThrow();
  });

  it("rejects wrong session, subject or audience, tampering and expiry", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let now = 0;
    const auth = createGoogleAccountAuth({ keyResolver: async () => publicKey, now: () => now });
    const first = auth.challenge("client-a", "owner-session");
    const firstToken = signedToken(privateKey, first.challenge, "client-a");
    await expect(
      auth.verify({ challenge: first.challenge, idToken: firstToken, ownerSessionId: null }),
    ).rejects.toThrow();
    await expect(
      auth.verify({
        challenge: first.challenge,
        idToken: firstToken,
        ownerSessionId: "owner-session",
      }),
    ).resolves.toMatchObject({ identity: { subject: "account-a" } });
    await expect(
      auth.verify({
        challenge: first.challenge,
        idToken: firstToken,
        ownerSessionId: "owner-session",
      }),
    ).rejects.toThrow();
    const second = auth.challenge("client-a", null);
    await expect(
      auth.verify({
        challenge: second.challenge,
        idToken: signedToken(privateKey, second.challenge, "other"),
        ownerSessionId: null,
      }),
    ).rejects.toThrow();
    await expect(
      auth.verify({
        challenge: `${second.challenge}bad`,
        idToken: firstToken,
        ownerSessionId: null,
      }),
    ).rejects.toThrow();
    await expect(
      auth.verify({
        challenge: second.challenge,
        idToken: signedToken(privateKey, second.challenge, "client-a"),
        ownerSessionId: null,
        expectedSubject: "account-b",
      }),
    ).rejects.toThrow();
    const third = auth.challenge("client-a", null);
    const thirdToken = signedToken(privateKey, third.challenge, "client-a");
    now = 5 * 60 * 1000;
    await expect(
      auth.verify({ challenge: third.challenge, idToken: thirdToken, ownerSessionId: null }),
    ).rejects.toThrow();
  });
});

function signedToken(key: import("node:crypto").KeyObject, nonce: string, aud: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // @effect-diagnostics-next-line globalDate:off -- JWT expiry must use the verifier's real clock.
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid: "test" })}.${encode({ iss: "https://accounts.google.com", sub: "account-a", aud, nonce, iat: now, exp: now + 300 })}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}
