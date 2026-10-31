# 허브 메모리 — 가능성·적용 여부 조사 (2026-09-12)

목표: NewAutoUsage(T3)에 연결된 폴더(프로젝트)의 프로그램들이 각자 메모리를 복제하지 않고 **허브가 관리하는 메모리를 공유**하게 할 수 있는가, 그리고 T3에 어떻게 붙이는가.

계기: 2026-09-12 이 PC(32 GB)에서 `__OnChainBot` 연구 스크립트 45개가 같은 JSONL을 각자 파싱해 커밋 47 GB(물리 81%, 페이지파일 7 GB)를 점유. 진단 기록은 `__OnChainBot` 장기기억 `knowledge-7f577c43…`, 문헌 조사는 공용 RAG `knowledge-d62506c3…`.

## 1. 결론

| 질문                                                                                 | 답                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 허브 프로세스가 힙(Python dict)을 소유하고 다른 프로그램이 그 객체를 쓰게 할 수 있나 | **불가.** 프로세스 주소공간은 분리돼 있고 CPython 객체는 재배치 불가라 공유 메모리에 놓을 수 없다. Windows는 fork(copy-on-write)도 없다.                                                                                                     |
| 허브가 데이터를 **한 벌**만 메모리에 올리고 모든 프로그램이 그걸 쓰게 할 수 있나     | **가능.** 데이터를 언어 중립 바이트 레이아웃(Arrow IPC)으로 파일에 두고 각 프로그램이 파일 매핑으로 연다. Windows 섹션 객체가 물리 페이지를 1벌로 공유하므로 "OS 페이지 캐시 = 허브 메모리"가 된다. 허브 프로세스가 죽어도 리더는 영향 없음. |
| 허브가 프로그램들의 메모리 사용을 **통제**할 수 있나                                 | **가능.** Job Object `ProcessMemoryLimit`/`JobMemoryLimit`(커밋 하드캡, 초과 시 할당 실패) + `NotificationLimit`(소프트 경보) + 동시 실행 슬롯. 파일 매핑 페이지는 커밋에 안 잡히므로 공유 데이터 계층과 충돌하지 않는다.                    |
| T3에 붙일 수 있나                                                                    | **가능하나 3곳을 손봐야 한다.** 프로그램 스키마(예산·데이터셋 필드), 스폰 경로(Job Object 없음, 환경변수 값 주입 불가), 텔레메트리(RSS만, 커밋 없음). 아래 §4.                                                                               |

## 2. 실측 PoC (이 PC, 2026-09-12)

스크립트: 세션 스크래치패드 `hubpoc/poc.py` (pyarrow 25.0.1, polars 1.44.2, psutil). 입력: `E:\memescan-data\forensics\crime_surge_entry_20260909\chain_wallet_research\20260910T004050839699Z\individual_wallet_replay\development_positions.jsonl` (119 MB, 46,250행, 37컬럼).

| 항목                    | 원본 방식 `list[dict]` (memescan `prefix()` 그대로) | Arrow IPC + `pyarrow.memory_map`                                    |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| 리더 1개 커밋(private)  | **506 MB** (파일의 4.3배)                           | **32 MB** (인터프리터+pyarrow 기본 16 MB 포함 → 데이터 몫 ≈16 MB)   |
| 리더 1개 USS(고유 상주) | 502 MB                                              | 28 MB — 파일 페이지는 USS에 없음 = 공유됨                           |
| 로드 시간               | 5.5 s                                               | 0.03 s                                                              |
| 리더 3개 동시 커밋 합   | 1,518 MB (시스템 커밋 +1,050 MB 실측)               | 96 MB (시스템 커밋 −13 MB, 노이즈)                                  |
| 변환 비용               | —                                                   | JSONL→IPC 2.0 s, 파일 63 MB(원본의 0.53배), 변환기 피크 577 MB(1회) |

외삽(2026-09-12 실제 부하, 리더 45개): dict 방식 ≈ 리더당 0.5~7 GB → 47 GB(실측) / Arrow 방식 ≈ 리더당 30~100 MB + 공유 파일 1벌(원본 JSONL 총 ~17 GB의 0.3~0.5배, 페이지 캐시에서 필요한 부분만 상주) → **수 GB 이내**. 리더가 `.to_pylist()`/`.to_pydict()`로 되돌리면 팽창이 그대로 복귀하므로 컬럼/배치 접근이 전제다.

