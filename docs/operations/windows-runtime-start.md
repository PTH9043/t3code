# Windows에서 기존 T3 실행·재시작

사용자의 시작·재시작 지시는 실행까지 수행한다. 이 문서는 실행 범위와 검증을 유지하기 위한 운영 절차이며, 도구의 실제 정책 거부를 우회하는 지시가 아니다.

## 범위와 경로

- 이 PC의 사용자 운영 프로젝트: `D:\__NewAutoUsage`, 기존 데이터 홈: `E:\NewAutoUsage`. 새 테스트/워크트리는 자신의 격리된 데이터를 사용한다.
- 웹·백엔드 요청: `node scripts/dev-runner.ts dev`.
- 데스크톱을 포함한 요청: `node scripts/dev-runner.ts dev:desktop`. 데스크톱 모드는 웹 개발 서버와 데스크톱이 소유한 백엔드를 시작한다. 같은 포트·데이터로 두 모드를 중복 실행하지 않는다.
- 모드가 이미 명확하면 다시 묻지 않는다. "전체"를 부하 절감 또는 편의 때문에 다른 모드로 축소하지 않는다.
- `--home-dir`가 필요하면 기존 운영 홈 `E:/NewAutoUsage`를 명시한다. 포트는 `[dev-runner]` 로그를 기준으로 확인한다.

## 운영 중 웹 화면 변경

운영 Vite는 파일을 쓰는 즉시 열린 창의 모듈을 다시 읽습니다. 새 화면은 분리 작업 트리에서 먼저 빌드하고, 운영에 전송할 때는 그 화면이 가져오는 모듈을 먼저 설치합니다. 화면 파일, 라우트 등록, 기존 제어센터에서 화면으로 연결하는 변경은 의존 모듈을 모두 확인한 뒤 반영합니다. 적용 후에는 운영 주소의 경로 목록과 제어센터 모듈 응답을 확인하고 별도 숨김 브라우저에서 화면 렌더링과 오류 표시 여부를 점검합니다.

## 실행 순서

이 사용자는 PowerShell 실행을 금지했다. 이 PC에서 확인된 Python 실행기 `.t3/honey-upgrade-20261011/runtime.py`를 CMD에서 호출한다. 웹·백엔드는 `start --production --mode dev`, 데스크톱 포함은 `start --production --mode dev:desktop`, 현재 상태 확인은 `status --production`을 사용한다. 모드 생략 시 기록된 기존 모드를 유지하며 최초 기본값은 데스크톱 포함이다. 실행기는 정상 `scripts/dev-runner.ts`를 숨김으로 시작하고 `.t3/runtime-launch.json`에 PID·생성 시각·명령·로그를 기록한다. 이미 실행 중인 같은 프로그램을 중복 시작하지 않는다.

프로그램 수정·업그레이드 후 운영 프로그램과 교체하면 항상 Python 실행기의 일반 시작으로 실제 데스크톱 창을 보이게 실행한다. 이전 창이 최소화·숨김 상태였어도 동일하다. 같은 실행 승인을 다시 묻지 않는다. 이 PC의 실행기는 `T3CODE_DESKTOP_START_INACTIVE=true`로 Electron의 `showInactive()`를 호출해 창과 렌더러를 함께 표시하며 포커스를 바꾸지 않는다. 숨긴 Electron 창을 Win32 `ShowWindow`/`ShowWindowAsync`로만 꺼내고 창 존재 여부만으로 정상 표시라고 판단하지 않는다.

분리된 테스트 실행에만 `--background`를 붙인다. 운영 프로그램 교체 후에는 이 옵션을 사용하지 않는다. 이 옵션은 `T3CODE_DESKTOP_START_HIDDEN=true`를 설정하고 비활성 표시보다 우선하므로 검증 창을 사용자 화면에 띄우지 않는다. 검은 화면을 확인할 때는 HTTP 200과 창의 보임 상태에 더해 실제 Electron 렌더러의 내용과 캡처 이미지를 확인한다.

