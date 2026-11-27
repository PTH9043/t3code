import { spawn, type ChildProcess } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SERVER_SETTINGS,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ServerConfig,
  ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// ---------------------------------------------------------------------------
// Playwright-compatible test.describe wrapper backed by vite-plus/test so the
// suite runs without adding @playwright/test to package.json.
// ---------------------------------------------------------------------------

type TestFn = () => Promise<void> | void;

interface TestCallable {
  (name: string, fn: TestFn, timeoutMs?: number): void;
  describe: typeof describe;
  beforeAll: typeof beforeAll;
  afterAll: typeof afterAll;
}

const DEFAULT_E2E_TEST_TIMEOUT_MS = 60_000;

export const test: TestCallable = Object.assign(
  (name: string, fn: TestFn, timeoutMs = DEFAULT_E2E_TEST_TIMEOUT_MS) => {
    it(name, fn, timeoutMs);
  },
  {
    describe,
    beforeAll,
    afterAll,
  },
);

export { expect };

// ---------------------------------------------------------------------------
// Minimal structural Playwright-Core types (keeps tsgo --noEmit clean in
// apps/web without modifying package.json or installing @playwright/test).
// ---------------------------------------------------------------------------

export interface PlaywrightBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlaywrightRequest {
  url(): string;
  method(): string;
}

