# P1 대화별 인계 문맥 절약 구현

2026-09-05. `304a9099a`와 기존 작업 트리 위에서 구현했다.
사용자는 **작업 인계 문맥**, **대화별 선택 적용**을 선택했다.
P0 사용량 계측 위에 얹는 보수적인 추출 방식이며, 의미 요약이나 native compaction 구현은 아니다.

## 적용 경로

`thread.meta.update`의 선택 필드 `handoffMode: standard | compact`를 기존 명령·이벤트에
추가했다. migration 058은 `projection_threads.handoff_mode`를 standard로 만든다.
순수 projector, SQL projector, 전체·shell·detail·command snapshot, 공용 client reducer와
shell/detail 병합에 같은 설정을 반영한다. 예전 payload에서 필드가 없으면 꺼짐이다.
예전 서버에는 클라이언트가 설정을 보내지 않도록 조작을 비활성화한다.

ProviderCommandReactor가 기존 조건으로 `contextHandoff`를 결정한 뒤, 사람이 시작한
요청이며 compact인 경우에만 `prepareCompactHandoff`를 부른다. 같은 세션의 후속 요청,
회의·작업 그래프·프로그램이 자체 구성한 automation 요청은 그대로 통과한다.
모델 선택, 추론 옵션, 세션 생성 정책, 재시도·검증 정책은 바꾸지 않는다.

Codex·Claude/Fable·Cursor·Grok·OpenCode·Gemini에 공통으로 적용되는 서버 입력 경로다.
각 adapter에 별도 요약 호출을 넣지 않았다. 실제 CLI별 원문 읽기 권한과 모델 결과 품질은
이번 mock 기반 검증으로 확정하지 않았다. 인계가 발생하지 않는 모델 전환에는 적용하지 않는다.

## 인계 내용과 원문

`conversationHandoff.ts`는 현재 요청의 message ID 이전 기록을 선택한다. 현재 요청과
이후 대기열 메시지는 축소 블록에 넣지 않고 현재 요청을 뒤에 한 번 붙인다.

- 비어 있지 않은 사용자·system 발언 전체를 시간순으로 원문 인용한다. 길이 때문에 자르지 않는다.
- 질문·답변·승인 활동 및 error 활동을 보존한다. 제공자의 답변 수신 통지가 없더라도
  기존 이벤트 저장소의 사용자 답변·승인 요청을 thread/sequence 범위로 읽는다.
- 최근 assistant 발언 두 개와 실패·보류 표기가 있는 과거 발언을 원문 인용한다.
- 최근 제안 계획과 체크포인트를 함께 전달한다. 계획의 구현 여부, 체크포인트 생성,
  테스트 통과를 서로 같은 것으로 취급하지 않는다.
- 나머지 기록은 `messages`, `activities`, `decisions`, `proposedPlans`, `checkpoints`를
  담은 JSON 파일로 보관한다. 이는 T3가 기록한 자료이며 provider의 미보고 내부 기록까지
  복원하는 것은 아니다.

원문 경로는 `<stateDir>/conversation-handoffs/<sha256(threadId)>/<sha256(contents)>.json`이다.
파일 안에 project/thread/current-message 경계를 넣는다. 동일 경로의 내용이 일치하면
재사용하고, 다르면 원래 내용으로 복구한다. 원자적으로 저장한 뒤 실제 읽기와 hash를
확인해야 축소 블록에 참조를 넣는다. 원문은 사용자 메시지나 프로젝트 Git 파일에 삽입하지 않는다.
클라이언트는 기존 환경 연결을 통해 설정과 준비 내역을 읽으며 로컬 경로에 의존하지 않는다.

