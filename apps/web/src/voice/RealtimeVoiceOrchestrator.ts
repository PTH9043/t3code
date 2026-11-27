import {
  ZERO_VISEME_WEIGHTS,
  type AssistantAudioSettings,
  type VisemeWeights,
} from "@t3tools/contracts";
import {
  charToVisemeWeights,
  SpeechSanitizerStream,
  sanitizeTextForSpeech,
} from "@t3tools/shared/speechSanitizer";
import type { AssistantPresenceStore } from "../assistantPresenceStore";

export const VOICE_WORKLET_URL = "/worklets/voice-analyzer-worklet.js";

/**
 * Validates an OpenAI-compatible audio gateway URL (`unspeech`, Kokoro, GPT-SoVITS,
 * F5-TTS, Fish Speech): allows loopback HTTP(S) or public HTTPS, blocking SSRF metadata/file URLs.
 */
export function validateAudioEndpointUrl(rawUrl: string): {
  readonly valid: boolean;
  readonly normalized?: string;
  readonly reason?: string;
} {
  const trimmed = rawUrl.trim().replace(/\/+$/u, "");
  if (!trimmed) return { valid: false, reason: "오디오 엔드포인트 URL이 비어 있습니다." };
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
    if (parsed.protocol === "http:") {
      if (!isLoopback) {
        return {
          valid: false,
          reason: "HTTP 오디오 엔드포인트는 로컬 루프백(127.0.0.1/localhost)만 허용합니다.",
        };
      }
      return { valid: true, normalized: parsed.origin + parsed.pathname.replace(/\/+$/u, "") };
    }
    if (parsed.protocol === "https:") {
      if (host === "169.254.169.254" || host.endsWith(".internal")) {
        return { valid: false, reason: "차단된 메타데이터 호스트입니다." };
      }
      return { valid: true, normalized: parsed.origin + parsed.pathname.replace(/\/+$/u, "") };
    }
    return { valid: false, reason: `지원하지 않는 프로토콜입니다: ${parsed.protocol}` };
  } catch {
    return { valid: false, reason: "유효한 URL 형식이 아닙니다." };
  }
}

export interface AudioBufferPlaybackAdapter {
  playAudioBuffer(
    audioBytes: ArrayBuffer,
    onViseme: (weights: VisemeWeights) => void,
    signal: AbortSignal,
  ): Promise<void>;
  stopAll(): void;
}

/**
 * Browser Web Audio player with optional `t3-lipsync-processor` AudioWorklet
 * formant 5-vowel extraction (gracefully degrades if AudioWorklet is unavailable).
 */
export class WebAudioLipSyncPlayer implements AudioBufferPlaybackAdapter {
  private context: AudioContext | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private workletLoaded = false;

  async playAudioBuffer(
    audioBytes: ArrayBuffer,
    onViseme: (weights: VisemeWeights) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext();
      this.workletLoaded = false;
    }
    const ctx = this.context;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    const decoded = await ctx.decodeAudioData(audioBytes.slice(0));
    if (signal.aborted) return;

    let workletNode: AudioWorkletNode | null = null;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        if (!this.workletLoaded) {
          await ctx.audioWorklet.addModule(VOICE_WORKLET_URL);
          this.workletLoaded = true;
        }
        workletNode = new AudioWorkletNode(ctx, "t3-lipsync-processor");
        workletNode.port.onmessage = (
          event: MessageEvent<{ type?: string; weights?: VisemeWeights }>,
        ) => {
          if (event.data?.type === "viseme" && event.data.weights && !signal.aborted) {
            onViseme(event.data.weights);
          }
        };
      } catch {
        workletNode = null;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = decoded;
    if (workletNode) {
      source.connect(workletNode);
      workletNode.connect(ctx.destination);
    } else {
      source.connect(ctx.destination);
    }
    this.activeSource = source;

    await new Promise<void>((resolve) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        if (this.activeSource === source) {
          this.activeSource = null;
        }
        try {
          source.disconnect();
          workletNode?.disconnect();
        } catch {
          // ignore disconnect errors
        }
        onViseme(ZERO_VISEME_WEIGHTS);
        resolve();
      };
      const onAbort = () => {
        try {
          source.stop();
        } catch {
          // ignore already stopped
        }
        cleanup();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      source.onended = cleanup;
      source.start();
    });
  }

  stopAll(): void {
    const src = this.activeSource;
    this.activeSource = null;
    if (src) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // ignore
      }
    }
  }
}

