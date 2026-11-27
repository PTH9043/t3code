import type { ReactElement, ReactNode } from "react";
import { ApprovalRequestId } from "@t3tools/contracts";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import {
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    memo: (component: unknown) => component,
    useState: reactHookHarness.useState,
    useEffect: () => {},
    useEffectEvent: (callback: unknown) => callback,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

describe("question choice confirmation", () => {
  beforeEach(() => {
    hooks.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("renders a free-text answer inside the question card without inventing options", () => {
    const onChangeCustomAnswer = vi.fn();
    hooks.beginRender();
    const element = ComposerPendingUserInputPanel({
      pendingUserInputs: [
        {
          requestId: ApprovalRequestId.make("async:free-text"),
          createdAt: "2026-09-30T00:00:00Z",
          questions: [
            {
              id: "year",
              header: "Question",
              question: "어느 연도가 맞나요?",
              options: [],
              multiSelect: false,
            },
          ],
        },
      ],
      respondingRequestIds: [],
      answers: {},
      questionIndex: 0,
      onToggleOption: () => {},
      onChangeCustomAnswer,
    }) as ReactElement<Record<string, unknown>>;
    const Card = element.type as (props: Record<string, unknown>) => ReactNode;
    const tree = Card(element.props);
    const textarea = visitElements(tree, (entry) => entry.type === "textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.props["aria-label"]).toBe("질문 답변");
    (textarea!.props.onChange as (event: unknown) => void)({ target: { value: "2023년" } });
    expect(onChangeCustomAnswer).toHaveBeenCalledWith("year", "2023년");
    expect(visitElements(tree, (entry) => entry.type === "button")).toBeNull();
  });
  it.each([false, true])(
    "keeps second-question selections editable until explicit submission (multiSelect=%s)",
    (multiSelect) => {
      const questions = [
        {
          id: "first",
          header: "First",
          question: "First?",
          multiSelect: false,
          options: [{ label: "A", description: "A" }],
        },
        {
          id: "second",
          header: "Second",
          question: "Second?",
          multiSelect,
          options: [
            { label: "B", description: "B" },
            { label: "C", description: "C" },
          ],
        },
      ];
      let answers: Record<string, PendingUserInputDraftAnswer> = {};
      let questionIndex = 0;
      const render = () => {
        hooks.beginRender();
        const element = ComposerPendingUserInputPanel({
          pendingUserInputs: [
            {
              requestId: ApprovalRequestId.make("prompt"),
              createdAt: "2026-09-30T00:00:00Z",
              questions,
            },
          ],
          respondingRequestIds: [],
          answers,
          questionIndex,
          onToggleOption: (questionId, label) => {
            const question = questions.find((entry) => entry.id === questionId)!;
            answers = {
              ...answers,
              [questionId]: togglePendingUserInputOptionSelection(
                question,
                answers[questionId],
                label,
              ),
            };
          },
          onChangeCustomAnswer: () => {},
        }) as ReactElement<Record<string, unknown>>;
        const Card = element.type as (props: Record<string, unknown>) => ReactNode;
        return Card(element.props);
      };
      const click = (tree: ReactNode, index: number) => {
        let seen = 0;
        const button = visitElements(
          tree,
          (element) => element.type === "button" && seen++ === index,
        );
        expect(button).not.toBeNull();
        (button!.props.onClick as () => void)();
        expect(vi.getTimerCount()).toBe(0);
        vi.runAllTimers();
      };
      click(render(), 0);
      expect(questionIndex).toBe(0);
      questionIndex = 1; // User clicks Next.
      click(render(), 0);
      click(render(), 1);
      expect(questionIndex).toBe(1);
      expect(answers.second?.selectedOptionLabels).toEqual(multiSelect ? ["B", "C"] : ["C"]);
      click(render(), 0); // Multi-select can be deselected before submission.
      expect(answers.second?.selectedOptionLabels).toEqual(multiSelect ? ["C"] : ["B"]);
      expect(questionIndex).toBe(1);
    },
  );
});
