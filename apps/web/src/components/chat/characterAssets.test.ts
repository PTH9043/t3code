// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { expect, it, vi } from "vite-plus/test";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { AnimationMixer } from "three";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";

it("loads the packaged VRM and builds both humanoid animation clips", async () => {
  // Loading does not need pixels in this test; the browser supplies the real image decoder.
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close: () => {} }));
  if (typeof ProgressEvent === "undefined") {
    vi.stubGlobal("ProgressEvent", class ProgressEvent extends Event {});
  }
  try {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const load = async (filename: string) => {
      const bytes = await NodeFSP.readFile(
        NodeURL.fileURLToPath(
          new URL(`../../../public/agent-characters/${filename}`, import.meta.url),
        ),
      );
      const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return loader.parseAsync(array, "");
    };
    const [model, idle, walk] = await Promise.all([
      load("polybot.vrm"),
      load("idle.vrma"),
      load("walk.vrma"),
    ]);
    const vrm = model.userData.vrm as VRM;
    expect(vrm.humanoid).toBeDefined();
    VRMUtils.rotateVRM0(vrm);
    for (const animation of [idle.userData.vrmAnimations[0], walk.userData.vrmAnimations[0]]) {
      const clip = createVRMAnimationClip(animation, vrm);
      expect(clip.duration).toBeGreaterThan(0);
      expect(clip.tracks.length).toBeGreaterThan(0);
      const mixer = new AnimationMixer(vrm.scene);
      const hips = vrm.humanoid.getNormalizedBoneNode("hips")!;
      const before = [...hips.position.toArray(), ...hips.quaternion.toArray()];
      mixer.clipAction(clip).play();
      mixer.update(Math.min(0.25, clip.duration / 2));
      vrm.update(0.1);
      const after = [...hips.position.toArray(), ...hips.quaternion.toArray()];
      expect(after.every(Number.isFinite)).toBe(true);
      expect(after).not.toEqual(before);
      mixer.stopAllAction();
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
