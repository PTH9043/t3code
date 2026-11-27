import {
  ProceduralLifeController,
  resolveAvatarFrameIntervalMs,
} from "@t3tools/shared/assistantPresenceController";
import type { AssistantExpressionKey } from "@t3tools/contracts";
import { ZERO_VISEME_WEIGHTS } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import type { AssistantPresenceStore } from "../../assistantPresenceStore";
import {
  live2dCharacterMotion,
  live2dCharacterSource,
  type Live2DCharacterKind,
} from "./live2dCharacterSources";

const CORE_PATH = "/agent-characters/live2dcubismcore.min.js";
let coreLoading: Promise<void> | undefined;

function loadCore(): Promise<void> {
  if ("Live2DCubismCore" in window) return Promise.resolve();
  if (coreLoading) return coreLoading;
  coreLoading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CORE_PATH;
    script.addEventListener(
      "load",
      () => {
        if ("Live2DCubismCore" in window) resolve();
        else {
          script.remove();
          reject(new Error("Invalid Live2D Core"));
        }
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => {
        script.remove();
        reject(new Error("Live2D Core failed to load"));
      },
      { once: true },
    );
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    coreLoading = undefined;
    throw error;
  });
  return coreLoading;
}

interface CubismCoreModelLike {
  setParameterValueById?: (id: string, value: number, weight?: number) => void;
}

function applyCubismExpressionParams(
  coreModel: CubismCoreModelLike,
  expression: AssistantExpressionKey,
  weight: number,
): void {
  const setParam = coreModel.setParameterValueById?.bind(coreModel);
  if (!setParam) return;
  let smile = 0;
  let browY = 0;
  if (expression === "warm_smile" || expression === "proud_joy") {
    smile = expression === "proud_joy" ? 0.9 * weight : 0.65 * weight;
    browY = 0.25 * weight;
  } else if (expression === "firm_serious" || expression === "urgent_focus") {
    smile = -0.35 * weight;
    browY = -0.55 * weight;
  } else if (expression === "worried_care") {
    smile = 0.1 * weight;
    browY = -0.25 * weight;
  }
  setParam("ParamMouthSmile", smile, 0.7);
  setParam("ParamBrowLY", browY, 0.7);
  setParam("ParamBrowRY", browY, 0.7);
}

/**
 * Loads the chosen Live2D Cubism 4 preset (or custom `.model3.json` URL),
 * drives 60fps/30fps procedural gaze, blinking, breathing, expressions, and
 * 5-vowel lip-sync, and pauses completely (0fps) when hidden or reduced motion.
 */
