# 제공자별 문맥 최적화 적용 범위

2026-09-12, 현재 저장소 어댑터와 설치 Grok CLI를 확인한 결과다. API 문서의 기능을 CLI 공통 기능이라고 가정하지 않는다.

| 제공자         | 확인한 소비/캐시 관측                                                                      | native 문맥 기능과 이번 적용                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex          | 기존 total/last 및 cachedInputTokens 정규화 경로 유지                                      | 어댑터의 compact 계열 이벤트를 context_compaction으로 처리한다. 새 API cache-control/tool-search/compaction 명령을 CLI 옵션으로 추가하지 않았다.                                                   |
| Claude / Fable | 기존 SDK usage·cache read/write·하위 작업 사용량 경로 유지                                 | compact_boundary 관측과 기존 permissionMode/canUseTool을 유지한다. allowedTools 빈 배열만으로 모든 도구가 꺼진다고 가정하지 않는다. 별도 native no-tools 모드는 이번 공통 계약에 없음.             |
| Grok           | ACP 실제 요청별 총사용량·cacheRead·reasoning 연결. 2턴과 실제 도구 작업/형식 복구에서 관측 | 설치 1.0.4의 `agent stdio --help`는 debug/debug-file/leader-socket만 제공한다. headless CLI의 다른 옵션을 stdio에 넘기지 않았다. 실제 복구 2건 도구0이지만 native 강제 차단이라고 주장하지 않는다. |
| Cursor         | 이번 감사에서 소비 총량에 해당하는 native 이벤트 연결은 확인하지 못함                      | 기존 어댑터/coverage 표시를 유지한다. 추정 0·가상의 cache hit·도구 차단 옵션을 만들지 않는다.                                                                                                      |
| OpenCode       | 이번 감사에서 소비 총량에 해당하는 native 이벤트 연결은 확인하지 못함                      | 기존 모델 옵션/세션 동작을 유지하고 지원이 확인되지 않은 API 옵션을 노출하지 않는다.                                                                                                               |
| Gemini         | 이번 감사에서 소비 총량에 해당하는 native 이벤트 연결은 확인하지 못함                      | 기존 어댑터/coverage를 유지하며 독립 관측 전 소비값을 채우지 않는다.                                                                                                                               |

`ProviderSessionStartInput`/`ProviderSendTurnInput`과 기존 어댑터 capability는 공통 no-tools/cache-control/tool-search 계약이 아니다. 모델·추론 수준을 바꾸지 않고 T3가 전달하는 텍스트만 선택적으로 조합한다. 제공자 내부의 대화·도구 정의·파일 기억은 최종 입력 문자 영수증의 unknown 영역이다.

S3의 조회 캐시는 이번에 추가하지 않았다. corpus/권한/파일 hash를 생략한 캐시는 허용하지 않으며, 현재 평가만으로 캐시 무효화 체계를 더할 지연 이점이 확인되지 않았다. 원문 artifact는 내용 hash와 프로젝트/실행 범위로 저장하고 실제 파일을 읽어 hash를 확인한 뒤 재사용한다. 같은 이름이더라도 본문이 달라지면 다른 파일이며 훼손된 파일은 복구한다.

현재 T3 소유 MCP 도구는 preview toolkit의 브라우저 작업 중심이다. status와 snapshot을 구분하고 클릭/타이핑 등은 null 결과를 반환하며, evaluate는 임의 JSON을 반환한다. 이번 작업의 실제 browser payload 크기·확장 조회 프로토콜을 검증하지 않은 상태에서 응답을 중간 절단하거나 실시간 화면 상태를 캐시하지 않았다. native CLI의 파일/로그 도구 결과를 T3의 UI 이벤트에서 잘라도 이미 모델에 전달된 토큰은 줄어들지 않는다. 이 경로의 도구 결과 범위 조회는 미구현이며 실제 병목 관측 뒤 별도 계약·권한·원문 재조회 검증이 필요하다.

실제 Grok 파일럿의 명령 완료 이벤트에는 `rawOutput.output_for_prompt`, `output_file`, `total_bytes`, `truncated`, `exit_code`, `current_dir`가 있었다. 협업 검증 사례의 1,577바이트 실패 로그는 truncated=false이고 native 원문 파일 참조가 보존됐다. 이는 해당 CLI가 제공한 출력/원문 정보의 관측이며, T3가 새 출력 제한이나 native 토큰 절감을 구현했다는 뜻은 아니다. 원시 byte 배열을 UI/RAG에 중복 직렬화하는 것은 모델에 이미 전송된 비용을 줄이지 못하므로 실제 결과 집계에는 명령·종료 코드·원문 참조와 요약을 사용한다.

S4의 자동 검사 생략은 추가하지 않았다. 현재 T3는 임의 native 명령의 전체 파일·환경·외부 의존성을 알지 못하므로 이를 같다고 판정할 근거가 없다. 요청된 독립 검증과 외부 상태 검사는 유지한다. 검증을 나중에 재사용하려면 요구사항/관련 파일·diff·lockfile hash, 명령/도구 버전/환경, 결과·로그 참조를 모두 확인해야 하며 하나라도 unknown이면 재실행한다. 현재 구현의 절약 범위는 직접 의존 결과, 완전한 원문 참조, 확인된 중복/선택적 상세 제거다.

근거: `provider/Layers/{Codex,Claude,Grok,Cursor,OpenCode,Gemini}Adapter.ts`, `provider/tokenConsumption.ts`, `provider/acp/GrokTokenUsage.ts`, `provider/acp/GrokAcpSupport.ts`, `mcp/toolkits/preview/{tools,handlers}.ts`, `orchestration/workspaceContextArtifacts.ts`, 실험 디렉터리 `grok-stdio-help.txt` 및 실제 ACP 영수증. 이 문서의 미관측/미구현 항목을 지원 완료로 세지 않는다.
