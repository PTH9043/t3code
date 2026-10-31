// @effect-diagnostics nodeBuiltinImport:off -- Electron's protocol handler is a native Promise callback.
import * as Context from "effect/Context";
import Mime from "@effect/platform-node/Mime";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";
export const DESKTOP_PRODUCTION_SCHEME = "t3code";
export const DESKTOP_DEVELOPMENT_SCHEME = "t3code-dev";
export const DESKTOP_START_PATH = "/control-center";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}${DESKTOP_START_PATH}`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedErrorClass<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedErrorClass<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

export interface DesktopProtocolRegistrationInput {
  readonly scheme: string;
  readonly targetOrigin: URL;
  readonly backendOrigin: URL;
  readonly clerkFrontendApiHostname: string | undefined;
  readonly local?: {
    readonly staticRoot: string;
    readonly request: (request: Request, backendId?: string) => Promise<Response>;
    readonly devRequest?: (request: Request) => Promise<Response>;
    readonly useDirect?: () => Promise<boolean>;
    readonly resolveSecondaryBackendId?: (host: string) => Promise<string | undefined>;
  };
}

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronProtocol") {}

export function makeDesktopContentSecurityPolicy(input: DesktopProtocolRegistrationInput): string {
  const clerkOrigin = input.clerkFrontendApiHostname
    ? `https://${input.clerkFrontendApiHostname}`
    : undefined;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    "'wasm-unsafe-eval'",
    ...(clerkOrigin ? [clerkOrigin] : []),
    "https://challenges.cloudflare.com",
  ];

  // The renderer connects directly to user-configured environments in addition to
  // the build-configured Clerk, relay, and OTLP endpoints. Those environment
  // origins are not known when this response policy is created, so restrict
  // connections by the network schemes the client supports instead of by host.
  const connectSources = ["'self'", `${input.scheme}:`, "http:", "https:", "ws:", "wss:"];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${input.scheme}: blob: data: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${input.scheme}: data:`,
    "worker-src 'self' blob:",
    "object-src 'self' blob:",
    "frame-src 'self' blob: https://challenges.cloudflare.com",
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Must run synchronously during process bootstrap, before Electron emits `ready`.
 */
export function registerDesktopSchemePrivilegesSync(): void {
  Electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_PRODUCTION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
    {
      scheme: DESKTOP_DEVELOPMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

const registerDesktopSchemePrivileges = Effect.sync(registerDesktopSchemePrivilegesSync).pipe(
  Effect.withSpan("desktop.electron.protocol.registerSchemePrivileges"),
);

export const layerSchemePrivileges = Layer.effectDiscard(registerDesktopSchemePrivileges);

async function proxyRequest(
  request: Request,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);
  const headersToRemove: string[] = [];
  for (const name of headers.keys()) {
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headersToRemove.push(name);
    }
  }
  for (const name of headersToRemove) {
    headers.delete(name);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? await fetchWithTransientRetry(targetUrl.toString(), init)
      : await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

async function localRequest(
  request: Request,
  local: NonNullable<DesktopProtocolRegistrationInput["local"]>,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.host.startsWith("wsl-")) {
    if (!isDevProxiedPath(url.pathname)) return new Response(null, { status: 404 });
    const allowedOrigin = `${url.protocol}//${DESKTOP_HOST}`;
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== allowedOrigin) return new Response(null, { status: 403 });
    // Electron does not populate Origin or referrer for custom-scheme image
    // and fetch requests. The random host is a per-run capability instead.
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        request.headers.get("access-control-request-headers") ?? "content-type, authorization",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders });
    try {
      const backendId = await local.resolveSecondaryBackendId?.(url.host);
      if (!backendId) return new Response(null, { status: 404 });
      const response = await local.request(request, backendId);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
      return withContentSecurityPolicy(
        new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        }),
        contentSecurityPolicy,
      );
    } catch {
      return new Response("Local environment unavailable.", { status: 503 });
    }
  }
  if (url.host !== DESKTOP_HOST) return new Response(null, { status: 404 });
  if (isDevProxiedPath(url.pathname)) {
    try {
      if (local.useDirect && !(await local.useDirect())) {
        return new Response("Local environment unavailable.", { status: 503 });
      }
      return withContentSecurityPolicy(await local.request(request), contentSecurityPolicy);
    } catch {
      return new Response("Local environment unavailable.", { status: 503 });
    }
  }
  if (local.devRequest) {
    try {
      return withContentSecurityPolicy(await local.devRequest(request), contentSecurityPolicy);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return new Response(`Desktop development files unavailable${code ? ` (${code})` : ""}.`, {
        status: 503,
      });
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  try {
    const root = await NodeFSP.realpath(local.staticRoot);
    const relative = decodeURIComponent(url.pathname).replace(/^[/\\]+/u, "");
    const candidate = NodePath.resolve(root, relative || "index.html");
    const withinRoot = (path: string) => path === root || path.startsWith(`${root}${NodePath.sep}`);
    if (!withinRoot(candidate)) return new Response(null, { status: 400 });
    let file = candidate;
    try {
      const actual = await NodeFSP.realpath(file);
      if (!withinRoot(actual)) return new Response(null, { status: 400 });
      if (!(await NodeFSP.stat(actual)).isFile()) throw new Error("Not a file");
      file = actual;
    } catch {
      file = await NodeFSP.realpath(NodePath.join(root, "index.html"));
      if (!withinRoot(file)) return new Response(null, { status: 400 });
    }
    const content = await NodeFSP.readFile(file);
    const contentType = Mime.getType(file) ?? "application/octet-stream";
    return withContentSecurityPolicy(
      new Response(request.method === "HEAD" ? null : content, {
        status: 200,
        headers: { "Content-Type": contentType },
      }),
      contentSecurityPolicy,
    );
  } catch {
    return new Response("Desktop files unavailable.", { status: 503 });
  }
}

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [0, 50, 150] as const;

async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (const delayMs of TRANSIENT_FETCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await NodeTimersPromises.setTimeout(delayMs);
    }

    try {
      return await Electron.net.fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export const make = Effect.gen(function* () {
  const registered = yield* Ref.make(false);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, (request) =>
              input.local
                ? localRequest(request, input.local, input.targetOrigin, contentSecurityPolicy)
                : proxyRequest(request, input.targetOrigin, contentSecurityPolicy),
            );
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({
                scheme: input.scheme,
                cause,
              }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