2026-10-22 사용자 요청에 따라 운영 T3는 항상 Windows 관리자 권한으로 실행한다. 예약 작업 `\NewAutoUsage-T3-Administrator`는 현재 사용자 로그인 시 `HighestAvailable`·`InteractiveToken`으로 `scripts/start-runtime-admin.vbs`를 실행한다. VBS는 콘솔을 숨기고 기존 Python 실행기로 web/backend/desktop을 시작하며, 앱 창은 `showInactive()`로 표시한다. 운영 시작에서 관리자 권한을 낮추지 않는다. 일반 권한에서 Python 실행기를 호출하면 같은 예약 작업에 실행을 맡기므로 추가 UAC 창을 직접 띄우지 않는다. 실행 후 실제 메인 Electron과 백엔드의 무결성 수준 `High` 및 포트·창 표시를 확인한다. 분리 테스트의 기존 일반 권한 실행 경로는 유지한다. 이전 2026-10-12의 운영 일반 권한 기본값은 이 사용자 요청으로 대체됐다.

바탕화면·시작 메뉴의 일반 `NewAutoUsage AI 제어센터` 바로가기는 `scripts/request-runtime-admin.vbs`를 통해 같은 예약 작업을 요청한다. 시작프로그램 폴더의 과거 PowerShell 바로가기는 백업 후 제거해 중복 실행을 막았다. 재설정은 작업 XML·현재 실행기·바로가기 백업을 확인하고 수행한다. Windows 재부팅이나 로그아웃은 따로 요청되지 않았다면 수행하지 않으며, 수동 작업 실행 시험과 실제 부팅 시험을 구분해 보고한다.

연결된 git worktree에서는 데이터 홈이 해당 worktree의 `.t3`로 자동 분리되고 포트는 정상 dev runner가 정한다. `--home-dir`로 명시한 경로가 있으면 그 경로를 사용한다. 명시한 데이터 홈의 Electron 프로필은 `userdata/desktop-profile` 아래에 저장하므로 기존 데스크톱과 잠금·쿠키·설정을 공유하지 않는다. 별도 업그레이드 실행은 해당 worktree와 격리 데이터를 사용하고 원래 실행의 PID를 종료하지 않는다.

1. 기존 실행 명령, 데이터 홈, 모드, PID·생성 시각, 포트 소유자를 읽기 전용으로 확인한다. 재시작할 구성과 복구 명령을 확보한다.
2. 재시작이 요청되었고 실행 중이면 신원이 확인된 프로젝트 프로세스만 종료한다. `node.exe`나 경로 문자열만으로 일괄 종료하지 않는다. 단순 시작 요청이면 이미 정상 동작하는 같은 구성은 중복 기동하지 않는다.
3. 필요하지 않은 `APPDATA`·디버깅 포트 설정을 덧붙이지 않는다. 사용자가 선택한 프로필은 유지한다. 실행기는 데스크톱 빌드에 실제 필요한 `node_modules/.bin`과 Node 디렉터리를 자식의 PATH에 추가한다.
4. 아래 표준 진입점으로 기존 실행기를 시작한다. 실행기는 숨김 프로세스, PID·생성 시각과 두 로그 파일을 기록한다. `status`와 준비 완료 로그로 실제 기동을 검사한다. 모드는 1단계에서 확인한 요청 범위를 사용한다.

```cmd
python .t3\honey-upgrade-20261011\runtime.py active-work --production
python .t3\honey-upgrade-20261011\runtime.py start --production --mode dev
rem 데스크톱 포함 요청은 활성 작업 0건 확인·대기 후 1회만 재시작:
python .t3\honey-upgrade-20261011\runtime.py start --production --mode dev:desktop --wait-idle 60
python .t3\honey-upgrade-20261011\runtime.py status --production
```

