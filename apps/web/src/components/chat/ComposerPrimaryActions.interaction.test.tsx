import { expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  memo: (component: unknown) => component,
}));
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

it("calls the stop handler from the active question's button", () => {
  const onInterrupt = vi.fn();
  const tree = ComposerPrimaryActions({
    compact: true,
    pendingAction: {
      questionIndex: 0,
      isLastQuestion: true,
      canAdvance: false,
      isResponding: false,
      isComplete: false,
      isCancelable: true,
    },
    isRunning: false,
    showPlanFollowUpPrompt: false,
    promptHasText: false,
    isSendBusy: false,
    sendDisabledReason: null,
    isConnecting: false,
    isEnvironmentUnavailable: false,
    isPreparingWorktree: false,
    hasSendableContent: false,
    onPreviousPendingQuestion: () => {},
    onInterrupt,
    onImplementPlanInNewThread: () => {},
  });
  const stop = visitElements(tree, (element) => element.props["aria-label"] === "질문 중지");
  expect(stop?.props.type).toBe("button");
  (stop!.props.onClick as () => void)();
  expect(onInterrupt).toHaveBeenCalledOnce();
});
