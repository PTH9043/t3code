import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import {
  EnvironmentCloudEndpointUnavailableError,
  type EnvironmentCloudLinkStateResult,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  type RelayClientDeviceRecord,
  type RelayClientEnvironmentRecord,
  type RelayEnvironmentLinkResponse,
  type RelayProtectedError as RelayProtectedErrorType,
  type RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request, runStream } from "@t3tools/client-runtime/rpc";
import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import { ManagedRelay } from "@t3tools/client-runtime/relay";

import {
  readPrimaryEnvironmentDescriptor,
  readPrimaryEnvironmentTarget,
} from "../environments/primary";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import { resolveCloudPublicConfig } from "./publicConfig";
import {
  finishRelayClientInstall,
  reportRelayClientInstallProgress,
  requestRelayClientInstallConfirmation,
} from "./relayClientInstallDialog";

export function normalizeRelayBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/g, "");
}

function relayUrl(): string | null {
  return resolveCloudPublicConfig().relayUrl;
}

export class CloudEnvironmentLinkError extends Data.TaggedError("CloudEnvironmentLinkError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly traceId?: string;
}> {}

const relayClientRpcError = (message: string) => (cause: unknown) =>
  new CloudEnvironmentLinkError({
    message,
    cause,
  });

function ensureRelayClientAvailable(
  environmentId: EnvironmentId,
): Effect.Effect<void, CloudEnvironmentLinkError, EnvironmentRegistry> {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const status = yield* registry
      .run(environmentId, request(WS_METHODS.cloudGetRelayClientStatus, {}))
      .pipe(
        Effect.mapError(
          relayClientRpcError("릴레이 클라이언트 사용 가능 여부를 확인하지 못했습니다."),
        ),
      );
    if (status.status === "available") return;
    if (status.status === "unsupported") {
      return yield* new CloudEnvironmentLinkError({
        message: `${status.platform}-${status.arch}에서는 T3 Code가 릴레이 클라이언트를 자동으로 설치할 수 없습니다.`,
      });
    }

    const confirmed = yield* Effect.tryPromise({
      try: () => requestRelayClientInstallConfirmation(status.version),
      catch: relayClientRpcError("릴레이 클라이언트 설치 확인을 처리하지 못했습니다."),
    });
    if (!confirmed) {
      return yield* new CloudEnvironmentLinkError({
        message: "릴레이 클라이언트 설치가 취소되었습니다.",
      });
    }

    const installed = yield* registry
      .runStream(
        environmentId,
        runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
          Stream.tap((event) => Effect.sync(() => reportRelayClientInstallProgress(event))),
        ),
      )
      .pipe(
        Stream.runLast,
        Effect.mapError(relayClientRpcError("릴레이 클라이언트를 설치하지 못했습니다.")),
        Effect.ensuring(Effect.sync(finishRelayClientInstall)),
      );
    if (Option.isNone(installed) || installed.value.type !== "complete") {
      return yield* new CloudEnvironmentLinkError({
        message: "릴레이 클라이언트 설치가 완료되었지만 최종 상태를 확인하지 못했습니다.",
      });
    }
    const installedStatus = installed.value.status;
    if (installedStatus.status !== "available") {
      return yield* new CloudEnvironmentLinkError({
        message:
          installedStatus.status === "unsupported"
            ? `${installedStatus.platform}-${installedStatus.arch}에서는 T3 Code가 릴레이 클라이언트를 자동으로 설치할 수 없습니다.`
            : "설치 후에도 릴레이 클라이언트를 사용할 수 없습니다.",
      });
    }
  });
}

const isEnvironmentCloudApiError = Schema.is(
  Schema.Union([
    EnvironmentHttpBadRequestError,
    EnvironmentHttpUnauthorizedError,
    EnvironmentHttpForbiddenError,
    EnvironmentHttpConflictError,
    EnvironmentHttpInternalServerError,
    EnvironmentCloudEndpointUnavailableError,
  ]),
);

