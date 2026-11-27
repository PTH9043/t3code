import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  handoffDescription,
  handoffMeasurementNote,
  handoffReportText,
  latestHandoffReport,
} from "@t3tools/client-runtime/state/conversation-handoff";
import { useMemo, useState } from "react";
import {
  latestInputComposition,
  inputCompositionText,
} from "@t3tools/client-runtime/state/token-usage";
import { useThreadActivities, useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

export function HandoffSettings(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  busy: boolean;
}) {
  const ref = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const thread = useThreadShell(ref);
  const activities = useThreadActivities(ref);
  const latest = useMemo(() => latestHandoffReport(activities), [activities]);
  const latestInput = useMemo(() => latestInputComposition(activities), [activities]);
  const update = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  return (
    <section className="space-y-2 border-t pt-3">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={thread?.handoffMode === "compact"}
          disabled={saving || props.busy || thread?.handoffMode === undefined}
          onChange={(event) => {
            setSaving(true);
            setError(false);
            void update({
              environmentId: props.environmentId,
              input: {
                threadId: props.threadId,
                handoffMode: event.target.checked ? "compact" : "standard",
              },
            })
              .then((result) => setError(result._tag === "Failure"))
              .finally(() => setSaving(false));
          }}
        />
        <strong>{saving ? "저장 중…" : "이 대화의 인계 문맥 절약"}</strong>
      </label>
      <p className="text-muted-foreground">{handoffDescription}</p>
      <p className="text-muted-foreground">해제하면 다음 인계부터 기존 방식으로 돌아갑니다.</p>
      {thread?.handoffMode === undefined ? <p>서버의 지원 여부를 확인할 수 없습니다.</p> : null}
      {props.busy ? <p>작업이 끝난 뒤 설정을 바꿀 수 있습니다.</p> : null}
      {error ? (
        <p role="alert" className="text-destructive">
          설정을 저장하지 못했습니다. 연결·권한을 확인하고 다시 시도하세요.
        </p>
      ) : null}
      {latest ? (
        <>
          <p>최근 인계 비교 · {new Date(latest.createdAt).toLocaleString("ko-KR")}</p>
          <p>{handoffReportText(latest.report)}</p>
        </>
      ) : (
        <p>현재 불러온 기록에 인계 비교가 없습니다.</p>
      )}
      <p className="text-muted-foreground">{handoffMeasurementNote}</p>
      {latestInput ? (
        <p className="border-t pt-2">{inputCompositionText(latestInput.report)}</p>
      ) : null}
    </section>
  );
}
