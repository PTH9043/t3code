# 보안 감사 스킬과 Bun 검사 도구

2026-10-22에 제공된 [텔레그램 자료](https://t.me/honey_box_main/2619)는 Cloudflare의 [security-audit-skill](https://github.com/cloudflare/security-audit-skill)을 소개한다. [Bun 게시물](https://x.com/bunjavascript/status/2113213103660032209)은 [Bun 1.4.4](https://bun.com/blog/bun-v1.4.4)의 포맷 검사·타입 검사·런타임 변경 사항을 소개한다.

## 보안 감사

원본 스킬은 `.agents/skills/security-audit`에 설치되어 있다. 고정한 커밋은 `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`이며, `UPSTREAM.json`에 출처와 파일별 SHA-256을 기록했다. 원본 지침과 MIT 라이선스를 보존한다. `.claude/skills`는 같은 디렉터리로 연결해 Codex와 Claude가 같은 스킬을 읽는다. Windows 체크아웃에서 링크가 `../.agents/skills`라는 일반 파일로 저장된 경우 실제 디렉터리 링크를 복원해야 한다.

T3 프로젝트 대화에서 `$security-audit`를 선택하거나 보안 검토를 요청할 수 있다. 새 스킬 목록은 다음 대화 턴 또는 공급자 목록 갱신 후 읽힌다. 다른 프로젝트에 설치한 것으로 간주하지 않는다. Gemini·Grok·Cursor·OpenCode에는 이번 작업으로 별도 스킬 선택 기능을 추가하지 않는다.

기본은 특정 질문과 경계를 검토하는 guidance 모드다. 전체 코드베이스 감사나 침투 시험을 명시적으로 요청했을 때만 원본의 전체 감사 절차를 사용한다. 확인된 결함, 추가 검증이 필요한 가설, 반증된 후보를 구분하고 결과를 독립적으로 검증한다. 스킬을 설치한 것만으로 보안 감사를 완료했다고 보고하지 않는다.

취약점 재현에는 원본이 요구하는 운영체제 수준의 격리가 필요하다. 외부 네트워크 차단, 허용 목록 환경 변수, 쓰기 경로 분리와 자원 상한을 갖춘 환경을 사용한다. 단순히 작업 디렉터리를 나누는 것으로 이를 충족했다고 판단하지 않는다. 이 조건을 충족하지 못한 공격 재현은 `needs_validation`으로 남기고, 운영 데이터·실행 중인 서비스·실제 계정으로 대신 재현하지 않는다. 사용자 앱의 전체/제한 권한, 질문하기와 계획 모드를 변경하지 않는다.

## Bun 1.4.4

운영 web/backend/desktop의 Node/Electron 실행 경로와 pnpm 잠금 파일은 유지한다. Bun.SQL·Bun WebSocket의 변경은 Bun 런타임에 해당하므로 이번 도구 설치만으로 운영 서버에 적용됐다고 보지 않는다.

이 PC에서는 공식 Windows x64 baseline ZIP을 받아 `.t3/tools/bun/1.4.4/bun.exe`에 설치한다. 전역 PATH를 바꾸지 않는다. `scripts/bun-release.json`에 고정한 ZIP과 실행 파일의 크기·SHA-256을 모두 확인한다. PowerShell이나 패키지 설치 스크립트를 실행하지 않는다.

```cmd
node scripts/bun-tools.mjs setup
node scripts/bun-tools.mjs version
node scripts/bun-tools.mjs fmt-check packages/shared/src/path.ts
node scripts/bun-tools.mjs fmt packages/shared/src/path.ts
node scripts/bun-tools.mjs check packages/contracts/tsconfig.json
```

같은 명령은 `bun:setup`, `fmt:bun`, `fmt:bun:check`, `typecheck:bun` 패키지 스크립트로도 사용할 수 있다. 포맷 명령은 대상 파일을, 타입 검사는 대상 프로젝트를 명시한다. 인자 없이 전체 저장소 검사를 시작하지 않는다.

`--no-script`로 Bun 내장 명령을 선택해 기존 `fmt`·`check` 스크립트가 대신 실행되는 것을 막는다. `fmt-check`는 파일을 쓰거나 Git 스테이지를 변경하지 않는다. Bun은 현재 `vite.config.ts`의 oxfmt 설정을 읽으며, `bun fmt --doctor`로 확인할 수 있다.

Bun 타입 검사는 빠른 TypeScript 사전 검사다. 이 프로젝트의 Effect 전용 진단을 포함한 기존 `tsgo` 검사와 대상 lint·테스트를 계속 사용한다. 기존 `fmt`, `fmt:check`, `typecheck` 명령을 바꾸지 않는다.

검증용 Effect 코드의 `new Date()` 사용은 기존 `tsgo`에서 `TS377069 / globalDateInEffect` 오류가 났지만 Bun 검사에서는 통과했다. 이 차이 때문에 Bun 통과만으로 프로젝트 검증 완료를 판단하지 않는다.
