import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  WorkspaceKnowledgeItemId,
  WorkspaceCollaborationRunId,
  WorkspaceKnowledgeItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { parseWorkspaceWikiLinks } from "@t3tools/shared/workspaceWikiLinks";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { visitElements } from "~/test/reactElementTree";
import { KnowledgeDocumentPage } from "./KnowledgeDocumentPage";
import { PdfRevisionPanel } from "./PdfRevisionPanel";
import { KnowledgeEditor } from "./KnowledgeEditor";
import { KnowledgeReader } from "./KnowledgeReader";
import { KnowledgeHistory } from "./KnowledgeHistory";
import { RunKnowledgeDocuments } from "./RunKnowledgeDocuments";
import { KnowledgeExcerpt, StoredKnowledgeOriginal } from "./StoredKnowledgeOriginal";
import { WikiLinkPicker } from "./WikiLinkPicker";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  read: vi.fn(),
  list: vi.fn(),
  links: vi.fn(),
  head: vi.fn(),
  revision: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  const { reactHookHarness: h } = await import("~/test/reactHookHarness");
  return {
    ...real,
    useState: h.useState,
    useMemo: h.useMemo,
    useRef: h.useRef,
    useEffect: () => {},
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness: h } = await import("~/test/reactHookHarness");
  return { c: h.useMemoCache };
});
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { workspaceKnowledge: mocks.list },
}));
vi.mock("./knowledgeApi", () => ({
  wikiLinks: mocks.links,
  wikiRevisions: mocks.head,
  wikiRevision: mocks.revision,
  editWikiDocument: "edit",
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: mocks.read }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.send }));
vi.mock("../control-center/DesignReferenceFields", () => ({
  DesignReferenceFields: () => null,
  DesignReferencePreview: () => null,
}));
vi.mock("@pierre/diffs/react", () => ({ MultiFileDiff: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Navigate: () => null,
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a
      href={
        to.replace(/\$(\w+)/g, (_, key: string) => encodeURIComponent(params?.[key] ?? "")) +
        (search?.knowledgeRun ? "?knowledgeRun=" + search.knowledgeRun : "")
      }
    >
      {children}
    </a>
  ),
}));

const project = {
  id: ProjectId.make("project-a"),
  environmentId: EnvironmentId.make("env-a"),
  title: "Project",
} as EnvironmentProject;
const item: WorkspaceKnowledgeItem = {
  id: WorkspaceKnowledgeItemId.make("capture"),
  projectId: project.id,
  title: "Spec",
  content: "[[Old title|참고]]\n\nOther [[missing]]",
  kind: "rag-source",
  status: "active",
  origin: "user",
  relativeFolder: null,
  tags: ["auto-conversation"],
  promptUses: 0,
  lastUsedAt: null,
  originalChars: null,
  storedChars: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  provenance: { runId: WorkspaceCollaborationRunId.make("run-1") },
};
const { provenance: _runEvidence, ...unattributedItem } = item;
const protectedSources = [
  { label: "tagged conversation capture", source: item },
  {
    label: "legacy agent document without tags or provenance",
    source: {
      ...unattributedItem,
      origin: "agent" as const,
      tags: [],
    },
  },
];
const target = WorkspaceKnowledgeItemId.make("chosen");
const outgoing = parseWorkspaceWikiLinks(item.content).map((link, index) => ({
  ...link,
  sourceItemId: item.id,
  sourceTitle: item.title,
  targetTitle: index ? "missing" : "New title",
  targetItemId: index ? null : target,
}));
const graph = {
  outgoing,
  unresolved: [outgoing[1]!],
  backlinks: [
    {
      ...outgoing[0]!,
      sourceItemId: WorkspaceKnowledgeItemId.make("source"),
      sourceTitle: "Backlink",
      context: "incoming context",
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  hooks.reset();
  mocks.list.mockImplementation((arg) => arg);
  mocks.links.mockReturnValue("graph");
  mocks.read.mockImplementation((key) => ({
    data:
      key === "graph"
        ? graph
        : key?.input?.itemId
          ? { items: [item] }
          : key?.input?.sourceItemId
            ? { items: [] }
            : null,
    error: null,
    refresh: vi.fn(),
  }));
});

it("mounts the version panel on the existing imported PDF and its retired page link, but not a user fork or similarly named note", () => {
  const attachment = { name: "Example.pdf", contentHash: "fixture-hash" };
  const source = {
    ...item,
    title: "Example.pdf",
    tags: ["pdf-page-batch"],
    origin: "imported",
    research: { attachment },
  };
  for (const [row, expected] of [
    [source, true],
    [{ ...source, status: "archived" }, true],
    [{ ...source, sourceItemId: target }, false],
    [{ ...source, tags: [] }, false],
    [{ ...source, origin: "user" }, false],
  ] as const) {
    hooks.reset();
    mocks.read.mockImplementation((key) => ({
      data: key?.input?.itemId ? { items: [row] } : null,
      error: null,
      refresh: vi.fn(),
    }));
    hooks.beginRender();
    const page = KnowledgeDocumentPage({ project, itemId: item.id, view: "read" });
    const panel = visitElements(page, (element) => element.type === PdfRevisionPanel);
    if (expected) {
      expect(panel?.props).toMatchObject({
        environmentId: project.environmentId,
        projectId: project.id,
        itemId: item.id,
        excerptHash: "fixture-hash",
      });
    } else {
      expect(panel).toBeNull();
    }
  }
});

it("reads one scoped document and filters separately for its manual fork", () => {
  hooks.beginRender();
  KnowledgeDocumentPage({ project, itemId: item.id, view: "read" });
  expect(mocks.list.mock.calls.map(([request]) => request)).toEqual([
    {
      environmentId: project.environmentId,
      input: { projectId: project.id, itemId: item.id, includeShared: false },
    },
    {
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        sourceItemId: item.id,
        includeShared: false,
        summariesOnly: true,
      },
    },
  ]);
});

