import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { TooltipProvider } from "../ui/tooltip";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { ProviderModelPicker } from "./ProviderModelPicker";
import {
  isMuseCloudEntry,
  modelPickerProviderGroupKey,
  modelPickerProviderGroupLabel,
} from "./modelPickerProviderGroups";

function makeSnapshot(
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "instanceId" | "driver">,
): ServerProvider {
  return {
    displayName: "Muse Code",
    badgeLabel: "Meta",
    showInteractionModeToggle: false,
    requiresNewThreadForModelChange: false,
    enabled: true,
    installed: true,
    version: "1.4.25",
    status: "ready",
    auth: { status: "authenticated", type: "oauth" },
    checkedAt: "2026-11-26T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("Muse Code vs Muse Cloud separation", () => {
  it("renders separate Muse Code and Muse Cloud buttons in sidebar and Cloud badge in picker", () => {
    const entries = deriveProviderInstanceEntries([
      makeSnapshot({
        instanceId: ProviderInstanceId.make("muse"),
        driver: ProviderDriverKind.make("muse"),
        displayName: "Muse Code",
        badgeLabel: "Meta",
        continuation: { groupKey: "muse:home:C:\\Users\\test\\.config\\muse" },
      }),
      makeSnapshot({
        instanceId: ProviderInstanceId.make("muse_cloud_136858bd"),
        driver: ProviderDriverKind.make("muse"),
        displayName: "Muse Cloud",
        badgeLabel: "Cloud · Google",
        version: "0.3.15",
        continuation: { groupKey: "muse:cloud:C:\\Users\\test\\.config\\muse-cli" },
      }),
    ]);

    const [codeEntry, cloudEntry] = entries;
    expect(isMuseCloudEntry(codeEntry!)).toBe(false);
    expect(isMuseCloudEntry(cloudEntry!)).toBe(true);
    expect(modelPickerProviderGroupKey(codeEntry!)).toBe("muse");
    expect(modelPickerProviderGroupKey(cloudEntry!)).toBe("muse-cloud:muse_cloud_136858bd");
    expect(modelPickerProviderGroupLabel(codeEntry!)).toBe("Muse Code");
    expect(modelPickerProviderGroupLabel(cloudEntry!)).toBe("Muse Cloud");

    const sidebarMarkup = renderToStaticMarkup(
      <TooltipProvider delay={0}>
        <ModelPickerSidebar
          selectedInstanceId={codeEntry!.instanceId}
          onSelectInstance={() => {}}
          instanceEntries={entries}
        />
      </TooltipProvider>,
    );
    expect(sidebarMarkup).toContain('data-model-picker-provider="muse"');
    expect(sidebarMarkup).toContain('data-model-picker-provider="muse-cloud:muse_cloud_136858bd"');
    expect(sidebarMarkup).toContain('aria-label="Muse Code"');
    expect(sidebarMarkup).toContain('aria-label="Muse Cloud"');
    expect(sidebarMarkup).toContain('data-model-picker-cloud-badge="true"');

    const cloudTriggerMarkup = renderToStaticMarkup(
      <TooltipProvider delay={0}>
        <ProviderModelPicker
          activeInstanceId={cloudEntry!.instanceId}
          model="muse-cloud-chat"
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={
            new Map([
              [cloudEntry!.instanceId, [{ slug: "muse-cloud-chat", name: "Muse Cloud · 새 대화" }]],
            ])
          }
          onInstanceModelChange={() => {}}
        />
      </TooltipProvider>,
    );
    expect(cloudTriggerMarkup).toContain('data-chat-muse-cloud="true"');
  });

  it("sanitizes corrupted replacement-character displayName on Muse Cloud entries", () => {
    const [corruptedCloud] = deriveProviderInstanceEntries([
      makeSnapshot({
        instanceId: ProviderInstanceId.make("muse_cloud_deadbeef"),
        driver: ProviderDriverKind.make("muse"),
        displayName: "muse.ai \uFFFD\uFFFD\uFFFD\uFFFD",
        badgeLabel: "Cloud · Google",
        continuation: { groupKey: "muse:cloud:C:\\Users\\test\\.config\\muse-cli" },
      }),
    ]);

    expect(corruptedCloud?.displayName).toBe("Muse Cloud");
    expect(modelPickerProviderGroupLabel(corruptedCloud!)).toBe("Muse Cloud");
  });
});
