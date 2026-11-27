import {
  DesktopAssistantModelUpdate,
  DesktopAssistantConversationRef,
  DesktopAssistantSettings,
  DesktopAssistantSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

export const getSettings = DesktopIpc.makeIpcMethod({
  channel: Channels.GET_ASSISTANT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: DesktopAssistantSettings,
  handler: Effect.fn("desktop.assistant.getSettings")(function* () {
    return yield* (yield* DesktopWindow.DesktopWindow).getAssistantSettings;
  }),
});

export const setSettings = DesktopIpc.makeIpcMethod({
  channel: Channels.SET_ASSISTANT_SETTINGS_CHANNEL,
  payload: DesktopAssistantSettingsPatch,
  result: DesktopAssistantSettings,
  handler: Effect.fn("desktop.assistant.setSettings")(function* (patch) {
    return yield* (yield* DesktopWindow.DesktopWindow).setAssistantSettings(patch);
  }),
});

export const open = DesktopIpc.makeIpcMethod({
  channel: Channels.OPEN_ASSISTANT_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.assistant.open")(function* () {
    yield* (yield* DesktopWindow.DesktopWindow).openAssistant;
  }),
});

export const close = DesktopIpc.makeIpcMethod({
  channel: Channels.CLOSE_ASSISTANT_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.assistant.close")(function* () {
    yield* (yield* DesktopWindow.DesktopWindow).closeAssistant;
  }),
});

export const publishModelUpdate = DesktopIpc.makeIpcMethod({
  channel: Channels.ASSISTANT_MODEL_UPDATE_CHANNEL,
  payload: DesktopAssistantModelUpdate,
  result: Schema.Void,
  handler: Effect.fn("desktop.assistant.publishModelUpdate")(function* (update) {
    yield* (yield* DesktopWindow.DesktopWindow).setAssistantModel(update);
    yield* (yield* ElectronWindow.ElectronWindow).sendAll(
      Channels.ASSISTANT_MODEL_CHANGED_CHANNEL,
      update,
    );
  }),
});

export const getModelSelection = DesktopIpc.makeIpcMethod({
  channel: Channels.ASSISTANT_MODEL_GET_CHANNEL,
  payload: DesktopAssistantConversationRef,
  result: Schema.NullOr(DesktopAssistantModelUpdate),
  handler: Effect.fn("desktop.assistant.getModelSelection")(function* (ref) {
    return yield* (yield* DesktopWindow.DesktopWindow).getAssistantModel(ref);
  }),
});
