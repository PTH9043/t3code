import { useState } from "react";
import type { AssistantComputerStatus, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { notifyCommandFailure } from "../control-center/controlCenterShared";

type Command =
  | { action: "create"; image: string; network: "none" | "bridge"; kind?: "container" | "vm" }
  | { action: "status" | "start" | "stop" | "remove" };

export function ThreadAssistantComputer(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const saved = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.threadAssistantComputers[props.threadId],
  );
  const creatorMode = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.threadCreatorModes[props.threadId] === true,
  );
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const control = useAtomCommand(serverEnvironment.assistantComputerControl, {
    reportFailure: false,
  });
  const [image, setImage] = useState("");
  const [kind, setKind] = useState<"container" | "vm">("vm");
  const [network, setNetwork] = useState<"" | "none" | "bridge">("");
  const [status, setStatus] = useState<AssistantComputerStatus | null>(null);
  const [pending, setPending] = useState(false);

  const invoke = async (command: Command) => {
    setPending(true);
    try {
      const result = await control({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, command },
      });
      if (!notifyCommandFailure(result, "비서 컴퓨터 요청 실패") && result._tag === "Success") {
        setStatus(result.value);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className="mt-3 flex max-w-xl flex-col gap-2 border-t border-border pt-2"
      aria-label="비서 컴퓨터"
    >
      <p className="font-medium">비서 컴퓨터</p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={creatorMode}
          onChange={(event) =>
            updateSettings({
              threadCreatorModes: { [props.threadId]: event.currentTarget.checked },
            })
          }
        />
        이 대화에서 플러그인 개발·교체 허용
      </label>
      <p className="text-muted-foreground">
        플러그인은 T3 서버 권한으로 실행됩니다. VM 내부 실행과는 별개입니다.
      </p>
      <p className="text-muted-foreground">
        서버를 다시 시작하면 플러그인은 자동으로 실행되지 않습니다. 기존 작업의 결과를 확인한 후
        다시 불러올 수 있습니다.
      </p>
      <p className="text-muted-foreground">
        이 대화 전용 실행 공간입니다. AI 모델 자체는 기존 환경에서 실행됩니다.
      </p>
      {saved ? (
        <>
          <p className="text-muted-foreground">
            {saved.kind === "vm" ? "독립 Ubuntu VM" : "Docker 컨테이너"} · 이미지: {saved.image} ·
            네트워크: {saved.network === "none" ? "차단" : "연결"}
          </p>
          {status?.configured ? (
            <p>
              상태:{" "}
              {status.status === "pending"
                ? "생성 결과 확인 필요"
                : status.status === "starting"
                  ? "VM 부팅 중"
                  : status.status === "running"
                    ? "실행 중"
                    : status.status === "exited"
                      ? "중지됨"
                      : status.status}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border border-border px-2 py-1"
              disabled={pending}
              onClick={() => void invoke({ action: "status" })}
            >
              상태 확인
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1"
              disabled={pending}
              onClick={() => void invoke({ action: "start" })}
            >
              시작
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1"
              disabled={pending}
              onClick={() => void invoke({ action: "stop" })}
            >
              중지
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1"
              disabled={pending}
              onClick={() => void invoke({ action: "remove" })}
            >
              컴퓨터와 내부 파일 삭제
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="flex items-center gap-2">
            실행 환경
            <select
              className="rounded border border-border bg-background px-2 py-1 text-foreground"
              value={kind}
              onChange={(event) => setKind(event.currentTarget.value as typeof kind)}
            >
              <option value="vm">독립 Ubuntu VM</option>
              <option value="container">Docker 컨테이너</option>
            </select>
          </label>
          {kind === "vm" ? (
            <p>Ubuntu · CPU 2개 · 메모리 4GB · 디스크 최대 16GB</p>
          ) : (
            <label className="flex flex-col gap-1">
              설치된 Node 포함 Docker 이미지
              <input
                className="rounded border border-border bg-background px-2 py-1 text-foreground"
                placeholder="예: node:24-alpine"
                value={image}
                onChange={(event) => setImage(event.currentTarget.value)}
              />
            </label>
          )}
          <label className="flex items-center gap-2">
            네트워크
            <select
              className="rounded border border-border bg-background px-2 py-1 text-foreground"
              value={network}
              onChange={(event) => setNetwork(event.currentTarget.value as typeof network)}
            >
              <option value="">선택</option>
              <option value="none">차단</option>
              <option value="bridge">연결</option>
            </select>
          </label>
          <button
            type="button"
            className="self-start rounded border border-border px-2 py-1"
            disabled={pending || (kind === "container" && !image.trim()) || !network}
            onClick={() => {
              if (network)
                void invoke({
                  action: "create",
                  image: kind === "vm" ? "t3-assistant-vm:ubuntu-noble-20261017" : image.trim(),
                  network,
                  kind,
                });
            }}
          >
            컴퓨터 생성
          </button>
        </>
      )}
    </section>
  );
}
