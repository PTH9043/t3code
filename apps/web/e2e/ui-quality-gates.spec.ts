/**
 * Headless Playwright 30대 UI/UX 품질 검증 게이트 스위트 (마스터 보고서 22장 · 22B장)
 *
 * - 화면 탈취 절대 금지(AGENTS.md): 반드시 headless: true 전용으로 실행.
 * - 라이브 운영 DB(E:\NewAutoUsage) 및 운영 포트(13773) 접근/오염 금지:
 *   격리된 임시 포트 Vite 서버 + 완전 인메모리 API 모킹으로 동작.
 * - 실행 방법:
 *   `vp test run --config apps/web/vite.config.ts apps/web/e2e/ui-quality-gates.spec.ts`
 *   또는 격리 URL 지정 시 `T3_E2E_BASE_URL=http://127.0.0.1:<isolated-port> ...`
 */

import {
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  getThemeColorsForMode,
  type ThemeDefinition,
} from "../src/themePalette";

import {
  ACTIVITY_RAIL_ITEM_IDS,
  CONTROL_CENTER_DOMAIN_IDS,
  E2E_ENVIRONMENT_ID,
  E2E_LONG_THREAD_ID,
  E2E_PROJECT_ID,
  E2E_SHORT_THREAD_ID,
  RESPONSIVE_VIEWPORTS,
  SIX_THEME_MATRIX,
  collectVisibleHeaderButtonBoxes,
  contrastRatio,
  expect,
  findHeaderButtonOverlaps,
  findUnlabeledVisibleFormControls,
  installIsolatedBackendMocks,
  isRedFamilyColor,
  launchHeadlessChromium,
  resolveCssVariablesToRgba,
  rgbEuclideanDistance,
  startIsolatedWebServer,
  test,
  type IsolatedWebServerHandle,
  type PlaywrightBrowser,
  type PlaywrightPage,
} from "./ui-quality-gates.helpers";

const THEME_DEFINITIONS_BY_ID: Readonly<Record<string, ThemeDefinition>> = {
  ocean: OCEAN_THEME,
  ember: EMBER_THEME,
  iris: IRIS_THEME,
  grove: GROVE_THEME,
};

const THEME_ROLE_TO_CSS_VAR: ReadonlyArray<readonly [string, string]> = [
  ["canvas", "--app-theme-canvas"],
  ["chrome", "--app-theme-chrome"],
  ["toolbar", "--app-theme-toolbar"],
  ["toolbarForeground", "--app-theme-toolbar-foreground"],
  ["toolbarBorder", "--app-theme-toolbar-border"],
  ["toolbarControl", "--app-theme-toolbar-control"],
  ["toolbarControlForeground", "--app-theme-toolbar-control-foreground"],
  ["toolbarControlHover", "--app-theme-toolbar-control-hover"],
  ["surface", "--app-theme-surface"],
  ["surfaceRaised", "--app-theme-surface-raised"],
  ["surfaceOverlay", "--app-theme-surface-overlay"],
  ["text", "--app-theme-text"],
  ["textMuted", "--app-theme-text-muted"],
  ["border", "--app-theme-border"],
  ["input", "--app-theme-input"],
  ["focus", "--app-theme-focus"],
  ["accent", "--app-theme-accent"],
  ["accentForeground", "--app-theme-accent-foreground"],
  ["secondary", "--app-theme-secondary"],
  ["secondaryForeground", "--app-theme-secondary-foreground"],
  ["muted", "--app-theme-muted"],
  ["placeholder", "--app-theme-placeholder"],
  ["secondaryLabel", "--app-theme-secondary-label"],
  ["iconMuted", "--app-theme-icon-muted"],
  ["accentSurface", "--app-theme-accent-surface"],
  ["accentSurfaceForeground", "--app-theme-accent-surface-foreground"],
  ["messageSurface", "--app-theme-message-surface"],
  ["messageForeground", "--app-theme-message-foreground"],
  ["messageAction", "--app-theme-message-action"],
  ["messageActionForeground", "--app-theme-message-action-foreground"],
  ["messageActionHover", "--app-theme-message-action-hover"],
  ["sidebar", "--app-theme-sidebar"],
  ["sidebarForeground", "--app-theme-sidebar-foreground"],
  ["sidebarMutedForeground", "--app-theme-sidebar-muted-foreground"],
  ["sidebarControlSurface", "--app-theme-sidebar-control-surface"],
  ["sidebarRowHover", "--app-theme-sidebar-row-hover"],
  ["sidebarRowActive", "--app-theme-sidebar-row-active"],
  ["sidebarRowSelected", "--app-theme-sidebar-row-selected"],
  ["sidebarBorder", "--app-theme-sidebar-border"],
];

let serverHandle: IsolatedWebServerHandle | null = null;
let browser: PlaywrightBrowser | null = null;

