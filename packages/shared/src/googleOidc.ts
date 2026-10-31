import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_KEYS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const googleKeys = createRemoteJWKSet(GOOGLE_KEYS_URL);

export interface GoogleOidcRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly authorizationUrl: string;
}

export interface GoogleIdentity {
  readonly subject: string;
  readonly expiresAt: string;
  readonly email?: string;
  readonly name?: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomValue(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function checkRedirectUri(redirectUri: string): string {
  const url = new URL(redirectUri);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Google 로그인 콜백은 포트가 지정된 로컬 주소여야 합니다.");
  }
  return url.href;
}

/** Builds one desktop authorization request. The verifier and nonce stay local. */
export async function createGoogleOidcRequest(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly nonce?: string;
}): Promise<GoogleOidcRequest> {
  const clientId = input.clientId.trim();
  if (!clientId) throw new Error("Google OAuth 클라이언트 ID가 필요합니다.");
  const redirectUri = checkRedirectUri(input.redirectUri);
  const state = randomValue();
  const nonce = input.nonce ?? randomValue();
  if (!nonce) throw new Error("Google 로그인 검증값이 필요합니다.");
  const verifier = randomValue();
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { clientId, redirectUri, state, nonce, verifier, authorizationUrl: url.href };
}

/** Accepts a callback only for the request that created the listening endpoint. */
export function readGoogleOidcCallback(callbackUrl: string, request: GoogleOidcRequest): string {
  const url = new URL(callbackUrl);
  const expected = new URL(request.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash) {
    throw new Error("Google 로그인 응답 주소가 일치하지 않습니다.");
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== request.state) {
    throw new Error("Google 로그인 응답을 확인하지 못했습니다.");
  }
  if (url.searchParams.has("error"))
    throw new Error("Google 로그인이 취소되었거나 거부되었습니다.");
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0]) throw new Error("Google 인증 코드를 받지 못했습니다.");
  return codes[0];
}

/** Exchanges a one-time code without returning Google tokens to the renderer. */
export async function exchangeGoogleOidcCode(input: {
  readonly code: string;
  readonly request: GoogleOidcRequest;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}): Promise<string> {
  const response = await (input.fetcher ?? fetch)(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.request.clientId,
      code: input.code,
      code_verifier: input.request.verifier,
      grant_type: "authorization_code",
      redirect_uri: input.request.redirectUri,
    }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) throw new Error("Google 인증 코드를 교환하지 못했습니다.");
  const body: unknown = await response.json().catch(() => {
    throw new Error("Google 신원 확인 정보를 읽지 못했습니다.");
  });
  if (
    typeof body !== "object" ||
    body === null ||
    !("id_token" in body) ||
    typeof body.id_token !== "string" ||
    !body.id_token
  ) {
    throw new Error("Google 신원 확인 정보를 받지 못했습니다.");
  }
  return body.id_token;
}

/** Verifies Google's signature and binds the identity to this login request. */
export async function verifyGoogleOidcIdentity(input: {
  readonly idToken: string;
  readonly request: GoogleOidcRequest;
  readonly keyResolver?: JWTVerifyGetKey;
}): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(input.idToken, input.keyResolver ?? googleKeys, {
    algorithms: ["RS256"],
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: input.request.clientId,
    requiredClaims: ["iss", "aud", "exp", "iat", "sub", "nonce"],
  });
  if (
    !payload.sub ||
    typeof payload.exp !== "number" ||
    payload.nonce !== input.request.nonce ||
    (payload.azp !== undefined && payload.azp !== input.request.clientId) ||
    (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== input.request.clientId)
  ) {
    throw new Error("Google 신원 확인 정보가 로그인 요청과 일치하지 않습니다.");
  }
  return {
    subject: payload.sub,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    ...(typeof payload.email === "string" && payload.email_verified === true
      ? { email: payload.email }
      : {}),
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
  };
}
