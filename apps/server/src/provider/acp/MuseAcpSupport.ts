import { type MuseSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import {
  MUSE_LOGIN_ENV,
  MUSE_NO_AUTO_UPDATE_ENV,
  resolveMuseBinaryPath,
} from "../Drivers/MuseHome.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const MUSE_DRIVER_KIND = ProviderDriverKind.make("muse");
export const DEFAULT_MUSE_MODEL_ID = "muse-spark-1.3";

type MuseAcpRuntimeSettings = Pick<MuseSettings, "binaryPath">;

interface MuseAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly museSettings: MuseAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly noSessionLog?: boolean;
}

export function buildMuseAcpSpawnInput(
  museSettings: MuseAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  options?: { readonly noSessionLog?: boolean },
): AcpSessionRuntime.AcpSpawnInput {
  const binary = resolveMuseBinaryPath(museSettings?.binaryPath, environment);
  const isScript = /\.[cm]?js$/i.test(binary);
  return {
    command: isScript ? process.execPath : binary,
    args: [
      ...(isScript ? [binary] : []),
      "acp",
      ...(options?.noSessionLog ? ["--no-session-log"] : []),
    ],
    cwd,
    env: {
      ...environment,
      ...(isScript ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      [MUSE_NO_AUTO_UPDATE_ENV]: "1",
      [MUSE_LOGIN_ENV]: "0",
    },
  };
}

/**
 * Create an ACP v1 session runtime backed by `muse acp`.
 *
 * Intentionally omits `authMethodId` so normal status checks and chat turns
 * never trigger interactive `muse-login` elicitation behind the user's back;
 * authentication is performed explicitly through `MuseAuth.ts`.
 */
export const makeMuseAcpRuntime = (
  input: MuseAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildMuseAcpSpawnInput(input.museSettings, input.cwd, input.environment, {
          ...(input.noSessionLog ? { noSessionLog: true } : {}),
        }),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveMuseAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_MUSE_MODEL_ID;
  return normalizeModelSlug(base, MUSE_DRIVER_KIND) ?? DEFAULT_MUSE_MODEL_ID;
}

export function currentMuseModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyMuseAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setSessionModel" | "setModel"
  >;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requestedModelId = input.requestedModelId?.trim() || undefined;
  if (requestedModelId === undefined || requestedModelId === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime.setSessionModel(requestedModelId).pipe(
    Effect.catch(() => input.runtime.setModel(requestedModelId)),
    Effect.mapError(input.mapError),
    Effect.as(requestedModelId),
  );
}
