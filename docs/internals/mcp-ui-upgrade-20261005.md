# MCP 연결과 작업실 UI — 2026-10-05

별도 업그레이드 작업 공간에서 기존 설정과 사용자 작업을 보존하며 구현했다. 관리 도구 설정은 서버 설정의 `mcpTools`에 저장하고 Codex·Claude 세션 시작 시 공급한다. 기본값은 꺼짐이며 이번 PC 반영에서 설치·검증된 연결을 명시적으로 켠다. 기존 사용자 MCP 설정과 제품 자체 `t3-code` MCP는 유지한다.

로컬 도구는 T3 home의 `tools/mcp`에 버전을 고정해 설치한다. `scripts/install-mcp-tools.mjs --home-dir <absolute-home>`은 공식 npm 패키지 세 종류만 설치하며 설치 후 스크립트를 실행하지 않는다. MCP SDK는 서버 의존성으로 포함한다. Claude Code의 기존 설치는 공식 `mcp serve` 진입점으로 연결하고 목록 확인에는 모델 호출을 사용하지 않는다.

## UI 참고 근거

운영 RAG에서 확인한 자료는 `repair-web-project-return-navigation`과 `repair-mobile-shared-presentation`이다. 프로젝트·환경별 복귀 경계, 웹·모바일 공통 상태 표시, 불필요한 스트리밍 구독 방지를 유지한다. 로컬 검증 화면 `.t3/orchestra-validation/memory-ui.png`의 기존 어두운 바탕, 얇은 경계, 둥근 입력 영역도 대조했다.

운영 RAG DB와 프로젝트 기억 폴더에서 Figma·Dribbble·shadcn 또는 별도의 UI 디자인 시안 항목은 확인하지 못했다. 사용자에게 위치를 요청했으며, 그 디자인 시안을 확인했다고 주장하지 않는다. 이번 화면 변경은 확인된 UI 운영 지침과 기존 테마를 기준으로 작업실의 기능 탐색과 도구 관리를 개선한다.

## 적용 범위

웹·데스크톱: 프로젝트 작업실 바로가기, 선택 영역 메뉴, 공용 프로젝트 검색, 설정과 제어센터의 MCP 관리.
모바일: 프로젝트 운영 화면의 접이식 MCP 관리. 모바일 설치 빌드와 기기 시각 검증은 별도다.
Codex·Claude: 세션 시작 시 관리 도구 적용. ACP 및 OpenCode 연결에는 추가하지 않는다.
원격 연결: 환경별 RPC와 서버 설정을 사용하며 도구 실행은 해당 환경 안에서 수행한다. 클라이언트 origin을 코드에 고정하지 않는다.
