import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_ASSISTANT_AUDIO_SETTINGS,
  resolveActivePersonaId,
  resolveEffectiveGlobalAssistant,
  type AssistantAudioSettings,
  type AssistantProactiveBriefingPayload,
} from "@t3tools/contracts";
import { inferOutOfBandExpression } from "@t3tools/shared/assistantPresenceController";
import { resolveAvatarAffectDirective } from "@t3tools/shared/livingPersonaAvatarBridge";
import { classifySituationMode } from "@t3tools/shared/livingPersonaCompiler";
import {
  DesktopUiChannelTransport,
  ProactivePresenceController,
} from "@t3tools/shared/proactivePresence";
import { useEffect, useMemo, useRef, useState } from "react";
import { createAssistantPresenceStore } from "../assistantPresenceStore";
import { useDesktopAssistant } from "../hooks/useDesktopAssistant";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { newMessageId } from "../lib/utils";
import { readPendingVoice, writePendingVoice } from "../assistantVoiceFlow";
import {
  useListedThreadShells,
  useProjects,
  useThreadDetail,
  useThreadMessages,
  useThreadSession,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { resolveThreadSyncPhase } from "../threadSync";
import { RealtimeVoiceOrchestrator } from "../voice/RealtimeVoiceOrchestrator";
import ChatView from "./ChatView";
import { ThreadCharacter } from "./chat/ThreadCharacter";
import { AssistantVoice, type AssistantVoiceInterruptHandle } from "./chat/AssistantVoice";
import { AssistantVoiceInput } from "./chat/AssistantVoiceInput";
import { useComposerDraftStore } from "../composerDraftStore";
import { SidebarProvider } from "./ui/sidebar";

function Conversation({
  environmentId,
  threadId,
  character,
  fallbackModelSelection,
  voiceSendMode,
  idlePowerSave30Fps,
  customAvatarUrl,
  audioSettings,
}: {
  environmentId: import("@t3tools/contracts").EnvironmentId;
  threadId: import("@t3tools/contracts").ThreadId;
  character: import("@t3tools/contracts").ThreadCharacter;
  fallbackModelSelection?: import("@t3tools/contracts").ModelSelection | null | undefined;
  voiceSendMode: "confirm" | "auto";
  idlePowerSave30Fps: boolean;
  customAvatarUrl?: string | null | undefined;
  audioSettings: AssistantAudioSettings;
}) {
  const envSettings = useEnvironmentSettings(environmentId);
  const effectiveGlobal = resolveEffectiveGlobalAssistant(envSettings);
  const globalDefaultModel = effectiveGlobal?.defaultModelSelection ?? null;
  const activePersonaId = resolveActivePersonaId(effectiveGlobal);
  const voiceStorageKey = `t3code:assistant-voice-pending:${environmentId}:${threadId}`;
  const [isVoiceSpeaking, setIsVoiceSpeaking] = useState(false);
  const [vadListening, setVadListening] = useState(false);
  const [proactiveBriefing, setProactiveBriefing] =
    useState<AssistantProactiveBriefingPayload | null>(null);
  const [voiceRequest, setVoiceRequest] = useState<{ id: string; text: string } | undefined>();
  const [pendingVoice, setPendingVoice] = useState<
    Array<{ id: string; text: string; reason: string }>
  >(() => {
    return readPendingVoice(localStorage, voiceStorageKey);
  });
  const pendingVoiceRef = useRef(pendingVoice);
  const pendingStorageHealthy = useRef(true);
  const voiceInFlight = useRef(false);
  const voiceInterruptRef = useRef<AssistantVoiceInterruptHandle | null>(null);

  const presenceStore = useMemo(
    () => createAssistantPresenceStore(activePersonaId),
    [activePersonaId],
  );
  const proactiveController = useMemo(
    () =>
      new ProactivePresenceController({
        enabled: audioSettings.proactiveBriefingEnabled,
        cooldownMs: Math.max(1, audioSettings.proactiveCooldownMinutes) * 60_000,
      }),
    [audioSettings.proactiveBriefingEnabled, audioSettings.proactiveCooldownMinutes],
  );

  const updatePendingVoice = (
    update: (current: typeof pendingVoice) => typeof pendingVoice,
  ): boolean => {
    let current = pendingVoiceRef.current;
    if (pendingStorageHealthy.current) {
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(voiceStorageKey) ?? "[]");
        if (Array.isArray(stored)) current = stored;
      } catch {
        pendingStorageHealthy.current = false;
      }
    }
    const next = update(current);
    const persisted = writePendingVoice(localStorage, voiceStorageKey, next);
    pendingStorageHealthy.current = persisted;
    pendingVoiceRef.current = next;
    setPendingVoice(next);
    return persisted;
  };
  const ref = scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(ref);
  const detail = useThreadDetail(ref);
  const messages = useThreadMessages(ref);
  const latestAssistantMessage = messages.findLast((message) => message.role === "assistant");
  const lastAssistantText =
    messages.findLast((message) => message.role === "assistant" && !message.streaming)?.text ?? "";
  const streamingAssistantText = latestAssistantMessage?.text ?? lastAssistantText;
  const lastUserText = messages.findLast((message) => message.role === "user")?.text ?? "";
  const status = useThreadStatus(ref);
  const session = useThreadSession(ref);
  const isWorking = session?.status === "running" || session?.status === "starting";
  const hasBgTasks = (shell?.backgroundTasks?.length ?? 0) > 0;

  const situationMode = classifySituationMode({
    text: lastUserText,
    localHour: new Date().getHours(),
  });
  const affectDirective = resolveAvatarAffectDirective({
    p: 0.25,
    a: isWorking ? 0.3 : 0.05,
    d: 0.35,
    situationMode,
  });

  const interactionMode = isVoiceSpeaking
    ? "speaking"
    : vadListening
      ? "listening"
      : situationMode === "INCIDENT_RESPONSE" || situationMode === "SUNK_COST_BRAKE"
        ? "alert_brake"
        : isWorking
          ? "thinking"
          : hasBgTasks
            ? "working_bg"
            : "idle";

  // Non-invasive Out-of-Band streaming expression inference (no inline [joy] bracket tags).
  const outOfBand = inferOutOfBandExpression({
    situation: situationMode,
    mode: interactionMode,
    streamingText: streamingAssistantText,
    baseExpression: affectDirective.canonicalExpression,
  });

  useEffect(() => {
    presenceStore.setSemanticState({
      personaId: activePersonaId,
      isWorking,
      mode: outOfBand.mode,
      situation: situationMode,
      expression: outOfBand.expression,
      expressionWeight: outOfBand.expressionWeight,
    });
  }, [
    activePersonaId,
    isWorking,
    outOfBand.expression,
    outOfBand.expressionWeight,
    outOfBand.mode,
    presenceStore,
    situationMode,
  ]);

  // Passive pointer tracking -> zero-rerender gaze target update for Live2D/VRM.
  useEffect(() => {
    let scheduled = false;
    let latestX = 0;
    let latestY = 0;
    const onPointerMove = (event: PointerEvent) => {
      const w = Math.max(window.innerWidth, 1);
      const h = Math.max(window.innerHeight, 1);
      latestX = (event.clientX / w) * 2 - 1;
      latestY = -((event.clientY / h) * 2 - 1);
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        presenceStore.setGazeTarget({ x: latestX, y: latestY, source: "cursor" });
      });
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [presenceStore]);

  // Optional hands-free VAD barge-in watcher (<=80ms audio stop on user speech start).
  useEffect(() => {
    if (!audioSettings.handsFreeVad) {
      setVadListening(false);
      return;
    }
    const vadRunner = new RealtimeVoiceOrchestrator({
      presenceStore,
      audioSettings,
      onBargeIn: () => {
        voiceInterruptRef.current?.interruptNow("barge_in");
      },
    });
    let cancelled = false;
    void vadRunner
      .startHandsFreeVad({
        onSpeechStart: () => {
          if (!cancelled) setVadListening(true);
          voiceInterruptRef.current?.interruptNow("barge_in");
        },
        onSpeechEnd: () => {
          if (!cancelled) setVadListening(false);
        },
      })
      .then((res) => {
        if (!res.active && !cancelled) setVadListening(false);
      });
    return () => {
      cancelled = true;
      vadRunner.dispose();
    };
  }, [audioSettings, presenceStore]);

  // Proactive presence briefing observer for UnifiedBgTask completion / STALLED alerts.
  useEffect(() => {
    const tasks = shell?.backgroundTasks ?? [];
    const decision = proactiveController.observeBackgroundTasks({
      personaId: activePersonaId,
      tasks,
      situation: situationMode,
      nowMs: Date.now(),
    });
    if (!decision.shouldNotify || !decision.payload) return;
    const transport = new DesktopUiChannelTransport((payload) => {
      setProactiveBriefing(payload);
      if (payload.speakAloud && audioSettings.proactiveBriefingEnabled && !isVoiceSpeaking) {
        voiceInterruptRef.current?.speakProactiveText(payload.summaryText);
      }
    });
    void transport.sendProactiveBriefing(decision.payload);
  }, [
    activePersonaId,
    audioSettings.proactiveBriefingEnabled,
    isVoiceSpeaking,
    proactiveController,
    shell?.backgroundTasks,
    situationMode,
  ]);

  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: detail !== null,
    shellExists: shell !== null,
    status,
  });
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside
        className="flex w-36 shrink-0 flex-col items-center justify-center gap-1 border-r border-border sm:w-48"
        aria-label="모니터 비서 캐릭터"
        data-avatar-expression={outOfBand.expression}
        data-avatar-mode={outOfBand.mode}
      >
        <ThreadCharacter
          environmentId={environmentId}
          threadId={threadId}
          isWorking={isWorking}
          isSpeaking={isVoiceSpeaking}
          affectDirective={affectDirective}
          presenceStore={presenceStore}
          customAvatarUrl={customAvatarUrl ?? null}
          idlePowerSave30Fps={idlePowerSave30Fps}
          characterOverride={character}
          size={160}
        />
        <span className="text-[11px] text-muted-foreground">{affectDirective.statusLabel}</span>
        {proactiveBriefing ? (
          <div
            role="status"
            className="mx-2 mt-1 rounded border border-border/70 bg-muted/40 p-1.5 text-[10px] leading-snug text-foreground"
          >
            <p>{proactiveBriefing.summaryText}</p>
            <button
              type="button"
              className="mt-1 text-[10px] underline text-muted-foreground"
              onClick={() => setProactiveBriefing(null)}
            >
              닫기
            </button>
          </div>
        ) : null}
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AssistantVoice
          text={lastAssistantText}
          prosody={{
            rate: affectDirective.voiceProsody.rate * outOfBand.prosodyDelta.rate,
            pitch: affectDirective.voiceProsody.pitch * outOfBand.prosodyDelta.pitch,
          }}
          isDelegatedWorking={isWorking || hasBgTasks}
          onSpeakingChange={setIsVoiceSpeaking}
          presenceStore={presenceStore}
          audioSettings={audioSettings}
          interruptRef={voiceInterruptRef}
        />
        <AssistantVoiceInput
          text={lastAssistantText}
          sendMode={voiceSendMode}
          onBargeIn={() => voiceInterruptRef.current?.interruptNow("barge_in")}
          onTranscript={(transcript) => {
            if (voiceSendMode === "auto") {
              const id = newMessageId();
              const reason = voiceInFlight.current
                ? "다른 음성 전송 중입니다. 확인한 뒤 다시 보내세요."
                : "자동 전송을 시도합니다.";
              const persisted = updatePendingVoice((current) => [
                ...current,
                { id, text: transcript, reason },
              ]);
              if (persisted && !voiceInFlight.current) {
                voiceInFlight.current = true;
                setVoiceRequest({ id, text: transcript });
              } else if (!persisted) {
                updatePendingVoice((current) =>
                  current.map((entry) =>
                    entry.id === id
                      ? {
                          ...entry,
                          reason:
                            "전사를 저장하지 못해 자동 전송하지 않았습니다. 작성란에 추가하세요.",
                        }
                      : entry,
                  ),
                );
              }
              return;
            }
            const store = useComposerDraftStore.getState();
            const current = store.getComposerDraft(ref)?.prompt ?? "";
            store.setPrompt(ref, current ? `${current}\n${transcript}` : transcript);
          }}
        />
        {pendingVoice.map((pending) => (
          <div key={pending.id} role="status" className="border-b border-border p-2 text-xs">
            <p>{pending.reason}</p>
            <p>{pending.text}</p>
            <button
              type="button"
              className="rounded border px-2 py-1"
              disabled={Boolean(voiceRequest)}
              onClick={() => {
                if (voiceInFlight.current) return;
                const id = newMessageId();
                const persisted = updatePendingVoice((current) =>
                  current.map((entry) =>
                    entry.id === pending.id
                      ? { ...entry, id, reason: "자동 전송을 다시 시도합니다." }
                      : entry,
                  ),
                );
                if (persisted) {
                  voiceInFlight.current = true;
                  setVoiceRequest({ id, text: pending.text });
                }
              }}
            >
              다시 보내기
            </button>{" "}
            <button
              type="button"
              className="rounded border px-2 py-1"
              disabled={Boolean(voiceRequest)}
              onClick={() => {
                const store = useComposerDraftStore.getState();
                const current = store.getComposerDraft(ref)?.prompt ?? "";
                store.setPrompt(ref, current ? `${current}\n${pending.text}` : pending.text);
                updatePendingVoice((current) => current.filter((entry) => entry.id !== pending.id));
              }}
            >
              작성란에 추가
            </button>{" "}
            <button
              type="button"
              className="rounded border px-2 py-1"
              disabled={Boolean(voiceRequest)}
              onClick={() =>
                updatePendingVoice((current) => current.filter((entry) => entry.id !== pending.id))
              }
            >
              전사 삭제
            </button>
          </div>
        ))}
        {shell ? (
          <ChatView
            environmentId={environmentId}
            threadId={threadId}
            routeKind="server"
            threadSyncPhase={threadSyncPhase}
            desktopAssistantCharacter={character}
            {...((globalDefaultModel ?? fallbackModelSelection)
              ? { desktopAssistantModelSelection: (globalDefaultModel ?? fallbackModelSelection)! }
              : {})}
            {...(voiceRequest ? { desktopAssistantVoiceRequest: voiceRequest } : {})}
            onDesktopAssistantVoiceHandled={(id, outcome) => {
              voiceInFlight.current = false;
              setVoiceRequest((current) => (current?.id === id ? undefined : current));
              updatePendingVoice((current) =>
                outcome === "sent"
                  ? current.filter((entry) => entry.id !== id)
                  : current.map((entry) =>
                      entry.id === id
                        ? {
                            ...entry,
                            reason:
                              outcome === "unknown"
                                ? "전송 수락 여부를 확인하지 못했습니다. 중복을 피하려면 대화 내역을 확인한 뒤 다시 보내세요."
                                : "현재 작업·질문 또는 연결 상태로 전송하지 못했습니다. 확인한 뒤 다시 보내세요.",
                          }
                        : entry,
                    ),
              );
            }}
            hideCharacter
            reserveTitleBarControlInset={false}
          />
        ) : (
          <p className="p-4 text-sm">선택한 대화를 불러오는 중입니다.</p>
        )}
      </main>
    </div>
  );
}

