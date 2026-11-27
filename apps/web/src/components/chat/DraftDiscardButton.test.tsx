import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  DEFAULT_MEETING_COMPOSER_CONFIG,
  useMeetingComposerStore,
} from "../../meetingComposerStore";
import { useWorkspaceTabStore, workspaceTabViewKey } from "../../workspaceTabStore";
import { DraftDiscardButton } from "./DraftDiscardButton";

const ui = vi.hoisted(() => ({
  navigate: vi.fn(),
  click: () => {},
  hasShell: false,
  routeDraftId: "",
}));
vi.mock("../../state/entities", () => ({ readThreadShell: () => (ui.hasShell ? {} : null) }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({
    get state() {
      return { matches: [{ params: { draftId: ui.routeDraftId } }] };
    },
    navigate: ui.navigate,
  }),
}));
vi.mock("../ui/button", () => ({
  Button: ({
    onClick,
    children,
    disabled,
  }: {
    onClick: () => void;
    children: string;
    disabled: boolean;
  }) => {
    ui.click = onClick;
    return (
      <button type="button" disabled={disabled}>
        {children}
      </button>
    );
  },
}));

const drafts = useComposerDraftStore;
const tabs = useWorkspaceTabStore;
const meetings = useMeetingComposerStore;
afterEach(() => {
  drafts.setState(drafts.getInitialState(), true);
  tabs.setState(tabs.getInitialState(), true);
  meetings.setState(meetings.getInitialState(), true);
  ui.navigate.mockClear();
  ui.hasShell = false;
});

function openDraft(name: string) {
  const environmentId = EnvironmentId.make(name);
  const projectId = ProjectId.make(name);
  const threadId = ThreadId.make("reserved-id");
  const draftId = DraftId.make(name);
  const view = { kind: "draft" as const, draftId };
  const viewKey = workspaceTabViewKey(view);
  drafts.getState().setProjectDraftThreadId({ environmentId, projectId }, draftId, { threadId });
  drafts.getState().setPrompt(draftId, name);
  drafts.getState().updateDraftModelTeam(draftId, {
    threadId,
    answeringInstanceId: ProviderInstanceId.make("test"),
    forModel: "main",
    members: [],
  });
  meetings
    .getState()
    .updateConfig(viewKey, () => ({ ...DEFAULT_MEETING_COMPOSER_CONFIG, enabled: true }));
  tabs.getState().syncRouteView(view, { projectKey: name });
  ui.routeDraftId = draftId;
  return { draftId, threadRef: { environmentId, threadId }, viewKey };
}

it("discards only the visible draft, its team, meeting configuration and tab, and returns to the surviving tab", () => {
  const other = openDraft("other");
  const current = openDraft("current");
  const otherSession = drafts.getState().getDraftSession(other.draftId);
  const otherPrompt = drafts.getState().getComposerDraft(other.draftId);
  expect(
    renderToStaticMarkup(
      <DraftDiscardButton {...current} disabled={false} isSending={() => false} />,
    ),
  ).toContain("초안 버리기");
  ui.click();

  expect(drafts.getState().getDraftSession(current.draftId)).toBeNull();
  expect(drafts.getState().getComposerDraft(current.draftId)).toBeNull();
  expect(drafts.getState().getDraftSession(other.draftId)).toBe(otherSession);
  expect(drafts.getState().getComposerDraft(other.draftId)).toBe(otherPrompt);
  expect(meetings.getState().configsByFolder[current.viewKey]).toBeUndefined();
  expect(meetings.getState().configsByFolder[other.viewKey]?.enabled).toBe(true);
  expect(tabs.getState().tabs.map((tab) => workspaceTabViewKey(tab.view))).toEqual([other.viewKey]);
  expect(ui.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/draft/$draftId",
    params: { draftId: other.draftId },
    replace: true,
  });
});

it.each(["unregistered", "other-active"] as const)(
  "discards the draft from its URL while tab registration is %s",
  (phase) => {
    const other = openDraft("keep");
    const keep = tabs.getState().activeTabId!;
    const current = openDraft("deep-link");
    if (phase === "unregistered") tabs.getState().closeTabsForView(current.viewKey);
    else tabs.getState().activateTab(keep);
    expect(tabs.getState().activeTabId).toBe(keep);
    renderToStaticMarkup(
      <DraftDiscardButton {...current} disabled={false} isSending={() => false} />,
    );
    ui.click();
    expect(drafts.getState().getDraftSession(current.draftId)).toBeNull();
    expect(drafts.getState().getComposerDraft(other.draftId)?.prompt).toBe("keep");
    expect(tabs.getState().tabs.map((tab) => tab.id)).toEqual([keep]);
    expect(ui.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/draft/$draftId",
      params: { draftId: other.draftId },
      replace: true,
    });
  },
);

it("returns to the landing route when the discarded draft was the last tab", () => {
  const current = openDraft("only");
  renderToStaticMarkup(
    <DraftDiscardButton {...current} disabled={false} isSending={() => false} />,
  );
  ui.click();
  expect(tabs.getState().tabs).toEqual([]);
  expect(tabs.getState().lastChatView).toBeNull();
  expect(ui.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true });
});

it("ignores a stale background button, a mismatched environment, a running submission and a promoted draft", () => {
  const a = openDraft("a");
  const b = openDraft("b");
  const click = (props: Parameters<typeof DraftDiscardButton>[0]) => {
    renderToStaticMarkup(<DraftDiscardButton {...props} />);
    ui.click();
  };
  const ready = { disabled: false, isSending: () => false };
  click({ ...a, ...ready });
  click({ ...b, ...ready, threadRef: a.threadRef });
  click({ ...b, ...ready, disabled: true });
  click({ ...b, ...ready, isSending: () => true });
  ui.hasShell = true;
  click({ ...b, ...ready });
  expect(drafts.getState().getDraftSession(b.draftId)).not.toBeNull();
  ui.hasShell = false;
  drafts.getState().markDraftThreadPromoting(b.draftId, b.threadRef);
  click({ ...b, ...ready });
  expect(drafts.getState().getDraftSession(a.draftId)).not.toBeNull();
  expect(drafts.getState().getDraftSession(b.draftId)).not.toBeNull();
  expect(tabs.getState().tabs).toHaveLength(2);
  expect(ui.navigate).not.toHaveBeenCalled();
});
