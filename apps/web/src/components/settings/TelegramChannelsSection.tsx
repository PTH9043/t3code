import { useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  TelegramChannelReference,
  TelegramChannelLookupTitle,
  WS_METHODS,
  type ScopedProjectRef,
  type TelegramChannelCliPolicy,
  type TelegramChannelRegistration,
  type TelegramChannelsManageInput,
  type TelegramChannelsStatusResult,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { KnowledgeDocLink } from "../knowledge/KnowledgeDocLink";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const status = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  tag: WS_METHODS.telegramChannelsStatus,
  label: "telegram:status",
  idleTtlMs: 0,
});
const manage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  tag: WS_METHODS.telegramChannelsManage,
  label: "telegram:manage",
});

const validChannel = Schema.is(TelegramChannelReference);
const validTitle = Schema.is(TelegramChannelLookupTitle);
const selectClass = "h-8 max-w-full rounded-lg border border-input bg-background px-2 text-sm";
const phaseLabels: Record<TelegramChannelRegistration["phase"], string> = {
  queued: "수집 대기 중",
  backfill: "이전 기록 수집 중",
  incremental: "4시간마다 새 글 전부 수집",
  paused: "일시정지됨",
  partial: "일부 기록만 수집됨",
  error: "동기화 실패",
};

type CliModels = TelegramChannelsStatusResult["cliModels"];

function cliKey(model: Pick<TelegramChannelCliPolicy, "instanceId" | "modelId">): string {
  return JSON.stringify([model.instanceId, model.modelId]);
}

export function TelegramCliFallback({
  policy,
  models,
  disabled,
  onSave,
}: {
  policy: TelegramChannelCliPolicy | null;
  models: CliModels;
  disabled: boolean;
  onSave: (policy: TelegramChannelCliPolicy | null) => void;
}) {
  const [selection, setSelection] = useState(policy ? cliKey(policy) : "");
  const [consent, setConsent] = useState(false);
  const selected = models.find((model) => cliKey(model) === selection);
  const saved = policy && models.find((model) => cliKey(model) === cliKey(policy));
  return (
    <details className="mt-2 text-sm">
      <summary className="w-fit cursor-pointer">
        {policy
          ? `대체 CLI · ${saved?.accountLabel ?? policy.instanceId} / ${policy.modelId}`
          : "로컬 재시도 · 대체 CLI 설정"}
      </summary>
      <div className="mt-2 grid max-w-xl gap-2">
        <p className="text-xs text-muted-foreground">
          무료 로컬 모델로 먼저 요약합니다. 로컬 요약이 실패하면 이 채널에서 승인한 CLI 계정과
          모델만 사용합니다. 승인이 없거나 해당 모델을 사용할 수 없으면 로컬에서 다시 시도합니다.
        </p>
        {models.length === 0 ? (
          <p className="text-muted-foreground">
            도구 없이 요약할 수 있는 등록된 CLI 모델이 없습니다.
          </p>
        ) : (
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !selected || !consent) return;
              onSave({
                instanceId: selected.instanceId,
                modelId: selected.modelId,
                allowExternalTransfer: true,
              });
            }}
          >
            <label className="grid gap-1">
              대체 CLI 계정 및 모델
              <select
                className={selectClass}
                value={selected ? selection : ""}
                disabled={disabled}
                onChange={(event) => {
                  setSelection(event.target.value);
                  setConsent(false);
                }}
              >
                <option value="">계정과 모델 선택</option>
                {models.map((model) => (
                  <option key={cliKey(model)} value={cliKey(model)}>
                    {model.accountLabel} ({model.instanceId}) / {model.modelId}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={consent && !!selected}
                disabled={disabled || !selected}
                onChange={(event) => setConsent(event.target.checked)}
              />
              로컬 요약 실패 시 이 채널의 내용을 선택한 CLI 계정과 모델에 전달하여 요약하는 데
              동의합니다.
            </label>
            <Button
              className="w-fit"
              size="sm"
              type="submit"
              disabled={disabled || !selected || !consent}
            >
              채널별 CLI 승인 저장
            </Button>
          </form>
        )}
        {policy && (
          <Button
            className="w-fit"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onSave(null)}
          >
            승인 해제 · 로컬에서만 재시도
          </Button>
        )}
      </div>
    </details>
  );
}

type ManageChannel = (
  input: TelegramChannelsManageInput,
) => Promise<TelegramChannelsStatusResult | null>;

