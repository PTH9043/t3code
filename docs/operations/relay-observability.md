# relay(중계 서버) 관측성

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

relay Alchemy 스택은 다음과 같은 공유 Axiom 트레이스 설정을 소유합니다.

- `t3-code-relay-traces-prod`, Worker와 모바일 앱, 자사 relay 클라이언트가 함께 사용하는
  OpenTelemetry 트레이스 데이터셋
- `t3-code-relay-otel-ingest-prod`, 데이터셋 스코프로 제한된 Worker 수집 토큰
- `t3-code-mobile-otel-ingest-prod`, 데이터셋 스코프로 제한된 모바일 수집 토큰
- `t3-code-relay-client-otel-ingest-prod`, 데이터셋 스코프로 제한된 자사 relay 클라이언트 수집 토큰
- `t3-code-relay-recent-spans-prod`, 최근 요청 스팬과 엔드포인트 스팬을 보여 주는 뷰

Alchemy 스테이지는 리소스를 격리하기 위해 정제한 스테이지 이름을 뒤에 덧붙이며, 예를 들어 개인
스테이지는 `t3-code-relay-traces-dev-julius`가 됩니다.

평소의 Alchemy 워크플로로 `infra/relay`에서 배포합니다.

```sh
vp run deploy
```

Alchemy는 계정 수준의 Axiom 배포 자격 증명을 자체 제공자를 통해 해결합니다. 런타임에 Worker는
자신의 스코프 수집 토큰만 받습니다. 모바일 클라이언트와 relay 클라이언트는 별도로 프로비저닝된
각자의 스코프 수집 토큰을 사용합니다.

Worker는 Effect의 기본 제공 HTTP 서버 스팬과 함께 엔드포인트 및 데이터베이스 하위 스팬을
내보냅니다. Effect의 OpenTelemetry 익스포터는 시맨틱 HTTP 속성을 `attributes.` 접두사 아래에
저장합니다. 예를 들면 다음과 같습니다.

```apl
['t3-code-relay-traces-prod']
| where name startswith 'http.server'
| extend endpoint = column_ifexists('attributes.http.route', ''),
    customAttributes = column_ifexists('attributes.custom', dynamic({}))
| project _time, name, trace_id, duration,
    ['attributes.http.request.method'],
    ['attributes.url.path'],
    ['attributes.http.response.status_code'],
    endpoint,
    relayOperation = customAttributes['relay']['operation']
| order by _time desc
| limit 200
```

프로비저닝된 뷰도 `attributes.http.route`에서 엔드포인트를 읽습니다. relay 전용 스팬 애너테이션은
`attributes.custom` 아래에 저장되며, `relay.operation`은 내보내는 사용자 지정 속성 중 하나입니다.

에이전트는 이미 종료된 장애를 조사할 때 Cloudflare Worker를 tail 하는 대신 프로비저닝된 뷰나 APL
쿼리를 사용하는 것이 좋습니다. 이 스택은 별도의 쿼리 토큰을 프로비저닝하지 않습니다. 스크립트로
쿼리에 접근해야 하는 대응 담당자는 인가된 계정 수준 `AXIOM_TOKEN`을 `AXIOM_ORG_ID`와 함께
사용하며, 스코프 수집 토큰은 각 생산자를 위한 쓰기 전용 자격 증명으로 유지됩니다.
