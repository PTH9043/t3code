import { useEffect, useRef, useState } from "react";

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const data = new ArrayBuffer(44 + buffer.length * 2);
  const view = new DataView(data);
  const write = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + buffer.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, buffer.length * 2, true);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
    buffer.getChannelData(i),
  );
  for (let i = 0; i < buffer.length; i++) {
    const sample = Math.max(
      -1,
      Math.min(1, channels.reduce((sum, channel) => sum + (channel[i] ?? 0), 0) / channels.length),
    );
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return data;
}

function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export async function toWavBase64(blob: Blob): Promise<string> {
  if (blob.size > 25 * 1024 * 1024) throw new Error("음성 파일은 25 MiB 이하여야 합니다.");
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (decoded.duration > 120) throw new Error("음성 파일은 2분 이하여야 합니다.");
    const wav = encodeWav(decoded);
    if (wav.byteLength > 25 * 1024 * 1024) throw new Error("변환된 음성은 25 MiB 이하여야 합니다.");
    return toBase64(wav);
  } finally {
    await context.close();
  }
}

type VoiceStatus = {
  paths: { python: string; whisper: string; qwen: string; script: string; sample: string };
  python: boolean;
  whisper: boolean;
  qwen: boolean;
  script: boolean;
  sample: boolean;
};

