export const AI_HELP_UPDATED_AT = "2026-10-15";
const AI_HELP_REFERENCE_CHECKED_AT = "2026-10-12";
export const AI_HELP_CHANNEL = "t3-ai-help";

export const AI_HELP_PROMPTS = [
  {
    title: "기능 추가 → 테스트 → 적용",
    text: "목표: [원하는 기능과 실제 사용 상황]\n범위: [프로젝트·파일·화면]\n제약: 기존 데이터와 진행 중인 변경을 보존해줘. Windows 명령은 CMD로 실행해줘.\n완료 기준: 개발본에 구현하고 관련 테스트를 통과시킨 뒤 운영본에 적용해줘. 변경 내용, 검증 결과, 남은 문제를 알려줘.",
  },
  {
    title: "오류의 원인을 찾아 수정",
    text: "[이 동작]을 하면 [오류]가 발생해.\n재현 순서: [1 → 2 → 3]\n기대 결과: [정상 동작]\n오류 메시지·관련 로그: [원문]\n원인을 확인하고 최소 범위로 수정해줘. 같은 오류가 재발하지 않는지 관련 테스트로 검증해줘.",
  },
  {
    title: "긴 작업을 이어갈 인수인계",
    text: "현재 목표, 완료한 변경, 수정 파일, 실행 중인 서버의 PID·포트·데이터 위치, 통과한 검증, 남은 작업을 정리해줘. 다음 대화에서 그대로 이어갈 수 있게 써줘. 토큰·인증 정보는 제외해줘.",
  },
  {
    title: "스킬을 골라서 사용",
    text: "목표는 [작업]이고 결과물은 [파일 형식 또는 화면]이야. 현재 세션에서 사용할 수 있는 스킬과 도구를 확인하고 가장 적합한 것을 사용해줘. 추가 설치가 필요하면 설치 전 현재 가능한 방법과 필요한 조건을 설명해줘.",
  },
  {
    title: "공식 문서와 X 조사",
    text: "[주제]를 조사해줘. 공식 문서·저장소로 기능과 사용법을 확인하고, Grok CLI의 X 검색을 사용할 수 있으면 최근 사용자 사례도 찾아줘. 게시 날짜와 링크를 남기고, 확인된 사실·사용자 경험·추론을 구분해줘.",
  },
  {
    title: "변경 코드 검토",
    text: "현재 변경 사항을 검토해줘. 실제 버그, 성능 저하, 웹·데스크톱·모바일 누락을 우선 확인해줘. 각 문제에 근거와 파일 위치를 적고, 확실한 문제를 수정한 뒤 관련 범위만 검증해줘.",
  },
  {
    title: "문서·표·발표자료 제작",
    text: "[자료·파일]을 바탕으로 [독자]가 사용할 [DOCX / PDF / XLSX / PPTX]를 만들어줘. 목적은 [목적], 분량은 [분량]이야. 해당 스킬을 사용하고 레이아웃이나 수식도 검증한 뒤 완성 파일을 제공해줘.",
  },
  {
    title: "화면 개선을 맡기기",
    text: "[화면]에서 [불편한 점]을 개선해줘. 현재 디자인과 기능을 확인하고 모바일에서도 읽기 쉽게 구현해줘. 기존 기능을 유지하고 렌더링 비용을 늘리지 않도록 해줘. 변경 전후와 검증 결과를 알려줘.",
  },
  {
    title: "반복 업무를 자동으로 맡기기",
    text: "프로젝트에서 [반복할 업무]를 자동 처리하고 싶어. 자동 업무 접수함에 저장할 양식 초안을 작성해줘. 입력 항목, 지시문, AI 호출 전 변화 확인, 실행 프로필, 검증 명령과 산출물 조건, 예약 주기를 정리해줘. 단순 처리는 AI 없이 명령 실행을 쓰고, 변화가 없으면 AI 호출을 생략하도록 설계해줘. 결과가 불확실한 작업을 다시 수행하기 전에 무엇을 확인할지도 적어줘.",
  },
] as const;

