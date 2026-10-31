# Windows 파일 드롭 위치 인식 수정 — 2026-10-24

운영 앱에서 파일 수신 이후 `renderer.rejected / no-target`가 반복됐다. 사용자가 좌표 기록을 켠 뒤 재현한 네 번의 이벤트는 뷰포트 1674×1387에서 (-119,1184), (-50,1007), (38,941), (-102,933)으로 전달됐다. 마지막 이벤트는 파일 네 개였다. 파일 읽기 오류가 아니라 첨부할 화면 요소를 선택하지 못한 경우다.

Windows 수신기는 이제 원래 `WM_DROPFILES` 메시지를 처리하는 시점에 `GetMessagePos()`를 캡처한다. 그 위치의 실제 HWND가 해당 앱 창 또는 자식이고 클라이언트 영역 안에 있는 경우, 이 좌표를 루트 클라이언트 좌표로 변환하여 사용한다. 파일 읽기 뒤의 현재 커서를 조회하지 않는다. 다른 앱 위의 위치나 숨겨진 테스트 창은 전달받은 HDROP 좌표를 유지한다. 이후 기존 DPI 및 Electron 확대 배율 변환을 적용한다. 가상 데스크톱의 음수 화면 좌표는 부호를 유지한다.

IPC 수신 확인에는 좌표·뷰포트 크기와 좌표 출처(`message` / `payload`)가 남는다. 파일 경로나 내용은 이 진단에 기록하지 않는다. DOM 대상 선택, 프로젝트 구분, 모달 차단, 화면 이동 중 드롭 거절, 첨부 제한은 기존 규칙을 사용한다. 위치를 못 찾았다고 임의의 프로젝트에 파일을 넣지 않는다.

검증은 별도 Windows 네이티브 좌표 회귀 실행 파일, 관련 TypeScript 테스트·타입·lint, 숨겨진 Electron의 실제 컴파일된 preload 및 네이티브 파일 수신 경로로 진행한다. 자동 검증은 사용자의 마우스나 키보드를 조작하지 않는다. 운영 재현 로그와 자동 테스트의 재현 범위는 구분해 기록한다.

근거: [GetMessagePos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getmessagepos), [DROPFILES](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/ns-shlobj_core-dropfiles), [DragQueryPoint](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-dragquerypoint).

작업 증거: `.t3/drop-target-coordinates-20261024/`. 원본 소스 해시 및 진단만 먼저 반영한 웹 파일을 별도로 보관한다. 운영 교체 후 같은 입력 사진의 실제 드롭 성공 여부는 새 운영 수신 로그의 `renderer.queued`, `composer.rendered`, `image.loaded`로 판단한다.
