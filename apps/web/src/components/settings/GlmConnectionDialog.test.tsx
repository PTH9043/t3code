import { EnvironmentId, OPENCODE_API_KEY_ENV } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const commands = vi.hoisted(() => ({ update: vi.fn(), toast: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: Symbol("updateSettings") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => commands.update }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => new Error("save failed"),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: commands.toast } }));

import { buildGlmInstance, GlmConnectionDialog } from "./GlmConnectionDialog";

describe("GLM account connection", () => {
  beforeEach(() => {
    hooks.reset();
    commands.update.mockReset();
    commands.toast.mockReset();
  });

  it.each([
    ["coding", "https://api.z.ai/api/coding/paas/v4"],
    ["standard", "https://api.z.ai/api/paas/v4"],
  ] as const)("uses the user-selected %s endpoint and exact model list", (accountType, baseUrl) => {
    const instance = buildGlmInstance({
      accountType,
      displayName: "GLM",
      models: "model-a, model-b, model-a",
      apiKey: "secret",
    });
    expect(instance).toMatchObject({
      driver: "opencode",
      displayName: "GLM",
      enabled: true,
      config: {
        apiConnection: {
          providerId: "t3_glm",
          baseUrl,
          protocol: "chat-completions",
          models: ["model-a", "model-b"],
        },
      },
      environment: [{ name: OPENCODE_API_KEY_ENV, value: "secret", sensitive: true }],
    });
    expect(JSON.stringify(instance.config)).not.toContain("secret");
    expect((instance.config as { apiConnection: object }).apiConnection).not.toHaveProperty(
      "contextTokens",
    );
    expect((instance.config as { apiConnection: object }).apiConnection).not.toHaveProperty(
      "outputTokens",
    );
  });

  it("requires an explicit account type and model before saving, then adds only that account", async () => {
    commands.update.mockResolvedValue({ _tag: "Success", value: {} });
    const close = vi.fn();
    const environmentId = EnvironmentId.make("remote-device");
    const render = () => {
      hooks.beginRender();
      return GlmConnectionDialog({ open: true, environmentId, onOpenChange: close });
    };
    const save = () =>
      visitElements(
        render(),
        (element) =>
          Array.isArray(element.props.children) && element.props.children.includes("계정 추가"),
      );
    expect(save()!.props.disabled).toBe(true);
    const select = visitElements(render(), (element) => element.type === "select");
    (select!.props.onChange as (event: unknown) => void)({ target: { value: "coding" } });
    const model = visitElements(render(), (element) => element.props.placeholder === "예: glm-5.3");
    (model!.props.onChange as (event: unknown) => void)({ target: { value: "my-model" } });
    const key = visitElements(render(), (element) => element.props.type === "password");
    (key!.props.onChange as (event: unknown) => void)({ target: { value: "secret" } });
    expect(save()!.props.disabled).toBe(false);
    await (save()!.props.onClick as () => Promise<void>)();
    expect(commands.update.mock.calls[0]?.[0].environmentId).toBe(environmentId);
    const upsert = commands.update.mock.calls[0]?.[0].input.patch.providerInstancesToUpsert;
    expect(Object.keys(upsert)).toEqual([expect.stringMatching(/^glm_/)]);
    expect(Object.values(upsert)).toEqual([expect.objectContaining({ displayName: "GLM" })]);
    expect(close).toHaveBeenCalledWith(false);
  });
});