it("renders stable links, context for backlinks and missing targets, and the scoped run destination", () => {
  hooks.beginRender();
  const html = renderToStaticMarkup(
    <KnowledgeReader project={project} item={item} links={graph} fork={undefined} />,
  );
  expect(html).toContain("/control-center/env-a/project-a/knowledge/docs/chosen");
  expect(html).toContain("/control-center/env-a/project-a/knowledge/docs/source");
  expect(html).toContain("incoming context");
  expect(html).toContain("Other [[missing]]");
  expect(html).toContain("/control-center/env-a/project-a?knowledgeRun=run-1");
});

it.each(protectedSources)(
  "saves a $label and opens the returned user document",
  async ({ source: item }) => {
    mocks.read.mockImplementation((key) => ({
      data: key === "graph" ? graph : key?.input?.itemId ? { items: [item] } : { items: [] },
      error: null,
      refresh: vi.fn(),
    }));
    hooks.beginRender();
    const page = KnowledgeDocumentPage({ project, itemId: item.id, view: "edit" });
    const editSession = visitElements(page, (e) => typeof e.props.onSaved === "function")!;
    const onSaved = editSession.props.onSaved as (id: WorkspaceKnowledgeItemId) => void;
    hooks.reset();
    const fork = WorkspaceKnowledgeItemId.make("human-copy");
    mocks.send.mockResolvedValue({ _tag: "Success", value: { itemId: fork, sequence: 9 } });
    function render() {
      hooks.beginRender();
      return KnowledgeEditor({ project, item, links: graph, sequence: 7, onSaved });
    }
    let tree = render();
    expect(visitElements(tree, (e) => e.props.type === "submit")?.props.children).toBe(
      "사용자 문서로 저장",
    );
    const field = visitElements(tree, (e) => e.props.value === "Spec")!;
    (field.props.onChange as (e: unknown) => void)({ target: { value: "Edited" } });
    tree = render();
    (tree.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/control-center/$environmentId/$projectId/knowledge/docs/$itemId",
        params: { environmentId: project.environmentId, projectId: project.id, itemId: fork },
        search: {},
        replace: true,
      }),
    );
    expect(mocks.send.mock.calls[0]?.[0].input).not.toHaveProperty("wikiLinksCanonicalized");
    expect(mocks.send).toHaveBeenCalledWith({
      environmentId: project.environmentId,
      input: expect.objectContaining({
        projectId: project.id,
        itemId: item.id,
        title: "Edited",
        content: item.content,
        expectedSequence: 7,
        commandId: expect.any(String),
      }),
    });
  },
);

const decodeKnowledgeItem = Schema.decodeUnknownSync(WorkspaceKnowledgeItem);

function renderProvenance(provenance: WorkspaceKnowledgeItem["provenance"]) {
  hooks.reset();
  hooks.beginRender();
  const record: WorkspaceKnowledgeItem = {
    ...item,
    tags: ["agent-grok", "confidence-high"],
    provenance: provenance ?? null,
  };
  return renderToStaticMarkup(
    <KnowledgeReader
      project={project}
      item={decodeKnowledgeItem(record)}
      links={null}
      fork={undefined}
    />,
  );
}

it("shows structured role, confidence, actual model and instance separately even when tags disagree", () => {
  const html = renderProvenance({
    actor: "codex",
    confidence: "low",
    modelSelection: { model: "fixture-output", instanceId: ProviderInstanceId.make("instance-a") },
  });
  expect(html).toContain("<dt>담당 에이전트 (역할)</dt><dd>codex</dd>");
  expect(html).toContain("<dt>신뢰도</dt><dd>낮음</dd>");
  expect(html).toMatch(/<dt>출력 모델<\/dt><dd[^>]*>fixture-output<\/dd>/);
  expect(html).toMatch(/<dt>제공자 인스턴스<\/dt><dd[^>]*>instance-a<\/dd>/);
  expect(html).not.toContain("높음");
});

