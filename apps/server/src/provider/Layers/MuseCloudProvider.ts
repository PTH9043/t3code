import {
  type ModelCapabilities,
  type MuseSettings,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  readMuseCloudAuthSummary,
  resolveMuseCloudBinaryPath,
  resolveMuseCloudConfigDir,
} from "../Drivers/MuseCloudHome.ts";

export const MUSE_CLOUD_CHAT_MODEL = "muse-cloud-chat";
export const MUSE_CLOUD_MAIN_MODEL = "muse-cloud-main";

const MUSE_CLOUD_PRESENTATION = {
  displayName: "Muse Cloud",
  badgeLabel: "Cloud · Google",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const STATUS_PROBE_TIMEOUT_MS = 15_000;

export const MUSE_CLOUD_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: MUSE_CLOUD_CHAT_MODEL,
    name: "Muse Cloud · 새 대화",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: MUSE_CLOUD_MAIN_MODEL,
    name: "Muse Cloud · 메인 대화",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface MuseCloudStatusInfo {
  readonly vmId?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly sessions?: number;
}

export function parseMuseCloudStatusJson(stdout: string): MuseCloudStatusInfo | undefined {
  const parsed = decodeUnknownJson(stdout.trim());
  if (Option.isNone(parsed) || !isPlainRecord(parsed.value)) {
    return undefined;
  }
  const root = parsed.value;
  const vmId = typeof root.vm_id === "string" && root.vm_id.trim() ? root.vm_id.trim() : undefined;
  const sessions = typeof root.sessions === "number" ? root.sessions : undefined;

  let email: string | undefined;
  let displayName: string | undefined;
  const identity = isPlainRecord(root.identity) ? root.identity : undefined;
  if (identity) {
    for (const key of ["email", "user_email", "account_email"] as const) {
      const val = identity[key];
      if (typeof val === "string" && val.trim().includes("@")) {
        email = val.trim();
        break;
      }
    }
    for (const key of ["name", "full_name", "display_name", "handle", "username"] as const) {
      const val = identity[key];
      if (typeof val === "string" && val.trim()) {
        displayName = val.trim();
        break;
      }
    }
  }

  return {
    ...(vmId ? { vmId } : {}),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
  };
}

function cloudModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    MUSE_CLOUD_BUILT_IN_MODELS,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export function buildInitialMuseCloudProviderSnapshot(
  museSettings: MuseSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = cloudModelsFromSettings(museSettings.customModels);

    if (!museSettings.enabled) {
      return buildServerProvider({
        presentation: MUSE_CLOUD_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "muse.ai 클라우드 계정이 비활성화되어 있습니다.",
        },
      });
    }

    return buildServerProvider({
      presentation: MUSE_CLOUD_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "muse.ai 클라우드(muse-cli) 상태를 확인하는 중입니다...",
      },
    });
  });
}

const runMuseCloudCli = (
  museSettings: MuseSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = resolveMuseCloudBinaryPath(museSettings.cloudBinaryPath);
    const spawnCommand = yield* resolveSpawnCommand(command, args, {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: {
          ...environment,
          PYTHONIOENCODING: "utf-8",
        },
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkMuseCloudProviderStatus = Effect.fn("checkMuseCloudProviderStatus")(function* (
  museSettings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = cloudModelsFromSettings(museSettings.customModels);

  if (!museSettings.enabled) {
    return buildServerProvider({
      presentation: MUSE_CLOUD_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "muse.ai 클라우드 계정이 비활성화되어 있습니다.",
      },
    });
  }

  const versionResult = yield* runMuseCloudCli(museSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation: MUSE_CLOUD_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "muse-cli가 설치되어 있지 않습니다. `uv tool install --from https://github.com/nikships/muse-cli.git muse-cli`로 설치하세요."
          : "muse-cli 상태 확인을 실행하지 못했습니다.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: MUSE_CLOUD_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "muse-cli 버전 확인 시간이 초과되었습니다.",
      },
    });
  }

  const versionOut = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOut.stdout}\n${versionOut.stderr}`);
  if (versionOut.code !== 0) {
    return buildServerProvider({
      presentation: MUSE_CLOUD_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "muse-cli가 설치되어 있지만 실행에 실패했습니다.",
      },
    });
  }

  const configDir = yield* resolveMuseCloudConfigDir(museSettings, environment);
  const authSummary = yield* readMuseCloudAuthSummary(configDir);
  if (!authSummary.authenticated) {
    return buildServerProvider({
      presentation: MUSE_CLOUD_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message: authSummary.expired
          ? "muse.ai 로그인 쿠키가 만료되었습니다. 'muse.ai (Google 로그인)' 버튼으로 다시 로그인하세요."
          : "muse.ai 계정에 로그인되어 있지 않습니다. 'muse.ai (Google 로그인)' 버튼으로 로그인하세요.",
      },
    });
  }

  const statusExit = yield* runMuseCloudCli(museSettings, ["status"], environment).pipe(
    Effect.timeoutOption(STATUS_PROBE_TIMEOUT_MS),
    Effect.exit,
  );

  if (Exit.isSuccess(statusExit) && Option.isSome(statusExit.value)) {
    const statusOut = statusExit.value.value;
    if (statusOut.code === 0) {
      const info = parseMuseCloudStatusJson(statusOut.stdout);
      const cleanName =
        info?.displayName && !info.displayName.includes("\uFFFD") ? info.displayName : undefined;
      const auth: ServerProviderAuth = {
        status: "authenticated",
        type: "oauth",
        label: cleanName
          ? `Muse Cloud (${cleanName})`
          : info?.vmId
            ? `Muse Cloud · ${info.vmId.slice(0, 8)}`
            : "Muse Cloud (Google)",
        ...(info?.email ? { email: info.email } : {}),
      };
      return buildServerProvider({
        presentation: MUSE_CLOUD_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "ready",
          auth,
        },
      });
    }

    if (statusOut.code === 2) {
      return buildServerProvider({
        presentation: MUSE_CLOUD_PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: { status: "unauthenticated" },
          message:
            "muse.ai 세션 인증이 만료되었습니다. 'muse.ai (Google 로그인)' 버튼으로 다시 로그인하세요.",
        },
      });
    }
  }

  return buildServerProvider({
    presentation: MUSE_CLOUD_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "warning",
      auth: { status: "authenticated", type: "oauth", label: "muse.ai (Google)" },
      message:
        "muse.ai 로그인 쿠키는 저장되어 있지만 클라우드 VM 게이트웨이 응답을 확인하지 못했습니다.",
    },
  });
});