> **활성 작업 중 재시작 보호 (2026-11-22 추가 — 이중 검증 · Fail-Closed)**: `runtime.py active-work --production`과 `runtime.py start --production`은 `E:\NewAutoUsage\userdata\active-work.json`(실행 중 서버 PID 확인 포함)과 읽기 전용 `state.sqlite?mode=ro`(`workspace_delegations`, `projection_workspace_collaboration_runs`)를 함께 교차 확인합니다. 진행 중인 대화 턴·하위 위임·오케스트라가 1건이라도 있거나, 상태 파일·DB를 판독할 수 없는 경우(Fail-Closed) 종료 코드 `2`(`restartBlocked: true`)로 재시작을 차단합니다. `--exclude-thread <thread_id>`로 호출자 방을 제외할 수 있고, `--wait-idle <초>`(또는 `--wait-drain <초>`)로 활성 작업이 0건이 될 때까지 대기한 뒤 재시작할 수 있습니다. 사용자가 중단을 명시적으로 승인한 경우에만 `--force`를 사용하며, 이때 중단된 작업 목록이 로그에 출력됩니다. 개발·실험 변경은 항상 테스트·빌드·분리 worktree에서 먼저 검증하고, 최종 반영 시에만 운영을 1회 재시작합니다.
>
> **운영 교체 전 의무 부팅 스모크 게이트 (`test:boot-smoke`, 2026-11-22 추가)**: `desktop` 정적 번들 모드로 `runtime.py start --production`을 실행하면, 기존 운영 프로세스를 종료하기 전에 `scripts/boot-smoke.mjs`(`vp run test:boot-smoke`)가 임시 `--base-dir`와 랜덤 루프백 포트에서 `apps/server/dist/bin.mjs serve`를 실제로 1회 기동해 `/.well-known/t3/environment`·`/` HTTP 200과 `Service not found` 0건을 사전 확인합니다. 스모크 검증이 실패하면 종료 코드 `3`(`reason: "boot_smoke_failed"`)으로 기존 운영 프로세스를 건드리지 않고 즉시 차단합니다(비상 복구 시에만 `--skip-boot-smoke` 사용).

5. 로그에서 실제 포트와 준비 완료를 확인하고 웹·백엔드 HTTP 응답을 검사한다. `dev:desktop`이면 데스크톱 메인 프로세스·창 준비 로그도 확인한다. 웹 접속 안내는 현재 실행에서 발급된 `pairingUrl`을 사용한다.
6. 실패하면 실행 전 도구 거부인지, 셸/경로 문제인지, 앱 시작 오류인지 구분한다. 도구 거부의 구체적 사유가 없으면 "원인 미확인"으로 기록한다. 같은 실패를 반복 설명하며 작업을 방치하지 않는다.

## 2026-10-02 자동 실행 등록 기록

2026-10-02에는 시작프로그램 폴더의 `NewAutoUsage.lnk`에서 숨김 PowerShell 실행기를 호출하도록 등록했다. 이 항목은 2026-10-22에 위의 관리자 로그인 예약 작업과 VBS/Python 실행기로 대체했다. 기존 항목은 백업했으며 데이터 홈은 계속 `E:/NewAutoUsage`다.

바로가기의 대상·인자·작업 디렉터리를 다시 읽고 같은 명령을 시험했다. 기존 실행의 PID·생성 시각이 유지됐고 웹·백엔드 HTTP 200 및 데스크톱 창을 확인했다. 검증 기록은 `.t3/autostart-verification.json`이다. 실제 로그아웃·재부팅 시험은 수행하지 않았다.

## 미리 보기 무응답 복구 기록

2026-10-02 실행 로그에서 미리 보기 평가 요청이 약 470.8초 동안 완료되지 않은 것을 확인했다. 서버는 15초 뒤 요청을 시간 초과로 처리했지만 데스크톱 내부 요청은 계속 대기했다. 데스크톱의 브라우저 명령과 초기 연결·정리 명령에 10초 제한을 추가했고 JavaScript 평가에도 브라우저 실행 시간 제한을 전달한다. 응답이 오지 않아도 제어권과 다음 요청이 계속 묶이지 않도록 한다.

