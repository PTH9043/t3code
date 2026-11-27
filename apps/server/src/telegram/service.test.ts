import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TelegramChannels, TelegramChannelsLive } from "./service.ts";

const fixture = vi.hoisted(() => ({
  stat: vi.fn<(file: string) => Promise<{ isFile: () => boolean }>>(),
  open: vi.fn(),
  poll: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
}));

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  stat: fixture.stat,
}));
vi.mock("./index.ts", () => ({
  createTelegramCli: vi.fn(),
  createTelegramProjectRag: fixture.open,
}));
vi.mock("./connection.ts", () => ({
  telegramConnection: () => ({ readPage: vi.fn() }),
  TelegramBridgeFailure: class extends Error {},
}));

const config = ServerConfig.layerTest("/fixture", "/fixture").pipe(
  Layer.provide(
    Layer.merge(Path.layer, FileSystem.layerNoop({ makeDirectory: () => Effect.void })),
  ),
);
const live = TelegramChannelsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      config,
      Layer.mock(OrchestrationEngineService)({}),
      Layer.mock(ProjectionSnapshotQuery)({}),
      Layer.mock(ProviderInstanceRegistry)({}),
      Layer.mock(ServerSettingsService)({}),
    ),
  ),
);

beforeEach(() => {
  vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
  vi.clearAllMocks();
  fixture.stat.mockResolvedValue({ isFile: () => true });
  fixture.poll.mockResolvedValue(undefined);
  fixture.close.mockResolvedValue(undefined);
  fixture.open.mockReturnValue({ poll: fixture.poll, close: fixture.close });
});
afterEach(() => vi.unstubAllGlobals());

it.effect("polls a saved journal immediately on restart and at exactly four and eight hours", () =>
  Effect.gen(function* () {
    const start = Effect.flatMap(TelegramChannels, (service) => service.start);
    yield* start.pipe(Effect.provide(live));
    expect(fixture.poll).toHaveBeenCalledTimes(1);
    expect(fixture.close).toHaveBeenCalledTimes(1);

    yield* TestClock.adjust("9 hours");
    expect(fixture.poll).toHaveBeenCalledTimes(1);

    yield* Effect.gen(function* () {
      // An unfinished catch-up must not prevent the scheduler from dispatching its next poll.
      const catchUp = Promise.withResolvers<void>();
      fixture.poll.mockImplementationOnce(() => catchUp.promise);
      try {
        yield* start;
        expect(fixture.stat.mock.lastCall?.[0].replaceAll("\\", "/")).toBe(
          "/fixture/userdata/telegram/telegram-project-rag.sqlite",
        );
        expect(fixture.open).toHaveBeenCalledTimes(2);
        expect(fixture.poll).toHaveBeenCalledTimes(2);
        for (const countBeforeTick of [2, 3]) {
          yield* TestClock.adjust(4 * 60 * 60 * 1000 - 1);
          expect(fixture.poll).toHaveBeenCalledTimes(countBeforeTick);
          yield* TestClock.adjust("1 milli");
          expect(fixture.poll).toHaveBeenCalledTimes(countBeforeTick + 1);
        }
      } finally {
        catchUp.resolve();
      }
    }).pipe(Effect.provide(live));
    expect(fixture.close).toHaveBeenCalledTimes(2);
  }),
);

it.effect("leaves a fresh environment idle at startup and through two scheduled ticks", () =>
  Effect.gen(function* () {
    fixture.stat.mockRejectedValueOnce(
      Object.assign(new Error("Missing journal"), { code: "ENOENT" }),
    );
    const service = yield* TelegramChannels;
    yield* service.start;
    yield* TestClock.adjust("8 hours");
    expect(fixture.stat).toHaveBeenCalledTimes(1);
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.poll).not.toHaveBeenCalled();
  }).pipe(Effect.provide(live)),
);
