import type {
  ModelCapabilities,
  ModelSelection,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly providerDriverLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function humanizeInstanceId(instanceId: string): string {
  return instanceId
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function providerDriverLabel(driver: string): string {
  if (driver === "codex") return "코덱스";
  if (driver === "claudeAgent") return "클로드";
  if (driver === "gemini") return "Gemini";
  return humanizeInstanceId(driver) || driver;
}

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  const humanized = humanizeInstanceId(provider.instanceId);
  if (humanized && humanized !== providerDriverLabel(provider.driver)) return humanized;
  return providerDriverLabel(provider.driver);
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/**
 * A stored model selection is only usable when its provider instance is
 * currently enabled, installed, and authenticated on the server. Returns the
 * selection unchanged when usable, otherwise `null` so callers fall through to
 * the server's default model. A missing config (environment offline) cannot be
 * validated, so stored selections pass through untouched.
 */
export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  return provider &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
    ? selection
    : null;
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (!provider.enabled || !provider.installed || provider.auth.status === "unauthenticated") {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: providerLabel,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const providerLabel = fallbackModelSelection.instanceId;
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver: "unknown",
        isDefault: false,
        isLegacy: false,
        capabilities: null,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<
    string,
    {
      providerLabel: string;
      providerDriver: string;
      providerDriverLabel: string;
      models: ModelOption[];
    }
  >();
  const driverOrder: string[] = [];
  for (const option of options) {
    if (!driverOrder.includes(option.providerDriver)) {
      driverOrder.push(option.providerDriver);
    }
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        providerDriver: option.providerDriver,
        providerDriverLabel: providerDriverLabel(option.providerDriver),
        models: [option],
      });
    }
  }

  return [...groups.entries()]
    .toSorted(
      ([leftKey, left], [rightKey, right]) =>
        driverOrder.indexOf(left.providerDriver) - driverOrder.indexOf(right.providerDriver) ||
        Number(Boolean(right.providerLabel)) - Number(Boolean(left.providerLabel)) ||
        left.providerLabel.localeCompare(right.providerLabel) ||
        leftKey.localeCompare(rightKey),
    )
    .map(([providerKey, group]) => ({
      providerKey,
      providerLabel: group.providerLabel,
      providerDriver: group.providerDriver,
      providerDriverLabel: group.providerDriverLabel,
      models: group.models,
    }));
}

function modelMenuAction(option: ModelOption, selectedModel: ModelSelection | null): MenuAction {
  return {
    id: `model:${option.key}`,
    title: option.label,
    state:
      option.selection.instanceId === selectedModel?.instanceId &&
      option.selection.model === selectedModel.model
        ? "on"
        : undefined,
  };
}

export function buildModelMenuActions(
  groups: ReadonlyArray<ProviderGroup>,
  selectedModel: ModelSelection | null,
): MenuAction[] {
  const accountCounts = new Map<string, number>();
  for (const group of groups) {
    accountCounts.set(group.providerDriver, (accountCounts.get(group.providerDriver) ?? 0) + 1);
  }

  return groups.flatMap((group) => {
    const currentModels = group.models.filter((model) => !model.isLegacy);
    const legacyModels = group.models.filter((model) => model.isLegacy);
    const selected = group.models.find(
      (model) =>
        model.selection.instanceId === selectedModel?.instanceId &&
        model.selection.model === selectedModel.model,
    );
    const title =
      (accountCounts.get(group.providerDriver) ?? 0) > 1 &&
      group.providerLabel !== group.providerDriverLabel
        ? `${group.providerDriverLabel} · ${group.providerLabel}`
        : group.providerLabel;

    return [
      ...(currentModels.length > 0
        ? [
            {
              id: `provider:${group.providerKey}`,
              title,
              subtitle: selected && !selected.isLegacy ? selected.label : undefined,
              subactions: currentModels.map((option) => modelMenuAction(option, selectedModel)),
            },
          ]
        : []),
      ...(legacyModels.length > 0
        ? [
            {
              id: `legacy-models:${group.providerKey}`,
              title: `${title} legacy models`,
              subtitle: selected?.isLegacy ? selected.label : undefined,
              subactions: legacyModels.map((option) => modelMenuAction(option, selectedModel)),
            },
          ]
        : []),
    ];
  });
}
