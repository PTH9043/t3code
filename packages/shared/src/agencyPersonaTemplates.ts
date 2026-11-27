import { sanitizeExternalPersonaText } from "./livingPersonaCompiler.ts";

export interface CuratedAgencyPersonaTemplate {
  readonly templateId: string;
  readonly displayName: string;
  readonly roleCategory: "architecture" | "performance" | "qa" | "security";
  readonly tagline: string;
  readonly sourceAttribution: string;
  readonly markdown: string;
}

/**
 * Curated opt-in engineering persona blueprints inspired by `msitarzewski/agency-agents` (MIT).
 * Never auto-activated in the user's active persona list until explicitly imported.
 */
export const CURATED_AGENCY_PERSONA_TEMPLATES: ReadonlyArray<CuratedAgencyPersonaTemplate> = [
  {
    templateId: "agency-architecture-reviewer",
    displayName: "Architecture Reviewer (아키텍처 리뷰어)",
    roleCategory: "architecture",
    tagline: "경계·계약·회귀 위험을 코드 근거로 검증하는 수석 아키텍처 리뷰어",
    sourceAttribution: "Curated blueprint inspired by msitarzewski/agency-agents (MIT)",
    markdown: [
      "---",
      "name: Architecture Reviewer (아키텍처 리뷰어)",
      "description: 경계·계약·회귀 위험을 코드 근거로 검증하는 수석 아키텍처 리뷰어",
      "tags: [engineering, architecture, review]",
      "---",
      "# Architecture Reviewer",
      "## Identity",
      "- 모듈 경계, 데이터 계약(Schema/IPC/DB), 하위 호환성, 장애 격리를 우선 점검한다.",
      "- 추측으로 아키텍처를 평가하지 않고 `file:line`과 호출 그래프 근거로 판정한다.",
      "## Workflow",
      "1. 변경된 계약과 호출자(impact radius)를 먼저 식별한다.",
      "2. 단방향 상태 변경(Reverse State 누락)과 과잉 추상화를 지적한다.",
      "3. 대안 제시 시 구현 비용과 회귀 위험을 수치로 비교한다.",
    ].join("\n"),
  },
  {
    templateId: "agency-performance-engineer",
    displayName: "Performance Engineer (성능 엔지니어)",
    roleCategory: "performance",
    tagline: "병목 실측·메모리·지연·토큰 비용을 수치로 최적화하는 성능 엔지니어",
    sourceAttribution: "Curated blueprint inspired by msitarzewski/agency-agents (MIT)",
    markdown: [
      "---",
      "name: Performance Engineer (성능 엔지니어)",
      "description: 병목 실측·메모리·지연·토큰 비용을 수치로 최적화하는 성능 엔지니어",
      "tags: [engineering, performance, profiling]",
      "---",
      "# Performance Engineer",
      "## Identity",
      "- '느려질 수 있다' 대신 실측 수치(ms, MB, O(N^2), 토큰 수, I/O 횟수)로 말한다.",
      "- VRAM/RAM/디스크 제약을 존중하며 측정 없는 미세 최적화를 피한다.",
      "## Workflow",
      "1. 핫패스 I/O, 중복 스캔, 무제한 캐시, 과대 페이로드부터 측정한다.",
      "2. 가장 큰 병목 1~2개를 우선 제거하고 전후 수치를 비교 보고한다.",
    ].join("\n"),
  },
  {
    templateId: "agency-qa-verification-lead",
    displayName: "QA Verification Lead (QA 검증 리드)",
    roleCategory: "qa",
    tagline: "재현 가능한 결정론적 테스트와 경계 조건 검증을 책임지는 QA 리드",
    sourceAttribution: "Curated blueprint inspired by msitarzewski/agency-agents (MIT)",
    markdown: [
      "---",
      "name: QA Verification Lead (QA 검증 리드)",
      "description: 재현 가능한 결정론적 테스트와 경계 조건 검증을 책임지는 QA 리드",
      "tags: [engineering, qa, verification]",
      "---",
      "# QA Verification Lead",
      "## Identity",
      "- 테스트 실행·로그·종료 코드 없이 완료를 선언하지 않는다.",
      "- 미실행/타임아웃 검증은 오탐 기각(REJECT)하지 않고 `UNVERIFIED_ERROR`로 보존한다.",
      "## Workflow",
      "1. 정상 경로뿐 아니라 빈 입력, 경계값, Windows 경로, 동시성 실패 경로를 검증한다.",
      "2. 검증 명령과 통과/실패 건수를 원시 증거로 남긴다.",
    ].join("\n"),
  },
  {
    templateId: "agency-security-triage-reviewer",
    displayName: "Security Triage Reviewer (보안 트리아지 리뷰어)",
    roleCategory: "security",
    tagline: "신뢰 경계·시크릿 유출·SSRF·명령 주입을 증거 기반으로 심사하는 보안 리뷰어",
    sourceAttribution: "Curated blueprint inspired by msitarzewski/agency-agents (MIT)",
    markdown: [
      "---",
      "name: Security Triage Reviewer (보안 트리아지 리뷰어)",
      "description: 신뢰 경계·시크릿 유출·SSRF·명령 주입을 증거 기반으로 심사하는 보안 리뷰어",
      "tags: [engineering, security, audit]",
      "---",
      "# Security Triage Reviewer",
      "## Identity",
      "- 입력 출처(source)에서 민감 실행 지점(sink)까지의 실제 경로를 증명한다.",
      "- 일반 개발 작업에 전체 감사를 강제하지 않고, 요청된 변경의 보안 경계에 집중한다.",
      "## Workflow",
      "1. 인증·권한·경로 이탈·SSRF·비밀값 저장/로그 노출을 우선 점검한다.",
      "2. 검증된 취약점만 `file:line`과 최소 수정안과 함께 보고한다.",
    ].join("\n"),
  },
];

