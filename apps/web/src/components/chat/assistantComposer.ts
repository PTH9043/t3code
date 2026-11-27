import type { ModelSelection } from "@t3tools/contracts";

export function availableAssistantModel(
  selected: ModelSelection | undefined,
  instance:
    | { readonly instanceId: string; readonly enabled: boolean; readonly isAvailable: boolean }
    | undefined,
  selectableModels: ReadonlyArray<{ readonly slug: string }>,
): ModelSelection | null {
  if (
    !selected ||
    !instance ||
    !instance.enabled ||
    !instance.isAvailable ||
    instance.instanceId !== selected.instanceId ||
    !selectableModels.some((model) => model.slug === selected.model)
  )
    return null;
  return selected;
}
