import { Link } from "@tanstack/react-router";
import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type EnvironmentId,
  type PdfRevisionStatus,
  type ProjectId,
  type WorkspaceKnowledgeItem,
  type WorkspaceKnowledgeItemId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentSessionState } from "~/state/session";
import { randomUUID } from "~/lib/utils";
import {
  getPdfRevisionStatus,
  readPdfRevisionSource,
  retryPdfRevision,
  startPdfRevision,
} from "./pdfRevisionApi";

type DocumentRef = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  itemId: WorkspaceKnowledgeItemId;
};
type Props = DocumentRef & { name: string; excerptHash: string; onPublished: () => void };

export function pdfKnowledgeAttachment(item: WorkspaceKnowledgeItem) {
  return item.origin === "imported" &&
    item.kind === "rag-source" &&
    !item.sourceItemId &&
    item.tags.includes("pdf-page-batch")
    ? item.research?.attachment
    : undefined;
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function PdfRevisionPanel({
  environmentId,
  projectId,
  itemId,
  name,
  excerptHash,
  onPublished,
}: Props) {
  const session = useEnvironmentSessionState(environmentId).data;
  const readOnly =
    session?.authenticated === true &&
    session.scopes !== undefined &&
    !session.scopes.includes(AuthOrchestrationOperateScope);
  const getStatus = useAtomCommand(getPdfRevisionStatus, { reportFailure: false });
  const start = useAtomCommand(startPdfRevision, { reportFailure: false });
  const retry = useAtomCommand(retryPdfRevision, { reportFailure: false });
  const [status, setStatus] = useState<PdfRevisionStatus | null>(null);
  const [selection, setSelection] = useState<{
    file: File;
    version: number;
    requestId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const requestSequence = useRef(0);
  const operationPending = useRef(false);
  const reading = useRef(false);
  const previousStatus = useRef<PdfRevisionStatus | null>(null);
  const publishedCallback = useRef(onPublished);
  useEffect(() => {
    publishedCallback.current = onPublished;
  }, [onPublished]);
  const receive = useCallback((next: PdfRevisionStatus) => {
    if (!mounted.current) return;
    const previous = previousStatus.current;
    previousStatus.current = next;
    setStatus(next);
    setLoadError("");
    if (
      previous &&
      (previous.published.version !== next.published.version ||
        previous.pending?.contentHash !== next.pending?.contentHash ||
        previous.pending?.status !== next.pending?.status)
    ) {
      setSelection(null);
      if (picker.current) picker.current.value = "";
      setNotice("");
    }
    if (previous && next.published.version > previous.published.version) {
      setNotice(`버전 ${next.published.version}이 공개됐습니다.`);
      publishedCallback.current();
    }
  }, []);
  const refresh = useCallback(async () => {
    if (operationPending.current || reading.current) return;
    const sequence = ++requestSequence.current;
    reading.current = true;
    try {
      const result = await getStatus({ environmentId, input: { projectId, itemId } });
      if (!mounted.current || sequence !== requestSequence.current) return;
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      receive(result.value);
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current)
        setLoadError(errorMessage(cause, "버전 상태를 불러오지 못했습니다."));
    } finally {
      if (sequence === requestSequence.current) reading.current = false;
    }
  }, [environmentId, projectId, itemId, getStatus, receive]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      requestSequence.current++;
      reading.current = false;
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  useEffect(() => {
    if (status?.pending?.status !== "indexing") return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [status?.pending?.status, refresh]);
  const submit = async (mode: "upload" | "retry") => {
    if (operationPending.current || !status || readOnly) return;
    if (mode === "retry" && status.pending?.status !== "failed") return;
    if (
      mode === "upload" &&
      (!selection ||
        selection.version !== status.published.version ||
        status.pending?.status === "indexing")
    )
      return;
    operationPending.current = true;
    requestSequence.current++;
    reading.current = false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let result;
      if (mode === "upload" && selection) {
        const { file, version, requestId } = selection;
        const { readFileAsDataUrl } = await import("../ChatView.logic");
        const dataUrl = await readFileAsDataUrl(
          new File([file], file.name, { type: "application/pdf" }),
        );
        result = await start({
          environmentId,
          input: {
            projectId,
            itemId,
            expectedVersion: version,
            requestId,
            file: {
              type: "file",
              name: file.name,
              mimeType: "application/pdf",
              sizeBytes: file.size,
              dataUrl,
            },
          },
        });
      } else {
        result = await retry({ environmentId, input: { projectId, itemId } });
      }
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      if (mounted.current) {
        receive(result.value);
        setSelection(null);
        if (picker.current) picker.current.value = "";
        if (mode === "retry" && result.value.pending?.status === "indexing")
          setNotice("저장된 PDF로 색인 재개를 요청했습니다.");
        else if (
          !result.value.pending &&
          result.value.published.version === status.published.version
        )
          setNotice(`현재 공개 버전은 ${result.value.published.version}입니다.`);
      }
    } catch (cause) {
      if (mounted.current)
        setError(errorMessage(cause, "요청 결과를 확인하지 못했습니다. 버전 상태를 확인하세요."));
    } finally {
      operationPending.current = false;
      if (mounted.current) {
        setBusy(false);
        void refresh();
      }
    }
  };
  const pending = status?.pending;
  return (
    <section aria-label="PDF 버전" className="grid gap-3 rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">PDF 버전</h2>
        <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={refresh}>
          상태 새로고침
        </Button>
      </div>
      {!status && !loadError && <p role="status">공개 버전을 확인하는 중…</p>}
      {loadError && <p role="alert">{loadError}</p>}
      {status && (
        <>
          <p>
            <strong>공개 버전 {status.published.version}</strong>
            {status.published.totalPages > 0 && ` · ${status.published.totalPages}쪽`}
          </p>
          {excerptHash !== status.published.contentHash && (
            <p className="text-muted-foreground">
              이 페이지의 발췌문은 이전 판에 속합니다. 최신 내용은 공개 PDF 원문이나 프로젝트 지식
              검색에서 확인하세요.
            </p>
          )}
          <PdfPublishedSource
            key={status.published.version}
            environmentId={environmentId}
            projectId={projectId}
            itemId={itemId}
            version={status.published.version}
            name={name}
          />
          {pending && (
            <div className="grid gap-1">
              <p role="status">
                버전 {pending.version} {pending.status === "failed" ? "색인 실패" : "색인 중"} ·{" "}
                {pending.lastPage}쪽 처리
                {pending.totalPages > 0 && ` / 전체 ${pending.totalPages}쪽`}
              </p>
              {pending.status === "indexing" && (
                <progress
                  aria-label="PDF 색인 진행률"
                  {...(pending.totalPages > 0
                    ? { value: pending.lastPage, max: pending.totalPages }
                    : {})}
                />
              )}
              <p className="text-muted-foreground">
                새 버전이 공개될 때까지 버전 {status.published.version}을 검색할 수 있습니다.
              </p>
              {pending.status === "failed" && (
                <>
                  {pending.error && (
                    <p role="alert" className="break-words">
                      {pending.error}
                    </p>
                  )}
                  {!readOnly && (
                    <>
                      <p className="text-muted-foreground">
                        저장된 PDF로 색인을 재개하거나 교정한 PDF를 선택해 새로 올리세요.
                      </p>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        className="justify-self-start"
                        disabled={busy}
                        onClick={() => submit("retry")}
                      >
                        색인 재개
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
          )}
          {pending?.status !== "indexing" && !readOnly && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1">
                새 버전 PDF
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  ref={picker}
                  disabled={busy}
                  onChange={(event) => {
                    const next = event.currentTarget.files?.[0];
                    if (!next) {
                      setSelection(null);
                      return;
                    }
                    const issue =
                      next.type !== "application/pdf" && !/\.pdf$/i.test(next.name)
                        ? "PDF 파일을 선택하세요."
                        : !next.size
                          ? "비어 있는 파일입니다."
                          : next.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES
                            ? "50 MiB 이하의 PDF를 선택하세요."
                            : "";
                    setSelection(
                      issue
                        ? null
                        : {
                            file: next,
                            version: status.published.version,
                            requestId: randomUUID(),
                          },
                    );
                    setError(issue);
                    setNotice("");
                    if (issue) event.currentTarget.value = "";
                  }}
                />
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !selection || selection.version !== status.published.version}
                onClick={() => submit("upload")}
              >
                새 버전 올리기
              </Button>
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <Link
        className="justify-self-start text-primary underline"
        to="/control-center/$environmentId/$projectId"
        params={{ environmentId, projectId }}
        hash="project-knowledge-search"
      >
        프로젝트 지식 검색
      </Link>
    </section>
  );
}

export function PdfPublishedSource({
  environmentId,
  projectId,
  itemId,
  version,
  name,
}: DocumentRef & { version: number; name: string }) {
  const read = useAtomCommand(readPdfRevisionSource, { reportFailure: false });
  const [pdf, setPdf] = useState<Blob | null>(null);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    if (!pdf) {
      setUrl("");
      return;
    }
    const url = URL.createObjectURL(pdf);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pdf]);
  const open = async () => {
    if (inFlight.current) return;
    if (pdf) {
      setPdf(null);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const result = await read({ environmentId, input: { projectId, itemId, version } });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      const prefix = "data:application/pdf;base64,";
      if (!result.value.dataUrl.startsWith(prefix))
        throw new Error("PDF 원문 형식을 확인할 수 없습니다.");
      const raw = atob(result.value.dataUrl.slice(prefix.length));
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      setPdf(new Blob([bytes], { type: "application/pdf" }));
    } catch (cause) {
      setError(errorMessage(cause, "공개 PDF 원문을 불러오지 못했습니다."));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <div className="grid gap-2">
      <button
        type="button"
        className="justify-self-start text-primary underline"
        aria-expanded={!!pdf}
        disabled={pending}
        onClick={open}
      >
        {pending ? "PDF 원문을 불러오는 중…" : pdf ? "공개 PDF 원문 닫기" : "공개 PDF 원문 보기"}
      </button>
      {error && <p role="alert">{error}</p>}
      {pdf && url && (
        <>
          <object
            data={url}
            type="application/pdf"
            aria-label={`공개 PDF 버전 ${version}`}
            className="h-[55vh] w-full rounded border"
          >
            PDF 미리보기를 지원하지 않는 환경에서는 원문을 내려받을 수 있습니다.
          </object>
          <a className="justify-self-start text-primary underline" href={url} download={name}>
            버전 {version} PDF 내려받기
          </a>
        </>
      )}
    </div>
  );
}
