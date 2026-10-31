# Windows 탐색기 드롭 재수정 (2026-10-23)

> 후속 상태: 사용자가 이 재수정 이후에도 실제 이미지 드롭 실패를 다시 보고했다. 기능은 미해결이다. 아래 자동 검사 통과와 운영 반영은 실제 탐색기 제스처 성공 확인으로 해석하지 않는다. 최신 확인은 [관제 점검 기록](control-center-audit-2026-10-23.md)의 이미지 드롭 상태를 따른다.

사용자는 2차 업데이트 뒤에도 Windows 탐색기에서 대화·입력창과 왼쪽 프로젝트 목록으로 사진을 끌어놓을 수 없다고 보고했다. 이전의 단위·메시지 주입·렌더러 검사는 실제 탐색기가 드롭 대상을 선택하는 경로를 검증하지 못했다. 이전 완료 보고의 검증 범위가 부족했다.

## 확인한 원인과 변경

- 기존 운영 Electron PID 35432의 표시된 메인 HWND 3544556에 `WS_EX_ACCEPTFILES`와 `OleDropTargetInterface`가 동시에 있었다. Explorer는 Medium, 운영 데스크톱은 High였다. 메시지 필터만 허용하고 Chromium OLE 등록을 남겨 두면 낮은 권한의 탐색기가 OLE 경로를 먼저 선택해 별도 WM_DROPFILES 수신 코드까지 오지 않는다.
- 관리자 토큰인 Windows 메인 창에서만 기존 OLE 대상을 참조 유지한 뒤 등록을 해제해 셸 파일 드롭으로 넘긴다. 일반 권한의 Chromium OLE 동작은 유지한다. 창별 두 파일 전달 메시지 허용 범위와 기존 읽기·크기 제한을 유지한다.
- 앱 내부에서 사용자가 시작한 실제 드래그에는 preload의 비공개 동기 IPC로 기존 OLE 대상을 잠깐 복원한다. 종료·취소·메인 탐색·렌더러 종료 시 외부 파일 수신으로 돌린다. 탭 이동과 파일 멘션 끌기의 기존 경로를 보존하기 위한 처리다. renderer에 파일 경로 읽기 API나 OLE 포인터를 공개하지 않는다. 추가 COM 참조는 창 종료 시 해제한다.
- Windows 수신 시 파일 개수만 로그에 기록한다. 파일명·내용·경로는 기록하지 않는다. 이후 운영 실패가 발생하면 Windows 수신 여부부터 구분할 수 있다.

## 검증

검증 결과와 운영 적용 증거는 `.t3/dragdrop-repair-20261023/`에 보존한다. 실제 사용자 마우스·탐색기 창은 조작하지 않는다. 숨긴 별도 Electron의 OLE 등록 전후, 내부 드래그 복원, 재탐색·재로딩, 한국어 HDROP 해석·해제와 headless 첨부 화면을 확인한다. 이 검사는 실제 탐색기에서 사람이 끌어놓는 물리적 제스처 검사와 구분한다.

- 집중 테스트 5개 파일 46개 통과. 데스크톱 범위 타입 검사, 변경 파일 lint·format 통과.
- 숨긴 관리자 Electron에서 기존 OLE 등록이 있었음을 먼저 확인하고 수정 후 0이 됨을 확인했다. 페이지 이동·재로딩 후에도 유지됐다. 내부 OLE 복원→셸 파일 수신 복귀를 5회 반복하고 한국어 HDROP 경로와 메모리 해제 1회를 확인했다. 창은 숨김, 앞선 작업 창은 유지됐다.
- 분리된 실제 dev:desktop 실행의 HWND와 하위 창도 읽기 전용으로 열거했다. 메인 창의 OLE 등록은 없고 파일 수신 스타일은 유지됐다. 웹·백엔드는 정상 응답했다.
- headless 9개 화면: 네이티브 파일 payload의 프로젝트·대화 첨부, DOM 대화·작성창·현재 프로젝트·다른 폴더 첨부, 기존 초안 복귀, 8개 제한, 좁은 화면. 이미지 로딩 실패·문서 가로 넘침·JavaScript 오류·HTTP 실패 0, AI 작업 전송 0.
- 운영 적용 전후의 원본 해시, 보존한 설정 해시, 정확히 종료한 실행 구성 요소, 적용 후 High 토큰·실제 창 표시·렌더링·OLE 등록 상태는 `promotion.json`, `production-visible-proof.json`, `windows-after.json`, `completion.json`으로 확인한다. PID 생성이나 HTTP만으로 완료 판단하지 않는다.

## 출처

- [Chromium DropTargetWin의 RegisterDragDrop](https://github.com/chromium/chromium/blob/main/ui/base/dragdrop/drop_target_win.cc)
- [Microsoft RevokeDragDrop](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-revokedragdrop)
- [Microsoft RegisterDragDrop](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-registerdragdrop)
- [Microsoft IUnknown_Set의 참조 수명](https://learn.microsoft.com/en-us/windows/win32/api/shlwapi/nf-shlwapi-iunknown_set)
- [Microsoft DragAcceptFiles](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-dragacceptfiles)
