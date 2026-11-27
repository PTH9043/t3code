import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { RightPanelTabs } from "../RightPanelTabs";
import {
  ChatHeader,
  ChatViewerToggle,
  resolveRenameCommit,
  shouldShowOpenInPicker,
} from "./ChatHeader";

vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => null }));
vi.mock("./ThreadBackgroundWatch", () => ({
  ThreadBackgroundWatch: (props: { environmentId: string; threadId: string }) =>
    createElement("button", null, `감시 ${props.environmentId}/${props.threadId}`),
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
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => createElement("nav", null, children),
}));

const toggle = (open: boolean) => createElement(ChatViewerToggle, { open, onToggle: vi.fn() });
const header = (isServerThread: boolean, viewerControl: ReactNode) =>
  renderToStaticMarkup(
    createElement(ChatHeader, {
      activeThreadEnvironmentId: EnvironmentId.make("env"),
      activeThreadId: ThreadId.make("room"),
      activeThreadTitle: "기록이 있는 긴 대화 제목",
      isServerThread,
      viewerControl,
      changeRequestState: null,
      activeProjectName: "긴 프로젝트 이름",
      activeProjectCwd: null,
      openInCwd: null,
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      gitCwd: null,
      onNewThreadInProject: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn(),
      onUpdateProjectScript: vi.fn(),
      onDeleteProjectScript: vi.fn(),
    }),
  );
it.each([true, false])(
  "renders compact icon+dot Viewer toggle after non-shrinking project tools (saved=%s)",
  (saved) => {
    const html = header(saved, toggle(false));
    expect(html).toContain("기록이 있는 긴 대화 제목");
    expect(html).toContain("min-w-[180px]");
    expect(html.includes("감시 env/room")).toBe(saved);
    expect(html).toContain("스크립트 도구");
    expect(html).toContain("Git 도구");
    expect(html).toContain('aria-label="대화 뷰어"');
    expect(html).toMatch(/aria-pressed="false"[^>]*title="대화 뷰어 열기"/);
    expect(html).not.toMatch(/<\/svg>대화 뷰어<\/button>/);
  },
);

it.each(["inline", "maximized", "sheet"] as const)(
  "keeps Viewer and the add menu outside the scrolling tab list in %s mode",
  (layout) => {
    const html = (open: boolean) =>
      renderToStaticMarkup(
        createElement(RightPanelTabs, {
          mode: layout === "sheet" ? "sheet" : "inline",
          maximized: layout === "maximized",
          layoutControls: toggle(open),
          surfaces: [
            { kind: "diff", id: "diff" },
            { kind: "agents", id: "agents" },
          ],
          activeSurfaceId: open ? "agents" : "diff",
          pendingSurfaceIds: new Set<string>(),
          terminalLabelsById: new Map<string, string>(),
          previewSessions: {},
          onActivate: vi.fn(),
          onCloseSurface: vi.fn(),
          onCloseOtherSurfaces: vi.fn(),
          onCloseSurfacesToRight: vi.fn(),
          onCloseAllSurfaces: vi.fn(),
          onCopyFilePath: vi.fn(),
          onAddBrowser: vi.fn(),
          onAddTerminal: vi.fn(),
          onAddDiff: vi.fn(),
          onAddFiles: vi.fn(),
          onAddAgents: vi.fn(),
          onAddWorkers: vi.fn(),
          browserAvailable: false,
          diffAvailable: true,
          filesAvailable: true,
          children: "패널 내용",
        }),
      );
    expect(header(true, null)).not.toContain('aria-label="대화 뷰어"');
    for (const open of [true, false]) {
      const [tabList, controls] = html(open).split("</nav>");
      expect(tabList).toContain('data-active-tab="true"');
      expect(tabList).not.toContain("aria-pressed=");
      expect(controls).toContain('aria-label="패널 화면 추가"');
      expect(controls).toContain(`aria-label="대화 뷰어" aria-pressed="${open}"`);
      expect(controls).toContain("data-right-panel-surface-content");
    }
  },
);

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});
