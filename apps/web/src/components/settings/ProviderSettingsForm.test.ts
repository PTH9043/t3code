import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("exposes reversible independent Claude cache settings", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")]!;
    const fields = deriveProviderSettingsFields(claude);
    for (const key of ["promptCacheTtl", "subagentPromptCacheTtl"]) {
      const field = fields.find((candidate) => candidate.key === key)!;
      expect(field.control).toBe("select");
      expect(field.options?.map((option) => option.value)).toEqual(["inherit", "5m", "1h"]);
      expect(
        nextProviderConfigWithFieldValue({ [key]: "1h", binaryPath: "claude" }, field, "inherit"),
      ).toEqual({ [key]: "inherit", binaryPath: "claude" });
    }
  });
  it("exposes reversible Claude connector and user plugin isolation controls", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")]!;
    const fields = deriveProviderSettingsFields(claude);

    const connectors = fields.find((f) => f.key === "disableClaudeAiConnectors")!;
    expect(connectors.control).toBe("switch");
    expect(connectors.defaultBooleanValue).toBe(true);
    expect(nextProviderConfigWithFieldValue(undefined, connectors, false)).toEqual({
      disableClaudeAiConnectors: false,
    });
    expect(
      nextProviderConfigWithFieldValue({ disableClaudeAiConnectors: false }, connectors, true),
    ).toBeUndefined();

    const bulkPlugins = fields.find((f) => f.key === "disableUserPlugins")!;
    expect(bulkPlugins.control).toBe("switch");
    expect(bulkPlugins.defaultBooleanValue).toBe(false);

    const selectivePlugins = fields.find((f) => f.key === "disabledPlugins")!;
    expect(selectivePlugins.control).toBe("text");
    expect(selectivePlugins.clearWhenEmpty).toBe("omit");

    const skipAgents = fields.find((f) => f.key === "skipDuplicateAgentsMdInjection")!;
    expect(skipAgents.control).toBe("switch");
    const proactive = fields.find((f) => f.key === "proactiveCompactEnabled")!;
    expect(proactive.control).toBe("switch");
  });
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "서버 비밀번호",
      description: "디스크에 일반 텍스트로 저장됩니다.",
      control: "password",
    });
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("reads non-string config values as blank strings", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("reads non-boolean config values as false booleans", () => {
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
  });

  it("reads missing boolean config values from the supplied default", () => {
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});