export function AssistantVoiceInput({
  text,
  sendMode,
  onTranscript,
  onBargeIn,
}: {
  text: string;
  sendMode: "confirm" | "auto";
  onTranscript: (value: string) => void;
  onBargeIn?: () => void;
}) {
  const [status, setStatus] = useState("");
  const [paths, setPaths] = useState<VoiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [referenceText, setReferenceText] = useState("");
  const [playing, setPlaying] = useState(false);
  const [running, setRunning] = useState(false);
  const [recoverableRecording, setRecoverableRecording] = useState<Blob | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const player = useRef<{ context: AudioContext; source: AudioBufferSourceNode } | null>(null);
  const alive = useRef(true);
  const cancelled = useRef(false);
  const runningRef = useRef(false);
  const microphoneActive = useRef(false);
  const microphoneAttempt = useRef(0);
  const recordingToken = useRef<string | null>(null);
  const latest = useRef({ sendMode, onTranscript });
  latest.current = { sendMode, onTranscript };
  const recordTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const releaseRecording = (expectedToken?: string) => {
    const token = recordingToken.current;
    if (expectedToken && token !== expectedToken) return;
    recordingToken.current = null;
    if (token) void window.desktopBridge?.endAssistantVoiceRecording?.(token).catch(() => {});
  };

  const check = async () => {
    try {
      const result = await window.desktopBridge?.getAssistantVoiceStatus?.();
      if (alive.current) setPaths(result ?? null);
    } catch (error) {
      if (alive.current) setStatus(`음성 경로 확인 실패: ${String(error)}`);
    }
  };
  useEffect(() => {
    alive.current = true;
    void check();
    return () => {
      alive.current = false;
      microphoneAttempt.current++;
      if (runningRef.current) {
        cancelled.current = true;
        void window.desktopBridge?.cancelAssistantVoice?.();
      }
      if (recordTimer.current) clearTimeout(recordTimer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      recorder.current = null;
      stream.current = null;
      microphoneActive.current = false;
      releaseRecording();
      player.current?.source.stop();
      void player.current?.context.close();
    };
  }, []);

  const transcribe = async (recorded: Blob) => {
    if (runningRef.current || microphoneActive.current) return;
    cancelled.current = false;
    runningRef.current = true;
    setRunning(true);
    setBusy(true);
    setStatus("녹음을 로컬에서 전사하고 있습니다.");
    try {
      const audio = await toWavBase64(recorded);
      if (cancelled.current) throw new Error("음성 작업이 취소되었습니다.");
      const result = await window.desktopBridge?.runAssistantVoice?.({ task: "transcribe", audio });
      if (cancelled.current) throw new Error("음성 작업이 취소되었습니다.");
      if (!result?.ok || !result.text) throw new Error(result?.error || "전사된 내용이 없습니다.");
      if (!alive.current) return;
      latest.current.onTranscript(result.text);
      setRecoverableRecording(null);
      releaseRecording();
      setStatus(
        latest.current.sendMode === "auto"
          ? "자동 전송 상태를 아래에서 확인하세요."
          : "전사 내용을 작성란에 추가했습니다. 확인한 뒤 전송하세요.",
      );
    } catch (error) {
      if (alive.current) setStatus(`전사 실패: ${String(error)} 녹음을 다시 전사할 수 있습니다.`);
    } finally {
      runningRef.current = false;
      if (alive.current) {
        setBusy(false);
        setRunning(false);
      }
    }
  };

  const start = async () => {
    if (microphoneActive.current || runningRef.current || playing || recoverableRecording) return;
    microphoneActive.current = true;
    const attempt = ++microphoneAttempt.current;
    let token: string | undefined;
    setBusy(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
        throw new Error("마이크 녹음을 지원하지 않습니다.");
      const bridge = window.desktopBridge;
      if (!bridge?.beginAssistantVoiceRecording || !bridge.endAssistantVoiceRecording)
        throw new Error("녹음 보호 상태를 확인하지 못했습니다.");
      token = await bridge.beginAssistantVoiceRecording();
      if (!alive.current || attempt !== microphoneAttempt.current) {
        await bridge.endAssistantVoiceRecording(token);
        return;
      }
      recordingToken.current = token;
      onBargeIn?.();
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!alive.current || attempt !== microphoneAttempt.current) {
        nextStream.getTracks().forEach((track) => track.stop());
        releaseRecording(token);
        return;
      }
      stream.current = nextStream;
      const nextRecorder = new MediaRecorder(nextStream);
      const chunks: BlobPart[] = [];
      let failed = false;
      nextRecorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      nextRecorder.onerror = () => {
        failed = true;
        if (alive.current) setStatus("마이크 녹음에 실패했습니다.");
        if (nextRecorder.state === "recording") {
          try {
            nextRecorder.stop();
          } catch {
            nextStream.getTracks().forEach((track) => track.stop());
            if (attempt === microphoneAttempt.current) {
              stream.current = null;
              recorder.current = null;
              microphoneActive.current = false;
              if (alive.current) setRecording(false);
            }
            releaseRecording(token);
          }
        }
      };
      nextRecorder.onstop = () => {
        if (attempt === microphoneAttempt.current && recordTimer.current)
          clearTimeout(recordTimer.current);
        nextStream.getTracks().forEach((track) => track.stop());
        if (stream.current === nextStream) stream.current = null;
        if (recorder.current === nextRecorder) recorder.current = null;
        if (attempt === microphoneAttempt.current) microphoneActive.current = false;
        if (!alive.current || attempt !== microphoneAttempt.current) {
          releaseRecording(token);
          return;
        }
        setRecording(false);
        const recorded = new Blob(chunks, { type: nextRecorder.mimeType });
        if (recorded.size) setRecoverableRecording(recorded);
        if (!recorded.size) {
          releaseRecording(token);
          return;
        }
        if (failed) return;
        void transcribe(recorded);
      };
      recorder.current = nextRecorder;
      nextRecorder.start();
      recordTimer.current = setTimeout(() => {
        if (nextRecorder.state === "recording") nextRecorder.stop();
      }, 120_000);
      setRecording(true);
      setStatus("마이크 녹음 중입니다. 최대 2분입니다.");
    } catch (error) {
      if (attempt === microphoneAttempt.current) {
        stream.current?.getTracks().forEach((track) => track.stop());
        stream.current = null;
        microphoneActive.current = false;
        if (token) releaseRecording(token);
        if (alive.current) {
          setRecording(false);
          setStatus(`마이크를 열지 못했습니다: ${String(error)}`);
        }
      }
    } finally {
      if (alive.current && attempt === microphoneAttempt.current) setBusy(false);
    }
  };

  const stopPlayback = () => {
    const previous = player.current;
    player.current = null;
    if (previous) {
      previous.source.stop();
      void previous.context.close();
    }
    setPlaying(false);
  };

  const clone = async () => {
    if (!text.trim() || microphoneActive.current || runningRef.current) return;
    cancelled.current = false;
    runningRef.current = true;
    setRunning(true);
    setBusy(true);
    setStatus("로컬 음성 복제 모델을 불러와 답변을 합성하고 있습니다.");
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      await context.resume();
      const result = await window.desktopBridge?.runAssistantVoice?.({
        task: "clone",
        text,
        referenceText,
      });
      if (cancelled.current) throw new Error("음성 작업이 취소되었습니다.");
      if (!result?.ok || !result.audio) throw new Error(result?.error || "합성 결과가 없습니다.");
      const raw = atob(result.audio);
      const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      const source = context.createBufferSource();
      source.buffer = await context.decodeAudioData(bytes.buffer);
      source.connect(context.destination);
      if (!alive.current || cancelled.current) return;
      const playingContext = context;
      player.current = { context: playingContext, source };
      source.onended = () => {
        if (player.current?.source !== source) return;
        player.current = null;
        void playingContext.close();
        if (alive.current) {
          setPlaying(false);
          setStatus("복제 음성 재생을 마쳤습니다.");
        }
      };
      source.start();
      context = undefined;
      setPlaying(true);
      setStatus(`복제 음성을 재생 중입니다 (${result.device === "cpu" ? "CPU" : "GPU"}).`);
    } catch (error) {
      if (alive.current) setStatus(`음성 복제 실패: ${String(error)}`);
    } finally {
      if (context) await context.close();
      runningRef.current = false;
      if (alive.current) {
        setBusy(false);
        setRunning(false);
      }
    }
  };

  return (
    <section
      aria-label="로컬 음성 입력과 복제"
      className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs"
    >
      <button
        type="button"
        className="rounded border px-2 py-1 disabled:opacity-50"
        disabled={
          busy ||
          playing ||
          (!recording &&
            (Boolean(recoverableRecording) || !paths?.whisper || !paths.python || !paths.script))
        }
        onClick={() => (recording ? recorder.current?.stop() : void start())}
      >
        {recording ? "녹음 중지 후 전사" : "마이크 켜기"}
      </button>
      <span>복제 샘플은 모니터 비서 설정에서 관리합니다.</span>
      <label>
        샘플 발화 내용 (선택){" "}
        <input
          className="rounded border bg-background px-1"
          value={referenceText}
          onChange={(event) => setReferenceText(event.currentTarget.value)}
        />
      </label>
      <button
        type="button"
        className="rounded border px-2 py-1 disabled:opacity-50"
        disabled={
          busy ||
          recording ||
          playing ||
          !text.trim() ||
          !paths?.qwen ||
          !paths.python ||
          !paths.script
        }
        onClick={() => void clone()}
      >
        복제 음성으로 답변 듣기
      </button>
      {recoverableRecording && !running ? (
        <>
          <button
            type="button"
            className="rounded border px-2 py-1"
            disabled={recording || busy}
            onClick={() => void transcribe(recoverableRecording)}
          >
            녹음 다시 전사
          </button>
          <button
            type="button"
            className="rounded border px-2 py-1"
            disabled={recording || busy}
            onClick={() => {
              setRecoverableRecording(null);
              releaseRecording();
            }}
          >
            녹음 삭제
          </button>
        </>
      ) : null}
      {running ? (
        <button
          type="button"
          className="rounded border px-2 py-1"
          onClick={() => {
            cancelled.current = true;
            setStatus("음성 작업을 취소하고 있습니다.");
            void window.desktopBridge?.cancelAssistantVoice?.();
          }}
        >
          음성 작업 취소
        </button>
      ) : null}
      {playing ? (
        <button type="button" className="rounded border px-2 py-1" onClick={stopPlayback}>
          복제 음성 중지
        </button>
      ) : null}
      <details>
        <summary>로컬 음성 경로</summary>
        <p>
          Python: {paths?.paths.python ?? "확인 중"} ({paths?.python ? "확인됨" : "없음"})
        </p>
        <p>
          전사: {paths?.paths.whisper ?? "확인 중"} ({paths?.whisper ? "확인됨" : "없음"})
        </p>
        <p>
          복제: {paths?.paths.qwen ?? "확인 중"} ({paths?.qwen ? "확인됨" : "없음"})
        </p>
        <button type="button" onClick={() => void check()}>
          다시 확인
        </button>
      </details>
      <span role="status">{status}</span>
    </section>
  );
}

