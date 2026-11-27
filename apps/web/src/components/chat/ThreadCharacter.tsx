import { lazy, Suspense, useState } from "react";
import type { EnvironmentId, ThreadCharacter as CharacterKind, ThreadId } from "@t3tools/contracts";
import type { AvatarAffectDirective } from "@t3tools/shared/livingPersonaAvatarBridge";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { notifyCommandFailure } from "../control-center/controlCenterShared";
import type { AssistantPresenceStore } from "../../assistantPresenceStore";
import { AgustinaCharacter } from "./AgustinaCharacter";

const VrmCharacter = lazy(() => import("./VrmCharacter"));
const Live2DCharacter = lazy(() => import("./Live2DCharacter"));
const LivLivCharacter = lazy(() => import("./LivLivCharacter"));
const ASSETS = "/agent-characters";

/** A character belongs to one conversation and does not affect the provider or its permissions. */
export function ThreadCharacter(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  isWorking: boolean;
  isSpeaking?: boolean;
  affectDirective?: AvatarAffectDirective;
  presenceStore?: AssistantPresenceStore;
  customAvatarUrl?: string | null;
  idlePowerSave30Fps?: boolean;
  settingsMode?: boolean;
  /** A shared desktop character can be displayed without changing the thread setting. */
  characterOverride?: CharacterKind;
  size?: number;
}) {
  const selected = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.threadCharacters[props.threadId] ?? "off",
  );
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState<CharacterKind | null>(null);
  const [failedCharacter, setFailedCharacter] = useState<CharacterKind | null>(null);
  const choice = props.characterOverride ?? pending ?? selected;
  const select = async (next: CharacterKind) => {
    setFailedCharacter(null);
    setPending(next);
    try {
      const result = await save({
        environmentId: props.environmentId,
        input: { patch: { threadCharacters: { [props.threadId]: next } } },
      });
      notifyCommandFailure(result, "캐릭터 설정을 저장하지 못했습니다.");
    } finally {
      setPending(null);
    }
  };
  if (!props.settingsMode && choice === "off") return null;
  return (
    <section
      className="flex items-center gap-3 border-b border-border px-4 py-1.5"
      aria-label="대화 캐릭터"
    >
      {props.settingsMode ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          캐릭터
          <select
            aria-label="대화 캐릭터 선택"
            value={choice}
            disabled={pending !== null}
            onChange={(event) => void select(event.currentTarget.value as CharacterKind)}
            className="rounded border border-border bg-background px-2 py-1 text-foreground"
          >
            <option value="off">표시 안 함</option>
            <option value="type95">1번 · 95식</option>
            <option value="k2">2번 · K2</option>
            <option value="ots14">3번 · OTs-14</option>
            <option value="agustina">2D Agustina (수영복)</option>
            <option value="pixel">2D 픽셀 캐릭터 (Discrete Sprite Lab)</option>
            <option value="livliv">2.5D LivLiv 캐릭터</option>
            <option value="vrm">3D Polybot</option>
          </select>
        </label>
      ) : null}
      {choice === "pixel" ? (
        <picture aria-label={props.isWorking ? "캐릭터가 작업 중입니다" : "캐릭터가 대기 중입니다"}>
          {props.isWorking ? (
            <source media="(prefers-reduced-motion: reduce)" srcSet={`${ASSETS}/pixel-idle.png`} />
          ) : null}
          <img
            src={`${ASSETS}/${props.isWorking ? "pixel-working.gif" : "pixel-idle.png"}`}
            alt=""
            width={64}
            height={64}
            className="h-16 w-16 object-contain [image-rendering:pixelated]"
          />
        </picture>
      ) : null}
      {choice === "agustina" ? <AgustinaCharacter isWorking={props.isWorking} /> : null}
      {choice === "type95" || choice === "k2" || choice === "ots14" ? (
        <span className="flex flex-col items-center gap-1">
          {(() => {
            const preview = (
              <span className="text-xs text-muted-foreground">캐릭터 불러오는 중…</span>
            );
            return failedCharacter === choice ? (
              <>
                <span className="text-xs text-muted-foreground">
                  Live2D 캐릭터를 불러오지 못했습니다.
                </span>
              </>
            ) : (
              <Suspense fallback={preview}>
                <Live2DCharacter
                  key={choice}
                  character={choice}
                  isWorking={props.isWorking}
                  {...(props.presenceStore ? { presenceStore: props.presenceStore } : {})}
                  {...(props.customAvatarUrl !== undefined
                    ? { customModelUrl: props.customAvatarUrl }
                    : {})}
                  {...(props.idlePowerSave30Fps !== undefined
                    ? { idlePowerSave30Fps: props.idlePowerSave30Fps }
                    : {})}
                  {...(props.size !== undefined ? { size: props.size } : {})}
                  onError={() => setFailedCharacter(choice)}
                />
              </Suspense>
            );
          })()}
        </span>
      ) : null}
      {choice === "livliv" ? (
        <Suspense
          fallback={<span className="text-xs text-muted-foreground">2.5D 캐릭터 불러오는 중…</span>}
        >
          <LivLivCharacter
            isWorking={props.isWorking}
            {...(props.isSpeaking !== undefined ? { isSpeaking: props.isSpeaking } : {})}
            {...(props.affectDirective ? { affectDirective: props.affectDirective } : {})}
            {...(props.presenceStore ? { presenceStore: props.presenceStore } : {})}
            {...(props.customAvatarUrl ? { modelUrl: props.customAvatarUrl } : {})}
            {...(props.size !== undefined ? { size: props.size } : {})}
          />
        </Suspense>
      ) : null}
      {choice === "vrm" ? (
        <Suspense
          fallback={<span className="text-xs text-muted-foreground">캐릭터 불러오는 중…</span>}
        >
          <VrmCharacter
            isWorking={props.isWorking}
            {...(props.presenceStore ? { presenceStore: props.presenceStore } : {})}
            {...(props.customAvatarUrl !== undefined
              ? { customModelUrl: props.customAvatarUrl }
              : {})}
            {...(props.idlePowerSave30Fps !== undefined
              ? { idlePowerSave30Fps: props.idlePowerSave30Fps }
              : {})}
            {...(props.size !== undefined ? { size: props.size } : {})}
          />
        </Suspense>
      ) : null}
      {choice !== "off" ? (
        <span className="text-xs text-muted-foreground">
          {props.isWorking ? "작업 중" : "대기 중"}
        </span>
      ) : null}
    </section>
  );
}
