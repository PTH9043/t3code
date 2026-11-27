import { ClientSettingsSchema } from "@t3tools/contracts";
import { ClientSettingsPatch } from "@t3tools/contracts/settings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Writes and notifications share an order across all desktop windows.
const updateLock = Semaphore.makeUnsafe(1);

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const setClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: (settings) =>
    updateLock.withPermits(1)(
      Effect.gen(function* () {
        yield* (yield* DesktopClientSettings.DesktopClientSettings).set(settings);
        yield* (yield* ElectronWindow.ElectronWindow).sendAll(
          IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL,
          settings,
        );
      }),
    ),
});

export const patchClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PATCH_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsPatch,
  result: ClientSettingsSchema,
  handler: (patch) =>
    updateLock.withPermits(1)(
      Effect.gen(function* () {
        const next = yield* (yield* DesktopClientSettings.DesktopClientSettings).patch(patch);
        yield* (yield* ElectronWindow.ElectronWindow).sendAll(
          IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL,
          next,
        );
        return next;
      }),
    ),
});
