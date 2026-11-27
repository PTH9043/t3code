import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  WorkspaceKnowledgeItemId,
  type PdfRevisionStatus,
} from "@t3tools/contracts";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { visitElements } from "~/test/reactElementTree";
import { PdfPublishedSource, PdfRevisionPanel } from "./PdfRevisionPanel";

const rpc = vi.hoisted(() => ({
  scopes: ["orchestration:operate"],
  get: vi.fn(),
  start: vi.fn(),
  retry: vi.fn(),
  source: vi.fn(),
  encode: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  const { reactHookHarness: h } = await import("~/test/reactHookHarness");
  return {
    ...real,
    useState: h.useState,
    useRef: h.useRef,
    useCallback: h.useCallback,
    useEffect: (f: () => void) => rpc.effects.push(f),
  };
});
vi.mock("react/compiler-runtime", async () => ({
  c: (await import("~/test/reactHookHarness")).reactHookHarness.useMemoCache,
}));
vi.mock("./pdfRevisionApi", () => ({
  getPdfRevisionStatus: "get",
  startPdfRevision: "start",
  retryPdfRevision: "retry",
  readPdfRevisionSource: "source",
}));
vi.mock("~/state/session", () => ({
  useEnvironmentSessionState: () => ({ data: { authenticated: true, scopes: rpc.scopes } }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (key: "get" | "start" | "retry" | "source") => rpc[key],
}));
vi.mock("../ChatView.logic", () => ({ readFileAsDataUrl: rpc.encode }));
const environmentId = EnvironmentId.make("env"),
  projectId = ProjectId.make("project"),
  itemId = WorkspaceKnowledgeItemId.make("doc");
const props = {
  environmentId,
  projectId,
  itemId,
  name: "original.pdf",
  excerptHash: "first",
  onPublished: vi.fn(),
};
const ref = { environmentId, input: { projectId, itemId } };
const v1 = { version: 1, contentHash: "first", totalPages: 12 };
const pending = {
  version: 2,
  contentHash: "second",
  totalPages: 15,
  lastPage: 6,
  status: "indexing" as const,
  error: null,
};
let durable: PdfRevisionStatus;
const dataUrl = "data:application/pdf;base64,JVBERi0=";
const file = new File(["%PDF-"], "update.pdf", { type: "application/pdf" });
const success = <T,>(value: T) => ({ _tag: "Success", value });
function render() {
  hooks.beginRender();
  return PdfRevisionPanel(props);
}
function button(label: string) {
  return visitElements(render(), (e) => e.props.children === label);
}
async function press(label: string) {
  const btn = button(label);
  expect(btn).not.toBeNull();
  expect(btn!.props.disabled).not.toBe(true);
  await (btn!.props.onClick as () => Promise<void>)();
}
function choose(file?: File) {
  const input = visitElements(render(), (e) => e.type === "input" && e.props.type === "file");
  expect(input).not.toBeNull();
  (input!.props.onChange as (e: unknown) => void)({
    currentTarget: { files: file ? [file] : [], value: "" },
  });
}
beforeEach(() => {
  hooks.reset();
  rpc.scopes = ["orchestration:operate"];
  vi.clearAllMocks();
  rpc.effects = [];
  durable = { published: v1, pending: null };
  rpc.get.mockImplementation(async () => success(durable));
  rpc.encode.mockResolvedValue(dataUrl);
  rpc.start.mockImplementation(async () => {
    durable = { published: v1, pending };
    return success(durable);
  });
  rpc.retry.mockImplementation(async () => {
    durable = { published: v1, pending };
    return success(durable);
  });
});

it("uploads only after an explicit click with the original environment, item and expected published version", async () => {
  await press("상태 새로고침");
  expect(rpc.get).toHaveBeenCalledExactlyOnceWith(ref);
  choose();
  expect(button("새 버전 올리기")?.props.disabled).toBe(true);
  choose(new File(["text"], "fixture.txt", { type: "text/plain" }));
  expect(button("새 버전 올리기")?.props.disabled).toBe(true);
  choose(file);
  expect(rpc.start).not.toHaveBeenCalled();
  await press("새 버전 올리기");
  expect(rpc.start).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      projectId,
      itemId,
      expectedVersion: 1,
      requestId: expect.any(String),
      file: {
        type: "file",
        mimeType: "application/pdf",
        name: file.name,
        sizeBytes: file.size,
        dataUrl,
      },
    },
  });
  expect(visitElements(render(), (e) => e.type === "progress")?.props).toMatchObject({
    value: 6,
    max: 15,
  });
  expect(visitElements(render(), (e) => e.type === PdfPublishedSource)?.props.version).toBe(1);
  expect(
    visitElements(render(), (e) => e.props.hash === "project-knowledge-search")?.props.params,
  ).toEqual({ environmentId, projectId });
});
it("reads a persisted failure on reopening and resumes it without a file; the source changes only after publication", async () => {
  durable = { published: v1, pending: { ...pending, status: "failed", error: "fixture failure" } };
  await press("상태 새로고침");
  expect(visitElements(render(), (e) => e.props.children === "fixture failure")).not.toBeNull();
  expect(button("새 버전 올리기")?.props.disabled).toBe(true);
  await press("색인 재개");
  expect(rpc.retry).toHaveBeenCalledExactlyOnceWith(ref);
  expect(rpc.start).not.toHaveBeenCalled();
  expect(button("새 버전 올리기")).toBeNull();
  expect(visitElements(render(), (e) => e.type === PdfPublishedSource)?.props.version).toBe(1);
  durable = { published: { version: 2, totalPages: 15, contentHash: "second" }, pending: null };
  await press("상태 새로고침");
  expect(visitElements(render(), (e) => e.type === PdfPublishedSource)?.props.version).toBe(2);
  expect(props.onPublished).toHaveBeenCalledOnce();
  expect(button("색인 재개")).toBeNull();
});
it("submits corrected bytes under a fresh ID and reuses that ID only for an uncertain delivery of the same selection", async () => {
  const broken = new File(["%PDF-truncated"], "volume.pdf", { type: "application/pdf" });
  const corrected = new File(["%PDF-fixed"], broken.name, { type: broken.type });
  const failed = { ...pending, status: "failed" as const, error: "fixture: invalid page" };
  rpc.encode.mockImplementation(
    async (pdf: File) => `data:application/pdf;base64,${btoa(await pdf.text())}`,
  );
  rpc.start.mockImplementationOnce(async () => {
    durable = { published: v1, pending: failed };
    return success(durable);
  });
  await press("상태 새로고침");
  choose(broken);
  await press("새 버전 올리기");
  const first = rpc.start.mock.calls[0]![0].input;
  choose();
  expect(button("새 버전 올리기")?.props.disabled).toBe(true);
  choose(corrected);
  expect(rpc.start).toHaveBeenCalledTimes(1);
  rpc.start.mockRejectedValueOnce(new Error("fixture: response lost"));
  await press("새 버전 올리기");
  const replacement = rpc.start.mock.calls[1]![0];
  expect(replacement).toEqual({
    environmentId,
    input: {
      projectId,
      itemId,
      expectedVersion: v1.version,
      requestId: expect.any(String),
      file: {
        type: "file",
        name: corrected.name,
        mimeType: "application/pdf",
        sizeBytes: corrected.size,
        dataUrl: `data:application/pdf;base64,${btoa("%PDF-fixed")}`,
      },
    },
  });
  expect(replacement.input.requestId).not.toBe(first.requestId);
  expect(replacement.input.file.dataUrl).not.toBe(first.file.dataUrl);
  expect(visitElements(render(), (e) => e.type === PdfPublishedSource)?.props.version).toBe(1);
  expect(
    visitElements(render(), (e) => e.props.hash === "project-knowledge-search")?.props.params,
  ).toEqual({ environmentId, projectId });
  rpc.start.mockImplementationOnce(async () => {
    durable = { published: v1, pending: { ...pending, contentHash: "corrected", lastPage: 0 } };
    return success(durable);
  });
  await press("새 버전 올리기");
  expect(rpc.start).toHaveBeenCalledTimes(3);
  expect(rpc.start.mock.calls[2]![0]).toEqual(replacement);
  expect(rpc.retry).not.toHaveBeenCalled();
  expect(button("새 버전 올리기")).toBeNull();
  expect(button("색인 재개")).toBeNull();
  expect(visitElements(render(), (e) => e.type === PdfPublishedSource)?.props.version).toBe(1);
  expect(
    visitElements(render(), (e) => e.props.hash === "project-knowledge-search"),
  ).not.toBeNull();
  expect(props.onPublished).not.toHaveBeenCalled();
});

