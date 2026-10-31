import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceDevelopmentState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DEFAULT_MEETING_COMPOSER_CONFIG } from "../../meetingComposerStore";
import type { WorkspaceDevelopmentPanelProps } from "./WorkspaceDevelopmentPanel";
import { useComposerWorkMode, type ComposerWorkMode } from "./useComposerWorkMode";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  configure: vi.fn(
    async (_input: unknown): Promise<{ _tag: "Success" | "Failure" }> => ({
      _tag: "Success",
    }),
  ),
}));
vi.mock("../../meetingComposerStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../meetingComposerStore")>()),
  updateMeetingComposerConfig: state.update,
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { configureDevelopment: "configure" },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.configure }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("변경 실패"),
}));

let select: (mode: ComposerWorkMode) => Promise<boolean>;
function Harness({ development }: { development: WorkspaceDevelopmentPanelProps | null }) {
  select = useComposerWorkMode(development).selectMode;
  return null;
}

const model = { instanceId: ProviderInstanceId.make("codex"), model: "model" };
const developmentState = Schema.decodeUnknownSync(WorkspaceDevelopmentState)({
  projectId: "project",
  conversationId: "thread",
  enabled: true,
  revision: 1,
  policyRevision: 1,
  mainObservedRevision: 0,
  mainActedRevision: 0,
  pendingMainNotification: false,
  ownerModels: [model],
  runtimeMode: "full-access",
  maxParallelOwners: 3,
  verificationCommands: [{ command: "check", args: [] }],
  bindings: [],
  tasks: [],
  verifications: [],
  integrations: [],
  workspaces: [],
});
const development = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  conversationId: ThreadId.make("thread"),
  mainModel: model,
  runtimeMode: "full-access",
  interactionMode: "plan",
  state: developmentState,
} as WorkspaceDevelopmentPanelProps;

beforeEach(() => {
  state.update.mockClear();
  state.configure.mockReset();
  state.configure.mockResolvedValue({ _tag: "Success" });
});

it("enables orchestra without changing the existing roster or settings", async () => {
  renderToStaticMarkup(<Harness development={null} />);
  expect(await select("meeting")).toBe(true);
  const update = state.update.mock.calls[0]![0] as (
    value: typeof DEFAULT_MEETING_COMPOSER_CONFIG,
  ) => typeof DEFAULT_MEETING_COMPOSER_CONFIG;
  const current = { ...DEFAULT_MEETING_COMPOSER_CONFIG, maxParallel: 2, reviewPlan: true };
  expect(update(current)).toEqual({ ...current, enabled: true });
  expect(state.configure).not.toHaveBeenCalled();
});

it("enables orchestra without disabling an active persistent workspace", async () => {
  renderToStaticMarkup(<Harness development={development} />);
  expect(await select("meeting")).toBe(true);
  expect(state.configure).not.toHaveBeenCalled();
  expect(state.update).toHaveBeenCalledOnce();
});

it("opening persistent-work settings leaves the orchestra preference untouched", async () => {
  renderToStaticMarkup(<Harness development={development} />);
  expect(await select("development")).toBe(true);
  expect(state.update).not.toHaveBeenCalled();
  expect(state.configure).not.toHaveBeenCalled();
});
