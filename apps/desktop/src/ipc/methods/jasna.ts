import { DesktopJasnaSnapshot, DesktopJasnaStart } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as JasnaSupervisor from "../../jasna/JasnaSupervisor.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const videoFilters = [
  { name: "영상 파일", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v", "mpg", "mpeg"] },
];

export const snapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JASNA_SNAPSHOT_CHANNEL,
  payload: Schema.Void,
  result: DesktopJasnaSnapshot,
  handler: () =>
    Effect.gen(function* () {
      const supervisor = yield* JasnaSupervisor.JasnaSupervisor;
      return supervisor.snapshot();
    }),
});

export const pickExecutable = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JASNA_PICK_EXECUTABLE_CHANNEL,
  payload: Schema.Void,
  result: DesktopJasnaSnapshot,
  handler: Effect.fn("desktop.ipc.jasna.pickExecutable")(function* () {
    const supervisor = yield* JasnaSupervisor.JasnaSupervisor;
    const dialog = yield* ElectronDialog.ElectronDialog;
    const window = yield* ElectronWindow.ElectronWindow;
    const selected = yield* dialog.pickFiles({
      owner: yield* window.focusedMainOrFirst,
      defaultPath: Option.none(),
      filters: [],
      multiple: false,
    });
    return selected[0] === undefined
      ? supervisor.snapshot()
      : yield* JasnaSupervisor.attempt(() => supervisor.selectExecutable(selected[0]!));
  }),
});

export const pickInput = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JASNA_PICK_INPUT_CHANNEL,
  payload: Schema.Void,
  result: DesktopJasnaSnapshot,
  handler: Effect.fn("desktop.ipc.jasna.pickInput")(function* () {
    const supervisor = yield* JasnaSupervisor.JasnaSupervisor;
    const dialog = yield* ElectronDialog.ElectronDialog;
    const window = yield* ElectronWindow.ElectronWindow;
    const selected = yield* dialog.pickFiles({
      owner: yield* window.focusedMainOrFirst,
      defaultPath: Option.none(),
      filters: videoFilters,
      multiple: false,
    });
    return selected[0] === undefined
      ? supervisor.snapshot()
      : yield* JasnaSupervisor.attempt(() => supervisor.selectInput(selected[0]!));
  }),
});

export const clearExecutable = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JASNA_CLEAR_EXECUTABLE_CHANNEL,
  payload: Schema.Void,
  result: DesktopJasnaSnapshot,
  handler: Effect.fn("desktop.ipc.jasna.clearExecutable")(function* () {
    const supervisor = yield* JasnaSupervisor.JasnaSupervisor;
    return yield* JasnaSupervisor.attempt(supervisor.clearExecutable);
  }),
});

export const pickOutput = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JASNA_PICK_OUTPUT_CHANNEL,
  payload: Schema.Void,
  result: DesktopJasnaSnapshot,
  handler: Effect.fn("desktop.ipc.jasna.pickOutput")(function* () {
    const supervisor = yield* JasnaSupervisor.JasnaSupervisor;
    const dialog = yield* ElectronDialog.ElectronDialog;
    const window = yield* ElectronWindow.ElectronWindow;
    const selected = yield* dialog.saveFile({
      owner: yield* window.focusedMainOrFirst,
      filters: videoFilters,
    });
    return Option.isNone(selected)
      ? supervisor.snapshot()
      : yield* JasnaSupervisor.attempt(() => supervisor.selectOutput(selected.value));
  }),
});

export const start = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JASNA_START_CHANNEL,
  payload: DesktopJasnaStart,
  result: DesktopJasnaSnapshot,
  handler: Effect.fn("desktop.ipc.jasna.start")(function* (selection) {
    const supervisor = yield* JasnaSupervisor.JasnaSupervisor;
    return yield* JasnaSupervisor.attempt(() => supervisor.start(selection));
  }),
});

export const cancel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.JASNA_CANCEL_CHANNEL,
  payload: Schema.String,
  result: DesktopJasnaSnapshot,
  handler: Effect.fn("desktop.ipc.jasna.cancel")(function* (id) {
    const supervisor = yield* JasnaSupervisor.JasnaSupervisor;
    return yield* JasnaSupervisor.attempt(() => supervisor.cancel(id));
  }),
});
