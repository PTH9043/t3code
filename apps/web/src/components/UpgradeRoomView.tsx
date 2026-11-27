import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ServerConfig,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import { useProject, useThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import ChatView from "./ChatView";
import { buildLocalDraftThread } from "./ChatView.logic";
import { SidebarProvider } from "./ui/sidebar";

export function UpgradeRoomView({
  config,
  room,
}: {
  config: ServerConfig;
  room: NonNullable<ServerConfig["upgradeRoom"]>;
}) {
  const environmentId = config.environment.environmentId;
  const shell = useThreadShell(scopeThreadRef(environmentId, room.threadId));
  const project = useProject(scopeProjectRef(environmentId, room.projectId));
  const create = useAtomCommand(threadEnvironment.create);
  const update = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [openedAt] = useState(() => new Date().toISOString());
  const createdAt = project?.createdAt ?? openedAt;
  // The canonical thread is first persisted by an explicit model choice. Its
  // empty timeline and composer can already use the same environment/thread key.
  const emptyThread = useMemo(
    () => ({
      ...buildLocalDraftThread(
        room.threadId,
        {
          environmentId,
          projectId: room.projectId,
          createdAt,
          branch: null,
          worktreePath: null,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        },
        NO_PROVIDER_MODEL_SELECTION,
      ),
      title: "AutoUsage 업그레이드",
    }),
    [createdAt, environmentId, room.projectId, room.threadId],
  );
  const saved = shell?.modelSelection;
  const choices = useMemo(
    () =>
      config.providers.filter(
        (p) =>
          p.enabled &&
          p.installed &&
          p.status !== "disabled" &&
          p.status !== "error" &&
          p.availability !== "unavailable" &&
          p.auth.status !== "unauthenticated" &&
          p.models.length > 0,
      ),
    [config.providers],
  );
  const available =
    !!saved &&
    choices.some(
      (p) =>
        p.instanceId === saved.instanceId && p.models.some((model) => model.slug === saved.model),
    );

  const select = async (instanceId: string, slug: string) => {
    if (pending || !project) return;
    if (saved?.instanceId === instanceId && saved.model === slug) return;
    const provider = choices.find((p) => p.instanceId === instanceId);
    const model = provider?.models.find((m) => m.slug === slug);
    if (!provider || !model) return;
    const modelSelection = { instanceId: provider.instanceId, model: model.slug };
    setPending(true);
    setError("");
    try {
      const result = shell
        ? await update({ environmentId, input: { threadId: room.threadId, modelSelection } })
        : await create({
            environmentId,
            input: {
              ...room,
              modelSelection,
              title: "AutoUsage 업그레이드",
              branch: null,
              worktreePath: null,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt: new Date().toISOString(),
            },
          });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "방 모델을 저장할 수 없습니다.");
    } finally {
      setPending(false);
    }
  };
  return (
    <SidebarProvider defaultOpen={false} className="h-dvh! min-h-0!">
      <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background text-foreground">
        <ChatView
          environmentId={environmentId}
          threadId={room.threadId}
          routeKind="server"
          dedicatedRoom={{
            emptyThread,
            modelSelection: saved ?? null,
            picker: {
              providers: choices,
              disabled: pending || !project || choices.length === 0,
              error,
              onSelect: select,
              placeholder: available
                ? null
                : saved
                  ? `사용 불가 · ${saved.instanceId} / ${saved.model}`
                  : choices.length === 0
                    ? "사용 가능한 계정과 모델이 없습니다"
                    : "계정과 모델 선택",
            },
            sendDisabledReason: pending
              ? "방 모델 저장 중"
              : available
                ? null
                : choices.length === 0
                  ? "T3 제공자 설정에서 사용할 수 있는 계정과 모델을 확인하세요"
                  : "방에서 사용할 계정과 모델을 선택하세요",
          }}
        />
      </main>
    </SidebarProvider>
  );
}
