// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { resolveAvatarFrameIntervalMs } from "@t3tools/shared/assistantPresenceController";
import { describe, expect, it, vi } from "vite-plus/test";
import { createAssistantPresenceStore } from "../../assistantPresenceStore";

describe("Gate 4: Avatar FPS power-saving, hidden-tab 0fps pause, and zero-setInterval guard", () => {
  it("pauses rendering completely when document is hidden and throttles idle power-save to 30fps", () => {
    expect(
      resolveAvatarFrameIntervalMs({
        hidden: true,
        reducedMotion: false,
        mode: "speaking",
        idlePowerSave30Fps: false,
      }),
    ).toBeNull();

    expect(
      resolveAvatarFrameIntervalMs({
        hidden: false,
        reducedMotion: true,
        mode: "speaking",
        idlePowerSave30Fps: false,
      }),
    ).toBeNull();

    const activeMs = resolveAvatarFrameIntervalMs({
      hidden: false,
      reducedMotion: false,
      mode: "speaking",
      idlePowerSave30Fps: true,
    });
    expect(activeMs).toBeCloseTo(1000 / 60, 1);

    const idleSaveMs = resolveAvatarFrameIntervalMs({
      hidden: false,
      reducedMotion: false,
      mode: "idle",
      idlePowerSave30Fps: true,
    });
    expect(idleSaveMs).toBeCloseTo(1000 / 30, 1);
  });

  it("avoids React subscriber re-renders during 60fps gaze and viseme updates", () => {
    const store = createAssistantPresenceStore("builtin-chief-of-staff");
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    for (let i = 0; i < 120; i += 1) {
      store.setGazeTarget({ x: i / 120, y: 0, source: "cursor" }, i * 16);
      store.setVisemeWeights({ a: 0.6, i: 0.1, u: 0, e: 0.2, o: 0.1, silence: 0.2 });
    }
    expect(listener).not.toHaveBeenCalled();

    store.setSemanticState({ mode: "speaking", expression: "warm_smile" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().mode).toBe("speaking");
    unsub();
  });

  it("ensures Live2DCharacter, VrmCharacter, and LivLivCharacter contain zero setInterval polling", () => {
    const chatDir = NodePath.resolve(import.meta.dirname);
    for (const file of ["Live2DCharacter.tsx", "VrmCharacter.tsx", "LivLivCharacter.tsx"]) {
      const content = NodeFS.readFileSync(NodePath.join(chatDir, file), "utf8");
      expect(content).not.toMatch(/\bsetInterval\s*\(/u);
    }
  });
});