기존 실행의 신원을 기록한 뒤 전체 구성을 재시작했으며, 이전 서버 종료로 중단된 대화 두 개가 복구됐다. 이번 시작프로그램 등록으로 화면 멈춤·깨짐이 발생했다고 단정할 근거는 확인하지 못했다. 실제 화면 검증은 별도 사용자 동의 후 수행한다.

## 2026-09-11에 확인한 사실

- 실패 세션 `01a08c95-d07c-7dc2-bd36-00daaf58382d`: 09:03:07, 09:27:20, 09:44:15 KST에 `functions.exec`에서 `tools.exec_command`로 제출한 `Start-Process ... dev:desktop` 요청이 실행 전에 `CreateProcess ... rejected: blocked by policy`로 거부됐다.
- 성공 세션 `01a08df6-2463-7771-b0d4-c04b73d30d55`: 09:58:23 KST에 같은 도구 계열의 `Start-Process ... dev`로 시작했고 웹 5733·백엔드 13773의 HTTP 200을 확인했다. 실행 로그의 데이터 홈은 `E:\NewAutoUsage`였다.
- 두 세션의 저장된 모델·노력 수준·CLI 버전은 `gpt-6-astra`·`xhigh`·`0.154.0`, 승인 정책은 `never`, 샌드박스는 비활성/전체 접근이었다. 모델이나 사용자 권한 차이를 원인으로 단정할 근거가 없다.
- 거부 자체는 사실이지만 구체적인 적용 정책은 확인되지 않았다. 성공 명령과 실패 명령은 실행 모드·추가 환경·세션 맥락이 달라, 어느 차이가 원인인지 확정할 수 없다.
- 당시 `dev:desktop --dry-run` 통과는 구성 해석만 확인한 결과다. 실제 데스크톱 기동 성공의 증거가 아니다.
- 10:13 KST에 디버깅 포트 없이 실제 `dev:desktop`을 시작했을 때 도구 호출은 허용됐으나, 서버 빌드가 `vp`를 찾지 못해 실패했다. 이 세션의 PATH는 15,270자였고, 로컬 도구 디렉터리를 추가해도 실패했다.
- 같은 `cmd /d /c "vp --version"`이 로컬 도구를 포함한 15,330자 PATH에서는 exit 1, 90자 PATH에서는 exit 0이었다. `apps/server/scripts/cli.ts`의 빌드를 셸 경유 `node --run build:bundle`에서 Node로 로컬 Vite+ 진입점을 직접 실행하는 방식으로 수정했고, 원래 긴 PATH 환경에서 두 서버 번들과 웹 자산 복사가 통과했다. 전역 PATH는 변경하지 않았다.
- 이는 실제 재현하고 수정한 Windows 빌드 오류다. 이전 실행 전 `blocked by policy`의 정확한 원인으로 확인된 것은 아니다.
- 수정 후 10:20 KST 실제 `dev:desktop` 실행 검증 통과: 웹 5733 HTTP 200, 백엔드 13773 HTTP 200, `NewAutoUsage AI 제어센터 (개발)` 데스크톱 창 확인. 로그: `.logs/runtime-20260911-101850-371.out.log`. 시작 스크립트의 구성 검사뿐 아니라 실제 전체 실행을 검증했다.
- 사용자에게 전체 실행 대신 빌드된 앱만 제안하거나, 이미 받은 승인을 다시 요구하거나, 미확인 원인을 Auto-review로 단정하는 대응을 반복하지 않는다.

원문 증거: `.t3/orchestra-validation/restart-tool-rejection-evidence.md`. 성공 로그: `.logs/dev-restart-20260911-095823.out.log`.

