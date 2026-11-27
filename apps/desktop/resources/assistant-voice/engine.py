"""Local voice inference for the monitor assistant.

The process reads one JSON request from stdin and writes one JSON response to
stdout. Model paths are supplied explicitly; no model or dependency is fetched.
"""

import base64
import contextlib
import io
import json
import math
import os
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"


def audio_from_base64(value):
    import numpy as np
    import soundfile as sf

    data = base64.b64decode(value, validate=True)
    if not data:
        raise ValueError("음성 데이터가 비어 있습니다.")
    audio, sample_rate = sf.read(io.BytesIO(data), dtype="float32")
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if audio.ndim != 1 or not audio.size or not np.isfinite(audio).all():
        raise ValueError("유효한 음성 파일을 읽지 못했습니다.")
    return audio, sample_rate


def transcribe(request):
    device = request.get("device", "cpu")
    if device not in ("cpu", "cuda:0"):
        raise ValueError("지원하지 않는 음성 인식 장치입니다.")
    if device == "cuda:0":
        # Load PyTorch's CUDA libraries before CTranslate2 on Windows.
        import torch
        if not torch.cuda.is_available():
            raise ValueError("CUDA 장치를 사용할 수 없습니다.")

    import numpy as np
    from faster_whisper import WhisperModel

    audio, sample_rate = audio_from_base64(request["audio"])
    if sample_rate != 16000:
        import soxr
        expected = math.ceil(len(audio) * 16000 / sample_rate)
        audio = soxr.resample(audio, sample_rate, 16000, quality="HQ")
        if len(audio) < expected:
            audio = np.pad(audio, (0, expected - len(audio)))
        else:
            audio = audio[:expected]
    model = WhisperModel(
        request["model"], device="cuda" if device == "cuda:0" else "cpu",
        compute_type="float16" if device == "cuda:0" else "int8", local_files_only=True,
    )
    segments, _ = model.transcribe(np.ascontiguousarray(audio))
    return {"text": " ".join(segment.text.strip() for segment in segments).strip()}


def clone(request):
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    audio, sample_rate = audio_from_base64(request["audio"])
    device = request.get("device", "cpu")
    if device not in ("cpu", "cuda:0"):
        raise ValueError("지원하지 않는 음성 합성 장치입니다.")
    if device.startswith("cuda") and not torch.cuda.is_available():
        raise ValueError("CUDA 장치를 사용할 수 없습니다.")
    model = Qwen3TTSModel.from_pretrained(
        request["model"], device_map=device, dtype=torch.float32,
        attn_implementation="eager", local_files_only=True,
    )
    reference_text = request.get("referenceText", "").strip()
    wavs, rate = model.generate_voice_clone(
        text=request["text"], language=request.get("language", "Auto"),
        ref_audio=(audio, sample_rate), ref_text=reference_text or None,
        x_vector_only_mode=not bool(reference_text),
    )
    if not wavs or not len(wavs[0]) or not np.isfinite(wavs[0]).all() or not np.any(wavs[0]):
        raise ValueError("음성 모델이 유효한 오디오를 생성하지 못했습니다.")
    output = io.BytesIO()
    sf.write(output, wavs[0], rate, format="WAV")
    return {"audio": base64.b64encode(output.getvalue()).decode("ascii")}


def main():
    try:
        request = json.load(sys.stdin)
        if not os.path.isdir(request["model"]):
            raise ValueError("음성 모델 폴더를 찾을 수 없습니다.")
        with contextlib.redirect_stdout(sys.stderr):
            if request["task"] == "transcribe":
                result = transcribe(request)
            elif request["task"] == "clone":
                if not request.get("text", "").strip():
                    raise ValueError("합성할 답변이 비어 있습니다.")
                result = clone(request)
            else:
                raise ValueError("지원하지 않는 음성 작업입니다.")
        json.dump({"ok": True, **result}, sys.stdout, ensure_ascii=False)
    except Exception as exc:
        json.dump({"ok": False, "error": str(exc)}, sys.stdout, ensure_ascii=False)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
