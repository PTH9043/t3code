// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- This controller runs outside Effect and uses a loopback OAuth callback.
import * as NodeHttp from "node:http";

import type {
  EnrolledGoogleAccountSummary,
  GoogleAccountTier,
  GoogleEnrollmentStatusResult,
} from "@t3tools/contracts";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  createGoogleOidcRequest,
  exchangeGoogleOidcCodeDetailed,
  readGoogleOidcCallback,
  verifyGoogleOidcIdentity,
  type GoogleIdentity,
  type GoogleOidcPrompt,
  type GoogleOidcRequest,
} from "@t3tools/shared/googleOidc";

export interface GoogleServerSignInResult {
  readonly identity: GoogleIdentity;
  readonly idToken: string;
  readonly refreshToken?: string;
}

/** Opens the system browser and receives one Google login on loopback. */
async function signInGoogle(input: {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly nonce?: string;
  readonly prompt?: GoogleOidcPrompt;
  readonly loginHint?: string;
  readonly extraScopes?: ReadonlyArray<string>;
  readonly accessType?: "online" | "offline";
}): Promise<GoogleServerSignInResult> {
  if (input.signal?.aborted) throw new Error("Google 로그인이 취소되었습니다.");

  let request: GoogleOidcRequest | undefined;
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codeReceived = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // A cancellation or server failure may arrive while the system browser opens.
  void codeReceived.catch(() => undefined);
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectCode(error);
  };
  const onAbort = () => fail(new Error("Google 로그인이 취소되었습니다."));
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const server = NodeHttp.createServer((incoming, response) => {
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'none'");
    if (!request || settled || incoming.method !== "GET") {
      response.writeHead(400).end("Google 로그인 요청을 확인할 수 없습니다.");
      return;
    }
    const expected = new URL(request.redirectUri);
    if (incoming.headers.host !== expected.host) {
      response.writeHead(400).end("Google 로그인 요청을 확인할 수 없습니다.");
      return;
    }
    let url: URL;
    try {
      url = new URL(incoming.url ?? "", request.redirectUri);
    } catch {
      response.writeHead(400).end("Google 로그인 요청을 확인할 수 없습니다.");
      return;
    }
    const states = url.searchParams.getAll("state");
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      states.length !== 1 ||
      states[0] !== request.state
    ) {
      response.writeHead(400).end("Google 로그인 요청을 확인할 수 없습니다.");
      return;
    }
    try {
      const code = readGoogleOidcCallback(url.href, request);
      settled = true;
      response.writeHead(200).end("인증 응답을 받았습니다. T3로 돌아가세요.");
      server.close();
      resolveCode(code);
    } catch {
      response.writeHead(400).end("Google 로그인이 취소되었거나 응답을 확인할 수 없습니다.");
      fail(new Error("Google 로그인이 취소되었거나 응답을 확인할 수 없습니다."));
      server.close();
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = () =>
        reject(new Error("Google 로그인에 필요한 로컬 연결을 열지 못했습니다."));
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    server.on("error", () => fail(new Error("Google 로그인 로컬 연결이 끊어졌습니다.")));
    if (input.signal?.aborted) throw new Error("Google 로그인이 취소되었습니다.");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Google 로그인 로컬 주소를 확인하지 못했습니다.");
    }
    request = await createGoogleOidcRequest({
      clientId: input.clientId,
      redirectUri: `http://127.0.0.1:${address.port}/oauth2/callback`,
      ...(input.nonce ? { nonce: input.nonce } : {}),
      ...(input.prompt ? { prompt: input.prompt } : { prompt: "select_account" }),
      ...(input.loginHint ? { loginHint: input.loginHint } : {}),
      ...(input.extraScopes ? { extraScopes: input.extraScopes } : {}),
      ...(input.accessType ? { accessType: input.accessType } : {}),
    });
    if (input.signal?.aborted) throw new Error("Google 로그인이 취소되었습니다.");
    const opened = await Promise.race([
      input.openExternal(request.authorizationUrl),
      codeReceived.then(() => true),
    ]);
    if (!opened) {
      throw new Error("Google 로그인을 위한 브라우저를 열지 못했습니다.");
    }
    const code = await codeReceived;
    const exchanged = await exchangeGoogleOidcCodeDetailed({
      code,
      request,
      ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const identity = await verifyGoogleOidcIdentity({ idToken: exchanged.idToken, request });
    if (input.signal?.aborted) throw new Error("Google 로그인이 취소되었습니다.");
    return {
      identity,
      idToken: exchanged.idToken,
      ...(exchanged.refreshToken ? { refreshToken: exchanged.refreshToken } : {}),
    };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    if (server.listening) server.close();
    server.closeAllConnections();
  }
}

export async function signInWithGoogle(input: {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly signal?: AbortSignal;
}): Promise<GoogleIdentity> {
  return (await signInGoogle(input)).identity;
}

/** Returns a verified token for immediate exchange with the T3 server. */
export async function signInWithGoogleForServer(input: {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly nonce: string;
  readonly prompt?: GoogleOidcPrompt;
  readonly loginHint?: string;
  readonly extraScopes?: ReadonlyArray<string>;
  readonly accessType?: "online" | "offline";
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly signal?: AbortSignal;
}): Promise<GoogleServerSignInResult> {
  return signInGoogle(input);
}

export function createGoogleSignInController(
  authenticate: typeof signInWithGoogle = signInWithGoogle,
  authenticateForServer: typeof signInWithGoogleForServer = signInWithGoogleForServer,
) {
  let active: AbortController | undefined;
  let identity: GoogleIdentity | null = null;
  return {
    async start(input: {
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly openExternal: (url: string) => Promise<boolean>;
    }): Promise<GoogleIdentity> {
      if (active) throw new Error("Google 로그인이 이미 진행 중입니다.");
      const controller = new AbortController();
      active = controller;
      try {
        const verified = await authenticate({ ...input, signal: controller.signal });
        if (controller.signal.aborted) throw new Error("Google 로그인이 취소되었습니다.");
        identity = verified;
        return verified;
      } finally {
        if (active === controller) active = undefined;
      }
    },
    async startForServer(input: {
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly nonce: string;
      readonly prompt?: GoogleOidcPrompt;
      readonly loginHint?: string;
      readonly extraScopes?: ReadonlyArray<string>;
      readonly accessType?: "online" | "offline";
      readonly openExternal: (url: string) => Promise<boolean>;
    }): Promise<GoogleServerSignInResult> {
      if (active) throw new Error("Google 로그인이 이미 진행 중입니다.");
      const controller = new AbortController();
      active = controller;
      try {
        const verified = await authenticateForServer({ ...input, signal: controller.signal });
        if (controller.signal.aborted) throw new Error("Google 로그인이 취소되었습니다.");
        identity = verified.identity;
        return verified;
      } finally {
        if (active === controller) active = undefined;
      }
    },
    cancel(): void {
      active?.abort();
    },
    status(): GoogleIdentity | null {
      if (identity && Date.parse(identity.expiresAt) <= Date.now()) identity = null;
      return identity;
    },
    signOut(): void {
      active?.abort();
      identity = null;
    },
  };
}

/** Exchanges the Google token in the main process with the configured T3 backend. */
export async function authenticateGoogleToT3(input: {
  readonly mode: "enroll" | "login";
  readonly baseUrl: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly label?: string;
  readonly tier?: GoogleAccountTier;
  readonly linkDriveBackup?: boolean;
  readonly subject?: string;
  readonly loginHint?: string;
  readonly bearerToken?: string;
  readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
  readonly authenticate: (input: {
    readonly clientId: string;
    readonly nonce: string;
    readonly clientSecret?: string;
    readonly prompt?: GoogleOidcPrompt;
    readonly loginHint?: string;
    readonly extraScopes?: ReadonlyArray<string>;
    readonly accessType?: "online" | "offline";
  }) => Promise<GoogleServerSignInResult>;
}): Promise<{ readonly identity: GoogleIdentity; readonly accessToken?: string }> {
  const request = async (path: string, body?: Record<string, unknown>) => {
    const response = await input.fetcher(new URL(path, input.baseUrl).href, {
      method: "POST",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(input.mode === "enroll" && input.bearerToken
          ? { authorization: `Bearer ${input.bearerToken}` }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: "include",
      redirect: "error",
    });
    if (!response.ok) throw new Error("T3 Google 인증 요청에 실패했습니다.");
    return (await response.json()) as unknown;
  };

  const challengePath =
    input.mode === "enroll"
      ? "/api/auth/google/enroll/challenge"
      : input.subject
        ? `/api/auth/google/challenge?subject=${encodeURIComponent(input.subject)}`
        : "/api/auth/google/challenge";

  const start = await request(
    challengePath,
    input.mode === "enroll"
      ? input.clientId?.trim()
        ? { clientId: input.clientId.trim() }
        : {}
      : undefined,
  );
  if (
    typeof start !== "object" ||
    start === null ||
    !("challenge" in start) ||
    typeof start.challenge !== "string" ||
    !start.challenge ||
    !("clientId" in start) ||
    typeof start.clientId !== "string" ||
    !start.clientId ||
    (input.mode === "enroll" && input.clientId?.trim() && start.clientId !== input.clientId.trim())
  ) {
    throw new Error("T3 Google 인증 요청을 확인하지 못했습니다.");
  }

  const linkDrive = input.mode === "enroll" && input.linkDriveBackup === true;
  const verified = await input.authenticate({
    clientId: start.clientId,
    nonce: start.challenge,
    ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
    prompt: linkDrive ? "select_account consent" : "select_account",
    ...(input.loginHint ? { loginHint: input.loginHint } : {}),
    ...(linkDrive
      ? { extraScopes: [GOOGLE_DRIVE_FILE_SCOPE], accessType: "offline" as const }
      : {}),
  });

  const payload: Record<string, unknown> = {
    challenge: start.challenge,
    idToken: verified.idToken,
    ...(input.mode === "enroll" && input.label?.trim() ? { label: input.label.trim() } : {}),
    ...(input.mode === "enroll" && input.tier ? { tier: input.tier } : {}),
    ...(input.mode === "enroll" && input.clientSecret?.trim()
      ? { clientSecret: input.clientSecret.trim() }
      : {}),
    ...(input.mode === "enroll" && verified.refreshToken
      ? { driveRefreshToken: verified.refreshToken }
      : {}),
  };

  const result = await request(
    input.mode === "enroll" ? "/api/auth/google/enroll" : "/api/auth/google/token",
    payload,
  );
  if (
    typeof result !== "object" ||
    result === null ||
    (input.mode === "enroll"
      ? !("subject" in result) || result.subject !== verified.identity.subject
      : !("access_token" in result) ||
        typeof result.access_token !== "string" ||
        !result.access_token)
  ) {
    throw new Error("T3 Google 인증 결과를 확인하지 못했습니다.");
  }
  return {
    identity: verified.identity,
    ...(input.mode === "login" &&
    "access_token" in result &&
    typeof result.access_token === "string"
      ? { accessToken: result.access_token }
      : {}),
  };
}

export async function removeGoogleFromT3(input: {
  readonly baseUrl: string;
  readonly subject?: string;
  readonly bearerToken?: string;
  readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<boolean> {
  const path = input.subject ? "/api/auth/google/accounts/remove" : "/api/auth/google/unenroll";
  const response = await input.fetcher(new URL(path, input.baseUrl).href, {
    method: "POST",
    headers: {
      ...(input.subject ? { "content-type": "application/json" } : {}),
      ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
    },
    ...(input.subject ? { body: JSON.stringify({ subject: input.subject }) } : {}),
    credentials: "include",
    redirect: "error",
  });
  if (!response.ok) throw new Error("T3 Google 연결을 해제하지 못했습니다.");
  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("removed" in result) ||
    typeof result.removed !== "boolean"
  ) {
    throw new Error("T3 Google 연결 해제 결과를 확인하지 못했습니다.");
  }
  return result.removed;
}

export async function listGoogleAccountsFromT3(input: {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<GoogleEnrollmentStatusResult> {
  const response = await input.fetcher(new URL("/api/auth/google/enrollment", input.baseUrl).href, {
    method: "GET",
    ...(input.bearerToken ? { headers: { authorization: `Bearer ${input.bearerToken}` } } : {}),
    credentials: "include",
    redirect: "error",
  });
  if (!response.ok) throw new Error("T3 Google 계정 목록을 확인하지 못했습니다.");
  const result = (await response.json()) as Partial<GoogleEnrollmentStatusResult>;
  if (typeof result !== "object" || result === null || typeof result.registered !== "boolean") {
    throw new Error("T3 Google 등록 상태를 확인하지 못했습니다.");
  }
  return {
    registered: result.registered,
    accounts: Array.isArray(result.accounts) ? result.accounts : [],
    defaultSubject: typeof result.defaultSubject === "string" ? result.defaultSubject : null,
    defaultClientId: typeof result.defaultClientId === "string" ? result.defaultClientId : null,
    hasClientSecret: Boolean(result.hasClientSecret),
  };
}

export async function googleEnrollmentStatus(input: {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<boolean> {
  return (await listGoogleAccountsFromT3(input)).registered;
}

export async function setDefaultGoogleAccountInT3(input: {
  readonly baseUrl: string;
  readonly subject: string;
  readonly label?: string;
  readonly tier?: GoogleAccountTier;
  readonly bearerToken?: string;
  readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<{
  readonly account: EnrolledGoogleAccountSummary;
  readonly accounts: ReadonlyArray<EnrolledGoogleAccountSummary>;
}> {
  const response = await input.fetcher(
    new URL("/api/auth/google/accounts/default", input.baseUrl).href,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
      },
      body: JSON.stringify({
        subject: input.subject,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.tier !== undefined ? { tier: input.tier } : {}),
      }),
      credentials: "include",
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error("기본 Google 계정을 변경하지 못했습니다.");
  return (await response.json()) as {
    readonly account: EnrolledGoogleAccountSummary;
    readonly accounts: ReadonlyArray<EnrolledGoogleAccountSummary>;
  };
}

export async function bindDriveBackupAccountInT3(input: {
  readonly baseUrl: string;
  readonly subject: string;
  readonly bearerToken?: string;
  readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<{ readonly bound: boolean; readonly email: string | null }> {
  const response = await input.fetcher(
    new URL("/api/auth/google/accounts/drive-bind", input.baseUrl).href,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
      },
      body: JSON.stringify({ subject: input.subject }),
      credentials: "include",
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error("Google Drive 백업 계정을 연결하지 못했습니다.");
  return (await response.json()) as { readonly bound: boolean; readonly email: string | null };
}