export const AI_HELP_SKILLS = [
  [
    "openai-docs",
    "개발",
    "Codex·ChatGPT·OpenAI API의 공식 문서와 설정을 확인합니다.",
    "Codex 설정과 지원 명령을 공식 문서로 확인해줘.",
  ],
  [
    "skill-creator",
    "개발",
    "반복 작업을 재사용할 SKILL.md로 만듭니다.",
    "우리 프로젝트의 배포 점검을 재사용 가능한 스킬로 만들어줘.",
  ],
  [
    "skill-installer",
    "개발",
    "공식 목록이나 GitHub 경로에서 스킬을 설치합니다.",
    "이 저장소의 스킬을 검토하고 이 프로젝트에 설치해줘.",
  ],
  [
    "test-t3-app",
    "개발",
    "격리된 T3 개발 환경에서 웹 동작과 페어링을 검증합니다.",
    "개발 데이터로 T3 웹 기능을 검증해줘. 브라우저 검증도 허용할게.",
  ],
  [
    "test-t3-mobile",
    "개발",
    "T3 모바일을 에뮬레이터·시뮬레이터와 개발 서버로 검증합니다.",
    "연결된 Android 에뮬레이터에서 모바일 변경을 검증해줘.",
  ],
  [
    "ios-debugger-agent",
    "개발",
    "macOS와 XcodeBuildMCP로 iOS 빌드·로그·UI를 확인합니다.",
    "macOS의 iOS 시뮬레이터에서 이 오류를 재현해줘.",
  ],
  [
    "ios-simulator-browser",
    "개발",
    "Apple Silicon macOS에서 iOS 시뮬레이터 화면을 스트리밍합니다.",
    "시뮬레이터 검증 화면을 브라우저로 볼 수 있게 해줘.",
  ],
  [
    "plugin-management:plugin-management",
    "연결",
    "작업에 필요한 플러그인과 연결·권한·의존성을 확인합니다.",
    "이 작업을 할 수 있는 플러그인을 찾고 필요한 연결을 설명해줘.",
  ],
  [
    "computer-use:computer-use",
    "연결",
    "지원되는 앱과 브라우저의 실제 화면을 조작합니다.",
    "브라우저를 직접 조작해서 이 화면의 동작을 검증해줘.",
  ],
  [
    "documents:documents",
    "문서",
    "Word·DOCX를 작성·수정하고 렌더링으로 배치를 검증합니다.",
    "이 초안을 3쪽 분량의 DOCX 보고서로 만들어줘.",
  ],
  [
    "pdf:pdf",
    "문서",
    "PDF를 읽고 생성하며 페이지 배치·양식을 확인합니다.",
    "이 PDF의 표를 추출하고 요약 PDF도 만들어줘.",
  ],
  [
    "presentations:Presentations",
    "문서",
    "PowerPoint와 Google Slides 발표자료를 만듭니다.",
    "이 자료로 경영진용 8장 발표자료를 만들어줘.",
  ],
  [
    "spreadsheets:Spreadsheets",
    "문서",
    "XLSX·CSV·Google Sheets의 수식·표·차트를 다룹니다.",
    "이 CSV를 분석하고 수식과 차트가 있는 XLSX로 만들어줘.",
  ],
  [
    "spreadsheets:excel-live-control",
    "연결",
    "연결된 Excel의 열려 있는 통합문서를 직접 조작합니다.",
    "연결된 Excel에서 이 표에 합계 수식과 서식을 적용해줘.",
  ],
  [
    "template-creator:template-creator",
    "문서",
    "참고 결과물을 개인용 재사용 템플릿 스킬로 만듭니다.",
    "이 보고서를 매달 재사용할 템플릿 스킬로 만들어줘.",
  ],
  [
    "pages:write-page",
    "문서",
    "요청한 ChatGPT Page·Space 내용을 작성·편집합니다.",
    "이 내용을 현재 Space의 도움말 페이지로 저장해줘.",
  ],
  [
    "pages:maintain-space",
    "문서",
    "새 자료를 기존 Page·Space에 반영합니다.",
    "이 새 자료를 기존 조사 페이지에 반영해줘.",
  ],
  [
    "pages:organize-space",
    "문서",
    "기존 Page·Space의 구조를 정리합니다.",
    "이 Space의 페이지들을 주제별로 정리해줘.",
  ],
  [
    "pages:manage-schedules",
    "문서",
    "Space 페이지에 필요한 반복 작업을 설정·관리합니다.",
    "이 페이지의 업데이트를 매주 월요일에 실행하도록 예약해줘.",
  ],
  [
    "sites:sites",
    "디자인",
    "웹사이트·대시보드·도구를 제작·수정하고 Sites 호스팅을 관리합니다.",
    "프로젝트 현황을 보는 대시보드 사이트를 만들어줘.",
  ],
  [
    "imagegen",
    "디자인",
    "사진·일러스트·텍스처·투명 배경 이미지 등 비트맵을 생성·편집합니다.",
    "투명 배경의 앱 소개용 일러스트를 만들어줘.",
  ],
  [
    "visualize:visualize",
    "디자인",
    "대화 안에서 비교·설명·시뮬레이션을 위한 시각화를 만듭니다.",
    "이 두 운영 방식의 차이를 조작 가능한 시각화로 보여줘.",
  ],
  [
    "work-pets:create-pet",
    "디자인",
    "ChatGPT Work에서 사용할 애니메이션 펫을 만듭니다.",
    "ChatGPT Work에서 사용할 작은 로봇 펫을 만들어줘.",
  ],
  [
    "work-pets:pets",
    "디자인",
    "ChatGPT Work 펫을 조회·선택·다운로드·삭제합니다.",
    "현재 ChatGPT Work 펫 목록을 보여줘.",
  ],
  [
    "work-pets:update-pet",
    "디자인",
    "기존 ChatGPT Work 펫의 이름·동작·스프라이트를 수정합니다.",
    "이 Work 펫의 달리기 동작을 수정해줘.",
  ],
] as const;

export const AI_HELP_DOWNLOADED_SKILLS = [
  [
    "systematic-debugging",
    "로그·재현·원인 가설을 순서대로 확인하는 디버깅 절차",
    "https://github.com/obra/superpowers/tree/main/skills/systematic-debugging",
  ],
  [
    "verification-before-completion",
    "완료 보고 전에 실제 검증 결과를 확보하는 절차",
    "https://github.com/obra/superpowers/tree/main/skills/verification-before-completion",
  ],
  [
    "test-driven-development",
    "실패하는 테스트로 동작을 정의하고 수정하는 절차",
    "https://github.com/obra/superpowers/tree/main/skills/test-driven-development",
  ],
  [
    "find-skills",
    "작업에 맞는 추가 스킬을 찾는 절차",
    "https://github.com/vercel-labs/skills/tree/main/skills/find-skills",
  ],
  [
    "vercel-react-best-practices",
    "React 코드의 렌더링·데이터 처리·성능 검토 지침",
    "https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices",
  ],
  [
    "vercel-react-native-skills",
    "React Native·Expo의 목록·애니메이션·네이티브 동작 지침",
    "https://github.com/vercel-labs/agent-skills/tree/main/skills/react-native-skills",
  ],
] as const;

const CODEX_SLASH = [
  ["/status", "현재 세션 설정·토큰 사용 확인"],
  ["/model", "모델과 지원되는 추론 수준 선택"],
  ["/plan", "구현 전 계획 모드로 전환"],
  ["/review", "작업 트리의 변경 코드 검토"],
  ["/compact", "대화를 요약해 문맥 공간 확보"],
  ["/skills", "발견된 스킬 확인·선택"],
  ["/mcp", "설정된 MCP 도구 확인"],
  ["/plugins", "플러그인 탐색·관리"],
  ["/permissions", "세션 권한 설정 확인·조정"],
  ["/init", "프로젝트 AGENTS.md 초안 생성"],
  ["/resume", "저장된 대화 선택·재개"],
  ["/new", "같은 CLI에서 새 대화 시작"],
  ["/exit", "CLI 세션 종료"],
] as const;

const CODEX_CLI = [
  ["codex --help", "설치된 버전의 명령 목록"],
  ["codex --version", "설치 버전 확인"],
  ["codex", "대화형 터미널 시작"],
  ['codex --cd "D:\\__NewAutoUsage"', "프로젝트 경로를 지정해 시작"],
  ['codex exec "이 프로젝트의 구조를 설명해줘"', "비대화형 작업 후 종료"],
  ["codex resume --last", "최근 터미널 대화 재개"],
  ["codex review --uncommitted", "커밋하지 않은 변경 검토"],
  ["codex mcp list", "등록된 MCP 서버 목록"],
  ["codex login status", "로그인 상태 확인"],
  ["codex --search", "실시간 웹 검색을 켜고 시작"],
] as const;

const CLAUDE_SLASH = [
  ["/help", "명령과 사용법 확인"],
  ["/status", "버전·모델·계정·연결 상태 확인"],
  ["/model", "현재 모델 선택"],
  ["/plan", "계획 모드 전환"],
  ["/context", "문맥 사용량과 구성 확인"],
  ["/compact", "대화 요약으로 문맥 공간 확보"],
  ["/cost", "사용량 정보 확인; 결제 방식에 따라 표시가 다름"],
  ["/mcp", "MCP 연결과 도구 관리"],
  ["/permissions", "허용·확인·거부 규칙 관리"],
  ["/memory", "CLAUDE.md 등 메모리 관리"],
  ["/init", "프로젝트 CLAUDE.md 초안 생성"],
  ["/resume", "이전 대화 재개"],
  ["/clear", "현재 문맥을 비우고 새 대화 시작"],
  ["/doctor", "설치·설정 점검; 수정도 수행할 수 있음"],
] as const;