/** Uses the same conversation stream and composer as the main window. */
export function DesktopAssistantView() {
  const assistant = useDesktopAssistant();
  const threads = useListedThreadShells();
  const projects = useProjects();
  const selected = assistant.settings?.conversation;
  const selectedIndex = threads.findIndex(
    (thread) =>
      thread.environmentId === selected?.environmentId && thread.id === selected?.threadId,
  );
  return (
    <SidebarProvider defaultOpen={false} className="h-dvh! min-h-0!">
      <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
          <label htmlFor="monitor-conversation" className="shrink-0">
            연결 대화
          </label>
          <select
            id="monitor-conversation"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
            value={selectedIndex < 0 ? "" : String(selectedIndex)}
            onChange={(event) => {
              const thread =
                event.currentTarget.value === ""
                  ? undefined
                  : threads[Number(event.currentTarget.value)];
              if (thread)
                void assistant.update({
                  conversation: { environmentId: thread.environmentId, threadId: thread.id },
                });
            }}
          >
            <option value="">대화를 선택하세요</option>
            {threads.map((thread, index) => (
              <option key={`${thread.environmentId}:${thread.id}`} value={String(index)}>
                {projects.find(
                  (project) =>
                    project.environmentId === thread.environmentId &&
                    project.id === thread.projectId,
                )?.title ?? "프로젝트"}{" "}
                · {thread.title}
              </option>
            ))}
          </select>
        </header>
        {assistant.error ? (
          <p role="alert" className="p-3 text-sm text-destructive">
            {assistant.error}
          </p>
        ) : null}
        {selected && assistant.settings && selectedIndex >= 0 ? (
          <Conversation
            key={`${selected.environmentId}:${selected.threadId}`}
            environmentId={selected.environmentId}
            threadId={selected.threadId}
            character={assistant.settings.character}
            fallbackModelSelection={assistant.settings.modelSelection}
            voiceSendMode={assistant.settings.voiceSendMode ?? "confirm"}
            idlePowerSave30Fps={assistant.settings.idlePowerSave30Fps ?? true}
            customAvatarUrl={assistant.settings.customAvatarUrl ?? null}
            audioSettings={assistant.settings.audio ?? DEFAULT_ASSISTANT_AUDIO_SETTINGS}
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            대화를 선택하면 전역 AI 설정과 해당 대화의 모델·기록을 그대로 사용합니다.
          </p>
        )}
      </div>
    </SidebarProvider>
  );
}