export interface SpeechSynthesizerAdapter {
  speakChunk(input: {
    readonly text: string;
    readonly prosody?: { readonly rate: number; readonly pitch: number } | undefined;
    readonly onViseme: (weights: VisemeWeights) => void;
    readonly signal: AbortSignal;
  }): Promise<void>;
  cancel(): void;
}

/**
 * Browser `window.speechSynthesis` adapter with Korean Hangul medial vowel
 * phoneme lip-sync driven by `utterance.onboundary` (zero `setInterval` polling).
 */
export class BrowserSpeechSynthesisAdapter implements SpeechSynthesizerAdapter {
  speakChunk(input: {
    readonly text: string;
    readonly prosody?: { readonly rate: number; readonly pitch: number } | undefined;
    readonly onViseme: (weights: VisemeWeights) => void;
    readonly signal: AbortSignal;
  }): Promise<void> {
    if (
      input.signal.aborted ||
      typeof window === "undefined" ||
      !("speechSynthesis" in window) ||
      typeof SpeechSynthesisUtterance === "undefined"
    ) {
      return Promise.resolve();
    }
    const synth = window.speechSynthesis;
    const isKorean = /[가-힣ᄀ-ᇿ]/u.test(input.text);
    const langPrefix = isKorean ? "ko" : "en";
    const voice = synth
      .getVoices()
      .find((v) => v.localService && v.lang.toLowerCase().startsWith(langPrefix));
    if (!voice) {
      return Promise.reject(new Error("이 답변의 언어에 사용할 로컬 음성을 찾지 못했습니다."));
    }

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(input.text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      if (input.prosody) {
        utterance.rate = input.prosody.rate;
        utterance.pitch = input.prosody.pitch;
      }

      let rafId: number | undefined;
      let charCursor = 0;
      let lastStepMs = performance.now();

      const stopPhonemeAnimation = () => {
        if (rafId !== undefined) cancelAnimationFrame(rafId);
        rafId = undefined;
        input.onViseme(ZERO_VISEME_WEIGHTS);
      };

      const stepPhoneme = (now: number) => {
        rafId = undefined;
        if (input.signal.aborted) {
          stopPhonemeAnimation();
          return;
        }
        const elapsed = now - lastStepMs;
        // ~115ms per syllable adjusted by prosody rate when onboundary is sparse on Windows voices
        const stepMs = 115 / Math.max(0.7, input.prosody?.rate ?? 1);
        if (elapsed >= stepMs && charCursor < input.text.length) {
          lastStepMs = now;
          const ch = input.text[charCursor] ?? "";
          charCursor += 1;
          input.onViseme(charToVisemeWeights(ch));
        }
        if (charCursor < input.text.length && !input.signal.aborted) {
          rafId = requestAnimationFrame(stepPhoneme);
        }
      };

      utterance.onstart = () => {
        if (typeof requestAnimationFrame !== "undefined") {
          rafId = requestAnimationFrame(stepPhoneme);
        }
      };
      utterance.onboundary = (event) => {
        if (input.signal.aborted) return;
        const idx = Math.min(Math.max(0, event.charIndex), input.text.length - 1);
        charCursor = idx + 1;
        lastStepMs = performance.now();
        input.onViseme(charToVisemeWeights(input.text[idx] ?? ""));
      };

      const onAbort = () => {
        stopPhonemeAnimation();
        synth.cancel();
        resolve();
      };
      input.signal.addEventListener("abort", onAbort, { once: true });

      utterance.onend = () => {
        input.signal.removeEventListener("abort", onAbort);
        stopPhonemeAnimation();
        resolve();
      };
      utterance.onerror = () => {
        input.signal.removeEventListener("abort", onAbort);
        stopPhonemeAnimation();
        if (input.signal.aborted) resolve();
        else reject(new Error("음성 재생에 실패했습니다."));
      };
      synth.speak(utterance);
    });
  }

  cancel(): void {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }
}

