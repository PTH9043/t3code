import { describe, expect, it, vi } from "vite-plus/test";
import {
  FILE_DROP_CHAT_TARGET,
  FILE_DROP_PROJECT_TARGET,
  NATIVE_FILES_EVENT,
  deliverNativeFilesToChat,
  nativeFileDropTargetAt,
} from "./nativeFileDrop";

function element(kind: "tooltip" | "chat" | "project" | "dialog") {
  const value = {
    closest: vi.fn((selector: string) =>
      kind === "dialog"
        ? selector.includes('aria-modal="true"')
          ? value
          : null
        : selector.includes(
              kind === "chat"
                ? FILE_DROP_CHAT_TARGET
                : kind === "project"
                  ? FILE_DROP_PROJECT_TARGET
                  : "never-matched",
            )
          ? value
          : null,
    ),
  };
  return value as unknown as Element;
}

describe("native file drop hit testing", () => {
  it("delivers a native drop to the visible composer and leaves unhandled drops available to queue", () => {
    const chat = new EventTarget();
    const files = [new File(["image"], "test.png", { type: "image/png" })];
    expect(deliverNativeFilesToChat(chat as Element, files)).toBe(false);
    const receive = vi.fn((event: Event) => {
      expect((event as CustomEvent<File[]>).detail).toEqual(files);
      event.preventDefault();
    });
    chat.addEventListener(NATIVE_FILES_EVENT, receive);
    expect(deliverNativeFilesToChat(chat as Element, files)).toBe(true);
    expect(receive).toHaveBeenCalledOnce();
  });
  it("finds the chat beneath a hover tooltip instead of losing the received file", () => {
    const tooltip = element("tooltip"),
      chat = element("chat");
    const elementsFromPoint = vi.fn(() => [tooltip, chat]);
    expect(nativeFileDropTargetAt({ elementsFromPoint }, 20, 40)).toBe(chat);
    expect(elementsFromPoint).toHaveBeenCalledWith(20, 40);
  });
  it("keeps the foremost project target and does not attach through a blocking dialog", () => {
    const project = element("project"),
      chat = element("chat");
    expect(nativeFileDropTargetAt({ elementsFromPoint: () => [project, chat] }, 20, 40)).toBe(
      project,
    );
    expect(
      nativeFileDropTargetAt({ elementsFromPoint: () => [element("dialog"), chat] }, 20, 40),
    ).toBeNull();
  });
  it("rejects invalid points and points outside any attachment target", () => {
    const elementsFromPoint = vi.fn(() => []);
    for (const [x, y] of [
      [-1, 10],
      [10, -1],
      [NaN, 10],
      [10, Infinity],
    ])
      expect(nativeFileDropTargetAt({ elementsFromPoint }, x!, y!)).toBeNull();
    expect(elementsFromPoint).not.toHaveBeenCalled();
    expect(nativeFileDropTargetAt({ elementsFromPoint }, 10, 20)).toBeNull();
  });
});
