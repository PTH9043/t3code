import { useEffect, useState } from "react";
import {
  ActivityIcon,
  BotIcon,
  CalendarClockIcon,
  DatabaseIcon,
  FileStackIcon,
  FolderCogIcon,
  ListChecksIcon,
  PlugZapIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";

const SECTIONS = [
  { id: "attention-inbox", label: "확인함", icon: ListChecksIcon },
  { id: "project-status", label: "현황", icon: ActivityIcon },
  { id: "project-runs", label: "AI 작업", icon: ListChecksIcon },
  { id: "project-automation-results", label: "자동 작업 성과", icon: ActivityIcon },
  { id: "project-profiles", label: "프로필", icon: SparklesIcon },
  { id: "project-tools", label: "MCP 도구", icon: PlugZapIcon },
  { id: "extensions", label: "스킬·플러그인", icon: PlugZapIcon },
  { id: "project-memory", label: "RAG·메모리", icon: DatabaseIcon },
  { id: "project-automation", label: "자동화", icon: CalendarClockIcon },
  { id: "completion-checks", label: "자동 검증", icon: ListChecksIcon },
  { id: "conversation-transfer", label: "CLI 대화", icon: FileStackIcon },
  { id: "project-programs", label: "프로그램·장애", icon: FolderCogIcon },
  { id: "project-monitoring", label: "모니터링", icon: ActivityIcon },
  { id: "project-terminals", label: "터미널", icon: TerminalIcon },
  { id: "project-accounts", label: "AI 계정", icon: BotIcon },
  { id: "project-knowledge", label: "지식", icon: FileStackIcon },
] as const;

export function WorkspaceSectionNav() {
  const [active, setActive] = useState<string>("project-status");
  useEffect(() => {
    const readHash = () => {
      const id = window.location.hash.slice(1);
      setActive(SECTIONS.some((section) => section.id === id) ? id : "project-status");
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);
  return (
    <nav
      aria-label="프로젝트 내부 영역"
      className="sticky top-0 z-10 flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 shadow-sm"
    >
      {SECTIONS.map(({ id, label, icon: Icon }) => (
        <a
          key={id}
          href={`#${id}`}
          aria-current={active === id ? "location" : undefined}
          onClick={() => setActive(id)}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
        >
          <Icon className="size-3.5" />
          {label}
        </a>
      ))}
    </nav>
  );
}
