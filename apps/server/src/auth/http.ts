import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthAccessTokenType,
  AuthEnvironmentScopes,
  AuthStandardClientScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
  EnvironmentAuthInvalidError,
  type EnvironmentAuthInvalidReason,
  EnvironmentHttpApi,
  EnvironmentInternalError,
  type EnvironmentInternalErrorReason,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  type EnvironmentRequestInvalidReason,
  EnvironmentResourceNotFoundError,
  type EnvironmentResourceNotFoundReason,
  EnvironmentScopeRequiredError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  GoogleAccountTier,
  type EnrolledGoogleAccountSummary,
} from "@t3tools/contracts";
import type { AuthEnvironmentScope } from "@t3tools/contracts";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { createGoogleAccountAuth, findEnrolledGoogleAccount } from "./GoogleAccountAuth.ts";
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "../cloud/traceRelayRequest.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { verifyRequestDpopProof } from "./dpop.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

class GoogleVerificationError extends Data.TaggedError("GoogleVerificationError")<{}> {}

const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

const appendDpopChallengeOnUnauthorized = (error: EnvironmentAuthInvalidError) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const usesDpop =
      (request.originalUrl.startsWith("/oauth/token") && request.headers.dpop !== undefined) ||
      request.headers.authorization?.startsWith("DPoP ") === true;
    if (usesDpop) {
      yield* appendDpopChallengeHeader;
    }
    return yield* error;
  });

export const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

export function annotateEnvironmentRequest(endpoint: string) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const traceId = yield* currentEnvironmentTraceId;

    yield* Effect.addFinalizer((exit) =>
      exit._tag === "Failure"
        ? Effect.logWarning("environment api request failed", {
            endpoint,
            traceId,
            errorTag: causeErrorTag(exit.cause),
            cause: exit.cause,
          })
        : Effect.void,
    );
    yield* Effect.annotateLogsScoped({ "environment.endpoint": endpoint, traceId });
    yield* Effect.annotateCurrentSpan({
      "environment.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": url._tag === "Some" ? url.value.pathname : "unknown",
    });
  });
}

export function failEnvironmentAuthInvalid(reason: EnvironmentAuthInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentAuthInvalidError({ code: "auth_invalid", reason, traceId })),
    ),
  );
}

export function failEnvironmentInvalidRequest(reason: EnvironmentRequestInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
    ),
  );
}

export function failEnvironmentScopeRequired(requiredScope: AuthEnvironmentScope) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentScopeRequiredError({
          code: "insufficient_scope",
          requiredScope,
          traceId,
        }),
      ),
    ),
  );
}

function failEnvironmentOperationForbidden(reason: "current_session_revoke_not_allowed") {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentOperationForbiddenError({
          code: "operation_forbidden",
          reason,
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentNotFound(reason: EnvironmentResourceNotFoundReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentResourceNotFoundError({ code: "not_found", reason, traceId })),
    ),
  );
}

export function failEnvironmentInternal(reason: EnvironmentInternalErrorReason, error?: unknown) {
  return Effect.gen(function* () {
    const traceId = yield* currentEnvironmentTraceId;
    if (error !== undefined) {
      yield* Effect.logError("environment api operation failed", {
        reason,
        traceId,
        cause: error,
      });
    }
    return yield* new EnvironmentInternalError({ code: "internal_error", reason, traceId });
  });
}

export const requireEnvironmentScope = Effect.fn("environment.auth.requireScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (!session.scopes.has(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

export const environmentAuthenticatedAuthLayer = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        return yield* httpEffect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            ...session,
            scopes: new Set(session.scopes),
          }),
          session.subject === "cloud-connect" ? traceAuthenticatedRelayRequest : identity,
        );
      }).pipe(Effect.catchTag("EnvironmentAuthInvalidError", appendDpopChallengeOnUnauthorized));
  }),
);

