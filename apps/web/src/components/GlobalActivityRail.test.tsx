import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import chatComposerSource from "./chat/ChatComposer.tsx?raw";
import {
  detectSystemDiagnosticsAlert,
  GlobalActivityRailView,
  parseProjectKey,
  resolveActiveActivityRailItem,
  resolveActiveProjectForRail,
  resolveGlobalActivityRailItems,
} from "./GlobalActivityRail";

describe("GlobalActivityRail (ERR-41)", () => {
  it("renders all 5 top-level destinations with fixed 48px width and responsive desktop rail classes", () => {
    const html = renderToStaticMarkup(
      createElement(GlobalActivityRailView, {
        pathname: "/",
        activeProject: { environmentId: "env-1", projectId: "proj-1" },
        diagnosticsAlert: null,
        onSelectItem: vi.fn(),
      }),
    );

    expect(html).toContain('data-slot="global-activity-rail"');
    expect(html).toContain('aria-label="전역 탐색"');
    expect(html).toContain("w-12");
    expect(html).toContain("hidden");
    expect(html).toContain("md:flex");
    expect(html).toContain("border-r");

    for (const [id, label] of [
      ["chat", "대화"],
      ["control-center", "AI 제어센터"],
      ["knowledge", "지식·RAG"],
      ["diagnostics", "시스템 진단"],
      ["settings", "환경 설정"],
    ] as const) {
      expect(html).toContain(`data-rail-item="${id}"`);
      expect(html).toContain(`aria-label="${label}"`);
    }

    expect(html).toContain('data-rail-href="/"');
    expect(html).toContain('data-rail-href="/control-center"');
    expect(html).toContain('data-rail-href="/control-center/env-1/proj-1/knowledge/manage"');
    expect(html).toContain('data-rail-href="/settings/diagnostics"');
    expect(html).toContain('data-rail-href="/settings/general"');
  });

  it("marks exactly one item with aria-current='page' and active indicator for each route", () => {
    const cases = [
      { pathname: "/", expected: "chat" },
      { pathname: "/env-1/thread-1", expected: "chat" },
      { pathname: "/draft/draft-1", expected: "chat" },
      { pathname: "/control-center", expected: "control-center" },
      { pathname: "/control-center/env-1/proj-1", expected: "control-center" },
      { pathname: "/control-center/env-1/proj-1/knowledge/manage", expected: "knowledge" },
      { pathname: "/control-center/env-1/proj-1/knowledge/docs/item-1", expected: "knowledge" },
      { pathname: "/settings/diagnostics", expected: "diagnostics" },
      { pathname: "/settings/general", expected: "settings" },
      { pathname: "/settings/appearance", expected: "settings" },
    ] as const;

    for (const testCase of cases) {
      expect(resolveActiveActivityRailItem(testCase.pathname)).toBe(testCase.expected);

      const html = renderToStaticMarkup(
        createElement(GlobalActivityRailView, {
          pathname: testCase.pathname,
          activeProject: { environmentId: "env-1", projectId: "proj-1" },
          diagnosticsAlert: null,
          onSelectItem: vi.fn(),
        }),
      );

      const currentPageMatches = html.match(/aria-current="page"/g) ?? [];
      expect(currentPageMatches).toHaveLength(1);
      const indicatorMatches = html.match(/data-rail-active-indicator="true"/g) ?? [];
      expect(indicatorMatches).toHaveLength(1);
      expect(html).toContain(`aria-current="page" data-rail-item="${testCase.expected}"`);
    }
  });

  it("falls back Knowledge & RAG link to /control-center when no active project is selected", () => {
    const itemsWithoutProject = resolveGlobalActivityRailItems({
      activeProject: null,
      diagnosticsAlert: null,
    });
    const knowledgeWithoutProject = itemsWithoutProject.find((item) => item.id === "knowledge");
    expect(knowledgeWithoutProject?.href).toBe("/control-center");

    expect(parseProjectKey("env-1:proj-1")).toEqual({
      environmentId: "env-1",
      projectId: "proj-1",
    });
    expect(parseProjectKey("")).toBeNull();
    expect(parseProjectKey("invalid")).toBeNull();

    expect(
      resolveActiveProjectForRail({
        routeEnvironmentId: "env-route",
        routeProjectId: "proj-route",
        activeTabProjectKey: "env-tab:proj-tab",
      }),
    ).toEqual({
      environmentId: "env-route",
      projectId: "proj-route",
    });
    expect(
      resolveActiveProjectForRail({
        activeTabProjectKey: "env-tab:proj-tab",
      }),
    ).toEqual({
      environmentId: "env-tab",
      projectId: "proj-tab",
    });
  });

  it("renders a diagnostics status dot badge when warning or error anomalies are detected", () => {
    expect(
      detectSystemDiagnosticsAlert({
        networkStatus: "online",
        environmentPhases: ["connected"],
        providerStatuses: [{ enabled: true, status: "ready" }],
      }),
    ).toBeNull();

    expect(
      detectSystemDiagnosticsAlert({
        networkStatus: "online",
        environmentPhases: ["reconnecting"],
        providerStatuses: [{ enabled: true, status: "ready" }],
      }),
    ).toBe("warning");

    expect(
      detectSystemDiagnosticsAlert({
        networkStatus: "online",
        environmentPhases: ["connected"],
        providerStatuses: [{ enabled: true, status: "error" }],
      }),
    ).toBe("error");

    expect(
      detectSystemDiagnosticsAlert({
        networkStatus: "online",
        environmentPhases: ["connected"],
        providerStatuses: [{ enabled: false, status: "error" }],
      }),
    ).toBeNull();

    const normalHtml = renderToStaticMarkup(
      createElement(GlobalActivityRailView, {
        pathname: "/",
        activeProject: null,
        diagnosticsAlert: null,
        onSelectItem: vi.fn(),
      }),
    );
    expect(normalHtml).not.toContain("data-status-badge=");

    const warningHtml = renderToStaticMarkup(
      createElement(GlobalActivityRailView, {
        pathname: "/",
        activeProject: null,
        diagnosticsAlert: "warning",
        onSelectItem: vi.fn(),
      }),
    );
    expect(warningHtml).toContain('data-status-badge="warning"');

    const errorHtml = renderToStaticMarkup(
      createElement(GlobalActivityRailView, {
        pathname: "/",
        activeProject: null,
        diagnosticsAlert: "error",
        onSelectItem: vi.fn(),
      }),
    );
    expect(errorHtml).toContain('data-status-badge="error"');
  });

  it("adds topbar clearance when topInset is enabled for macOS traffic lights", () => {
    const html = renderToStaticMarkup(
      createElement(GlobalActivityRailView, {
        pathname: "/",
        activeProject: null,
        diagnosticsAlert: null,
        topInset: true,
        onSelectItem: vi.fn(),
      }),
    );
    expect(html).toContain("pt-[var(--workspace-topbar-height)]");
  });

  it("keeps ChatComposer full-access control free of '주의' warning badges while preserving Wave 1 improvements", () => {
    expect(chatComposerSource).not.toContain("data-full-access-warning");
    expect(chatComposerSource).not.toContain("실행 모드: 전체 권한 (주의)");
    expect(chatComposerSource).not.toContain("bg-[var(--status-warning-surface)]");
    expect(chatComposerSource).not.toContain("border-[var(--status-warning-border)]");
    expect(chatComposerSource).not.toContain("text-[var(--status-warning-fg)]");
    expect(chatComposerSource).toContain('label: "전체 권한"');
    expect(chatComposerSource).toContain("min-w-[140px]");
    expect(chatComposerSource).toContain("isVideoOnlyModelSlug");
  });
});
