import * as NodeCrypto from "node:crypto";
import {
  ClaudeSettings,
  CodexSettings,
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

export function isBrowserLoginDriver(driver: string): driver is "codex" | "claudeAgent" {
  return driver === "codex" || driver === "claudeAgent";
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

  const settings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const instanceId = ProviderInstanceId.make(
    `${driver === "codex" ? "codex" : "claude"}_${NodeCrypto.randomUUID().slice(0, 8)}`,
  );
  const dedicatedHomePath = path.join(
    serverConfig.stateDir,
    "provider-instances",
    instanceId,
    driver === "codex" ? "codex-home" : "claude-home",
  );

  const allSettings = yield* settings.getSettings.pipe(
    Effect.mapError(() => loginError("설정을 읽지 못했습니다.")),
  );
  if (allSettings.providerInstances[instanceId]) {
    return yield* loginError(`인스턴스 '${instanceId}'가 이미 있습니다. 다시 시도하세요.`);
  }

  const processEnv = mergeProviderInstanceEnvironment([]);

  let binaryPath: string;
  let loginArgs: ReadonlyArray<string>;
  let statusArgs: ReadonlyArray<string>;
  let environment: NodeJS.ProcessEnv;

  if (driver === "codex") {
    const config = decodeCodexSettings({ homePath: dedicatedHomePath });
    const homeLayout = yield* resolveCodexHomeLayout(config);
    binaryPath = config.binaryPath || "codex";
    loginArgs = ["login"];
    statusArgs = ["login", "status"];
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
  } else {
    const config = decodeClaudeSettings({ homePath: dedicatedHomePath });
    binaryPath = config.binaryPath || "claude";
    loginArgs = ["auth", "login"];
    statusArgs = ["auth", "status"];
    environment = yield* makeClaudeEnvironment(config, processEnv);
    yield* fs
      .makeDirectory(dedicatedHomePath, { recursive: true })
      .pipe(
        Effect.mapError(() =>
          loginError(`Claude 홈 디렉터리를 만들지 못했습니다: ${dedicatedHomePath}`),
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
  const displayName = email
    ? `${driver === "codex" ? "Codex" : "Claude"} ${email}`
    : `${driver === "codex" ? "Codex" : "Claude"} 계정`;

  yield* settings
    .updateSettings({
      providerInstancesToUpsert: {
        [instanceId]: {
          driver: ProviderDriverKind.make(driver),
          enabled: true,
          displayName,
          config: { homePath: dedicatedHomePath },
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
