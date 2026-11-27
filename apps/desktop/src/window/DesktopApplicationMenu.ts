import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";
import { UPGRADE_ROOM_TAB_MENU_CHANNEL } from "../ipc/channels.ts";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedErrorClass<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logInfo: logUpdaterInfo } = makeComponentLogger("desktop-updater");

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action);
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

const checkForUpdatesFromMenu = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "최신 버전입니다",
      message: `NewAutoUsage AI 제어센터 ${updateState.currentVersion} 버전이 현재 최신 버전입니다.`,
      buttons: ["확인"],
    });
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: "업데이트 확인 실패",
      message: "업데이트를 확인하지 못했습니다.",
      detail: updateState.message ?? "알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도하세요.",
      buttons: ["확인"],
    });
  }
}).pipe(Effect.withSpan("desktop.menu.checkForUpdates"));

const handleCheckForUpdatesMenuClick = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updates.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "업데이트를 사용할 수 없음",
      message: "현재 자동 업데이트를 사용할 수 없습니다.",
      detail: disabledReason.value,
      buttons: ["확인"],
    });
    return;
  }

  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.ensureMain;
  yield* checkForUpdatesFromMenu;
}).pipe(Effect.withSpan("desktop.menu.handleCheckForUpdatesClick"));

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appName = yield* electronApp.name;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick);
    };
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    const helpClick = () => {
      runMenuEffect("open-ai-help", dispatchMenuAction("open-ai-help"));
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) => () => {
      runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: appName,
        submenu: [
          { role: "about", label: `${appName} 정보` },
          {
            label: "업데이트 확인...",
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: "설정...",
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services", label: "서비스" },
          { type: "separator" },
          { role: "hide", label: `${appName} 숨기기` },
          { role: "hideOthers", label: "다른 앱 숨기기" },
          { role: "unhide", label: "모두 표시" },
          { type: "separator" },
          { role: "quit", label: `${appName} 종료` },
        ],
      });
    }

    template.push(
      {
        label: "파일",
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: "설정...",
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          {
            role: environment.platform === "darwin" ? "close" : "quit",
            label: environment.platform === "darwin" ? "창 닫기" : "종료",
          },
        ],
      },
      { role: "editMenu", label: "편집" },
      {
        label: "보기",
        submenu: [
          ...(environment.platform === "win32"
            ? [
                {
                  label: "AutoUsage 업그레이드",
                  click: (_item: Electron.MenuItem, window: Electron.BaseWindow | undefined) => {
                    if (window && !window.isDestroyed() && "webContents" in window) {
                      (window as Electron.BrowserWindow).webContents.send(
                        UPGRADE_ROOM_TAB_MENU_CHANNEL,
                      );
                    }
                  },
                },
              ]
            : []),
          { role: "reload", label: "새로고침" },
          { role: "forceReload", label: "강제로 새로고침" },
          { role: "toggleDevTools", label: "개발자 도구 전환" },
          { type: "separator" },
          /*
            Not the zoom roles: those act on the focused webContents, so with
            an embedded preview WebContentsView focused they zoom the guest
            page and the app UI appears stuck. These always zoom the main
            window (see DesktopWindow.zoomMain).
          */
          { label: "글자 크기 초기화", accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
          { label: "글자 크게", accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
          {
            label: "글자 크게",
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
            click: zoomClick("in"),
          },
          { label: "글자 작게", accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
          { type: "separator" },
          { role: "togglefullscreen", label: "전체 화면 전환" },
        ],
      },
      { role: "windowMenu", label: "창" },
      {
        role: "help",
        label: "도움말",
        submenu: [
          {
            label: "AI 사용 도움말",
            accelerator: "F1",
            click: helpClick,
          },
          { type: "separator" },
          {
            label: "업데이트 확인...",
            click: checkForUpdatesClick,
          },
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
