import {
  ProceduralLifeController,
  resolveAvatarFrameIntervalMs,
} from "@t3tools/shared/assistantPresenceController";
import { ZERO_VISEME_WEIGHTS, type AssistantExpressionKey } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import type { AssistantPresenceStore } from "../../assistantPresenceStore";

const ROOT = "/agent-characters";

function applyVrmExpression(
  vrm: VRM,
  expression: AssistantExpressionKey,
  weight: number,
  blinkValue: number,
): void {
  const mgr = vrm.expressionManager;
  if (!mgr) return;
  const targets: Record<string, number> = {
    happy: 0,
    angry: 0,
    sad: 0,
    relaxed: 0,
    surprised: 0,
  };
  switch (expression) {
    case "warm_smile":
      targets.happy = 0.55 * weight;
      targets.relaxed = 0.3 * weight;
      break;
    case "proud_joy":
      targets.happy = 0.85 * weight;
      targets.relaxed = 0.2 * weight;
      break;
    case "firm_serious":
      targets.angry = 0.42 * weight;
      break;
    case "worried_care":
      targets.sad = 0.4 * weight;
      targets.relaxed = 0.25 * weight;
      break;
    case "urgent_focus":
      targets.surprised = 0.45 * weight;
      targets.angry = 0.25 * weight;
      break;
    case "neutral":
      targets.relaxed = 0.22 * weight;
      break;
  }
  for (const [name, value] of Object.entries(targets)) {
    mgr.setValue(name, value);
  }
  mgr.setValue("blink", blinkValue);
}

/**
 * Renders the chosen VRM avatar (built-in Polybot or user `.vrm` URL) with
 * procedural eye gaze (`VRMLookAt`), blinking, breathing, 6-expression spring
 * blending, 5-vowel visemes (`aa`/`ih`/`ou`/`ee`/`oh`), and hidden-tab 0fps pause.
 */
