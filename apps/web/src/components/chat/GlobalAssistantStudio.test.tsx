import { EnvironmentId } from "@t3tools/contracts";
import type { Dispatch, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";

const deferredHarness = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const pendingUpdaters: Array<() => void> = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
      pendingUpdaters.length = 0;
    },
    flush() {
      while (pendingUpdaters.length > 0) {
        const fn = pendingUpdaters.shift()!;
        fn();
      }
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useEffect() {
      nextIndex();
    },
    useMemo<T>(factory: () => T): T {
      nextIndex();
      return factory();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        pendingUpdaters.push(() => {
          const previous = slots[index] as T;
          slots[index] =
            typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
        });
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: deferredHarness.useCallback,
    useEffect: deferredHarness.useEffect,
    useMemo: deferredHarness.useMemo,
    useState: deferredHarness.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: deferredHarness.useMemoCache,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [],
}));

vi.mock("~/hooks/useDesktopAssistant", () => ({
  useDesktopAssistant: () => ({
    available: false,
    settings: null,
    error: null,
    open: vi.fn(),
    close: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    globalAssistant: null,
    globalResponseStyle: null,
    providerInstances: {},
    providers: {},
  }),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn().mockResolvedValue({ _tag: "Success" }),
}));

import { GlobalAssistantStudio } from "./GlobalAssistantStudio";

function renderStudio() {
  deferredHarness.beginRender();
  return GlobalAssistantStudio({
    environmentId: EnvironmentId.make("environment-local"),
  });
}

function fireSyntheticChange(
  handler: (event: { currentTarget: { value?: string; checked?: boolean } | null }) => void,
  payload: { value?: string; checked?: boolean },
) {
  const syntheticEvent: { currentTarget: { value?: string; checked?: boolean } | null } = {
    currentTarget: payload,
  };
  handler(syntheticEvent);
  // Mirror React's SyntheticEvent behavior: currentTarget is cleared to null
  // right after the event handler returns, before deferred state updaters run.
  syntheticEvent.currentTarget = null;
  deferredHarness.flush();
}

describe("GlobalAssistantStudio", () => {
  beforeEach(() => {
    deferredHarness.reset();
  });

  it("updates all identity fields safely after React clears event.currentTarget", () => {
    let tree = renderStudio();

    const textUpdates: ReadonlyArray<readonly [string, string]> = [
      ["역할 이름", "전속 비서실장"],
      ["프리셋", "concise"],
      ["답변 길이", "핵심 3줄 요약"],
      ["설명 방식", "결론 먼저 제시"],
      ["말투", "간결한 보고체"],
      ["추가 운영 지시", "추측 금지"],
    ];

    for (const [label, nextValue] of textUpdates) {
      const field = visitElements(tree, (el) => el.props["aria-label"] === label);
      expect(field, `missing field ${label}`).toBeTruthy();
      fireSyntheticChange(
        field!.props.onChange as (event: { currentTarget: { value?: string } | null }) => void,
        { value: nextValue },
      );
      tree = renderStudio();
      const updated = visitElements(tree, (el) => el.props["aria-label"] === label);
      expect(updated?.props.value).toBe(nextValue);
    }

    const enabledCheckbox = visitElements(
      tree,
      (el) => el.type === "input" && el.props.type === "checkbox",
    );
    expect(enabledCheckbox).toBeTruthy();
    const initialEnabled = Boolean(enabledCheckbox!.props.checked);
    fireSyntheticChange(
      enabledCheckbox!.props.onChange as (event: {
        currentTarget: { checked?: boolean } | null;
      }) => void,
      { checked: !initialEnabled },
    );
    tree = renderStudio();
    const toggledCheckbox = visitElements(
      tree,
      (el) => el.type === "input" && el.props.type === "checkbox",
    );
    expect(toggledCheckbox?.props.checked).toBe(!initialEnabled);
  });

  it("updates enforcement checkboxes safely after React clears event.currentTarget", () => {
    let tree = renderStudio();
    const contractTab = visitElements(
      tree,
      (el) => el.props.role === "tab" && String(el.props.children).includes("원칙·출력계약"),
    );
    expect(contractTab).toBeTruthy();
    (contractTab!.props.onClick as () => void)();
    deferredHarness.flush();
    tree = renderStudio();

    const checkboxes: Array<{
      props: {
        checked?: boolean;
        onChange: (event: { currentTarget: { checked?: boolean } | null }) => void;
      };
    }> = [];
    visitElements(tree, (el) => {
      if (el.type === "input" && el.props.type === "checkbox") {
        checkboxes.push(el as unknown as (typeof checkboxes)[number]);
      }
      return false;
    });
    // enabled + 4 enforcement options + characterOverridesVoice
    expect(checkboxes.length).toBeGreaterThanOrEqual(6);

    for (const checkbox of checkboxes) {
      fireSyntheticChange(checkbox.props.onChange, { checked: !checkbox.props.checked });
    }
    expect(() => renderStudio()).not.toThrow();
  });
});
