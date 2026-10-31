import { useRef, useState } from "react";
import type {
  EnvironmentId,
  WorkspaceCollaborationRun,
  WorkspaceAgentControlAction,
} from "@t3tools/contracts";
import { agentControlStatusLabels } from "@t3tools/client-runtime/state/presentation";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { notifyCommandFailure, notifySuccess } from "../control-center/controlCenterShared";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
type Run = Pick<WorkspaceCollaborationRun, "id" | "projectId" | "graph" | "status">;
const INPUT = "w-full rounded-md border border-input bg-background p-2 text-xs";
export function WorkspaceAgentControlPanel(props: { environmentId: EnvironmentId; run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <section
      className="rounded-md border border-border bg-background p-3 text-xs"
      data-agent-control
    >
      <button
        type="button"
        className="w-full text-left font-semibold"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        작업자 메시지 · 실제 인계 입력 {open ? "▴" : "▾"}
      </button>
      {props.run.graph?.nodes
        .filter(
          (n) => n.usageRecovery?.phase === "waiting" && ["queued", "blocked"].includes(n.status),
        )
        .map((n) => (
          <p key={n.id} className="mt-2 text-muted-foreground">
            사용량 제한 대기 · {n.title} · {new Date(n.usageRecovery!.resumeAt).toLocaleString()}{" "}
            이후 재개 ({n.usageRecovery!.count}/3)
          </p>
        ))}
      {open && <Mailbox {...props} />}
    </section>
  );
}
function Mailbox({ environmentId, run }: { environmentId: EnvironmentId; run: Run }) {
  const lookup = { projectId: run.projectId, runId: run.id };
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workspaceAgentControl({ environmentId, input: lookup }),
  );
  const action = useAtomCommand(orchestrationEnvironment.actOnAgentControl, {
    reportFailure: false,
  });
  const [text, setText] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [confirmRetry, setConfirmRetry] = useState<string | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const live = run.status === "running" || run.status === "queued";
  const targets =
    run.graph?.nodes.filter(
      (n) => !["completed", "failed", "cancelled", "skipped"].includes(n.status),
    ) ?? [];
  const destination = targets.find((n) => n.id === target)?.id ?? targets[0]?.id;
  const mutate = async (input: WorkspaceAgentControlAction) => {
    setBusy(true);
    try {
      const receipt = await action({ environmentId, input });
      if (notifyCommandFailure(receipt, "메시지 처리 실패")) return false;
      result.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!destination || !text.trim()) return;
    const key = destination + ":" + text.trim();
    if (request.current?.key !== key) request.current = { key, id: randomUUID() };
    if (
      await mutate({
        ...lookup,
        action: "send",
        requestId: request.current.id,
        toNodeId: destination,
        text: text.trim(),
      })
    ) {
      setText("");
      request.current = null;
    }
  };
  return (
    <div className="mt-3 space-y-3">
      <p className="text-muted-foreground">
        대기 메시지는 다음 작업 입력에 포함됩니다. 실행 중인 AI는 메시지함 도구로 새 메시지를 확인할
        수 있습니다. 제공자 수락과 작업자 확인은 따로 표시합니다.
      </p>
      {live && targets.length > 0 && (
        <div className="space-y-2">
          <label className="block">
            받는 작업
            <select
              aria-label="메시지 받을 작업"
              className={INPUT}
              value={destination}
              onChange={(e) => setTarget(e.currentTarget.value)}
              disabled={busy}
            >
              {targets.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title} · {n.id}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label="작업자 메시지"
            placeholder="작업자에게 전달할 내용을 입력하세요"
            rows={3}
            maxLength={8000}
            className={INPUT}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            disabled={busy}
          />
          <Button size="xs" onClick={() => void send()} disabled={busy || !text.trim()}>
            메시지 전송
          </Button>
        </div>
      )}
      {result.error && (
        <p role="alert" className="text-destructive">
          {result.error}
        </p>
      )}
      {result.data?.records.length === 0 && (
        <p className="text-muted-foreground">
          아직 메시지나 새 인계 기록이 없습니다. 업그레이드 이후 시작한 작업부터 실제 입력이
          보존됩니다.
        </p>
      )}
      <div className="max-h-96 space-y-2 overflow-auto">
        {result.data?.records.toReversed().map((record) => (
          <article
            key={record.id}
            className="space-y-1 rounded-md border border-border p-2"
            data-agent-record={record.recordType}
          >
            <p className="font-semibold">{record.title}</p>
            <p
              className={record.status === "unknown" ? "text-destructive" : "text-muted-foreground"}
            >
              {agentControlStatusLabels[record.status]} · {record.toNodeId ?? "실행 보고"}
            </p>
            <p className="whitespace-pre-wrap break-words">{record.text}</p>
            {record.recordType === "handoff" && (
              <>
                <p className="break-all text-muted-foreground">
                  {record.model} · {record.providerInstanceId} ·{" "}
                  {record.sourceChars?.toLocaleString()}자 · SHA-256 {record.sourceHash}
                </p>
                <Button size="xs" variant="outline" onClick={() => setEvidence(record.id)}>
                  실제 입력 원문
                </Button>
              </>
            )}
            {live &&
              record.recordType === "message" &&
              ["queued", "unknown"].includes(record.status) && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void mutate({
                        ...lookup,
                        action: "cancel",
                        recordId: record.id,
                        expectedRevision: record.revision,
                      })
                    }
                  >
                    메시지 취소
                  </Button>
                  {record.status === "unknown" && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirmRetry(record.id)}
                    >
                      재전송 선택
                    </Button>
                  )}
                  {confirmRetry === record.id && (
                    <div role="alert" className="space-y-1">
                      <p>이미 전달됐을 수 있습니다. 같은 내용을 다시 대기열에 넣을까요?</p>
                      <Button
                        size="xs"
                        disabled={busy}
                        onClick={() =>
                          void mutate({
                            ...lookup,
                            action: "requeue",
                            recordId: record.id,
                            expectedRevision: record.revision,
                          }).then((ok) => {
                            if (ok) setConfirmRetry(null);
                          })
                        }
                      >
                        중복 가능성을 확인하고 재전송
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirmRetry(null)}>
                        닫기
                      </Button>
                    </div>
                  )}
                </div>
              )}
          </article>
        ))}
      </div>
      {result.data && result.data.total > result.data.records.length && (
        <p className="text-muted-foreground">
          최근 {result.data.records.length}개 표시 · 전체 {result.data.total}개 기록 보존
        </p>
      )}
      <Button size="xs" variant="ghost" onClick={result.refresh}>
        기록 새로고침
      </Button>
      {evidence && (
        <InputEvidence
          environmentId={environmentId}
          run={run}
          recordId={evidence}
          close={() => setEvidence(null)}
        />
      )}
    </div>
  );
}
function InputEvidence({
  environmentId,
  run,
  recordId,
  close,
}: {
  environmentId: EnvironmentId;
  run: Run;
  recordId: string;
  close: () => void;
}) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.agentControlEvidence({
      environmentId,
      input: { projectId: run.projectId, runId: run.id, recordId },
    }),
  );
  const [copyError, setCopyError] = useState<string | null>(null);
  const copy = async () => {
    try {
      if (result.data) {
        await navigator.clipboard.writeText(result.data.text);
        notifySuccess("인계 입력 원문을 복사했습니다.");
      }
    } catch {
      setCopyError("클립보드에 접근하지 못했습니다. 원문 선택 또는 TXT 다운로드를 사용하세요.");
    }
  };
  const download = () => {
    if (!result.data) return;
    const url = URL.createObjectURL(
      new Blob([result.data.text], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "orchestra-input-" + recordId.slice(0, 12) + ".txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="w-full max-w-4xl" initialFocus={false}>
        <DialogHeader>
          <DialogTitle>실제 인계 입력</DialogTitle>
          <DialogDescription>
            앱이 제공자 CLI에 전달한 작업 입력입니다. 제공자가 별도로 붙인 시스템 지시나 내부 처리
            내용은 포함되지 않습니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-6">
          {result.error && (
            <p role="alert" className="text-sm text-destructive">
              {result.error}
            </p>
          )}
          {copyError && <p role="alert">{copyError}</p>}
          {result.data && (
            <>
              <p className="break-all text-xs">
                SHA-256 {result.data.record.sourceHash} · {result.data.text.length.toLocaleString()}
                자
              </p>
              <div className="flex gap-2">
                <Button size="xs" onClick={() => void copy()}>
                  원문 전체 복사
                </Button>
                <Button size="xs" variant="outline" onClick={download}>
                  TXT 다운로드
                </Button>
              </div>
              <pre
                className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs"
                data-input-evidence
              >
                {result.data.text}
              </pre>
            </>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