export function TelegramChannelRow({
  project,
  channel,
  models,
  disabled,
  onManage,
}: {
  project: ScopedProjectRef;
  channel: TelegramChannelRegistration;
  models: CliModels;
  disabled: boolean;
  onManage: ManageChannel;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { registrationId, phase } = channel;
  const target = { projectId: project.projectId, registrationId };
  const retry = phase === "error" || phase === "partial";
  return (
    <li className="space-y-2 rounded-xl border border-border px-3 py-3 text-sm">
      <h4 className="break-words font-medium">{channel.channel}</h4>
      <p className="text-muted-foreground">
        {phaseLabels[phase]}
        {channel.fetchedCount !== undefined && ` · 수집 ${channel.fetchedCount.toLocaleString()}건`}
        {channel.totalCount !== undefined && ` / 전체 ${channel.totalCount.toLocaleString()}건`}
        {" · "}RAG 문서에 반영 {channel.processedCount.toLocaleString()}건
        {channel.lastSyncedAt &&
          ` · 마지막 동기화 ${new Date(channel.lastSyncedAt).toLocaleString()}`}
      </p>
      {channel.readThroughId !== undefined && channel.readThroughId > 0 && (
        <p>메시지 ID {channel.readThroughId}까지 읽음</p>
      )}
      {channel.missingTextCount || channel.unavailableCount ? (
        <p>
          본문 없음 {channel.missingTextCount}건 · 접근 불가 {channel.unavailableCount}건
        </p>
      ) : null}
      {channel.error && <p className="text-destructive">{channel.error}</p>}
      {channel.sourceDocumentIds.map((itemId, index) => (
        <KnowledgeDocLink
          key={itemId}
          {...project}
          itemId={itemId}
          className="me-3 text-primary underline"
        >
          RAG 출처 문서{channel.sourceDocumentIds.length > 1 ? ` ${index + 1}` : " 열기"}
        </KnowledgeDocLink>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            void onManage({ ...target, action: phase === "paused" ? "resume" : "pause" })
          }
        >
          {phase === "paused" ? "재개" : "일시정지"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || phase === "paused" || phase === "backfill"}
          onClick={() => void onManage({ ...target, action: retry ? "retry" : "sync" })}
        >
          {retry ? "재시도" : "지금 동기화"}
        </Button>
        {confirmRemove ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={disabled}
              onClick={() => void onManage({ ...target, action: "remove" })}
            >
              이 채널 등록 해제
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setConfirmRemove(false)}
            >
              취소
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setConfirmRemove(true)}
          >
            등록 해제
          </Button>
        )}
      </div>
      <TelegramCliFallback
        key={JSON.stringify(channel.policy)}
        policy={channel.policy}
        models={models}
        disabled={disabled}
        onSave={(policy) => void onManage({ ...target, action: "setPolicy", policy })}
      />
    </li>
  );
}

export function TelegramChannelRegistrationForm({
  projectId,
  disabled,
  onManage,
}: {
  projectId: ScopedProjectRef["projectId"];
  disabled: boolean;
  onManage: ManageChannel;
}) {
  const [byTitle, setByTitle] = useState(false);
  const [text, setText] = useState("");
  const [matches, setMatches] = useState<TelegramChannelsStatusResult["matches"]>();
  const [selectedId, setSelectedId] = useState("");
  const [lookupError, setLookupError] = useState(false);
  const reference = text.trim();
  const canLookup = byTitle && validTitle(reference);
  const canRegister = byTitle
    ? matches?.some((match) => match.registrationId === selectedId)
    : validChannel(reference);
  function resetResults() {
    setMatches(undefined);
    setSelectedId("");
    setLookupError(false);
  }
  return (
    <div className="grid gap-2">
      <label className="flex flex-wrap items-center gap-2">
        채널 찾기
        <select
          className={selectClass}
          value={byTitle ? "title" : "address"}
          disabled={disabled}
          onChange={(event) => {
            setByTitle(event.target.value === "title");
            setText("");
            resetResults();
          }}
        >
          <option value="address">사용자 이름, 링크 또는 ID</option>
          <option value="title">계정에 저장된 채널 제목</option>
        </select>
      </label>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled) return;
          if (byTitle) {
            if (!canLookup) return;
            resetResults();
            const result = await onManage({ action: "lookup", projectId, title: reference });
            setMatches(result?.matches);
            setLookupError(result !== null && !result.matches);
          } else if (
            canRegister &&
            (await onManage({ action: "register", projectId, channel: reference }))
          ) {
            setText("");
          }
        }}
      >
        <label className="grid min-w-0 grow gap-1">
          {byTitle
            ? "기존 채널 제목 (정확히 일치)"
            : "채널 사용자 이름, 공개 t.me 링크 또는 숫자 ID"}
          <Input
            value={text}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder={byTitle ? undefined : "@username"}
            onChange={(event) => {
              setText(event.target.value);
              resetResults();
            }}
          />
        </label>
        <Button
          type="submit"
          size="sm"
          disabled={disabled || (byTitle ? !canLookup : !canRegister)}
        >
          {byTitle ? "제목 조회" : "채널 등록 및 수집"}
        </Button>
      </form>
      {!byTitle && reference && !canRegister && (
        <p className="text-destructive">
          공개 채널의 @username, t.me/username 또는 음수 채널 ID를 입력하세요.
        </p>
      )}
      {lookupError && <p role="alert">제목 조회 결과를 확인할 수 없습니다.</p>}
      {matches?.length === 0 && (
        <p role="status">저장된 채널 중 제목이 일치하는 채널이 없습니다.</p>
      )}
      {matches && matches.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 grow gap-1">
            등록할 채널
            <select
              className={selectClass}
              value={selectedId}
              disabled={disabled}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">채널 선택</option>
              {matches.map((match) => (
                <option key={match.registrationId} value={match.registrationId}>
                  {match.title} ({match.registrationId})
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            disabled={disabled || !canRegister}
            onClick={async () => {
              if (
                canRegister &&
                (await onManage({ action: "register", projectId, channel: selectedId }))
              ) {
                setText("");
                resetResults();
              }
            }}
          >
            선택한 채널 등록 및 수집
          </Button>
        </div>
      )}
    </div>
  );
}