export default function Live2DCharacter({
  character,
  isWorking,
  onError,
  size = 96,
  presenceStore,
  customModelUrl,
  idlePowerSave30Fps = true,
}: {
  character: Live2DCharacterKind;
  isWorking: boolean;
  onError: () => void;
  size?: number;
  presenceStore?: AssistantPresenceStore;
  customModelUrl?: string | null;
  idlePowerSave30Fps?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const working = useRef(isWorking);
  const storeRef = useRef(presenceStore);
  const powerSaveRef = useRef(idlePowerSave30Fps);
  const wake = useRef<(() => void) | null>(null);
  const errorHandler = useRef(onError);
  const [loading, setLoading] = useState(true);

  errorHandler.current = onError;
  storeRef.current = presenceStore;
  powerSaveRef.current = idlePowerSave30Fps;

  useEffect(() => {
    working.current = isWorking;
    wake.current?.();
  }, [isWorking]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let visible = true;
    let rafId: number | undefined;
    let previousDrawMs: number | undefined;
    let application: import("pixi.js").Application | undefined;
    let model: import("pixi-live2d-display/cubism4").Live2DModel | undefined;
    let lastMotion: number | undefined;
    let lastObservedCursorMs = 0;
    const life = new ProceduralLifeController();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const stopLoop = () => {
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      rafId = undefined;
      previousDrawMs = undefined;
    };

    const tick = (now: number) => {
      rafId = undefined;
      if (disposed || !visible || document.visibilityState === "hidden" || !model || !application) {
        return;
      }
      const snap = storeRef.current?.getSnapshot();
      const mode = snap?.mode ?? (working.current ? "working_bg" : "idle");
      const intervalMs = resolveAvatarFrameIntervalMs({
        hidden: false,
        reducedMotion: reducedMotion.matches,
        mode,
        idlePowerSave30Fps: powerSaveRef.current,
      });

      const dtMs = previousDrawMs === undefined ? 16.67 : Math.min(now - previousDrawMs, 100);
      if (intervalMs !== null && previousDrawMs !== undefined && dtMs < intervalMs * 0.85) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      previousDrawMs = now;

      try {
        const desired = live2dCharacterMotion(character, working.current || mode === "working_bg");
        if (desired !== lastMotion && !reducedMotion.matches) {
          lastMotion = desired;
          void model.motion("", desired).catch(() => {
            if (!disposed) errorHandler.current();
          });
        }

        const cursorMs = storeRef.current?.getLastCursorMoveMs() ?? 0;
        if (snap && cursorMs > lastObservedCursorMs) {
          lastObservedCursorMs = cursorMs;
          life.notifyCursorMove(snap.gazeTarget.x, snap.gazeTarget.y, now);
        }

        const frame = life.step({
          dtMs,
          nowMs: now,
          mode,
          expression: snap?.expression ?? "neutral",
          expressionWeight: snap?.expressionWeight ?? 0.6,
          gazeTarget: snap?.gazeTarget ?? { x: 0, y: 0, source: "saccade_idle" },
          visemeWeights: snap?.visemeWeights ?? ZERO_VISEME_WEIGHTS,
        });

        model.update(dtMs);

        // Apply normalized procedural parameters onto Cubism 4 coreModel (missing IDs are safely ignored).
        const coreModel = (model.internalModel as { coreModel?: CubismCoreModelLike } | undefined)
          ?.coreModel;
        if (coreModel?.setParameterValueById) {
          const setParam = coreModel.setParameterValueById.bind(coreModel);
          setParam("ParamEyeBallX", frame.eyeX, 0.85);
          setParam("ParamEyeBallY", frame.eyeY, 0.85);
          setParam("ParamAngleX", frame.headX * 30, 0.8);
          setParam("ParamAngleY", frame.headY * 24, 0.8);
          setParam("ParamAngleZ", frame.headX * -6, 0.5);
          setParam("ParamBodyAngleX", frame.bodyX * 12, 0.7);
          setParam("ParamEyeLOpen", frame.eyeOpen, 1.0);
          setParam("ParamEyeROpen", frame.eyeOpen, 1.0);
          setParam("ParamBreath", frame.breath, 0.85);
          if (frame.mouthOpenY > 0.01 || mode === "speaking") {
            setParam("ParamMouthOpenY", frame.mouthOpenY, 1.0);
            setParam("ParamMouthForm", frame.mouthForm, 0.85);
          }
          applyCubismExpressionParams(
            coreModel,
            snap?.expression ?? "neutral",
            frame.expressionWeight,
          );
        }

        application.renderer.render(application.stage);

        if (intervalMs !== null) {
          rafId = requestAnimationFrame(tick);
        }
      } catch {
        stopLoop();
        if (!disposed) errorHandler.current();
      }
    };

    const restart = () => {
      stopLoop();
      if (!disposed && visible && document.visibilityState !== "hidden" && model && application) {
        rafId = requestAnimationFrame(tick);
      }
    };

    wake.current = restart;
    document.addEventListener("visibilitychange", restart);
    reducedMotion.addEventListener("change", restart);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            restart();
          });
    observer?.observe(element);

    const resolvedSource =
      customModelUrl?.trim() && customModelUrl.trim().endsWith(".model3.json")
        ? customModelUrl.trim()
        : live2dCharacterSource(character);

    void (async () => {
      await loadCore();
      const PIXI = await import("pixi.js");
      const { install } = await import("@pixi/unsafe-eval");
      install(PIXI);
      const { Live2DModel } = await import("pixi-live2d-display/cubism4");
      if (disposed) return;
      application = new PIXI.Application({
        width: size,
        height: size,
        backgroundAlpha: 0,
        antialias: true,
        autoStart: false,
        resolution: Math.min(window.devicePixelRatio || 1, 1.5),
        autoDensity: true,
      });
      element.appendChild(application.view);
      const loaded = await Live2DModel.from(resolvedSource, {
        autoUpdate: false,
        autoInteract: false,
      });
      if (disposed) {
        loaded.destroy({ children: true, texture: true, baseTexture: true });
        return;
      }
      model = loaded;
      model.anchor.set(0.5, 0.5);
      const scale = Math.min(
        (size - 6) / Math.max(model.width, 1),
        (size - 6) / Math.max(model.height, 1),
      );
      model.scale.set(scale);
      model.position.set(size / 2, size / 2);
      application.stage.addChild(model);
      setLoading(false);
      restart();
    })().catch(() => {
      if (!disposed) errorHandler.current();
    });

    return () => {
      disposed = true;
      wake.current = null;
      stopLoop();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", restart);
      reducedMotion.removeEventListener("change", restart);
      application?.destroy(true, { children: true, texture: true, baseTexture: true });
    };
  }, [character, customModelUrl, size]);

  return (
    <div
      ref={host}
      style={{ width: size, height: size }}
      role="img"
      aria-label={loading ? "Live2D 캐릭터 불러오는 중" : "Live2D 캐릭터"}
    />
  );
}
