// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import {
  extractClerkCallbackUrl,
  startDesktopClerkCallbackRelay,
  tryForwardClerkCallbackFromArgv,
} from "./DesktopClerkCallbackRelay.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

export class DesktopClerkBridgeInitializationError extends Schema.TaggedErrorClass<DesktopClerkBridgeInitializationError>()(
  "DesktopClerkBridgeInitializationError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerkBridgeCleanupError extends Schema.TaggedErrorClass<DesktopClerkBridgeCleanupError>()(
  "DesktopClerkBridgeCleanupError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clean up the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerk extends Context.Service<
  DesktopClerk,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

export function resolveDesktopClerkFrontendApiHostname(
  publishableKey: string | undefined,
): string | undefined {
  const normalizedKey = publishableKey?.trim();
  if (!normalizedKey) return undefined;

  try {
    return clerkFrontendApiHostnameFromPublishableKey(normalizedKey);
  } catch {
    return undefined;
  }
}

export const desktopClerkFrontendApiHostname = resolveDesktopClerkFrontendApiHostname(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);

export function createDesktopClerkBridge(stateDir: string, isDevelopment: boolean) {
  return createClerkBridge({
    storage: storage({ path: stateDir }),
    passkeys: true,
    renderer: {
      scheme: ElectronProtocol.getDesktopScheme(isDevelopment),
      host: ElectronProtocol.DESKTOP_HOST,
    },
  });
}

export function registerWindowsUnpackedProtocolIfNeeded(
  electronApp: Pick<ElectronApp.ElectronApp["Service"], "setAsDefaultProtocolClient">,
  scheme: string,
  runtime: {
    readonly platform: NodeJS.Platform;
    readonly defaultApp: boolean | undefined;
    readonly execPath: string;
    readonly argv: ReadonlyArray<string>;
  } = {
    platform: process.platform,
    defaultApp: (process as NodeJS.Process & { readonly defaultApp?: boolean }).defaultApp,
    execPath: process.execPath,
    argv: process.argv,
  },
): Effect.Effect<boolean> {
  if (runtime.platform !== "win32" || !runtime.defaultApp || !runtime.argv[1]) {
    return Effect.succeed(false);
  }
  const entryPath = NodePath.resolve(runtime.argv[1]);
  if (typeof electronApp.setAsDefaultProtocolClient !== "function") {
    return Effect.succeed(false);
  }
  return electronApp.setAsDefaultProtocolClient(scheme, runtime.execPath, [entryPath]);
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);

  // Windows UIPI 관통 조기 포워더: 브라우저(Medium)가 딥링크(`t3code://app/?...`)로 띄운
  // 2차 Electron이 주 앱(High)의 릴레이 서버로 콜백을 직접 전송한 뒤 즉시 무창 종료한다.
  if (
    process.platform === "win32" &&
    extractClerkCallbackUrl(process.argv, scheme, ElectronProtocol.DESKTOP_HOST) !== null
  ) {
    const forwarded = yield* Effect.tryPromise({
      try: () =>
        tryForwardClerkCallbackFromArgv({
          argv: process.argv,
          stateDir: environment.stateDir,
          scheme,
          host: ElectronProtocol.DESKTOP_HOST,
        }),
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false));
    if (forwarded) {
      yield* electronApp.exit(0);
      return yield* Effect.interrupt;
    }
  }

  // Electron scopes the single-instance lock to the userData directory and
  // creates that directory when the lock is acquired. The SDK bridge takes
  // the lock at creation, so userData must already point at the real
  // directory here — under the default productName-derived path, acquiring
  // the lock would create "T3 Code (Alpha)" and make the legacy-install
  // detection in resolveUserDataPath match on fresh installs.
  const userDataPath = yield* DesktopAppIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);

  const bridge = yield* Effect.acquireRelease(
    Effect.try({
      try: () => createDesktopClerkBridge(environment.stateDir, environment.isDevelopment),
      catch: (cause) =>
        new DesktopClerkBridgeInitializationError({
          stateDir: environment.stateDir,
          isDevelopment: environment.isDevelopment,
          cause,
        }),
    }),
    (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: environment.stateDir,
            isDevelopment: environment.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
  );

  // @clerk/electron@0.0.24가 인자 없이 setAsDefaultProtocolClient(scheme)를 호출해
  // Windows unpacked 실행 시 레지스트리에서 dist-electron\main.cjs 진입점을 지우는 문제를 교정한다.
  yield* registerWindowsUnpackedProtocolIfNeeded(electronApp, scheme);

  // 주 인스턴스(High)에서 Windows UIPI 관통 로컬 루프백 콜백 릴레이 서버 가동
  if (bridge.isPrimaryInstance && NodeFs.existsSync(environment.stateDir)) {
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startDesktopClerkCallbackRelay({
            stateDir: environment.stateDir,
            scheme,
            host: ElectronProtocol.DESKTOP_HOST,
            onCallback: (url) => {
              const appEmitter = (
                Electron as unknown as {
                  readonly app?: {
                    readonly emit?: (event: string, ...args: ReadonlyArray<unknown>) => boolean;
                  };
                }
              ).app;
              appEmitter?.emit?.("second-instance", {}, ["", url], process.cwd());
            },
          }),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null)),
      (relay) =>
        relay
          ? Effect.tryPromise({
              try: () => relay.close(),
              catch: () => undefined,
            }).pipe(Effect.ignore)
          : Effect.void,
    );
  }

  return DesktopClerk.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);

      // The SDK bridge holds Electron's single-instance lock (acquired at
      // bridge creation) so OAuth deep-link callbacks on Windows/Linux are
      // forwarded to the running app. In a secondary instance the bridge has
      // already begun quitting the app; app.quit() is asynchronous, so stop
      // bootstrap here before whenReady can fire.
      if (!bridge.isPrimaryInstance) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      yield* electronApp.on("second-instance", () => {
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) {
              yield* electronWindow.reveal(mainWindow.value);
            }
          }),
        );
      });
    }).pipe(Effect.withSpan("desktop.clerk.configure")),
  });
});

export const layer = Layer.effect(DesktopClerk, make);
