import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { remainingWatchNoticeMs, useBackgroundWatchNotice } from "./useBackgroundWatchNotice";

const lifecycle = vi.hoisted(() => ({ cleanup: undefined as undefined | (() => void) }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useCallback: reactHookHarness.useCallback,
    useEffect(effect: () => void | (() => void)) {
      lifecycle.cleanup?.();
      lifecycle.cleanup = effect() || undefined;
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

const at = "2026-11-12T10:20:00+09:00";
const start = Date.parse(at);
const render = (room: string, eventId = "restart", seconds = 30) => {
  hooks.beginRender();
  return useBackgroundWatchNotice(room, { at, eventId }, seconds);
};

beforeEach(() => {
  hooks.reset();
  vi.useFakeTimers();
  vi.setSystemTime(start);
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  vi.stubGlobal("document", new EventTarget());
});
afterEach(() => {
  lifecycle.cleanup?.();
  lifecycle.cleanup = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("schedules only the remaining millisecond and stays hidden after reopening old history", () => {
  vi.setSystemTime(start + 29_999);
  expect(render("expiry").visible).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(render("expiry").visible).toBe(false);
  hooks.reset();
  vi.setSystemTime(new Date("2026-11-19T10:20:00+09:00"));
  expect(render("expiry").visible).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("closes synchronously and scopes acknowledgment to the event and room across remounts", () => {
  const notice = render("environment-a:room");
  notice.dismiss();
  expect(render("environment-a:room").visible).toBe(false);
  hooks.reset();
  expect(render("environment-a:room").visible).toBe(false);
  expect(render("environment-b:room").visible).toBe(true);
  expect(render("environment-a:room", "new-restart").visible).toBe(true);
});

it("honors zero, shortened and extended durations from the same interruption", () => {
  vi.setSystemTime(start + 15_000);
  expect(render("config", "r", 0).visible).toBe(false);
  expect(render("config", "r", 15).visible).toBe(false);
  expect(render("config", "r", 16).visible).toBe(true);
  vi.advanceTimersByTime(1000);
  expect(render("config", "r", 16).visible).toBe(false);
  expect(render("config", "r", 30).visible).toBe(true);
  expect(remainingWatchNoticeMs("invalid", 30, start)).toBe(0);
  expect(remainingWatchNoticeMs(undefined, 30, start)).toBe(0);
});
