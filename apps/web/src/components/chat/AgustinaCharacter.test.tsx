import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({ effect: undefined as (() => void | (() => void)) | undefined }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => void | (() => void)) => {
      state.effect = effect;
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { AgustinaCharacter } from "./AgustinaCharacter";

class FakeImage {
  static images: FakeImage[] = [];
  loadCallback: (() => void) | null = null;
  errorCallback: (() => void) | null = null;
  src = "";
  addEventListener(event: string, callback: () => void) {
    if (event === "load") this.loadCallback = callback;
    if (event === "error") this.errorCallback = callback;
  }
  removeEventListener(event: string) {
    if (event === "load") this.loadCallback = null;
    if (event === "error") this.errorCallback = null;
  }
  constructor() {
    FakeImage.images.push(this);
  }
}

beforeEach(() => {
  hooks.reset();
  state.effect = undefined;
  FakeImage.images = [];
  vi.stubGlobal("Image", FakeImage);
});
afterEach(() => vi.unstubAllGlobals());

it("shows the complete character only when every layer has loaded", async () => {
  hooks.beginRender();
  let tree = AgustinaCharacter({ isWorking: false });
  expect(visitElements(tree, (element) => element.type === "img")).toBeNull();
  const cleanup = state.effect?.();
  expect(FakeImage.images).toHaveLength(7);
  for (const image of FakeImage.images.slice(0, -1)) image.loadCallback?.();
  await Promise.resolve();
  hooks.beginRender();
  tree = AgustinaCharacter({ isWorking: false });
  expect(visitElements(tree, (element) => element.type === "img")).toBeNull();
  FakeImage.images.at(-1)?.loadCallback?.();
  await Promise.resolve();
  await Promise.resolve();
  hooks.beginRender();
  tree = AgustinaCharacter({ isWorking: true });
  expect(visitElements(tree, (element) => element.type === "img")?.props.src).toContain(
    "august_base.png",
  );
  expect(tree.props["aria-label"]).toContain("작업 중");
  if (typeof cleanup === "function") cleanup();
});

it("keeps the character hidden if an image fails", async () => {
  hooks.beginRender();
  AgustinaCharacter({ isWorking: false });
  const cleanup = state.effect?.();
  FakeImage.images[1]?.errorCallback?.();
  await Promise.resolve();
  await Promise.resolve();
  hooks.beginRender();
  const tree = AgustinaCharacter({ isWorking: false });
  expect(visitElements(tree, (element) => element.type === "img")).toBeNull();
  expect(tree.props.children).toContain("불러오지 못했습니다");
  if (typeof cleanup === "function") cleanup();
});