## 3. 방식 선택 (문헌 조사 요약, 출처는 공용 RAG 항목 참조)

1. **Arrow IPC(Feather v2, 무압축) + `pa.memory_map`** — 1순위. 허브 프로세스 불필요, 코드 변경은 "dict 순회 → 컬럼/RecordBatch 접근"으로 국한.
2. LMDB — 키→레코드 랜덤 액세스가 주 패턴일 때. Windows는 `map_size` 즉시 선할당.
3. SQLite WAL + `mmap_size` — 의존성 0이어야 할 때의 차선.
4. Arrow Flight 허브 — 중앙 서버가 질의를 처리해야만 할 때. 로컬에서도 복사 발생.

- 탈락: Plasma(Arrow 12에서 제거), Ray(Windows beta·재구조화 필요), Redis/Dragonfly(복사 모델), Vaex(비활성), `multiprocessing.shared_memory`(바이트만, Windows는 마지막 핸들 닫히면 소멸 → 허브 상주 강제).

## 4. T3(AutoUsage) 적용 설계

### 4.1 현재 구조에서 확인한 사실 (file:line은 2026-09-12 기준)

- 프로그램 스폰: `apps/server/src/orchestration/Layers/WorkspaceProgramSupervisor.ts:730` `startProgram` → `cmd.exe /d /s /c <command>`를 node-pty(ConPTY)로 실행(`:249`, `:768-777`, `terminal/NodePtyAdapter.ts:142-161`). **Job Object·taskkill 없음** → 손자 프로세스 생존 보장 없음(`stopProgram :863-901`은 SIGTERM→SIGKILL 후 "survived" 로그).
- 환경변수는 이름 허용목록만 통과(`programEnvironment :256-279`) → 허브가 계산한 값(데이터셋 경로)을 프로그램에 넘길 통로가 없음.
- 텔레메트리: Rust 사이드카(`native/resource-monitor/src/main.rs:423-424`)가 RSS·virtual만 수집, **커밋(private bytes) 없음**. 모니터링 `memory` 메트릭은 `residentBytes` 합(`WorkspaceMonitoringReactor.ts:192-223`).
- 프로그램 스키마(`packages/contracts/src/orchestration.ts:1370-1392`)에 자원 한도·데이터셋 필드 없음. 최신 마이그레이션 065, 패턴은 `050_ProjectionWorkspaceProgramIntegrity.ts`.
- 자율 액션은 `restart/stop/start-program`, `repair-run`뿐(`executePlaybooks :660-720`).

### 4.2 세 계층

**A. 공유 데이터 계층 (허브 = 변환·게시자)**

- 프로젝트별 "공유 데이터셋" 등록: `{name, sourceGlob(JSONL), outputPath(.arrow), schemaPolicy}`. 변환기: `polars.scan_ndjson(...).sink_ipc()` 또는 DuckDB `read_ndjson`→IPC. 갱신은 새 파일 쓰기 후 이름 교체(`atomicWrite.ts` 재사용; 열린 매핑은 truncate 불가). 소스 append 감시 → 증분 재생성.
- 프로그램에는 `T3_HUB_DATASET_<NAME>=<path>`와 `T3_HUB_MANIFEST=<json>`으로 전달 → `programEnvironment`를 "허브 계산값 주입"까지 확장.
- 프로그램 측 어댑터(예: memescan `hub_dataset.open(name)` → `pa.memory_map`+`ipc.open_file`; 환경변수 없으면 기존 JSONL 경로로 폴백).

**B. 메모리 예산 계층 (허브 = 통제자)**