[공식 Auto-review 문서](https://learn.chatgpt.com/docs/sandboxing/auto-review)는 `approval_policy=never`에서는 검토할 승인 요청이 없다고 설명한다. 실제 활성 방식과 거부 사유를 확인하지 않고 `/approve`를 해결책으로 제시하지 않는다.

## 화면 표시 없이 개발 빌드 반영

워크스페이스의 `.t3/desktop-background.flag`는 비활성 표시를 명시하지 않은 개발 실행을 숨긴다. `T3CODE_DESKTOP_START_INACTIVE=true`인 일반 운영 실행은 남은 표시 파일보다 우선하여 `showInactive()`로 창을 표시한다. 분리 테스트의 명시적인 `T3CODE_DESKTOP_START_HIDDEN=true`는 계속 우선하므로 테스트 창은 표시되지 않는다. 이 표시 파일을 운영 데이터 홈에 쓰지 않는다. 운영 교체 후 창 표시는 항상 수행하되 포커스 변경·입력 주입·최상위 고정은 하지 않는다.

## 재시작해도 업그레이드 방 작업이 이어지는 방식

업그레이드 방의 작업 프로세스는 백엔드와 운영 재시작보다 오래 살아야 한다. 그런데 `vp run`은 자신이 실행한 작업을 Windows 작업 개체(Job Object)에 넣고, `vp`가 끝나면 그 안의 프로세스를 모두 종료한다. `detached`로 띄워도, 작업 개체 이탈 플래그를 줘도 벗어나지 못한다. 2026-11-19 21:27과 2026-11-20 11:52에 운영 재시작이 진행 중이던 작업을 끊은 원인이다.

그래서 Windows에서는 작업 프로세스를 WMI(`Win32_Process.Create`)로 만든다. WMI 서비스가 만들어 주므로 어떤 작업 개체에도 속하지 않는다.

- 실행: `%SystemRoot%\System32\cscript.exe`로 서버와 함께 배포되는 고정 스크립트 `watchdog-wmi-launch.vbs`를 실행한다. 명령줄·작업 폴더·시작 환경 변수는 스크립트 프로세스의 환경 변수로만 넘기고, 창은 항상 숨긴다(`ShowWindow = 0`). `cmd.exe`를 거치지 않으므로 경로의 공백·`&`·`%`·괄호·한글이 그대로 전달된다.
- 시작 환경: 새 프로세스는 `SystemRoot`·`TEMP` 같은 기본 변수와 `NODE_OPTIONS`·`NODE_EXTRA_CA_CERTS`, Electron이면 `ELECTRON_RUN_AS_NODE=1`만 가지고 시작한다. 비밀값은 넣지 않는다.
- 전달: 백엔드가 일회용 이름의 파이프(`\\.\pipe\t3-watchdog-…`)를 열고 연결을 하나만 받는다. 작업 프로세스가 일회용 토큰을 내놓기 전에는 아무것도 보내지 않는다. 토큰이 맞으면 실행 내용(자격 증명 포함)과 백엔드의 환경 변수 전체를 보내고, 작업 프로세스는 그 환경을 적용한 뒤에야 본체 모듈을 불러온다. 파이프 이름과 토큰은 작업 프로세스의 인자로 전달되어 같은 사용자의 다른 프로세스가 볼 수 있지만, 한 번 쓰면 끝나고 몇 초 안에 무효가 된다.
- 대체 규칙: 실행 내용을 한 바이트도 보내기 전에 실패한 경우(스크립트 실행 실패, 프로세스 생성 거부, 만든 프로세스가 연결 없이 종료, 3초 안에 연결 없음)에만 파이프를 닫고 기존 방식(백엔드의 자식 프로세스)으로 한 번 시작한다. 이 경우 작업은 예전처럼 `vp` 종료와 함께 끝난다. 실행 내용을 보낸 뒤 확인 응답이 없으면 다시 시작하지 않고 "확인 불가"로 남긴다. 같은 작업을 두 번 실행하지 않기 위해서다.
- 확인: 새 방식으로 시작한 작업은 `logs/watchdog-worker.log`에 `started outside the backend process tree`로 기록되고, 부모 프로세스가 `WmiPrvSE.exe`다.

작업 프로세스 번들(`dist/watchdog-worker.mjs`)은 운영을 시작할 때 한 번만 빌드된다. 실행 중 감시 빌드는 `dist/bin.mjs`만 다시 만든다. 작업 프로세스 쪽 코드를 고친 뒤에는 운영을 정식으로 다시 시작해야 반영된다.
