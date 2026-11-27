import { EnvironmentId, ProjectId, type WorkspaceRuntimeEvidence } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CONTROL_CENTER_DOMAINS,
  DEFAULT_CONTROL_CENTER_DOMAIN,
  DEFAULT_CONTROL_CENTER_SECTION,
  WorkspaceSectionNav,
  resolveControlCenterTabSearch,
  resolveControlCenterTabState,
} from "./WorkspaceSectionNav";
import {
  buildRuntimeKpiCards,
  selectRuntimeEvidenceSummary,
  WorkspaceControlCenter,
} from "./WorkspaceControlCenter";
import {
  CompletionAutomationSection,
  DEFAULT_COMPLETION_MAX_AUTO_REPAIRS,
  DEFAULT_COMPLETION_TIMEOUT_SECONDS,
} from "./CompletionAutomationSection";
import { shouldRenderJasnaSection } from "./JasnaSection";

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  match: null as {
    params: { environmentId: string; projectId: string };
    search: { domain?: string; section?: string; knowledgeRun?: string };
  } | null,
  hash: "",
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => routerMocks.navigate,
  useMatch: () => routerMocks.match,
  useLocation: (opts?: { select?: (loc: { hash: string }) => unknown }) =>
    opts?.select ? opts.select({ hash: routerMocks.hash }) : { hash: routerMocks.hash },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: "Success", value: {} })),
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () => new Map(),
  useThreadShells: () => [],
  useProjects: () => [],
  useListedThreadShells: () => [],
  useThreadActivities: () => [],
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({}),
}));

const sampleProject = {
  environmentId: EnvironmentId.make("env-local"),
  id: ProjectId.make("proj-alpha"),
  title: "Alpha Project",
  workspaceRoot: "D:/workspace/alpha",
  scripts: [],
  workspaceControl: null,
} as unknown as Parameters<typeof WorkspaceControlCenter>[0]["project"];

beforeEach(() => {
  routerMocks.navigate.mockReset();
  routerMocks.match = {
    params: { environmentId: "env-local", projectId: "proj-alpha" },
    search: {},
  };
  routerMocks.hash = "";
});

describe("Control Center 5-domain routing & single-panel mount (ERR-02, ERR-03, ERR-13, ERR-14)", () => {
  it("groups all 18 sections (16 legacy + mission-control + drive-backup) into exactly 5 top-level domains without loss", () => {
    expect(CONTROL_CENTER_DOMAINS.map((domain) => domain.label)).toEqual([
      "운영 홈",
      "에이전트 실행",
      "도구 & 지식",
      "자동화 & 검증",
      "인프라 & 계정",
    ]);
    const allSections = CONTROL_CENTER_DOMAINS.flatMap((domain) => domain.sections);
    expect(allSections).toHaveLength(18);
    expect(new Set(allSections.map((section) => section.id)).size).toBe(18);
    expect(allSections.some((section) => section.id === "mission-control")).toBe(true);
    expect(allSections.some((section) => section.id === "drive-backup")).toBe(true);
  });

  it("resolves search params, legacy hashes, and knowledgeRun into valid domain/section pairs", () => {
    expect(resolveControlCenterTabSearch({ section: "drive-backup" })).toEqual({
      domain: "infra-accounts",
      section: "drive-backup",
    });
    expect(resolveControlCenterTabSearch({ section: "project-terminals" })).toEqual({
      domain: "infra-accounts",
      section: "project-terminals",
    });
    expect(resolveControlCenterTabSearch({ domain: "automation-verify" })).toEqual({
      domain: "automation-verify",
      section: "project-automation",
    });
    expect(resolveControlCenterTabSearch({ domain: "invalid", section: "nope" })).toEqual({});

    expect(resolveControlCenterTabState({ hash: "#project-memory" })).toEqual({
      domain: "tools-knowledge",
      section: "project-memory",
    });
    expect(resolveControlCenterTabState({ knowledgeRun: "run-123" })).toEqual({
      domain: "execution",
      section: "project-runs",
    });
    expect(resolveControlCenterTabState({})).toEqual({
      domain: DEFAULT_CONTROL_CENTER_DOMAIN,
      section: DEFAULT_CONTROL_CENTER_SECTION,
    });
  });

  it("mounts only the active section panel so terminal and memory sections do not render together (ERR-14)", () => {
    const homeHtml = renderToStaticMarkup(
      createElement(WorkspaceControlCenter, { project: sampleProject }),
    );
    expect(homeHtml).toContain('role="tabpanel"');
    expect(homeHtml).toContain('data-active-domain="home"');
    expect(homeHtml).toContain('data-active-section="project-status"');
    expect(homeHtml).toContain("프로젝트 운영 상태");
    expect(homeHtml).not.toContain("프로젝트 터미널");
    expect(homeHtml).not.toContain("격리 경계와 물리 장기기억 위치");
    expect(homeHtml).not.toContain('href="#project-runs"');

    routerMocks.match = {
      params: { environmentId: "env-local", projectId: "proj-alpha" },
      search: { domain: "infra-accounts", section: "project-terminals" },
    };
    const terminalsHtml = renderToStaticMarkup(
      createElement(WorkspaceControlCenter, { project: sampleProject }),
    );
    expect(terminalsHtml).toContain('data-active-domain="infra-accounts"');
    expect(terminalsHtml).toContain('data-active-section="project-terminals"');
    expect(terminalsHtml).toContain("프로젝트 터미널");
    expect(terminalsHtml).not.toContain("격리 경계와 물리 장기기억 위치");
  });

  it("renders two-tier tablist navigation without bare hash anchor links", () => {
    const navHtml = renderToStaticMarkup(
      createElement(WorkspaceSectionNav, {
        activeDomain: "tools-knowledge",
        activeSection: "project-memory",
        onSelectDomain: vi.fn(),
        onSelectSection: vi.fn(),
      }),
    );
    expect(navHtml).toContain('role="tablist"');
    expect(navHtml).toContain('aria-selected="true"');
    expect(navHtml).toContain("도구 &amp; 지식");
    expect(navHtml).toContain("RAG·메모리");
    expect(navHtml).not.toContain('href="#');
  });
});

