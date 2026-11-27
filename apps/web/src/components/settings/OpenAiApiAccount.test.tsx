import {
  EnvironmentId,
  configureOpenAiApiAccount,
  OPENAI_API_CREDENTIAL_ENV,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { it, expect, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { OpenAiApiConnectionDialog, OpenAiApiAccountForm } from "./OpenAiApiAccount";

const update = vi.hoisted(() => vi.fn());
vi.mock("react", async (orig) => {
  const react = await orig<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...react, useRef: reactHookHarness.useRef, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: Symbol("update") } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => update }));

it("saves only the new API instance with the model IDs entered in the account form", async () => {
  hooks.reset();
  const close = vi.fn();
  const environmentId = EnvironmentId.make("fixture");
  update.mockResolvedValue({ _tag: "Success", value: {} });
  hooks.beginRender();
  const dialog = OpenAiApiConnectionDialog({
    open: true,
    environmentId,
    onOpenChange: close,
    onBack: vi.fn(),
  });
  const form = visitElements(dialog, (el) => el.type === OpenAiApiAccountForm);
  if (!form) throw new Error("OpenAI account form is missing");
  const save = form.props.save as (instance: ProviderInstanceConfig) => Promise<void>;
  hooks.reset();
  const render = () => {
    hooks.beginRender();
    return OpenAiApiAccountForm({ save });
  };
  const enter = (field: "models" | "password", value: string) => {
    const input = visitElements(render(), (el) =>
      field === "models" ? el.props.spellCheck === false : el.props.type === "password",
    );
    if (!input) throw new Error("Account field missing: " + field);
    (input.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  };
  enter("models", "Exact-A, ft:Exact-B, Exact-A");
  enter("password", "synthetic");
  const submit = visitElements(render(), (el) => el.props.children === "계정 추가");
  if (!submit) throw new Error("Missing save action");
  await (submit.props.onClick as () => Promise<void>)();
  const patch = update.mock.calls[0]?.[0].input.patch;
  expect(Object.keys(patch)).toEqual(["providerInstancesToUpsert"]);
  const ids = Object.keys(patch.providerInstancesToUpsert);
  expect(ids).toHaveLength(1);
  expect(ids[0]).toMatch(/^openai_api_/);
  expect(patch.providerInstancesToUpsert[ids[0]!]).toMatchObject({
    config: { apiConnection: { models: ["Exact-A", "ft:Exact-B"] } },
    environment: [{ name: OPENAI_API_CREDENTIAL_ENV, sensitive: true }],
  });
  expect(close).toHaveBeenCalledWith(false);
});

it("retries one draft with the same ID and gives the next account a fresh ID and form", async () => {
  hooks.reset();
  update.mockReset();
  update
    .mockRejectedValueOnce(new Error("Fixture save failed"))
    .mockResolvedValue({ _tag: "Success", value: {} });
  let open = true;
  const environmentId = EnvironmentId.make("fixture");
  const render = () => {
    hooks.beginRender();
    const dialog = OpenAiApiConnectionDialog({
      open,
      environmentId,
      onOpenChange: (next) => {
        open = next;
      },
      onBack: vi.fn(),
    });
    const form = visitElements(dialog, (el) => el.type === OpenAiApiAccountForm);
    if (!form) throw new Error("Expected account form");
    return OpenAiApiAccountForm({
      save: form.props.save as (account: ProviderInstanceConfig) => Promise<void>,
    });
  };
  const field = (name: "name" | "models" | "key") => {
    const input = visitElements(
      render(),
      (el) =>
        typeof el.props.onChange === "function" &&
        (name === "key"
          ? el.props.type === "password"
          : name === "models"
            ? el.props.spellCheck === false
            : el.props.type === undefined && el.props.spellCheck === undefined),
    );
    if (!input) throw new Error("Expected field: " + name);
    return input.props;
  };
  const enter = (name: "name" | "models" | "key", value: string) =>
    (field(name).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  const submit = async () => {
    const button = visitElements(render(), (el) => el.props.children === "계정 추가");
    if (!button) throw new Error("Expected add button");
    expect(button.props.disabled).toBe(false);
    await (button.props.onClick as () => Promise<void>)();
  };
  enter("name", "First");
  enter("models", "Exact-A");
  enter("key", "synthetic-first");
  await submit();
  expect(open).toBe(true);
  expect(field("name").value).toBe("First");
  expect(field("models").value).toBe("Exact-A");
  expect(field("key").value).toBe("synthetic-first");
  await submit();
  expect(open).toBe(false);
  // The control center retains the same component across a close and reopen.
  render();
  open = true;
  expect(field("name").value).toBe("OpenAI API");
  expect(field("models").value).toBe("");
  expect(field("key").value).toBe("");
  enter("name", "Second");
  enter("models", "Exact-B");
  enter("key", "synthetic-second");
  await submit();
  expect(open).toBe(false);
  const patches = update.mock.calls.map(
    ([request]) => request.input.patch.providerInstancesToUpsert,
  );
  const ids = patches.map((patch) => Object.keys(patch)[0]!);
  expect(ids).toHaveLength(3);
  expect(ids[1]).toBe(ids[0]);
  expect(ids[2]).not.toBe(ids[1]);
  expect({ ...patches[1], ...patches[2] }).toMatchObject({
    [ids[1]!]: { displayName: "First", config: { apiConnection: { models: ["Exact-A"] } } },
    [ids[2]!]: { displayName: "Second", config: { apiConnection: { models: ["Exact-B"] } } },
  });
});

it("keeps a redacted account key when only the exact model list changes", () => {
  const initial = configureOpenAiApiAccount({
    displayName: "API",
    models: ["Old"],
    apiKey: "synthetic",
  });
  const existing = {
    ...initial,
    environment: [
      { name: OPENAI_API_CREDENTIAL_ENV, value: "", sensitive: true, valueRedacted: true },
    ],
  };
  const next = configureOpenAiApiAccount({
    existing,
    displayName: "API",
    models: ["New"],
    apiKey: "",
  });
  expect(next.environment).toEqual(existing.environment);
  expect(next.config).toMatchObject({ apiConnection: { models: ["New"] } });
});
