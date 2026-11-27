import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeEnvironmentSettings,
  normalizeClientSettings,
  resolveEnvironmentIdentificationMode,
} from "./useSettings";

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });
});

describe("normalizeClientSettings", () => {
  it("fills missing or undefined fields such as chatHorizontalInsetPx from defaults", () => {
    const partial = { ...DEFAULT_CLIENT_SETTINGS } as Record<string, unknown>;
    delete partial.chatHorizontalInsetPx;
    expect(normalizeClientSettings(partial).chatHorizontalInsetPx).toBeNull();

    const withUndefined = {
      ...DEFAULT_CLIENT_SETTINGS,
      chatHorizontalInsetPx: undefined,
    } as unknown as Partial<typeof DEFAULT_CLIENT_SETTINGS>;
    expect(normalizeClientSettings(withUndefined).chatHorizontalInsetPx).toBeNull();
    expect(normalizeClientSettings({ chatHorizontalInsetPx: 48 }).chatHorizontalInsetPx).toBe(48);
  });
});
