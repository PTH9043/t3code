---
name: autonomous-2agent
description: 다중 세션 장기 코딩 작업을 Initializer(기능 체크리스트 생성) + Worker(세션당 1~2개 기능 완결·테스트·체크포인트) 2단계 구조로 안전하게 실행합니다.
argument-hint: "[goal-or-feature-list-path]"
---

# Autonomous 2-Agent Long-Running Harness

Anthropic `claude-quickstarts/autonomous-coding` 패턴을 T3 Code(`AGENTS.md`, `progress.txt`, Vitest/tsgo)에 맞게 경량 이식한 장기 작업 프로토콜입니다.

## 핵심 규칙

- **단일 세션 과욕 금지**: 한 세션에서 모든 기능을 한꺼번에 구현하다 컨텍스트가 오염·절단되는 것을 막습니다.
- **증거 없는 완료 금지**: `passes: true`는 실제 단위/통합 테스트 또는 명령 실행 출력으로 확인된 뒤에만 기록합니다.
- **항상 깨끗한 상태 종료**: 세션 종료 전 실패 중인 테스트, 미정리 임시 파일, 깨진 빌드를 남기지 않습니다.

## 1단계: Initializer 모드 (`feature_list.json` 미존재 시)

1. 사용자 목표를 원자적이고 검증 가능한 기능 단위로 분해해 작업 대상 폴더에 `feature_list.json`을 생성합니다.
   ```json
   {
     "goal": "목표 한 줄 요약",
     "updatedAt": "ISO-8601",
     "features": [
       {
         "id": "F-01",
         "title": "기능 이름",
         "acceptance": ["구체적 통과 조건 1", "검증 명령"],
         "passes": false,
         "evidence": ""
       }
     ]
   }
   ```
2. 기존 `progress.txt`와 `LESSONS.md`를 읽고 충돌 사항이 없는지 확인합니다.
3. 첫 번째 기능(`F-01`)의 기본 테스트 스캐폴드만 준비하거나 바로 Worker 모드로 전환합니다.

## 2단계: Worker 모드 (`feature_list.json` 존재 시)

매 세션/턴 사이클 시작 시:

1. `progress.txt` → `feature_list.json` → `git status --short`를 순서대로 읽어 현재 진척을 파악합니다.
2. `passes: false`인 항목 중 **가장 우선순위가 높은 1~2개**만 선택합니다.
3. 선택된 기능에 대해:
   - 성공 기준 테스트를 먼저 작성하거나 확인합니다.
   - 최소 변경으로 구현합니다.
   - 타깃 테스트 + 타입 체크를 실행해 통과를 확인합니다.
   - 회귀가 없음을 확인한 뒤 `feature_list.json`의 해당 항목만 `passes: true`와 검증 증거(`evidence`)로 갱신합니다. (기존 테스트 삭제·조건 완화 금지)
4. 임시 파일을 모두 삭제하고 `progress.txt`를 `완료 / 진행 중 / 막힘 / 다음` 형식으로 갱신한 뒤 보고합니다.