- 스키마: 마이그레이션 066 `memory_budget_json` `{commitLimitMb, softLimitMb, concurrencySlots}` + `shared_datasets_json`.
- 강제: Windows Job Object가 필요 → T3 스폰 경로에 가드 삽입. 권장: 기존 Rust 사이드카(`native/resource-monitor`)에 "job 하위 스폰 + 한도 + 통지 수신" 명령 추가(이미 Rust·프로세스 트리 인지). 차선: Python/ctypes 가드(`__OnChainBot/memescan/resource_guard.py`의 구조 — 필드는 이미 선언, 플래그 0x100/0x200만 추가). 부수 효과로 손자 프로세스 kill 문제도 해결(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
- 텔레메트리에 커밋(private bytes) 추가 → 모니터링 `memory` 메트릭을 커밋 기준으로도 판단. 플레이북 액션 추가: `pause-program`(상태 저장 후 종료, 슬롯 반납), `queue-start`(슬롯 대기).
- 동시 실행: `start_policy`에 슬롯 게이트 — 슬롯 초과 시 큐잉, 에이전트가 "전부 재기동"해도 예산 안에서만 뜬다.

**C. 프로그램 측 수정 (memescan 예)**

1. 즉시(코드 몇 줄, 효과 최대): 폴링 루프 재파싱 제거(`crime_wallet_research_resume.py:95-96`), 한 프로세스 내 3중 로드 제거(`crime_flap_cost_swing_comparison.py:107-111`).
2. `resource_guard.py` ProcessMemoryLimit(예 3 GB) + 소프트 통지.
3. `prefix()` 호출부를 허브 데이터셋 어댑터로 교체(50개 스크립트가 같은 헬퍼를 쓰므로 헬퍼 1곳 + 순회 코드).
4. `time.sleep(3)` 대기 루프 → 상태 저장 후 종료, 허브 트리거로 `--resume`.

### 4.3 제약·주의

- Windows는 spawn만 있음(fork 상속 트릭 불가). 파일 매핑을 리더가 잡고 있으면 truncate 불가 → 원자적 이름 교체만.
- 레코드마다 스키마가 다른 JSON 필드는 `string`(원문) 컬럼으로 두고 필요 시 파싱.
- Job 한도는 커밋만 셈. 초과 시 Python `MemoryError` → 소프트 한도로 먼저 경보.
- 허브 프로세스(T3 서버)가 죽어도 리더는 영향 없음(파일 매핑). 허브가 담당하는 건 변환·예산·스케줄이지 메모리 소유가 아니다.

## 5. 권고 순서

1. C-1(재파싱 제거)과 B의 `resource_guard` 한도 — 하루 안에 가능, 즉시 수 GB 회수.
2. A 최소판: 변환기 CLI + memescan 어댑터 + 폴백 — 리더 커밋 16× 감소(PoC).
3. T3 통합: 066 마이그레이션, 환경변수 주입, 사이드카 Job/커밋 지원, 플레이북 액션.
4. C-4 대기 루프 제거·슬롯 큐잉.

## 6. 구현 상태 (2026-09-12, 같은 날 착수 — 사용자 결정: 4단계 전부)

| 단계 | 내용                                                                                                                                                                            | 상태                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 0    | 연구 트리 136개 종료(postgres_server 유지, 가용 물리 4.7→25.9 GB), 스레드 "초기 매수 지갑 추적 검증" 중단                                                                       | 완료                         |
| 1    | memescan `prefix()` 증분 캐시, `resource_guard.py` 프로세스별 커밋 캡(`MEMORY_HARD_CAP_MB`=3072)                                                                                | 완료, 테스트 6               |
| 2    | `ops/hub_convert.py` + `memescan/hub_dataset.py`(mmap 베이스+tail, `RowIndex`), `crime_flap_block_capture_resume.py` 전환                                                       | 완료, 실측 2,554→659 MB      |
| 3    | T3: contracts `WorkspaceProgram.hubMemory`, 마이그레이션 066, 저장소·decider, 수퍼바이저 env 주입·Windows Job 가드(PowerShell `-EncodedCommand`)·동시 실행 슬롯 큐, 제어센터 폼 | 완료, 테스트 11, 라이브 검증 |
| 4    | memescan `hub_wait.pause()`(허브 아래에선 exit 75로 슬롯 양보) 33개 사이트/32개 파일, T3가 exit 75를 양보로 처리·60 s 후 재기동                                                 | 완료, 테스트                 |

라이브 검증(15:55 KST): 제어센터에서 `__OnChainBot`에 프로그램 "허브 메모리 검증 프로브"(커밋 256 MB, 그룹 research/슬롯 1, 데이터셋 `PROBE=requirements.txt`) 등록·시작 → 로그에 `T3_HUB_DATASET_PROBE`, `T3_HUB_MEMORY_HARD_CAP_MB=256`, `T3_HUB_YIELD_ON_WAIT=1`, `T3_HUB_MANIFEST`, `T3_HUB_GUARDED_COMMAND` 출력 후 600 MB 할당이 **`MemoryError: commit cap enforced`**로 실패(종료 코드 3 전파, 스왑 없음).

미구현(후속): 텔레메트리 커밋(private bytes) 메트릭(Rust 사이드카), 모니터링 플레이북 `pause-program`, 대기 루프 재기동 트리거(현재는 60 s 타이머), 재시도 백오프 사이트(`retry_pending` 등)는 의도적으로 sleep 유지.

## 7. 재현

```
python -m venv hubpoc && hubpoc\Scripts\pip install pyarrow psutil polars duckdb
hubpoc\Scripts\python -X utf8 poc.py run <jsonl> <out.arrow> 3
```

`poc.py`: `convert`(polars→Arrow IPC 무압축), `reader-dict`(`prefix()` 동일), `reader-mmap`(`memory_map`+`open_file`+전 컬럼 터치), 자식 트리 합산(private/rss/uss; venv `python.exe`는 런처 스텁이라 자식 합산 필수).

## 8. 기능 점검 및 수정 (2026-09-12)

- Windows 가드는 정지 상태로 자식 생성 → Job 편입 → 실행 재개 순서로 변경했다. 기존 시작 후 편입 사이에 자식이 실행되던 경쟁 조건을 없애고 실패·종료 경로에서 핸들을 정리한다. 근거: [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw), [CREATE_SUSPENDED](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags).
- 슬롯 대기를 `starting` 실행 기록으로 표시해 중지할 수 있게 했다. 대기 양보 타이머는 실행 ID로 식별하며 중지·삭제·비활성화 뒤 재기동하지 않는다. 입장 시 최신 프로그램 정의를 조회하고, 그룹의 가장 작은 슬롯 제한을 사용한다. 재시작은 이전 프로세스의 종료 처리가 끝난 뒤 실행한다. 서버 종료 중에는 대기 프로그램을 새로 시작하지 않는다.
- 폼은 잘못된 데이터셋 행을 버리던 동작을 없애고 중복 이름·경로·숫자를 검사한다. 그룹만 입력하면 슬롯 1개를 기본 적용한다. API 명령도 중복 데이터셋 이름과 그룹 없는 슬롯 설정을 거부한다. 기존 프로그램 스냅샷과 구형 클라이언트 명령 호환 테스트를 추가했다.
- MemeScan 공유 리더는 빈 Arrow 베이스에 추가된 행의 인덱스 오류와 JSON 파싱 실패가 캐시에 일부 행을 남겨 중복시키는 오류를 재현 후 수정했다.
- 검증: T3 집중 테스트 10파일 50개 통과(개발 중 분할 실행한 서로 다른 테스트 합계). Windows 실제 프로세스 및 ConPTY에서 종료 코드 75·출력 전달, 256 MiB 한도 아래 8 MiB 할당 성공 / 384 MiB 커밋 실패, 가드 중지 시 자식 종료 확인. MemeScan 허브 리더·대기 테스트 9개 통과. 서버·웹·contracts 타입 검사 통과. 집중 lint 오류 없음(수퍼바이저의 기존 경고 2개 유지). 브라우저 조작 및 운영 서버 재시작은 수행하지 않았다.
- 적용 범위: 웹·데스크톱은 같은 제어센터와 서버를 사용한다. 모바일에는 전용 설정 화면이 없으며 서버의 슬롯/가드 동작이 공통 적용된다. provider 어댑터와 무관한 프로그램 실행 기능이며 경로 해석은 선택한 서버에서 수행한다. 원격/터널 클라이언트도 같은 실행 기록을 받는다. 실제 데이터 공유는 변환 파일과 이를 읽는 프로그램 어댑터가 있는 경로에만 적용된다.

## 9. C++ 운영 경로 전환 (2026-09-12)

사용자는 위 점검에 이어 C++ 전환 및 결과의 RAG 저장을 지시했다. 이 절이 앞선 PowerShell 가드·Python 문자열 인덱스 설명을 대체한다. 데이터 본체는 기존 Arrow IPC mmap을 유지한다. JSON은 설정·매니페스트와 변환 이후의 저널 tail에 남으며, 데이터 접근에 JSON RPC 서버를 추가하지 않는다.

- Windows 가드는 `native/hub-memory/guard.cpp`의 사전 빌드 C++ 실행 파일로 교체했다. suspended 생성 → Job 편입 → resume, 프로세스별 커밋 제한, kill-on-close, 표준 입출력·종료 코드 전달을 유지한다. 서버 빌드가 `dist/hub-memory/win32-<arch>`에 포함하고 Windows 데스크톱 패키징도 대상 아키텍처를 빌드한다. 배포 파일이 없으면 실행 실패로 표시하며 제한 없이 우회 실행하지 않는다. x64 실제 실행을 검증했으며 arm64 설치 패키지는 실행 검증하지 않았다.
- MemeScan `RowIndex`는 동일 Python 프로세스의 C++/Arrow 확장에서 문자열 해시·중복 제거·행 선택을 처리한다. 문자열 바이트는 수명이 보장된 Arrow 버퍼에서 참조하며 tail 컨테이너는 immutable tuple로 고정한다. null·중복·Unicode·내장 NUL·청크/슬라이스·추가행 동작을 보존한다. 숫자 키나 확장이 없는 환경은 Python 경로로 호환하며 `.backend`로 확인한다. Python/PyArrow 업그레이드 시 다시 빌드해야 한다.
- 첫 C++ 시제품은 느렸다. 해시와 예약 용량을 개선하고 반복 `Table.take`를 행 선택 마스크+기존 배치 순회로 바꾼 뒤 아래 결과를 얻었다. 반환 행을 전부 Python 리스트로 모으는 호출자는 여전히 객체 메모리를 사용한다.

| 측정 대상                                                     |  이전 중앙값 |  C++ 중앙값 |
| ------------------------------------------------------------- | -----------: | ----------: |
| 가드 시작, `exit /b 0`, 교차 순서 각 10회                     |    268.89 ms |    21.36 ms |
| 인덱스 생성, 10만 행·64바이트 키·중복 10%, 새 프로세스 각 3회 |     22.88 ms |    17.33 ms |
| 전체 값 순회, 같은 데이터                                     |     59.67 ms |    47.69 ms |
| 행 조회 100회                                                 |     1.143 ms |    1.467 ms |
| 인덱스 생성의 private bytes 증가                              | 19,853,312 B | 9,986,048 B |

위 수치는 제한된 합성 벤치마크다. 가드 시작 개선을 전체 연구 처리량 12.6배 개선으로 해석하지 않는다. 개별 조회는 100회당 약 0.32 ms 느려졌다. 원시 측정값: 이 저장소 `native/hub-memory/target/startup-benchmark.json`, MemeScan `native/hub-memory/target/index-benchmark.json`. 데이터 결과는 모든 실행에서 일치했다.

운영 경로 검증 중 두 기존 오류도 수정했다. node-pty Windows는 명명된 SIGTERM/SIGKILL 인자를 거부하므로 어댑터에서 인자 없는 종료로 변환한다. 1초 로그 저장 제한에 걸린 마지막 출력은 후속 출력 없이도 타이머와 worker를 통해 저장한다. 종료된 실행의 로그 타이머는 실행 ID로 무효화한다.

17:12 KST 실제 운영 서버의 WebSocket 명령으로 임시 프로그램을 등록·시작했다. 배포된 `dist/hub-memory/win32-x64/t3-hub-guard.exe` PID와 `backend=cpp`를 확인했고, 512 MiB 한도에서 8 MiB 할당 성공 / 768 MiB 커밋 거부 / mmap 결과 일치를 검증했다. 중지 뒤 가드·Python 자식 소멸, 상태 `exited`, 임시 프로그램 삭제를 확인했다. 초기 256 MiB 프로브는 OpenBLAS 초기화 메모리가 부족해 실패했으므로 최종 프로브는 수학 연산이 없는 조건에서 BLAS 스레드 1개와 512 MiB를 사용했다. 운영 연구 설정은 변경하지 않았다. 증거: `.t3/hub-native-verification/live-result.json`.

검증: C++ 전환·로그·PTY 관련 T3 4파일 24개 및 MemeScan 3파일 18개 통과. 서버·빌드 스크립트 타입 검사, Python ruff 통과. 집중 lint 오류 없음(수퍼바이저 기존 경고 2개). Windows node-pty의 종료 후 콘솔 목록 보조 프로세스에서 `AttachConsole failed` 진단이 발생할 수 있으나 가드와 자식 종료 및 실행 상태 전환은 실제 확인했다. 웹 5733·백엔드 13773 HTTP 200, 데스크톱 창 정상. 기존 개발 실행기의 자동 재빌드로 적용했으며 전체 연구 작업을 강제 재시작하지 않았다. 브라우저를 조작하지 않았다.

RAG 저장 확인(17:18 KST): 기존 공용 기록 3개에 현재 C++ 운영 결론을 반영했고 `hub-native-audit-2026-09-12`(환경 공용), `hub-native-memescan-2026-09-12`(OnChainBot 프로젝트)를 추가했다. 5개 항목 모두 저장 내용 일치·검색 성공, OnChainBot에서 공용 기록 조회 및 에이전트 프롬프트 구성 반영 확인. 기록은 애플리케이션 API로 저장했다. 영수증: `.t3/hub-native-verification/rag-result.json`.

## 10. 행 디코딩 추가 성능 개선 (2026-09-12)

사용자가 추가 성능 개선을 지시했다. C++는 이미 x64 기계어로 컴파일되어 실행된다. 이번에는 행을 한 건 읽을 때마다 `Table.slice().to_pylist()`로 중간 테이블·목록을 만들던 비용을 제거했다. MemeScan `native/hub-memory/rows.h`의 C++ 행 디코더가 primitive 컬럼을 최종 Python dict로 변환한다. 전체 순회는 선택 마스크를 먼저 적용하고 최대 2,048행 단위로 반환하며 전체 디코드 결과를 캐시하지 않는다. 기존 `RowIndex.get`, 인덱싱, `values/items` 호출에 자동 적용된다.

복합·시간·decimal·dictionary·extension 타입의 의미는 PyArrow가 유지한다. 이 경로의 단건 조회도 캐시한 컬럼에서 scalar를 읽는다. `Dataset.row_backend`와 `RowIndex.backend`를 별도로 확인할 수 있다. 옛 확장이나 확장 없는 환경도 호환한다. 운영 Python/PyArrow 환경으로 `.pyd` 재빌드 완료; 기존 연구 프로세스는 다음 시작부터 새 코드를 읽는다.

| 기존 C++ 버전 대비 중앙값 |                         2컬럼 |                          19컬럼 |
| ------------------------- | ----------------------------: | ------------------------------: |
| 조회 1,000회              |      8.532 → 1.419 ms (6.0배) |      61.816 → 5.897 ms (10.5배) |
| 전체 순회                 | 45.767 → 33.326 ms (27% 감소) | 176.026 → 101.279 ms (42% 감소) |
| 리더+인덱스 초기화        |              16.22 → 16.75 ms |                17.95 → 17.20 ms |
| 초기화 private bytes 증가 |       9,838,592 → 9,945,088 B |         9,924,608 → 9,920,512 B |

10만 행·64바이트 키·중복 10%의 primitive 합성 데이터, variant별 새 프로세스 5회, 교차 실행 순서이며 출력 checksum은 모두 같았다. 이전 C++ 문자열 인덱스를 유지한 상태에서 비교했다. 원시 시행 값·소스 해시: MemeScan `native/hub-memory/target/row-benchmark.json`. 이 수치를 전체 연구 처리량 개선으로 해석하지 않는다.

집중 테스트 51개 통과(허브 46, 실제 소비 코드 5), 핵심 Python ruff 통과. 17:35 KST 운영 서버의 임시 프로그램에서 `backend=cpp`와 `rowBackend=cpp`, mmap 결과, 512 MiB 캡, 중지 후 가드·Python 소멸 및 임시 프로그램 삭제를 확인했다. 웹·백엔드 HTTP 200과 데스크톱 창 정상. 거래·데이터·실행 설정은 변경하지 않았다. 증거: `.t3/hub-native-verification/row-live-result.json`.

RAG 갱신 확인(17:39 KST): 기존 공용 장기기억·공용 상세 RAG·OnChainBot RAG 3건에 개선 결과와 이전 단계 구분을 반영했다. 저장 내용 일치·검색·다른 프로젝트 공용 조회·소유 프로젝트 프롬프트 구성을 확인했다. 영수증: `.t3/hub-native-verification/row-rag-result.json`.
