import { useState, type FormEvent } from "react";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import {
  resolveAssistantProfile,
  type ThreadAssistantProfile as Profile,
} from "@t3tools/contracts/settings";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { notifyCommandFailure } from "../control-center/controlCenterShared";
import { ThreadAssistantComputer } from "./ThreadAssistantComputer";

const blank: Profile = { name: "", instructions: "" };
const fieldClass = "rounded border border-border bg-background px-2 py-1 text-foreground";
function profileFields(value: Profile, change: (v: Profile) => void) {
  return (
    <>
      <label className="flex flex-col gap-1">
        이름
        <input
          className={fieldClass}
          value={value.name}
          onChange={(e) => change({ ...value, name: e.currentTarget.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        역할과 말투
        <textarea
          className={`min-h-20 ${fieldClass}`}
          value={value.instructions}
          onChange={(e) => change({ ...value, instructions: e.currentTarget.value })}
        />
      </label>
    </>
  );
}
const saveClass = "self-start rounded border border-border px-3 py-1";

type CustomDraft = Profile & { mode: "global" | "custom"; key: string };
export function ThreadAssistantProfile(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  computerAvailable: boolean;
}) {
  const profiles = useEnvironmentSettings(props.environmentId, (s) => s.threadAssistantProfiles);
  const saved = profiles[props.threadId],
    key = `${props.environmentId}/${props.threadId}`;
  const [draft, setDraft] = useState<CustomDraft | null>(null);
  const [pending, setPending] = useState(false);
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const values =
    draft?.key === key
      ? draft
      : {
          key,
          name: saved?.name ?? "",
          instructions: saved?.instructions ?? "",
          mode: saved?.mode ?? (saved ? ("custom" as const) : ("global" as const)),
        };
  const active = resolveAssistantProfile(saved);
  const others = Object.entries(profiles).filter(
    ([id, p]) => id !== props.threadId && (p.name.trim() || p.instructions.trim()),
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      const { mode, name, instructions } = values;
      const result = await save({
        environmentId: props.environmentId,
        input: {
          patch: { threadAssistantProfiles: { [props.threadId]: { mode, name, instructions } } },
        },
      });
      if (!notifyCommandFailure(result, "비서 설정을 저장하지 못했습니다.")) setDraft(null);
    } finally {
      setPending(false);
    }
  }
  return (
    <details className="relative z-10 max-h-[40vh] overflow-y-auto border-b border-border px-4 py-1.5 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        비서 설정{active?.name.trim() ? ` · ${active.name}` : ""}
      </summary>
      <form className="mt-2 max-w-xl" onSubmit={(e) => void submit(e)}>
        <fieldset className="flex flex-col gap-2" disabled={pending}>
          <label className="flex flex-col gap-1">
            역할 적용 범위
            <select
              aria-label="역할 적용 범위"
              className={fieldClass}
              value={values.mode}
              onChange={(e) =>
                setDraft({
                  ...values,
                  mode: e.currentTarget.value === "custom" ? "custom" : "global",
                })
              }
            >
              <option value="global">전역 답변 스타일 사용</option>
              <option value="custom">이 대화에서 직접 설정</option>
            </select>
          </label>
          {values.mode === "global" ? (
            <p className="whitespace-pre-wrap text-muted-foreground">
              이 대화는 전역 답변 스타일을 따릅니다. 전역 답변 스타일은 설정의 전역 모델 설정에서
              바꿉니다.
            </p>
          ) : (
            <>
              {others.length > 0 ? (
                <label className="flex flex-col gap-1">
                  다른 대화의 사용자 지정 역할 가져오기
                  <select
                    aria-label="다른 대화의 역할 가져오기"
                    className={fieldClass}
                    value=""
                    onChange={(e) => {
                      const p = profiles[e.currentTarget.value];
                      if (p) setDraft({ ...values, name: p.name, instructions: p.instructions });
                    }}
                  >
                    <option value="">비서 선택</option>
                    {others.map(([id, p]) => (
                      <option key={id} value={id}>
                        {p.name || "비서"} · {id.slice(-6)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {profileFields(values, (p) => setDraft({ ...values, ...p }))}
            </>
          )}
          <p className="text-muted-foreground">
            저장한 역할은 다음 요청부터 적용됩니다. 현재 입력한 지시가 우선합니다.
          </p>
          <button className={saveClass} type="submit" disabled={draft?.key !== key}>
            {pending ? "저장 중…" : "저장"}
          </button>
        </fieldset>
      </form>
      {props.computerAvailable ? (
        <ThreadAssistantComputer environmentId={props.environmentId} threadId={props.threadId} />
      ) : (
        <p className="mt-2 text-muted-foreground">
          비서 컴퓨터는 첫 메시지를 보낸 뒤 만들 수 있습니다.
        </p>
      )}
    </details>
  );
}
