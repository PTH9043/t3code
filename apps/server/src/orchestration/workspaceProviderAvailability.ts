import type { ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";

const UNAVAILABLE_PREFIX = "선택한 AI 연결을 사용할 수 없습니다.";

export const isWorkspaceProviderUnavailable = (message: string): boolean =>
  message.startsWith(UNAVAILABLE_PREFIX) ||
  /^Provider instance .+ assigned to role .+ is unavailable\.?$/iu.test(message.trim());

/** Check the exact chosen connection without switching accounts or models. */
export const workspaceProviderUnavailableMessage = Effect.fn("workspaceProviderUnavailableMessage")(
  function* (input: {
    readonly registry: Pick<ProviderInstanceRegistryShape, "getInstance" | "listUnavailable">;
    readonly modelSelection: ModelSelection;
    readonly role: string;
  }) {
    const { registry, modelSelection, role } = input;
    const instance = yield* registry.getInstance(modelSelection.instanceId);
    if (instance?.enabled) return null;
    const shadows = instance === undefined ? yield* registry.listUnavailable : [];
    const shadow = shadows.find((entry) => entry.instanceId === modelSelection.instanceId);
    const reason = instance
      ? "연결이 비활성화되어 있습니다."
      : shadow
        ? `연결을 불러오지 못했습니다: ${shadow.unavailableReason ?? "원인 미확인"}`
        : "해당 연결이 등록되어 있지 않습니다.";
    return `${UNAVAILABLE_PREFIX} 역할: ${role}, 연결: ${modelSelection.instanceId}, 모델: ${modelSelection.model}. ${reason} 설정에서 해당 연결을 복구하거나 작업에 사용할 연결을 다시 선택하세요.`;
  },
);
