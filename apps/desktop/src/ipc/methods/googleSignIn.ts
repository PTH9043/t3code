import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import {
  authenticateGoogleToT3,
  createGoogleSignInController,
  googleEnrollmentStatus,
  removeGoogleFromT3,
} from "../../app/googleSignIn.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopDirectRpcHub from "../../backend/DesktopDirectRpcHub.ts";
import { directHttpRequest } from "../../backend/DesktopDirectHttpClient.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const controller = createGoogleSignInController();
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
          openExternal: (url) => Effect.runPromise(shell.openExternal(url)),
        }),
      catch: (cause) => new DesktopGoogleSignInError({ cause }),
    });
  }),
});

const authenticateT3 = Effect.fn("desktop.ipc.googleSignInT3")(function* (input: {
  readonly mode: "enroll" | "login";
  readonly clientId?: string;
}) {
  const shell = yield* ElectronShell.ElectronShell;
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
  const directHub = yield* Effect.serviceOption(DesktopDirectRpcHub.DesktopDirectRpcHub);
  if (input.mode === "login" && direct && Option.isNone(directHub)) {
    return yield* new DesktopGoogleSignInError({ cause: "직접 연결을 확인하지 못했습니다." });
  }
  const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const bearerToken = input.mode === "enroll" && !direct ? yield* auth.getBearerToken : undefined;
  return yield* Effect.tryPromise({
    try: async () => {
      const browserSession = window.value.webContents.session;
      const baseUrl = resolveT3AuthBaseUrl(
        window.value.webContents.getURL(),
        config.value.httpBaseUrl.href,
      );
      const result = await authenticateGoogleToT3({
        ...input,
        ...(bearerToken ? { bearerToken } : {}),
        baseUrl,
        fetcher: browserSession.fetch.bind(browserSession),
        authenticate: ({ clientId, nonce }) =>
          controller.startForServer({
            clientId,
            nonce,
            openExternal: (url) => Effect.runPromise(shell.openExternal(url)),
          }),
      });
      if (input.mode === "login") {
        if (!result.accessToken) throw new Error("T3 Google 로그인 토큰을 받지 못했습니다.");
        const response =
          direct && Option.isSome(directHub)
            ? await directHttpRequest(
                directHub.value,
                new Request("http://desktop.invalid/api/auth/session"),
                "primary",
                result.accessToken,
              )
            : await browserSession.fetch(new URL("/api/auth/session", baseUrl).href, {
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
        ? auth.setGoogleBearerToken(result.accessToken).pipe(Effect.as(result.identity))
        : Effect.succeed(result.identity),
    ),
  );
});

export const enrollGoogleToT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_ENROLL_T3_CHANNEL,
  payload: Schema.String,
  result: GoogleIdentity,
  handler: Effect.fn("desktop.ipc.googleEnrollT3")(function* (clientId) {
    return yield* authenticateT3({ mode: "enroll", clientId });
  }),
});

export const loginGoogleToT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_LOGIN_T3_CHANNEL,
  payload: Schema.Undefined,
  result: GoogleIdentity,
  handler: Effect.fn("desktop.ipc.googleLoginT3")(function* () {
    return yield* authenticateT3({ mode: "login" });
  }),
});

export const unenrollGoogleFromT3 = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_UNENROLL_T3_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.googleUnenrollT3")(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const primary = yield* pool.primary;
    const config = yield* primary.currentConfig;
    const windows = yield* ElectronWindow.ElectronWindow;
    const window = yield* windows.main;
    if (Option.isNone(config) || Option.isNone(window)) {
      return yield* new DesktopGoogleSignInError({ cause: "T3 로컬 환경을 확인하지 못했습니다." });
    }
    const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    const direct =
      config.value.bootstrap.desktopDirectRpcInputFd !== undefined &&
      config.value.bootstrap.desktopDirectRpcOutputFd !== undefined &&
      ["t3code:", "t3code-dev:"].includes(new URL(window.value.webContents.getURL()).protocol);
    const bearerToken = direct ? undefined : yield* auth.getBearerToken;
    return yield* Effect.tryPromise({
      try: () =>
        removeGoogleFromT3({
          ...(bearerToken ? { bearerToken } : {}),
          baseUrl: resolveT3AuthBaseUrl(
            window.value.webContents.getURL(),
            config.value.httpBaseUrl.href,
          ),
          fetcher: window.value.webContents.session.fetch.bind(window.value.webContents.session),
        }),
      catch: (cause) => new DesktopGoogleSignInError({ cause }),
    }).pipe(Effect.flatMap((removed) => auth.clearGoogleBearerToken.pipe(Effect.as(removed))));
  }),
});

export const googleT3EnrollmentStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_ENROLLMENT_STATUS_T3_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.googleT3EnrollmentStatus")(function* () {
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
    return yield* Effect.tryPromise({
      try: () =>
        googleEnrollmentStatus({
          ...(bearerToken ? { bearerToken } : {}),
          baseUrl: resolveT3AuthBaseUrl(
            window.value.webContents.getURL(),
            config.value.httpBaseUrl.href,
          ),
          fetcher: window.value.webContents.session.fetch.bind(window.value.webContents.session),
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
