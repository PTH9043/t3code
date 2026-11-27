import { describe, expect, it } from "vite-plus/test";
import { buildMuseApiInstance, META_API_KEY_ENV_NAME } from "./MuseAccountDialog";

describe("MuseAccountDialog helpers", () => {
  it("builds a sensitive META_API_KEY provider instance config", () => {
    const instance = buildMuseApiInstance({
      displayName: "Muse Personal API",
      apiKey: "meta-live-key-123",
      accentColor: "#2563eb",
    });

    expect(instance.driver).toBe("muse");
    expect(instance.displayName).toBe("Muse Personal API");
    expect(instance.enabled).toBe(true);
    expect(instance.accentColor).toBe("#2563eb");
    expect(instance.environment).toEqual([
      { name: META_API_KEY_ENV_NAME, value: "meta-live-key-123", sensitive: true },
    ]);
  });

  it("rejects blank displayName or apiKey", () => {
    expect(() => buildMuseApiInstance({ displayName: " ", apiKey: "abc" })).toThrow();
    expect(() => buildMuseApiInstance({ displayName: "Muse", apiKey: "  " })).toThrow();
  });
});
