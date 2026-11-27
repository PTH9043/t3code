import type { DesktopAssistantModelUpdate, ModelSelection } from "@t3tools/contracts";
import * as Equal from "effect/Equal";

/** A later model selected on another client supersedes an old pending desktop choice. */
export function resolveDesktopAssistantModel(
  update: DesktopAssistantModelUpdate,
  current: ModelSelection,
): ModelSelection {
  return Equal.equals(update.baseModelSelection, current) ||
    Equal.equals(update.modelSelection, current)
    ? update.modelSelection
    : current;
}
