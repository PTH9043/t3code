# Google Colab 무료 NVIDIA T4 16GB GPU 오프로드 운영 런북

로컬 PC의 CPU/GPU 자원을 소모하지 않고, Google Colab 무료 티어(NVIDIA Tesla T4 16GB VRAM)를 **보조 추론·임베딩·파인튜닝·TTS 워커**로 T3 Code(`OpenCode` 커스텀 OpenAI 호환 엔드포인트 또는 `workspace_helper`)에 연결하기 위한 운영 절차서입니다.

## 1. 하드웨어 제약 및 실전 생존 스펙 (Tesla T4, Turing `sm_75`)

| 항목               | T4 16GB 제한                                              | 실전 권장 설정                                                                                                               |
| :----------------- | :-------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **연산 정밀도**    | **BF16 네이티브 미지원** (`sm_75`), FP16 Tensor Core 지원 | 반드시 `dtype="float16"` (`--dtype half`) 사용. `bfloat16` 강제 시 소프트웨어 에뮬레이션으로 급격한 속도 저하                |
| **양자화 한계**    | FP8(`sm_89+`) 미지원                                      | 추론: **7B~8B Q4_K_M / AWQ / GPTQ** (KV 캐시 포함 ~7~10GB VRAM) · 14B는 컨텍스트 4K 이하 제한적 운용                         |
| **QLoRA 파인튜닝** | 16GB VRAM                                                 | `bitsandbytes` 4-bit NF4 (`bnb_4bit_compute_dtype=torch.float16`) + `gradient_checkpointing=True` + 7B 기준 `batch_size=1~2` |
| **세션 유지 시간** | 유휴 약 90분 / 최대 약 12시간(변동)                       | **Google Drive 체크포인트 필수** (`save_steps=50~100`, `save_total_limit=2`)                                                 |

> [!WARNING]
> Google Colab 무료 티어는 동적 할당이며, 브라우저 유휴·할당량 초과 시 예고 없이 런타임이 회수됩니다. 운영 필수 백엔드가 아니라 **탄력적 보조 워커(오프로드)** 용도로만 사용하세요.

## 2. T4 OpenAI 호환 추론 서버 + 임시 터널(`cloudflared`) 기동 절차

Colab 노트북 셀에서 GPU 런타임(T4)을 선택한 뒤 아래 순서로 실행합니다.

### 2.1 모델 서버 실행 (예: `llama-cpp-python` 또는 `vLLM --dtype half`)

```python
# 예시: vLLM (T4는 반드시 --dtype half, --enforce-eager, --gpu-memory-utilization 0.85)
!pip install -q vllm
# 백그라운드 실행 (포트 8000, API 키 필수 설정)
import os, subprocess
os.environ["COLAB_API_KEY"] = "t3-colab-ephemeral-key-change-me"
subprocess.Popen([
    "python3", "-m", "vllm.entrypoints.openai.api_server",
    "--model", "Qwen/Qwen2.5-Coder-7B-Instruct-AWQ",
    "--quantization", "awq",
    "--dtype", "half",
    "--max-model-len", "8192",
    "--gpu-memory-utilization", "0.85",
    "--api-key", os.environ["COLAB_API_KEY"],
    "--host", "127.0.0.1",
    "--port", "8000",
])
```

### 2.2 `cloudflared` Quick Tunnel로 임시 HTTPS URL 발급

```bash
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
cloudflared tunnel --url http://127.0.0.1:8000 --no-autoupdate
```

- 출력되는 `https://<random>.trycloudflare.com` 주소를 복사합니다.
- **보안 필수**: 공개 터널 URL이므로 반드시 `--api-key`(Bearer 토큰)를 켜고, 비밀 프로젝트 코드·API 키·개인정보는 전송하지 않습니다(`projectContentAllowed=false` 취급).

## 3. T3 Code 연결 방법

1. **하위 작업/오프로드 모델(`OpenCode` 커스텀 OpenAI 호환 제공자)**:
   - Base URL: `https://<random>.trycloudflare.com/v1`
   - API Key: 위에서 설정한 `COLAB_API_KEY`
   - 용도: 공개 문서 요약, 대량 분류, 번역, 초안 생성 등 비민감 오프로드 작업.
2. **체크포인트 영속화 (파인튜닝/배치 작업)**:
   - `from google.colab import drive; drive.mount('/content/drive')`
   - 출력 디렉터리를 `/content/drive/MyDrive/t3-colab-runs/<job-id>`로 지정해 세션 단절 시 이어서 재개(`resume_from_checkpoint=True`)합니다.

## 4. 트러블슈팅

- `OutOfMemoryError`: `--max-model-len`을 `4096`으로 낮추고 `--gpu-memory-utilization 0.80`으로 조정합니다.
- `BFloat16 is only supported on GPUs with compute capability >= 8.0`: `--dtype half` / `torch.float16`으로 변경합니다.
- 연결 끊김(`502/530`): Colab 런타임 회수 또는 `cloudflared` 종료 상태이므로 T3 설정에서 즉시 로컬 모델(Ollama/EXAONE)로 폴백합니다.