function relayProtectedErrorMessage(error: RelayProtectedErrorType): string {
  switch (error._tag) {
    case "RelayAuthInvalidError":
      switch (error.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return "릴레이가 클라우드 세션 토큰을 거부했습니다.";
        case "invalid_dpop":
          return "릴레이가 DPoP 증명을 거부했습니다.";
        case "not_authorized":
          return "릴레이가 인증된 요청을 거부했습니다.";
      }
    case "RelayEnvironmentLinkProofExpiredError":
      return "릴레이가 만료된 환경 연결 증명을 거부했습니다.";
    case "RelayEnvironmentLinkProofInvalidError":
      return `릴레이가 환경 연결 증명을 거부했습니다(${error.reason}).`;
    case "RelayEnvironmentConnectNotAuthorizedError":
      // "Not authorized" covers non-auth causes too; surface the reason so a
      // missing link doesn't read as a credential problem.
      if (error.reason === "environment_link_not_found") {
        return "릴레이에 이 환경의 활성 연결이 없습니다. 환경 서버가 아직 연결을 다시 설정하지 못했을 수 있습니다.";
      }
      return error.reason
        ? `릴레이가 환경 연결 요청을 거부했습니다(${error.reason}).`
        : "릴레이가 환경 연결 요청을 거부했습니다.";
    case "RelayEnvironmentEndpointUnavailableError":
      return `릴레이가 환경 엔드포인트에 연결하지 못했습니다(${error.reason}).`;
    case "RelayEnvironmentEndpointTimedOutError":
      return "릴레이가 환경 엔드포인트에 연결하는 동안 시간이 초과되었습니다.";
    case "RelayEnvironmentLinkFailedError":
      return `릴레이가 환경을 연결하지 못했습니다(${error.reason}).`;
    case "RelayEnvironmentLinkUnavailableError":
      return `릴레이가 관리형 엔드포인트를 준비할 수 없습니다(${error.reason}).`;
    case "RelayEnvironmentLinkLimitExceededError":
      return `이 계정은 관리형 터널 최대 ${error.maxTunnels}개를 이미 사용 중이어서 릴레이가 연결을 거부했습니다. 기존 환경 연결 하나를 해제하세요.`;
    case "RelayAgentActivityPublishProofExpiredError":
      return "릴레이가 만료된 에이전트 활동 게시 증명을 거부했습니다.";
    case "RelayAgentActivityPublishProofInvalidError":
      return `릴레이가 에이전트 활동 게시 증명을 거부했습니다(${error.reason}).`;
    case "RelayInternalError":
      return `릴레이 내부 오류가 발생했습니다(${error.reason}).`;
  }
}

function decodedRelayClientError(message: string) {
  return (cause: ManagedRelay.ManagedRelayClientError) => {
    const relayError =
      cause._tag === "ManagedRelayRequestFailedError" ? cause.relayError : undefined;
    const traceId = cause._tag === "ManagedRelayRequestFailedError" ? cause.traceId : undefined;
    const detail = relayError ? relayProtectedErrorMessage(relayError) : null;
    return new CloudEnvironmentLinkError({
      message: detail ? `${message}: ${detail}` : message,
      cause,
      ...(traceId ? { traceId } : {}),
    });
  };
}

function findEnvironmentCloudApiError(cause: unknown): { readonly message: string } | null {
  if (isEnvironmentCloudApiError(cause)) {
    return cause;
  }
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  return "cause" in cause ? findEnvironmentCloudApiError(cause.cause) : null;
}

const environmentApiError = (message: string) => (cause: unknown) => {
  const environmentError = findEnvironmentCloudApiError(cause);
  return new CloudEnvironmentLinkError({
    message: environmentError
      ? `${message.replace(/[.:]$/, "")}: ${environmentError.message}`
      : message,
    cause,
  });
};

