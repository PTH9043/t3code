import { DEFAULT_ASSISTANT_AUDIO_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createAssistantPresenceStore } from "../assistantPresenceStore";
import {
  RealtimeVoiceOrchestrator,
  validateAudioEndpointUrl,
  type AudioBufferPlaybackAdapter,
  type SpeechSynthesizerAdapter,
} from "./RealtimeVoiceOrchestrator";

describe("Gate 3: RealtimeVoiceOrchestrator <= 80ms barge-in & audio endpoint validation", () => {
  it("halts active TTS, clears queued chunks, aborts LLM stream, and enters listening within 80ms on VAD speech_start", async () => {
    const store = createAssistantPresenceStore("builtin-chief-of-staff");
    const cancelSpy = vi.fn();
    const stopAllSpy = vi.fn();
    let resolveSpeak!: () => void;

    const fakeSynth: SpeechSynthesizerAdapter = {
      speakChunk: ({ signal }) =>
        new Promise<void>((resolve) => {
          resolveSpeak = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      cancel: cancelSpy,
    };
    const fakePlayer: AudioBufferPlaybackAdapter = {
      playAudioBuffer: async () => {},
      stopAll: stopAllSpy,
    };

    const bargeInReports: Array<{ elapsedMs: number; interrupted: boolean }> = [];
    const orchestrator = new RealtimeVoiceOrchestrator({
      presenceStore: store,
      audioSettings: { ...DEFAULT_ASSISTANT_AUDIO_SETTINGS, bargeInEnabled: true },
      speechSynth: fakeSynth,
      audioPlayer: fakePlayer,
      onBargeIn: (report) => bargeInReports.push(report),
    });

    const llmAbort = new AbortController();
    orchestrator.attachLlmAbortController(llmAbort);

    // Start speaking a multi-sentence reply
    const speakPromise = orchestrator.speakCompletedReply(
      "첫 번째 문장입니다. 두 번째 문장도 이어집니다. 세 번째 문장입니다.",
    );
    // Allow microtask to start playback
    await Promise.resolve();
    expect(orchestrator.isSpeaking()).toBe(true);
    expect(store.getSnapshot().mode).toBe("speaking");

    // Simulate VAD `onSpeechStart` barge-in while assistant is actively speaking
    const report = orchestrator.handleVadSpeechStart();
    await speakPromise;

    expect(report.interrupted).toBe(true);
    expect(report.elapsedMs).toBeLessThanOrEqual(80);
    expect(report.abortedStream).toBe(true);
    expect(report.clearedChunks).toBeGreaterThanOrEqual(1);
    expect(llmAbort.signal.aborted).toBe(true);
    expect(cancelSpy).toHaveBeenCalled();
    expect(stopAllSpy).toHaveBeenCalled();
    expect(orchestrator.isSpeaking()).toBe(false);
    expect(store.getSnapshot().mode).toBe("listening");
    expect(bargeInReports).toHaveLength(1);
    resolveSpeak();
  });

  it("validates loopback/HTTPS OpenAI-compatible audio endpoints and blocks SSRF/file URLs", () => {
    expect(validateAudioEndpointUrl("http://127.0.0.1:5933/").valid).toBe(true);
    expect(validateAudioEndpointUrl("http://localhost:8880").valid).toBe(true);
    expect(validateAudioEndpointUrl("https://audio.example.com").valid).toBe(true);

    expect(validateAudioEndpointUrl("http://192.168.1.50:8080").valid).toBe(false);
    expect(validateAudioEndpointUrl("https://169.254.169.254/latest").valid).toBe(false);
    expect(validateAudioEndpointUrl("file:///C:/Windows/win.ini").valid).toBe(false);
  });
});
