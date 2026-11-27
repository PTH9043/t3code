import type { ReactElement } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const effectHarness = vi.hoisted(() => {
  let cleanups: Array<() => void> = [];
  let pendingEffects: Array<() => void | (() => void)> = [];
  let prevDeps: ReadonlyArray<unknown> | undefined;
  return {
    reset() {
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
      pendingEffects = [];
      prevDeps = undefined;
    },
    useEffect(effect: () => void | (() => void), deps?: ReadonlyArray<unknown>) {
      const changed =
        prevDeps === undefined ||
        deps === undefined ||
        deps.length !== prevDeps.length ||
        deps.some((value, index) => !Object.is(value, prevDeps![index]));
      if (changed) {
        prevDeps = deps ? [...deps] : undefined;
        pendingEffects.push(effect);
      }
    },
    flush() {
      const queue = pendingEffects;
      pendingEffects = [];
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
      for (const effect of queue) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
    },
  };
});

const queryState = vi.hoisted(() => ({
  data: null as unknown,
  error: null as string | null,
  isPending: true,
  refresh: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: effectHarness.useEffect,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: EnvironmentId.make("env-local") }),
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => queryState,
}));

vi.mock("./SourceControlWritingSettings", () => ({
  SourceControlWritingSettingsSection: () => null,
}));

import {
  SOURCE_CONTROL_DISCOVERY_TIMEOUT_MS,
  SourceControlSettingsPanel,
} from "./SourceControlSettings";

function renderPanel(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  const tree = SourceControlSettingsPanel() as ReactElement<Record<string, unknown>>;
  effectHarness.flush();
  return tree;
}

describe("SourceControlSettingsPanel 3s discovery timeout (ERR-10)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    if (typeof globalThis.window === "undefined") {
      vi.stubGlobal("window", globalThis);
    }
    hooks.reset();
    effectHarness.reset();
    queryState.data = null;
    queryState.error = null;
    queryState.isPending = true;
    queryState.refresh.mockReset();
  });

  afterEach(() => {
    effectHarness.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("exits skeleton state after 3 seconds and displays timeout guidance with retry action", () => {
    let panel = renderPanel();

    // Initially pending -> skeletons shown, no timeout notice
    expect(visitElements(panel, (el) => el.props.title === "버전 관리")).not.toBeNull();
    expect(
      visitElements(panel, (el) => el.props.children === "서버 실행 환경 확인이 지연되고 있습니다"),
    ).toBeNull();

    // Advance past 3s timeout -> transitions to EmptySourceControlDiscovery(timedOut=true)
    vi.advanceTimersByTime(SOURCE_CONTROL_DISCOVERY_TIMEOUT_MS);
    panel = renderPanel();

    expect(visitElements(panel, (el) => el.props.title === "버전 관리")).toBeNull();
    const emptyDiscovery = visitElements(panel, (el) => el.props.timedOut === true);
    expect(emptyDiscovery).not.toBeNull();

    const emptyTree = (
      emptyDiscovery!.type as (
        props: Record<string, unknown>,
      ) => ReactElement<Record<string, unknown>>
    )(emptyDiscovery!.props);
    expect(
      visitElements(
        emptyTree,
        (el) => el.props.children === "서버 실행 환경 확인이 지연되고 있습니다",
      ),
    ).not.toBeNull();

    const retryButton = visitElements(
      emptyTree,
      (el) =>
        typeof el.props.onClick === "function" &&
        Array.isArray(el.props.children) &&
        el.props.children.includes("다시 시도"),
    );
    expect(retryButton).not.toBeNull();
    expect(retryButton?.props.disabled).toBe(false);

    // Clicking retry triggers refresh and clears timeout state
    (retryButton!.props.onClick as () => void)();
    expect(queryState.refresh).toHaveBeenCalledTimes(1);

    panel = renderPanel();
    expect(visitElements(panel, (el) => el.props.title === "버전 관리")).not.toBeNull();
  });
});
