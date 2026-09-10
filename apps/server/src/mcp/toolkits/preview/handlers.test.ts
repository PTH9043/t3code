import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { normalizePreviewOpenInput, PreviewToolkitHandlersLive } from "./handlers.ts";
import { PreviewToolkit } from "./tools.ts";

describe("normalizePreviewOpenInput", () => {
  it("opens the inline preview and reuses the current tab by default", () => {
    expect(normalizePreviewOpenInput({})).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-preview-handlers"),
  threadId: ThreadId.make("thread-preview-handlers"),
  providerSessionId: "provider-session-preview-handlers",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};

const recordingToolkitLayer = (recorded: PreviewAutomationBroker.PreviewAutomationInvokeInput[]) =>
  PreviewToolkitHandlersLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
        Layer.succeed(
          PreviewAutomationBroker.PreviewAutomationBroker,
          PreviewAutomationBroker.PreviewAutomationBroker.of({
            connect: () => Effect.die("unused"),
            focusHost: () => Effect.die("unused"),
            respond: () => Effect.die("unused"),
            invoke: <A>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) =>
              Effect.sync(() => {
                recorded.push(request);
                return undefined as A;
              }),
          }),
        ),
      ),
    ),
  );

it.effect("leaves the desktop deadline room to fail with its own typed error", () => {
  const recorded: PreviewAutomationBroker.PreviewAutomationInvokeInput[] = [];

  return Effect.gen(function* () {
    const toolkit = yield* PreviewToolkit;
    yield* Stream.runDrain(
      yield* toolkit.handle("preview_click", { locator: "role=button", timeoutMs: 2_000 }),
    );
    yield* Stream.runDrain(yield* toolkit.handle("preview_press", { key: "Enter" }));

    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.timeoutMs).toBe(7_000);
    expect(recorded[0]?.input).toMatchObject({ timeoutMs: 2_000 });
    expect(recorded[1]?.timeoutMs).toBeUndefined();
  }).pipe(Effect.provide(recordingToolkitLayer(recorded)));
});
