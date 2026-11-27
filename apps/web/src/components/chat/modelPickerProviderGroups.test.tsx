import {
  DEFAULT_SERVER_SETTINGS,
  OPENAI_API_CONNECTION,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
} from "../../providerInstances";
import { TooltipProvider } from "../ui/tooltip";
import { ModelPickerContent } from "./ModelPickerContent";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { ProviderModelPicker } from "./ProviderModelPicker";
import {
  modelPickerProviderGroupKey,
  modelPickerProviderGroupLabel,
} from "./modelPickerProviderGroups";

const combobox = vi.hoisted(() =>
  vi.fn(
    (_props: {
      items: readonly string[];
      filteredItems: readonly string[];
      onValueChange: (key: string) => void;
    }) => null,
  ),
);
const favorites = vi.hoisted(() => [] as Array<{ provider: ProviderInstanceId; model: string }>);
vi.mock("../ui/combobox", async (original) => ({
  ...(await original<typeof import("../ui/combobox")>()),
  Combobox: combobox,
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => favorites,
  useUpdateClientSettings: () => () => {},
}));

function instance(id: string, displayName: string, api: boolean): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: api ? { status: "authenticated", type: "apiKey" } : { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

it("offers Claude API as its own picker group without changing subscription grouping", () => {
  const entries = deriveProviderInstanceEntries([
    instance("claudeAgent", "Claude", false),
    instance("claude_work", "Work account", false),
    instance("claude_api_example", "Claude API", true),
    instance("custom_id", "Second API", true),
  ]);
  expect(entries.map(modelPickerProviderGroupKey)).toEqual([
    "claudeAgent",
    "claudeAgent",
    "claudeAgent:claude_api_example",
    "claudeAgent:custom_id",
  ]);
  expect(entries.map(modelPickerProviderGroupLabel)).toEqual([
    "Claude",
    "Claude",
    "Claude API",
    "Second API",
  ]);
  const markup = renderToStaticMarkup(
    <TooltipProvider delay={0}>
      <ModelPickerSidebar
        selectedInstanceId={entries[0]!.instanceId}
        onSelectInstance={() => {}}
        instanceEntries={entries}
      />
    </TooltipProvider>,
  );
  expect(markup).toContain('data-model-picker-provider="claudeAgent"');
  expect(markup).toContain('data-model-picker-provider="claudeAgent:claude_api_example"');
  expect(markup).toContain('aria-label="Claude API"');
  expect(markup).toContain('data-model-picker-api-badge="true"');
  expect(markup).toContain('aria-label="Second API"');
});

it("keeps both room accounts available in the normal picker before the user picks a model", () => {
  const entries = deriveProviderInstanceEntries([
    instance("claudeAgent", "Personal", false),
    instance("claude_work", "Work", false),
  ]).map((entry) => ({ ...entry, individualAccount: true }));
  const markup = renderToStaticMarkup(
    <TooltipProvider delay={0}>
      <ProviderModelPicker
        activeInstanceId={entries[0]!.instanceId}
        model=""
        lockedProvider={null}
        triggerPlaceholder="계정과 모델 선택"
        instanceEntries={entries}
        modelOptionsByInstance={new Map()}
        onInstanceModelChange={() => {}}
      />
      <ModelPickerSidebar
        selectedInstanceId={entries[0]!.instanceId}
        onSelectInstance={() => {}}
        instanceEntries={entries}
      />
    </TooltipProvider>,
  );
  expect(markup).toContain('data-chat-provider-model-picker="true"');
  expect(markup).toContain("계정과 모델 선택");
  expect(markup).toContain('aria-label="Personal"');
  expect(markup).toContain('aria-label="Work"');
});

it("shows the first usable room account instead of an empty saved selection or unrelated favorites", () => {
  const entries = deriveProviderInstanceEntries([
    instance("empty", "Empty account", false),
    instance("room_account", "Room account", false),
  ]).map((entry) => ({ ...entry, individualAccount: true }));
  const account = entries[1]!;
  const onInstanceModelChange = vi.fn();
  try {
    favorites.push({ provider: ProviderInstanceId.make("other_account"), model: "other-model" });
    renderToStaticMarkup(
      <ModelPickerContent
        activeInstanceId={NO_PROVIDER_MODEL_SELECTION.instanceId}
        model=""
        preferReadyAccount
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={
          new Map([[account.instanceId, [{ slug: "room-model", name: "Room model" }]]])
        }
        terminalOpen={false}
        onInstanceModelChange={onInstanceModelChange}
      />,
    );
    const list = combobox.mock.lastCall![0];
    expect(list.filteredItems).toEqual([modelPickerModelKey(account.instanceId, "room-model")]);
    expect(onInstanceModelChange).not.toHaveBeenCalled();
    list.onValueChange(list.filteredItems[0]!);
    expect(onInstanceModelChange).toHaveBeenCalledExactlyOnceWith(account.instanceId, "room-model");
  } finally {
    favorites.length = 0;
  }
});

it("shows API on the selected model control only for an API connection", () => {
  const entries = deriveProviderInstanceEntries([
    instance("claudeAgent", "Claude", false),
    instance("claude_api_example", "Claude API", true),
  ]);
  const render = (index: number) =>
    renderToStaticMarkup(
      <TooltipProvider delay={0}>
        <ProviderModelPicker
          activeInstanceId={entries[index]!.instanceId}
          model="claude-haiku-5-5"
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={new Map()}
          onInstanceModelChange={() => {}}
        />
      </TooltipProvider>,
    );
  expect(render(1)).toContain('data-chat-claude-api="true"');
  expect(render(0)).not.toContain('data-chat-claude-api="true"');
});

it("keeps same-name OpenAI accounts individually selectable, including colliding ID suffixes", () => {
  const driver = ProviderDriverKind.make("opencode");
  const name = "Billing";
  const slug = "t3_openai/shared-model";
  const ids = ["openai_api_a123456", "custom-b123456", "ordinary-a", "ordinary-b"].map((id) =>
    ProviderInstanceId.make(id),
  );
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(ids.map((id) => ({ ...instance(id, name, false), driver }))),
    {
      providers: DEFAULT_SERVER_SETTINGS.providers,
      providerInstances: Object.fromEntries(
        ids.map((id, index) => [
          id,
          {
            driver,
            displayName: name,
            config: {
              apiConnection: index < 2 ? OPENAI_API_CONNECTION : { providerId: "another" },
            },
          },
        ]),
      ),
    },
  );
  expect(entries.map(modelPickerProviderGroupKey)).toEqual([
    `openai-api:${ids[0]}`,
    `openai-api:${ids[1]}`,
    "opencode:Billing",
    "opencode:Billing",
  ]);
  expect(entries.map(modelPickerProviderGroupLabel)).toEqual([
    "#a123456 · Billing",
    "#b123456 · Billing",
    "Billing",
    "Billing",
  ]);
  const paid = entries.slice(0, 2);
  const options = new Map(
    paid.map(({ instanceId }) => [instanceId, [{ slug, name: "Shared model" }]]),
  );
  const onInstanceModelChange = vi.fn();
  for (const account of paid) {
    const props = {
      activeInstanceId: account.instanceId,
      instanceEntries: entries,
      model: slug,
      modelOptionsByInstance: options,
      onInstanceModelChange,
      lockedProvider: null,
      terminalOpen: false,
    };
    const rail = renderToStaticMarkup(<ModelPickerContent {...props} />);
    for (const entry of paid) {
      expect(rail).toContain(
        `aria-label="#${entry.openAiAccountTag} · Billing (${entry.instanceId})"`,
      );
    }
    const list = combobox.mock.lastCall![0];
    expect(list.items).toEqual(paid.map(({ instanceId }) => modelPickerModelKey(instanceId, slug)));
    expect(list.filteredItems).toEqual([modelPickerModelKey(account.instanceId, slug)]);
    list.onValueChange(list.filteredItems[0]!);
    expect(onInstanceModelChange).toHaveBeenLastCalledWith(account.instanceId, slug);
    const trigger = renderToStaticMarkup(
      <ProviderModelPicker {...props} triggerAriaLabel="모델 선택" />,
    );
    expect(trigger).toContain(`API #${account.openAiAccountTag}`);
    expect(trigger).toContain(`Billing (${account.instanceId})`);
  }
  expect(onInstanceModelChange).toHaveBeenCalledTimes(2);

  // With both accounts in favorites, select B while A is still the active account.
  favorites.push(...paid.map(({ instanceId }) => ({ provider: instanceId, model: slug })));
  try {
    renderToStaticMarkup(
      <ModelPickerContent
        activeInstanceId={paid[0]!.instanceId}
        model={slug}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        onInstanceModelChange={onInstanceModelChange}
        lockedProvider={null}
        terminalOpen={false}
      />,
    );
    const list = combobox.mock.lastCall![0];
    const second = modelPickerModelKey(paid[1]!.instanceId, slug);
    expect(list.filteredItems).toHaveLength(2);
    expect(list.filteredItems).toContain(second);
    list.onValueChange(second);
    expect(onInstanceModelChange).toHaveBeenLastCalledWith(paid[1]!.instanceId, slug);
  } finally {
    favorites.length = 0;
  }
});