export default function VrmCharacter({
  isWorking,
  size = 96,
  presenceStore,
  customModelUrl,
  idlePowerSave30Fps = true,
}: {
  isWorking: boolean;
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
  const [error, setError] = useState(false);

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
    let previousTime: number | undefined;
    let model: GLTF | undefined;
    let idle: GLTF | undefined;
    let walk: GLTF | undefined;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      setError(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(size, size);
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 2));
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(1, 2, 3);
    scene.add(light);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    const lookTarget = new THREE.Object3D();
    scene.add(lookTarget);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const life = new ProceduralLifeController();
    let lastObservedCursorMs = 0;

    let draw: ((now: number) => void) | undefined;
    const stopLoop = () => {
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      rafId = undefined;
      previousTime = undefined;
    };
    const restart = () => {
      stopLoop();
      if (!disposed && visible && document.visibilityState !== "hidden" && draw) {
        rafId = requestAnimationFrame(draw);
      }
    };
    wake.current = restart;
    const visibilityChanged = () => restart();
    document.addEventListener("visibilitychange", visibilityChanged);
    motion.addEventListener("change", visibilityChanged);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            restart();
          });
    observer?.observe(element);

    const vrmSource =
      customModelUrl?.trim() && customModelUrl.trim().endsWith(".vrm")
        ? customModelUrl.trim()
        : `${ROOT}/polybot.vrm`;

    const load = async (url: string, keep: (value: GLTF) => void) => {
      const result = await loader.loadAsync(url);
      if (disposed) VRMUtils.deepDispose(result.scene);
      else keep(result);
      return result;
    };
    void Promise.all([
      load(vrmSource, (value) => {
        model = value;
      }),
      load(`${ROOT}/idle.vrma`, (value) => {
        idle = value;
      }),
      load(`${ROOT}/walk.vrma`, (value) => {
        walk = value;
      }),
    ])
      .then(([modelGltf, idleGltf, walkGltf]) => {
        if (disposed) return;
        const vrm = modelGltf.userData.vrm as VRM | undefined;
        const idleAnimation = idleGltf.userData.vrmAnimations?.[0];
        const walkAnimation = walkGltf.userData.vrmAnimations?.[0];
        if (!vrm || !idleAnimation || !walkAnimation) throw new Error("Invalid character assets");
        VRMUtils.rotateVRM0(vrm);
        scene.add(vrm.scene);
        const bounds = new THREE.Box3().setFromObject(vrm.scene);
        const center = bounds.getCenter(new THREE.Vector3());
        const height = Math.max(bounds.getSize(new THREE.Vector3()).y, 0.5);
        camera.position.set(center.x, center.y, center.z + height * 2.6);
        camera.lookAt(center);
        camera.updateProjectionMatrix();
        lookTarget.position.set(center.x, center.y + height * 0.25, center.z + height * 2.0);
        if (vrm.lookAt) {
          vrm.lookAt.target = lookTarget;
        }
        const mixer = new THREE.AnimationMixer(vrm.scene);
        const actions = {
          idle: mixer.clipAction(createVRMAnimationClip(idleAnimation, vrm)),
          working: mixer.clipAction(createVRMAnimationClip(walkAnimation, vrm)),
        };
        let active: THREE.AnimationAction | undefined;
        const headBone = vrm.humanoid?.getNormalizedBoneNode("head");
        const spineBone = vrm.humanoid?.getNormalizedBoneNode("spine");
        const chestBone = vrm.humanoid?.getNormalizedBoneNode("chest");

        draw = (now: number) => {
          rafId = undefined;
          if (disposed || !visible || document.visibilityState === "hidden") return;
          const snap = storeRef.current?.getSnapshot();
          const mode = snap?.mode ?? (working.current ? "working_bg" : "idle");
          const intervalMs = resolveAvatarFrameIntervalMs({
            hidden: false,
            reducedMotion: motion.matches,
            mode,
            idlePowerSave30Fps: powerSaveRef.current,
          });
          const dtMs = previousTime === undefined ? 16.67 : Math.min(now - previousTime, 100);
          if (intervalMs !== null && previousTime !== undefined && dtMs < intervalMs * 0.85) {
            rafId = requestAnimationFrame(draw!);
            return;
          }
          previousTime = now;

          const desired = working.current || mode === "working_bg" ? actions.working : actions.idle;
          if (active !== desired) {
            active?.stop();
            desired.reset().play();
            active = desired;
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

          const delta = dtMs / 1000;
          mixer.update(delta);

          // Procedural gaze target + head/chest breathing overlay
          lookTarget.position.set(
            center.x + frame.eyeX * height * 0.9,
            center.y + height * 0.25 + frame.eyeY * height * 0.6,
            center.z + height * 2.0,
          );
          if (headBone) {
            headBone.rotation.y += frame.headX * 0.32;
            headBone.rotation.x += -frame.headY * 0.22;
          }
          const breathOffset = (frame.breath - 0.5) * 0.04;
          if (spineBone) spineBone.rotation.x += breathOffset;
          if (chestBone) chestBone.rotation.x += breathOffset * 0.7;

          // 6-expression spring blending + blink + 5-vowel lip-sync
          applyVrmExpression(
            vrm,
            snap?.expression ?? "neutral",
            frame.expressionWeight,
            1 - frame.eyeOpen,
          );
          const mgr = vrm.expressionManager;
          if (mgr) {
            mgr.setValue("aa", frame.viseme.a);
            mgr.setValue("ih", frame.viseme.i);
            mgr.setValue("ou", frame.viseme.u);
            mgr.setValue("ee", frame.viseme.e);
            mgr.setValue("oh", frame.viseme.o);
          }

          vrm.update(delta);
          renderer.render(scene, camera);
          if (intervalMs !== null) {
            rafId = requestAnimationFrame(draw!);
          }
        };
        restart();
      })
      .catch(() => {
        if (!disposed) setError(true);
      });

    return () => {
      disposed = true;
      wake.current = null;
      stopLoop();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", visibilityChanged);
      motion.removeEventListener("change", visibilityChanged);
      for (const asset of [model, idle, walk]) if (asset) VRMUtils.deepDispose(asset.scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [customModelUrl, size]);

  return (
    <div>
      <div
        ref={host}
        style={{ width: size, height: size }}
        className="h-24 w-24"
        role="img"
        aria-label="3D 캐릭터"
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          3D 캐릭터를 불러오지 못했습니다.
        </p>
      ) : null}
    </div>
  );
}
