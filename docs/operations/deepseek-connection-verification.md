# DeepSeek 연결 검증 · 2026-09-30

웹·데스크톱의 CLI 계정 설정과 계정 추가 화면에 DeepSeek 전용 연결 창을 제공한다. `deepseek.connect`는 선택한 환경의 서버에서 공식 `https://api.deepseek.com/models`를 호출하며, 정상 응답에서 모델 ID를 읽은 뒤 OpenCode 실행 계정을 저장한다. API 키는 기존 ServerSecretStore 경로를 사용하고 RPC 결과에는 포함하지 않는다. 개인 웹 채팅 로그인 쿠키를 API 인증으로 사용하지 않는다.

인증 실패·잘못된 응답·네트워크 오류에서는 계정을 저장하지 않는다. 연결 확인 중 다른 클라이언트가 추가한 계정은 `providerInstancesToUpsert`를 통해 settings write semaphore 안에서 보존한다. 계정 삭제와 일반 OpenCode API 설정을 통한 키 교체는 기존 계정 제어를 사용한다. 모바일은 설정된 계정의 모델을 소비하며 새 연결 설정 UI는 웹·데스크톱에 제공한다.

집중 테스트는 공식 URL·Bearer 헤더·모델 조회·키의 민감 저장·실패 시 무변경·계정 보존·선택한 원격 환경 라우팅·수락 전 성공 표시 금지를 검사한다. 격리된 실행 서버에서 실제 RPC로 잘못된 키를 공식 DeepSeek 서버에 보내 HTTP 인증 거절 및 계정 미생성을 확인했다. 유효한 사용자의 DeepSeek API 키를 제공받지 않았으므로 실제 계정의 성공 연결과 모델 답변은 아직 실측하지 않았다. 연결 가능한 브라우저 제어 표면이 없어 최종 화면 검사는 컴포넌트 테스트와 서버 RPC로 진행했다.

이 PC의 Gemini CLI는 공식 npm 패키지 `@google/gemini-cli@0.62.0`을 전역 설치했다. T3 PTY를 통한 실제 Google 로그인 URL 생성과 ACP 시작을 검사했다. Google 인증 정보는 인식됐으나 개인 계정에 대한 Google의 `This client is no longer supported for Gemini Code Assist for individuals` 거절을 실측했다. 해당 거절은 프로그램 설정에서 지원 종료로 표시한다. 설치 실패·로그인 실패·상위 서비스의 이용 자격 거절을 구별한다.
