import { useState } from "react";
import type { WorkspaceResearchInput } from "@t3tools/contracts";
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
        cause instanceof Error
          ? cause.message
          : "처리를 완료하지 못했습니다. 연결과 권한을 확인하세요.",
      );
      status.refresh();
    } finally {
      setBusy(false);
    }
  };
  const research = () =>
    action(() =>
      run({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          requestId: randomUUID(),
          query: query.trim(),
          source,
          allowedDomains: split(domains),
          allowedHandles: split(handles).map((handle) => handle.replace(/^@/, "")),
          ...(fromDate ? { fromDate } : {}),
          ...(toDate ? { toDate } : {}),
          ...(followUpId ? { followUpId } : {}),
        },
      }),
    );
  const saveKey = (apiKey: string | null) =>
    action(async () => {
      const result = await configureKey({
        environmentId: project.environmentId,
        input: { apiKey },
      });
      if (result._tag === "Success") setKey("");
      return result;
    });
  return (
    <div className="grid gap-3 rounded-xl border border-border/70 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Grok 최신 정보 조사</h3>
        <Button size="sm" variant="outline" onClick={status.refresh}>
          비용 새로고침
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        질문과 이전 Grok 조사만 xAI로 보냅니다. 출처와 날짜를 프로젝트 RAG에 저장합니다. 로컬 첨부
        문서는 업로드하지 않습니다.
      </p>
      <p className="text-xs">
        {status.data?.apiKeyReady
          ? `API 연결 · ${status.data.model}`
          : "조사 API 키 연결 필요 · Grok CLI 로그인과 별도"}
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-40 flex-1"
          type="password"
          autoComplete="off"
          aria-label="Grok 조사 API 키"
          placeholder="XAI_API_KEY"
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
        검색·압축을 포함한 이 조사 기능의 비용입니다. CLI 구독 비용은 포함하지 않습니다. 진행 중
        호출은 상한을 넘을 수 있습니다.
      </p>
      <Textarea
        aria-label="Grok 조사 질문"
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
          <option value="both">웹 + X</option>
          <option value="web">웹</option>
          <option value="x">X</option>
        </select>
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="허용 웹 도메인"
          placeholder="웹 도메인 최대 5개, 쉼표 구분"
          value={domains}
          onChange={(event) => setDomains(event.currentTarget.value)}
        />
        <Input
          aria-label="허용 X 계정"
          placeholder="X 계정 최대 20개, 쉼표 구분"
          value={handles}
          onChange={(event) => setHandles(event.currentTarget.value)}
        />
        <label className="text-xs">
          X 시작일 (UTC, 포함)
          <Input
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.currentTarget.value)}
          />
        </label>
        <label className="text-xs">
          X 종료일 (UTC, 미포함)
          <Input
            type="date"
            value={toDate}
            onChange={(event) => setToDate(event.currentTarget.value)}
          />
        </label>
      </div>
      <label className="text-xs">
        추가 조사{" "}
        <select
          className="ml-2 max-w-full rounded border bg-background p-1"
          value={followUpId}
          onChange={(event) => setFollowUpId(event.currentTarget.value)}
        >
          <option value="">새 조사</option>
          {status.data?.calls
            .filter((call) => call.kind === "research" && call.status === "complete")
            .map((call) => (
              <option key={call.requestId} value={call.requestId}>
                {call.query.slice(0, 80)}
              </option>
            ))}
        </select>
      </label>
      <Button
        disabled={busy || status.data?.busy || !status.data?.apiKeyReady || !query.trim()}
        onClick={() => void research()}
      >
        {busy ? "조사 처리 중…" : "조사 후 RAG 저장"}
      </Button>
      {(error || status.error) && (
        <p role="alert" className="text-xs text-destructive">
          {error ?? status.error}
        </p>
      )}
      {status.data?.calls.map((call) => (
        <details key={`${call.requestId}:${call.kind}`} className="rounded border p-2 text-xs">
          <summary>
            {call.kind === "compaction" ? "맥락 압축" : call.query} ·{" "}
            {call.status === "complete" ? "응답 기록" : "처리 확인 필요"} ·{" "}
            {call.costTicks === null ? "비용 미보고" : `$${(call.costTicks / 1e10).toFixed(6)}`}
          </summary>
          <p>
            {call.createdAt} · 입력 {call.inputTokens ?? "미보고"} / 캐시{" "}
            {call.cachedTokens ?? "미보고"} / 출력 {call.outputTokens ?? "미보고"}
          </p>
          <p>{call.message}</p>
          <p className="whitespace-pre-wrap">{call.text}</p>
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
