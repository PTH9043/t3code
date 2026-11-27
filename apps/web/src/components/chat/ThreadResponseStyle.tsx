import { useEffect, useState, type FormEvent } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  isCustomResponseStyle,
  type EnvironmentId,
  type ThreadId,
  type ThreadResponseStyle as ResponseStyle,
} from "@t3tools/contracts";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { notifyCommandFailure, notifySuccess } from "../control-center/controlCenterShared";
import { toastManager } from "../ui/toast";

const DEFAULT_STYLE: ResponseStyle = {
  preset: "default",
  tone: "",
  length: "",
  explanation: "",
  instructions: "",
};
const PRESETS: ReadonlyArray<readonly [ResponseStyle["preset"], string]> = [
  ["default", "기본"],
  ["concise", "간결"],
  ["detailed", "상세"],
  ["friendly", "친근"],
  ["professional", "전문"],
];

function sameStyle(left: ResponseStyle, right: ResponseStyle): boolean {
  return (Object.keys(DEFAULT_STYLE) as (keyof ResponseStyle)[]).every(
    (key) => left[key] === right[key],
  );
}

export function ThreadResponseStyle({
  environmentId,
  threadId,
  localDraft,
  onSaving,
}: {
  environmentId: EnvironmentId;
  threadId?: ThreadId;
  localDraft?:
    | { style: ResponseStyle | undefined; save: (style: ResponseStyle) => boolean }
    | undefined;
  onSaving?: (pending: boolean) => void;
}) {
  const styles = useEnvironmentSettings(environmentId, (settings) => settings.threadResponseStyles);
  const globalStyle = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
  )?.globalResponseStyle;
  const global = threadId === undefined;
  const ready = global ? globalStyle !== undefined : Boolean(localDraft || styles);
  const saved =
    (threadId === undefined ? globalStyle : (localDraft?.style ?? styles?.[threadId])) ??
    DEFAULT_STYLE;
  const [draft, setDraft] = useState<ResponseStyle>(saved);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  useEffect(() => {
    if (!dirty) setDraft(saved);
    else if (sameStyle(saved, draft)) setDirty(false);
  }, [saved, dirty, draft]);

  const persist = async (value: ResponseStyle | null) => {
    if (pending || !ready) return;
    setPending(true);
    onSaving?.(true);
    try {
      const patch =
        threadId === undefined
          ? { globalResponseStyle: value }
          : { threadResponseStyles: { [threadId]: value ?? DEFAULT_STYLE } };
      const result = await save({ environmentId, input: { patch } });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "답변 스타일을 저장하지 못했습니다.");
        return;
      }
      const applied =
        threadId === undefined
          ? result.value.globalResponseStyle
          : result.value.threadResponseStyles[threadId];
      const expected = threadId === undefined ? value : (value ?? DEFAULT_STYLE);
      if (expected === null ? applied !== null : !applied || !sameStyle(applied, expected)) {
        toastManager.add({
          type: "error",
          title: "서버에서 답변 스타일 변경을 확인하지 못했습니다.",
        });
        return;
      }
      setDirty(false);
      if (global)
        notifySuccess(
          value === null ? "전역 답변 스타일을 해제했습니다." : "전역 답변 스타일을 저장했습니다.",
        );
    } finally {
      setPending(false);
      onSaving?.(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    if (localDraft) {
      if (localDraft.save(draft)) setDirty(false);
      return;
    }
    await persist(draft);
  };

  const styleLabel = PRESETS.find(([value]) => value === saved.preset)?.[1];
  // A conversation follows the global style until it stores a style that asks for something.
  const roomCustom = !global && isCustomResponseStyle(saved);
  const form = (
    <form className="mt-2 flex max-w-xl flex-col gap-2" onSubmit={(event) => void submit(event)}>
      {!ready ? (
        <p role="status">환경 설정을 불러오는 중입니다. 서버 연결을 확인해 주세요.</p>
      ) : null}
      <fieldset className="flex flex-col gap-2" disabled={!ready || pending}>
        <label className="flex flex-col gap-1">
          프리셋
          <select
            className="rounded border border-border bg-background px-2 py-1 text-foreground"
            value={draft.preset}
            onChange={(event) => {
              setDraft({
                ...draft,
                preset: event.currentTarget.value as ResponseStyle["preset"],
              });
              setDirty(true);
            }}
          >
            {PRESETS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {(
          [
            ["tone", "말투"],
            ["length", "답변 길이"],
            ["explanation", "설명 방식"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex flex-col gap-1">
            {label}
            <input
              className="rounded border border-border bg-background px-2 py-1 text-foreground"
              value={draft[key]}
              onChange={(event) => {
                setDraft({ ...draft, [key]: event.currentTarget.value });
                setDirty(true);
              }}
            />
          </label>
        ))}
        <label className="flex flex-col gap-1">
          자유 지시
          <textarea
            className="min-h-20 rounded border border-border bg-background px-2 py-1 text-foreground"
            value={draft.instructions}
            onChange={(event) => {
              setDraft({ ...draft, instructions: event.currentTarget.value });
              setDirty(true);
            }}
          />
        </label>
        <p className="text-muted-foreground">
          {global
            ? "이 서버의 모든 대화에 다음 요청부터 적용됩니다. 오케스트라에서는 최종 답변에 적용됩니다. 현재 요청에 지정한 형식과 말투가 우선합니다."
            : "이 대화에만 적용됩니다. 저장하면 전역 답변 스타일 대신 이 스타일로 답합니다. 비워 두면 전역 답변 스타일을 따릅니다."}
        </p>
        <button
          className="self-start rounded border border-border px-3 py-1"
          type="submit"
          disabled={!dirty && !(global && globalStyle === null)}
        >
          {pending ? "저장 중…" : "저장"}
        </button>
        {global && globalStyle ? (
          <button
            className="self-start rounded border border-border px-3 py-1"
            type="button"
            onClick={() => void persist(null)}
          >
            전역 스타일 해제
          </button>
        ) : null}
        {!global && roomCustom ? (
          <button
            className="self-start rounded border border-border px-3 py-1"
            type="button"
            onClick={() => {
              if (!localDraft) void persist(null);
              else if (localDraft.save(DEFAULT_STYLE)) setDirty(false);
            }}
          >
            전역 스타일 사용
          </button>
        ) : null}
      </fieldset>
    </form>
  );
  return global ? (
    <section aria-label="전역 답변 스타일" className="border-b border-border px-4 py-2 text-xs">
      <h2 className="font-semibold">
        전역 답변 스타일 · {ready ? (globalStyle ? styleLabel : "미설정") : "불러오는 중"}
      </h2>
      {form}
    </section>
  ) : (
    <details className="relative z-10 max-h-[40vh] overflow-y-auto border-b border-border px-4 py-1.5 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        이 방 답변 스타일 · {roomCustom ? styleLabel : "전역 스타일 사용 중"}
      </summary>
      {form}
    </details>
  );
}
