import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement, ReactNode } from "react";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { createTaskConditionsDraft } from "../../taskConditions";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
import { TaskConditionsDialog } from "./TaskConditionsDialog";

function find(
  tree: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
) {
  const found = visitElements(tree, predicate);
  expect(found).not.toBeNull();
  return found!;
}

describe("task conditions confirmation", () => {
  beforeEach(() => hooks.reset());

  it("does not offer inspection mode for managed execution paths", () => {
    hooks.beginRender();
    const tree = TaskConditionsDialog({
      draft: createTaskConditionsDraft("협업 실행", "D:/test"),
      workOnlyReason: "협업 실행 경로입니다.",
      onChange: vi.fn(),
      onApprove: vi.fn(),
      onCancel: vi.fn(),
    });
    expect(
      find(tree, (e) => e.type === "input" && e.props.value === "inspect").props.disabled,
    ).toBe(true);
    expect(find(tree, (e) => e.type === "input" && e.props.value === "work").props.disabled).toBe(
      false,
    );
  });

  it("waits for explicit submission and invalidates review after edits", () => {
    let draft = createTaskConditionsDraft("조회해 줘", "D:/test");
    const onApprove = vi.fn();
    const onCancel = vi.fn();
    const render = () => {
      hooks.beginRender();
      return TaskConditionsDialog({
        draft,
        onChange: (next) => {
          draft = next;
        },
        onApprove,
        onCancel,
      });
    };
    const submit = (tree: ReactNode) => find(tree, (e) => e.props.children === "이 조건으로 실행");
    const review = (tree: ReactNode) =>
      find(tree, (e) => e.type === "input" && e.props.type === "checkbox");
    let tree = render();
    expect(submit(tree).props.disabled).toBe(true);
    expect(onApprove).not.toHaveBeenCalled();
    const mode = find(tree, (e) => e.type === "input" && e.props.value === "inspect");
    (mode.props.onChange as () => void)();
    tree = render();
    (review(tree).props.onChange as (e: unknown) => void)({ target: { checked: true } });
    tree = render();
    expect(submit(tree).props.disabled).toBe(false);
    expect(onApprove).not.toHaveBeenCalled();
    const field = find(tree, (e) => e.type === "textarea" && e.props["aria-label"] === "판단 기준");
    (field.props.onChange as (e: unknown) => void)({ target: { value: "새 기준" } });
    tree = render();
    expect(review(tree).props.checked).toBe(false);
    expect(submit(tree).props.disabled).toBe(true);
    (review(tree).props.onChange as (e: unknown) => void)({ target: { checked: true } });
    tree = render();
    (submit(tree).props.onClick as () => void)();
    expect(onApprove).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ criteria: "새 기준", mode: "inspect" }),
    );
    (
      find(tree, (e) => e.props.children === "취소 · 요청으로 돌아가기").props.onClick as () => void
    )();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledOnce();
  });
});
