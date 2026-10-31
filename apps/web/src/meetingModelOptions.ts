import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import type { ProviderInstanceEntry } from "./providerInstances";
import { getProviderModelCapabilities } from "./providerModels";

/** Persist the displayed defaults so a CLI's local config cannot silently use higher effort. */
export function meetingModelDefaultOptions(entry: ProviderInstanceEntry, model: string) {
  return getProviderOptionDescriptors({
    caps: getProviderModelCapabilities(entry.models, model, entry.driverKind),
  }).flatMap((descriptor) => {
    if (descriptor.type !== "select") return [];
    const current = getProviderOptionCurrentValue(descriptor);
    const value =
      typeof current === "string" && descriptor.options.some((option) => option.id === current)
        ? current
        : (descriptor.options.find((option) => option.isDefault)?.id ?? descriptor.options[0]?.id);
    return value === undefined ? [] : [{ id: descriptor.id, value }];
  });
}
