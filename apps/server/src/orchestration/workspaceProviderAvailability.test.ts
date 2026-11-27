import { ProviderInstanceId } from "@t3tools/contracts";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  workspaceProviderUnavailableMessage,
  isWorkspaceProviderUnavailable,
} from "./workspaceProviderAvailability.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("research-connection"),
  model: "deepseek",
};

it.effect("reports missing and disabled connections without choosing another account", () =>
  Effect.gen(function* () {
    let state: "missing" | "disabled" | "ready" = "missing";
    const requested: string[] = [];
    const registry = {
      getInstance: (id: ProviderInstanceId) =>
        Effect.sync(() => {
          requested.push(id);
          return state === "missing" ? undefined : ({ enabled: state === "ready" } as never);
        }),
      listUnavailable: Effect.succeed([]),
    } as unknown as ProviderInstanceRegistryShape;
    const check = () =>
      workspaceProviderUnavailableMessage({ registry, modelSelection, role: "researcher" });
    const missing = yield* check();
    expect(missing).toContain("등록되어 있지 않습니다");
    expect(isWorkspaceProviderUnavailable(missing!)).toBe(true);
    state = "disabled";
    expect(yield* check()).toContain("비활성화");
    state = "ready";
    expect(yield* check()).toBeNull();
    expect(requested).toEqual([
      "research-connection",
      "research-connection",
      "research-connection",
    ]);
  }),
);

it("recognizes the historical role-specific unavailable error without assuming its cause", () => {
  expect(
    isWorkspaceProviderUnavailable(
      "Provider instance research-connection assigned to role 'researcher' is unavailable",
    ),
  ).toBe(true);
  expect(isWorkspaceProviderUnavailable("Provider instance research-connection timeout")).toBe(
    false,
  );
});
