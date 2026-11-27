import {
  EnrolledGoogleAccountSummary,
  GoogleAccountTier,
  GoogleEnrollmentStatusResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  authenticateGoogleToT3,
  bindDriveBackupAccountInT3,
  createGoogleSignInController,
  googleEnrollmentStatus,
  listGoogleAccountsFromT3,
  removeGoogleFromT3,
  setDefaultGoogleAccountInT3,
} from "../../app/googleSignIn.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import { directHttpRequest } from "../../backend/DesktopDirectHttpClient.ts";
import * as DesktopDirectRpcHub from "../../backend/DesktopDirectRpcHub.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const controller = createGoogleSignInController();
// Main-process in-memory cache for desktop OAuth clientSecret so subsequent accounts in the
// same session don't need re-entry. Never exposed back to the renderer.
let cachedClientSecret: string | undefined;

class DesktopGoogleSignInError extends Schema.TaggedErrorClass<DesktopGoogleSignInError>()(
  "DesktopGoogleSignInError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Google 로그인을 완료하지 못했습니다. 설정과 인증 상태를 확인하세요.";
  }
}

const GoogleIdentity = Schema.Struct({
  subject: Schema.String,
  expiresAt: Schema.String,
  email: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

const EnrollGooglePayload = Schema.Union([
  Schema.String,
  Schema.Struct({
    clientId: Schema.optionalKey(Schema.String),
    clientSecret: Schema.optionalKey(Schema.String),
    label: Schema.optionalKey(Schema.String),
    tier: Schema.optionalKey(GoogleAccountTier),
    linkDriveBackup: Schema.optionalKey(Schema.Boolean),
    loginHint: Schema.optionalKey(Schema.String),
  }),
]);

const LoginGooglePayload = Schema.UndefinedOr(
  Schema.Struct({
    subject: Schema.optionalKey(Schema.String),
    loginHint: Schema.optionalKey(Schema.String),
  }),
);

function resolveT3AuthBaseUrl(windowUrl: string, backendUrl: string): string {
  const url = new URL(windowUrl);
  if ((url.protocol === "t3code:" || url.protocol === "t3code-dev:") && url.hostname === "app") {
    return `${url.protocol}//${url.host}/`;
  }
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    return `${url.origin}/`;
  }
  return backendUrl;
}

const resolvePrimaryContext = Effect.fn("desktop.ipc.googleSignIn.context")(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const primary = yield* pool.primary;
  const config = yield* primary.currentConfig;
  const windows = yield* ElectronWindow.ElectronWindow;
  const window = yield* windows.main;
  if (Option.isNone(config) || Option.isNone(window)) {
    return yield* new DesktopGoogleSignInError({ cause: "T3 로컬 환경을 확인하지 못했습니다." });
  }
  const direct =
    config.value.bootstrap.desktopDirectRpcInputFd !== undefined &&
    config.value.bootstrap.desktopDirectRpcOutputFd !== undefined &&
    ["t3code:", "t3code-dev:"].includes(new URL(window.value.webContents.getURL()).protocol);
  const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const bearerToken = direct ? undefined : yield* auth.getBearerToken;
  const baseUrl = resolveT3AuthBaseUrl(
    window.value.webContents.getURL(),
    config.value.httpBaseUrl.href,
  );
  return { config: config.value, window: window.value, direct, auth, bearerToken, baseUrl };
});

export const startGoogleSignIn = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_SIGN_IN_CHANNEL,
  payload: Schema.String,
  result: GoogleIdentity,
  handler: Effect.fn("desktop.ipc.googleSignIn")(function* (clientId) {
    const shell = yield* ElectronShell.ElectronShell;
    return yield* Effect.tryPromise({
      try: () =>
        controller.start({
          clientId,
          ...(cachedClientSecret ? { clientSecret: cachedClientSecret } : {}),
          openExternal: (url) => Effect.runPromise(shell.openExternal(url)),
        }),
      catch: (cause) => new DesktopGoogleSignInError({ cause }),
    });
  }),
});