export const authHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const google = createGoogleAccountAuth();
    const legacyGoogleSecretName = "google-login-account";
    const multiGoogleSecretName = "google-login-accounts";
    const googleClientSecretName = "google-oauth-client-secret";
    const driveOAuthPrimarySecretName = "drive_backup_gdrive_oauth";
    const driveOAuthPerSubjectSecretName = (subject: string) =>
      `drive_backup_gdrive_oauth_${subject.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)}`;

    const legacyGoogleAccountSchema = Schema.Struct({
      clientId: Schema.String,
      subject: Schema.String,
      scopes: AuthEnvironmentScopes,
    });
    const storedGoogleAccountSchema = Schema.Struct({
      clientId: Schema.String,
      subject: Schema.String,
      scopes: AuthEnvironmentScopes,
      email: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
      label: Schema.optionalKey(Schema.String),
      tier: Schema.optionalKey(GoogleAccountTier),
      driveBackupLinked: Schema.optionalKey(Schema.Boolean),
      addedAt: Schema.String,
      lastUsedAt: Schema.optionalKey(Schema.String),
      isDefault: Schema.Boolean,
    });
    type StoredGoogleAccount = typeof storedGoogleAccountSchema.Type;
    const decodeLegacyGoogleAccount = Schema.decodeUnknownEffect(
      Schema.fromJsonString(legacyGoogleAccountSchema),
    );
    const decodeGoogleAccounts = Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(storedGoogleAccountSchema)),
    );
    const encodeGoogleAccounts = Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(storedGoogleAccountSchema)),
    );
    const driveOAuthPayloadSchema = Schema.Struct({
      clientId: Schema.String,
      clientSecret: Schema.String,
      refreshToken: Schema.String,
      connectedEmail: Schema.optionalKey(Schema.String),
    });
    const decodeDriveOAuthPayload = Schema.decodeUnknownEffect(
      Schema.fromJsonString(driveOAuthPayloadSchema),
    );
    const encodeDriveOAuthPayload = Schema.encodeEffect(
      Schema.fromJsonString(driveOAuthPayloadSchema),
    );

    const toAccountSummary = (account: StoredGoogleAccount): EnrolledGoogleAccountSummary => ({
      subject: account.subject,
      clientId: account.clientId,
      ...(account.email ? { email: account.email } : {}),
      ...(account.name ? { name: account.name } : {}),
      ...(account.label ? { label: account.label } : {}),
      ...(account.tier ? { tier: account.tier } : {}),
      driveBackupLinked: Boolean(account.driveBackupLinked),
      addedAt: account.addedAt,
      ...(account.lastUsedAt ? { lastUsedAt: account.lastUsedAt } : {}),
      isDefault: account.isDefault,
    });

    const saveGoogleAccounts = (accounts: ReadonlyArray<StoredGoogleAccount>) =>
      encodeGoogleAccounts(accounts).pipe(
        Effect.flatMap((serialized) =>
          secrets.set(multiGoogleSecretName, new TextEncoder().encode(serialized)),
        ),
        Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
      );

    const loadGoogleAccounts = (): Effect.Effect<
      ReadonlyArray<StoredGoogleAccount>,
      EnvironmentInternalError
    > =>
      Effect.gen(function* () {
        const multiVal = yield* secrets
          .get(multiGoogleSecretName)
          .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        if (Option.isSome(multiVal)) {
          return yield* decodeGoogleAccounts(new TextDecoder().decode(multiVal.value)).pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }
        const legacyVal = yield* secrets
          .get(legacyGoogleSecretName)
          .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        if (Option.isNone(legacyVal)) return [];
        const legacy = yield* decodeLegacyGoogleAccount(
          new TextDecoder().decode(legacyVal.value),
        ).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const migrated: ReadonlyArray<StoredGoogleAccount> = [
          {
            clientId: legacy.clientId,
            subject: legacy.subject,
            scopes: legacy.scopes,
            driveBackupLinked: false,
            addedAt: nowIso,
            isDefault: true,
          },
        ];
        yield* saveGoogleAccounts(migrated);
        return migrated;
      });

    const readStoredClientSecret = () =>
      secrets.get(googleClientSecretName).pipe(
        Effect.map((opt) =>
          Option.isSome(opt) ? new TextDecoder().decode(opt.value).trim() || null : null,
        ),
        Effect.orElseSucceed(() => null),
      );

    const verifyGoogle = (input: {
      challenge: string;
      idToken: string;
      ownerSessionId: string | null;
      expectedSubject?: string;
    }) =>
      Effect.tryPromise({
        try: () => google.verify(input),
        catch: () => new GoogleVerificationError(),
      }).pipe(Effect.catch(() => failEnvironmentAuthInvalid("invalid_credential")));
    const issueGoogleChallenge = (clientId: string, ownerSessionId: string | null) =>
      Effect.try({
        try: () => google.challenge(clientId, ownerSessionId),
        catch: () => new GoogleVerificationError(),
      }).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
    const authenticateGoogle = Effect.fn("environment.auth.authenticateGoogle")(
      function* (payload: { readonly challenge: string; readonly idToken: string }) {
        const accounts = yield* loadGoogleAccounts();
        if (accounts.length === 0) return yield* failEnvironmentAuthInvalid("invalid_credential");
        const { identity, clientId } = yield* verifyGoogle({
          ...payload,
          ownerSessionId: null,
        });
        const freshAccounts = yield* loadGoogleAccounts();
        const matched = findEnrolledGoogleAccount(freshAccounts, clientId, identity.subject);
        if (!matched) {
          return yield* failEnvironmentAuthInvalid("invalid_credential");
        }
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const updatedAccounts = freshAccounts.map((acc) =>
          acc.subject === matched.subject && acc.clientId === matched.clientId
            ? {
                ...acc,
                ...(identity.email ? { email: identity.email } : {}),
                ...(identity.name ? { name: identity.name } : {}),
                lastUsedAt: nowIso,
              }
            : acc,
        );
        yield* saveGoogleAccounts(updatedAccounts).pipe(Effect.ignore);
        return { identity, account: matched };
      },
    );

    return handlers
      .handle(
        "googleEnrollment",
        Effect.fn("environment.auth.googleEnrollment")(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          const accounts = yield* loadGoogleAccounts();
          const defaultAcc = accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
          const storedSecret = yield* readStoredClientSecret();
          yield* appendCredentialResponseHeaders;
          return {
            registered: accounts.length > 0,
            accounts: accounts.map(toAccountSummary),
            defaultSubject: defaultAcc?.subject ?? null,
            defaultClientId: defaultAcc?.clientId ?? null,
            hasClientSecret: storedSecret !== null,
          };
        }),
      )
      .handle(
        "googleEnrollChallenge",
        Effect.fn("environment.auth.googleEnrollChallenge")(function* (args) {
          const principal = yield* requireEnvironmentScope(AuthAccessWriteScope);
          const accounts = yield* loadGoogleAccounts();
          const defaultAcc = accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
          const clientId = args.payload.clientId?.trim() || defaultAcc?.clientId || "";
          if (!clientId) {
            return yield* failEnvironmentAuthInvalid("invalid_credential");
          }
          yield* appendCredentialResponseHeaders;
          return yield* issueGoogleChallenge(clientId, principal.sessionId);
        }),
      )
      .handle(
        "googleEnroll",
        Effect.fn("environment.auth.googleEnroll")(function* (args) {
          const principal = yield* requireEnvironmentScope(AuthAccessWriteScope);
          const { identity, clientId } = yield* verifyGoogle({
            challenge: args.payload.challenge,
            idToken: args.payload.idToken,
            ownerSessionId: principal.sessionId,
          });
          const existingAccounts = yield* loadGoogleAccounts();
          const existingIdx = existingAccounts.findIndex(
            (a) => a.subject === identity.subject && a.clientId === clientId,
          );
          const nowIso = DateTime.formatIso(yield* DateTime.now);

          let effectiveClientSecret = args.payload.clientSecret?.trim() || "";
          if (effectiveClientSecret) {
            yield* secrets
              .set(googleClientSecretName, new TextEncoder().encode(effectiveClientSecret))
              .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          } else {
            effectiveClientSecret = (yield* readStoredClientSecret()) ?? "";
          }

          let driveBackupLinked =
            existingIdx >= 0 ? Boolean(existingAccounts[existingIdx]!.driveBackupLinked) : false;
          const driveRefreshToken = args.payload.driveRefreshToken?.trim() || "";
          if (driveRefreshToken && effectiveClientSecret) {
            const driveJson = yield* encodeDriveOAuthPayload({
              clientId,
              clientSecret: effectiveClientSecret,
              refreshToken: driveRefreshToken,
              ...(identity.email ? { connectedEmail: identity.email } : {}),
            }).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
            const encodedBytes = new TextEncoder().encode(driveJson);
            yield* secrets
              .set(driveOAuthPerSubjectSecretName(identity.subject), encodedBytes)
              .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
            yield* secrets
              .set(driveOAuthPrimarySecretName, encodedBytes)
              .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
            driveBackupLinked = true;
          }

          const prev = existingIdx >= 0 ? existingAccounts[existingIdx]! : null;
          const nextEntry: StoredGoogleAccount = {
            clientId,
            subject: identity.subject,
            scopes: [...principal.scopes],
            ...(identity.email
              ? { email: identity.email }
              : prev?.email
                ? { email: prev.email }
                : {}),
            ...(identity.name ? { name: identity.name } : prev?.name ? { name: prev.name } : {}),
            ...(args.payload.label?.trim()
              ? { label: args.payload.label.trim() }
              : prev?.label
                ? { label: prev.label }
                : {}),
            ...(args.payload.tier
              ? { tier: args.payload.tier }
              : prev?.tier
                ? { tier: prev.tier }
                : {}),
            driveBackupLinked,
            addedAt: prev?.addedAt ?? nowIso,
            ...(prev?.lastUsedAt ? { lastUsedAt: prev.lastUsedAt } : {}),
            isDefault: prev ? prev.isDefault : existingAccounts.length === 0,
          };

          const nextAccounts =
            existingIdx >= 0
              ? existingAccounts.map((a, idx) => (idx === existingIdx ? nextEntry : a))
              : [...existingAccounts, nextEntry];

          yield* saveGoogleAccounts(nextAccounts);
          yield* appendCredentialResponseHeaders;
          return { subject: identity.subject, account: toAccountSummary(nextEntry) };
        }),
      )
      .handle(
        "googleUnenroll",
        Effect.fn("environment.auth.googleUnenroll")(function* () {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          const accounts = yield* loadGoogleAccounts();
          for (const acc of accounts) {
            yield* secrets.remove(driveOAuthPerSubjectSecretName(acc.subject)).pipe(Effect.ignore);
          }
          yield* secrets.remove(multiGoogleSecretName).pipe(Effect.ignore);
          yield* secrets.remove(legacyGoogleSecretName).pipe(Effect.ignore);
          yield* appendCredentialResponseHeaders;
          return { removed: accounts.length > 0 };
        }),
      )
      .handle(
        "googleRemoveAccount",
        Effect.fn("environment.auth.googleRemoveAccount")(function* (args) {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          const accounts = yield* loadGoogleAccounts();
          const filtered = accounts.filter((a) => a.subject !== args.payload.subject);
          const removed = filtered.length !== accounts.length;
          if (removed) {
            yield* secrets
              .remove(driveOAuthPerSubjectSecretName(args.payload.subject))
              .pipe(Effect.ignore);
            const hasDefault = filtered.some((a) => a.isDefault);
            const normalized =
              !hasDefault && filtered.length > 0
                ? filtered.map((a, idx) => (idx === 0 ? { ...a, isDefault: true } : a))
                : filtered;
            if (normalized.length === 0) {
              yield* secrets.remove(multiGoogleSecretName).pipe(Effect.ignore);
              yield* secrets.remove(legacyGoogleSecretName).pipe(Effect.ignore);
            } else {
              yield* saveGoogleAccounts(normalized);
            }
            yield* appendCredentialResponseHeaders;
            return { removed: true, accounts: normalized.map(toAccountSummary) };
          }
          yield* appendCredentialResponseHeaders;
          return { removed: false, accounts: accounts.map(toAccountSummary) };
        }),
      )
      .handle(
        "googleSetDefaultAccount",
        Effect.fn("environment.auth.googleSetDefaultAccount")(function* (args) {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          const accounts = yield* loadGoogleAccounts();
          const found = accounts.find((a) => a.subject === args.payload.subject);
          if (!found) {
            return yield* failEnvironmentAuthInvalid("invalid_credential");
          }
          const updated = accounts.map((a) => {
            if (a.subject !== args.payload.subject) {
              return { ...a, isDefault: false };
            }
            const nextLabel =
              args.payload.label !== undefined ? args.payload.label.trim() : a.label;
            const nextTier = args.payload.tier ?? a.tier;
            return {
              ...a,
              isDefault: true,
              ...(nextLabel ? { label: nextLabel } : {}),
              ...(nextTier ? { tier: nextTier } : {}),
            };
          });
          yield* saveGoogleAccounts(updated);
          const target = updated.find((a) => a.subject === args.payload.subject)!;
          yield* appendCredentialResponseHeaders;
          return {
            account: toAccountSummary(target),
            accounts: updated.map(toAccountSummary),
          };
        }),
      )
      .handle(
        "googleBindDriveBackupAccount",
        Effect.fn("environment.auth.googleBindDriveBackupAccount")(function* (args) {
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          const accounts = yield* loadGoogleAccounts();
          const target = accounts.find((a) => a.subject === args.payload.subject);
          if (!target) {
            return yield* failEnvironmentAuthInvalid("invalid_credential");
          }
          const perSubjectOpt = yield* secrets
            .get(driveOAuthPerSubjectSecretName(target.subject))
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          if (Option.isNone(perSubjectOpt)) {
            return yield* failEnvironmentAuthInvalid("invalid_credential");
          }
          const parsed = yield* decodeDriveOAuthPayload(
            new TextDecoder().decode(perSubjectOpt.value),
          ).pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          yield* secrets
            .set(driveOAuthPrimarySecretName, perSubjectOpt.value)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          yield* appendCredentialResponseHeaders;
          return {
            bound: true,
            email: parsed.connectedEmail ?? target.email ?? null,
          };
        }),
      )
      .handle(
        "googleChallenge",
        Effect.fn("environment.auth.googleChallenge")(function* (args) {
          const accounts = yield* loadGoogleAccounts();
          if (accounts.length === 0) {
            return yield* failEnvironmentAuthInvalid("invalid_credential");
          }
          const requested = args.query.subject
            ? accounts.find((a) => a.subject === args.query.subject)
            : (accounts.find((a) => a.isDefault) ?? accounts[0]);
          const chosen = requested ?? accounts[0]!;
          yield* appendCredentialResponseHeaders;
          return yield* issueGoogleChallenge(chosen.clientId, null);
        }),
      )
      .handle(
        "googleSession",
        Effect.fn("environment.auth.googleSession")(function* (args) {
          const { identity, account } = yield* authenticateGoogle(args.payload);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const session = yield* sessions
            .issue({
              method: "browser-session-cookie",
              subject: `google:${identity.subject}`,
              scopes: account.scopes,
              client: deriveAuthClientMetadata({ request }),
            })
            .pipe(
              Effect.catch((error) =>
                failEnvironmentInternal("browser_session_issuance_failed", error),
              ),
            );
          const sessionCookies = yield* Effect.fromResult(
            Cookies.set(Cookies.empty, sessions.cookieName, session.token, {
              expires: DateTime.toDate(session.expiresAt),
              httpOnly: true,
              path: "/",
              sameSite: "lax",
            }),
          ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
          );
          yield* appendCredentialResponseHeaders;
          return {
            authenticated: true as const,
            scopes: session.scopes,
            sessionMethod: session.method,
            expiresAt: DateTime.toUtc(session.expiresAt),
          };
        }),
      )
      .handle(
        "googleToken",
        Effect.fn("environment.auth.googleToken")(function* (args) {
          const { identity, account } = yield* authenticateGoogle(args.payload);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const session = yield* sessions
            .issue({
              method: "bearer-access-token",
              subject: `google:${identity.subject}`,
              scopes: account.scopes,
              client: deriveAuthClientMetadata({ request }),
            })
            .pipe(
              Effect.catch((error) =>
                failEnvironmentInternal("access_token_issuance_failed", error),
              ),
            );
          const now = yield* DateTime.now;
          yield* appendCredentialResponseHeaders;
          return {
            access_token: session.token,
            issued_token_type: AuthAccessTokenType,
            token_type: "Bearer" as const,
            expires_in: Math.max(
              0,
              Math.floor((session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000),
            ),
            scope: session.scopes.join(" "),
          };
        }),
      )
      .handle(
        "session",
        Effect.fn("environment.auth.session")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* serverAuth.getSessionState(request);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        ),
      )
      .handle(
        "browserSession",
        Effect.fn("environment.auth.browserSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const result = yield* serverAuth.createBrowserSession(
              args.payload.credential,
              deriveAuthClientMetadata({ request }),
            );
            const sessionCookies = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, sessions.cookieName, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "token",
        Effect.fn("environment.auth.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const requestedScopes =
              args.payload.scope === undefined
                ? undefined
                : parseAllowedOAuthScope({
                    value: args.payload.scope,
                    allowedScopes: new Set<AuthEnvironmentScope>([
                      AuthOrchestrationReadScope,
                      AuthOrchestrationOperateScope,
                      AuthTerminalOperateScope,
                      AuthReviewWriteScope,
                      AuthAccessReadScope,
                      AuthAccessWriteScope,
                      AuthRelayReadScope,
                      AuthRelayWriteScope,
                    ]),
                  });
            if (requestedScopes === null) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            const proofKeyThumbprint = args.headers.dpop
              ? yield* verifyRequestDpopProof({ request }).pipe(
                  Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
                    appendDpopChallengeHeader.pipe(
                      Effect.andThen(failEnvironmentAuthInvalid("invalid_credential")),
                    ),
                  ),
                  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
                    failEnvironmentInternal("access_token_issuance_failed", error),
                  ),
                )
              : undefined;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              args.payload.subject_token,
              requestedScopes,
              deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.client_label ? { label: args.payload.client_label } : {}),
                  ...(args.payload.client_device_type
                    ? { deviceType: args.payload.client_device_type }
                    : {}),
                  ...(args.payload.client_os ? { os: args.payload.client_os } : {}),
                },
              }),
              proofKeyThumbprint ? { proofKeyThumbprint } : undefined,
            );
          },
          traceRelayRequest,
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInvalidRequestError, (error) =>
            failEnvironmentInvalidRequest(EnvironmentAuth.serverAuthInvalidRequestReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("environment.auth.webSocketTicket")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingCredential",
        Effect.fn("environment.auth.pairingCredential")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const delegatedScopes = args.payload.scopes ?? AuthStandardClientScopes;
            if (
              delegatedScopes.length === 0 ||
              new Set<AuthEnvironmentScope>(delegatedScopes).size !== delegatedScopes.length
            ) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            for (const delegatedScope of delegatedScopes) {
              if (!session.scopes.has(delegatedScope)) {
                return yield* failEnvironmentScopeRequired(delegatedScope);
              }
            }
            return yield* serverAuth.issuePairingCredential(args.payload);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_credential_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingLinks",
        Effect.fn("environment.auth.pairingLinks")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listPairingLinks();
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_links_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokePairingLink",
        Effect.fn("environment.auth.revokePairingLink")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokePairingLink(args.payload.id);
            return { revoked };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_link_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "clients",
        Effect.fn("environment.auth.clients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listClientSessions(session.sessionId);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_sessions_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokeClient",
        Effect.fn("environment.auth.revokeClient")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokeClientSession(
              session.sessionId,
              args.payload.sessionId,
            );
            return { revoked };
          },
          Effect.catchTag("ServerAuthForbiddenOperationError", () =>
            failEnvironmentOperationForbidden("current_session_revoke_not_allowed"),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeOtherClients",
        Effect.fn("environment.auth.revokeOtherClients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
            return { revokedCount };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      );
  }),
);