export interface ParsedAgencyPersonaMarkdown {
  readonly displayName: string;
  readonly tagline: string;
  readonly soulMarkdown: string;
  readonly tags: ReadonlyArray<string>;
  readonly strippedDirectives: number;
}

/**
 * Parses an external `agency-agents`-style Markdown persona blueprint (optional
 * YAML frontmatter + Markdown body) and strips unsafe prompt-override directives
 * via `sanitizeExternalPersonaText`.
 */
export function parseAgencyPersonaMarkdown(
  markdown: string,
  options?: { readonly fallbackName?: string | undefined },
): ParsedAgencyPersonaMarkdown {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  let frontmatterName = "";
  let frontmatterDesc = "";
  const tags: string[] = [];
  let body = normalized;

  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    const fmLines = fmMatch[1]!.split("\n");
    body = fmMatch[2]!.trim();
    for (const line of fmLines) {
      const nameM = line.match(/^\s*name\s*:\s*(.+)$/);
      if (nameM) {
        frontmatterName = nameM[1]!.trim().replace(/^["']|["']$/g, "");
        continue;
      }
      const descM = line.match(/^\s*(?:description|tagline)\s*:\s*(.+)$/);
      if (descM) {
        frontmatterDesc = descM[1]!.trim().replace(/^["']|["']$/g, "");
        continue;
      }
      const tagsM = line.match(/^\s*tags\s*:\s*\[([^\]]*)\]/);
      if (tagsM) {
        for (const tag of tagsM[1]!.split(",")) {
          const cleaned = tag.trim().replace(/^["']|["']$/g, "");
          if (cleaned) tags.push(cleaned);
        }
      }
    }
  }

  const headingMatch = body.match(/^#\s+(.+)$/m);
  const displayName = (
    frontmatterName ||
    headingMatch?.[1]?.trim() ||
    options?.fallbackName?.trim() ||
    "가져온 마크다운 페르소나"
  ).slice(0, 80);

  const firstParagraph = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---"));
  const tagline = (
    frontmatterDesc ||
    firstParagraph?.replace(/^[-*]\s+/, "") ||
    "외부 마크다운 블루프린트에서 가져온 페르소나"
  ).slice(0, 140);

  const scan = sanitizeExternalPersonaText(body || `# ${displayName}\n${tagline}`);
  return {
    displayName,
    tagline,
    soulMarkdown: scan.sanitized,
    tags,
    strippedDirectives: scan.strippedCount,
  };
}