const authenticateT3 = Effect.fn("desktop.ipc.googleSignInT3")(function* (input: {
  readonly mode: "enroll" | "login";
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly label?: string;
  readonly tier?: GoogleAccountTier;
  readonly linkDriveBackup?: boolean;
  readonly subject?: string;
  readonly loginHint?: string;
}) {
  const shell = yield* ElectronShell.ElectronShell;
  const ctx = yield* resolvePrimaryContext();
  const directHub = yield* Effect.serviceOption(DesktopDirectRpcHub.DesktopDirectRpcHub);
  if (input.mode === "login" && ctx.direct && Option.isNone(directHub)) {
    return yield* new DesktopGoogleSignInError({ cause: "직접 연결을 확인하지 못했습니다." });
  }
  const effectiveSecret = input.clientSecret?.trim() || cachedClientSecret;
  if (input.clientSecret?.trim()) {
    cachedClientSecret = input.clientSecret.trim();
  }
  return yield* Effect.tryPromise({
    try: async () => {
      const browserSession = ctx.window.webContents.session;
      const result = await authenticateGoogleToT3({
        mode: input.mode,
        ...(input.clientId ? { clientId: input.clientId } : {}),
        ...(effectiveSecret ? { clientSecret: effectiveSecret } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(input.tier ? { tier: input.tier } : {}),
        ...(input.linkDriveBackup !== undefined ? { linkDriveBackup: input.linkDriveBackup } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.loginHint ? { loginHint: input.loginHint } : {}),
        ...(input.mode === "enroll" && ctx.bearerToken ? { bearerToken: ctx.bearerToken } : {}),
        baseUrl: ctx.baseUrl,
        fetcher: browserSession.fetch.bind(browserSession),
        authenticate: (authInput) =>
          controller.startForServer({
            ...authInput,
            openExternal: (url) => Effect.runPromise(shell.openExternal(url)),
          }),
      });
      if (input.mode === "login") {
        if (!result.accessToken) throw new Error("T3 Google 로그인 토큰을 받지 못했습니다.");
        const response =
          ctx.direct && Option.isSome(directHub)
            ? await directHttpRequest(
                directHub.value,
                new Request("http://desktop.invalid/api/auth/session"),
                "primary",
                result.accessToken,
              )
            : await browserSession.fetch(new URL("/api/auth/session", ctx.baseUrl).href, {
                headers: { authorization: `Bearer ${result.accessToken}` },
                credentials: "omit",
                redirect: "error",
              });
        const session: unknown = await response.json();
        if (
          !response.ok ||
          typeof session !== "object" ||
          session === null ||
          !("authenticated" in session) ||
          session.authenticated !== true
        ) {
          throw new Error("T3 Google 로그인 세션을 확인하지 못했습니다.");
        }
      }
      return result;
    },
    catch: (cause) => new DesktopGoogleSignInError({ cause }),
  }).pipe(
    Effect.flatMap((result) =>
      result.accessToken
        ? ctx.auth.setGoogleBearerToken(result.accessToken).pipe(Effect.as(result.identity))
        : Effect.succeed(result.identity),
    ),
  );
});

export const enrollGoogleToT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_ENROLL_T3_CHANNEL,
  payload: EnrollGooglePayload,
  result: GoogleIdentity,
  handler: Effect.fn("desktop.ipc.googleEnrollT3")(function* (payload) {
    if (typeof payload === "string") {
      return yield* authenticateT3({ mode: "enroll", clientId: payload });
    }
    return yield* authenticateT3({
      mode: "enroll",
      ...(payload.clientId ? { clientId: payload.clientId } : {}),
      ...(payload.clientSecret ? { clientSecret: payload.clientSecret } : {}),
      ...(payload.label ? { label: payload.label } : {}),
      ...(payload.tier ? { tier: payload.tier } : {}),
      ...(payload.linkDriveBackup !== undefined
        ? { linkDriveBackup: payload.linkDriveBackup }
        : {}),
      ...(payload.loginHint ? { loginHint: payload.loginHint } : {}),
    });
  }),
});

export const loginGoogleToT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_LOGIN_T3_CHANNEL,
  payload: LoginGooglePayload,
  result: GoogleIdentity,
  handler: Effect.fn("desktop.ipc.googleLoginT3")(function* (payload) {
    return yield* authenticateT3({
      mode: "login",
      ...(payload?.subject ? { subject: payload.subject } : {}),
      ...(payload?.loginHint ? { loginHint: payload.loginHint } : {}),
    });
  }),
});

export const unenrollGoogleFromT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_UNENROLL_T3_CHANNEL,
  payload: Schema.UndefinedOr(Schema.String),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.googleUnenrollT3")(function* (subject) {
    const ctx = yield* resolvePrimaryContext();
    return yield* Effect.tryPromise({
      try: () =>
        removeGoogleFromT3({
          ...(subject ? { subject } : {}),
          ...(ctx.bearerToken ? { bearerToken: ctx.bearerToken } : {}),
          baseUrl: ctx.baseUrl,
          fetcher: ctx.window.webContents.session.fetch.bind(ctx.window.webContents.session),
        }),
      catch: (cause) => new DesktopGoogleSignInError({ cause }),
    }).pipe(
      Effect.flatMap((removed) =>
        subject
          ? Effect.succeed(removed)
          : ctx.auth.clearGoogleBearerToken.pipe(Effect.as(removed)),
      ),
    );
  }),
});

