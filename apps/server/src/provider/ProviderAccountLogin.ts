import * as NodeCrypto from "node:crypto";
import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GeminiSettings,
  GrokSettings,
  ProviderAccountLoginError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAccountLoginInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { isCommandMissingCause, spawnAndCollect } from "./providerSnapshot.ts";
import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const decodeGeminiSettings = Schema.decodeSync(GeminiSettings);

function loginError(detail: string): ProviderAccountLoginError {
  return new ProviderAccountLoginError({ detail });
}

const AuthStatusResponseShape = Schema.Struct({
  loggedIn: Schema.Boolean,
  account: Schema.optional(
    Schema.Struct({
      email: Schema.optional(Schema.String),
    }),
  ),
});
const decodeAuthStatus = Schema.decodeUnknownOption(Schema.fromJsonString(AuthStatusResponseShape));

type BrowserLoginDriver = "codex" | "claudeAgent" | "cursor" | "grok" | "gemini";

interface BrowserLoginSpec {
  readonly instancePrefix: string;
  readonly displayName: string;
  readonly homeFolder: string;
  readonly homeEnvVar?: string;
  readonly binary: string;
  readonly loginArgs: ReadonlyArray<string>;
  readonly statusArgs: ReadonlyArray<string>;
}

const BROWSER_LOGIN_SPECS: Record<BrowserLoginDriver, BrowserLoginSpec> = {
  codex: {
    instancePrefix: "codex",
    displayName: "Codex",
    homeFolder: "codex-home",
    homeEnvVar: "CODEX_HOME",
    binary: "codex",
    loginArgs: ["login"],
    statusArgs: ["login", "status"],
  },
  claudeAgent: {
    instancePrefix: "claude",
    displayName: "Claude",
    homeFolder: "claude-home",
    binary: "claude",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
  },
  cursor: {
    instancePrefix: "cursor",
    displayName: "Cursor",
    homeFolder: "cursor-home",
    homeEnvVar: "CURSOR_HOME",
    binary: "cursor-agent",
    loginArgs: ["login"],
    statusArgs: ["status"],
  },
  grok: {
    instancePrefix: "grok",
    displayName: "Grok",
    homeFolder: "grok-home",
    homeEnvVar: "GROK_HOME",
    binary: "grok",
    loginArgs: ["login"],
    statusArgs: ["status"],
  },
  gemini: {
    instancePrefix: "gemini",
    displayName: "Gemini",
    homeFolder: "gemini-home",
    homeEnvVar: "GEMINI_CLI_HOME",
    binary: "gemini",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
  },
  // NOTE: opencode is intentionally absent. `opencode auth login` is an
  // interactive TUI — there is no non-interactive browser OAuth path. Google
  // in opencode accepts an API key only (no OAuth), so routing users through
  // a "browser login" flow here always fails. Users who want a Google
  // account should pick the Gemini driver instead.
};

export function isBrowserLoginDriver(driver: string): driver is BrowserLoginDriver {
  return Object.hasOwn(BROWSER_LOGIN_SPECS, driver);
}

/**
 * Create a fresh per-account provider instance, run `codex login` or
 * `claude auth login` in that instance's dedicated home, let the CLI open the
 * system browser, and confirm the account landed via status check before
 * saving the instance into settings.
 */
