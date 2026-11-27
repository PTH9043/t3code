import { describe, expect, it } from "vite-plus/test";
import { resolveAvatarAffectDirective } from "./livingPersonaAvatarBridge.ts";

describe("livingPersonaAvatarBridge LivLiv 2.5D mapping", () => {
  it("maps PAD coordinates and situation modes to deterministic LivLiv expressions", () => {
    const alert = resolveAvatarAffectDirective({
      p: -0.4,
      a: 0.5,
      d: 0.2,
      situationMode: "INCIDENT_RESPONSE",
    });
    expect(alert.livliv).toEqual({
      expressionId: "surprised",
      action: "tilt",
      smile: 0,
    });

    const celebrate = resolveAvatarAffectDirective({
      p: 0.6,
      a: 0.2,
      d: 0.3,
      situationMode: "CELEBRATION",
    });
    expect(celebrate.livliv.expressionId).toBe("smile");
    expect(celebrate.livliv.action).toBe("nod");
    expect(celebrate.livliv.smile).toBeGreaterThan(0.5);

    const neutral = resolveAvatarAffectDirective({
      p: 0.1,
      a: 0.05,
      d: 0.2,
      situationMode: "DEEP_WORK",
    });
    expect(neutral.livliv.expressionId).toBeNull();
    expect(neutral.livliv.action).toBeNull();
  });
});