export const googleT3EnrollmentStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_ENROLLMENT_STATUS_T3_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.googleT3EnrollmentStatus")(function* () {
    const ctx = yield* resolvePrimaryContext();
    return yield* Effect.tryPromise({
      try: () =>
        googleEnrollmentStatus({
          ...(ctx.bearerToken ? { bearerToken: ctx.bearerToken } : {}),
          baseUrl: ctx.baseUrl,
          fetcher: ctx.window.webContents.session.fetch.bind(ctx.window.webContents.session),
        }),
      catch: (cause) => new DesktopGoogleSignInError({ cause }),
    });
  }),
});

export const listGoogleAccountsT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_LIST_ACCOUNTS_T3_CHANNEL,
  payload: Schema.Undefined,
  result: GoogleEnrollmentStatusResult,
  handler: Effect.fn("desktop.ipc.googleListAccountsT3")(function* () {
    const ctx = yield* resolvePrimaryContext();
    return yield* Effect.tryPromise({
      try: () =>
        listGoogleAccountsFromT3({
          ...(ctx.bearerToken ? { bearerToken: ctx.bearerToken } : {}),
          baseUrl: ctx.baseUrl,
          fetcher: ctx.window.webContents.session.fetch.bind(ctx.window.webContents.session),
        }),
      catch: (cause) => new DesktopGoogleSignInError({ cause }),
    });
  }),
});

export const setDefaultGoogleAccountT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_SET_DEFAULT_ACCOUNT_T3_CHANNEL,
  payload: Schema.Struct({
    subject: Schema.String,
    label: Schema.optionalKey(Schema.String),
    tier: Schema.optionalKey(GoogleAccountTier),
  }),
  result: Schema.Struct({
    account: EnrolledGoogleAccountSummary,
    accounts: Schema.Array(EnrolledGoogleAccountSummary),
  }),
  handler: Effect.fn("desktop.ipc.googleSetDefaultAccountT3")(function* (payload) {
    const ctx = yield* resolvePrimaryContext();
    return yield* Effect.tryPromise({
      try: () =>
        setDefaultGoogleAccountInT3({
          subject: payload.subject,
          ...(payload.label !== undefined ? { label: payload.label } : {}),
          ...(payload.tier !== undefined ? { tier: payload.tier } : {}),
          ...(ctx.bearerToken ? { bearerToken: ctx.bearerToken } : {}),
          baseUrl: ctx.baseUrl,
          fetcher: ctx.window.webContents.session.fetch.bind(ctx.window.webContents.session),
        }),
      catch: (cause) => new DesktopGoogleSignInError({ cause }),
    });
  }),
});

export const bindDriveBackupAccountT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_BIND_DRIVE_BACKUP_T3_CHANNEL,
  payload: Schema.String,
  result: Schema.Struct({
    bound: Schema.Boolean,
    email: Schema.NullOr(Schema.String),
  }),
  handler: Effect.fn("desktop.ipc.googleBindDriveBackupT3")(function* (subject) {
    const ctx = yield* resolvePrimaryContext();
    return yield* Effect.tryPromise({
      try: () =>
        bindDriveBackupAccountInT3({
          subject,
          ...(ctx.bearerToken ? { bearerToken: ctx.bearerToken } : {}),
          baseUrl: ctx.baseUrl,
          fetcher: ctx.window.webContents.session.fetch.bind(ctx.window.webContents.session),
        }),
      catch: (cause) => new DesktopGoogleSignInError({ cause }),
    });
  }),
});

export const logoutGoogleFromT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_LOGOUT_T3_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.googleLogoutT3")(function* () {
    const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    yield* auth.clearGoogleBearerToken;
  }),
});

export const cancelGoogleSignIn = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_SIGN_IN_CANCEL_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: () => Effect.sync(() => controller.cancel()),
});

export const getGoogleSignInStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_SIGN_IN_STATUS_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.NullOr(GoogleIdentity),
  handler: () => Effect.sync(() => controller.status()),
});

export const signOutGoogle = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_SIGN_OUT_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: () => Effect.sync(() => controller.signOut()),
});
