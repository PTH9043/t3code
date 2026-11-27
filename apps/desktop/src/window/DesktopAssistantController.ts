import type {
  DesktopAssistantConversationRef,
  DesktopAssistantModelUpdate,
  DesktopAssistantSettings,
  DesktopAssistantSettingsPatch,
} from "@t3tools/contracts";
import type * as Electron from "electron";
import { DesktopAssistantState } from "../settings/DesktopAssistantState.ts";

/** Owns one assistant window; the main window and its active turn stay independent. */
export class DesktopAssistantController {
  private readonly state: DesktopAssistantState;
  private readonly create: (settings: DesktopAssistantSettings) => Promise<Electron.BrowserWindow>;
  private readonly notify: (settings: DesktopAssistantSettings) => void;
  private readonly reveal: (window: Electron.BrowserWindow) => void;
  private window: Electron.BrowserWindow | null = null;
  private opening: Promise<void> | null = null;
  private readonly loaded: Promise<DesktopAssistantSettings>;
  private started = false;

  constructor(
    state: DesktopAssistantState,
    create: (settings: DesktopAssistantSettings) => Promise<Electron.BrowserWindow>,
    notify: (settings: DesktopAssistantSettings) => void,
    reveal: (window: Electron.BrowserWindow) => void = (window) => window.showInactive(),
  ) {
    this.state = state;
    this.create = create;
    this.notify = notify;
    this.reveal = reveal;
    this.loaded = state.load();
    // Startup may have no assistant enabled; do not leave a rejection unobserved.
    void this.loaded.catch(() => undefined);
  }

  async getSettings(): Promise<DesktopAssistantSettings> {
    await this.loaded;
    return this.state.get();
  }

  async getModel(
    ref: DesktopAssistantConversationRef,
  ): Promise<DesktopAssistantModelUpdate | null> {
    await this.loaded;
    return this.state.getModel(ref);
  }

  async setModel(update: DesktopAssistantModelUpdate): Promise<void> {
    await this.loaded;
    await this.state.setModel(update);
  }

  async updateSettings(patch: DesktopAssistantSettingsPatch): Promise<DesktopAssistantSettings> {
    await this.loaded;
    const settings = await this.state.update(patch);
    if (this.window && !this.window.isDestroyed()) this.window.setAlwaysOnTop(settings.alwaysOnTop);
    this.notify(settings);
    return settings;
  }

  async open(): Promise<void> {
    await this.loaded;
    if (this.opening) return this.opening;
    if (this.window && !this.window.isDestroyed()) {
      this.reveal(this.window);
      return;
    }
    this.opening = (async () => {
      const window = await this.create(this.state.get());
      this.window = window;
      if (!window.isDestroyed()) window.setAlwaysOnTop(this.state.get().alwaysOnTop);
      window.once("closed", () => {
        if (this.window === window) this.window = null;
      });
    })();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  async close(): Promise<void> {
    if (this.opening) await this.opening;
    if (this.window && !this.window.isDestroyed()) this.window.close();
  }

  async onMainClosed(): Promise<void> {
    if (!(await this.getSettings()).keepOnMainClose) await this.close();
  }

  async openOnStartup(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if ((await this.getSettings()).openAtStartup) await this.open();
  }

  isAssistant(window: Electron.BrowserWindow): boolean {
    return this.window === window;
  }
}