async function openIsolatedPage(options: {
  readonly authenticated: boolean;
  readonly viewport?: { width: number; height: number };
  readonly turnCount?: number;
  readonly councilFixture?: boolean;
}): Promise<{
  page: PlaywrightPage;
  pageErrors: Array<string>;
  dispose: () => Promise<void>;
}> {
  if (!browser || !serverHandle) {
    throw new Error("Headless browser or isolated web server was not initialized.");
  }
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const pageErrors: Array<string> = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await installIsolatedBackendMocks(page, {
    authenticated: options.authenticated,
    ...(options.turnCount !== undefined ? { turnCount: options.turnCount } : {}),
    ...(options.councilFixture !== undefined ? { councilFixture: options.councilFixture } : {}),
  });

  return {
    page,
    pageErrors,
    async dispose() {
      await context.close();
    },
  };
}

async function waitForAppShell(
  page: PlaywrightPage,
  selector: string,
  timeout = 30_000,
): Promise<void> {
  await page.locator(selector).first().waitFor({ state: "visible", timeout });
}

test.beforeAll(async () => {
  serverHandle = await startIsolatedWebServer();
  browser = await launchHeadlessChromium();
  // Warm up Vite's initial module graph once in headless Chromium so individual
  // gate tests run deterministically without cold-compile timeouts.
  const warmup = await openIsolatedPage({ authenticated: false });
  try {
    await warmup.page.goto(`${serverHandle.baseUrl}/pair`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForAppShell(warmup.page, "input#pairing-token", 60_000);
  } finally {
    await warmup.dispose();
  }
}, 120_000);

test.afterAll(async () => {
  if (browser) {
    await browser.close();
    browser = null;
  }
  if (serverHandle) {
    await serverHandle.close();
    serverHandle = null;
  }
}, 30_000);

// ===========================================================================
// Gate Group 1: 반응형 헤더 충돌 0px² & 뷰포트 예산 (ERR-01, ERR-08, ERR-23, ERR-54)
// ===========================================================================
test.describe("Gate Group 1: 반응형 헤더 충돌 0px² & 뷰포트 예산 (ERR-01, ERR-08, ERR-23, ERR-54)", () => {
  test("5대 뷰포트에서 가시 헤더 버튼 쌍의 바운딩 박스 교차 면적이 0px²이고 중앙 대화 스트림 min-height >= 320px이다", async () => {
    const { page, pageErrors, dispose } = await openIsolatedPage({
      authenticated: true,
      viewport: { width: 1920, height: 1080 },
    });

    try {
      const threadUrl = `${serverHandle!.baseUrl}/${E2E_ENVIRONMENT_ID}/${E2E_SHORT_THREAD_ID}`;
      await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
      await waitForAppShell(page, "header[data-chat-header]");
      await waitForAppShell(page, "[data-chat-stream-viewport]");

      for (const vp of RESPONSIVE_VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.waitForTimeout(150);

        const boxes = await collectVisibleHeaderButtonBoxes(page, "header[data-chat-header]");
        expect(
          boxes.length,
          `[${vp.name} ${vp.width}x${vp.height}] 가시 헤더 버튼이 최소 1개 이상 렌더링되어야 합니다.`,
        ).toBeGreaterThan(0);

        const overlaps = findHeaderButtonOverlaps(boxes, 0);
        expect(
          overlaps,
          `[${vp.name} ${vp.width}x${vp.height}] 헤더 버튼 교차 면적은 0px²여야 합니다: ${JSON.stringify(overlaps)}`,
        ).toEqual([]);

        const streamMetrics = await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>("[data-chat-stream-viewport]");
          if (!el) return null;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return {
            minHeightPx: Number.parseFloat(style.minHeight),
            renderedHeightPx: rect.height,
          };
        });

        expect(
          streamMetrics,
          `[${vp.name}] 중앙 대화 스트림([data-chat-stream-viewport])이 존재해야 합니다.`,
        ).not.toBeNull();
        expect(
          streamMetrics!.minHeightPx,
          `[${vp.name}] 중앙 대화 스트림 CSS min-height는 >= 320px 이어야 합니다 (ERR-08).`,
        ).toBeGreaterThanOrEqual(320);
        expect(
          streamMetrics!.renderedHeightPx,
          `[${vp.name}] 중앙 대화 스트림 실측 높이는 >= 320px 이어야 합니다 (ERR-08).`,
        ).toBeGreaterThanOrEqual(320);
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

// ===========================================================================
// Gate Group 2: 라우팅 · IA · 액티비티 레일 (ERR-02, ERR-03, ERR-13, ERR-14, ERR-41)
// ===========================================================================
test.describe("Gate Group 2: 라우팅 · IA · 액티비티 레일 (ERR-02, ERR-03, ERR-13, ERR-14, ERR-41)", () => {
  test("최좌측 48px 전역 액티비티 레일이 5개 목적지를 제공하고 탐색 가능하다 (ERR-41)", async () => {
    const { page, pageErrors, dispose } = await openIsolatedPage({
      authenticated: true,
      viewport: { width: 1280, height: 800 },
    });

    try {
      await page.goto(`${serverHandle!.baseUrl}/${E2E_ENVIRONMENT_ID}/${E2E_SHORT_THREAD_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForAppShell(page, 'nav[data-slot="global-activity-rail"]');

      const railBox = await page
        .locator('nav[data-slot="global-activity-rail"]')
        .first()
        .boundingBox();
      expect(railBox).not.toBeNull();
      expect(Math.round(railBox!.width)).toBe(48);
      expect(Math.round(railBox!.x)).toBeLessThanOrEqual(2);

      for (const itemId of ACTIVITY_RAIL_ITEM_IDS) {
        const button = page.locator(
          `nav[data-slot="global-activity-rail"] button[data-rail-item="${itemId}"]`,
        );
        await button.first().waitFor({ state: "visible", timeout: 10_000 });
      }

      // 1) AI 제어센터 클릭 → /control-center
      await page.locator('button[data-rail-item="control-center"]').first().click();
      await page.waitForFunction(() => window.location.pathname.startsWith("/control-center"));
      expect(
        await page
          .locator('button[data-rail-item="control-center"]')
          .first()
          .getAttribute("aria-current"),
      ).toBe("page");

      // 2) 시스템 진단 클릭 → /settings/diagnostics
      await page.locator('button[data-rail-item="diagnostics"]').first().click();
      await page.waitForFunction(() => window.location.pathname === "/settings/diagnostics");
      expect(
        await page
          .locator('button[data-rail-item="diagnostics"]')
          .first()
          .getAttribute("aria-current"),
      ).toBe("page");

      // 3) 환경 설정 클릭 → /settings/general
      await page.locator('button[data-rail-item="settings"]').first().click();
      await page.waitForFunction(() => window.location.pathname.startsWith("/settings/general"));
      expect(
        await page
          .locator('button[data-rail-item="settings"]')
          .first()
          .getAttribute("aria-current"),
      ).toBe("page");

      // 4) 지식·RAG 클릭 → /control-center 또는 프로젝트 지식 관리 경로
      await page.locator('button[data-rail-item="knowledge"]').first().click();
      await page.waitForFunction(() => window.location.pathname.startsWith("/control-center"));

      // 5) 대화 클릭 → 채팅 화면 복귀
      await page.locator('button[data-rail-item="chat"]').first().click();
      await page.waitForFunction(
        () =>
          !window.location.pathname.startsWith("/settings") &&
          !window.location.pathname.startsWith("/control-center"),
      );
      expect(
        await page.locator('button[data-rail-item="chat"]').first().getAttribute("aria-current"),
      ).toBe("page");

      expect(pageErrors).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test("프로젝트 제어센터 5대 도메인 탭 순회 시 URL·projectId 유지 및 활성 role=tabpanel 1개 격리 (ERR-02, ERR-03, ERR-13, ERR-14)", async () => {
    const { page, pageErrors, dispose } = await openIsolatedPage({
      authenticated: true,
      viewport: { width: 1280, height: 800 },
    });

    try {
      const ccPath = `/control-center/${E2E_ENVIRONMENT_ID}/${E2E_PROJECT_ID}`;
      await page.goto(`${serverHandle!.baseUrl}${ccPath}`, { waitUntil: "domcontentloaded" });
      await waitForAppShell(page, "[data-control-center-nav]");

      const domainTabs = page.locator(
        '[data-control-center-nav] [role="tablist"][aria-label="프로젝트 제어센터 도메인"] [role="tab"]',
      );
      expect(await domainTabs.count()).toBe(5);

      for (const domainId of CONTROL_CENTER_DOMAIN_IDS) {
        const tab = page.locator(`#cc-domain-tab-${domainId}`);
        await tab.first().waitFor({ state: "visible", timeout: 10_000 });
        await tab.first().click();

        await page.waitForFunction(
          (expectedDomain) => {
            const panel = document.querySelector<HTMLElement>('[role="tabpanel"]');
            return panel?.getAttribute("data-active-domain") === expectedDomain;
          },
          domainId,
          { timeout: 10_000 },
        );

        const currentUrl = new URL(page.url());
        expect(
          currentUrl.pathname,
          `도메인(${domainId}) 전환 후 environmentId/projectId 경로가 유실되면 안 됩니다 (ERR-02/ERR-03).`,
        ).toBe(ccPath);

        const activePanelCount = await page.locator('[role="tabpanel"]').count();
        expect(
          activePanelCount,
          `도메인(${domainId})에서 활성 role="tabpanel"은 정확히 1개만 마운트되어야 합니다 (ERR-14).`,
        ).toBe(1);

        expect(await tab.first().getAttribute("aria-selected")).toBe("true");
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

// ===========================================================================
// Gate Group 3: 6종 테마 시맨틱 컬러 & WCAG 대비비 (ERR-11, ERR-22, ERR-53)
// ===========================================================================
test.describe("Gate Group 3: 6종 테마 시맨틱 컬러 & WCAG 대비비 (ERR-11, ERR-22, ERR-53)", () => {
  test("6종 테마 전수에서 --status-danger-* 적색 계열 분리 및 라이트 모드 보더(>=3.0:1)·본문(>=4.5:1) 대비비를 만족한다", async () => {
    const { page, pageErrors, dispose } = await openIsolatedPage({
      authenticated: true,
      viewport: { width: 1280, height: 800 },
    });

    try {
      await page.goto(`${serverHandle!.baseUrl}/settings/appearance`, {
        waitUntil: "domcontentloaded",
      });
      await waitForAppShell(page, "body");

      for (const themeCase of SIX_THEME_MATRIX) {
        const themeDef = themeCase.themeId ? THEME_DEFINITIONS_BY_ID[themeCase.themeId] : undefined;
        const themeColors = themeDef
          ? (getThemeColorsForMode(themeDef, themeCase.appearance) ?? themeDef.colors)
          : null;

        const cssOverrides: Record<string, string> = {};
        if (themeColors) {
          for (const [role, cssVar] of THEME_ROLE_TO_CSS_VAR) {
            const value = themeColors[role as keyof typeof themeColors];
            if (typeof value === "string") {
              cssOverrides[cssVar] = value;
            }
          }
        }

        await page.evaluate(
          ({ themeId, appearance, overrides }) => {
            const root = document.documentElement;
            root.classList.toggle("dark", appearance === "dark");
            for (const prop of Array.from(root.style)) {
              if (prop.startsWith("--app-theme-")) {
                root.style.removeProperty(prop);
              }
            }
            if (themeId) {
              root.dataset.themeId = themeId;
              for (const [prop, val] of Object.entries(overrides)) {
                root.style.setProperty(prop, val);
              }
            } else {
              delete root.dataset.themeId;
            }
          },
          {
            themeId: themeCase.themeId,
            appearance: themeCase.appearance,
            overrides: cssOverrides,
          },
        );

        const colors = await resolveCssVariablesToRgba(page, [
          "--status-danger",
          "--status-danger-fg",
          "--primary",
          "--accent",
          "--border",
          "--foreground",
          "--background",
          "--card",
        ]);

        const danger = colors["--status-danger"]!;
        const dangerFg = colors["--status-danger-fg"]!;
        const primary = colors["--primary"]!;
        const accent = colors["--accent"]!;
        const border = colors["--border"]!;
        const foreground = colors["--foreground"]!;
        const background = colors["--background"]!;
        const card = colors["--card"]!;

        // ERR-11: --status-danger 및 --status-danger-fg는 6종 테마 모두 적색 계열 유지
        expect(
          isRedFamilyColor(danger),
          `[${themeCase.name}] --status-danger(${JSON.stringify(danger)})는 적색 계열이어야 합니다 (ERR-11).`,
        ).toBe(true);
        expect(
          isRedFamilyColor(dangerFg),
          `[${themeCase.name}] --status-danger-fg(${JSON.stringify(dangerFg)})는 적색 계열이어야 합니다 (ERR-11).`,
        ).toBe(true);

        // ERR-11: 브랜드 액센트(--primary / --accent)와 --status-danger 분리
        expect(
          rgbEuclideanDistance(danger, primary),
          `[${themeCase.name}] --status-danger가 브랜드 --primary와 분리되어야 합니다 (ERR-11).`,
        ).toBeGreaterThanOrEqual(30);
        expect(
          rgbEuclideanDistance(danger, accent),
          `[${themeCase.name}] --status-danger가 --accent와 분리되어야 합니다 (ERR-11).`,
        ).toBeGreaterThanOrEqual(40);

        // 본문 텍스트 대비비 >= 4.5:1 (WCAG AA)
        const textVsBg = contrastRatio(foreground, background);
        const textVsCard = contrastRatio(foreground, card);
        expect(
          textVsBg,
          `[${themeCase.name}] 본문 텍스트 vs 배경 대비비(${textVsBg.toFixed(2)}:1) >= 4.5:1 이어야 합니다.`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          textVsCard,
          `[${themeCase.name}] 본문 텍스트 vs 카드 대비비(${textVsCard.toFixed(2)}:1) >= 4.5:1 이어야 합니다.`,
        ).toBeGreaterThanOrEqual(4.5);

        // ERR-22 / ERR-53: 라이트 모드 보더 대비비 >= 3.0:1 (WCAG Non-Text Contrast)
        if (themeCase.appearance === "light") {
          const borderVsCard = contrastRatio(border, card);
          expect(
            borderVsCard,
            `[${themeCase.name}] 라이트 모드 보더 vs 카드 대비비(${borderVsCard.toFixed(2)}:1) >= 3.0:1 이어야 합니다 (ERR-22).`,
          ).toBeGreaterThanOrEqual(3.0);
        }
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

// ===========================================================================
// Gate Group 4: 접근성 · 폼 라벨 · 페어링 · 진단 · 전체 권한 표시 (ERR-15, ERR-25, ERR-27)
// ===========================================================================
test.describe("Gate Group 4: 접근성 · 폼 라벨 · 페어링 · 진단 · 전체 권한 표시 (ERR-15, ERR-25, ERR-27)", () => {
  test("설정 좌측 메뉴에 '시스템 진단'이 존재하고 /settings/diagnostics로 이동된다 (ERR-15)", async () => {
    const { page, pageErrors, dispose } = await openIsolatedPage({
      authenticated: true,
      viewport: { width: 1280, height: 800 },
    });

    try {
      await page.goto(`${serverHandle!.baseUrl}/settings/general`, {
        waitUntil: "domcontentloaded",
      });
      await waitForAppShell(page, '[data-app-sidebar=""]');

      const diagnosticsNavButton = page.locator(
        '[data-app-sidebar=""] button:has-text("시스템 진단")',
      );
      await diagnosticsNavButton.first().waitFor({ state: "visible", timeout: 10_000 });
      await diagnosticsNavButton.first().click();

      await page.waitForFunction(
        () => window.location.pathname === "/settings/diagnostics",
        undefined,
        {
          timeout: 10_000,
        },
      );

      const unlabeled = await findUnlabeledVisibleFormControls(page);
      expect(
        unlabeled,
        `설정 화면의 모든 가시 폼 컨트롤은 라벨과 연결되어야 합니다 (ERR-27): ${JSON.stringify(unlabeled)}`,
      ).toEqual([]);

      expect(pageErrors).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test("페어링 화면은 44px 터치 타겟·CLI 안내·토큰 표시/숨김 토글·폼 라벨 연결을 충족한다 (ERR-25, ERR-27)", async () => {
    const { page, pageErrors, dispose } = await openIsolatedPage({
      authenticated: false,
      viewport: { width: 430, height: 932 },
    });

    try {
      await page.goto(`${serverHandle!.baseUrl}/pair`, { waitUntil: "domcontentloaded" });
      await waitForAppShell(page, "input#pairing-token");

      // ERR-27: label[for="pairing-token"] 및 모든 가시 폼 컨트롤 라벨 연결 확인
      expect(await page.locator('label[for="pairing-token"]').count()).toBe(1);
      const unlabeled = await findUnlabeledVisibleFormControls(page);
      expect(unlabeled).toEqual([]);

      // ERR-25: CLI 토큰 안내 (`t3 pair --token`)
      const cliCode = page.locator("code");
      const hasCliGuide = await page.evaluate(() =>
        Array.from(document.querySelectorAll("code")).some((el) =>
          el.textContent?.includes("t3 pair --token"),
        ),
      );
      expect(await cliCode.count()).toBeGreaterThan(0);
      expect(hasCliGuide).toBe(true);

      // ERR-25: 토큰 표시/숨김 토글 검증
      const tokenInput = page.locator("input#pairing-token").first();
      const toggleButton = page.locator('button[aria-label="토큰 표시"]').first();
      expect(await tokenInput.getAttribute("type")).toBe("password");
      expect(await toggleButton.getAttribute("aria-pressed")).toBe("false");

      await toggleButton.click();
      expect(await tokenInput.getAttribute("type")).toBe("text");
      const hideButton = page.locator('button[aria-label="토큰 숨기기"]').first();
      expect(await hideButton.getAttribute("aria-pressed")).toBe("true");

      // ERR-25: 44px 이상 터치 타겟 검증 (입력 컨트롤 컨테이너, 토글, 제출, CLI 복사 버튼)
      const touchTargetSelectors = [
        '[data-slot="input-control"]:has(#pairing-token)',
        'button[aria-label="토큰 숨기기"]',
        'button[type="submit"]',
        'button[aria-label="CLI 토큰 확인 명령 복사"]',
      ];
      for (const selector of touchTargetSelectors) {
        const box = await page.locator(selector).first().boundingBox();
        expect(box, `페어링 컨트롤(${selector}) 바운딩 박스가 존재해야 합니다.`).not.toBeNull();
        expect(
          box!.height,
          `페어링 컨트롤(${selector}) 높이(${box!.height}px) >= 44px 이어야 합니다 (ERR-25).`,
        ).toBeGreaterThanOrEqual(44);
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test("채팅 작성기의 '전체 권한' 버튼에 원치 않는 '주의' 경고 배지가 표시되지 않는다", async () => {
    const { page, pageErrors, dispose } = await openIsolatedPage({
      authenticated: true,
      viewport: { width: 1280, height: 800 },
    });

    try {
      await page.goto(`${serverHandle!.baseUrl}/${E2E_ENVIRONMENT_ID}/${E2E_SHORT_THREAD_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForAppShell(page, 'button:has-text("전체 권한")');

      const warningAttrCount = await page.locator("[data-full-access-warning]").count();
      expect(warningAttrCount).toBe(0);

      const fullAccessButton = page.locator('button:has-text("전체 권한")').first();
      const buttonText = (await fullAccessButton.innerText()).trim();
      const ariaLabel = (await fullAccessButton.getAttribute("aria-label")) ?? "";

      expect(buttonText).toContain("전체 권한");
      expect(buttonText).not.toContain("주의");
      expect(ariaLabel).not.toContain("주의");

      expect(pageErrors).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

// ===========================================================================
// Gate Group 5: 500턴 가상화 스크롤 안정성 (ERR-07)
// ===========================================================================
test.describe("Gate Group 5: 500턴 가상화 스크롤 안정성 (ERR-07)", () => {
  test("500턴(1,000 메시지) 대용량 대화 렌더링 및 역/정방향 스크롤 시 크래시·빈 뷰포트 고착이 없다", async () => {
    const { page, pageErrors, dispose } = await openIsolatedPage({
      authenticated: true,
      viewport: { width: 1280, height: 800 },
      turnCount: 500,
    });

    try {
      await page.goto(`${serverHandle!.baseUrl}/${E2E_ENVIRONMENT_ID}/${E2E_LONG_THREAD_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForAppShell(page, '[data-timeline-root="true"]');

      // 최초 렌더링 시 실제 메시지 행이 화면에 마운트될 때까지 대기
      await page.waitForFunction(
        () => document.querySelectorAll("[data-timeline-row-id]").length > 0,
        undefined,
        { timeout: 15_000 },
      );

      // 스크롤 가능한 타임라인 컨테이너를 탐색해 최하단 → 중간 → 최상단 → 최하단 왕복 스크롤
      const scrollReport = await page.evaluate(async () => {
        const root = document.querySelector<HTMLElement>('[data-timeline-root="true"]');
        if (!root) {
          return { foundContainer: false, checkpoints: [] as Array<Record<string, unknown>> };
        }

        const findScrollable = (start: HTMLElement): HTMLElement => {
          const descendants = Array.from(start.querySelectorAll<HTMLElement>("*"));
          for (const candidate of [start, ...descendants]) {
            const style = window.getComputedStyle(candidate);
            const overflowY = style.overflowY;
            if (
              (overflowY === "auto" || overflowY === "scroll") &&
              candidate.scrollHeight > candidate.clientHeight + 50
            ) {
              return candidate;
            }
          }
          let parent = start.parentElement;
          while (parent) {
            if (parent.scrollHeight > parent.clientHeight + 50) {
              return parent;
            }
            parent = parent.parentElement;
          }
          return start;
        };

        const scroller = findScrollable(root);
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const targets = [
          { label: "bottom-initial", ratio: 1 },
          { label: "middle", ratio: 0.5 },
          { label: "upper-quarter", ratio: 0.25 },
          { label: "top", ratio: 0 },
          { label: "bottom-return", ratio: 1 },
        ];

        const checkpoints: Array<{
          label: string;
          scrollTop: number;
          scrollHeight: number;
          renderedRowCount: number;
          visibleNonEmptyRowCount: number;
          stuckLoadingOverlay: boolean;
        }> = [];

        for (const target of targets) {
          scroller.scrollTop = Math.round(maxScrollTop * target.ratio);
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          await new Promise((resolve) => setTimeout(resolve, 120));

          const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-timeline-row-id]"));
          const viewportRect = scroller.getBoundingClientRect();
          const visibleNonEmptyRowCount = rows.filter((row) => {
            const rect = row.getBoundingClientRect();
            const overlapsViewport =
              rect.bottom > viewportRect.top && rect.top < viewportRect.bottom && rect.height > 0;
            return overlapsViewport && Boolean(row.textContent?.trim());
          }).length;

          const stuckLoadingOverlay = (document.body.innerText || "").includes(
            "Loading messages...",
          );

          checkpoints.push({
            label: target.label,
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            renderedRowCount: rows.length,
            visibleNonEmptyRowCount,
            stuckLoadingOverlay,
          });
        }

        return { foundContainer: true, checkpoints };
      });

      expect(scrollReport.foundContainer).toBe(true);
      expect(scrollReport.checkpoints.length).toBe(5);

      for (const cp of scrollReport.checkpoints) {
        expect(
          cp.renderedRowCount,
          `[500턴 ${cp.label}] 가상화 리스트가 행을 렌더링해야 합니다.`,
        ).toBeGreaterThan(0);
        expect(
          cp.visibleNonEmptyRowCount,
          `[500턴 ${cp.label}] 뷰포트 내에 실제 콘텐츠 행이 보여야 합니다(빈 뷰포트 고착 금지, ERR-07).`,
        ).toBeGreaterThan(0);
        expect(
          cp.stuckLoadingOverlay,
          `[500턴 ${cp.label}] 'Loading messages...' 오버레이가 고착되면 안 됩니다 (ERR-07).`,
        ).toBe(false);
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await dispose();
    }
  });

  // =========================================================================
  // Gate Group 6: 200p 엔터프라이즈 마스터 리포트 4대 포렌식 회귀 게이트 (BUG-01~12)
  // =========================================================================
  test("Gate Group 6: 200p 마스터 포렌식 회귀 게이트 (컴팩트 프로젝트 헤더·설정 IA·모바일 5탭/2열 KPI·PII 0누출·하이드레이션)", async () => {
    // 6-1. Desktop 1280×800: Compact project hero (BUG-01), Settings IA (BUG-11), PII zero-leak (BUG-09)
    const desktop = await openIsolatedPage({
      authenticated: true,
      viewport: { width: 1280, height: 800 },
    });
    try {
      // BUG-01: Sub-section under project control center uses compact sticky header (not 380px hero)
      await desktop.page.goto(
        `${serverHandle!.baseUrl}/control-center/${E2E_ENVIRONMENT_ID}/${E2E_PROJECT_ID}?domain=automation-verify&section=project-automation`,
        { waitUntil: "domcontentloaded" },
      );
      await desktop.page.waitForSelector('[data-project-hero-mode="compact"]', { timeout: 15_000 });
      const compactHeroHeight = await desktop.page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-project-hero-mode="compact"]');
        return el ? Math.round(el.getBoundingClientRect().height) : 9999;
      });
      expect(
        compactHeroHeight,
        "[BUG-01] 하위 섹션 상단 컴팩트 프로젝트 바 높이는 120px 이하여야 합니다.",
      ).toBeLessThanOrEqual(120);

      // BUG-11: Permissions tab must not contain '애플리케이션 업데이트', General tab must contain it
      await desktop.page.goto(`${serverHandle!.baseUrl}/settings/permissions`, {
        waitUntil: "domcontentloaded",
      });
      await desktop.page.waitForFunction(
        () => (document.body?.innerText || "").includes("프로젝트 프로그램 운영"),
        { timeout: 15_000 },
      );
      const permissionsText = await desktop.page.evaluate(() => document.body?.innerText || "");
      expect(permissionsText).not.toContain("애플리케이션 업데이트");

      await desktop.page.goto(`${serverHandle!.baseUrl}/settings/general`, {
        waitUntil: "domcontentloaded",
      });
      await desktop.page.waitForFunction(
        () => (document.body?.innerText || "").includes("애플리케이션 업데이트"),
        { timeout: 15_000 },
      );

      // BUG-09: Control center overview must not leak raw email addresses or DESKTOP-* hostnames
      await desktop.page.goto(`${serverHandle!.baseUrl}/control-center`, {
        waitUntil: "domcontentloaded",
      });
      await desktop.page.waitForSelector("[data-control-center-kpi-grid]", { timeout: 15_000 });
      const leakAudit = await desktop.page.evaluate(() => {
        const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        const hostRe = /\bDESKTOP-[A-Z0-9]+\b/;
        const leaks: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const parent = node.parentElement;
          if (!parent || parent.closest('[data-redacted-pii="masked"]')) continue;
          const text = node.nodeValue ?? "";
          if (emailRe.test(text) || hostRe.test(text)) {
            leaks.push(text.trim().slice(0, 80));
          }
        }
        return {
          leaks,
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
          stillLoading: (document.body.innerText || "").includes("불러오는 중..."),
        };
      });
      expect(
        leakAudit.leaks,
        "[BUG-09] 제어센터 DOM에 평문 이메일/호스트명 누출이 0건이어야 합니다.",
      ).toEqual([]);
      expect(leakAudit.overflowX, "[BUG-04] 수평 오버플로가 없어야 합니다.").toBe(false);
      expect(
        leakAudit.stillLoading,
        "[BUG-05] 미하이드레이션 로딩 문구가 남지 않아야 합니다.",
      ).toBe(false);
      expect(desktop.pageErrors).toEqual([]);
    } finally {
      await desktop.dispose();
    }

    // 6-2. Mobile 430×932: Bottom 5-tab bar + 2-column KPI grid (BUG-12)
    const mobile = await openIsolatedPage({
      authenticated: true,
      viewport: { width: 430, height: 932 },
    });
    try {
      await mobile.page.goto(`${serverHandle!.baseUrl}/control-center`, {
        waitUntil: "domcontentloaded",
      });
      await mobile.page.waitForSelector('[data-slot="mobile-activity-tabbar"]', {
        timeout: 15_000,
      });
      await mobile.page.waitForSelector("[data-control-center-kpi-grid]", { timeout: 15_000 });
      const mobileReport = await mobile.page.evaluate(() => {
        const tabbar = document.querySelector<HTMLElement>('[data-slot="mobile-activity-tabbar"]');
        const tabItems = tabbar?.querySelectorAll("[data-mobile-rail-item]").length ?? 0;
        const tabRect = tabbar?.getBoundingClientRect();
        const kpiGrid = document.querySelector<HTMLElement>("[data-control-center-kpi-grid]");
        const kpiRect = kpiGrid?.getBoundingClientRect();
        const inbox = document.querySelector<HTMLElement>("[data-attention-inbox]");
        const inboxRect = inbox?.getBoundingClientRect();
        return {
          tabbarVisible: Boolean(tabRect && tabRect.height >= 40 && tabRect.width >= 300),
          tabItems,
          kpiHeight: kpiRect ? Math.round(kpiRect.height) : 9999,
          inboxTop: inboxRect ? Math.round(inboxRect.top) : 9999,
        };
      });
      expect(
        mobileReport.tabbarVisible,
        "[BUG-12] 모바일 하단 5탭 바가 가시 상태여야 합니다.",
      ).toBe(true);
      expect(
        mobileReport.tabItems,
        "[BUG-12] 모바일 하단 탭 바는 5대 전역 메뉴를 제공해야 합니다.",
      ).toBe(5);
      expect(
        mobileReport.kpiHeight,
        "[BUG-12] 모바일 KPI 2×2 그리드 높이는 기존 560px 1열 적층 대비 320px 이하여야 합니다.",
      ).toBeLessThanOrEqual(320);
      expect(
        mobileReport.inboxTop,
        "[BUG-12] 모바일 제어센터 첫 화면(932px) 내에 확인함이 진입해야 합니다.",
      ).toBeLessThan(820);
      expect(mobile.pageErrors).toEqual([]);
    } finally {
      await mobile.dispose();
    }
  });

  // =========================================================================
  // Gate Group 7: 모델-불가지론적 다자간 위원회 · 근거 원장 · PinnedSpec UI (TC-08)
  // =========================================================================
  test("Gate Group 7: 동적 위원회 Strip · 인라인 PinnedSpec 카드 · 워커 스위처 · 근거 원장 드로어 · 라이트/다크 시맨틱 토큰", async () => {
    const { page, pageErrors, dispose } = await openIsolatedPage({
      authenticated: true,
      viewport: { width: 1280, height: 800 },
      councilFixture: true,
    });
    try {
      await page.goto(`${serverHandle!.baseUrl}/${E2E_ENVIRONMENT_ID}/${E2E_SHORT_THREAD_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForAppShell(page, "[data-council-strip]");
      await waitForAppShell(page, "[data-council-pinned-card]");

      const cardText = await page.locator("[data-council-pinned-card]").first().innerText();
      expect(cardText).toContain("2인 동적 위원회");
      expect(cardText).toContain("원장 검증 근거 1건");
      expect(cardText).toContain("무근거 Flip 1건 차단");
      expect(cardText).toContain("src/auth.ts");

      // Worker switcher dropdown must expose recommended 1st + fallback candidate
      const workerSelectOptions = await page.evaluate(() => {
        const sel = document.querySelector<HTMLSelectElement>("[data-council-worker-select]");
        if (!sel) return [];
        return Array.from(sel.options).map((o) => o.textContent ?? "");
      });
      expect(workerSelectOptions.length).toBe(2);
      expect(workerSelectOptions[0]).toContain("[추천 1순위]");

      // Open Evidence Ledger drawer & verify anonymized Proposal-1 + file/symbol entry
      await page
        .locator('[data-council-pinned-card] button:has-text("근거 원장 보기")')
        .first()
        .click();
      await waitForAppShell(page, "[data-council-evidence-drawer]");
      const drawerText = await page.locator("[data-council-evidence-drawer]").first().innerText();
      expect(drawerText).toContain("src/auth.ts:1-18");
      expect(drawerText).toContain("verifyToken");
      expect(drawerText).toContain("Proposal-1");

      // Header overlap & horizontal overflow must remain 0
      const headerBoxes = await collectVisibleHeaderButtonBoxes(page, "header[data-chat-header]");
      expect(findHeaderButtonOverlaps(headerBoxes)).toEqual([]);
      const overflowX = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 2,
      );
      expect(overflowX).toBe(false);
      expect(pageErrors).toEqual([]);
    } finally {
      await dispose();
    }
  });
});
