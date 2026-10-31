# 사진 기반 계정 전환 업데이트 검증 · 2026-09-30

분석 원본은 `C:\Users\박태현\Downloads\업데이트 할 것.jpg`다. 사진에서 확인된 요구는 Codex 크레딧 잔액 유지, 실제 429의 우선 처리, Claude/Codex 토글 분리, Codex 5시간 표시 제거다. 사진의 잘린 부분과 다른 앱의 설정명·스케줄러를 구현 근거로 추정하지 않았다.

이 저장소에는 기존 자동 계정 전환 스케줄러가 없었다. 서버 권위 설정 `providerAutoSwitch.codex`와 `providerAutoSwitch.claudeAgent`를 추가했고 기본값을 모두 false로 둔다. 부분 patch는 다른 토글을 유지한다. ProviderCommandReactor의 대화 입력 경로에서 계정별 ProviderRegistry의 실제 사용량·설치·인증·모델 목록을 사용한다. Codex weekly allowance, spendable credits, quota unknown 순으로 후보를 정렬한다. 현재 계정에 크레딧이 남으면 weekly exhaustion만으로 교체하지 않는다.

확정된 `thread.session-set`의 error/HTTP 429를 처리한다. 전환은 모델 선택 변경과 활동 기록을 남기며 실패 요청을 재전송하지 않는다. 다음 입력에서 기존 세션을 종료한 후 기존 conversation handoff 경로로 새 로그인 namespace에 세션을 생성한다. 다른 계정의 resume cursor를 넘기지 않는다. 활성 native turn이 있는 계정은 전환하지 않는다. 실패 계정은 변경 불가능한 `provider.account.rate-limited` 활동 사실로 보존하며 최근 5분의 기록을 다시 조회한다. 세션을 교체해 현재 error가 지워져도 제외가 유지된다. Migration 068의 부분 인덱스로 해당 사실만 조회하므로 매 입력마다 전체 대화 이력을 적재하지 않는다. 상태나 선택이 바뀌면 전환 계획을 재평가하고 조회 실패 시 입력을 실행하지 않는다.

테스트는 주간 소진 후 크레딧 유지, 주간 잔여 후보 우선, 429가 unlimited credits보다 우선, 독립 토글, 미지원 모델·미인증 계정 제외, reset 경과, 숫자/문자 잔액, 같은 로그인 경로 제외를 검사한다. 실제 orchestration engine·SQLite projection·worker drain을 사용하는 reactor 테스트는 자동 선택 저장, 모델/effort 유지, 429 후 재전송 없음, 다음 입력의 대화 인계와 resume cursor 미재사용을 검사한다. 하네스 호출은 해당 테스트에서 제어된 어댑터이며 실제 외부 계정에 고의로 429를 발생시키지 않았다.

격리된 실행 환경의 typed RPC에서 토글을 독립적으로 켜고 끈 뒤 원래 설정을 복원한다. 사용자 실행 환경에서는 새 설정 schema의 노출만 읽기 전용으로 확인한다. 브라우저 제어 표면이 없어 실제 클라이언트 화면 검사는 수행하지 못했다. 컴포넌트 렌더링 테스트에서 Codex 주간 표시·크레딧 포맷·Claude 5시간 유지와 원격 환경별 토글 입력을 확인한다. 자연 발생 429와 두 실제 인증 계정 사이 전환은 외부 계정 조건이 갖춰졌을 때 추가 실측할 수 있다.

최종 검증은 관련 17개 테스트 파일의 201개 테스트가 통과했다. 서버·웹·contracts·client-runtime의 `tsgo --noEmit` 검사가 통과했다. `node .t3/provider-auto-switch-check.mjs`로 격리 서버의 독립 토글 patch/복원과 read-only SQLite의 실제 부분 인덱스 사용을 확인했고, 사용자 웹 5733에서 새 설정 모듈 제공과 서버 설정 노출을 확인했다. 실제 브라우저 시각 검사와 실제 두 외부 인증 계정 간 429 전환은 이 결과에 포함하지 않는다.
