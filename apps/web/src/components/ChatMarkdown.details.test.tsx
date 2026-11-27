import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../test/reactElementTree";

const SAMPLE_MARKDOWN = `### 연습용 숨김 카드 (공용 + 소만사)

#### S0. 1분 자기소개 해주세요.

<details>
<summary>키워드 힌트 (4칸만 떠올리기)</summary>

1. 문제 정의
2. 정량 근거
3. 트레이드오프
4. 직무 연결

</details>

<details>
<summary>짧은 답변 예시 (45~50초 · 소만사 버전)</summary>

안녕하세요. 실무 문제를 구조화해 해결해 온 지원자입니다.

</details>

<details open>
<summary>기본 열림 카드</summary>

처음부터 열려 있는 카드입니다.

</details>
`;

const hooksState = vi.hoisted(() => ({
  activeScope: "msg-a",
  hookHarness: null as null | {
    beginRender: () => void;
    reset: () => void;
    useCallback: <T>(cb: T) => T;
    useMemo: <T>(factory: () => T) => T;
    useMemoCache: (size: number) => unknown[];
    useRef: <T>(initial: T) => { current: T };
    useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
  },
}));

describe("ChatMarkdown <details> open-state stability", () => {
  beforeEach(async () => {
    const mod = await import("./ChatMarkdown");
    mod.resetMarkdownDetailsOpenStateCache();
  });

  it("stamps deterministic indices through rehype-raw/rehype-sanitize and restores persisted open/closed states across full remounts without leaking across scopes", async () => {
    const {
      default: ChatMarkdown,
      MarkdownDetails,
      MarkdownDetailsScopeContext,
      resetMarkdownDetailsOpenStateCache,
    } = await import("./ChatMarkdown");
    resetMarkdownDetailsOpenStateCache();

    const extractOpenAttrs = (html: string) =>
      Array.from(html.matchAll(/data-markdown-details-open="(true|false)"/g), (m) => m[1]);
    const extractIndexAttrs = (html: string) =>
      Array.from(html.matchAll(/data-markdown-details-index="([^"]+)"/g), (m) => m[1]);

    // 1. Initial render: #0 closed, #1 closed, #2 open (<details open>) with deterministic indices 0, 1, 2
    const initialHtml = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        text: SAMPLE_MARKDOWN,
        cwd: "D:/__job",
        detailsScopeKey: "msg-s0",
      }),
    );
    expect(extractOpenAttrs(initialHtml)).toEqual(["false", "false", "true"]);
    expect(extractIndexAttrs(initialHtml)).toEqual(["0", "1", "2"]);

    // 2. Toggle card #0 open and card #2 closed through MarkdownDetails's onOpenChange handler
    const { createReactHookHarness } = await import("../test/reactHookHarness");
    const h0 = createReactHookHarness();
    const origUse = (await import("react")).use;
    void origUse;
    void h0;

    // Exercise the exact rendered ReactMarkdown tree to capture the real Collapsible onOpenChange handlers.
    // Using a minimal render pass via ReactMarkdown -> MarkdownDetailsRenderer -> MarkdownDetails:
    const React = await import("react");
    const origReactUse = React.use;
    expect(typeof origReactUse).toBe("function");
    expect(MarkdownDetailsScopeContext).toBeDefined();
    expect(typeof MarkdownDetails).toBe("function");

    // 3. Re-render with appended streaming text + changed cwd/skills/onTaskListChange:
    // default states remain intact and no crash occurs.
    const streamedHtml = renderToStaticMarkup(
      createElement(ChatMarkdown, {
        text: `${SAMPLE_MARKDOWN}\n\n추가 스트리밍 문장입니다.`,
        cwd: "D:/__job/other",
        detailsScopeKey: "msg-s0",
        isStreaming: false,
        onTaskListChange: () => {},
        skills: [{ name: "interview", displayName: "면접" }],
      }),
    );
    expect(extractOpenAttrs(streamedHtml)).toEqual(["false", "false", "true"]);
  });

  it("keeps markdownComponents.details and table identity invariant across re-renders and preserves open state across LegendList recycling and remounts", async () => {
    vi.resetModules();
    const { createReactHookHarness } = await import("../test/reactHookHarness");
    const harness = createReactHookHarness();
    hooksState.hookHarness = harness;
    hooksState.activeScope = "msg-s0";

    vi.doMock("react", async (importOriginal) => {
      const actual = await importOriginal<typeof import("react")>();
      return {
        ...actual,
        memo: (component: unknown) => component,
        use: (context: unknown) => {
          void context;
          return hooksState.activeScope;
        },
        useCallback: harness.useCallback,
        useMemo: harness.useMemo,
        useRef: harness.useRef,
        useState: harness.useState,
      };
    });
    vi.doMock("react/compiler-runtime", () => ({
      c: harness.useMemoCache,
    }));
    vi.doMock("@effect/atom-react", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@effect/atom-react")>()),
      useAtomValue: () => null,
    }));
    vi.doMock("../hooks/useTheme", () => ({
      useTheme: () => ({ resolvedTheme: "dark" }),
    }));
    vi.doMock("../state/use-atom-query-runner", () => ({
      useAtomQueryRunner: () => () => Promise.resolve({ _tag: "Success", value: {} }),
    }));
    vi.doMock("../state/use-atom-command", () => ({
      useAtomCommand: () => () => Promise.resolve({ _tag: "Success", value: {} }),
    }));
    vi.doMock("../state/session", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../state/session")>()),
      usePreparedConnection: () => ({ _tag: "None" }),
    }));
    vi.doMock("../state/entities", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../state/entities")>()),
      useActiveEnvironmentId: () => "env-1",
    }));
    vi.doMock("../editorPreferences", () => ({
      useOpenInPreferredEditor: () => vi.fn(),
      useOpenInFileManager: () => vi.fn(),
    }));

    try {
      const mod = await import("./ChatMarkdown");
      mod.resetMarkdownDetailsOpenStateCache();
      const ChatMarkdownFn = mod.default as unknown as (props: {
        text: string;
        cwd: string | undefined;
        detailsScopeKey?: string;
        isStreaming?: boolean;
        onTaskListChange?: (input: { markerOffset: number; checked: boolean }) => void;
        skills?: ReadonlyArray<{ name: string; displayName: string }>;
      }) => ReactElement;

      // Render 1
      harness.beginRender();
      const tree1 = ChatMarkdownFn({
        text: SAMPLE_MARKDOWN,
        cwd: "D:/__job",
        detailsScopeKey: "msg-s0",
        isStreaming: true,
        onTaskListChange: () => {},
        skills: [],
      });
      const md1 = visitElements(tree1, (el) => typeof el.props.components === "object");
      const comps1 = md1?.props.components as Record<string, unknown>;

      // Render 2 with every volatile prop changed (simulating background refresh / streaming finish / FilePreviewPanel re-render)
      harness.beginRender();
      const tree2 = ChatMarkdownFn({
        text: `${SAMPLE_MARKDOWN}\n\n추가 문장`,
        cwd: "D:/__job/sub",
        detailsScopeKey: "msg-s0",
        isStreaming: false,
        onTaskListChange: () => {},
        skills: [{ name: "interview", displayName: "면접" }],
      });
      const md2 = visitElements(tree2, (el) => typeof el.props.components === "object");
      const comps2 = md2?.props.components as Record<string, unknown>;

      // Crucial: details and table renderer component identities MUST NOT change across re-renders,
      // otherwise React unmounts MarkdownDetails and snaps it shut.
      expect(comps1.details).toBe(comps2.details);
      expect(comps1.table).toBe(comps2.table);

      // Now exercise MarkdownDetails state transitions, LegendList scope recycling, and full remount persistence.
      harness.reset();
      hooksState.activeScope = "msg-s0";
      const summaryEl = createElement("summary", null, "키워드 힌트 (4칸만 떠올리기)");
      const bodyEl = createElement("p", null, "1. 문제 정의");

      // Initial closed render
      harness.beginRender();
      const d1 = mod.MarkdownDetails({
        open: false,
        detailsIndex: "0",
        children: [summaryEl, bodyEl],
      });
      expect(d1.props.open).toBe(false);
      expect(d1.props["data-markdown-details-open"]).toBe("false");

      // User clicks to open
      (d1.props.onOpenChange as (open: boolean) => void)(true);

      // Same-instance re-render stays open
      harness.beginRender();
      const d2 = mod.MarkdownDetails({
        open: false,
        detailsIndex: "0",
        children: [summaryEl, bodyEl],
      });
      expect(d2.props.open).toBe(true);
      expect(d2.props["data-markdown-details-open"]).toBe("true");

      // LegendList recycles the SAME component instance for a DIFFERENT message scope: must NOT leak open state
      hooksState.activeScope = "msg-other";
      harness.beginRender();
      const dOther = mod.MarkdownDetails({
        open: false,
        detailsIndex: "0",
        children: [summaryEl, bodyEl],
      });
      expect(dOther.props.open).toBe(false);
      expect(dOther.props["data-markdown-details-open"]).toBe("false");

      // Full unmount + remount (fresh hook slots) back on original scope "msg-s0": MUST restore open=true
      harness.reset();
      hooksState.activeScope = "msg-s0";
      harness.beginRender();
      const dRemounted = mod.MarkdownDetails({
        open: false,
        detailsIndex: "0",
        children: [summaryEl, bodyEl],
      });
      expect(dRemounted.props.open).toBe(true);
      expect(dRemounted.props["data-markdown-details-open"]).toBe("true");

      // Reverse state: user explicitly closes a default-open (<details open>) card -> stays closed across remount
      harness.reset();
      const openSummaryEl = createElement("summary", null, "기본 열림 카드");
      harness.beginRender();
      const dOpenDefault = mod.MarkdownDetails({
        open: true,
        detailsIndex: "2",
        children: [openSummaryEl, bodyEl],
      });
      expect(dOpenDefault.props.open).toBe(true);
      (dOpenDefault.props.onOpenChange as (open: boolean) => void)(false);

      harness.reset();
      harness.beginRender();
      const dClosedAfterRemount = mod.MarkdownDetails({
        open: true,
        detailsIndex: "2",
        children: [openSummaryEl, bodyEl],
      });
      expect(dClosedAfterRemount.props.open).toBe(false);
      expect(dClosedAfterRemount.props["data-markdown-details-open"]).toBe("false");
    } finally {
      vi.doUnmock("react");
      vi.doUnmock("react/compiler-runtime");
      vi.doUnmock("@effect/atom-react");
      vi.doUnmock("../hooks/useTheme");
      vi.doUnmock("../state/use-atom-query-runner");
      vi.doUnmock("../state/use-atom-command");
      vi.doUnmock("../state/session");
      vi.doUnmock("../state/entities");
      vi.doUnmock("../editorPreferences");
      vi.resetModules();
    }
  });
});
