import {
  ActivityIcon,
  BotIcon,
  CalendarClockIcon,
  DatabaseIcon,
  FileStackIcon,
  FolderCogIcon,
  ListChecksIcon,
  PlugZapIcon,
  RadarIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";

export type ControlCenterDomainId =
  | "home"
  | "execution"
  | "tools-knowledge"
  | "automation-verify"
  | "infra-accounts";

export type ControlCenterSectionId =
  | "mission-control"
  | "project-status"
  | "attention-inbox"
  | "project-runs"
  | "project-automation-results"
  | "project-profiles"
  | "conversation-transfer"
  | "project-memory"
  | "project-knowledge"
  | "project-tools"
  | "extensions"
  | "project-automation"
  | "completion-checks"
  | "project-accounts"
  | "project-programs"
  | "project-monitoring"
  | "project-terminals";

export interface ControlCenterSectionDef {
  readonly id: ControlCenterSectionId;
  readonly domain: ControlCenterDomainId;
  readonly label: string;
  readonly icon: LucideIcon;
}

export interface ControlCenterDomainDef {
  readonly id: ControlCenterDomainId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly sections: ReadonlyArray<ControlCenterSectionDef>;
}

export const CONTROL_CENTER_DOMAINS: ReadonlyArray<ControlCenterDomainDef> = [
  {
    id: "home",
    label: "운영 홈",
    icon: ActivityIcon,
    sections: [
      { id: "mission-control", domain: "home", label: "자율 운영실", icon: RadarIcon },
      { id: "project-status", domain: "home", label: "운영 현황", icon: ActivityIcon },
      { id: "attention-inbox", domain: "home", label: "확인함", icon: ListChecksIcon },
    ],
  },
  {
    id: "execution",
    label: "에이전트 실행",
    icon: BotIcon,
    sections: [
      { id: "project-runs", domain: "execution", label: "AI 작업", icon: ListChecksIcon },
      {
        id: "project-automation-results",
        domain: "execution",
        label: "자동 작업 성과",
        icon: ActivityIcon,
      },
      { id: "project-profiles", domain: "execution", label: "프로필", icon: SparklesIcon },
      { id: "conversation-transfer", domain: "execution", label: "CLI 대화", icon: FileStackIcon },
    ],
  },
  {
    id: "tools-knowledge",
    label: "도구 & 지식",
    icon: DatabaseIcon,
    sections: [
      { id: "project-memory", domain: "tools-knowledge", label: "RAG·메모리", icon: DatabaseIcon },
      { id: "project-knowledge", domain: "tools-knowledge", label: "지식", icon: FileStackIcon },
      { id: "project-tools", domain: "tools-knowledge", label: "MCP 도구", icon: PlugZapIcon },
      { id: "extensions", domain: "tools-knowledge", label: "스킬·플러그인", icon: PlugZapIcon },
    ],
  },
  {
    id: "automation-verify",
    label: "자동화 & 검증",
    icon: ShieldCheckIcon,
    sections: [
      {
        id: "project-automation",
        domain: "automation-verify",
        label: "무인 스케줄",
        icon: CalendarClockIcon,
      },
      {
        id: "completion-checks",
        domain: "automation-verify",
        label: "완료 자동 검증",
        icon: ShieldCheckIcon,
      },
    ],
  },
  {
    id: "infra-accounts",
    label: "인프라 & 계정",
    icon: ServerIcon,
    sections: [
      { id: "project-accounts", domain: "infra-accounts", label: "AI 계정", icon: BotIcon },
      {
        id: "project-programs",
        domain: "infra-accounts",
        label: "프로그램·장애",
        icon: FolderCogIcon,
      },
      { id: "project-monitoring", domain: "infra-accounts", label: "모니터링", icon: ActivityIcon },
      { id: "project-terminals", domain: "infra-accounts", label: "터미널", icon: TerminalIcon },
    ],
  },
] as const;

export const DEFAULT_CONTROL_CENTER_DOMAIN: ControlCenterDomainId = "home";
export const DEFAULT_CONTROL_CENTER_SECTION: ControlCenterSectionId = "project-status";

const DOMAIN_MAP = new Map<ControlCenterDomainId, ControlCenterDomainDef>(
  CONTROL_CENTER_DOMAINS.map((domain) => [domain.id, domain]),
);

const SECTION_MAP = new Map<ControlCenterSectionId, ControlCenterSectionDef>(
  CONTROL_CENTER_DOMAINS.flatMap((domain) =>
    domain.sections.map((section) => [section.id, section] as const),
  ),
);

export function isControlCenterDomainId(value: unknown): value is ControlCenterDomainId {
  return typeof value === "string" && DOMAIN_MAP.has(value as ControlCenterDomainId);
}

export function isControlCenterSectionId(value: unknown): value is ControlCenterSectionId {
  return typeof value === "string" && SECTION_MAP.has(value as ControlCenterSectionId);
}

export function getControlCenterDomain(domainId: ControlCenterDomainId): ControlCenterDomainDef {
  return DOMAIN_MAP.get(domainId) ?? CONTROL_CENTER_DOMAINS[0]!;
}

export function getControlCenterSection(
  sectionId: ControlCenterSectionId,
): ControlCenterSectionDef {
  return SECTION_MAP.get(sectionId) ?? CONTROL_CENTER_DOMAINS[0]!.sections[0]!;
}

export function defaultSectionForDomain(domainId: ControlCenterDomainId): ControlCenterSectionId {
  return getControlCenterDomain(domainId).sections[0]!.id;
}

export function resolveControlCenterTabSearch(search: Record<string, unknown>): {
  domain?: ControlCenterDomainId;
  section?: ControlCenterSectionId;
} {
  if (isControlCenterSectionId(search.section)) {
    const sectionDef = getControlCenterSection(search.section);
    return { domain: sectionDef.domain, section: sectionDef.id };
  }
  if (isControlCenterDomainId(search.domain)) {
    return {
      domain: search.domain,
      section: defaultSectionForDomain(search.domain),
    };
  }
  return {};
}

export function resolveControlCenterTabState(input: {
  readonly domain?: unknown;
  readonly section?: unknown;
  readonly hash?: string | null | undefined;
  readonly knowledgeRun?: string | null | undefined;
}): {
  readonly domain: ControlCenterDomainId;
  readonly section: ControlCenterSectionId;
} {
  if (isControlCenterSectionId(input.section)) {
    const def = getControlCenterSection(input.section);
    return { domain: def.domain, section: def.id };
  }
  if (isControlCenterDomainId(input.domain)) {
    return { domain: input.domain, section: defaultSectionForDomain(input.domain) };
  }
  const normalizedHash = (input.hash ?? "").replace(/^#/, "");
  if (isControlCenterSectionId(normalizedHash)) {
    const def = getControlCenterSection(normalizedHash);
    return { domain: def.domain, section: def.id };
  }
  if (input.knowledgeRun) {
    return { domain: "execution", section: "project-runs" };
  }
  return {
    domain: DEFAULT_CONTROL_CENTER_DOMAIN,
    section: DEFAULT_CONTROL_CENTER_SECTION,
  };
}

export function WorkspaceSectionNav({
  activeDomain,
  activeSection,
  onSelectDomain,
  onSelectSection,
}: {
  readonly activeDomain: ControlCenterDomainId;
  readonly activeSection: ControlCenterSectionId;
  readonly onSelectDomain: (domain: ControlCenterDomainId) => void;
  readonly onSelectSection: (section: ControlCenterSectionId) => void;
}) {
  const currentDomain = getControlCenterDomain(activeDomain);

  return (
    <div
      className="sticky top-0 z-10 grid gap-2 rounded-xl border border-border bg-card/95 p-2 shadow-sm backdrop-blur-xs"
      data-control-center-nav
    >
      <div
        role="tablist"
        aria-label="프로젝트 제어센터 도메인"
        className="flex gap-1 overflow-x-auto border-b border-border/60 pb-2"
      >
        {CONTROL_CENTER_DOMAINS.map((domain) => {
          const Icon = domain.icon;
          const isSelected = domain.id === activeDomain;
          return (
            <button
              key={domain.id}
              id={`cc-domain-tab-${domain.id}`}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={`cc-tabpanel-${activeSection}`}
              onClick={() => onSelectDomain(domain.id)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isSelected
                  ? "bg-primary/12 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className="size-3.5" aria-hidden />
              {domain.label}
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {domain.sections.length}
              </span>
            </button>
          );
        })}
      </div>

      <div
        role="tablist"
        aria-label={`${currentDomain.label} 하위 항목`}
        className="flex flex-wrap gap-1.5"
      >
        {currentDomain.sections.map((section) => {
          const Icon = section.icon;
          const isSelected = section.id === activeSection;
          return (
            <button
              key={section.id}
              id={`cc-section-tab-${section.id}`}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={`cc-tabpanel-${section.id}`}
              onClick={() => onSelectSection(section.id)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isSelected
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/70 bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className="size-3.5" aria-hidden />
              {section.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