export function TelegramProjectChannels({ project }: { project: ScopedProjectRef }) {
  const registry = useEnvironmentQuery(
    status({ environmentId: project.environmentId, input: { projectId: project.projectId } }),
  );
  const snapshot = registry.data;
  const { refresh } = registry;
  const followProgress = snapshot?.registrations.some((entry) => entry.phase !== "paused");
  useEffect(() => {
    if (!followProgress) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [followProgress, refresh]);
  const run = useAtomCommand(manage, { reportFailure: false, reportDefect: false });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const disabled = busy || registry.data === null || registry.error !== null;
  const onManage: ManageChannel = async (input) => {
    if (disabled || inFlight.current || input.projectId !== project.projectId) return null;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await run({ environmentId: project.environmentId, input });
      if (result._tag === "Success") return result.value;
      const failure = squashAtomCommandFailure(result);
      if (!isAtomCommandInterrupted(result)) {
        setError(failure instanceof Error ? failure.message : "채널 설정을 변경하지 못했습니다.");
      }
      return null;
    } finally {
      if (input.action !== "lookup") registry.refresh();
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="mx-3 grid gap-3 text-sm sm:mx-4">
      <TelegramChannelRegistrationForm
        projectId={project.projectId}
        disabled={disabled}
        onManage={onManage}
      />
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">등록한 채널</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || registry.isPending}
          onClick={registry.refresh}
        >
          새로고침
        </Button>
        {busy || registry.isPending || (!registry.data && !registry.error) ? (
          <span role="status">{busy ? "요청 처리 중…" : "목록을 불러오는 중…"}</span>
        ) : null}
      </div>
      {(error || registry.error) && (
        <p role="alert" className="text-destructive">
          {error || registry.error}
        </p>
      )}
      {snapshot &&
        (snapshot.registrations.length === 0 ? (
          <p className="text-muted-foreground">이 프로젝트에 등록한 채널이 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {snapshot.registrations.map((entry) => (
              <TelegramChannelRow
                key={entry.registrationId}
                project={project}
                channel={entry}
                models={snapshot.cliModels}
                disabled={disabled}
                onManage={onManage}
              />
            ))}
          </ul>
        ))}
      {snapshot?.unsupportedCli?.length ? (
        <details>
          <summary className="w-fit cursor-pointer">선택할 수 없는 CLI 계정</summary>
          <ul className="mt-2 space-y-1">
            {snapshot.unsupportedCli.map((entry) => (
              <li key={entry.instanceId}>
                {entry.accountLabel} ({entry.driver} · {entry.instanceId}) — {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function TelegramChannelsSection() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState("");
  const options = projects.map(({ environmentId, id, title }) => {
    const project = { environmentId, projectId: id };
    const server = environments.find((entry) => entry.environmentId === environmentId);
    return {
      project,
      key: scopedProjectKey(project),
      label: `${title} (${server?.label ?? environmentId})`,
    };
  });
  const selected = options.find((option) => option.key === selection);
  return (
    <SettingsSection title="Telegram 채널">
      <SettingsRow
        title="수집할 프로젝트"
        description="등록하면 접근 가능한 이전 기록 전체를 즉시 수집하고, 이후 4시간마다 새 글 전부를 수집합니다. 서버를 다시 시작하면 중단된 동안의 글부터 이어서 수집합니다."
        control={
          <select
            className={selectClass}
            aria-label="Telegram 채널을 연결할 프로젝트"
            value={selected?.key ?? ""}
            onChange={(event) => setSelection(event.target.value)}
          >
            <option value="">{projects.length ? "프로젝트 선택" : "활성 프로젝트 없음"}</option>
            {options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        }
      />
      {selected && <TelegramProjectChannels key={selected.key} project={selected.project} />}
    </SettingsSection>
  );
}