export interface BargeInInterruptReport {
  readonly interrupted: boolean;
  readonly elapsedMs: number;
  readonly abortedStream: boolean;
  readonly clearedChunks: number;
}

export interface RealtimeVoiceOrchestratorOptions {
  readonly presenceStore?: AssistantPresenceStore;
  readonly audioSettings?: AssistantAudioSettings;
  readonly speechSynth?: SpeechSynthesizerAdapter;
  readonly audioPlayer?: AudioBufferPlaybackAdapter;
  readonly fetchImpl?: typeof fetch;
  readonly onSpeakingChange?: (speaking: boolean) => void;
  readonly onBargeIn?: (report: BargeInInterruptReport) => void;
}

/**
 * Coordinates sanitized breath-unit TTS (with 2-chunk concurrent prefetch for
 * OpenAI-compatible `/v1/audio/speech` backends like `unspeech`, Kokoro-82M,
 * GPT-SoVITS, F5-TTS, Fish Speech), 5-vowel viseme output, and <=80ms hands-free
 * VAD barge-in interruption.
 */
export class RealtimeVoiceOrchestrator {
  private readonly presenceStore: AssistantPresenceStore | undefined;
  private audioSettings: AssistantAudioSettings | undefined;
  private readonly speechSynth: SpeechSynthesizerAdapter;
  private readonly audioPlayer: AudioBufferPlaybackAdapter;
  private readonly fetchImpl: typeof fetch;
  private readonly onSpeakingChange: ((speaking: boolean) => void) | undefined;
  private readonly onBargeIn: ((report: BargeInInterruptReport) => void) | undefined;

  private readonly sanitizer = new SpeechSanitizerStream();
  private chunkQueue: Array<{
    readonly text: string;
    readonly prefetched?: Promise<ArrayBuffer>;
  }> = [];
  private activeAbort: AbortController | null = null;
  private activeLlmAbort: AbortController | null = null;
  private speaking = false;
  private draining = false;
  private prosody: { readonly rate: number; readonly pitch: number } | undefined;

  // Hands-free VAD capture state
  private vadStream: MediaStream | null = null;
  private vadContext: AudioContext | null = null;
  private vadNode: AudioWorkletNode | null = null;

  constructor(options?: RealtimeVoiceOrchestratorOptions) {
    this.presenceStore = options?.presenceStore;
    this.audioSettings = options?.audioSettings;
    this.speechSynth = options?.speechSynth ?? new BrowserSpeechSynthesisAdapter();
    this.audioPlayer = options?.audioPlayer ?? new WebAudioLipSyncPlayer();
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onSpeakingChange = options?.onSpeakingChange;
    this.onBargeIn = options?.onBargeIn;
  }

  updateAudioSettings(settings: AssistantAudioSettings): void {
    this.audioSettings = settings;
  }

