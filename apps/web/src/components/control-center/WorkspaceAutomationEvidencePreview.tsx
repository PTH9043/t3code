import { useEffect, useState } from "react";
import type { WorkspaceAutomationEvidence } from "@t3tools/contracts";
import {
  workspaceEvidenceBytes,
  workspaceEvidenceHtml,
  workspaceEvidenceText,
} from "@t3tools/shared/workspaceEvidence";
import { Button } from "../ui/button";

export function WorkspaceAutomationEvidencePreview({
  evidence,
}: {
  evidence: WorkspaceAutomationEvidence;
}) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(
      new Blob([workspaceEvidenceBytes(evidence)], { type: evidence.mediaType ?? "text/plain" }),
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [evidence]);
  const isImage = evidence.mediaType?.startsWith("image/");
  const isPdf = evidence.mediaType === "application/pdf";
  const isHtml = evidence.mediaType === "text/html";
  const text = workspaceEvidenceText(evidence.contents);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          {evidence.label} · {evidence.byteLength.toLocaleString()}바이트
          {evidence.truncated ? " · 앞 64 KiB 표시" : ""}
          {evidence.sha256 ? " · 검증 당시 저장본" : ""}
        </p>
        {url && evidence.mediaType ? (
          <Button variant="outline" size="sm" render={<a href={url} download={evidence.label} />}>
            파일 저장
          </Button>
        ) : null}
      </div>
      {failed ? (
        <p role="alert" className="text-destructive">
          이 이미지의 미리보기를 표시하지 못했습니다. 파일을 저장해 확인할 수 있습니다.
        </p>
      ) : null}
      {isImage && url ? (
        <img
          src={url}
          alt={evidence.label}
          className="max-h-[55vh] w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : isPdf && url ? (
        <object
          data={url}
          type="application/pdf"
          aria-label={`${evidence.label} PDF 미리보기`}
          className="h-[55vh] w-full rounded-lg border border-border"
        >
          <p className="p-4 text-sm">
            이 환경에서는 PDF 미리보기를 표시할 수 없습니다. 파일 저장으로 확인하세요.
          </p>
        </object>
      ) : isHtml ? (
        <iframe
          srcDoc={workspaceEvidenceHtml(evidence.contents)}
          sandbox=""
          referrerPolicy="no-referrer"
          title={`${evidence.label} HTML 미리보기`}
          className="h-[55vh] w-full rounded-lg border border-border bg-white"
        />
      ) : !isImage && !isPdf ? (
        <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-4 text-xs">
          {text.contents || "자료가 비어 있습니다."}
        </pre>
      ) : (
        <p>미리보기를 준비하는 중…</p>
      )}
      {isHtml ? (
        <p className="text-xs text-muted-foreground">
          읽기 전용 미리보기 · 스크립트와 외부 이미지·글꼴은 제한됩니다.
        </p>
      ) : null}
      {!isImage && !isPdf && !isHtml && text.shortened ? (
        <p className="text-xs text-muted-foreground">
          긴 텍스트는 앞부분만 미리 봅니다. 파일 저장으로 불러온 내용을 확인할 수 있습니다.
        </p>
      ) : null}
    </div>
  );
}
