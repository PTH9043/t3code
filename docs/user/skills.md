# 스킬과 `/` 메뉴

스킬은 `SKILL.md` 한 장과 참고 파일로 이루어진 작업 지침 묶음입니다. 스킬 목록은 대화에서 어떤 AI를 고르든 같습니다.

- 프로젝트의 `.agents/skills/<이름>/`, `.claude/skills/<이름>/`, `.gemini/skills/<이름>/`에 넣은 스킬
- 어느 한 AI에 개인용으로 설치한 스킬(각 AI 홈 폴더의 `skills`, Antigravity 플러그인 스킬 `~/.gemini/config/plugins/*/skills`, 설정의 확장에서 설치한 스킬). 다른 AI를 골라도 목록에 나옵니다.

이름이 겹치면 프로젝트 스킬, 지금 고른 AI의 스킬, 다른 AI의 개인 스킬 순으로 우선합니다. 각 AI에 기본 내장된 시스템 스킬은 그 AI를 골랐을 때만 나옵니다.

## 고르는 방법

- 입력창 줄 맨 앞에서 `/`를 누르면 기본 명령, 제공자 명령, 스킬이 함께 뜹니다. 이어서 글자를 입력하면 이름과 설명으로 좁혀집니다.
- `$`를 입력하면 스킬만 뜹니다 (`$플러그인:스킬` 형태도 지원합니다).
- 스킬을 고르면 입력창에 `$이름`이 들어갑니다. 그 뒤에 요청을 적어 보내면 됩니다.

## AI별 동작

- Codex와 Claude는 `$이름`으로 지정한 스킬을 자체 스킬 기능으로 실행합니다.
- Antigravity(`agy acp`)는 격리 홈의 `skills.json`·`plugins.json`으로 스킬을 직접 탐색하며, `$이름`으로 명시한 스킬은 요청 지침으로도 함께 고정 전달됩니다.
- 그 밖의 AI는 스킬 기능이 없으므로, T3 Code가 지정한 스킬의 `SKILL.md` 본문을 요청에 붙여 보냅니다. 본문이 6만 자를 넘으면 앞부분만 보냅니다. 스킬에 딸린 스크립트를 실행할 수 있는지는 그 AI가 명령을 실행할 수 있는지에 달려 있습니다.

## 이 저장소에 들어 있는 외부 스킬

출처와 받은 시점은 각 스킬 폴더의 `UPSTREAM.json`에 적혀 있습니다. 모두 `disable-model-invocation: true`로 두어 사용자가 직접 고를 때만 실행됩니다. AI가 알아서 쓰게 하려면 해당 `SKILL.md`에서 그 줄을 지웁니다.

| 스킬                                                                                                                                     | 용도                                                                              | 출처                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| `brainstorming`, `writing-plans`, `executing-plans`, `systematic-debugging`, `test-driven-development`, `verification-before-completion` | 코딩 전 설계·계획, 계획 실행, 디버깅, 테스트 우선, 완료 전 검증                   | obra/superpowers                     |
| `skill-creator`, `frontend-design`                                                                                                       | 스킬 작성·개선, 화면 디자인 방향                                                  | anthropics/skills                    |
| `ui-ux-pro-max`                                                                                                                          | 디자인 시스템·UI/UX 자료 검색 (Python 필요)                                       | nextlevelbuilder/ui-ux-pro-max-skill |
| `humanizer`                                                                                                                              | AI 특유의 말투 걷어내기                                                           | blader/humanizer                     |
| `book-to-skill`                                                                                                                          | 책·문서를 스킬로 변환 (Python 필요)                                               | virgiliojr94/book-to-skill           |
| `prompt-master`                                                                                                                          | 대상 AI에 맞춘 프롬프트 작성                                                      | nidhinjs/prompt-master               |
| `hiring-prep-doc-feedback`, `kevin-feedback`, `hiring-sim-resume-redteam`, `hiring-sim-interview`                                        | 이력서·자소서 피드백, 직설 피드백, 이력서 주장과 근거 대조, 이력서 기반 모의 면접 | techeer-sv/Career-Skills             |

## 질문 틀 스킬

역할과 답변 형식을 정해 둔 질문 틀입니다. 스킬을 고른 뒤 상황을 적어 보내면 되고, 빠진 정보가 있으면 AI가 먼저 묻습니다. 역시 직접 고를 때만 실행됩니다.

| 스킬                        | 용도                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `requirements-analyst`      | 문제를 정리하고 필요한 정보 3가지를 먼저 물은 뒤 해결책 제시 |
| `critical-evaluator`        | 투자자 관점의 약점·미검증 가정·실패 시나리오                 |
| `goal-backcaster`           | 목표에서 역산한 주간 실행 계획                               |
| `industry-veteran`          | 숙련자 관점의 작업 방식 점검                                 |
| `decision-analyst`          | 두 선택지의 항목별 점수 비교와 추천                          |
| `opportunity-finder`        | 보유 자원 기반 기회 10가지                                   |
| `thirty-day-coach`          | 30일 학습 계획                                               |
| `habit-system-designer`     | 지속 가능한 실천 시스템                                      |
| `content-deep-analyst`      | 글의 핵심 주장·숨은 전제·실행 항목 분석                      |
| `personal-strategy-advisor` | 6개월 목표를 위한 레버리지와 이번 주 할 일                   |
