import type { AssistantAudioSettings } from "@t3tools/contracts";
import { sanitizeTextForSpeech } from "@t3tools/shared/speechSanitizer";
import { useEffect, useRef, useState } from "react";
import type { AssistantPresenceStore } from "../../assistantPresenceStore";
import { RealtimeVoiceOrchestrator } from "../../voice/RealtimeVoiceOrchestrator";

/** Never silently select a network-backed system voice. */
export function selectLocalAssistantVoice(
  voices: readonly SpeechSynthesisVoice[],
  text: string,
): SpeechSynthesisVoice | undefined {
  const language = /[가-힣ᄀ-ᇿ]/u.test(text) ? "ko" : "en";
  return voices.find(
    (voice) => voice.localService && voice.lang.toLowerCase().startsWith(language),
  );
}

/**
 * Splits spoken text cleanly after stripping code blocks, file paths, tables,
 * and URLs so TTS never reads raw syntax aloud.
 */
export function splitAssistantSpeech(text: string, limit = 1000): string[] {
  const sanitized = sanitizeTextForSpeech(text, Math.min(limit, 180));
  if (sanitized.length === 0) return [];
  const merged = sanitized.join(" ");
  const chunks: string[] = [];
  let chunk = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    merged,
  )) {
    if (chunk && chunk.length + segment.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += segment;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export interface AssistantVoiceInterruptHandle {
  interruptNow: (reason?: "barge_in" | "user_stop") => void;
  speakProactiveText: (summaryText: string) => void;
}

/** A local or OpenAI-compatible (`/v1/audio/speech`) sanitized voice player with 5-vowel viseme output. */
export function AssistantVoice({
  text,
  prosody,
  isDelegatedWorking = false,
  onSpeakingChange,
  presenceStore,
  audioSettings,
  interruptRef,
}: {
  text: string;
  prosody?: { readonly rate: number; readonly pitch: number } | undefined;
  isDelegatedWorking?: boolean;
  onSpeakingChange?: (speaking: boolean) => void;
  presenceStore?: AssistantPresenceStore;
  audioSettings?: AssistantAudioSettings;
  interruptRef?: React.MutableRefObject<AssistantVoiceInterruptHandle | null>;
}) {
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState("");
  const [showDelegateHint, setShowDelegateHint] = useState(false);
  const onSpeakingChangeRef = useRef(onSpeakingChange);
  onSpeakingChangeRef.current = onSpeakingChange;

  const orchestratorRef = useRef<RealtimeVoiceOrchestrator | null>(null);
  if (!orchestratorRef.current) {
    orchestratorRef.current = new RealtimeVoiceOrchestrator({
      ...(presenceStore ? { presenceStore } : {}),
      ...(audioSettings ? { audioSettings } : {}),
      onSpeakingChange: (next) => {
        setSpeaking(next);
        onSpeakingChangeRef.current?.(next);
      },
    });
  }

  useEffect(() => {
    if (audioSettings) {
      orchestratorRef.current?.updateAudioSettings(audioSettings);
    }
  }, [audioSettings]);

  useEffect(() => {
    if (!isDelegatedWorking) {
      setShowDelegateHint(false);
      return;
    }
    const timer = window.setTimeout(() => setShowDelegateHint(true), 2_000);
    return () => window.clearTimeout(timer);
  }, [isDelegatedWorking]);

  useEffect(() => {
    const orchestrator = orchestratorRef.current;
    if (interruptRef && orchestrator) {
      interruptRef.current = {
        interruptNow: (reason = "barge_in") => {
          const report = orchestrator.interruptNow(reason);
          if (report.interrupted) {
            setStatus(
              reason === "barge_in"
                ? `사용자 발화 감지로 ${report.elapsedMs.toFixed(0)}ms 만에 음성을 즉시 중단했습니다.`
                : "음성 재생을 중지했습니다.",
            );
          }
        },
        speakProactiveText: (summaryText: string) => {
          setStatus("능동 브리핑을 안내하고 있습니다.");
          void orchestrator
            .speakCompletedReply(summaryText, prosody)
            .then(() => setStatus("능동 브리핑 안내를 마쳤습니다."))
            .catch(() => setStatus("능동 브리핑 음성 재생을 건너뛰었습니다."));
        },
      };
    }
    return () => {
      if (interruptRef) interruptRef.current = null;
    };
  }, [interruptRef, prosody]);

  useEffect(
    () => () => {
      orchestratorRef.current?.dispose();
    },
    [],
  );

  const stop = () => {
    orchestratorRef.current?.interruptNow("user_stop");
    setStatus("음성 재생을 중지했습니다.");
  };

  const speak = () => {
    if (!text.trim()) return;
    const chunks = sanitizeTextForSpeech(text);
    if (chunks.length === 0) {
      setStatus("코드·경로·표를 제외하고 읽을 자연어 문장이 없습니다.");
      return;
    }
    setStatus(
      audioSettings?.ttsEngine === "openai_compat"
        ? "외부/로컬 오디오 게이트웨이로 정제된 답변을 읽고 있습니다."
        : "코드·경로를 제외한 자연어 답변을 읽고 있습니다.",
    );
    void orchestratorRef.current
      ?.speakCompletedReply(text, prosody)
      .then(() => {
        setStatus("음성 재생을 마쳤습니다.");
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : "음성 재생에 실패했습니다.");
      });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
      <button
        type="button"
        className="rounded border border-border px-2 py-1 disabled:opacity-50"
        disabled={!text.trim() || speaking}
        onClick={speak}
      >
        마지막 답변 듣기
      </button>
      {speaking ? (
        <button type="button" className="rounded border border-border px-2 py-1" onClick={stop}>
          음성 중지
        </button>
      ) : null}
      <span role="status">
        {status ||
          (showDelegateHint
            ? "백그라운드에서 확인·작업을 진행 중이에요. 결과가 정리되는 대로 바로 안내해 드릴게요."
            : "")}
      </span>
    </div>
  );
}
