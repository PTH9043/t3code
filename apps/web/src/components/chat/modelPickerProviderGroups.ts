import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";

export function isClaudeApiEntry(entry: ProviderInstanceEntry): boolean {
  return (
    entry.driverKind === "claudeAgent" &&
    (entry.snapshot.auth.type === "apiKey" || entry.instanceId.startsWith("claude_api_"))
  );
}

export function isMuseCloudEntry(entry: ProviderInstanceEntry): boolean {
  return (
    entry.driverKind === "muse" &&
    (entry.instanceId.startsWith("muse_cloud_") ||
      entry.continuationGroupKey?.startsWith("muse:cloud:") ||
      entry.snapshot.badgeLabel === "Cloud · Google")
  );
}

export function sanitizeMuseCloudDisplayName(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed || trimmed.includes("\uFFFD")) {
    return "Muse Cloud";
  }
  return trimmed;
}

/** Independently billed accounts stay distinct even when their configured names match. */
export function modelPickerProviderGroupKey(entry: ProviderInstanceEntry): string {
  if (entry.individualAccount) return entry.instanceId;
  if (entry.openAiAccountTag) return `openai-api:${entry.instanceId}`;
  if (isClaudeApiEntry(entry)) return `claudeAgent:${entry.instanceId}`;
  if (isMuseCloudEntry(entry)) return `muse-cloud:${entry.instanceId}`;
  if (entry.driverKind === "opencode") return `opencode:${entry.displayName}`;
  return entry.driverKind;
}

export function modelPickerProviderGroupLabel(entry: ProviderInstanceEntry): string {
  if (entry.individualAccount) {
    return isMuseCloudEntry(entry)
      ? sanitizeMuseCloudDisplayName(entry.displayName)
      : entry.displayName;
  }
  if (entry.openAiAccountTag) return `#${entry.openAiAccountTag} · ${entry.displayName}`;
  if (isClaudeApiEntry(entry) || entry.driverKind === "opencode") return entry.displayName;
  if (isMuseCloudEntry(entry)) return sanitizeMuseCloudDisplayName(entry.displayName);
  if (entry.driverKind === "muse") return "Muse Code";
  return PROVIDER_DISPLAY_NAMES[entry.driverKind] ?? entry.displayName;
}
