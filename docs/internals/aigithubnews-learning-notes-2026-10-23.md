# AI GitHub News 주요 저장소 학습 노트

T3와 가까운 35개 저장소의 README를 우선 검토했다. 아래 적용 항목은 현재 T3 구조에 대한 개발 제안이며, 외부 제품의 성능을 T3에서 재현했다는 뜻이 아니다. 원문은 commit·Git blob ID·SHA-256과 함께 보관했다. 7개 저장소에서는 관련 코드·테스트 표본도 읽었다. 외부 테스트를 실행하거나 새 의존성을 설치한 결과는 아니다.

P1은 다음 개발에서 먼저 대조할 자료, P2는 해당 단계의 보조 자료, P3는 요구가 생기면 검토할 자료, P4는 역사·이전 안내를 보존할 자료다. 전체 보관 목록은 [저장소 목록](aigithubnews-repositories-2026-10-23.md), 진행 순서는 [발전 계획](aigithubnews-learning-plan-2026-10-23.md)을 따른다.

## 기억과 검색

### mem0

**P1** · [mem0ai/mem0](https://github.com/mem0ai/mem0/blob/2c81af3bbe27d9bccb09c772d583df9e9be72ee5/README.md) · 기준 commit `2c81af3bbe27` · [채널 출처](https://t.me/aigithubnews/13973)

학습 항목: 사실 추출과 추가 저장, 키워드·의미·개체 신호의 결합

T3 적용 후보: 사용자 발언·에이전트 보고·검증 결과를 구분한 한국어 기억 평가와 검색 순위 비교

README의 관리형 플랫폼 평가 점수는 공개 SDK 또는 T3의 성능을 보장하지 않는다.

추가로 읽은 자료: [main.py](https://github.com/mem0ai/mem0/blob/2c81af3bbe27d9bccb09c772d583df9e9be72ee5/mem0/memory/main.py), [test_temporal_feature_notice.py](https://github.com/mem0ai/mem0/blob/2c81af3bbe27d9bccb09c772d583df9e9be72ee5/tests/memory/test_temporal_feature_notice.py).

### graphiti

**P1** · [getzep/graphiti](https://github.com/getzep/graphiti/blob/345e73161a61b0a4400f80c64e5bba6a584acb7b/README.md) · 기준 commit `345e73161a61` · [채널 출처](https://t.me/aigithubnews/13553)

학습 항목: 사실의 유효 시점과 원본 episode를 연결하는 시간 기반 기억

T3 적용 후보: 예정·완료·기한·취소와 정정 전후를 구분하고 현재 질문과 과거 질문의 정답을 따로 평가

그래프 저장소를 추가하기 전에 기존 lineage와 revision으로 표현할 수 있는지 확인한다.

추가로 읽은 자료: [temporal_edge_utils.py](https://github.com/getzep/graphiti/blob/345e73161a61b0a4400f80c64e5bba6a584acb7b/graphiti_core/utils/maintenance/temporal_edge_utils.py), [test_temporal_edge_utils.py](https://github.com/getzep/graphiti/blob/345e73161a61b0a4400f80c64e5bba6a584acb7b/tests/utils/maintenance/test_temporal_edge_utils.py).

### cognee

**P2** · [topoteretes/cognee](https://github.com/topoteretes/cognee/blob/37f788bd287750e10d7610173e5332b3843f6ebd/README.md) · 기준 commit `37f788bd2877` · [채널 출처](https://t.me/aigithubnews/13264)

학습 항목: 자료 수집·구조화·검색을 나눈 기억 처리 과정

T3 적용 후보: 자료 변경을 재색인과 연결하고 데이터셋별 출처를 유지하는 수집 단계를 비교

로컬 실행 예제도 모델 다운로드와 추가 런타임이 필요할 수 있다.

### letta

**P4** · [letta-ai/letta](https://github.com/letta-ai/letta/blob/8816d3a8516893bfdc0fa14bfb1235226012e295/README.md) · 기준 commit `8816d3a85168` · [채널 출처](https://t.me/aigithubnews/2070)

학습 항목: 상태를 유지하는 에이전트와 장기 기억의 역사적 설계

T3 적용 후보: 기억 수명과 대화 상태 모델의 비교 자료로 보관

현재 README는 기존 V1 서버를 retired로 설명하고 활성 소스를 letta-ai/letta-code로 안내한다.

### claude-mem

**P1** · [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem/blob/dcb28a768c6be4b8e451843210558275caa8ec44/README.md) · 기준 commit `dcb28a768c6b` · [채널 출처](https://t.me/aigithubnews/15096)

학습 항목: 검색 목록을 먼저 받고 필요한 원문만 읽는 단계별 기억 조회

T3 적용 후보: 기존 memory v2의 history·read·export에서 출처를 유지하며 전달량과 정답률을 함께 평가

현재 README의 observer·호스팅·가입 흐름과 로컬 기능을 구분한다. T3의 기존 provider를 바꾸지 않는다.

### onyx

**P2** · [onyx-dot-app/onyx](https://github.com/onyx-dot-app/onyx/blob/345b1e5986780e52ebb7ed79fcd507744c405f73/README.md) · 기준 commit `345b1e598678` · [채널 출처](https://t.me/aigithubnews/15082)

학습 항목: 여러 자료원을 색인하고 질문에 맞는 근거를 고르는 지식 계층

T3 적용 후보: 자료 갱신·삭제를 색인 상태와 연결하고 검색 결과의 원본 추적을 보강

루트 LICENSE는 일반 영역 MIT와 ee 영역의 별도 Enterprise 조건을 구분한다.

추가로 읽은 자료: [LICENSE](https://github.com/onyx-dot-app/onyx/blob/345b1e5986780e52ebb7ed79fcd507744c405f73/LICENSE).

### LightRAG

**P2** · [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/README.md) · 기준 commit `aaebfe1bb8d5` · [채널 출처](https://t.me/aigithubnews/14196)

학습 항목: 청킹 방식과 검색 모드·재순위화의 조합

T3 적용 후보: 현재 청킹과 후보 선택을 고정 정답셋으로 비교하고 검색 근거를 평가 결과에 포함

그래프 추출·재순위화에 드는 모델 호출과 지연을 포함해 판단한다.

### ragflow

**P1** · [infiniflow/ragflow](https://github.com/infiniflow/ragflow/blob/7d188e1abef4668a725c8b6de4a901ef43f93843/README.md) · 기준 commit `7d188e1abef4` · [채널 출처](https://t.me/aigithubnews/14372)

학습 항목: 문서 분석·청크 확인·원문 인용을 연결하는 검색 경험

T3 적용 후보: 한국어 PDF·표·OCR·코드 자료에서 답변의 근거 위치를 확인하는 평가를 구성

현재 T3의 로컬 OCR과 청킹은 이미 존재한다. 새 서버 도입보다 실패 사례 대조를 먼저 한다.

### cortexdb

**P2** · [liliang-cn/cortexdb](https://github.com/liliang-cn/cortexdb/blob/a591ae127517e62f52a7db9db137354143e5b72a/README.md) · 기준 commit `a591ae127517` · [채널 출처](https://t.me/aigithubnews/15091)

학습 항목: SQLite 기반 기억·검색과 작은 목차에서 시작하는 조회

T3 적용 후보: 자료 전체를 프롬프트에 넣지 않고 항목을 선택해 읽는 현재 구조를 비교

Go 기반 구현을 그대로 도입하면 런타임 경계가 추가되므로 현재 SQLite·Node 경로부터 측정한다.

### akm

**P1** · [itlackey/akm](https://github.com/itlackey/akm/blob/724a974a9b62f1876d17ee002abe0729ce04ffe2/README.md) · 기준 commit `724a974a9b62` · [채널 출처](https://t.me/aigithubnews/15095)

학습 항목: 기존 스킬·지식 자산을 제자리에서 색인하고 피드백을 수정 제안으로 연결

T3 적용 후보: 스킬별 출처·버전·사용 결과·회귀 평가와 되돌리기 기록을 남기는 개선 절차

검색에 적중한 외부 자산을 곧바로 실행하지 않는다. 설치 예제의 PowerShell 경로는 이 PC에서 사용하지 않는다.

## 에이전트 실행과 작업 흐름

### langgraph

**P1** · [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph/blob/9d68e5b3eb1a63027b05e9f0152149ea0284dcdb/README.md) · 기준 commit `9d68e5b3eb1a` · [채널 출처](https://t.me/aigithubnews/14430)

학습 항목: 체크포인트 저장소의 멱등성·범위 분리·삭제 규약

T3 적용 후보: 현재 receipt·복구 장벽에 중복 이벤트·재시작·취소·다른 스레드 보존 사례를 대조

새 실행 엔진을 넣기 전에 기존 이벤트 원장과 worker drain으로 검증한다.

추가로 읽은 자료: [README.md](https://github.com/langchain-ai/langgraph/blob/9d68e5b3eb1a63027b05e9f0152149ea0284dcdb/libs/checkpoint-conformance/README.md), [test_put_writes.py](https://github.com/langchain-ai/langgraph/blob/9d68e5b3eb1a63027b05e9f0152149ea0284dcdb/libs/checkpoint-conformance/langgraph/checkpoint/conformance/spec/test_put_writes.py), [test_delete_thread.py](https://github.com/langchain-ai/langgraph/blob/9d68e5b3eb1a63027b05e9f0152149ea0284dcdb/libs/checkpoint-conformance/langgraph/checkpoint/conformance/spec/test_delete_thread.py).

### mastra

**P2** · [mastra-ai/mastra](https://github.com/mastra-ai/mastra/blob/cf0ca8b55d67a3ccf6ee7835e4dd2addea0c82a8/README.md) · 기준 commit `cf0ca8b55d67` · [채널 출처](https://t.me/aigithubnews/14961)

학습 항목: TypeScript 작업 흐름의 저장된 상태와 suspend·resume

T3 적용 후보: 작업 상태·사용자 입력 대기·재개 시점과 관측 정보를 현재 상태 모델에 대조

코어 Apache-2.0과 ee 영역 Enterprise 조건을 구분한다.

추가로 읽은 자료: [LICENSE.md](https://github.com/mastra-ai/mastra/blob/cf0ca8b55d67a3ccf6ee7835e4dd2addea0c82a8/LICENSE.md).

### autogen

**P4** · [microsoft/autogen](https://github.com/microsoft/autogen/blob/004749e6b7102c8fd317b9b1499ce5807223c278/README.md) · 기준 commit `004749e6b710` · [채널 출처](https://t.me/aigithubnews/739)

학습 항목: 다중 에이전트 메시지·실행 구조의 역사적 비교 자료

T3 적용 후보: 현재 실행 모델과의 차이를 기록하고 신규 도입 후보는 Microsoft Agent Framework로 검토

README는 유지보수 종료를 선언하지만 조회 당시 GitHub isArchived는 false였다. 문서와 코드 라이선스도 구분한다.

추가로 읽은 자료: [LICENSE](https://github.com/microsoft/autogen/blob/004749e6b7102c8fd317b9b1499ce5807223c278/LICENSE), [LICENSE-CODE](https://github.com/microsoft/autogen/blob/004749e6b7102c8fd317b9b1499ce5807223c278/LICENSE-CODE).

### agent-framework

**P2** · [microsoft/agent-framework](https://github.com/microsoft/agent-framework/blob/a8e284ca8ce7c2a6b4a4641ef35e131d75a5cda3/README.md) · 기준 commit `a8e284ca8ce7` · [채널 출처](https://t.me/aigithubnews/15072)

학습 항목: 체크포인트·스트리밍·중간 사용자 입력을 포함하는 작업 흐름

T3 적용 후보: provider 전환과 재개 뒤에도 원래 권한·대기 상태가 유지되는 시나리오를 평가

Python·.NET 중심 구현이며 T3의 Effect 기반 오케스트레이션 대체는 별도 필요성으로 판단한다.

### deer-flow

**P1** · [bytedance/deer-flow](https://github.com/bytedance/deer-flow/blob/cc013c96808e68ca99338841dd2ba997076e826d/README.md) · 기준 commit `cc013c96808e` · [채널 출처](https://t.me/aigithubnews/14967)

학습 항목: 긴 작업에서 자료·산출물·기억·샌드박스의 역할 분리

T3 적용 후보: 노드 결과에 근거·산출물·미완료 사항을 연결하고 작업 종료 조건을 검증

현재 2.0은 1.x와 다른 구현이다. 과거 문서의 경로와 동작을 그대로 가정하지 않는다.

### OpenHands

**P2** · [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands/blob/6be67b820bc3272ed50e19d16d6f97e981c443ef/README.md) · 기준 commit `6be67b820bc3` · [채널 출처](https://t.me/aigithubnews/14781)

학습 항목: 개발 UI와 에이전트 실행·샌드박스 사이의 책임 분리

T3 적용 후보: 로컬·원격 환경에서 실행 상태와 산출물 참조가 같은 의미를 갖는지 점검

README의 저장소 경계를 확인하고 클라이언트와 SDK의 기능을 혼동하지 않는다.

### rowboat

**P2** · [rowboatlabs/rowboat](https://github.com/rowboatlabs/rowboat/blob/31931b32dc22345703aa9781d5e337fe6ef9eef4/README.md) · 기준 commit `31931b32dc22` · [채널 출처](https://t.me/aigithubnews/15127)

학습 항목: 사용자가 읽고 고칠 수 있는 장기 지식과 개인·공유 공간의 구분

T3 적용 후보: 자동 생성 기억에 원문·수정 이력·공유 범위를 드러내는 현재 기능을 평가

외부 검색·MCP 연결은 선택 기능이다. 저장만으로 새 외부 전송이나 계정 연결을 켜지 않는다.

## 평가와 관측

### promptfoo

**P1** · [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo/blob/b678d240d8f1426bee776ff24c34252baa564e17/README.md) · 기준 commit `b678d240d8f1` · [채널 출처](https://t.me/aigithubnews/14932)

학습 항목: 같은 질문으로 검색 설정을 비교하고 고정 검사와 모델 채점을 구분

T3 적용 후보: 한국어 RAG·작업 성공·토큰·지연을 동일 조건으로 비교하는 평가 명세

모델 채점은 변동과 호출 비용을 기록하고 고정 정답 검사를 우선한다.

추가로 읽은 자료: [README.md](https://github.com/promptfoo/promptfoo/blob/b678d240d8f1426bee776ff24c34252baa564e17/examples/eval-rag-full/README.md), [promptfooconfig.with-asserts.yaml](https://github.com/promptfoo/promptfoo/blob/b678d240d8f1426bee776ff24c34252baa564e17/examples/eval-rag-full/promptfooconfig.with-asserts.yaml).

### langfuse

**P1** · [langfuse/langfuse](https://github.com/langfuse/langfuse/blob/c83198b03f6b63e7d57c0daf016bb4d3ab052913/README.md) · 기준 commit `c83198b03f6b` · [채널 출처](https://t.me/aigithubnews/15046)

학습 항목: 실행 trace·평가 데이터셋·사용자 피드백을 연결

T3 적용 후보: 실행 원장과 평가 결과를 run·turn·노드 식별자로 연결해 회귀 원인을 찾게 한다

관측용 새 서버는 실제 진단 수요가 확인될 때 검토한다. 원본 대화의 외부 전송은 별도 선택이다.

### opik

**P1** · [comet-ml/opik](https://github.com/comet-ml/opik/blob/ec65c464a0ee7cbfed45d52da6c16491dc42aee1/README.md) · 기준 commit `ec65c464a0ee` · [채널 출처](https://t.me/aigithubnews/15024)

학습 항목: 데이터셋 버전과 실험 결과를 비교하는 평가 모델

T3 적용 후보: 실패 사례를 재현 fixture로 만들고 평가셋 변경과 구현 변경을 분리해 기록

자동 최적화 점수만으로 운영 변경을 채택하지 않는다.

추가로 읽은 자료: [DatasetVersionDiff.java](https://github.com/comet-ml/opik/blob/ec65c464a0ee7cbfed45d52da6c16491dc42aee1/apps/opik-backend/src/main/java/com/comet/opik/api/DatasetVersionDiff.java).

### llm

**P2** · [simonw/llm](https://github.com/simonw/llm/blob/aebaca27f9acb6cc56ba4b33ab81e08d6dcb3bc3/README.md) · 기준 commit `aebaca27f9ac` · [채널 출처](https://t.me/aigithubnews/405)

학습 항목: 프롬프트·응답·임베딩을 재현 가능한 로컬 기록으로 다루는 CLI

T3 적용 후보: 서로 다른 provider의 입력·응답과 자료 버전을 비교하는 작은 연구 기록 형식

T3의 실제 CLI 이벤트와 별도 실험 호출의 사용량을 섞지 않는다.

### asqav-sdk

**P3** · [jagmarques/asqav-sdk](https://github.com/jagmarques/asqav-sdk/blob/23a159f9a7fd4f6c08226be1eac4f7a1a8beb805/README.md) · 기준 commit `23a159f9a7fd` · [채널 출처](https://t.me/aigithubnews/15080)

학습 항목: 실행에 서명된 영수증과 확인 범위를 붙이는 모델

T3 적용 후보: 기존 receipt가 증명하는 실행·검증 범위를 문서화하고 외부 감사를 요구할 때 서명 가능성을 비교

SDK는 Elastic License 2.0, verifier와 conformance는 Apache-2.0이며 서명 서비스는 별도다. 서명은 작업 결과의 정확성을 증명하지 않는다.

추가로 읽은 자료: [LICENSE](https://github.com/jagmarques/asqav-sdk/blob/23a159f9a7fd4f6c08226be1eac4f7a1a8beb805/LICENSE).

## 개발 도구와 작업실

### emdash

**P1** · [generalaction/emdash](https://github.com/generalaction/emdash/blob/5bebb2e842f31e61b338c04054b106ed4d046887/README.md) · 기준 commit `5bebb2e842f3` · [채널 출처](https://t.me/aigithubnews/14200)

학습 항목: 작업실 준비 파일과 prepare·setup·run의 의존 순서

T3 적용 후보: 준비 실패·취소·재시작 전에 Owner 실행을 허용할 조건과 필수·선택 자산을 구분

upstream은 clone 실패 뒤 gate를 여는 사례가 있다. T3의 필수 자산 실패 정책을 명시해서 대조한다.

추가로 읽은 자료: [activation-gate.test.ts](https://github.com/generalaction/emdash/blob/5bebb2e842f31e61b338c04054b106ed4d046887/packages/core/src/runtimes/workspace-registry/node/activation-gate.test.ts).

### pi-app

**P1** · [justhil/pi-app](https://github.com/justhil/pi-app/blob/6cf93eb218ea06b90f74f24eb86690e83625ec3a/README.md) · 기준 commit `6cf93eb218ea` · [채널 출처](https://t.me/aigithubnews/15089)

학습 항목: turn·session·working tree별 변경 검토와 세션 트리

T3 적용 후보: 변경 범위 표시·hunk 검토·분기와 원문으로 돌아가는 흐름의 사용성 개선

기존 checkpoint·diff를 재사용하고 binary·rename·공백·한글 경로를 포함해 검증한다.

추가로 읽은 자료: [completion-preview.test.ts](https://github.com/justhil/pi-app/blob/6cf93eb218ea06b90f74f24eb86690e83625ec3a/packages/shared/completion-preview.test.ts), [diff-model.test.ts](https://github.com/justhil/pi-app/blob/6cf93eb218ea06b90f74f24eb86690e83625ec3a/packages/shared/diff-model.test.ts).

### happy

**P2** · [slopus/happy](https://github.com/slopus/happy/blob/d6b85a0dda14c9582e1f083539fd11d99924022f/README.md) · 기준 commit `d6b85a0dda14` · [채널 출처](https://t.me/aigithubnews/13825)

학습 항목: 모바일·relay·desktop·agent runtime의 경계와 세션 연속성

T3 적용 후보: 기기 전환 때 대기 질문·취소·provider identity가 일관되게 전달되는지 평가

현재 저장소는 모바일·원래 CLI·relay이며 desktop과 agent는 별도 저장소다.

### happier

**P1** · [happier-dev/happier](https://github.com/happier-dev/happier/blob/f3ce78a2bf15784f6b136a61cfc6b2734693c5ad/README.md) · 기준 commit `f3ce78a2bf15` · [채널 출처](https://t.me/aigithubnews/13875)

학습 항목: 기존 세션 이어받기·provider 전환·대기 메시지와 기기 간 작업 연속성

T3 적용 후보: 재개 후 빠진 문맥만 보충하고 기존 권한·질문·계획 선택과 결과 이력을 보존하는 회귀 사례

원격·암호화·다중 계정 범위는 각자의 계약으로 검토하고 기능 이름만으로 동일하다고 보지 않는다.

### vibe-kanban

**P3** · [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/README.md) · 기준 commit `d5cbb5380fa0` · [채널 출처](https://t.me/aigithubnews/11003)

학습 항목: 작업 보드·작업실·변경 검토를 연결하는 화면

T3 적용 후보: 작업 목록과 실제 진행 상태·검증 결과가 함께 보이는 흐름의 비교

이전 조사에서 확인한 운영사 종료·커뮤니티 전환 공지는 별도 최신 상태 확인 대상이다. 최근 push만으로 유지보수 수준을 판단하지 않는다.

### oh-my-pi

**P2** · [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/README.md) · 기준 commit `0b5c27ab2471` · [채널 출처](https://t.me/aigithubnews/14950)

학습 항목: 도구 결과·문맥·작업실을 연결한 코딩 에이전트 경험

T3 적용 후보: 도구 결과 스키마·실패 근거·문맥 구성의 검토 항목을 추출

규칙 주입·자동 재시도·작업 분배를 이 PC의 권한·화면 보호 지시보다 우선시키지 않는다.

## MCP와 스킬

### superpowers

**P2** · [obra/superpowers](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/README.md) · 기준 commit `2ce8aa15d05b` · [채널 출처](https://t.me/aigithubnews/1278)

학습 항목: 계획·구현·검증에 쓰는 조합 가능한 개발 스킬

T3 적용 후보: 필요한 검증 근거와 작업 크기에 맞는 절차를 스킬별로 정리

일괄 승인 절차나 모든 작업의 TDD를 강제하지 않는다. 현재 사용자 선택과 저장소 검증 범위를 유지한다.

### agent-skills

**P2** · [mblode/agent-skills](https://github.com/mblode/agent-skills/blob/0f66c31875ef924d65b79772d4d5093fe91f18c2/README.md) · 기준 commit `0f66c31875ef` · [채널 출처](https://t.me/aigithubnews/15081)

학습 항목: 설계·문서·PR 검토·UI 검증을 나눈 품질 기준

T3 적용 후보: 화면이나 산출물 검토 시 확인할 항목을 선택적으로 재사용

브라우저·화면 조작을 자동 실행하지 않는다. 현재 요청은 자료 수집과 계획 수립이다.

### context7

**P1** · [upstash/context7](https://github.com/upstash/context7/blob/d980242a5b04be30ae8804124a8be259bcc2a227/README.md) · 기준 commit `d980242a5b04` · [채널 출처](https://t.me/aigithubnews/15019)

학습 항목: 라이브러리와 버전을 지정해 공식 문서·예제를 조회

T3 적용 후보: 의존성 버전·확인 날짜·출처를 연구 기록에 남겨 오래된 API 사용을 줄인다

기존 MCP와 CLI 경계를 확인하고 새 계정이나 API 키 설정을 임의로 추가하지 않는다.

### CopilotKit

**P2** · [CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit/blob/b4cb0efc414bf7fe8b0fefd10d7db3160de62f4c/README.md) · 기준 commit `b4cb0efc414b` · [채널 출처](https://t.me/aigithubnews/15118)

학습 항목: 에이전트 상태·도구 결과·사용자 입력을 연결하는 여러 클라이언트의 UI

T3 적용 후보: 웹·데스크톱·모바일의 작업 상태와 도구 결과 표시 계약을 대조

새 UI 프로토콜을 추가하기 전에 기존 contracts와 client-runtime의 표현력을 확인한다.

## 로컬 모델과 추론

### jan

**P3** · [janhq/jan](https://github.com/janhq/jan/blob/ae1e73f4a127d668682117ef16fa77eb3b2b90b5/README.md) · 기준 commit `ae1e73f4a127` · [채널 출처](https://t.me/aigithubnews/15102)

학습 항목: 로컬 모델·클라우드 모델·MCP를 함께 다루는 데스크톱 경험

T3 적용 후보: 로컬 모델 준비 상태와 실행 실패를 설명하는 화면의 비교

로컬 실행과 클라우드 연결을 구분하며 GPU·모델 다운로드를 이번 작업에서 시작하지 않는다.

### ollama

**P2** · [ollama/ollama](https://github.com/ollama/ollama/blob/5e31438d5d2223d8338595b366b7434ef3539708/README.md) · 기준 commit `5e31438d5d22` · [채널 출처](https://t.me/aigithubnews/14942)

학습 항목: 로컬 추론·임베딩 서버의 모델 수명과 API

T3 적용 후보: 이미 사용하는 로컬 임베딩의 오류·대기·모델 미설치·재시작 사례를 평가

현재 모델·endpoint와 동시 실행 한도를 유지하고 새 모델은 측정 필요성으로 선택한다.

### litellm

**P3** · [BerriAI/litellm](https://github.com/BerriAI/litellm/blob/f2118fc7670ba3fa736d9b8f4deef9077a45a720/README.md) · 기준 commit `f2118fc7670b` · [채널 출처](https://t.me/aigithubnews/14867)

학습 항목: provider별 API 기능·사용량·비용·실패 분류의 통일

T3 적용 후보: 현재 provider 어댑터의 사용량 누락·추정 비용·오류 분류 대조표

일반 영역 MIT와 enterprise 조건을 구분한다. 구독 CLI의 native 세션을 API gateway로 대체하지 않는다.

추가로 읽은 자료: [LICENSE](https://github.com/BerriAI/litellm/blob/f2118fc7670ba3fa736d9b8f4deef9077a45a720/LICENSE).