function endpointOrigin(httpBaseUrl: string) {
  const url = new URL(httpBaseUrl);
  return {
    localHttpHost: "127.0.0.1",
    localHttpPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
}

const MANAGED_ENDPOINT_PROVIDER_KIND =
  "cloudflare_tunnel" satisfies RelayManagedEndpointProviderKind;

function ensureLinkedEnvironmentMatches(input: {
  readonly expectedEnvironmentId: string;
  readonly expectedProviderKind: RelayManagedEndpointProviderKind;
  readonly link: RelayEnvironmentLinkResponse;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  if (input.link.environmentId !== input.expectedEnvironmentId) {
    return new CloudEnvironmentLinkError({
      message: "릴레이가 다른 환경의 자격 증명을 반환했습니다.",
    });
  }
  if (input.link.endpoint.providerKind !== input.expectedProviderKind) {
    return new CloudEnvironmentLinkError({
      message: "릴레이가 다른 엔드포인트 제공자의 자격 증명을 반환했습니다.",
    });
  }
  return Effect.void;
}

export interface CloudLinkTarget {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export type CloudLinkState = EnvironmentCloudLinkStateResult;

export function collectCloudLinkTargets(input: {
  readonly primary: CloudLinkTarget | null;
  readonly saved: ReadonlyArray<CloudLinkTarget>;
}): ReadonlyArray<CloudLinkTarget> {
  const byId = new Map<string, CloudLinkTarget>();
  if (input.primary) {
    byId.set(input.primary.environmentId, input.primary);
  }
  for (const environment of input.saved) {
    if (!byId.has(environment.environmentId)) {
      byId.set(environment.environmentId, environment);
    }
  }
  return [...byId.values()];
}

export function readPrimaryCloudLinkTarget(): CloudLinkTarget | null {
  const descriptor = readPrimaryEnvironmentDescriptor();
  const target = readPrimaryEnvironmentTarget();
  if (!descriptor || !target) {
    return null;
  }
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    httpBaseUrl: target.target.httpBaseUrl,
    wsBaseUrl: target.target.wsBaseUrl,
  };
}

export function listManagedCloudEnvironments(input: {
  readonly clerkToken: string;
}): Effect.Effect<
  ReadonlyArray<RelayClientEnvironmentRecord>,
  CloudEnvironmentLinkError,
  ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudEnvironmentLinkError({
        message: "T3CODE_RELAY_URL이 설정되지 않았습니다.",
      });
    }
    const relayClient = yield* ManagedRelay.ManagedRelayClient;
    return yield* relayClient
      .listEnvironments({
        clerkToken: input.clerkToken,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CloudEnvironmentLinkError({
              message: "릴레이에서 관리하는 환경 목록을 불러오지 못했습니다.",
              cause,
            }),
        ),
      );
  });
}

export function listCloudDevices(input: {
  readonly clerkToken: string;
}): Effect.Effect<
  ReadonlyArray<RelayClientDeviceRecord>,
  CloudEnvironmentLinkError,
  ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    if (!relayUrl()) {
      return yield* new CloudEnvironmentLinkError({
        message: "T3CODE_RELAY_URL이 설정되지 않았습니다.",
      });
    }
    const relayClient = yield* ManagedRelay.ManagedRelayClient;
    return yield* relayClient.listDevices({ clerkToken: input.clerkToken }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudEnvironmentLinkError({
            message: "클라우드 기기 목록을 불러오지 못했습니다.",
            cause,
          }),
      ),
    );
  });
}

export function readPrimaryCloudLinkState(input: {
  readonly target: CloudLinkTarget;
}): Effect.Effect<CloudLinkState | null, CloudEnvironmentLinkError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(input.target.httpBaseUrl);
    return yield* client.connect
      .linkState({ headers: {} })
      .pipe(Effect.mapError(environmentApiError("환경의 클라우드 연결 상태를 읽지 못했습니다.")));
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer));
}

export function updatePrimaryCloudPreferences(input: {
  readonly target: CloudLinkTarget;
  readonly publishAgentActivity: boolean;
}): Effect.Effect<CloudLinkState, CloudEnvironmentLinkError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(input.target.httpBaseUrl);
    return yield* client.connect
      .preferences({
        headers: {},
        payload: input,
      })
      .pipe(
        Effect.mapError(environmentApiError("환경의 클라우드 설정을 업데이트하지 못했습니다.")),
      );
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer));
}

