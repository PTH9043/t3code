import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/entities", () => ({
  useServerConfigs: () => new Map([["fixture", { providers: [] }]]),
}));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("~/providerInstances", () => ({
  deriveProviderInstanceEntries: () => [
    {
      instanceId: ProviderInstanceId.make("codex"),
      displayName: "Codex",
      enabled: true,
      isAvailable: true,
    },
    {
      instanceId: ProviderInstanceId.make("offline"),
      displayName: "Offline",
      enabled: true,
      isAvailable: false,
    },
  ],
}));
vi.mock("~/modelSelection", () => ({
  getAppModelOptionsForInstance: () => [{ slug: "model-a", name: "Model A" }],
}));

import { WorkflowModelSelector } from "./WorkflowModelSelector";

const selection = { instanceId: ProviderInstanceId.make("codex"), model: "model-a" };
const common = {
  environmentId: EnvironmentId.make("fixture"),
  onModeChange: () => {},
  onSingleChange: () => {},
  onRoleChange: () => {},
  single: selection,
  roles: { coordinator: selection, implementer: selection, researcher: selection },
  current: selection,
  meetingEnabled: false,
};

describe("workflow model controls", () => {
  it("shows the currently selected chat model without requiring another provider", () => {
    const html = renderToStaticMarkup(<WorkflowModelSelector {...common} mode="current" />);
    expect(html).toContain("현재 채팅에서 선택한 모델");
    expect(html).toContain("codex · model-a");
  });
  it("offers one model for every role in single-model mode", () => {
    const html = renderToStaticMarkup(<WorkflowModelSelector {...common} mode="single" />);
    expect(html).toContain("전체 역할 모델");
    expect(html).toContain("Codex · Model A");
    expect(html).not.toContain("Offline");
    expect(html).not.toContain("총괄 모델");
  });
  it("shows a separate model picker for each role", () => {
    const html = renderToStaticMarkup(<WorkflowModelSelector {...common} mode="roles" />);
    for (const label of ["총괄 모델", "구현 모델", "조사 모델"]) expect(html).toContain(label);
    expect(html).toContain("이번 실행에만 적용");
  });
});