export interface PlaywrightRoute {
  request(): PlaywrightRequest;
  fulfill(response: {
    status?: number;
    contentType?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

export interface PlaywrightLocator {
  first(): PlaywrightLocator;
  nth(index: number): PlaywrightLocator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  click(options?: { timeout?: number; force?: boolean }): Promise<void>;
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  boundingBox(): Promise<PlaywrightBoundingBox | null>;
  waitFor(options?: {
    state?: "attached" | "detached" | "visible" | "hidden";
    timeout?: number;
  }): Promise<void>;
}

export interface PlaywrightWebSocketRoute {
  url(): string;
  send(message: string | Buffer): void;
  onMessage(handler: (message: string | Buffer) => void): void;
  close(options?: { code?: number; reason?: string }): Promise<void>;
}

export interface PlaywrightPage {
  setViewportSize(viewport: { width: number; height: number }): Promise<void>;
  goto(
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number },
  ): Promise<unknown>;
  url(): string;
  locator(selector: string): PlaywrightLocator;
  evaluate<R, Arg = void>(fn: (arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R>;
  route(
    url: string | RegExp,
    handler: (route: PlaywrightRoute) => Promise<void> | void,
  ): Promise<void>;
  routeWebSocket(
    url: string | RegExp,
    handler: (ws: PlaywrightWebSocketRoute) => Promise<void> | void,
  ): Promise<void>;
  unrouteAll?(options?: { behavior?: "wait" | "ignoreErrors" | "default" }): Promise<void>;
  addInitScript(script: string | ((arg?: unknown) => void)): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForFunction<Arg = void>(
    fn: (arg: Arg) => unknown,
    arg?: Arg,
    options?: { timeout?: number; polling?: number | "raf" },
  ): Promise<unknown>;
  on(event: "pageerror", listener: (err: Error) => void): void;
  on(event: "console", listener: (msg: { type(): string; text(): string }) => void): void;
  close(): Promise<void>;
}

export interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

export interface PlaywrightBrowser {
  newContext(options?: {
    viewport?: { width: number; height: number };
    colorScheme?: "light" | "dark" | "no-preference";
    reducedMotion?: "reduce" | "no-preference";
  }): Promise<PlaywrightBrowserContext>;
  close(): Promise<void>;
}

interface PlaywrightChromiumLauncher {
  launch(options: {
    headless: true;
    executablePath?: string;
    args?: string[];
  }): Promise<PlaywrightBrowser>;
}

// ---------------------------------------------------------------------------
// Constants & Isolation Guards
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = NodePath.dirname(__filename);
export const WEB_APP_DIR = NodePath.resolve(__dirname, "..");
export const REPO_ROOT_DIR = NodePath.resolve(WEB_APP_DIR, "..", "..");

const LIVE_PRODUCTION_PORTS = new Set(["13773"]);

export const E2E_ENVIRONMENT_ID = "env-e2e-quality";
export const E2E_PROJECT_ID = "proj-e2e-quality";
export const E2E_SHORT_THREAD_ID = "thread-e2e-header";
export const E2E_LONG_THREAD_ID = "thread-e2e-500-turns";

export const RESPONSIVE_VIEWPORTS = [
  { name: "desktop-fhd", width: 1920, height: 1080 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "mobile-430", width: 430, height: 932 },
  { name: "mobile-320", width: 320, height: 568 },
] as const;

export const CONTROL_CENTER_DOMAIN_IDS = [
  "home",
  "execution",
  "tools-knowledge",
  "automation-verify",
  "infra-accounts",
] as const;

export const ACTIVITY_RAIL_ITEM_IDS = [
  "chat",
  "control-center",
  "knowledge",
  "diagnostics",
  "settings",
] as const;

export interface ThemeMatrixCase {
  readonly name: string;
  readonly themeId: string | null;
  readonly appearance: "light" | "dark";
}

export const SIX_THEME_MATRIX: ReadonlyArray<ThemeMatrixCase> = [
  { name: "Dark (Default)", themeId: null, appearance: "dark" },
  { name: "Light (Default)", themeId: null, appearance: "light" },
  { name: "Ocean (Dark)", themeId: "ocean", appearance: "dark" },
  { name: "Ocean (Light)", themeId: "ocean", appearance: "light" },
  { name: "Ember (Dark)", themeId: "ember", appearance: "dark" },
  { name: "Ember (Light)", themeId: "ember", appearance: "light" },
  { name: "Iris (Dark)", themeId: "iris", appearance: "dark" },
  { name: "Iris (Light)", themeId: "iris", appearance: "light" },
  { name: "Grove (Dark)", themeId: "grove", appearance: "dark" },
  { name: "Grove (Light)", themeId: "grove", appearance: "light" },
] as const;

export function assertIsolatedTargetUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (LIVE_PRODUCTION_PORTS.has(parsed.port)) {
    throw new Error(
      `Refusing to run E2E quality gates against live production port ${parsed.port} (${rawUrl}). Use an isolated temporary port.`,
    );
  }
  return parsed.origin;
}

// ---------------------------------------------------------------------------
// Headless Chromium Launcher (strictly headless: true, zero focus stealing)
// ---------------------------------------------------------------------------

function resolveSystemBrowserExecutable(): string | undefined {
  const envPath = process.env.T3_E2E_CHROMIUM_PATH?.trim();
  if (envPath && NodeFs.existsSync(envPath)) {
    return envPath;
  }

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];

  return candidates.find((candidate) => NodeFs.existsSync(candidate));
}

function loadPlaywrightChromium(): PlaywrightChromiumLauncher {
  const require = createRequire(import.meta.url);
  const candidateModules = [
    NodePath.resolve(REPO_ROOT_DIR, "apps/desktop/node_modules/playwright-core"),
    "playwright-core",
    "@playwright/test",
  ];

  for (const modPath of candidateModules) {
    try {
      const loaded = require(modPath) as { chromium?: PlaywrightChromiumLauncher };
      if (loaded?.chromium && typeof loaded.chromium.launch === "function") {
        return loaded.chromium;
      }
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(
    "Could not load playwright-core from repository node_modules. Ensure workspace dependencies are installed.",
  );
}

export async function launchHeadlessChromium(): Promise<PlaywrightBrowser> {
  const chromium = loadPlaywrightChromium();
  const executablePath = resolveSystemBrowserExecutable();
  return chromium.launch({
    // Strictly headless to enforce AGENTS.md no-focus-stealing rule.
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
}

// ---------------------------------------------------------------------------
// Isolated Temporary Vite Server Lifecycle (zero live backend/DB mutation)
// ---------------------------------------------------------------------------

async function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate an ephemeral localhost port."));
        return;
      }
      const { port } = address;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Isolated web server did not become ready at ${url} within ${timeoutMs}ms: ${String(lastError)}`,
  );
}

export interface IsolatedWebServerHandle {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startIsolatedWebServer(): Promise<IsolatedWebServerHandle> {
  const externalUrl = process.env.T3_E2E_BASE_URL?.trim();
  if (externalUrl) {
    return {
      baseUrl: assertIsolatedTargetUrl(externalUrl),
      async close() {
        // Externally managed isolated server.
      },
    };
  }

  const port = await allocateEphemeralPort();
  const baseUrl = assertIsolatedTargetUrl(`http://127.0.0.1:${port}`);

  const binDir = NodePath.resolve(REPO_ROOT_DIR, "node_modules/.bin");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [pathKey]: `${binDir}${NodePath.delimiter}${currentPath}`,
    HOST: "127.0.0.1",
    PORT: String(port),
    T3CODE_SINGLE_ORIGIN_DEV: "1",
    T3CODE_BUNDLED_DEV: "0",
    // Explicitly blank backend proxy/URL envs so nothing can reach live port 13773.
    T3CODE_PORT: "",
    VITE_HTTP_URL: "",
    VITE_WS_URL: "",
    BROWSER: "none",
  };

  const vpBin =
    process.platform === "win32"
      ? NodePath.resolve(binDir, "vp.cmd")
      : NodePath.resolve(binDir, "vp");

  let child: ChildProcess;
  if (process.platform === "win32") {
    child = spawn(
      "cmd.exe",
      ["/d", "/c", vpBin, "dev", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: WEB_APP_DIR,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } else {
    child = spawn(vpBin, ["dev", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: WEB_APP_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  let logs = "";
  const appendLog = (chunk: Buffer) => {
    logs = (logs + chunk.toString("utf8")).slice(-8_000);
  };
  child.stdout?.on("data", appendLog);
  child.stderr?.on("data", appendLog);

  const stopChild = async () => {
    if (child.exitCode !== null || child.killed) {
      return;
    }
    if (process.platform === "win32" && child.pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("exit", () => resolve());
        killer.on("error", () => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve();
        });
      });
      return;
    }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  try {
    await waitForHttpReady(baseUrl, 45_000);
  } catch (error) {
    await stopChild();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nVite logs:\n${logs}`,
    );
  }

  return {
    baseUrl,
    close: stopChild,
  };
}

// ---------------------------------------------------------------------------
// In-Memory Backend Route Mocking (100% isolated from E:\NewAutoUsage)
// ---------------------------------------------------------------------------

export interface MockBackendOptions {
  readonly authenticated: boolean;
  readonly turnCount?: number;
  readonly councilFixture?: boolean;
}

function buildIsoTimestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 10, 21, 0, 0, 0) + offsetSeconds * 1000).toISOString();
}

export function buildSyntheticMessages(turnCount: number) {
  const messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < turnCount; i += 1) {
    const turnId = `turn-e2e-${String(i + 1).padStart(4, "0")}`;
    const userTs = buildIsoTimestamp(i * 10);
    const assistantTs = buildIsoTimestamp(i * 10 + 4);
    messages.push({
      id: `msg-user-${i + 1}`,
      role: "user",
      text: `품질 게이트 검증 턴 #${i + 1}: 반응형 레이아웃 및 가상화 스크롤 안정성 점검 요청입니다.`,
      turnId,
      streaming: false,
      createdAt: userTs,
      updatedAt: userTs,
    });
    messages.push({
      id: `msg-assistant-${i + 1}`,
      role: "assistant",
      text:
        i % 5 === 0
          ? `턴 #${i + 1} 분석 결과입니다.\n\n\`\`\`ts\nexport const turnIndex = ${i + 1};\n\`\`\`\n\n레이아웃 예산과 가상화 행 높이 추정이 정상 범위입니다.`
          : `턴 #${i + 1} 검증 완료: 스크롤 컨테이너가 빈 뷰포트 고착 없이 정상 동작합니다.`,
      turnId,
      streaming: false,
      createdAt: assistantTs,
      updatedAt: assistantTs,
    });
  }
  return messages;
}

export async function installIsolatedBackendMocks(
  page: PlaywrightPage,
  options: MockBackendOptions,
): Promise<void> {
  const turnCount = options.turnCount ?? 500;
  const nowIso = buildIsoTimestamp(turnCount * 10 + 30);
  const shortMessages = buildSyntheticMessages(6);
  const longMessages = buildSyntheticMessages(turnCount);

  const descriptorPayload = {
    environmentId: E2E_ENVIRONMENT_ID,
    label: "E2E Isolated Environment",
    platform: { os: "windows", arch: "x64" },
    serverVersion: "0.0.32-e2e",
    capabilities: {
      repositoryIdentity: false,
      connectionProbe: false,
      threadSettlement: true,
      threadSnooze: true,
      threadPinning: true,
      threadPinReorder: true,
      threadTitleRegeneration: false,
    },
  };

  const sessionPayload = options.authenticated
    ? {
        authenticated: true,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_e2e_session",
        },
        scopes: [
          "orchestration:read",
          "orchestration:operate",
          "terminal:operate",
          "review:write",
          "access:read",
          "access:write",
          "relay:read",
          "relay:write",
        ],
        sessionMethod: "browser-session-cookie",
        expiresAt: buildIsoTimestamp(86_400),
      }
    : {
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_e2e_session",
        },
      };

  const defaultModelSelection = {
    instanceId: "codex",
    provider: "codex",
    model: "gpt-5-codex",
  };

  const projectShell = {
    id: E2E_PROJECT_ID,
    title: "E2E Quality Gates Workspace",
    workspaceRoot: "D:/__E2E_Isolated__/workspace",
    repositoryIdentity: null,
    defaultModelSelection,
    scripts: [],
    createdAt: buildIsoTimestamp(0),
    updatedAt: nowIso,
  };

  const shortThreadShell = {
    id: E2E_SHORT_THREAD_ID,
    projectId: E2E_PROJECT_ID,
    title: "반응형 헤더 및 권한 배지 검증 스레드",
    modelSelection: defaultModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    orchestraRunThreadId: null,
    latestTurn: null,
    createdAt: buildIsoTimestamp(0),
    updatedAt: nowIso,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: nowIso,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };

  const longThreadShell = {
    ...shortThreadShell,
    id: E2E_LONG_THREAD_ID,
    title: "500턴 가상화 스크롤 안정성 스트레스 스레드",
  };

  const buildThreadDetail = (
    shell: typeof shortThreadShell,
    messages: Array<Record<string, unknown>>,
  ) => ({
    snapshotSequence: 1,
    thread: {
      id: shell.id,
      projectId: shell.projectId,
      title: shell.title,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      orchestraRunThreadId: shell.orchestraRunThreadId,
      latestTurn: shell.latestTurn,
      createdAt: shell.createdAt,
      updatedAt: shell.updatedAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages,
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  });

  const shellSnapshotPayload = {
    snapshotSequence: 1,
    projects: [projectShell],
    threads: [shortThreadShell, longThreadShell],
    updatedAt: nowIso,
  };
  const shortThreadDetailPayload = buildThreadDetail(shortThreadShell, shortMessages);
  const longThreadDetailPayload = buildThreadDetail(longThreadShell, longMessages);

  // Self-validate mock payloads against live @t3tools/contracts schemas so any
  // contract drift fails fast instead of hanging in a browser wait.
  Schema.decodeUnknownSync(OrchestrationShellSnapshot)(shellSnapshotPayload);
  Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot)(shortThreadDetailPayload);

  await page.route("**/.well-known/t3/environment*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(descriptorPayload),
    });
  });

  // Single unified /api/** handler avoids Playwright's LIFO route precedence trap
  // where a later catch-all route would shadow earlier specific handlers.
  await page.route("**/api/**", async (route) => {
    const reqUrl = route.request().url();
    const pathname = new URL(reqUrl).pathname;

    if (pathname === "/api/auth/session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(sessionPayload),
      });
      return;
    }

    if (pathname === "/api/auth/websocket-ticket") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ticket: "e2e-mock-ws-ticket",
          expiresAt: buildIsoTimestamp(3_600),
        }),
      });
      return;
    }

    if (pathname === "/api/orchestration/shell") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(shellSnapshotPayload),
      });
      return;
    }

    if (pathname.startsWith("/api/orchestration/threads/")) {
      const isLong = pathname.includes(E2E_LONG_THREAD_ID);
      const payload = isLong ? longThreadDetailPayload : shortThreadDetailPayload;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
      return;
    }

    if (pathname === "/api/orchestration/snapshot") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          snapshotSequence: 1,
          projects: [{ ...projectShell, deletedAt: null }],
          threads: [shortThreadDetailPayload.thread, longThreadDetailPayload.thread],
          updatedAt: nowIso,
        }),
      });
      return;
    }

    if (pathname === "/api/connect/link-state") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          linked: false,
          cloudUserId: null,
          relayUrl: null,
          relayIssuer: null,
          managedTunnelActive: false,
          publishAgentActivity: false,
        }),
      });
      return;
    }

    if (pathname === "/api/auth/pairing-links" || pathname === "/api/auth/clients") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });

  if (options.authenticated) {
    const serverConfigPayload = {
      environment: descriptorPayload,
      auth: sessionPayload.auth,
      cwd: "D:/__E2E_Isolated__/workspace",
      keybindingsConfigPath: "D:/__E2E_Isolated__/keybindings.json",
      keybindings: [],
      issues: [],
      providers: [],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "D:/__E2E_Isolated__/logs",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: Schema.encodeSync(ServerSettings)(DEFAULT_SERVER_SETTINGS),
    };

    Schema.decodeUnknownSync(ServerConfig)(serverConfigPayload);

    const fullSnapshotPayload = {
      snapshotSequence: 1,
      projects: [{ ...projectShell, deletedAt: null }],
      threads: [shortThreadDetailPayload.thread, longThreadDetailPayload.thread],
      updatedAt: nowIso,
    };

    await page.routeWebSocket("**/ws*", (ws) => {
      ws.onMessage((raw) => {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return;
        }

        if (parsed._tag === "Ping") {
          ws.send(JSON.stringify({ _tag: "Pong" }));
          return;
        }

        if (parsed._tag !== "Request") {
          return;
        }

        const requestId = parsed.id;
        const tag = String(parsed.tag ?? "");
        const payload = (parsed.payload ?? {}) as Record<string, unknown>;

        const sendExitSuccess = (value: unknown) => {
          ws.send(
            JSON.stringify({
              _tag: "Exit",
              requestId,
              exit: { _tag: "Success", value },
            }),
          );
        };

        const sendStreamChunk = (values: ReadonlyArray<unknown>) => {
          ws.send(
            JSON.stringify({
              _tag: "Chunk",
              requestId,
              values,
            }),
          );
        };

        if (tag === "server.getConfig") {
          sendExitSuccess(serverConfigPayload);
          return;
        }

        if (tag === "subscribeServerConfig" || tag === "server.subscribeConfig") {
          sendStreamChunk([
            {
              version: 1,
              type: "snapshot",
              config: serverConfigPayload,
            },
          ]);
          return;
        }

        if (tag === "subscribeServerLifecycle" || tag === "server.subscribeLifecycle") {
          sendStreamChunk([
            {
              version: 1,
              sequence: 1,
              type: "welcome",
              payload: {
                environment: descriptorPayload,
                cwd: serverConfigPayload.cwd,
                projectName: projectShell.title,
              },
            },
            {
              version: 1,
              sequence: 2,
              type: "ready",
              payload: {
                at: nowIso,
                environment: descriptorPayload,
              },
            },
          ]);
          return;
        }

        if (tag === "server.reportClientActivity") {
          sendExitSuccess(undefined);
          return;
        }

        if (tag === "orchestration.getSnapshot") {
          sendExitSuccess(fullSnapshotPayload);
          return;
        }

        if (tag === "orchestration.getShellSnapshot") {
          sendExitSuccess(shellSnapshotPayload);
          return;
        }

        if (tag === "orchestration.getThreadDetail") {
          const threadId = String(payload.threadId ?? "");
          const isLong = threadId === E2E_LONG_THREAD_ID;
          sendExitSuccess(isLong ? longThreadDetailPayload : shortThreadDetailPayload);
          return;
        }

        if (tag === "council.subscribe") {
          const threadId = String(payload.threadId ?? E2E_SHORT_THREAD_ID);
          const sessions = options.councilFixture
            ? [
                {
                  councilId: "cnc_e2e_000001",
                  threadId,
                  projectId: E2E_PROJECT_ID,
                  userPrompt: "인증 동시성 경쟁 조건 분석 및 최소 침습 패치",
                  state: "PINNED_READY",
                  chairModel: {
                    providerInstanceId: "codex",
                    driverId: "codex",
                    modelId: "gpt-5-codex",
                    displayName: "Codex · gpt-5-codex",
                  },
                  roster: [
                    {
                      seatId: "seat_chair",
                      targetModel: {
                        providerInstanceId: "codex",
                        driverId: "codex",
                        modelId: "gpt-5-codex",
                        displayName: "Codex · gpt-5-codex",
                      },
                      assignedRole: "CHAIR_ARBITER",
                      capabilityTags: ["deep_reasoning", "code_edit"],
                      temperatureOffset: 0,
                      temperatureApplied: false,
                      directoryShardHint: null,
                      isFallbackSubstituted: false,
                    },
                    {
                      seatId: "seat_sub_0",
                      targetModel: {
                        providerInstanceId: "claude",
                        driverId: "claudeAgent",
                        modelId: "claude-sonnet",
                        displayName: "Claude · claude-sonnet",
                      },
                      assignedRole: "CONTRARIAN_RED",
                      capabilityTags: ["code_edit", "fast_critic"],
                      temperatureOffset: 0,
                      temperatureApplied: false,
                      directoryShardHint: null,
                      isFallbackSubstituted: false,
                    },
                  ],
                  triageScore: 0.92,
                  flipBlockedCount: 1,
                  researchRetryCount: 0,
                  ledgerEntries: [
                    {
                      evidenceId: "ev_e2e_1",
                      councilId: "cnc_e2e_000001",
                      submittedBySeatId: "seat_chair",
                      roundNum: 1,
                      filePath: "src/auth.ts",
                      startLine: 1,
                      endLine: 18,
                      astSymbol: "verifyToken",
                      excerptSha256: "a".repeat(64),
                      fileHeadSha256: "b".repeat(64),
                      verificationStatus: "VERIFIED_EXACT",
                      verifiedAtMs: Date.now(),
                    },
                  ],
                  claims: [
                    {
                      claimId: "clm_e2e_1",
                      councilId: "cnc_e2e_000001",
                      authorSeatId: "seat_chair",
                      anonHandle: "Proposal-1",
                      roundNum: 1,
                      claimKind: "PATCH_PROPOSAL",
                      severity: "P1",
                      targetClaimId: null,
                      responseTaxonomy: "INITIAL",
                      stanceHash: "c".repeat(64),
                      statementKo: "verifyToken 공백 가드 및 스코프 중복 제거를 적용합니다.",
                      proposedDiffSketch: "trim token + dedup scopes",
                      evidenceIds: ["ev_e2e_1"],
                      subjectiveOpinion: {
                        belief: 0.65,
                        disbelief: 0,
                        uncertainty: 0.35,
                        baseRate: 0.5,
                      },
                      status: "ACCEPTED",
                    },
                  ],
                  pinnedSpec: {
                    pinnedSpecId: "pspec_e2e_0001",
                    councilId: "cnc_e2e_000001",
                    threadId,
                    projectId: E2E_PROJECT_ID,
                    titleKo: "auth.ts 토큰 검증 및 스코프 중복 제거",
                    executiveSummaryKo: "검증된 원장 근거 1건 기반으로 최소 침습 패치를 잠급니다.",
                    acceptedClaimIds: ["clm_e2e_1"],
                    verifiedEvidenceIds: ["ev_e2e_1"],
                    targetFilesLock: [
                      {
                        filePath: "src/auth.ts",
                        expectedFileSha256: "b".repeat(64),
                        patchIntentKo: "verifyToken 공백 가드 추가",
                        relatedEvidenceIds: ["ev_e2e_1"],
                      },
                    ],
                    acceptanceChecks: [
                      {
                        label: "인증 단위 테스트",
                        verifySpec: { command: "vp", args: ["test", "run", "src/auth.test.ts"] },
                      },
                    ],
                    unresolvedDisagreementsKo: [],
                    uniqueFindingsKo: [],
                    recommendedWorker: {
                      providerInstanceId: "codex",
                      driverId: "codex",
                      modelId: "gpt-5-codex",
                      displayName: "Codex · gpt-5-codex",
                    },
                    availableWorkerCandidates: [
                      {
                        providerInstanceId: "codex",
                        driverId: "codex",
                        modelId: "gpt-5-codex",
                        displayName: "Codex · gpt-5-codex",
                      },
                      {
                        providerInstanceId: "claude",
                        driverId: "claudeAgent",
                        modelId: "claude-sonnet",
                        displayName: "Claude · claude-sonnet",
                      },
                    ],
                    specHashSha256: "d".repeat(64),
                    delegatedTaskId: null,
                    createdAtMs: Date.now(),
                  },
                  errorMessage: null,
                  createdAtMs: Date.now(),
                  updatedAtMs: Date.now(),
                },
              ]
            : [];
          sendStreamChunk([
            {
              kind: "snapshot",
              threadId,
              sessions,
              updatedAt: nowIso,
            },
          ]);
          return;
        }

        // Keep streaming subscriptions open without closing the socket.
        if (tag.toLowerCase().includes("subscribe")) {
          return;
        }

        // For non-critical query RPCs (git status, diagnostics, workspace control),
        // return safe empty/default payloads so auxiliary widgets never crash.
        if (tag.startsWith("git.") || tag.startsWith("terminal.") || tag.startsWith("workspace")) {
          sendExitSuccess({});
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Pure Mathematical Geometry, Color & Accessibility Verification Helpers
// (Zero dependency on @axe-core/playwright)
// ---------------------------------------------------------------------------

export interface RectLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HeaderButtonBox extends RectLike {
  readonly label: string;
  readonly tagName: string;
}

export interface HeaderOverlapViolation {
  readonly first: HeaderButtonBox;
  readonly second: HeaderButtonBox;
  readonly areaPx2: number;
}

/**
 * Exact axis-aligned bounding-box intersection area in square pixels (px²).
 */
export function computeRectIntersectionArea(a: RectLike, b: RectLike): number {
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlapX * overlapY;
}

/**
 * Finds all pairs of visible header controls whose bounding boxes intersect by
 * strictly more than `tolerancePx2` (default 0px²).
 */
export function findHeaderButtonOverlaps(
  boxes: ReadonlyArray<HeaderButtonBox>,
  tolerancePx2 = 0,
): Array<HeaderOverlapViolation> {
  const violations: Array<HeaderOverlapViolation> = [];
  for (let i = 0; i < boxes.length; i += 1) {
    const first = boxes[i]!;
    for (let j = i + 1; j < boxes.length; j += 1) {
      const second = boxes[j]!;
      const areaPx2 = computeRectIntersectionArea(first, second);
      if (areaPx2 > tolerancePx2) {
        violations.push({ first, second, areaPx2 });
      }
    }
  }
  return violations;
}

export async function collectVisibleHeaderButtonBoxes(
  page: PlaywrightPage,
  headerSelector = "header[data-chat-header], header.workspace-topbar",
): Promise<Array<HeaderButtonBox>> {
  return page.evaluate((selector) => {
    const headers = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const header = headers.find((el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    });
    if (!header) {
      return [];
    }

    const candidates = Array.from(
      header.querySelectorAll<HTMLElement>('button, a[href], [role="button"]'),
    );

    // Exclude nested controls inside an already-selected interactive ancestor so
    // only sibling/independent interactive controls are compared pairwise.
    const topLevelControls = candidates.filter((el) => {
      let parent = el.parentElement;
      while (parent && parent !== header) {
        if (parent.matches('button, a[href], [role="button"]')) {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    });

    const result: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      label: string;
      tagName: string;
    }> = [];

    for (const el of topLevelControls) {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      ) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      // Compute effective visible rect clipped by ancestor overflow containers
      // (e.g. overflow-x-auto horizontal toolbars / overflow-hidden headers)
      // so off-scroll clipped items are not misreported as pixel overlaps while
      // genuine rendered overlaps remain strictly > 0px².
      let left = rect.left;
      let top = rect.top;
      let right = rect.right;
      let bottom = rect.bottom;
      let ancestor = el.parentElement;
      while (ancestor && ancestor !== document.documentElement) {
        const aStyle = window.getComputedStyle(ancestor);
        const clipsX =
          aStyle.overflowX === "hidden" ||
          aStyle.overflowX === "clip" ||
          aStyle.overflowX === "auto" ||
          aStyle.overflowX === "scroll";
        const clipsY =
          aStyle.overflowY === "hidden" ||
          aStyle.overflowY === "clip" ||
          aStyle.overflowY === "auto" ||
          aStyle.overflowY === "scroll";
        if (clipsX || clipsY) {
          const aRect = ancestor.getBoundingClientRect();
          if (clipsX) {
            left = Math.max(left, aRect.left);
            right = Math.min(right, aRect.right);
          }
          if (clipsY) {
            top = Math.max(top, aRect.top);
            bottom = Math.min(bottom, aRect.bottom);
          }
        }
        ancestor = ancestor.parentElement;
      }

      const clippedWidth = right - left;
      const clippedHeight = bottom - top;
      if (clippedWidth <= 0.5 || clippedHeight <= 0.5) {
        continue;
      }

      const label =
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.textContent?.trim().slice(0, 40) ||
        el.tagName;
      result.push({
        x: Math.round(left * 100) / 100,
        y: Math.round(top * 100) / 100,
        width: Math.round(clippedWidth * 100) / 100,
        height: Math.round(clippedHeight * 100) / 100,
        label,
        tagName: el.tagName,
      });
    }
    return result;
  }, headerSelector);
}

// ---------------------------------------------------------------------------
// WCAG 2.1 Color & Contrast Math
// ---------------------------------------------------------------------------

export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export function compositeOverBackground(fg: RgbaColor, bg: RgbaColor): RgbaColor {
  const alpha = Math.max(0, Math.min(1, fg.a));
  return {
    r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
    a: 1,
  };
}

export function relativeLuminance(color: RgbaColor): number {
  const channel = (v: number) => {
    const srgb = v / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(foreground: RgbaColor, background: RgbaColor): number {
  const effectiveFg =
    foreground.a < 1 ? compositeOverBackground(foreground, background) : foreground;
  const l1 = relativeLuminance(effectiveFg);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Verifies that an RGB color clearly belongs to the red danger hue family
 * (red channel dominates green and blue by a meaningful perceptual margin).
 */
export function isRedFamilyColor(color: RgbaColor): boolean {
  return color.r >= 170 && color.r - color.g >= 45 && color.r - color.b >= 45;
}

export function rgbEuclideanDistance(a: RgbaColor, b: RgbaColor): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Resolves CSS custom properties (including oklch(), color-mix(), var(), etc.)
 * into exact 8-bit sRGB RGBA values using the browser's own rendering engine
 * via a 1×1 offscreen canvas + computed style probe.
 */
export async function resolveCssVariablesToRgba(
  page: PlaywrightPage,
  variableNames: ReadonlyArray<string>,
): Promise<Record<string, RgbaColor>> {
  return page.evaluate(
    (vars) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        throw new Error("2D canvas context unavailable in headless Chromium.");
      }

      const probe = document.createElement("div");
      probe.style.position = "fixed";
      probe.style.left = "-9999px";
      probe.style.top = "-9999px";
      probe.style.width = "1px";
      probe.style.height = "1px";
      document.body.appendChild(probe);

      const resolved: Record<string, { r: number; g: number; b: number; a: number }> = {};

      try {
        for (const name of vars) {
          probe.style.backgroundColor = `var(${name})`;
          const computed = window.getComputedStyle(probe).backgroundColor;
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "rgba(0, 0, 0, 0)";
          ctx.fillStyle = computed;
          ctx.fillRect(0, 0, 1, 1);
          const pixel = ctx.getImageData(0, 0, 1, 1).data;
          resolved[name] = {
            r: pixel[0] ?? 0,
            g: pixel[1] ?? 0,
            b: pixel[2] ?? 0,
            a: Math.round(((pixel[3] ?? 255) / 255) * 1000) / 1000,
          };
        }
      } finally {
        probe.remove();
      }

      return resolved;
    },
    [...variableNames],
  );
}

// ---------------------------------------------------------------------------
// Pure DOM Accessibility Audit (replaces @axe-core/playwright when absent)
// ---------------------------------------------------------------------------

export interface UnlabeledFormControl {
  readonly tagName: string;
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly placeholder: string;
}

export async function findUnlabeledVisibleFormControls(
  page: PlaywrightPage,
  rootSelector = "main, form, section, body",
): Promise<Array<UnlabeledFormControl>> {
  return page.evaluate((selector) => {
    const root = document.querySelector<HTMLElement>(selector) ?? document.body;
    const controls = Array.from(
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea',
      ),
    );

    const unlabeled: Array<{
      tagName: string;
      type: string;
      id: string;
      name: string;
      placeholder: string;
    }> = [];

    for (const control of controls) {
      const style = window.getComputedStyle(control);
      const rect = control.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        rect.width === 0 ||
        rect.height === 0 ||
        control.getAttribute("aria-hidden") === "true"
      ) {
        continue;
      }

      const hasAriaLabel = Boolean(control.getAttribute("aria-label")?.trim());
      const labelledBy = control.getAttribute("aria-labelledby")?.trim();
      const hasAriaLabelledBy = Boolean(
        labelledBy &&
        labelledBy
          .split(/\s+/)
          .some((id) => Boolean(document.getElementById(id)?.textContent?.trim())),
      );
      const hasExplicitLabel = Boolean(
        control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`),
      );
      const hasWrappingLabel = Boolean(control.closest("label"));
      const hasAssociatedLabels = Boolean(
        "labels" in control && control.labels && control.labels.length > 0,
      );

      if (
        !hasAriaLabel &&
        !hasAriaLabelledBy &&
        !hasExplicitLabel &&
        !hasWrappingLabel &&
        !hasAssociatedLabels
      ) {
        unlabeled.push({
          tagName: control.tagName,
          type: control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase(),
          id: control.id,
          name: control.getAttribute("name") ?? "",
          placeholder: control.getAttribute("placeholder") ?? "",
        });
      }
    }

    return unlabeled;
  }, rootSelector);
}