export function unlinkPrimaryEnvironmentFromCloud(input: {
  readonly target: CloudLinkTarget;
  readonly clerkToken: string | null;
}): Effect.Effect<
  void,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient | ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(input.target.httpBaseUrl);
    yield* client.connect
      .unlink({ headers: {} })
      .pipe(Effect.mapError(environmentApiError("클라우드에서 환경 연결을 해제하지 못했습니다.")));

    const configuredRelayUrl = relayUrl();
    if (configuredRelayUrl && input.clerkToken) {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient
        .unlinkEnvironment({
          clerkToken: input.clerkToken,
          environmentId: EnvironmentId.make(input.target.environmentId),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not revoke cloud environment link after local unlink.", {
              cause,
            }),
          ),
        );
    }
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer));
}

// "publish_only" links the environment to the relay for agent-activity
// publishing alone: no managed tunnel is provisioned, so it can be toggled
// independently of T3 Connect while clients reach the environment out of band.
export type CloudLinkMode = "managed" | "publish_only";

const PUBLISH_ONLY_PROVIDER_KIND = "manual" satisfies RelayManagedEndpointProviderKind;

export function linkPrimaryEnvironmentToCloud(input: {
  readonly target: CloudLinkTarget;
  readonly clerkToken: string;
  readonly mode?: CloudLinkMode;
}): Effect.Effect<
  void,
  CloudEnvironmentLinkError,
  EnvironmentRegistry | HttpClient.HttpClient | ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudEnvironmentLinkError({
        message: "T3CODE_RELAY_URL이 설정되지 않았습니다.",
      });
    }
    const managedTunnelsEnabled = (input.mode ?? "managed") === "managed";
    const providerKind = managedTunnelsEnabled
      ? MANAGED_ENDPOINT_PROVIDER_KIND
      : PUBLISH_ONLY_PROVIDER_KIND;
    const relayClient = yield* ManagedRelay.ManagedRelayClient;
    const environmentClient = yield* makeEnvironmentHttpApiClient(input.target.httpBaseUrl);
    if (managedTunnelsEnabled) {
      yield* ensureRelayClientAvailable(EnvironmentId.make(input.target.environmentId));
    }

    const challenge = yield* relayClient
      .createEnvironmentLinkChallenge({
        clerkToken: input.clerkToken,
        payload: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled,
        },
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(
            `${configuredRelayUrl}/v1/client/environment-link-challenges 요청 실패`,
          ),
        ),
      );
    const proof = yield* environmentClient.connect
      .linkProof({
        headers: {},
        payload: {
          challenge: challenge.challenge,
          relayIssuer: configuredRelayUrl,
          endpoint: {
            httpBaseUrl: input.target.httpBaseUrl,
            wsBaseUrl: input.target.wsBaseUrl,
            providerKind,
          },
          origin: endpointOrigin(input.target.httpBaseUrl),
        },
      })
      .pipe(Effect.mapError(environmentApiError("환경 연결 증명을 가져오지 못했습니다.")));
    const link = yield* relayClient
      .linkEnvironment({
        clerkToken: input.clerkToken,
        payload: {
          proof,
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled,
        },
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(`${configuredRelayUrl}/v1/client/environment-links 요청 실패`),
        ),
      );
    yield* ensureLinkedEnvironmentMatches({
      expectedEnvironmentId: input.target.environmentId,
      expectedProviderKind: providerKind,
      link,
    });

    yield* environmentClient.connect
      .relayConfig({
        headers: {},
        payload: {
          relayUrl: configuredRelayUrl,
          relayIssuer: link.relayIssuer,
          cloudUserId: link.cloudUserId,
          environmentCredential: link.environmentCredential,
          cloudMintPublicKey: link.cloudMintPublicKey,
          endpointRuntime: link.endpointRuntime,
        },
      })
      .pipe(Effect.mapError(environmentApiError("환경의 릴레이 접근을 설정하지 못했습니다.")));
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer));
}
