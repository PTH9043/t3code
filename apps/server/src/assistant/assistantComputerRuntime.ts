import * as Effect from "effect/Effect";
import type { ServerSettingsService } from "../serverSettings.ts";
import { makeAssistantComputerController } from "./assistantComputerController.ts";
import { makeIsolatedComputer } from "./isolatedComputer.ts";

// Both the chat tool and the UI must share the same lifecycle lock.
const controllers = new WeakMap<object, ReturnType<typeof makeAssistantComputerController>>();

export function assistantComputerRuntime(settings: ServerSettingsService["Service"]) {
  const existing = controllers.get(settings);
  if (existing) return existing;
  const controller = makeAssistantComputerController({
    computer: makeIsolatedComputer(),
    read: async (threadId) =>
      (await Effect.runPromise(settings.getSettings)).threadAssistantComputers[threadId] ?? null,
    write: async (threadId, value) => {
      await Effect.runPromise(
        settings.updateSettings({ threadAssistantComputers: { [threadId]: value } }),
      );
    },
  });
  controllers.set(settings, controller);
  return controller;
}

export function assistantComputerErrorMessage(cause: unknown): string {
  return cause instanceof Error && !cause.message.startsWith("Command failed:")
    ? cause.message
    : "비서 컴퓨터 요청에 실패했습니다. 컴퓨터 상태와 명령을 확인하세요.";
}
