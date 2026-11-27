import {
  ClientOrchestrationCommand,
  EnvironmentId,
  ProjectId,
  WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeDashboard,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { visitElements } from "~/test/reactElementTree";
import { KnowledgeDashboard } from "./KnowledgeDashboard";
import { KnowledgeBulkActions } from "./KnowledgeBulkActions";
import { KnowledgeSearch } from "./KnowledgeSearch";
import { KnowledgeRows } from "./KnowledgeRows";
import { KnowledgeMetrics } from "./KnowledgeMetrics";
import { type DashboardRow, toggleRows } from "./dashboardSelection";

const isClientCommand = Schema.is(ClientOrchestrationCommand);
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  read: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness: h } = await import("~/test/reactHookHarness");
  return { ...actual, useState: h.useState, useRef: h.useRef };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness: h } = await import("~/test/reactHookHarness");
  return { c: h.useMemoCache };
});
vi.mock("./dashboardData", () => ({ dashboardQuery: mocks.query, dashboardCommand: "dispatch" }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: mocks.read }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.send }));
const projectId = ProjectId.make("project-A"),
  environmentId = EnvironmentId.make("env-B");
const updatedAt = "2026-11-05T01:02:03.000Z";
const a: DashboardRow = {
  id: WorkspaceKnowledgeItemId.make("a"),
  revisionSequence: 71,
  title: "같은 제목",
  kind: "run-memory",
  status: "candidate",
  updatedAt,
  createdAt: updatedAt,
  promptUses: 0,
  lastUsedAt: null,
  contentHash: "sha",
  supersededBy: null,
};
const b: DashboardRow = {
  ...a,
  id: WorkspaceKnowledgeItemId.make("b"),
  promptUses: 12,
  lastUsedAt: updatedAt,
};
const snapshot: WorkspaceKnowledgeDashboard = {
  projectId,
  measuredAt: updatedAt,
  total: 103,
  byKind: [{ kind: "run-memory", count: 103 }],
  byStatus: [{ status: "candidate", count: 103 }],
  growth: [{ day: "2026-11-05", count: 23 }],
  compaction: { measuredItems: 2, originalChars: 2000, storedChars: 560, reductionRatio: 0.72 },
  matching: { total: 103, items: [a, b] },
  candidates: { total: 103, items: [a, b] },
  mostUsed: { total: 15, items: [b] },
  unused: { total: 88, items: [a] },
  duplicates: { total: 1, items: [{ contentHash: "sha", count: 2 }] },
  savedSearches: [{ id: "saved", name: "팀 후보", filters: { usage: "unused" }, updatedAt }],
};
function show() {
  hooks.beginRender();
  return KnowledgeDashboard({ projectId, environmentId, projectTitle: "프로젝트" });
}
function component<P extends object>(tree: unknown, type: FunctionComponent<P>): P {
  const hit = visitElements(tree, (e) => e.type === type);
  expect(hit).toBeTruthy();
  return hit!.props as P;
}
function button(tree: unknown, label: string) {
  const hit = visitElements(
    tree,
    (e) =>
      !!e.props.onClick &&
      (e.props.children === label ||
        (Array.isArray(e.props.children) && e.props.children[0] === label)),
  );
  expect(hit).toBeTruthy();
  return hit!.props as { onClick: () => unknown; disabled?: boolean };
}
function read(data: WorkspaceKnowledgeDashboard | null) {
  mocks.read.mockReturnValue({ data, error: null, isPending: false, refresh: mocks.refresh });
}
beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  read(snapshot);
  mocks.send.mockReset();
  mocks.send.mockResolvedValue({ _tag: "Success", value: { sequence: 11 } });
});
describe("knowledge dashboard", () => {
  it.each([
    { type: "promote" },
    { type: "archive" },
    { type: "reclassify", kind: "goal" },
  ] as const)(
    "dispatches a checked $type command once for an explicit selection",
    async (operation) => {
      component(show(), KnowledgeRows).onToggle([a, b], true);
      const actions = component(show(), KnowledgeBulkActions);
      const promise = actions.apply(operation);
      expect(await actions.apply(operation)).toBe(false);
      expect(await promise).toBe(true);
      expect(mocks.send).toHaveBeenCalledTimes(1);
      const command = mocks.send.mock.lastCall![0].input;
      expect(isClientCommand(command)).toBe(true);
      expect(command).toMatchObject({
        projectId,
        operation,
        items: [
          { id: a.id, updatedAt, revisionSequence: a.revisionSequence },
          { id: b.id, updatedAt, revisionSequence: b.revisionSequence },
        ],
      });
    },
  );
  it("keeps search editing available while a fresh query loads and never shows invented totals", () => {
    read(null);
    const tree = show();
    expect(component(tree, KnowledgeSearch).busy).toBe(true);
    expect(visitElements(tree, (e) => e.type === KnowledgeMetrics)).toBeNull();
    expect(component(tree, KnowledgeBulkActions).canApply).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("displays the server totals, UTC growth and weighted ratio even on a short result page", () => {
    const html = renderToStaticMarkup(<KnowledgeMetrics data={snapshot} />);
    for (const value of ["103", "88", "72%", "2,000", "560", "2026-11-05", "23"])
      expect(html).toContain(value);
    const none = renderToStaticMarkup(
      <KnowledgeMetrics
        data={{
          ...snapshot,
          compaction: { originalChars: 0, storedChars: 0, measuredItems: 0, reductionRatio: null },
        }}
      />,
    );
    expect(none).toContain("측정값 없음");
    expect(none).not.toContain("0%");
  });
  it("drills into an exact hash, scopes queries and paginates the selected list", () => {
    button(show(), "중복 묶음").onClick();
    button(show(), "문서 보기").onClick();
    expect(component(show(), KnowledgeSearch).filters).toEqual({ contentHash: "sha" });
    button(show(), "다음").onClick();
    show();
    expect(mocks.query).toHaveBeenLastCalledWith({
      environmentId,
      input: { projectId, limit: 25, offset: 25, contentHash: "sha" },
    });
    button(show(), "미사용").onClick();
    expect(component(show(), KnowledgeRows).rows).toEqual([a]);
    expect(mocks.query.mock.lastCall![0].input).toEqual({
      projectId,
      limit: 25,
      offset: 0,
      contentHash: "sha",
    });
    button(show(), "많이 사용한 문서").onClick();
    expect(component(show(), KnowledgeRows).rows).toEqual([b]);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("preserves selected revisions and reuses an uncertain command on retry; clears only after acknowledgement", async () => {
    component(show(), KnowledgeRows).onToggle([a, b], true);
    component(show(), KnowledgeRows).onToggle(
      [{ ...a, revisionSequence: a.revisionSequence + 1 }],
      true,
    );
    mocks.send.mockRejectedValueOnce(new Error("연결 끊김"));
    expect(
      await component(show(), KnowledgeBulkActions).apply({ type: "merge", targetId: b.id }),
    ).toBe(false);
    const failed = mocks.send.mock.calls[0]![0];
    expect(failed).toMatchObject({
      environmentId,
      input: {
        type: "project.knowledge.bulk",
        projectId,
        operation: { type: "merge", targetId: b.id },
        items: [
          { id: a.id, updatedAt, revisionSequence: a.revisionSequence },
          { id: b.id, updatedAt, revisionSequence: b.revisionSequence },
        ],
      },
    });
    expect(component(show(), KnowledgeBulkActions).selected.size).toBe(2);
    expect(
      await component(show(), KnowledgeBulkActions).apply({ type: "merge", targetId: b.id }),
    ).toBe(true);
    expect(mocks.send.mock.lastCall![0]).toEqual(failed);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(component(show(), KnowledgeBulkActions).selected.size).toBe(0);
  });
  it("requires an explicit representative, including when both selected titles match", async () => {
    const apply = vi.fn().mockResolvedValue(true);
    const open = () => {
      hooks.beginRender();
      return KnowledgeBulkActions({
        selected: toggleRows(new Map(), [a, b], true),
        busy: false,
        canApply: true,
        error: null,
        apply,
        clear: vi.fn(),
      });
    };
    button(open(), "병합").onClick();
    expect(button(open(), "병합 적용").disabled).toBe(true);
    const radio = visitElements(open(), (e) => e.props.type === "radio" && e.props.value === b.id)!;
    (radio.props.onChange as () => void)();
    await button(open(), "병합 적용").onClick();
    expect(apply).toHaveBeenCalledWith({ type: "merge", targetId: b.id });
  });
  it("creates, updates and removes project-shared searches using the server revision", async () => {
    const search = () => component(show(), KnowledgeSearch);
    const saved = snapshot.savedSearches[0]!;
    expect(search().saved).toEqual([saved]);
    const filters = { kind: "goal", usage: "unused" } as const;
    await search().onSave("신규", filters, null);
    expect(mocks.send.mock.lastCall![0]).toMatchObject({
      environmentId,
      input: {
        projectId,
        type: "project.knowledge.search.save",
        id: expect.any(String),
        name: "신규",
        filters,
        expectedUpdatedAt: null,
      },
    });
    await search().onSave("변경", filters, saved);
    expect(mocks.send.mock.lastCall![0].input).toMatchObject({
      id: saved.id,
      expectedUpdatedAt: saved.updatedAt,
    });
    await search().onRemove(saved);
    expect(mocks.send.mock.lastCall![0].input).toMatchObject({
      projectId,
      type: "project.knowledge.search.remove",
      id: saved.id,
      expectedUpdatedAt: saved.updatedAt,
    });
    read({ ...snapshot, projectId: ProjectId.make("foreign") });
    expect(await search().onSave("scope", filters, null)).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });
  it("loads saved filters from another device and requires confirmation to delete the saved search", async () => {
    const first = snapshot.savedSearches[0]!;
    const apply = vi.fn(),
      onSave = vi.fn(),
      onRemove = vi.fn().mockResolvedValue(true);
    const panel = () => {
      hooks.beginRender();
      return KnowledgeSearch({ filters: {}, saved: [first], apply, onSave, onRemove, busy: false });
    };
    const picker = visitElements(
      panel(),
      (e) =>
        e.type === "select" &&
        !!visitElements(
          e.props.children,
          (child) => child.type === "option" && child.props.value === first.id,
        ),
    );
    (picker!.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: first.id },
    });
    expect(apply).toHaveBeenLastCalledWith(first.filters);
    button(panel(), "삭제").onClick();
    expect(onRemove).not.toHaveBeenCalled();
    await button(panel(), "삭제 확인").onClick();
    expect(onRemove).toHaveBeenCalledWith(first);
    expect(onSave).not.toHaveBeenCalled();
    expect(apply).toHaveBeenLastCalledWith({});
  });
});