it("marks missing provenance independently for partial and legacy records", () => {
  const partial = renderProvenance({ actor: "fable" });
  expect(partial).toContain("<dd>fable</dd>");
  expect(partial).toContain("<dt>신뢰도</dt><dd>미확인</dd>");
  expect(partial.match(/미확인/g)).toHaveLength(3);
  const confidenceOnly = renderProvenance({ confidence: "medium" });
  expect(confidenceOnly).toContain("<dt>담당 에이전트 (역할)</dt><dd>미확인</dd>");
  expect(confidenceOnly).toContain("<dt>신뢰도</dt><dd>보통</dd>");
  const legacy = renderProvenance(undefined);
  expect(legacy.match(/미확인/g)).toHaveLength(4);
  expect(legacy).not.toContain("grok");
  expect(legacy).not.toContain("높음");
});

it("requests only the selected revision pair from this document", () => {
  // Each selector addresses an immutable snapshot by event sequence.
  mocks.head.mockReturnValue("head");
  mocks.revision.mockImplementation((target) => target);
  mocks.read.mockImplementation((key) => ({
    data:
      key === "head"
        ? {
            revisions: [7, 4].map((sequence) => ({
              sequence,
              occurredAt: item.createdAt,
              eventType: "project.knowledge-item-upserted",
            })),
            nextBeforeSequence: null,
          }
        : null,
    error: null,
  }));
  hooks.beginRender();
  KnowledgeHistory({
    environmentId: project.environmentId,
    projectId: project.id,
    itemId: item.id,
  });
  expect(mocks.revision.mock.calls.map(([request]) => request.input)).toEqual(
    [4, 7].map((sequence) => ({ projectId: project.id, itemId: item.id, sequence })),
  );
});

it("binds a new namesake to the explicitly picked ID and preserves the old occurrence", async () => {
  const onSaved = vi.fn();
  mocks.send.mockResolvedValue({ _tag: "Success", value: { itemId: item.id, sequence: 10 } });
  const added = WorkspaceKnowledgeItemId.make("other-document");
  function render() {
    hooks.beginRender();
    return KnowledgeEditor({ project, item, links: graph, sequence: 7, onSaved });
  }
  let tree = render();
  const body = visitElements(
    tree,
    (e) => typeof e.props.value === "string" && e.props.value.includes("[[id:chosen|참고]]"),
  )!;
  const value = body.props.value + "\n[[Old title";
  (body.props.onChange as (e: unknown) => void)({
    target: { value, selectionStart: value.length },
  });
  tree = render();
  const picker = visitElements(tree, (e) => e.type === WikiLinkPicker)!;
  (picker.props.onPick as (choice: unknown) => void)({ id: added, title: "Old title" });
  tree = render();
  (tree.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(mocks.send.mock.calls[0]?.[0].input.content).toContain("[[id:chosen|참고]]");
  expect(mocks.send.mock.calls[0]?.[0].input.wikiLinksCanonicalized).toBe(true);
  expect(mocks.send.mock.calls[0]?.[0].input.content).toContain("[[id:other-document|Old title]]");
});

it.each(protectedSources)(
  "routes a repeat edit of a $label to the existing user fork",
  ({ source: item }) => {
    const fork = {
      ...item,
      origin: "user",
      id: WorkspaceKnowledgeItemId.make("fork"),
      sourceItemId: item.id,
    };
    mocks.read.mockImplementation((key) => ({
      data:
        key === "graph"
          ? graph
          : key?.input?.sourceItemId === item.id
            ? { items: [{ ...fork, id: "wrong", projectId: "another-project" }, fork] }
            : { items: [item] },
      error: null,
    }));
    hooks.beginRender();
    const redirect = KnowledgeDocumentPage({ project, itemId: item.id, view: "edit" });
    expect(redirect.props.params).toEqual({
      environmentId: project.environmentId,
      projectId: project.id,
      itemId: fork.id,
    });
    expect(redirect.props.search).toEqual({ view: "edit" });
    expect(mocks.send).not.toHaveBeenCalled();
  },
);

it("loads run documents only when expanded and supplies the run and project filters", () => {
  const runId = item.provenance!.runId!;
  function render() {
    hooks.beginRender();
    return RunKnowledgeDocuments({ project, runId });
  }
  const initial = render();
  expect(mocks.list).not.toHaveBeenCalled();
  (initial.props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } });
  render();
  expect(mocks.list).toHaveBeenCalledWith({
    environmentId: project.environmentId,
    input: { projectId: project.id, sourceRunId: runId, includeShared: false, summariesOnly: true },
  });
});

it("opens a single full body on demand from a metadata-only card", () => {
  const ref = { environmentId: project.environmentId, projectId: project.id, itemId: item.id };
  function render() {
    hooks.beginRender();
    return KnowledgeExcerpt(ref);
  }
  const closed = render();
  expect(visitElements(closed, (e) => e.type === StoredKnowledgeOriginal)).toBeNull();
  expect(mocks.list).not.toHaveBeenCalled();
  (closed.props.onToggle as (e: unknown) => void)({ currentTarget: { open: true } });
  expect(visitElements(render(), (e) => e.type === StoredKnowledgeOriginal)).not.toBeNull();
  hooks.reset();
  hooks.beginRender();
  const original = StoredKnowledgeOriginal(ref);
  expect(mocks.list).toHaveBeenCalledWith({
    environmentId: project.environmentId,
    input: { projectId: project.id, itemId: item.id, includeShared: false },
  });
  expect(original.props.children).toBe(item.content);
});