const CLAUDE_CLI = [
  ["claude --help", "설치된 버전의 명령 목록"],
  ["claude --version", "설치 버전 확인"],
  ["claude", "대화형 터미널 시작"],
  ['claude -p "이 프로젝트의 구조를 설명해줘"', "비대화형 요청 후 종료"],
  ["claude -c", "현재 디렉터리의 최근 대화 이어가기"],
  ["claude -r", "이전 대화 선택·재개"],
  ["claude --permission-mode plan", "계획 모드로 시작"],
  ["claude mcp list", "등록된 MCP 서버 목록"],
  ["claude doctor", "터미널에서 읽기 전용 설치·설정 진단"],
] as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function card(title: string, body: string, search = title): string {
  return `<article class="card" data-search="${escapeHtml(search)}"><h3>${escapeHtml(title)}</h3>${body}</article>`;
}

function copyBlock(text: string, label = "복사"): string {
  return `<div class="copy-block"><pre tabindex="0">${escapeHtml(text)}</pre><button type="button" data-copy aria-label="${escapeHtml(label)}">${escapeHtml(label)}</button></div>`;
}

function commandTable(rows: ReadonlyArray<readonly [string, string]>): string {
  return `<div class="table-wrap"><table><thead><tr><th scope="col">입력</th><th scope="col">하는 일</th><th scope="col"><span class="sr-only">복사</span></th></tr></thead><tbody>${rows.map(([command, description]) => `<tr data-search="${escapeHtml(command + " " + description)}"><td><code>${escapeHtml(command)}</code></td><td>${escapeHtml(description)}</td><td><button type="button" data-copy-command="${escapeHtml(command)}" aria-label="${escapeHtml(command)} 복사">복사</button></td></tr>`).join("")}</tbody></table></div>`;
}

export type AiHelpMessage =
  | { readonly action: "copy"; readonly text: string; readonly requestId: number }
  | { readonly action: "close" }
  | { readonly action: "open-link"; readonly url: string };

