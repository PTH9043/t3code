import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const effects = vi.hoisted(() => ({ callbacks: [] as Array<() => void | (() => void)> }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (callback: () => void | (() => void)) => {
      effects.callbacks.push(callback);
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("./aiHelpStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aiHelpStore")>();
  return {
    ...actual,
    useAiHelpStore: <T,>(
      selector: (state: ReturnType<typeof actual.useAiHelpStore.getState>) => T,
    ) => selector(actual.useAiHelpStore.getState()),
  };
});

import { AiHelpHost } from "./AiHelpHost";

const store = await vi.importActual<typeof import("./aiHelpStore")>("./aiHelpStore");

function mount() {
  const unsubscribeMenu = vi.fn();
  const onMenuAction = vi.fn<(listener: (action: string) => void) => () => void>(
    () => unsubscribeMenu,
  );
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const querySelector = vi.fn(() => null);
  vi.stubGlobal("window", {
    addEventListener,
    removeEventListener,
    desktopBridge: { onMenuAction },
  });
  vi.stubGlobal("document", { querySelector });
  hooks.beginRender();
  expect(AiHelpHost()).toBeNull();
  const cleanup = effects.callbacks[0]!();
  const menuAction = onMenuAction.mock.calls[0]![0];
  const keyDown = addEventListener.mock.calls[0]![1] as (event: KeyboardEvent) => void;
  return { menuAction, keyDown, cleanup, unsubscribeMenu, removeEventListener, querySelector };
}

describe("AI help entry points", () => {
  beforeEach(() => {
    hooks.reset();
    effects.callbacks = [];
    store.useAiHelpStore.getState().setOpen(false);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens the same lazy dialog from the desktop menu and can return to the conversation", () => {
    const mounted = mount();
    mounted.menuAction("open-settings");
    expect(store.useAiHelpStore.getState().isOpen).toBe(false);
    mounted.menuAction("open-ai-help");
    expect(store.useAiHelpStore.getState().isOpen).toBe(true);
    hooks.beginRender();
    const dialogHost = AiHelpHost();
    expect(dialogHost).not.toBeNull();
    const onClose = dialogHost!.props.children.props.onClose as () => void;
    onClose();
    hooks.beginRender();
    expect(AiHelpHost()).toBeNull();
  });

  it("handles unmodified F1 without taking keys already consumed by another interaction", () => {
    const mounted = mount();
    const preventDefault = vi.fn();
    const event = { key: "F1", preventDefault } as unknown as KeyboardEvent;
    mounted.keyDown({ ...event, ctrlKey: true } as KeyboardEvent);
    mounted.keyDown({ ...event, defaultPrevented: true } as KeyboardEvent);
    expect(store.useAiHelpStore.getState().isOpen).toBe(false);
    mounted.keyDown(event);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(store.useAiHelpStore.getState().isOpen).toBe(true);
  });

  it("removes the desktop and keyboard listeners when the app shell unmounts", () => {
    const mounted = mount();
    mounted.cleanup?.();
    expect(mounted.unsubscribeMenu).toHaveBeenCalledOnce();
    expect(mounted.removeEventListener).toHaveBeenCalledWith("keydown", mounted.keyDown);
  });
});
