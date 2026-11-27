import type { AvatarAffectDirective } from "@t3tools/shared/livingPersonaAvatarBridge";
import { useEffect, useRef, useState } from "react";
import type { AssistantPresenceStore } from "../../assistantPresenceStore";

type LivLivPlayerInstance = import("@livliv-dev/player").Player;
type LivLivModelInfo = import("@livliv-dev/player").ModelInfo;

export interface LivLivCharacterProps {
  readonly isWorking: boolean;
  readonly isSpeaking?: boolean;
  readonly affectDirective?: AvatarAffectDirective;
  readonly presenceStore?: AssistantPresenceStore;
  readonly modelUrl?: string;
  readonly size?: number;
  readonly onError?: () => void;
}

const DEFAULT_MODEL_URL_KEY = "t3code:livliv-model-url";

function readSavedModelUrl(): string {
  try {
    return localStorage.getItem(DEFAULT_MODEL_URL_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Lightweight WebGL2 2.5D LivLiv character renderer (`@livliv-dev/player`, Apache-2.0).
 * Pauses automatically when hidden, offscreen, or when `prefers-reduced-motion` is active
 * to avoid GPU spikes on high-refresh displays.
 */
export default function LivLivCharacter({
  isWorking,
  isSpeaking = false,
  affectDirective,
  presenceStore,
  modelUrl,
  size = 160,
  onError,
}: LivLivCharacterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<LivLivPlayerInstance | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [supported, setSupported] = useState<boolean>(true);
  const [status, setStatus] = useState<string>(
    "로컬 .livliv 파일을 선택해 2.5D 캐릭터를 불러오세요.",
  );
  const [modelInfo, setModelInfo] = useState<LivLivModelInfo | null>(null);
  const [customUrl, setCustomUrl] = useState<string>(() => modelUrl ?? readSavedModelUrl());
  const [loading, setLoading] = useState(false);

  const loadSource = async (source: string | File, label: string) => {
    const player = playerRef.current;
    if (!player) return;
    setLoading(true);
    setStatus(`${label} 불러오는 중…`);
    try {
      const info = await player.load(source);
      setModelInfo(info);
      setStatus(info.name || label);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`불러오기 실패: ${message}`);
      onErrorRef.current?.();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let visible = true;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const syncPlayback = () => {
      const player = playerRef.current;
      if (!player || disposed) return;
      const shouldRun = visible && document.visibilityState !== "hidden" && !reducedMotion.matches;
      if (shouldRun) {
        player.play();
      } else {
        player.pause();
      }
    };

    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            syncPlayback();
          });
    observer?.observe(canvas);
    document.addEventListener("visibilitychange", syncPlayback);
    reducedMotion.addEventListener("change", syncPlayback);

    void (async () => {
      try {
        const mod = await import("@livliv-dev/player");
        if (disposed) return;
        if (!mod.Player.isSupported()) {
          setSupported(false);
          setStatus("이 환경은 WebGL2를 지원하지 않아 2.5D LivLiv를 표시할 수 없습니다.");
          return;
        }
        const player = new mod.Player(canvas, {
          idle: !reducedMotion.matches,
          followPointer: "canvas",
          maxPixelRatio: 1.5,
          autoplay: !reducedMotion.matches,
          renderWhenHidden: false,
        });
        playerRef.current = player;
        syncPlayback();
        const initialUrl = (modelUrl ?? readSavedModelUrl()).trim();
        if (initialUrl) {
          await loadSource(initialUrl, initialUrl);
        }
      } catch (error) {
        if (disposed) return;
        setSupported(false);
        setStatus(
          error instanceof Error
            ? `2.5D 렌더러 초기화 실패: ${error.message}`
            : "2.5D 렌더러 초기화에 실패했습니다.",
        );
        onErrorRef.current?.();
      }
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      document.removeEventListener("visibilitychange", syncPlayback);
      reducedMotion.removeEventListener("change", syncPlayback);
      const current = playerRef.current;
      playerRef.current = null;
      current?.dispose();
    };
  }, [modelUrl]);

  // Apply living persona PAD affect expression & smile weight
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !modelInfo || !affectDirective) return;
    player.setExpression(affectDirective.livliv.expressionId);
    player.params.smile = affectDirective.livliv.smile;
    if (affectDirective.livliv.action) {
      player.act(affectDirective.livliv.action, 0.7);
    }
  }, [affectDirective, modelInfo]);

  // Subtle nod when entering active work state
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !modelInfo || !isWorking) return;
    player.act("nod", 0.55);
  }, [isWorking, modelInfo]);

  // 60fps requestAnimationFrame viseme lip-sync driven by AssistantPresenceStore (zero setInterval polling)
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !modelInfo) return;
    if (!isSpeaking) {
      player.params.mouthOpen = 0;
      return;
    }
    let rafId: number | undefined;
    let phase = 0;
    const stepMouth = () => {
      rafId = undefined;
      if (document.visibilityState === "hidden") {
        player.params.mouthOpen = 0;
        return;
      }
      const viseme = presenceStore?.getSnapshot().visemeWeights;
      if (viseme && viseme.silence < 0.98) {
        const open = Math.min(
          1,
          viseme.a * 1.0 + viseme.o * 0.8 + viseme.e * 0.58 + viseme.i * 0.35 + viseme.u * 0.3,
        );
        player.params.mouthOpen = open;
      } else {
        phase += 0.14;
        player.params.mouthOpen = 0.2 + Math.abs(Math.sin(phase)) * 0.45;
      }
      rafId = requestAnimationFrame(stepMouth);
    };
    const onVisibility = () => {
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      rafId = undefined;
      if (document.visibilityState !== "hidden") {
        rafId = requestAnimationFrame(stepMouth);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    rafId = requestAnimationFrame(stepMouth);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      player.params.mouthOpen = 0;
    };
  }, [isSpeaking, modelInfo, presenceStore]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    void loadSource(file, file.name);
  };

  const handleLoadUrl = () => {
    const trimmed = customUrl.trim();
    if (!trimmed) return;
    try {
      localStorage.setItem(DEFAULT_MODEL_URL_KEY, trimmed);
    } catch {
      // ignore storage quota errors
    }
    void loadSource(trimmed, trimmed);
  };

  return (
    <div
      data-livliv-stage=""
      className="flex flex-col items-center gap-1.5 text-center text-[11px] text-muted-foreground"
    >
      {supported ? (
        <canvas
          ref={canvasRef}
          aria-label={isWorking ? "LivLiv 2.5D 캐릭터가 작업 중입니다" : "LivLiv 2.5D 캐릭터"}
          style={{ width: size, height: size }}
          className="rounded-lg border border-border/60 bg-muted/20"
        />
      ) : null}
      <span className="max-w-44 truncate">{status}</span>
      {modelInfo?.meta ? (
        <span className="max-w-44 truncate text-[10px] text-muted-foreground/80">
          {modelInfo.meta.author ? `제작: ${modelInfo.meta.author}` : "LivLiv 모델"}
          {modelInfo.meta.license?.id ? ` · ${modelInfo.meta.license.id}` : ""}
        </span>
      ) : null}
      {supported ? (
        <div className="flex flex-wrap items-center justify-center gap-1">
          <label className="cursor-pointer rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-accent">
            {loading ? "로딩…" : ".livliv 열기"}
            <input
              type="file"
              accept=".livliv,.zip"
              className="sr-only"
              disabled={loading}
              onChange={handleFileChange}
            />
          </label>
          <input
            type="url"
            value={customUrl}
            onChange={(event) => setCustomUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleLoadUrl();
            }}
            placeholder="/avatars/model.livliv"
            aria-label="LivLiv 모델 URL"
            className="w-28 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground"
          />
          {customUrl.trim() ? (
            <button
              type="button"
              disabled={loading}
              onClick={handleLoadUrl}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-accent"
            >
              적용
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