describe("Control Center KPI grid, evidence count parity, C11 safety, Jasna hiding (ERR-44, ERR-45, ERR-28)", () => {
  it("consolidates 9 runtime counters into 5 balanced KPI cards without orphan rows (ERR-44)", () => {
    const cards = buildRuntimeKpiCards({
      workingThreadCount: 2,
      blockedThreadCount: 1,
      failedThreadCount: 2,
      completedUnseenCount: 3,
      activeProgramCount: 4,
      unhealthyProgramCount: 1,
      openIncidentCount: 1,
      activeCollaborationCount: 1,
      enabledScheduleCount: 2,
    });
    expect(cards).toHaveLength(5);
    expect(cards.map((card) => [card.id, card.value])).toEqual([
      ["active-work", 3],
      ["attention-needed", 4],
      ["completed-unseen", 3],
      ["programs", 4],
      ["schedules", 2],
    ]);
  });

  it("derives evidence attention count directly from the rendered evidence list (ERR-45)", () => {
    const evidence: WorkspaceRuntimeEvidence[] = [
      {
        source: "thread",
        sourceId: "t1",
        authority: "provider",
        status: "working",
        title: "작업 중",
        detail: null,
        observedAt: "2026-11-21T00:00:00.000Z",
      },
      {
        source: "incident",
        sourceId: "i1",
        authority: "program-supervisor",
        status: "failed",
        title: "프로세스 오류",
        detail: "exit 1",
        observedAt: "2026-11-21T00:01:00.000Z",
      },
      {
        source: "thread",
        sourceId: "t2",
        authority: "provider",
        status: "blocked",
        title: "승인 대기",
        detail: null,
        observedAt: "2026-11-21T00:02:00.000Z",
      },
    ];
    const summary = selectRuntimeEvidenceSummary(evidence);
    expect(summary.totalCount).toBe(3);
    expect(summary.visibleItems).toHaveLength(3);
    expect(summary.attentionCount).toBe(2);
    expect(summary.visibleAttentionCount).toBe(2);

    const emptySummary = selectRuntimeEvidenceSummary([]);
    expect(emptySummary.attentionCount).toBe(0);
    expect(emptySummary.visibleItems).toHaveLength(0);
  });

  it("renders C11 completion automation safety limits (default 3 retries / 120s timeout)", () => {
    const html = renderToStaticMarkup(
      createElement(CompletionAutomationSection, { project: sampleProject }),
    );
    expect(DEFAULT_COMPLETION_MAX_AUTO_REPAIRS).toBe(3);
    expect(DEFAULT_COMPLETION_TIMEOUT_SECONDS).toBe(120);
    expect(html).toContain("최대 자동 보정 횟수 (기본 3회)");
    expect(html).toContain("명령별 실행 타임아웃 · 초 (기본 120초)");
  });

  it("hides Jasna section by default on web or unconfigured desktop installs (ERR-28)", () => {
    const mockBridge = {} as Parameters<typeof shouldRenderJasnaSection>[0];
    expect(shouldRenderJasnaSection(undefined, null)).toBe(false);
    expect(shouldRenderJasnaSection(undefined, null, true)).toBe(false);
    expect(shouldRenderJasnaSection(mockBridge, null)).toBe(false);
    expect(
      shouldRenderJasnaSection(mockBridge, {
        executablePath: null,
        inputPath: null,
        outputPath: null,
        jobs: [],
      }),
    ).toBe(false);
    expect(
      shouldRenderJasnaSection(mockBridge, {
        executablePath: "C:/jasna/jasna.exe",
        inputPath: null,
        outputPath: null,
        jobs: [],
      }),
    ).toBe(true);
    expect(shouldRenderJasnaSection(mockBridge, null, true)).toBe(true);
  });
});