  attachLlmAbortController(controller: AbortController | null): void {
    this.activeLlmAbort = controller;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * Immediately halts all TTS playback, empties prefetched audio queues, aborts
   * any active LLM stream, and switches the avatar into `listening` mode.
   * Synchronous hot path guarantees completion well under the 80ms budget.
   */
  interruptNow(reason: "barge_in" | "user_stop" = "user_stop"): BargeInInterruptReport {
    const start = performance.now();
    const clearedChunks = this.chunkQueue.length;
    this.chunkQueue = [];

    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
    this.speechSynth.cancel();
    this.audioPlayer.stopAll();
    this.sanitizer.reset();

    let abortedStream = false;
    if (this.activeLlmAbort && !this.activeLlmAbort.signal.aborted) {
      this.activeLlmAbort.abort();
      abortedStream = true;
    }

    const wasSpeaking = this.speaking;
    this.setSpeaking(false);
    this.presenceStore?.resetViseme();
    if (reason === "barge_in") {
      this.presenceStore?.setSemanticState({
        mode: "listening",
        expression: "warm_smile",
        expressionWeight: 0.72,
        activeSpeechText: null,
      });
    } else {
      this.presenceStore?.setSemanticState({
        mode: "idle",
        activeSpeechText: null,
      });
    }

    const report: BargeInInterruptReport = {
      interrupted: wasSpeaking || clearedChunks > 0 || abortedStream,
      elapsedMs: performance.now() - start,
      abortedStream,
      clearedChunks,
    };
    if (reason === "barge_in") {
      this.onBargeIn?.(report);
    }
    return report;
  }

  /** Triggered by the `t3-vad-processor` AudioWorklet or test harness on speech start. */
  handleVadSpeechStart(): BargeInInterruptReport {
    if (this.audioSettings?.bargeInEnabled === false && this.speaking) {
      return { interrupted: false, elapsedMs: 0, abortedStream: false, clearedChunks: 0 };
    }
    return this.interruptNow("barge_in");
  }

  /** Speaks a complete reply after running it through `SpeechSanitizerStream`. */
  async speakCompletedReply(
    rawMarkdown: string,
    prosody?: { readonly rate: number; readonly pitch: number },
  ): Promise<void> {
    this.stopPlaybackOnly();
    this.prosody = prosody;
    const chunks = sanitizeTextForSpeech(rawMarkdown);
    if (chunks.length === 0) return;
    this.activeAbort = new AbortController();
    for (const chunk of chunks) {
      this.enqueueChunk(chunk);
    }
    await this.drainQueue();
  }

  /** Stops only TTS playback and empties the queue without aborting an attached LLM stream. */
  private stopPlaybackOnly(): void {
    this.chunkQueue = [];
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
    this.speechSynth.cancel();
    this.audioPlayer.stopAll();
    this.sanitizer.reset();
    this.setSpeaking(false);
    this.presenceStore?.resetViseme();
  }

  /** Feeds incremental LLM text deltas directly into sanitized speech playback. */
  pushStreamDelta(
    delta: string,
    prosody?: { readonly rate: number; readonly pitch: number },
  ): void {
    this.prosody = prosody;
    if (!this.activeAbort) {
      this.activeAbort = new AbortController();
    }
    const ready = this.sanitizer.push(delta);
    for (const chunk of ready) {
      this.enqueueChunk(chunk);
    }
    if (ready.length > 0 && !this.draining) {
      void this.drainQueue();
    }
  }

  flushStream(): void {
    const ready = this.sanitizer.flush();
    for (const chunk of ready) {
      this.enqueueChunk(chunk);
    }
    if (ready.length > 0 && !this.draining) {
      void this.drainQueue();
    }
  }

  /** Starts echo-cancelled hands-free VAD listening via AudioWorklet. */
  async startHandsFreeVad(callbacks?: {
    readonly onSpeechStart?: () => void;
    readonly onSpeechEnd?: () => void;
  }): Promise<{ readonly active: boolean; readonly error?: string }> {
    this.stopHandsFreeVad();
    if (!navigator.mediaDevices?.getUserMedia) {
      return { active: false, error: "이 환경은 마이크 입력을 지원하지 않습니다." };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const ctx = new AudioContext();
      await ctx.resume();
      if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") {
        stream.getTracks().forEach((t) => t.stop());
        await ctx.close();
        return { active: false, error: "AudioWorklet VAD를 지원하지 않는 환경입니다." };
      }
      await ctx.audioWorklet.addModule(VOICE_WORKLET_URL);
      const source = ctx.createMediaStreamSource(stream);
      const vadNode = new AudioWorkletNode(ctx, "t3-vad-processor");
      vadNode.port.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === "speech_start") {
          this.handleVadSpeechStart();
          callbacks?.onSpeechStart?.();
        } else if (event.data?.type === "speech_end") {
          callbacks?.onSpeechEnd?.();
        }
      };
      source.connect(vadNode);
      this.vadStream = stream;
      this.vadContext = ctx;
      this.vadNode = vadNode;
      return { active: true };
    } catch (error) {
      return {
        active: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  stopHandsFreeVad(): void {
    try {
      this.vadNode?.disconnect();
    } catch {
      // ignore
    }
    this.vadNode = null;
    this.vadStream?.getTracks().forEach((track) => track.stop());
    this.vadStream = null;
    if (this.vadContext) {
      void this.vadContext.close().catch(() => {});
      this.vadContext = null;
    }
  }

  /** OpenAI-compatible `/v1/audio/transcriptions` (`unspeech` / Whisper server) STT helper. */
  async transcribeViaOpenAiCompat(audioBlob: Blob): Promise<string> {
    const check = validateAudioEndpointUrl(this.audioSettings?.audioBaseUrl ?? "");
    if (!check.valid || !check.normalized) {
      throw new Error(check.reason ?? "STT 엔드포인트 URL이 설정되지 않았습니다.");
    }
    const form = new FormData();
    form.append("file", audioBlob, "speech.wav");
    form.append("model", this.audioSettings?.sttModel || "whisper-1");
    form.append("language", "ko");
    const response = await this.fetchImpl(`${check.normalized}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      throw new Error(`STT 요청 실패 (HTTP ${response.status})`);
    }
    const data = (await response.json()) as { text?: string };
    return data.text?.trim() ?? "";
  }

  dispose(): void {
    this.stopHandsFreeVad();
    this.interruptNow("user_stop");
  }

  private setSpeaking(next: boolean): void {
    if (this.speaking === next) return;
    this.speaking = next;
    this.onSpeakingChange?.(next);
  }

  private useOpenAiCompatTts(): string | null {
    if (this.audioSettings?.ttsEngine !== "openai_compat") return null;
    const check = validateAudioEndpointUrl(this.audioSettings.audioBaseUrl);
    return check.valid && check.normalized ? check.normalized : null;
  }

  private enqueueChunk(text: string): void {
    const endpoint = this.useOpenAiCompatTts();
    const signal = this.activeAbort?.signal;
    // Prefetch up to 2 chunks concurrently when using OpenAI-compatible audio endpoints.
    const shouldPrefetch = endpoint !== null && signal && this.chunkQueue.length < 2;
    const prefetched = shouldPrefetch ? this.fetchSpeechAudio(endpoint, text, signal) : undefined;
    this.chunkQueue.push({ text, ...(prefetched ? { prefetched } : {}) });
  }

  private async fetchSpeechAudio(
    baseUrl: string,
    text: string,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.audioSettings?.ttsModel || "kokoro",
        voice: this.audioSettings?.ttsVoice || "af_heart",
        input: text,
        speed: this.prosody?.rate ?? 1.0,
        response_format: "wav",
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`TTS 합성 실패 (HTTP ${response.status})`);
    }
    return await response.arrayBuffer();
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const abort = this.activeAbort;
    if (!abort) {
      this.draining = false;
      return;
    }

    this.setSpeaking(true);
    this.presenceStore?.setSemanticState({ mode: "speaking" });

    try {
      while (this.chunkQueue.length > 0 && !abort.signal.aborted) {
        const next = this.chunkQueue.shift()!;
        // Keep up to 2 chunks prefetched ahead of playback
        const endpoint = this.useOpenAiCompatTts();
        if (endpoint) {
          for (let i = 0; i < Math.min(2, this.chunkQueue.length); i += 1) {
            const ahead = this.chunkQueue[i]!;
            if (!ahead.prefetched) {
              this.chunkQueue[i] = {
                text: ahead.text,
                prefetched: this.fetchSpeechAudio(endpoint, ahead.text, abort.signal),
              };
            }
          }
        }

        this.presenceStore?.setSemanticState({ activeSpeechText: next.text });
        const onViseme = (weights: VisemeWeights) => {
          this.presenceStore?.setVisemeWeights(weights);
        };

        if (endpoint) {
          const bytes = await (next.prefetched ??
            this.fetchSpeechAudio(endpoint, next.text, abort.signal));
          if (abort.signal.aborted) break;
          await this.audioPlayer.playAudioBuffer(bytes, onViseme, abort.signal);
        } else {
          await this.speechSynth.speakChunk({
            text: next.text,
            prosody: this.prosody,
            onViseme,
            signal: abort.signal,
          });
        }
      }
    } finally {
      this.draining = false;
      if (!abort.signal.aborted) {
        this.setSpeaking(false);
        this.presenceStore?.resetViseme();
        this.presenceStore?.setSemanticState({ mode: "idle", activeSpeechText: null });
      }
    }
  }
}
