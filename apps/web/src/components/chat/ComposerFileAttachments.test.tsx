import type { ChangeEvent, DragEvent, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const lifecycle = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => void | (() => void)) => lifecycle.effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { ComposerFilePicker } from "./ComposerFilePicker";
import { ComposerFileDropZone } from "./ComposerFileDropZone";
import { NATIVE_FILES_EVENT } from "../../lib/nativeFileDrop";

beforeEach(() => {
  hooks.reset();
  lifecycle.effects.length = 0;
});

describe("file selection and dragging", () => {
  it("opens the picker with + and accepts multiple document types, including selecting the same files again", () => {
    const onFiles = vi.fn();
    hooks.beginRender();
    const tree = ComposerFilePicker({ disabled: false, onFiles });
    const input = visitElements(tree, (element) => element.type === "input")!;
    const button = visitElements(tree, (element) => element.props["aria-label"] === "파일 첨부")!;
    expect(input.props.multiple).toBe(true);
    expect(input.props.accept).toBeUndefined();
    const click = vi.fn();
    (input.props.ref as { current: unknown }).current = { click };
    (button.props.onClick as () => void)();
    expect(click).toHaveBeenCalledOnce();
    const files = [new File(["notes"], "notes.txt"), new File(["%PDF"], "report.pdf")];
    const target = { files, value: "selected-files" };
    const change = input.props.onChange as (event: ChangeEvent<HTMLInputElement>) => void;
    change({ currentTarget: target } as unknown as ChangeEvent<HTMLInputElement>);
    expect(onFiles).toHaveBeenLastCalledWith(files);
    expect(target.value).toBe("");
    target.value = "selected-files";
    change({ currentTarget: target } as unknown as ChangeEvent<HTMLInputElement>);
    expect(onFiles).toHaveBeenCalledTimes(2);
  });

  it("disables the button and file input together when the composer cannot accept attachments", () => {
    hooks.beginRender();
    const tree = ComposerFilePicker({ disabled: true, onFiles: vi.fn() });
    expect(visitElements(tree, (element) => element.type === "input")?.props.disabled).toBe(true);
    expect(
      visitElements(tree, (element) => element.props["aria-label"] === "파일 첨부")?.props.disabled,
    ).toBe(true);
  });

  it("accepts multiple dropped files anywhere in the chat and resets the drop highlight", () => {
    const onFiles = vi.fn();
    const render = () => {
      hooks.beginRender();
      return ComposerFileDropZone({ children: "chat", onFiles }) as ReactElement<
        Record<string, unknown>
      >;
    };
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.csv")];
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      dataTransfer: { types: ["Files"], files },
    };
    (render().props.onDragEnter as (event: DragEvent<HTMLDivElement>) => void)(
      event as unknown as DragEvent<HTMLDivElement>,
    );
    expect(
      visitElements(
        render(),
        (element) => element.props.className?.toString().includes("pointer-events-none") ?? false,
      ),
    ).not.toBeNull();
    event.defaultPrevented = false;
    (render().props.onDrop as (event: DragEvent<HTMLDivElement>) => void)(
      event as unknown as DragEvent<HTMLDivElement>,
    );
    expect(onFiles).toHaveBeenCalledExactlyOnceWith(files);
    expect(event.defaultPrevented).toBe(true);
    expect(
      visitElements(
        render(),
        (element) => element.props.className?.toString().includes("pointer-events-none") ?? false,
      ),
    ).toBeNull();
  });

  it("acknowledges a native drop only when the visible composer accepts the files", () => {
    const onFiles = vi.fn().mockReturnValue(false);
    hooks.beginRender();
    const tree = ComposerFileDropZone({ children: "chat", onFiles }) as ReactElement<
      Record<string, unknown>
    >;
    const container = new EventTarget();
    (tree.props.ref as { current: unknown }).current = container;
    const cleanup = lifecycle.effects[0]?.();
    const files = [new File(["image"], "photo.png", { type: "image/png" })];
    const unavailable = new CustomEvent(NATIVE_FILES_EVENT, { detail: files, cancelable: true });
    container.dispatchEvent(unavailable);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith(files);
    expect(unavailable.defaultPrevented).toBe(false);
    onFiles.mockReturnValue(true);
    const accepted = new CustomEvent(NATIVE_FILES_EVENT, { detail: files, cancelable: true });
    container.dispatchEvent(accepted);
    expect(accepted.defaultPrevented).toBe(true);
    cleanup?.();
  });

  it("does not attach twice when the composer already handled a drop", () => {
    const onFiles = vi.fn();
    hooks.beginRender();
    const tree = ComposerFileDropZone({ children: "chat", onFiles }) as ReactElement<
      Record<string, unknown>
    >;
    const event = {
      defaultPrevented: true,
      preventDefault: vi.fn(),
      dataTransfer: { types: ["Files"], files: [new File(["a"], "a.txt")] },
    };
    (tree.props.onDrop as (event: DragEvent<HTMLDivElement>) => void)(
      event as unknown as DragEvent<HTMLDivElement>,
    );
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("leaves text and workspace mention drops to their existing handlers", () => {
    const onFiles = vi.fn();
    hooks.beginRender();
    const tree = ComposerFileDropZone({ children: "chat", onFiles }) as ReactElement<
      Record<string, unknown>
    >;
    const event = {
      defaultPrevented: false,
      preventDefault: vi.fn(),
      dataTransfer: { types: ["text/plain"], files: [] },
    };
    (tree.props.onDrop as (event: DragEvent<HTMLDivElement>) => void)(
      event as unknown as DragEvent<HTMLDivElement>,
    );
    expect(onFiles).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