it("shows the server's failed or already-published result without claiming a new indexing attempt", async () => {
  durable = { published: v1, pending: { ...pending, status: "failed", error: "fixture error" } };
  rpc.start.mockImplementation(async () => success(durable));
  await press("상태 새로고침");
  choose(file);
  await press("새 버전 올리기");
  expect(button("색인 재개")).not.toBeNull();
  expect(visitElements(render(), (e) => e.type === "progress")).toBeNull();
  expect(visitElements(render(), (e) => e.props.children === "새 버전을 접수했습니다.")).toBeNull();
  rpc.start.mockImplementationOnce(async () => {
    durable = { published: v1, pending: null };
    return success(durable);
  });
  choose(new File(["%PDF-original"], file.name, { type: file.type }));
  await press("새 버전 올리기");
  expect(
    visitElements(render(), (e) => e.props.children === "현재 공개 버전은 1입니다."),
  ).not.toBeNull();
  expect(button("색인 재개")).toBeNull();
  expect(props.onPublished).not.toHaveBeenCalled();
  expect(rpc.retry).not.toHaveBeenCalled();
});

it("drops an unsent correction if a different failed attempt now occupies the same edition", async () => {
  durable = { published: v1, pending: { ...pending, status: "failed", error: "fixture error" } };
  await press("상태 새로고침");
  choose(file);
  expect(button("새 버전 올리기")?.props.disabled).toBe(false);
  durable = {
    published: v1,
    pending: {
      ...pending,
      status: "failed",
      contentHash: "another attempt",
      error: "fixture error",
    },
  };
  await press("상태 새로고침");
  expect(button("새 버전 올리기")?.props.disabled).toBe(true);
  expect(rpc.start).not.toHaveBeenCalled();
});

