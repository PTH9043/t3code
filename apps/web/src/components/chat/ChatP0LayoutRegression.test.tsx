import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    createElement("div", { "data-sheet-open": String(open) }, children),
  SheetPopup: ({
    className,
    keepMounted,
    children,
  }: {
    className?: string;
    keepMounted?: boolean;
    children: ReactNode;
  }) =>
    createElement(
      "div",
      { "data-sheet-popup": "true", "data-keep-mounted": String(Boolean(keepMounted)), className },
      children,
    ),
}));

import { ChatHeader, ChatViewerToggle } from "./ChatHeader";
import { ThreadBackgroundWatch } from "./ThreadBackgroundWatch";
import { hasComposerDraftContent } from "../ChatView";
import { RightPanelSheet } from "../RightPanelSheet";

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => null,
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ backgroundWatchThreadIds: [] }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => ({}),
    updateSettings: {},
  },
}));
vi.mock("~/hooks/useT3ProjectFileScripts", () => ({ useT3ProjectFileScripts: () => [] }));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: vi.fn() }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../GitActionsControl", () => ({
  default: () => createElement("button", null, "Git 도구"),
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: () => createElement("button", null, "스크립트 도구"),
}));

describe("Chat P0 mobile header & empty draft regressions (ERR-01, ERR-33)", () => {
  it("applies container-query responsive compaction on ChatHeader and ThreadBackgroundWatch (ERR-01)", () => {
    const headerHtml = renderToStaticMarkup(
      createElement(ChatHeader, {
        activeThreadEnvironmentId: EnvironmentId.make("env-1"),
        activeThreadId: ThreadId.make("thread-1"),
        activeThreadTitle: "모바일 430px 좁은 헤더 테스트",
        isServerThread: true,
        changeRequestState: null,
        activeProjectName: "매우 긴 프로젝트 이름",
        activeProjectCwd: null,
        openInCwd: null,
        activeProjectScripts: [],
        preferredScriptId: null,
        keybindings: [],
        availableEditors: [],
        viewerControl: createElement(ChatViewerToggle, { open: false, onToggle: vi.fn() }),
        gitCwd: null,
        onNewThreadInProject: vi.fn(),
        onRunProjectScript: vi.fn(),
        onAddProjectScript: vi.fn(),
        onUpdateProjectScript: vi.fn(),
        onDeleteProjectScript: vi.fn(),
      }),
    );

    expect(headerHtml).toContain("@container/header-actions");
    expect(headerHtml).toContain("overflow-hidden");
    expect(headerHtml).toContain("min-w-[180px]");
    expect(headerHtml).toContain("justify-between");
    expect(headerHtml).toContain("@[22rem]/header-actions:inline");

    const watchHtml = renderToStaticMarkup(
      createElement(ThreadBackgroundWatch, {
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(watchHtml).toContain('aria-label="이 대화의 백그라운드 감시 · 꺼짐"');
    expect(watchHtml).toContain("sr-only");
    expect(watchHtml).toContain("shrink-0");
  });

  it("returns false for empty drafts so the header hides '초안 버리기' (ERR-33)", () => {
    expect(hasComposerDraftContent(null)).toBe(false);
    expect(hasComposerDraftContent(undefined)).toBe(false);
    expect(
      hasComposerDraftContent({
        prompt: "   \n\t  ",
        images: [],
        terminalContexts: [],
        elementContexts: [],
        previewAnnotations: [],
        reviewComments: [],
      }),
    ).toBe(false);
    expect(
      hasComposerDraftContent({
        prompt: "안녕하세요",
        images: [],
        terminalContexts: [],
        elementContexts: [],
        previewAnnotations: [],
        reviewComments: [],
      }),
    ).toBe(true);
    expect(
      hasComposerDraftContent({
        prompt: "",
        images: [{ id: "img-1" }],
        terminalContexts: [],
        elementContexts: [],
        previewAnnotations: [],
        reviewComments: [],
      }),
    ).toBe(true);
  });

  it("ensures RightPanelSheet sets full height so FilePreviewPanel mounts without collapsing (ERR-21)", () => {
    const html = renderToStaticMarkup(
      createElement(RightPanelSheet, {
        open: true,
        onClose: vi.fn(),
        children: createElement("div", { "data-testid": "file-panel-body" }, "파일 탐색기"),
      }),
    );
    expect(html).toContain('data-sheet-open="true"');
    expect(html).toContain("h-full");
    expect(html).toContain("min-h-0");
    expect(html).toContain("파일 탐색기");
  });
});
