// @effect-diagnostics nodeBuiltinImport:off
// The per-environment native SQLite journal is opened only when registered channels need it.
import { stat } from "node:fs/promises";
import * as Schema from "effect/Schema";
import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  TelegramChannelsError,
  type TelegramChannelsManageInput,
  type TelegramChannelsStatusInput,
  type TelegramChannelsStatusResult,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { telegramConnection, TelegramBridgeFailure } from "./connection.ts";
import { createTelegramCli, createTelegramProjectRag } from "./index.ts";

type Result = Effect.Effect<TelegramChannelsStatusResult, TelegramChannelsError>;

export class TelegramChannels extends Context.Service<
  TelegramChannels,
  {
    start: Effect.Effect<void>;
    status(input: TelegramChannelsStatusInput): Result;
    manage(input: TelegramChannelsManageInput): Result;
  }
>()("t3/telegram/service/TelegramChannels") {}

export const TelegramChannelsLive = Layer.effect(
  TelegramChannels,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const engine = yield* OrchestrationEngineService;
    const queries = yield* ProjectionSnapshotQuery;
    const registry = yield* ProviderInstanceRegistry;
    const settings = yield* ServerSettingsService;
    const connection = telegramConnection(config.baseDir);
    const stateDir = path.join(config.stateDir, "telegram");
    let runtime: ReturnType<typeof createTelegramProjectRag> | undefined;
    function getRuntime() {
      if (config.upgradeRoom || process.platform !== "win32") {
        throw new TelegramChannelsError({
          detail: "운영 T3의 Windows 실행 환경에서 채널을 연결해 주세요.",
        });
      }
      return (runtime ??= createTelegramProjectRag({
        stateDir,
        engine,
        queries,
        readPage: connection.readPage,
        cli: createTelegramCli({ registry, settings }),
      }));
    }
    const start = Effect.promise(async () => {
      if (config.upgradeRoom || process.platform !== "win32") return;
      if (
        !(
          await stat(path.join(stateDir, "telegram-project-rag.sqlite")).catch(() => null)
        )?.isFile()
      )
        return;
      const active = getRuntime();
      void active.poll().catch(() => undefined);
    }).pipe(
      Effect.catchCause(() => Effect.logWarning("텔레그램 채널 수집 기록을 열 수 없습니다.")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await runtime?.close();
      }),
    );
    if (!config.upgradeRoom && process.platform === "win32") {
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep("4 hours").pipe(
            Effect.andThen(
              Effect.sync(() => {
                void runtime?.poll().catch(() => undefined);
              }),
            ),
          ),
        ),
      );
    }
    const failed = (error: unknown) => {
      if (Schema.is(TelegramChannelsError)(error)) return error;
      if (error instanceof TelegramBridgeFailure)
        return new TelegramChannelsError({ detail: error.message });
      // SDK and child-process errors may contain private arguments; return only known app messages.
      return new TelegramChannelsError({
        detail: "텔레그램 채널 작업을 마치지 못했습니다. 계정 연결과 채널 상태를 확인해 주세요.",
      });
    };
    return {
      start,
      status: (input) =>
        Effect.tryPromise({ try: () => getRuntime().status(input), catch: failed }),
      manage: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const active = getRuntime();
            if (input.action === "lookup" || input.action === "register") {
              if (
                Option.isNone(await Effect.runPromise(queries.getProjectShellById(input.projectId)))
              ) {
                throw new TelegramChannelsError({ detail: "활성 프로젝트를 선택해 주세요." });
              }
              if (input.action === "lookup") {
                const matches = await connection.lookupTitle(input.title, signal);
                return { ...(await active.status(input)), matches };
              }
              const peer = await connection.resolveChannel(input.channel, signal);
              const result = await active.register({ projectId: input.projectId, ...peer });
              return result;
            }
            const mapping = { projectId: input.projectId, peerId: input.registrationId };
            switch (input.action) {
              case "setPolicy":
                return active.setPolicy({ ...mapping, policy: input.policy });
              case "pause":
                return active.pause(mapping);
              case "resume":
                return active.resume(mapping);
              case "remove":
                return active.unregister(mapping);
              case "sync":
                return active.sync(mapping);
              case "retry":
                return active.retry(mapping);
            }
          },
          catch: failed,
        }),
    };
  }),
);