export const loginProviderAccount = Effect.fn("loginProviderAccount")(function* (
  input: ProviderAccountLoginInput,
) {
  const driver = input.driver;
  if (!isBrowserLoginDriver(driver)) {
    return yield* loginError(`'${driver}' 드라이버는 브라우저 로그인을 지원하지 않습니다.`);
  }
  const spec = BROWSER_LOGIN_SPECS[driver];

  const settings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const instanceId = ProviderInstanceId.make(
    `${spec.instancePrefix}_${NodeCrypto.randomUUID().slice(0, 8)}`,
  );
  const dedicatedHomePath = path.join(
    serverConfig.stateDir,
    "provider-instances",
    instanceId,
    spec.homeFolder,
  );

  const allSettings = yield* settings.getSettings.pipe(
    Effect.mapError(() => loginError("설정을 읽지 못했습니다.")),
  );
  if (allSettings.providerInstances[instanceId]) {
    return yield* loginError(`인스턴스 '${instanceId}'가 이미 있습니다. 다시 시도하세요.`);
  }

  const processEnv = mergeProviderInstanceEnvironment([]);

  let binaryPath: string;
  let environment: NodeJS.ProcessEnv;
  const loginArgs = spec.loginArgs;
  const statusArgs = spec.statusArgs;

  if (driver === "codex") {
    const config = decodeCodexSettings({ homePath: dedicatedHomePath });
    const homeLayout = yield* resolveCodexHomeLayout(config);
    binaryPath = config.binaryPath || spec.binary;
    environment = {
      ...processEnv,
      CODEX_HOME: homeLayout.effectiveHomePath ?? dedicatedHomePath,
    };
    yield* fs
      .makeDirectory(homeLayout.effectiveHomePath ?? dedicatedHomePath, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          loginError(`Codex 홈 디렉터리를 만들지 못했습니다: ${dedicatedHomePath}`),
        ),
      );
  } else if (driver === "claudeAgent") {
    const config = decodeClaudeSettings({ homePath: dedicatedHomePath });
    binaryPath = config.binaryPath || spec.binary;
    environment = yield* makeClaudeEnvironment(config, processEnv);
    yield* fs
      .makeDirectory(dedicatedHomePath, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          loginError(`Claude 홈 디렉터리를 만들지 못했습니다: ${dedicatedHomePath}`),
        ),
      );
  } else {
    if (driver === "cursor") {
      const config = decodeCursorSettings({});
      binaryPath = config.binaryPath || spec.binary;
    } else if (driver === "grok") {
      const config = decodeGrokSettings({});
      binaryPath = config.binaryPath || spec.binary;
    } else {
      const config = decodeGeminiSettings({});
      binaryPath = config.binaryPath || spec.binary;
    }
    environment = {
      ...processEnv,
      ...(spec.homeEnvVar ? { [spec.homeEnvVar]: dedicatedHomePath } : {}),
    };
    yield* fs
      .makeDirectory(dedicatedHomePath, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          loginError(`${spec.displayName} 홈 디렉터리를 만들지 못했습니다: ${dedicatedHomePath}`),
        ),
      );
  }

  const spawnCommand = yield* resolveSpawnCommand(binaryPath, loginArgs, {
    env: environment,
    extendEnv: true,
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const loginProcess = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: environment,
    shell: spawnCommand.shell,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const child = yield* spawner
    .spawn(loginProcess)
    .pipe(
      Effect.mapError((cause) =>
        loginError(`로그인 프로세스를 시작하지 못했습니다: ${String(cause)}`),
      ),
    );
  const exitCode = yield* child.exitCode.pipe(
    Effect.mapError((cause) =>
      loginError(`로그인 프로세스 종료를 확인하지 못했습니다: ${String(cause)}`),
    ),
    Effect.map(Number),
  );

  if (exitCode !== 0) {
    return yield* loginError(
      `로그인이 완료되지 않았습니다 (종료 코드 ${exitCode}). 브라우저에서 로그인을 완료했는지 확인하세요.`,
    );
  }

  const statusSpawn = yield* resolveSpawnCommand(binaryPath, statusArgs, {
    env: environment,
    extendEnv: true,
  });
  const statusCommand = ChildProcess.make(statusSpawn.command, statusSpawn.args, {
    env: environment,
    shell: statusSpawn.shell,
    extendEnv: true,
  });
  const statusResult = yield* spawnAndCollect(binaryPath, statusCommand).pipe(
    Effect.mapError((cause) => {
      if (isCommandMissingCause(cause))
        return loginError(`${binaryPath} CLI를 찾을 수 없습니다. 설치 상태를 확인하세요.`);
      return loginError(`로그인 확인에 실패했습니다: ${String(cause)}`);
    }),
  );

  const parsed = decodeAuthStatus(statusResult.stdout);
  if (Option.isNone(parsed) || !parsed.value.loggedIn) {
    return yield* loginError(
      "브라우저에서 로그인을 완료했지만 CLI가 로그인 상태를 인식하지 못했습니다. CLI 버전과 네트워크 상태를 확인하세요.",
    );
  }

  const email = parsed.value.account?.email;
  const displayName = email ? `${spec.displayName} ${email}` : `${spec.displayName} 계정`;

  // homePath is a real setting only for drivers that support it; other
  // drivers isolate auth through the spawned environment at runtime.
  const supportsHomePath = driver === "codex" || driver === "claudeAgent" || driver === "gemini";
  yield* settings
    .updateSettings({
      providerInstancesToUpsert: {
        [instanceId]: {
          driver: ProviderDriverKind.make(driver),
          enabled: true,
          displayName,
          ...(supportsHomePath ? { config: { homePath: dedicatedHomePath } } : {}),
        },
      },
    })
    .pipe(Effect.mapError(() => loginError("로그인은 성공했지만 계정을 저장하지 못했습니다.")));

  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    ...(email ? { email } : {}),
  };
});
