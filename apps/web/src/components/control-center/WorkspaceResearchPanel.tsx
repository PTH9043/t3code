import { Fragment, useState } from "react";
import type {
  WorkspaceResearchCall,
  WorkspaceResearchInput,
  WorkspaceResearchProvider,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { GoogleSearchSuggestions } from "./GoogleSearchSuggestions";
import {
  researchCitationMarkers,
  researchCitationSegments,
} from "@t3tools/shared/researchCitations";
import { researchErrorMessage } from "@t3tools/shared/researchErrors";

export function WorkspaceResearchPanel({
  project,
  onSaved,
}: {
  project: EnvironmentProject;
  onSaved: () => void;
}) {
  const status = useEnvironmentQuery(
    orchestrationEnvironment.workspaceResearch({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const run = useAtomCommand(orchestrationEnvironment.runWorkspaceResearch, {
    reportFailure: false,
  });
  const configureKey = useAtomCommand(orchestrationEnvironment.configureResearchKey, {
    reportFailure: false,
  });
  const settings = useEnvironmentSettings(project.environmentId);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<WorkspaceResearchProvider>("xai");
  const [model, setModel] = useState("");
  const [apiInstanceId, setApiInstanceId] = useState("");
  const [geminiMode, setGeminiMode] = useState<"google" | "analysis">("analysis");
  const [customMode, setCustomMode] = useState<"search" | "analysis">("search");
  const [googleReport, setGoogleReport] = useState<WorkspaceResearchCall | null>(null);
  const [googleSafe, setGoogleSafe] = useState(false);
  const [source, setSource] = useState<WorkspaceResearchInput["source"]>("both");
  const [domains, setDomains] = useState("");
  const [handles, setHandles] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [followUpId, setFollowUpId] = useState("");
  const [key, setKey] = useState("");
  const [limit, setLimit] = useState(() => String(settings.aiSearch.researchDailyUsd ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const split = (value: string) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const action = async (work: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      status.refresh();
      onSaved();
    } catch (cause) {
      setError(
        researchErrorMessage(cause, "처리를 완료하지 못했습니다. 연결과 권한을 확인하세요."),
      );
      status.refresh();
    } finally {
      setBusy(false);
    }
  };
  const research = () =>
    action(async () => {
      setGoogleReport(null);
      setGoogleSafe(false);
      const result = await run({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          requestId: randomUUID(),
          query: query.trim(),
          ...(provider === "xai" ? {} : { provider, model: model.trim() }),
          ...(provider === "gemini" ? { geminiMode } : {}),
          ...(provider === "custom" ? { apiInstanceId } : {}),
          ...(provider === "custom" ? { customMode } : {}),
          source,
          allowedDomains: split(domains),
          allowedHandles: split(handles).map((handle) => handle.replace(/^@/, "")),
          ...(fromDate ? { fromDate } : {}),
          ...(toDate ? { toDate } : {}),
          ...(followUpId && !(provider === "gemini" && geminiMode === "google")
            ? { followUpId }
            : {}),
        },
      });
      if (result._tag === "Success" && result.value.displayOnly) setGoogleReport(result.value);
      return result;
    });
  const saveKey = (apiKey: string | null) =>
    action(async () => {
      const result = await configureKey({
        environmentId: project.environmentId,
        input: { apiKey, ...(provider === "xai" ? {} : { provider }) },
      });
      if (result._tag === "Success") setKey("");
      return result;
    });
  return (
    <div className="grid gap-3 rounded-xl border border-border/70 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">API 최신 정보 조사</h3>
        <Button size="sm" variant="outline" onClick={status.refresh}>
          비용 새로고침
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        질문과 선택한 조사 자료를 해당 API로 보냅니다. Google 검색 보고서는 화면에만 표시하며,
        나머지 조사 결과는 출처와 함께 프로젝트 RAG에 저장합니다. 로컬 첨부 문서는 업로드하지
        않습니다.
      </p>
      <label className="text-xs">
        조사 API{" "}
        <select
          className="rounded border bg-background p-1"
          value={provider}
          onChange={(event) => {
            const next = event.currentTarget.value as WorkspaceResearchProvider;
            setProvider(next);
            setModel("");
            setKey("");
            setFollowUpId("");
            setApiInstanceId("");
            setGoogleReport(null);
            if (next !== "xai") {
              setSource("web");
              setHandles("");
              setFromDate("");
              setToDate("");
            }
            if (next === "gemini" || next === "custom") setDomains("");
          }}
        >
          <option value="xai">Grok (xAI)</option>
          <option value="openai" disabled={!status.data?.providerKeys}>
            OpenAI
          </option>
          <option value="anthropic" disabled={!status.data?.providerKeys}>
            Claude (Anthropic)
          </option>
          <option value="gemini" disabled={!status.data?.providerKeys}>
            Gemini
          </option>
          <option value="custom" disabled={!status.data?.customAccounts}>
            사용자 지정 API
          </option>
        </select>
      </label>
      {provider === "gemini" && (
        <label className="text-xs">
          Gemini 방식{" "}
          <select
            value={geminiMode}
            onChange={(event) => {
              setGeminiMode(event.currentTarget.value as "google" | "analysis");
              setFollowUpId("");
              setGoogleReport(null);
            }}
            className="rounded border bg-background p-1"
          >
            <option value="analysis">다른 API 조사 분석 후 RAG 저장</option>
            <option value="google">Google 검색 보고서 (화면 표시만)</option>
          </select>
        </label>
      )}
      {provider === "custom" && (
        <label className="text-xs">
          사용자 지정 API 방식{" "}
          <select
            value={customMode}
            onChange={(event) => {
              setCustomMode(event.currentTarget.value as "search" | "analysis");
              setFollowUpId("");
            }}
            className="rounded border bg-background p-1"
          >
            <option value="search">API 자체 웹 검색</option>
            <option value="analysis">다른 API 조사 분석</option>
          </select>
        </label>
      )}
      {provider === "custom" && (
        <label className="text-xs">
          등록된 API 계정{" "}
          <select
            value={apiInstanceId}
            onChange={(event) => {
              setApiInstanceId(event.currentTarget.value);
              setModel("");
            }}
            className="rounded border bg-background p-1"
          >
            <option value="">계정 선택</option>
            {status.data?.customAccounts?.map((account) => (
              <option key={account.instanceId} value={account.instanceId}>
                {account.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
      {provider === "custom" && (
        <label className="text-xs">
          모델{" "}
          <select
            value={model}
            onChange={(event) => setModel(event.currentTarget.value)}
            className="rounded border bg-background p-1"
          >
            <option value="">모델 선택</option>
            {status.data?.customAccounts
              ?.find((account) => account.instanceId === apiInstanceId)
              ?.models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
          </select>
        </label>
      )}
      {provider !== "xai" && provider !== "custom" && (
        <Input
          aria-label="조사 모델"
          placeholder="검색을 지원하는 모델 ID"
          value={model}
          onChange={(event) => setModel(event.currentTarget.value)}
        />
      )}
      {provider !== "custom" && (
        <p className="text-xs">
          {(provider === "xai" ? status.data?.apiKeyReady : status.data?.providerKeys?.[provider])
            ? `API 키 사용 가능${provider === "xai" ? ` · ${status.data?.model}` : ""}`
            : "조사 API 키 연결 필요 · CLI 로그인과 별도"}
        </p>
      )}
      {provider !== "custom" && (
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-40 flex-1"
            type="password"
            autoComplete="off"
            aria-label="조사 API 키"
            placeholder={
              provider === "xai"
                ? "XAI_API_KEY"
                : provider === "openai"
                  ? "OPENAI_API_KEY"
                  : provider === "anthropic"
                    ? "ANTHROPIC_API_KEY"
                    : "GEMINI_API_KEY"
            }
            value={key}
            onChange={(event) => setKey(event.currentTarget.value)}
          />
          <Button disabled={busy || !key.trim()} onClick={() => void saveKey(key.trim())}>
            키 저장
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void saveKey(null)}>
            저장 키 삭제
          </Button>
        </div>
      )}
      {provider === "custom" && (
        <p className="text-xs">
          등록한 API 계정과 키를 사용합니다. 자체 검색은 해당 API의 웹 검색 지원이 필요하며, 출처가
          없는 응답은 RAG에 저장하지 않습니다.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs">
          하루 조사 비용 상한 (USD, UTC)
          <Input
            type="number"
            min="0.01"
            step="0.01"
            value={limit}
            placeholder="제한 없음"
            onChange={(event) => setLimit(event.currentTarget.value)}
          />
        </label>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            const value = limit.trim() ? Number(limit) : null;
            if (value !== null && (!Number.isFinite(value) || value <= 0)) {
              setError("비용 상한은 양수로 입력하세요.");
              return;
            }
            void action(() =>
              update({
                environmentId: project.environmentId,
                input: { patch: { aiSearch: { researchDailyUsd: value } } },
              }),
            );
          }}
        >
          상한 저장
        </Button>
      </div>
      {status.data && (
        <p className="text-xs">
          오늘 보고 비용 ${status.data.reportedTodayUsd.toFixed(6)} · 이 프로젝트 $
          {status.data.projectTodayUsd.toFixed(6)} · 미확인 호출 {status.data.unreportedCalls}개
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        제공자가 실제 금액을 보고하지 않으면 미확인으로 표시합니다. 하루 상한이 설정된 경우 미확인
        호출이 있으면 다음 유료 호출을 중지합니다. CLI 구독은 포함하지 않으며 진행 중 호출은 상한을
        넘을 수 있습니다.
      </p>
      <Textarea
        aria-label="조사 질문"
        placeholder="공식 출처와 날짜를 확인할 조사 질문"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <label className="text-xs">
        검색 대상{" "}
        <select
          className="rounded border bg-background p-1"
          value={source}
          onChange={(event) =>
            setSource(event.currentTarget.value as WorkspaceResearchInput["source"])
          }
        >
          {provider === "xai" && <option value="both">웹 + X</option>}
          <option value="web">웹</option>
          {provider === "xai" && <option value="x">X</option>}
        </select>
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        {provider !== "gemini" && provider !== "custom" && (
          <Input
            aria-label="허용 웹 도메인"
            placeholder="웹 도메인 최대 5개, 쉼표 구분"
            value={domains}
            onChange={(event) => setDomains(event.currentTarget.value)}
          />
        )}
        {provider === "xai" && (
          <Input
            aria-label="허용 X 계정"
            placeholder="X 계정 최대 20개, 쉼표 구분"
            value={handles}
            onChange={(event) => setHandles(event.currentTarget.value)}
          />
        )}
        {provider === "xai" && (
          <label className="text-xs">
            X 시작일 (UTC, 포함)
            <Input
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.currentTarget.value)}
            />
          </label>
        )}
        {provider === "xai" && (
          <label className="text-xs">
            X 종료일 (UTC, 미포함)
            <Input
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.currentTarget.value)}
            />
          </label>
        )}
      </div>
      {!(provider === "gemini" && geminiMode === "google") && (
        <label className="text-xs">
          {(provider === "custom" && customMode === "analysis") || provider === "gemini"
            ? "분석할 검색 자료"
            : "추가 조사"}{" "}
          <select
            className="ml-2 max-w-full rounded border bg-background p-1"
            value={followUpId}
            onChange={(event) => setFollowUpId(event.currentTarget.value)}
          >
            <option value="">
              {(provider === "custom" && customMode === "analysis") || provider === "gemini"
                ? "완료된 조사 선택"
                : "새 조사"}
            </option>
            {status.data?.calls
              .filter(
                (call) =>
                  call.kind === "research" &&
                  call.status === "complete" &&
                  !call.displayOnly &&
                  Boolean(call.text) &&
                  call.sources.length > 0 &&
                  ((provider === "custom" && customMode === "analysis") ||
                    provider === "gemini" ||
                    (call.provider ?? "xai") === provider),
              )
              .map((call) => (
                <option key={call.requestId} value={call.requestId}>
                  {call.query.slice(0, 80)}
                </option>
              ))}
          </select>
        </label>
      )}
      <Button
        disabled={
          busy ||
          status.data?.busy ||
          !(provider === "custom"
            ? Boolean(apiInstanceId)
            : provider === "xai"
              ? status.data?.apiKeyReady
              : status.data?.providerKeys?.[provider]) ||
          !query.trim() ||
          (provider !== "xai" && !model.trim()) ||
          (((provider === "custom" && customMode === "analysis") ||
            (provider === "gemini" && geminiMode === "analysis")) &&
            !followUpId)
        }
        onClick={() => void research()}
      >
        {busy
          ? "조사 처리 중…"
          : provider === "gemini" && geminiMode === "google"
            ? "Google 검색 보고서 보기"
            : "조사 후 RAG 저장"}
      </Button>
      {(error || status.error) && (
        <p role="alert" className="text-xs text-destructive">
          {error ?? status.error}
        </p>
      )}
      {googleReport?.searchSuggestionsHtml && (
        <section className="rounded border p-3 text-sm">
          <div className="sticky top-0 z-10 bg-background">
            <GoogleSearchSuggestions
              html={googleReport.searchSuggestionsHtml}
              onValidated={setGoogleSafe}
            />
          </div>
          {googleSafe && (
            <>
              <h4 className="font-semibold">Gemini Google 검색 보고서</h4>
              <p className="whitespace-pre-wrap">
                {researchCitationMarkers(
                  googleReport.text,
                  googleReport.citations,
                  googleReport.sources,
                ).map((part) => (
                  <Fragment key={part.end}>
                    {part.text}
                    {part.links.map(({ url, number }) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline"
                        aria-label={`출처 ${number}`}
                      >
                        [{number}]
                      </a>
                    ))}
                  </Fragment>
                ))}
              </p>
              {googleReport.sources.map((url, index) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="block break-all text-primary underline"
                >
                  [{index + 1}] {url}
                </a>
              ))}
              <p className="text-xs text-muted-foreground">
                이 보고서는 화면에만 표시되며 프로젝트 RAG와 조사 기록에 저장되지 않습니다.
              </p>
            </>
          )}
        </section>
      )}
      {!googleReport &&
        status.data?.calls.map((call) => (
          <details key={`${call.requestId}:${call.kind}`} className="rounded border p-2 text-xs">
            <summary>
              {call.kind === "compaction" ? "맥락 압축" : call.query} · {call.provider ?? "xai"} ·{" "}
              {call.researchModel ?? "모델 미기록"} ·{" "}
              {call.displayOnly
                ? "화면 전용 · 본문 미저장"
                : call.status === "complete"
                  ? "응답 기록"
                  : "처리 확인 필요"}{" "}
              · {call.costTicks === null ? "비용 미보고" : `$${(call.costTicks / 1e10).toFixed(6)}`}
            </summary>
            <p>
              {call.createdAt} · 입력 {call.inputTokens ?? "미보고"} / 캐시{" "}
              {call.cachedTokens ?? "미보고"} / 출력 {call.outputTokens ?? "미보고"}
            </p>
            <p>{call.message}</p>
            <p className="whitespace-pre-wrap">
              {researchCitationSegments(call.text, call.citations).map((part) =>
                part.url ? (
                  <a
                    key={part.start}
                    href={part.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    {part.text}
                  </a>
                ) : (
                  part.text
                ),
              )}
            </p>
            {call.sources.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="block break-all text-primary underline"
              >
                {url}
              </a>
            ))}
          </details>
        ))}
    </div>
  );
}
