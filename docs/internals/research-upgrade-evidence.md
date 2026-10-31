# 연구 기반 변경과 스킬 검증 기록

`t3-research-upgrade`는 조사한 설계를 현재 T3의 재현된 문제와 연결하는 프로젝트 스킬이다. 출처를 읽은 결과, 로컬 실험, 운영 반영을 구분한다. 새 스킬의 존재만으로 이미 열린 모든 세션에 적용됐다고 판단하지 않는다.

검증 기록에는 문제, 출처의 고정 버전·조회 시각, 변경 파일의 이전·이후 SHA-256, 성공한 집중 검사 명령과 로그, 비교 데이터셋, 남은 한계를 남긴다. 새 파일은 이전 해시와 복구 자료가 `null`이며 기존 파일은 정확한 원본을 보관한다. 모델이나 사용자 지침의 변경을 스킬 개선에 끼워 넣지 않는다.

`scripts/verify-research-upgrade.ts`는 기록과 실제 파일의 일치 여부를 읽기 전용으로 확인한다. 명령을 실행하거나 외부 사이트에 접속하거나 스킬을 적용하지 않는다. 성공은 **evidence-consistent**이며 제품 품질·실제 사용 성공·배포 완료의 판정은 아니다. 기록된 성공 코드가 실제 로그와 연결되고, 검증 후 코드가 바뀌지 않았으며 되돌릴 원본과 비교 데이터셋이 맞는지 확인하는 도구다.

## 파일 형식

```json
{
  "version": 1,
  "problem": "재현한 실패와 의도한 수정",
  "sources": [
    {
      "url": "https://github.com/owner/repo/blob/<40자리 commit>/file.ts",
      "revision": "동일한 40자리 commit 또는 공식 문서의 패키지 버전",
      "capturedAt": "2026-10-24T00:00:00.000Z"
    }
  ],
  "files": [
    {
      "path": "후보 작업공간 기준 상대 경로",
      "before": "이전 파일 SHA-256 또는 null",
      "after": "후보 파일 SHA-256",
      "rollback": { "path": "backups/이전 파일", "sha256": "이전 파일 SHA-256" }
    }
  ],
  "checks": [
    {
      "name": "집중 검사",
      "command": "실행한 정확한 명령",
      "exitCode": 0,
      "log": { "path": "tests.log", "sha256": "실제 로그 SHA-256" }
    }
  ],
  "comparisons": [
    {
      "name": "검색·근거 회귀 비교",
      "baseline": { "path": "baseline.json", "sha256": "보고서 SHA-256" },
      "candidate": { "path": "candidate.json", "sha256": "보고서 SHA-256" },
      "datasetHash": "두 보고서에 기록된 동일한 데이터셋 SHA-256"
    }
  ],
  "limitations": ["직접 측정하지 못한 범위"]
}
```

위 예시의 설명용 해시는 실제 값으로 바꾼다. `files.path`는 `--workspace` 내부, 로그·보고서·복구 원본 경로는 manifest 폴더 내부를 가리켜야 한다. 절대 경로, 상위 폴더 이탈과 symlink 이탈을 허용하지 않는다. GitHub `/blob/` 링크는 branch 이름 대신 고정 commit을 사용한다. 공식 문서는 조회 당시 설치 버전을 기록하되, 이 도구가 원격 내용과의 일치를 확인하는 것은 아니다.

```cmd
node scripts/verify-research-upgrade.ts --manifest .t3/review/evidence.json --workspace D:/candidate
```

검색에서는 동일 데이터셋의 근거 보존·제외·경계·토큰·지연을 비교하고, 실제 답변을 생성하지 않았다면 답변 정답률을 주장하지 않는다. 복구에서는 명령 수락 여부·취소·재시작·중복 전달을 대조한다. 재현하지 않은 실패를 해결했다고 표시하지 않고, 검증된 수정만 반복 사용 지침에 반영한다.
