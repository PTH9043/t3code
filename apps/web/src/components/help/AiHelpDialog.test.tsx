import { AI_HELP_CHANNEL, AI_HELP_HTML } from "@t3tools/shared/aiHelp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const effects = vi.hoisted(() => ({ callbacks: [] as Array<() => void | (() => void)> }));
const frameUrls: string[] = [];

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: (callback: () => void | (() => void)) => {
      effects.callbacks.push(callback);
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import AiHelpDialog from "./AiHelpDialog";

function mount() {
  const onClose = vi.fn();
  const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  const sender = { postMessage: vi.fn() };
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal("window", { addEventListener, removeEventListener });
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  hooks.beginRender();
  let tree = AiHelpDialog({ onClose });
  const guideCleanup = effects.callbacks[1]?.();
  if (effects.callbacks[1]) {
    hooks.beginRender();
    tree = AiHelpDialog({ onClose });
  }
  const iframe = visitElements(tree, (element) => element.type === "iframe");
  if (typeof iframe?.props.src === "string") frameUrls.push(iframe.props.src);
  const ref = iframe!.props.ref as { current: { contentWindow: typeof sender } | null };
  ref.current = { contentWindow: sender };
  const messageCleanup = effects.callbacks[0]!();
  const cleanup = () => {
    messageCleanup?.();
    guideCleanup?.();
  };
  const onMessage = addEventListener.mock.calls[0]![1] as (event: {
    source: unknown;
    data: unknown;
  }) => void;
  return {
    onClose,
    writeText,
    sender,
    onMessage,
    ref,
    cleanup,
    removeEventListener,
    iframe: iframe!,
  };
}

describe("AI help dialog frame messages", () => {
  beforeEach(() => {
    hooks.reset();
    effects.callbacks = [];
  });
  afterEach(() => {
    for (const url of frameUrls.splice(0)) URL.revokeObjectURL(url);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the bundled document without navigating through the app router", async () => {
    const mounted = mount();
    const source = mounted.iframe.props.src;
    expect(typeof source).toBe("string");
    if (typeof source !== "string") throw new Error("Guide document URL missing");
    expect(source).toMatch(/^blob:/);
    expect(mounted.iframe.props.srcDoc).toBeUndefined();
    const response = await fetch(source);
    expect(await response.text()).toBe(AI_HELP_HTML);
    expect(mounted.iframe.props.sandbox).not.toContain("allow-same-origin");
  });

  it("releases its document URL when the guide is closed", async () => {
    const mounted = mount();
    const source = mounted.iframe.props.src;
    if (typeof source !== "string") throw new Error("Guide document URL missing");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    mounted.cleanup();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(source);
    await expect(fetch(source)).rejects.toThrow();
  });

  it("ignores clipboard and close requests from other frames", () => {
    const mounted = mount();
    mounted.onMessage({
      source: {},
      data: { channel: AI_HELP_CHANNEL, action: "copy", text: "unrelated", requestId: 1 },
    });
    mounted.onMessage({ source: {}, data: { channel: AI_HELP_CHANNEL, action: "close" } });
    expect(mounted.writeText).not.toHaveBeenCalled();
    expect(mounted.onClose).not.toHaveBeenCalled();
  });

  it("copies the request once and acknowledges success to that frame", async () => {
    const mounted = mount();
    const reply = new Promise<void>((resolve) =>
      mounted.sender.postMessage.mockImplementation(() => resolve()),
    );
    mounted.onMessage({
      source: mounted.sender,
      data: { channel: AI_HELP_CHANNEL, action: "copy", text: "검증 후 적용", requestId: 5 },
    });
    await reply;
    expect(mounted.writeText).toHaveBeenCalledExactlyOnceWith("검증 후 적용");
    expect(mounted.sender.postMessage).toHaveBeenCalledExactlyOnceWith(
      { channel: AI_HELP_CHANNEL, action: "copy-result", requestId: 5, success: true },
      "*",
    );
  });

  it("does not reply to a detached frame after a pending clipboard write", async () => {
    const mounted = mount();
    let finish: () => void = () => undefined;
    mounted.writeText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mounted.onMessage({
      source: mounted.sender,
      data: { channel: AI_HELP_CHANNEL, action: "copy", text: "검증", requestId: 1 },
    });
    mounted.ref.current = null;
    finish();
    await mounted.writeText.mock.results[0]!.value;
    await Promise.resolve();
    expect(mounted.sender.postMessage).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "reports the selection fallback result (%s) when clipboard access is unavailable",
    async (success) => {
      const mounted = mount();
      const selection = { value: "", style: {}, select: vi.fn(), remove: vi.fn() };
      const execCommand = vi.fn(() => success);
      class FocusTarget {
        focus = vi.fn();
      }
      const previousFocus = new FocusTarget();
      vi.stubGlobal("HTMLElement", FocusTarget);
      vi.stubGlobal("document", {
        activeElement: previousFocus,
        createElement: () => selection,
        body: { appendChild: vi.fn() },
        execCommand,
      });
      mounted.writeText.mockRejectedValueOnce(new Error("Clipboard unavailable"));
      const reply = new Promise<void>((resolve) =>
        mounted.sender.postMessage.mockImplementation(() => resolve()),
      );
      mounted.onMessage({
        source: mounted.sender,
        data: { channel: AI_HELP_CHANNEL, action: "copy", text: "개발본에서 검증", requestId: 4 },
      });
      await reply;
      expect(selection.value).toBe("개발본에서 검증");
      expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
      expect(selection.remove).toHaveBeenCalledOnce();
      expect(previousFocus.focus).toHaveBeenCalledOnce();
      expect(mounted.sender.postMessage).toHaveBeenCalledExactlyOnceWith(
        { channel: AI_HELP_CHANNEL, action: "copy-result", requestId: 4, success },
        "*",
      );
    },
  );

  it("closes only for its own guide and removes the listener on unmount", () => {
    const mounted = mount();
    mounted.onMessage({
      source: mounted.sender,
      data: { channel: AI_HELP_CHANNEL, action: "close" },
    });
    expect(mounted.onClose).toHaveBeenCalledOnce();
    mounted.cleanup?.();
    expect(mounted.removeEventListener).toHaveBeenCalledWith("message", mounted.onMessage);
  });
});