it("invalidates a file selection if another client publishes a new version first", async () => {
  await press("상태 새로고침");
  choose(file);
  durable = { published: { version: 2, totalPages: 15, contentHash: "second" }, pending: null };
  await press("상태 새로고침");
  expect(button("새 버전 올리기")?.props.disabled).toBe(true);
  expect(rpc.start).not.toHaveBeenCalled();
});
it("loads a specific published source only when opened, exposes a downloadable PDF, and releases its object URL", async () => {
  rpc.source.mockResolvedValue(success({ dataUrl }));
  function source() {
    hooks.beginRender();
    return PdfPublishedSource({ ...props, version: 2 });
  }
  const first = source();
  expect(rpc.source).not.toHaveBeenCalled();
  const btn = visitElements(first, (e) => e.props.children === "공개 PDF 원문 보기")!;
  await (btn.props.onClick as () => Promise<void>)();
  expect(rpc.source).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { projectId, itemId, version: 2 },
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  try {
    source();
    const cleanup = rpc.effects.at(-1)!();
    const view = source(),
      obj = visitElements(view, (e) => e.type === "object")!,
      link = visitElements(view, (e) => e.type === "a")!;
    expect(obj.props.type).toBe("application/pdf");
    expect(link.props.download).toBe("original.pdf");
    expect(link.props.href).toBe(obj.props.data);
    expect(link.props.href).toMatch(/^blob:/);
    if (typeof cleanup === "function") cleanup();
    expect(revoke).toHaveBeenCalledWith(link.props.href);
  } finally {
    revoke.mockRestore();
  }
});

it("restores progress on mount and polls only a visible indexing document", async () => {
  const add = vi.fn(),
    remove = vi.fn(),
    interval = vi.fn(),
    clear = vi.fn();
  const doc = { hidden: false };
  vi.stubGlobal("window", {
    addEventListener: add,
    removeEventListener: remove,
    setInterval: interval,
    clearInterval: clear,
  });
  vi.stubGlobal("document", doc);
  try {
    durable = { published: v1, pending };
    render();
    const cleanup = rpc.effects[1]!();
    await Promise.resolve();
    expect(rpc.get).toHaveBeenCalledExactlyOnceWith(ref);
    render();
    const stop = rpc.effects.at(-1)!();
    expect(interval).toHaveBeenCalledOnce();
    const tick = interval.mock.calls[0]![0] as () => void;
    doc.hidden = true;
    tick();
    expect(rpc.get).toHaveBeenCalledTimes(1);
    doc.hidden = false;
    tick();
    await Promise.resolve();
    expect(rpc.get).toHaveBeenCalledTimes(2);
    if (typeof stop === "function") stop();
    if (typeof cleanup === "function") cleanup();
    expect(clear).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("online", expect.any(Function));
    expect(rpc.start).not.toHaveBeenCalled();
    expect(rpc.retry).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("retains source, search and progress for read-only sessions without upload or retry", async () => {
  rpc.scopes = ["orchestration:read"];
  await press("상태 새로고침");
  expect(button("새 버전 올리기")).toBeNull();
  durable = { published: v1, pending: { ...pending, status: "failed", error: "fixture" } };
  await press("상태 새로고침");
  expect(button("색인 재개")).toBeNull();
  expect(button("새 버전 올리기")).toBeNull();
  expect(visitElements(render(), (e) => e.type === PdfPublishedSource)?.props.version).toBe(1);
  expect(
    visitElements(render(), (e) => e.props.hash === "project-knowledge-search"),
  ).not.toBeNull();
});