실패 표기의 정규식은 추가 보존을 위한 휴리스틱이다. 모든 미완료 의미를 알아낸다는
보장이 없다. 인계 지시는 불명확한 과거 결정·실패 원인·구현 세부를 추측하거나 반복하기 전에
원문을 조회하도록 한다. 원문 속 파일·체크포인트는 당시 근거이므로 현재 코드와 대조해야 한다.
원문 스냅샷은 자동 만료시키지 않으며 설정 해제도 기존 참조 파일을 삭제하지 않는다.
반복 전환에 따른 보관 용량 관리와 대화 삭제 시 원문 파일 정리는 후속 운영 범위다.

## 기존 인계를 유지하는 조건

축소 입력이 기존 입력보다 **500자 이상이면서 10% 이상** 짧을 때만 사용한다.
그 외에는 기존 `buildConversationHandoff` 출력을 그대로 쓴다. 비교 기준은 기존의
30개 메시지·메시지당 2,000자·합계 약 16,000자 인계다.

다음 경우에도 기존 방식을 유지한다.

- 요청 메시지 경계를 찾지 못하거나 이전 발언이 streaming 상태인 경우
- 사용자 결정 조회가 실패하거나 1,000건을 넘는 경우
- thread.reverted 이력이 있는 경우: 제거된 결정의 유효 범위를 추측해 되살리지 않는다
- 과거 첨부 자료가 있는 경우
- 원문 JSON이 2,000,000자를 넘거나 저장·읽기·hash 확인에 실패한 경우

기존 방식 자체가 길이를 자르던 문제까지 해결했다고 주장하지 않는다. 절감보다
기존 동작의 유지가 필요한 경우이며 준비 내역에 fallback 사유를 남긴다.

## 측정과 화면

`conversation.handoff.prepared` 활동은 version/status/reason, 비교 전후 글자 수,
감소 글자 수, source hash와 메시지 수만 저장한다. 원문을 활동 payload에 복제하지 않는다.
이 활동은 **준비된 입력**의 기록이며 전송 성공이나 과금 증거가 아니다.
기존 P0의 provider 사용량 기록이 실제 소비 관측이다. 재조회·응답·캐시 효과까지 포함한
절감률과 품질 동등성은 아직 실측하지 않았다.

웹의 사용량 팝업과 이를 감싸는 Electron, 모바일 상세 화면에 켜기·끄기·상태·최근 비교를
제공한다. 추가 설정 메뉴·키바인딩·명령 팔레트 진입점은 만들지 않았다.
environment+thread로 범위를 한정하고 기존 metadata 쓰기 권한을 사용한다.
새 RPC, localhost origin, 주기적 조회 또는 LLM 호출은 추가하지 않는다.
다른 장치의 변경은 기존 shell 이벤트로 반영한다. 비교는 현재 로드된 활동 범위에서 찾는다.

## 검증

이번 변경의 집중 테스트: 서버 90개, 계약 50개, 공용 client 44개, 합계 184개.
명시적 사용자 결정, 오래된 제약, 최근 수정, 실패한 검사, 미완료 계획, 변경 근거,
메시지 경계·대기열 제외, 원문 hash와 손상 복구, 파일 I/O 실패, 큰 기록·첨부·되돌림,
기본 꺼짐·설정 복원·thread 범위·event sequence 경계, opt-in 전환·해제·automation 제외를 검증한다.

ProviderCommandReactor의 기존 session-stop 테스트는 mock 호출 직후 결과를 읽던 경쟁을
worker drain으로 바꿨다. 새 전환 검사는 Deferred 전달 확인과 drain을 사용한다.
실제 모델 호출·브라우저·Electron·모바일 실행 검증은 수행하지 않았다.
서버·웹·client-runtime 타입 검사는 통과했다. 모바일은 이전부터 있던 navigation 타입 오류
67개가 동일하며 새 오류는 없다. 변경 범위 lint에 새 오류·경고는 없고 기존 reducer 테스트의
optional chaining 경고 1개가 남아 있다.
타입·lint 결과와 원본 반영 hash 목록은 작업 복사본 `.t3/handoff-*` 기록에 남긴다.

P2 협업 문맥, P3 검증 재사용, P4 재시도 최적화는 이 변경에 포함하지 않는다.
