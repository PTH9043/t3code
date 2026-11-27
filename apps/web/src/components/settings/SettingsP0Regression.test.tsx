import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";
import { SETTINGS_SECTION_LABELS, searchSettings } from "./settingsSearch";
import { SOURCE_CONTROL_DISCOVERY_TIMEOUT_MS } from "./SourceControlSettings";
import { classifyProviderRowFilterStatus } from "./ProviderSettingsPanel";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ hash: "", pathname: "/settings/diagnostics" }),
  useCanGoBack: () => false,
}));

describe("Settings P0 regressions (ERR-15, ERR-10, ERR-48)", () => {
  it("exposes /settings/diagnostics in the left settings sidebar nav and search catalog (ERR-15)", () => {
    expect(SETTINGS_SECTION_LABELS["/settings/diagnostics"]).toBe("시스템 진단 및 리소스");
    const diagnosticsNav = SETTINGS_NAV_ITEMS.find((item) => item.to === "/settings/diagnostics");
    expect(diagnosticsNav).toBeDefined();
    expect(diagnosticsNav?.label).toBe("시스템 진단 및 리소스");

    const matches = searchSettings("시스템 진단");
    expect(matches).toContainEqual({
      id: "system-diagnostics",
      title: "시스템 진단 및 리소스",
      to: "/settings/diagnostics",
    });
  });

  it("enforces a 3-second timeout constant for source control discovery probes (ERR-10)", () => {
    expect(SOURCE_CONTROL_DISCOVERY_TIMEOUT_MS).toBe(3_000);
  });

  it("classifies provider rows accurately into active vs unconfigured for status filtering (ERR-48)", () => {
    expect(
      classifyProviderRowFilterStatus({
        enabled: true,
        isDefault: true,
        isDirty: false,
        liveStatus: "ready",
        liveInstalled: true,
        liveAuthStatus: "authenticated",
      }),
    ).toBe("active");

    expect(
      classifyProviderRowFilterStatus({
        enabled: false,
        isDefault: true,
        isDirty: true,
        liveStatus: "ready",
        liveInstalled: true,
        liveAuthStatus: "authenticated",
      }),
    ).toBe("unconfigured");

    expect(
      classifyProviderRowFilterStatus({
        enabled: true,
        isDefault: true,
        isDirty: false,
        liveStatus: "error",
        liveInstalled: false,
        liveAuthStatus: "unauthenticated",
      }),
    ).toBe("unconfigured");

    expect(
      classifyProviderRowFilterStatus({
        enabled: true,
        isDefault: false,
        isDirty: true,
      }),
    ).toBe("active");

    expect(
      classifyProviderRowFilterStatus({
        enabled: true,
        isDefault: true,
        isDirty: false,
      }),
    ).toBe("unconfigured");
  });

  it("keeps SettingsSidebarNav icons renderable for every settings route", () => {
    for (const item of SETTINGS_NAV_ITEMS) {
      const iconHtml = renderToStaticMarkup(createElement(item.icon, { className: "size-4" }));
      expect(iconHtml).toContain("<svg");
    }
  });
});
