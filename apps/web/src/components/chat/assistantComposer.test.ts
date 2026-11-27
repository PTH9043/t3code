import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import { availableAssistantModel } from "./assistantComposer";

it("does not alter the existing assistant draft when resolving its configured model", () => {
  const thread = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("shared-thread"));
  const store = useComposerDraftStore.getState();
  const ordinary = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "ordinary-model",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const assistant = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "assistant-model",
    options: [{ id: "reasoningEffort", value: "medium" }],
  };
  store.setPrompt(thread, "ordinary unfinished draft");
  store.setModelSelection(thread, ordinary);
  const before = structuredClone(store.getComposerDraft(thread));
  expect(
    availableAssistantModel(assistant, { instanceId: "codex", enabled: true, isAvailable: true }, [
      { slug: "assistant-model" },
    ]),
  ).toEqual(assistant);
  expect(store.getComposerDraft(thread)).toEqual(before);
  expect(store.getComposerDraft(thread)?.prompt).toBe("ordinary unfinished draft");
  expect(store.getComposerDraft(thread)?.modelSelectionByProvider[ordinary.instanceId]).toEqual(
    ordinary,
  );
  store.setPrompt(thread, "voice transcript");
  expect(store.getComposerDraft(thread)?.prompt).toBe("voice transcript");
  expect(store.getComposerDraft(thread)?.modelSelectionByProvider[ordinary.instanceId]).toEqual(
    ordinary,
  );
});

it("does not select or dispatch a fallback when the assistant model is unavailable", () => {
  const selected = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-terra",
    options: [{ id: "reasoningEffort", value: "medium" }],
  };
  const send = vi.fn();
  for (const [instance, options] of [
    [undefined, [{ slug: "gpt-6-astra" }]],
    [{ instanceId: "codex", enabled: false, isAvailable: true }, [{ slug: selected.model }]],
    [{ instanceId: "codex", enabled: true, isAvailable: false }, [{ slug: selected.model }]],
    [{ instanceId: "other", enabled: true, isAvailable: true }, [{ slug: selected.model }]],
    [{ instanceId: "codex", enabled: true, isAvailable: true }, [{ slug: "gpt-6-astra" }]],
  ] as const) {
    const model = availableAssistantModel(selected, instance, options);
    if (model) send(model);
    expect(model).toBeNull();
  }
  expect(send).not.toHaveBeenCalled();
});
