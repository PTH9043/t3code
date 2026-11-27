import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { ReactElement } from "react";
import { EventId, TurnId } from "@t3tools/contracts";
import { groupToolActivities } from "@t3tools/shared/toolActivity";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { visitElements } from "~/test/reactElementTree";
import { ToolActivityRow } from "./ToolActivityRow";
import {
  ActivitySummaryContext,
  ActivityDiffContext,
  ActivityRecordContext,
} from "./ActivitySummaryProvider";

const rig = vi.hoisted(() => ({
  contexts: new Map<unknown, unknown>(),
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  const { reactHookHarness: h } = await import("~/test/reactHookHarness");
  return {
    ...real,
    useContext: (ctx: unknown) => rig.contexts.get(ctx) ?? null,
    useState: h.useState,
    useEffect: (f: () => void) => rig.effects.push(f),
    useEffectEvent: (f: unknown) => f,
  };
});
vi.mock("react/compiler-runtime", async () => ({
  c: (await import("~/test/reactHookHarness")).reactHookHarness.useMemoCache,
}));
const id = EventId.make("stored"),
  turn = TurnId.make("turn");
const event = {
  id,
  turnId: turn,
  createdAt: "2026-01-01T00:00:00Z",
  kind: "tool.completed",
  tone: "tool" as const,
  summary: "Command run",
  payload: {
    reportedModel: "worker",
    itemType: "command_execution",
    data: { item: { command: "git log --oneline" } },
  },
};
const [group] = groupToolActivities([event]);
beforeEach(() => {
  hooks.reset();
  rig.effects = [];
  rig.contexts.clear();
});
function find(root: unknown, name: string) {
  return visitElements(root, (el) => el.props.children === name);
}
function toggle(el: ReactElement<Record<string, unknown>>, open: boolean) {
  (el.props.onToggle as (event: unknown) => void)({ currentTarget: { open } });
}
function row() {
  hooks.beginRender();
  return ToolActivityRow({ group: group! });
}
it("shows failure evidence once and leaves recovery unconfirmed without requesting a second explanation", () => {
  const request = vi.fn();
  rig.contexts.set(ActivitySummaryContext, request);
  const [failed] = groupToolActivities([
    { ...event, payload: { itemType: "command_execution", exitCode: 2, status: "failed" } },
  ]);
  const show = () => {
    hooks.beginRender();
    return ToolActivityRow({ group: failed! });
  };
  const closed = show();
  expect(find(closed, failed!.summary)).toBeTruthy();
  toggle(closed as ReactElement<Record<string, unknown>>, true);
  const detail = visitElements(show(), (el) => typeof el.type === "function")!;
  hooks.reset();
  hooks.beginRender();
  const content = (detail.type as (props: { group: typeof failed }) => ReactElement)({
    group: failed,
  });
  expect(find(content, failed!.summary)).toBeNull();
  expect(find(content, "이 명령의 복구 여부 미확인")).toBeTruthy();
  expect(find(content, "로컬 설명 작성 중")).toBeNull();
  rig.effects.forEach((effect) => effect());
  expect(request).not.toHaveBeenCalled();
});
it("opens immediately with factual evidence, distinguishes turn diff, and rejects a late summary from superseded evidence", async () => {
  let finish!: (value: { summary: string; model: string }) => void;
  const pending = new Promise<{ summary: string; model: string }>((resolve) => {
    finish = resolve;
  });
  const run = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValue({ summary: "오류를 확인했습니다.", model: "qwen2.5-coder:14b" });
  const diff = vi.fn();
  rig.contexts.set(ActivitySummaryContext, run);
  rig.contexts.set(ActivityDiffContext, {
    ready: new Map([[turn, { turnId: turn, files: [{ path: "unrelated.ts" }] }]]),
    open: diff,
  });
  rig.contexts.set(ActivityRecordContext, new Map([[id, event]]));
  const closed = row();
  expect(run).not.toHaveBeenCalled();
  toggle(closed as ReactElement<Record<string, unknown>>, true);
  const detail = visitElements(row(), (el) => typeof el.type === "function")!;
  const render = (g = group!) => {
    hooks.beginRender();
    return (detail.type as (props: { group: typeof g }) => ReactElement)({ group: g });
  };
  hooks.reset();
  let content = render();
  expect(find(content, group!.summary)).toBeTruthy();
  expect(find(content, "로컬 설명 작성 중")).toBeTruthy();
  const diffLink = visitElements(content, (el) => el.type === "button")!;
  (diffLink.props.onClick as () => void)();
  expect(diff).toHaveBeenCalledExactlyOnceWith(turn);
  expect(find(content, "unrelated.ts")).toBeNull();
  expect(visitElements(content, (el) => el.type === "pre")).toBeNull();
  const stop = rig.effects.pop()!();
  expect(run).toHaveBeenCalledTimes(1);
  const changed = { ...group!, phase: "failed" as const, summary: "이력 확인 실패" };
  if (typeof stop === "function") stop();
  render(changed);
  rig.effects.pop()!();
  await Promise.resolve();
  finish({ summary: "지난 결과", model: "granite4.1:8b" });
  await Promise.resolve();
  content = render(changed);
  expect(find(content, "오류를 확인했습니다.")).toBeTruthy();
  expect(find(content, "지난 결과")).toBeNull();
  expect(find(content, "로컬 설명 작성 중")).toBeNull();
  const records = visitElements(content, (el) => el.type === "details")!;
  toggle(records, true);
  expect(visitElements(render(changed), (el) => el.type === "pre")?.props.children).toContain(
    "git log --oneline",
  );
});
