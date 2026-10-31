import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { MeetingModePanel } from "./MeetingModePanel";
import { meetingModelDefaultOptions } from "../../meetingModelOptions";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

vi.mock("../../meetingComposerStore", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../meetingComposerStore")>();
  return {
    ...original,
    useMeetingComposerConfig: () => ({
      ...original.DEFAULT_MEETING_COMPOSER_CONFIG,
      chairSeatId: "claude-b",
      seats: ["codex", "claudeAgent"].flatMap((instanceId) =>
        ["a", "b"].map((model) => ({
          id: `${instanceId === "codex" ? "codex" : "claude"}-${model}`,
          instanceId: ProviderInstanceId.make(instanceId),
          model,
          displayName: instanceId,
        })),
      ),
    }),
  };
});

it("renders multiple models per account and identifies exactly one selected conductor", () => {
  const entries: ProviderInstanceEntry[] = ["codex", "claudeAgent"].map((instanceId) => {
    const snapshot = decodeProvider({
      instanceId,
      driver: instanceId,
      enabled: true,
      installed: true,
      version: "test",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-13T00:00:00.000Z",
      models: ["a", "b", "c"].map((slug) => ({
        slug,
        name: `Model ${slug}`,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: instanceId === "codex" ? "reasoningEffort" : "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
              ],
              currentValue: slug === "a" ? "low" : "medium",
            },
          ],
        },
      })),
    });
    return {
      instanceId: snapshot.instanceId,
      driverKind: ProviderDriverKind.make(instanceId),
      displayName: instanceId,
      enabled: true,
      installed: true,
      status: "ready",
      isDefault: true,
      isAvailable: true,
      snapshot,
      models: snapshot.models,
    };
  });
  const markup = renderToStaticMarkup(
    <MeetingModePanel
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
    />,
  );
  expect(markup.match(/data-meeting-seat=/g)).toHaveLength(4);
  expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
  expect(markup).toContain('value="claude-b" selected=""');
  expect(markup).toContain('aria-label="codex Model a 모델"');
  expect(markup).toContain('aria-label="codex Model b 모델"');
  expect(markup).toContain('aria-label="claudeAgent Model a 제거"');
  expect(markup).toContain('aria-label="claudeAgent 모델 추가"');
  expect(markup).toContain("선택하지 않은 AI 추가 허용");
  expect(meetingModelDefaultOptions(entries[0]!, "a")).toEqual([
    { id: "reasoningEffort", value: "low" },
  ]);
  expect(meetingModelDefaultOptions(entries[0]!, "b")).toEqual([
    { id: "reasoningEffort", value: "medium" },
  ]);
  expect(meetingModelDefaultOptions(entries[1]!, "a")).toEqual([{ id: "effort", value: "low" }]);
});
