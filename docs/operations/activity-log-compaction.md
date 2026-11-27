# 도구 실행 로그 용량 관리

`state.sqlite`의 대부분은 대화 본문이 아니라 도구 실행 출력이다. 2026-11-15 운영 DB(13.9GB)에서 대화 본문은 약 80MB였고, 약 12GB가 `tool.updated`·`tool.completed` 활동의 출력 원문(명령 출력, MCP 결과, base64 이미지)이었다. 같은 내용이 이벤트 저장소(`orchestration_events`)와 화면용 테이블(`projection_thread_activities`)에 두 번 저장된다.

## 저장 규칙

서버는 도구 활동을 저장하기 전에 `compactActivityData`(`apps/server/src/orchestration/activityDataCompaction.ts`)로 출력을 줄인다.

- 도구 출력에서 2,048자를 넘는 문자열은 앞 512자와 뒤 1,024자만 남기고 가운데에 생략한 글자 수를 적는다.
- 작업 로그에 보이는 명령과 도구 인자(`command`, `arguments`, `input` 아래)는 16,384자까지 그대로 두고, 넘으면 앞 4,096자와 뒤 8,192자를 남긴다.
- 48개를 넘는 목록은 앞 16개와 뒤 24개만 남기고 가운데에 생략한 개수를 적는다.
- 도구 이름, 짧은 결과와 구조는 그대로 둔다. 대화 메시지와 다른 종류의 활동은 건드리지 않는다.

화면에는 16,384자를 넘는 명령·인자만 생략 표시와 함께 보인다. 도구 출력 원문은 원래 클라이언트로 보내지 않는다(`ActivityPayloadProjection`). 생성 이미지는 저장 전의 원본 이벤트에서 첨부 파일로 따로 저장된다. 기억 원문 조회(`activity:` 출처), 대화 내보내기, 다른 AI로 넘기는 인계 원문에서는 긴 도구 출력이 생략 표시와 함께 보인다.

## 이미 쌓인 로그 줄이기

`scripts/compact-activity-log.ts`는 같은 규칙을 기존 행에 적용한다. 여러 번 실행해도 결과가 같다. 줄인 내용은 되돌릴 수 없다.

```cmd
rem 미리 보기: 읽기만 하고 줄어들 용량을 보고한다. 서버가 켜져 있어도 된다
node scripts\compact-activity-log.ts "E:\NewAutoUsage\userdata\state.sqlite"

rem 적용하고 파일 크기까지 줄이기: 서버를 멈춘 뒤 실행한다
node scripts\compact-activity-log.ts "E:\NewAutoUsage\userdata\state.sqlite" --apply --vacuum
```

`--apply`는 다른 프로세스가 DB를 열고 있으면 시작하지 않는다. 서버가 켜진 채로 쓰면 서버의 쓰기가 잠금에 밀려 유실될 수 있다. `--vacuum` 없이 실행하면 파일 크기는 그대로이고 빈 공간만 재사용된다.

`--vacuum`은 새 파일로 다시 만들어(`VACUUM INTO`) 무결성과 모든 테이블의 행 수·rowid, 대화 테이블의 내용 길이를 비교한 뒤 교체한다. 일반 `VACUUM`은 쓰지 않는다. 서버가 메시지·RAG 청크의 rowid를 진행 위치로 저장하는데, 일반 `VACUUM`은 이 번호를 바꿀 수 있다. 교체 전의 파일(이미 줄인 상태)은 `state.sqlite.before-compact`로 남으므로 서버가 정상 시작한 것을 확인한 뒤 지운다.

테이블별 용량은 `node scripts\storage-report.mjs "<state.sqlite>"`로 확인한다. 읽기 전용이다.