/** Accepts messages only from the bundled guide; hosts also verify the sending frame. */
export function parseAiHelpMessage(value: unknown): AiHelpMessage | null {
  let data: unknown = value;
  if (typeof data === "string") {
    if (data.length > 30_000) return null;
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (
    typeof data !== "object" ||
    data === null ||
    !("channel" in data) ||
    data.channel !== AI_HELP_CHANNEL ||
    !("action" in data)
  )
    return null;
  if (data.action === "close") return { action: "close" };
  if (
    data.action === "copy" &&
    "text" in data &&
    typeof data.text === "string" &&
    data.text.length > 0 &&
    data.text.length <= 20_000 &&
    "requestId" in data &&
    typeof data.requestId === "number" &&
    Number.isSafeInteger(data.requestId) &&
    data.requestId >= 0 &&
    data.requestId <= 1_000_000
  ) {
    return { action: "copy", text: data.text, requestId: data.requestId };
  }
  if (data.action === "open-link" && "url" in data && typeof data.url === "string") {
    try {
      const url = new URL(data.url);
      if (url.protocol === "https:" && !url.username && !url.password)
        return { action: "open-link", url: url.toString() };
    } catch {
      return null;
    }
  }
  return null;
}

/** Bundled, offline HTML used by both the web dialog and the native mobile WebView. */
export const AI_HELP_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark">
<title>AI 사용 도움말 · 스킬과 Codex·Claude 명령어</title>
<style>
:root{color-scheme:light dark;--bg:#f6f8fc;--paper:#fff;--text:#17253b;--muted:#53647b;--line:#dce4ef;--accent:#1e5acf;--soft:#edf3ff;--code:#f1f4f9;--success:#166443}
@media(prefers-color-scheme:dark){:root{--bg:#101722;--paper:#182231;--text:#e5edf8;--muted:#a6b5cb;--line:#33435a;--accent:#96b9ff;--soft:#233555;--code:#111c2c;--success:#8ad8b1}}
*{box-sizing:border-box}html{scroll-behavior:auto;scroll-padding-top:110px}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif}a{color:var(--accent);text-underline-offset:3px}button,input{font:inherit}button{cursor:pointer;border:1px solid var(--line);border-radius:8px;padding:7px 12px;background:var(--paper);color:var(--text)}button:hover{background:var(--soft)}button:focus-visible,a:focus-visible,input:focus-visible,pre:focus-visible{outline:3px solid var(--accent);outline-offset:3px}[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.shell{max-width:1400px;margin:auto;display:grid;grid-template-columns:210px minmax(0,1fr);gap:32px;padding:28px}nav{position:sticky;top:24px;align-self:start}nav strong{font-size:17px;display:block;margin:0 0 15px}nav a{display:block;padding:9px 12px;text-decoration:none;color:var(--muted);border-radius:8px;margin:3px 0}nav a:hover{background:var(--soft);color:var(--accent)}nav small{display:block;margin:22px 12px;color:var(--muted)}main{min-width:0}.hero{border:1px solid var(--line);border-radius:20px;background:var(--paper);padding:32px;margin-bottom:18px}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.12em;color:var(--accent)}h1{font-size:clamp(28px,4vw,42px);line-height:1.25;letter-spacing:-.045em;margin:12px 0}h2{font-size:24px;letter-spacing:-.025em;margin:0 0 8px}h3{font-size:17px;line-height:1.5;margin:0 0 10px}h4{font-size:15px;margin:20px 0 8px}p{margin:8px 0 14px}ul,ol{padding-left:22px}li+li{margin-top:8px}.muted,.lede{color:var(--muted)}.lede{max-width:760px}.badges{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}.badge{font-size:12px;font-weight:600;border-radius:6px;padding:4px 9px;background:var(--soft);color:var(--accent)}.downloaded{background:var(--code);color:var(--muted)}.toolbar{position:sticky;top:0;z-index:2;padding:12px 0;background:var(--bg);display:flex;gap:8px;align-items:center}.search{min-width:0;flex:1;background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:11px 14px;color:var(--text)}.status{font-size:12px;min-height:24px;color:var(--muted);margin-bottom:12px}.section{margin:20px 0 34px;scroll-margin-top:100px}.section-heading{margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{min-width:0;border:1px solid var(--line);background:var(--paper);border-radius:14px;padding:20px;overflow-wrap:anywhere}.card p:last-child{margin-bottom:0}.card .badge{display:inline-block;margin-bottom:10px}.skill-name{font-size:15px;font-family:ui-monospace,Consolas,monospace}.example{padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}.copy-block{position:relative;margin-top:12px;border-radius:9px;background:var(--code);border:1px solid var(--line);overflow:hidden}.copy-block pre{margin:0;padding:15px 16px 52px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.8 ui-monospace,Consolas,"Malgun Gothic",monospace}.copy-block button{position:absolute;right:8px;bottom:8px;font-size:12px;padding:4px 10px}code{font:13px/1.6 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.note{border-left:3px solid var(--accent);background:var(--soft);border-radius:0 9px 9px 0;padding:14px 18px;margin:16px 0}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--paper)}table{border-collapse:collapse;width:100%;min-width:430px;font-size:14px}th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);background:var(--code)}tr:last-child td{border-bottom:0}td:first-child{width:43%}td:last-child{width:65px}td button{padding:4px 8px;font-size:12px}.sources li{margin-bottom:10px}.empty{padding:40px;border:1px dashed var(--line);border-radius:14px;text-align:center}.feedback{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--paper);padding:10px 20px;border-radius:10px;max-width:90%;z-index:3;font-size:14px}footer{padding:16px 0 30px;color:var(--muted);font-size:12px}
@media(max-width:1000px){.shell{grid-template-columns:1fr;gap:10px;padding:18px}nav{position:static}nav strong{display:none}nav .nav-links{display:flex;flex-wrap:wrap;gap:3px}nav a{padding:5px 9px;font-size:13px}nav small{display:none}.hero{padding:24px}.toolbar{top:0}}
@media(max-width:650px){.shell{padding:12px}.hero{padding:20px}.grid{grid-template-columns:1fr}.card{padding:17px}.toolbar button{padding:9px;font-size:13px}.search{font-size:14px}h2{font-size:22px}table{min-width:390px}}
@media print{body{background:white;color:#17253b}.shell{display:block;padding:0;max-width:none}nav,.toolbar,.status,button,.feedback,footer{display:none!important}.hero,.card,.table-wrap{background:white;break-inside:avoid}.section{margin:20px 0}.grid{display:block}.card{margin-bottom:12px}.copy-block pre{padding-bottom:15px}a{color:#1e5acf}.section[hidden],article[hidden],tr[hidden]{display:revert!important}}
</style>
</head>
<body>
<a class="sr-only" href="#main">본문으로 이동</a>
<div class="shell">
<nav aria-label="도움말 목차"><strong>AI 사용 설명서</strong><div class="nav-links">
<a href="#start">빠르게 시작</a><a href="#prompts">복사할 요청 예시</a><a href="#skills">현재 스킬</a><a href="#downloaded">추가 스킬 후보</a><a href="#utilities">앱과 유틸리티</a><a href="#automatic-work">자동 업무 · 토큰 절약</a><a href="#codex">Codex 명령어</a><a href="#claude">Claude 명령어</a><a href="#grok">Grok · X 조사</a><a href="#troubleshooting">문제 해결</a><a href="#sources">공식 자료</a>
</div><small>목표 → 범위 → 제약 → 완료 기준<br>짧고 구체적인 요청으로 시작하세요.</small></nav>
<main id="main">
<header class="hero"><div class="eyebrow">YOUR AI WORKSPACE GUIDE</div><h1>AI에게 일을 잘 맡기는 방법</h1><p class="lede">스킬 선택부터 코드 수정, 반복 업무 자동화와 토큰 절약까지. 원하는 결과를 설명하고, 실행과 검증을 맡기세요. 아래 예시는 복사해서 대화에 붙여 넣을 수 있습니다.</p><div class="badges"><span class="badge">한국어 도움말</span><span class="badge">오프라인 열람</span><span class="badge">업데이트 ${AI_HELP_UPDATED_AT}</span><span class="badge">Codex · Claude · Grok</span></div></header>
<div class="toolbar"><label for="guide-search" class="sr-only">도움말 검색</label><input id="guide-search" class="search" type="search" placeholder="스킬, 명령어, 오류, PDF… 검색" autocomplete="off"><button id="reset" type="button">초기화</button><button id="print" type="button">인쇄</button></div>
<div id="search-status" class="status" role="status" aria-live="polite">목차로 이동하거나 검색어를 입력하세요. Ctrl+K로 검색할 수 있습니다.</div>
<div id="empty" class="empty" hidden>일치하는 내용이 없습니다. 검색어를 줄이거나 초기화하세요.</div>
<section id="start" class="section" data-guide-section><div class="section-heading"><h2>01. 빠르게 시작</h2><p class="muted">필요한 정보 네 가지면 작업을 시작하기에 충분합니다.</p></div><div class="grid">
${card("목표와 완료 기준을 함께 적기", "<p>무엇을 바꿀지, 어디까지 끝내야 하는지 설명하세요. 오류 수정이라면 재현 순서와 기대 동작을, 파일 제작이라면 독자·분량·형식을 알려주세요.</p><p><strong>예:</strong> 개발본에 기능을 추가하고 관련 테스트 후 운영본에 적용해줘. 최종 실행 상태까지 확인해줘.</p>", "시작 요청 목표 범위 제약 완료 기준 프롬프트")}
${card("파일과 근거를 함께 제공하기", "<p>관련 파일·폴더·링크·로그 원문을 알려주세요. 이미 아는 경로를 주면 탐색 시간을 줄일 수 있습니다. 프로젝트 규칙은 AGENTS.md나 CLAUDE.md에 남기면 재사용하기 좋습니다.</p>", "문맥 컨텍스트 파일 로그 AGENTS.md CLAUDE.md")}
${card("진행 중에도 방향을 조정하기", "<p>추가 메시지로 제약이나 우선순위를 알려주세요. 주제가 크게 바뀌면 새 대화를, 같은 작업을 계속하면 현재 대화를 사용하세요. 긴 작업은 인수인계 요약을 남겨 이어갈 수 있습니다.</p>", "진행 수정 중단 이어가기 인수인계 새 대화")}
${card("결과와 검증을 확인하기", "<p>변경 파일, 실행한 검증, 실제 동작, 남은 문제를 함께 요청하세요. 운영 프로그램을 교체할 때는 개발본의 검증 결과와 재시작 후 상태 확인을 완료 기준에 넣으면 됩니다.</p>", "검증 테스트 안정성 운영 개발 교체 결과")}
</div></section>
<section id="prompts" class="section" data-guide-section><div class="section-heading"><h2>02. 복사해서 쓰는 작업 요청</h2><p class="muted">대괄호 안의 내용을 자신의 작업에 맞게 바꿔주세요.</p></div><div class="grid">${AI_HELP_PROMPTS.map((prompt) => card(prompt.title, copyBlock(prompt.text, "요청 예시 복사"), prompt.title + " " + prompt.text)).join("")}</div></section>
<section id="skills" class="section" data-guide-section><div class="section-heading"><h2>03. 현재 스킬 ${AI_HELP_SKILLS.length}개</h2><p class="muted">작성 당시 이 Codex 세션에 제공된 목록입니다. 다른 제공자·클라이언트·계정에서도 동일하게 활성화되는지는 그 세션에서 확인해야 합니다.</p></div>
<article class="note" data-search="스킬 도구 MCP 호출 달러 skills">스킬은 작업 절차와 참고 자료이고, 도구는 검색·파일 수정·앱 조작 같은 실제 기능입니다. 자연어로 스킬 이름을 지정할 수 있습니다. Codex CLI는 <code>/skills</code> 또는 <code>$스킬이름</code>, Claude Code는 설치된 스킬의 <code>/스킬이름</code>을 사용합니다. 플러그인 기능은 해당 연결도 필요합니다.</article>
<div class="grid">${AI_HELP_SKILLS.map(([name, category, description, example]) => card(name, `<span class="badge">${escapeHtml(category)} · 세션 목록</span><p>${escapeHtml(description)}</p><p class="example"><strong>요청 예시</strong><br>${escapeHtml(example)}</p>`, [name, category, description, example].join(" "))).join("")}</div>
<article class="note" data-search="Sites 사이트 HTML 호스팅 개발 Windows macOS iOS 권한 브라우저">Sites는 사이트 제작·호스팅용 스킬입니다. 앱 내부 기능은 현재 프로젝트 코드에 구현할 수 있습니다. iOS 전용 스킬에는 macOS가 필요하며, 화면 조작·외부 앱 연결은 현재 환경의 지원 여부와 프로젝트 지침을 따릅니다. 이 프로젝트는 Windows 셸로 CMD를 사용합니다.</article></section>
<section id="downloaded" class="section" data-guide-section><div class="section-heading"><h2>04. 추가 스킬 후보</h2><p class="muted">지난 Grok·X 조사에서 아래 6개 전체 패키지를 내려받아 검토했습니다. <strong>자동 발견 경로에 설치하거나 활성화하지는 않았습니다.</strong></p></div><div class="grid">${AI_HELP_DOWNLOADED_SKILLS.map(([name, description, url]) => card(name, `<span class="badge downloaded">다운로드·검토 완료 / 활성화 전</span><p>${escapeHtml(description)}</p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">원본 저장소 보기 ↗</a>`, name + " " + description + " 다운로드 설치 비활성")).join("")}</div>
<article class="note" data-search="스킬 설치 폴더 발견 .agents .claude SKILL.md 호환성">설치를 요청하면 Windows 호환성·추가 의존성·프로젝트 지침을 확인한 뒤 제공자별 발견 경로에 배치할 수 있습니다. Codex 프로젝트 스킬은 <code>.agents/skills/&lt;이름&gt;/SKILL.md</code>, Claude 프로젝트 스킬은 <code>.claude/skills/&lt;이름&gt;/SKILL.md</code>를 사용합니다. 파일을 임의의 다운로드 폴더에 두는 것만으로는 활성화되지 않습니다.</article></section>
<section id="utilities" class="section" data-guide-section><div class="section-heading"><h2>05. 앱과 유틸리티 활용</h2><p class="muted">작업에 맞는 입력 위치와 확인 도구를 선택하세요.</p></div><div class="grid">
${card("채팅 · 모델 · 스킬", "<p>실제 작업 요청은 채팅에 입력합니다. 제공자·모델·권한은 앱의 선택 메뉴와 설정에서 확인하세요. 스킬은 현재 세션의 목록에 있을 때 사용하도록 요청할 수 있습니다.</p>", "T3 채팅 모델 제공자 Codex Claude Cursor Grok OpenCode 스킬")}
${card("파일 · 터미널 · 변경 내역", "<p>파일 경로와 코드 변경을 확인하고, 터미널에서 직접 CLI를 실행할 수 있습니다. AI에게 기존 스크립트와 실행기를 확인해 사용하도록 요청하면 프로젝트 설정을 유지하기 좋습니다.</p>", "T3 파일 터미널 코드 diff Git CMD")}
${card("AI 제어센터 · 검증 증거", "<p>AI 제어센터에서 자동화 상태와 작업 결과를 확인할 수 있습니다. 검증이 만든 PNG·PDF·HTML·TXT 등의 증거 파일을 기록한 경우 결과에서 미리보기나 공유로 확인할 수 있습니다.</p>", "제어센터 자동화 검증 증거 evidencePaths 미리보기 PNG PDF HTML TXT workspace_manage")}
${card("MCP · 앱 연결", "<p>MCP는 AI가 외부 기능을 호출하는 연결 방식입니다. 연결된 서버·앱마다 가능한 작업이 다르므로 먼저 현재 도구 목록을 확인해달라고 요청하세요. 스킬 이름만으로 없는 연결이 생기지는 않습니다.</p>", "MCP 플러그인 앱 connector 도구 연결")}
</div><h3>Windows CMD에서 쓰는 확인 명령</h3>${commandTable([
  ["git status --short", "수정된 파일 목록"],
  ["git diff --stat", "변경 규모 확인"],
  ["rg -n TODO apps", "apps 폴더의 TODO 검색"],
  ["node --version", "Node 버전 확인"],
  ["python --version", "Python 버전 확인"],
  [
    "node_modules\\.bin\\vp.cmd test run 경로.test.ts",
    "이 프로젝트의 특정 테스트 실행; 실제 경로로 교체",
  ],
])}</section>
<section id="automatic-work" class="section" data-guide-section><div class="section-heading"><h2>06. 자동 업무 · 토큰 절약 · 오케스트라</h2><p class="muted">반복할 업무의 입력과 성공 조건을 저장하고, 필요한 경우에만 AI를 실행하세요.</p></div><div class="grid">
${card("Claude · Codex 자동 캐시 활용", "<p>프로젝트의 공통 지침을 앞에 유지하고 작업별 요청을 뒤에 배치해 반복 입력의 재사용을 돕습니다. 같은 오케스트라 작업의 바로 다음 재시도는 계정·모델·추론 설정·작업 폴더·권한이 같을 때 이전 세션을 이어갑니다. 세션 재개만으로 캐시 적중을 확정하지 않습니다.</p><p>Codex의 실제 캐시 읽기·쓰기는 제공자가 보고한 사용량으로 확인합니다. 이전 세션 복원이 실패하면 새 세션에 대화 인계 문맥을 보냅니다. 이 기능은 선택한 모델이나 추론 수준을 낮추지 않습니다.</p>", "Claude Codex 캐시 cache 토큰 절약 세션 재개 재시도 오케스트라 적중 인계")}
${card("Claude 캐시 유지 시간", "<p><strong>설정 → 제공자 → Claude</strong>에서 일반 대화와 Claude 내부 하위 에이전트의 유지 시간을 각각 <strong>Claude 기본 설정 · 5분 · 1시간</strong>으로 선택합니다. 변경 사항은 새 세션부터 적용됩니다. 앱의 오케스트라 작업자는 각각 일반 대화 설정을 사용합니다.</p><p>기본값은 Claude의 현재 설정을 따릅니다. 긴 간격으로 같은 문맥을 반복하는 작업에는 1시간을 선택할 수 있지만, 캐시 쓰기 비용이 더 클 수 있으므로 사용량을 비교하세요. 환경 변수나 관리 정책이 우선할 수 있습니다.</p>", "Claude TTL promptCacheTtl subagentPromptCacheTtl 5분 1시간 설정 하위 에이전트")}
${card("문서 캐시 확인 · 끄기 · 새로고침", "<p><strong>설정 → AI 검색</strong>의 <strong>동일 문서 추출 결과 재사용</strong>으로 반복 첨부한 문서의 추출 결과를 재사용합니다. 매번 파일 내용을 확인하며, 내용·프로젝트·추출 조건이 바뀌면 다시 처리합니다. 동시에 들어온 같은 추출 요청은 한 번 처리합니다.</p><p><strong>문서 캐시 새로고침</strong>은 다음 요청에서 새로 추출하게 합니다. 기존 대화와 증거 파일은 보존합니다. 실패·부분 추출은 저장하지 않으며, 캐시가 없어도 원본에서 처리합니다. 이 캐시는 문서 처리 작업을 줄이며 AI의 입력 토큰 절감률과는 별도로 확인해야 합니다.</p><p>사용량에서 캐시 읽기·쓰기와 보고된 경우 5분·1시간 쓰기를 볼 수 있습니다. <strong>—</strong>는 보고되지 않은 값이며 0으로 계산하지 않습니다.</p>", "문서 캐시 새로고침 끄기 AI 검색 토큰 사용량 캐시 읽기 쓰기 5분 1시간")}
${card("처음 시작: 양식 저장 → 작업 접수", "<ol><li><strong>프로젝트 운영 → 자동 작업 성과 → 자동 업무 접수함</strong>을 엽니다.</li><li><strong>자료 조사 · 이슈 수정 후보 · 파일 처리 · AI 없이 명령 실행</strong> 중 업무에 맞는 양식을 고릅니다.</li><li>입력 항목, 지시문, 변화 확인 방식, 실행 방법과 성공 조건을 편집해 저장합니다.</li><li>저장한 양식을 선택하고 입력값을 채운 뒤 <strong>업무 접수</strong>를 누릅니다. 해당 프로젝트에서 AI 작업이 진행 중이면 기다렸다가 실행합니다.</li></ol><p>양식 편집은 웹·데스크톱에서, 저장한 양식의 접수·상태 확인·작업 제어는 모바일에서도 사용할 수 있습니다.</p>", "자동 업무 자동업무 접수함 시작 양식 저장 작업 접수 자료 조사 이슈 수정 파일 처리 모바일")}
${card("토큰 절약: 변화 확인과 명령 실행", "<p><strong>파일 내용이 바뀔 때 실행</strong>은 이전 정상 완료 때의 파일 내용과 비교합니다. <strong>확인 명령이 변경을 보고할 때 실행</strong>은 확인 명령의 JSON 결과를 사용합니다. 변화가 없으면 <strong>변화 없음 · AI 생략</strong>으로 끝납니다.</p><p>단순 집계·변환·정해진 스크립트는 <strong>AI 없이 명령 실행</strong>을 선택하세요. Windows 명령은 CMD로 실행하며 PowerShell 명령은 저장할 수 없습니다.</p><p>확인 명령의 실패·시간 초과·잘못된 출력은 ‘변화 없음’으로 처리하지 않습니다. 실패한 실행은 다음 비교의 정상 완료 기준을 앞당기지 않습니다.</p>", "자동 업무 자동업무 접수함 토큰 절약 최적화 AI 호출 생략 파일 변경 fingerprint 변화 없음 명령 실행 CMD")}
${card("입력·양식 버전과 중복 접수", "<p>접수할 때 입력과 양식 버전, 선택한 실행 프로필을 함께 보관합니다. 이후 양식을 수정해도 이미 접수한 업무는 원래 조건으로 처리합니다.</p><p>GitHub 이슈 가져오기와 JSON 접수 도구로 외부 이벤트를 업무 입력으로 연결할 수 있습니다. 같은 프로젝트·출처·이벤트 ID·입력은 기존 접수 기록을 반환합니다. 입력이 바뀐 이벤트에는 새 ID를 사용하세요.</p><p><strong>입력·실행 자료</strong>에서 사용한 버전, 시도 번호, 실제 종료 코드와 저장 출력을 확인할 수 있습니다.</p>", "자동 업무 자동업무 접수함 입력 양식 버전 GitHub 이슈 JSON 외부 이벤트 ID 중복 접수 실행 자료")}
${card("오케스트라 프로필과 예약 연결", "<p>AI 업무에는 저장한 실행 프로필을 선택할 수 있습니다. 프로필의 모델·역할·병렬·worktree 설정과 검증 명령을 함께 보관합니다. 프로필을 나중에 바꿔도 이미 접수한 업무의 조건은 유지됩니다.</p><p>스케줄러에서 <strong>저장한 업무 양식</strong>을 선택하고 입력값과 실행 시간을 지정하세요. 매일·주기·한 번·협업 완료 후 예약을 사용할 수 있습니다.</p><p>이전 회차가 진행·보류 중이거나 검증·수행 결과 재확인이 필요하면 새 회차를 건너뛰고 이유를 표시합니다. 이전 결과를 확인하고 대기를 정리한 뒤 이어가세요.</p>", "자동 업무 자동업무 접수함 오케스트라 오케스트레이션 실행 프로필 모델 역할 병렬 worktree 스케줄 예약 반복 협업")}
${card("완료 기준: 답변 뒤에 실제 결과 검사", "<p>검증 명령의 종료 코드와 산출물의 변경·비어 있지 않음을 검사합니다. JSON 산출물에는 필수 최상위 필드를 지정할 수 있습니다. 산출물 경로는 프로젝트 루트 기준이며, worktree의 결과는 프로젝트 루트에 반영된 뒤 검사합니다.</p><p><strong>설정한 결과 검사 통과</strong>는 저장한 명령·파일 조건이 통과했다는 뜻입니다. 내용의 정확성을 확인하려면 그에 맞는 테스트와 성공 조건을 설정하세요.</p><p>AI 업무에 검증 명령·산출물 조건이 없으면 <strong>응답 완료 · 검증 필요</strong>로 남습니다. 양식에 성공 조건을 보완하고 새 업무로 접수하세요.</p>", "자동 업무 자동업무 접수함 완료 결과 검사 성공 조건 검증 필요 산출물 JSON 종료 코드 worktree")}
${card("보류·취소와 중단된 작업 이어가기", "<p><strong>보류</strong>한 작업은 보류를 해제해 다시 진행할 수 있습니다. <strong>취소</strong>는 실행이 정리될 때까지 ‘취소 처리 중’으로 표시되며, 이미 수행한 변경을 되돌리지는 않습니다.</p><p>실행·검증 중 서버가 중단되면 <strong>수행 결과 재확인 필요</strong>로 남고 명령을 자동 재생하지 않습니다. AI 실행 기록이 있으면 <strong>기존 실행 재확인</strong>으로 연결하세요.</p><p><strong>새 시도로 재실행</strong>은 실제 업무를 다시 수행합니다. 기존 산출물과 실행 자료를 먼저 확인하세요. 이전 시도의 기록은 보존됩니다.</p><p>양식의 <strong>새 작업 접수 허용</strong>을 끄면 새 접수를 막습니다. 이미 접수한 작업은 개별 보류·취소로 제어하세요.</p>", "자동 업무 자동업무 접수함 보류 해제 취소 중지 재실행 재시도 재확인 복구 서버 중단 재시작 입력 실행 자료")}
${card("자료 조사 양식 예시", "<p>입력 항목과 지시문의 이름을 맞추고, 실제로 확인할 산출물을 지정하세요. 아래 내용을 자신의 주제와 결과 형식에 맞게 바꿔 사용할 수 있습니다.</p>" + copyBlock("양식: 자료 조사\n입력 항목: topic\n지시문: {{topic}}의 변경 사항을 공식 자료와 비교해 요약하고 report.json에 저장하세요. 요약은 summary, 출처 목록은 sources 필드에 작성하세요.\n산출물: report.json\n파일 형식: JSON\n필수 최상위 필드: summary, sources\n변화 확인: 조사할 출처에 맞는 파일 확인 또는 확인 명령을 별도로 설정", "양식 예시 복사"), "자동 업무 자동업무 접수함 자료 조사 양식 예시 입력 변수 지시문 topic report.json JSON 산출물 복사")}
</div></section>
<section id="codex" class="section" data-guide-section><div class="section-heading"><h2>07. Codex 명령어</h2><p class="muted">확인한 로컬 버전: Codex CLI 0.162.1. 기능·명령 노출은 버전과 환경에 따라 달라질 수 있습니다.</p></div>
<article class="note" data-search="Codex 슬래시 CLI TUI 채팅 명령 입력 위치">아래 <code>/…</code>는 <strong>Codex의 대화형 터미널</strong>에 입력하는 명령입니다. T3 채팅은 제공자와 별도 UI를 사용하므로 지원 여부는 앱의 <code>/</code> 메뉴에서 확인하세요. 목록에 없는 명령은 채팅에서 자연어로 요청하거나 터미널의 Codex CLI에서 실행하세요.</article>
<h3>대화형 터미널의 슬래시 명령</h3>${commandTable(CODEX_SLASH)}<h3 style="margin-top:22px">CMD 터미널에서 실행</h3>${commandTable(CODEX_CLI)}
<p class="muted"><a href="https://learn.chatgpt.com/docs/developer-commands" target="_blank" rel="noopener noreferrer">공식 슬래시 명령</a> · <a href="https://learn.chatgpt.com/docs/cli/reference" target="_blank" rel="noopener noreferrer">공식 CLI 참조</a></p></section>
<section id="claude" class="section" data-guide-section><div class="section-heading"><h2>08. Claude Code 명령어</h2><p class="muted">확인한 로컬 버전: Claude Code 2.1.296. 계정·플랫폼·연결 상태에 따라 일부 명령이 다르게 표시됩니다.</p></div>
<article class="note" data-search="Claude 슬래시 CLI T3 채팅 스킬 skill">아래 슬래시 명령은 <strong>Claude Code 대화형 터미널</strong>용입니다. T3에서 같은 조작을 할 때는 앱의 모델·권한·대화 메뉴와 현재 지원되는 <code>/</code> 메뉴를 사용하세요. 설치된 사용자 스킬은 <code>/스킬이름</code>, 플러그인 스킬은 <code>/플러그인:스킬이름</code>으로 호출할 수 있습니다.</article>
<h3>대화형 터미널의 슬래시 명령</h3>${commandTable(CLAUDE_SLASH)}<h3 style="margin-top:22px">CMD 터미널에서 실행</h3>${commandTable(CLAUDE_CLI)}
<p class="muted"><a href="https://code.claude.com/docs/en/commands" target="_blank" rel="noopener noreferrer">공식 명령 목록</a> · <a href="https://code.claude.com/docs/en/cli-reference" target="_blank" rel="noopener noreferrer">공식 CLI 참조</a></p></section>
<section id="grok" class="section" data-guide-section><div class="section-heading"><h2>09. Grok으로 X 사례 조사</h2><p class="muted">확인한 로컬 버전: Grok CLI 1.0.46. X 검색 결과는 공식 문서·저장소와 함께 확인하면 좋습니다.</p></div><div class="grid">
${card("X 검색을 명시해서 요청하기", "<p>주제·기간·원하는 결과 형식을 정해주고, 게시 날짜·원문 링크·공식 자료 대조를 요청하세요. 검색 가능 여부는 해당 Grok 세션의 도구와 계정 상태에 달려 있습니다.</p>" + copyBlock("Grok CLI로 최근 30일의 X에서 [주제] 사례를 찾아줘. 게시 날짜와 원문 링크를 남기고 공식 문서로 기능을 확인해줘. 실제 검색한 범위와 확인하지 못한 내용도 표시해줘.", "조사 요청 복사"), "Grok X 검색 조사 출처 최신 30일")}
${card(
  "터미널에서 시작하기",
  commandTable([
    ["grok --help", "설치된 옵션 확인"],
    ["grok --version", "설치 버전 확인"],
    ["grok", "대화형 CLI 시작"],
  ]) +
    '<p class="example">이번 스킬 조사에서는 실제 X 검색과 게시물 스레드 조회를 사용했고, 추천 패키지는 원본 저장소로 추가 확인했습니다.</p>',
  "Grok CLI 터미널 명령 XSearch WebSearch",
)}
</div></section>
<section id="troubleshooting" class="section" data-guide-section><div class="section-heading"><h2>10. 자주 생기는 문제</h2></div><div class="grid">
${card("스킬이 보이지 않을 때", "<p>현재 세션의 스킬 목록과 실제 SKILL.md 위치를 확인해달라고 요청하세요. 다운로드·설치·활성화는 별개의 상태입니다. 제공자와 플러그인 연결이 맞는지도 확인합니다.</p>", "오류 스킬 안보임 설치 활성화 발견")}
${card("슬래시 명령이 실행되지 않을 때", "<p>입력한 곳이 T3 채팅인지, Codex·Claude 대화형 터미널인지 먼저 확인하세요. 해당 CLI의 <code>--help</code>와 터미널의 <code>/</code> 목록으로 지원 여부를 확인합니다.</p>", "오류 명령 슬래시 안됨 Codex Claude CLI")}
${card("대화가 길어졌을 때", "<p>현재 목표·진행 상태·파일·검증 결과·남은 일을 요약해달라고 요청하세요. 같은 작업을 이어가려면 요약을 남기고 문맥을 정리합니다. 새 주제는 새 대화로 시작할 수 있습니다.</p>", "오류 컨텍스트 context compact 토큰 요약 인수인계")}
${card("명령이나 테스트가 실패했을 때", "<p>실행 경로·인자·종료 코드·오류 원문을 제공하세요. AI에게 셸 문법, 경로 문제, 프로그램 오류, 실제 접근 제한을 구분해서 진단하고 가능한 후속 작업을 계속해달라고 요청하세요.</p>", "오류 실패 CMD 실행 경로 테스트 진단 권한")}
</div></section>
<section id="sources" class="section" data-guide-section><div class="section-heading"><h2>11. 공식 자료와 확인 범위</h2></div><article class="card" data-search="출처 공식 문서 버전 확인 스킬">
<ul class="sources"><li><a href="https://learn.chatgpt.com/docs/cli/reference" target="_blank" rel="noopener noreferrer">Codex CLI 명령·옵션</a></li><li><a href="https://learn.chatgpt.com/docs/developer-commands" target="_blank" rel="noopener noreferrer">Codex 슬래시 명령</a></li><li><a href="https://learn.chatgpt.com/docs/build-skills" target="_blank" rel="noopener noreferrer">Codex 스킬 작성·발견·호출</a></li><li><a href="https://code.claude.com/docs/en/cli-reference" target="_blank" rel="noopener noreferrer">Claude Code CLI 참조</a></li><li><a href="https://code.claude.com/docs/en/commands" target="_blank" rel="noopener noreferrer">Claude Code 명령 목록</a></li><li><a href="https://code.claude.com/docs/en/skills" target="_blank" rel="noopener noreferrer">Claude Code 스킬</a></li></ul>
<p class="muted">공식 문서와 이 PC의 CLI 도움말은 ${AI_HELP_REFERENCE_CHECKED_AT}에 확인한 내용입니다. 자동 업무 안내는 ${AI_HELP_UPDATED_AT}의 앱 기능을 기준으로 추가했습니다. 스킬 목록은 작성 시점의 세션 목록이며 실시간 설치 현황이 아닙니다. 새 버전이나 다른 계정에서는 현재 메뉴와 공식 문서를 우선 확인하세요.</p>
</article></section>
<footer>AI 사용 도움말 · 검색과 복사 기능은 이 HTML 안에서 동작합니다. 명령을 복사해도 자동 실행되지는 않습니다.</footer>
</main></div><div id="feedback" class="feedback" role="status" aria-live="polite" hidden></div>
<script>
(function () {
  var search = document.getElementById('guide-search');
  var status = document.getElementById('search-status');
  var items = Array.from(document.querySelectorAll('[data-search]'));
  var sections = Array.from(document.querySelectorAll('[data-guide-section]'));
  var feedback = document.getElementById('feedback');
  var timer;
  var requestId = 0;
  var isNative = Boolean(window.ReactNativeWebView);
  var isEmbedded = window.parent !== window;
  var normal = function (text) { return text.normalize('NFKC').toLocaleLowerCase().replace(/\\s+/g, ' ').trim(); };
  var indexed = items.map(function (item) { return normal(item.getAttribute('data-search') + ' ' + item.textContent + ' ' + item.closest('section').querySelector('h2').textContent); });
  function filter() {
    var terms = normal(search.value).split(' ').filter(Boolean);
    var count = 0;
    items.forEach(function (item, index) { item.hidden = !terms.every(function (term) { return indexed[index].includes(term); }); if (!item.hidden) count++; });
    sections.forEach(function (section) { section.hidden = !Array.from(section.querySelectorAll('[data-search]')).some(function (item) { return !item.hidden; }); });
    status.textContent = terms.length ? count + '개 항목이 일치합니다.' : '목차로 이동하거나 검색어를 입력하세요. Ctrl+K로 검색할 수 있습니다.';
    document.getElementById('empty').hidden = count > 0;
  }
  function notify(success) {
    clearTimeout(timer); feedback.textContent = success ? '복사했습니다. 채팅이나 터미널에 붙여 넣으세요.' : '복사하지 못했습니다. 내용을 선택해서 직접 복사하세요.'; feedback.hidden = false;
    timer = setTimeout(function () { feedback.hidden = true; }, 3500);
  }
  window.aiHelpResult = function (id, success) { if (id <= requestId) notify(success === true); };
  function send(message) {
    message.channel = '${AI_HELP_CHANNEL}';
    if (isNative) window.ReactNativeWebView.postMessage(JSON.stringify(message));
    else if (isEmbedded) window.parent.postMessage(message, '*');
  }
  async function copy(text) {
    if (isNative || isEmbedded) { send({ action: 'copy', text: text, requestId: ++requestId }); return; }
    try { if (!navigator.clipboard) throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(text); notify(true); }
    catch (error) {
      var area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select();
      try { notify(document.execCommand('copy')); } catch (copyError) { notify(false); }
      area.remove();
    }
  }
  search.addEventListener('input', filter);
  document.getElementById('reset').addEventListener('click', function () { search.value = ''; filter(); search.focus(); });
  if (isNative) document.getElementById('print').hidden = true;
  else document.getElementById('print').addEventListener('click', function () { window.print(); });
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy], [data-copy-command]');
    if (button) copy(button.hasAttribute('data-copy-command') ? button.getAttribute('data-copy-command') : button.closest('.copy-block').querySelector('pre').textContent);
    var link = event.target.closest('a');
    var href = link ? link.getAttribute('href') || '' : '';
    if (href.startsWith('#')) {
      // Keep fragment jumps inside this document, including sandboxed blob frames.
      event.preventDefault();
      var target = document.getElementById(href.slice(1));
      if (target) {
        if (search.value) { search.value = ''; filter(); }
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
      return;
    }
    if (link && isNative && href.startsWith('https://')) { event.preventDefault(); send({ action: 'open-link', url: link.href }); }
  });
  window.addEventListener('message', function (event) { if (event.source !== window.parent) return; var data = event.data; if (data && data.channel === '${AI_HELP_CHANNEL}' && data.action === 'copy-result') window.aiHelpResult(data.requestId, data.success); });
  document.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); search.focus(); }
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); if (search.value) { search.value = ''; filter(); } else send({ action: 'close' }); }
  });
})();
</script>
</body></html>`;