export function AssistantVoiceSampleSettings() {
  const [status, setStatus] = useState("");
  const [samplePath, setSamplePath] = useState("");
  const [present, setPresent] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      const value = await window.desktopBridge?.getAssistantVoiceStatus?.();
      setPresent(value?.sample ?? false);
      setSamplePath(value?.paths.sample ?? "");
    } catch (error) {
      setStatus(`샘플 상태를 확인하지 못했습니다: ${String(error)}`);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div className="flex flex-col gap-2">
      <p>
        복제 샘플: {present ? "저장됨" : "없음"} {samplePath ? `· ${samplePath}` : ""}
      </p>
      <p>샘플은 로컬에만 저장하며 2분, 25 MiB 이하 파일을 사용할 수 있습니다.</p>
      <label>
        로컬 샘플 선택·교체{" "}
        <input
          type="file"
          accept="audio/*"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            void (async () => {
              setBusy(true);
              try {
                const token = await window.desktopBridge?.beginAssistantVoiceSample?.();
                if (!token) throw new Error("샘플 변경을 시작할 수 없습니다.");
                const audio = await toWavBase64(file);
                const result = await window.desktopBridge?.saveAssistantVoiceSample?.({
                  audio,
                  token,
                });
                if (!result?.ok) throw new Error(result?.error || "샘플 저장을 지원하지 않습니다.");
                await refresh();
                setStatus(result.warning || "로컬 샘플을 저장했습니다.");
              } catch (error) {
                setStatus(`샘플 저장 실패: ${String(error)}`);
              } finally {
                setBusy(false);
              }
            })();
          }}
        />
      </label>
      <button
        type="button"
        className="w-fit rounded border px-2 py-1 disabled:opacity-50"
        disabled={busy || !present}
        onClick={() => {
          void (async () => {
            setBusy(true);
            try {
              const result = await window.desktopBridge?.deleteAssistantVoiceSample?.();
              if (!result?.ok) throw new Error(result?.error || "샘플 삭제를 지원하지 않습니다.");
              await refresh();
              setStatus("저장된 로컬 샘플을 삭제했습니다.");
            } catch (error) {
              setStatus(`샘플 삭제 실패: ${String(error)}`);
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        저장된 샘플 삭제
      </button>
      <span role="status">{status}</span>
    </div>
  );
}
