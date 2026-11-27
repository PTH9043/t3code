import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ProviderInstanceId,
  type ConversationExportFileFormat,
  type ConversationExportScope,
  type ConversationPreview,
  type ConversationSourceFormat,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { FileStackIcon } from "lucide-react";
import { serverEnvironment } from "~/state/server";
import { useListedThreadShells, useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SectionCard, notifyCommandFailure } from "./controlCenterShared";

export function ConversationTransferSection({ project }: { project: EnvironmentProject }) {
  const preview = useAtomCommand(serverEnvironment.previewConversation, { reportFailure: false });
  const importChat = useAtomCommand(serverEnvironment.importConversation, { reportFailure: false });
  const exportChat = useAtomCommand(serverEnvironment.exportConversation, { reportFailure: false });
  const navigate = useNavigate();
  const providers = deriveProviderInstanceEntries(
    useServerConfigs().get(project.environmentId)?.providers ?? [],
  ).filter((item) => item.enabled);
  const threads = useListedThreadShells().filter(
    (item) => item.environmentId === project.environmentId && item.projectId === project.id,
  );
  const [format, setFormat] = useState<ConversationSourceFormat>("grok");
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("CLI에서 이어온 대화");
  const [providerId, setProviderId] = useState("");
  const selectedProvider = providers.find((item) => item.instanceId === providerId) ?? providers[0];
  const [model, setModel] = useState("");
  const selectedModel =
    model || selectedProvider?.models[0]?.slug || project.defaultModelSelection?.model || "";
  const [exportId, setExportId] = useState("");
  const [exportScope, setExportScope] = useState<ConversationExportScope>("all");
  const selectedThread = threads.find((item) => item.id === exportId) ?? threads[0];
  const [summary, setSummary] = useState<ConversationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 8_000_000) {
      setError("원본은 8 MB 이내여야 합니다.");
      return;
    }
    setContent(await file.text());
    setTitle(file.name.replace(/\.(jsonl|json|md|txt)$/i, "").slice(0, 180));
    setSummary(null);
    setError(null);
  };
  const check = async () => {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const result = await preview({
        environmentId: project.environmentId,
        input: { format, content },
      });
      if (
        !notifyCommandFailure(result, "대화 원본 형식을 확인하세요.") &&
        result._tag === "Success"
      )
        setSummary(result.value);
    } finally {
      setBusy(false);
    }
  };
  const importNow = async () => {
    if (!selectedProvider || !selectedModel || !summary) return;
    setBusy(true);
    try {
      const result = await importChat({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          format,
          content,
          title: title.trim(),
          modelSelection: {
            instanceId: ProviderInstanceId.make(selectedProvider.instanceId),
            model: selectedModel,
          },
        },
      });
      if (
        !notifyCommandFailure(result, "대화를 가져오지 못했습니다.") &&
        result._tag === "Success"
      ) {
        setContent("");
        setSummary(null);
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: project.environmentId, threadId: result.value.threadId },
        });
      }
    } finally {
      setBusy(false);
    }
  };
  const exportNow = async (options: {
    original?: boolean;
    outputFormat?: ConversationExportFileFormat;
  }) => {
    if (!selectedThread) return;
    setBusy(true);
    try {
      const result = await exportChat({
        environmentId: project.environmentId,
        input: {
          threadId: selectedThread.id,
          original: options.original ?? false,
          ...(options.original
            ? {}
            : {
                scope: exportScope,
                ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
              }),
        },
      });
      if (!notifyCommandFailure(result, "내보낼 원본을 확인하세요.") && result._tag === "Success") {
        const mime = result.value.fileName.endsWith(".md")
          ? "text/markdown;charset=utf-8"
          : "text/plain;charset=utf-8";
        const url = URL.createObjectURL(new Blob([result.value.content], { type: mime }));
        const link = document.createElement("a");
        link.href = url;
        link.download = result.value.fileName;
        link.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard
      id="conversation-transfer"
      icon={FileStackIcon}
      title="CLI 대화 이어오기"
      description="Codex·Claude JSONL, Grok Markdown 내보내기와 T3 JSON을 가져오세요. 원본 도구·할일 기록은 서버에 그대로 보관합니다."
    >
      <details className="rounded-xl border border-border p-4">
        <summary className="cursor-pointer text-sm font-semibold">대화 가져오기</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-xs">
            원본 형식
            <select
              className="rounded-lg border bg-background p-2"
              value={format}
              onChange={(event) => {
                setFormat(event.target.value as ConversationSourceFormat);
                setSummary(null);
              }}
            >
              {(["grok", "codex", "claude", "t3"] as const).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            대화 원본 파일
            <input
              type="file"
              accept=".jsonl,.json,.md,.txt"
              onChange={(event) => void loadFile(event.target.files?.[0])}
            />
          </label>
          <label className="grid gap-1 text-xs md:col-span-2">
            원본 붙여넣기
            <Textarea
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setSummary(null);
              }}
              placeholder="grok export <세션 ID>로 내보낸 내용 또는 CLI JSONL"
              className="max-h-64 min-h-28 font-mono text-xs"
            />
          </label>
          <label className="grid gap-1 text-xs">
            새 대화 제목
            <Input
              value={title}
              maxLength={180}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs">
            이어갈 AI
            <select
              className="rounded-lg border bg-background p-2"
              value={selectedProvider?.instanceId ?? ""}
              onChange={(event) => {
                setProviderId(event.target.value);
                setModel("");
              }}
            >
              {providers.map((item) => (
                <option key={item.instanceId} value={item.instanceId}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs md:col-span-2">
            모델
            <Input value={selectedModel} onChange={(event) => setModel(event.target.value)} />
          </label>
          <Button
            className="w-fit"
            variant="outline"
            size="sm"
            disabled={busy || !content.trim()}
            onClick={() => void check()}
          >
            가져올 내용 확인
          </Button>
          {summary ? (
            <div className="rounded-lg bg-muted/40 p-3 text-xs md:col-span-2">
              <p>
                {summary.messageCount}개 메시지 · {summary.sourceSessionId ?? "원본 세션 ID 없음"}
              </p>
              {summary.sample.map((item) => (
                <p key={`${item.role}:${item.text}`} className="mt-2 whitespace-pre-wrap">
                  <strong>{item.role}</strong> · {item.text}
                </p>
              ))}
            </div>
          ) : null}
          <Button
            className="w-fit"
            size="sm"
            disabled={busy || !summary || !title.trim() || !selectedProvider || !selectedModel}
            onClick={() => void importNow()}
          >
            새 대화로 가져오기
          </Button>
          <p className="text-xs text-muted-foreground md:col-span-2">
            가져오기는 AI를 실행하지 않습니다. 새 메시지를 보내면 이전 문맥과 원본 경로를
            인계합니다. 첨부 이미지의 외부 파일은 따로 가져와야 합니다.
          </p>
          {error ? (
            <p role="alert" className="text-xs text-destructive md:col-span-2">
              {error}
            </p>
          ) : null}
        </div>
      </details>
      <div className="mt-4 flex flex-wrap gap-2">
        <select
          aria-label="내보낼 대화"
          className="min-w-0 flex-1 rounded-lg border bg-background p-2 text-xs"
          value={selectedThread?.id ?? ""}
          onChange={(event) => setExportId(event.target.value)}
        >
          {threads.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        <select
          aria-label="대화 내보내기 구분"
          className="rounded-lg border bg-background p-2 text-xs"
          value={exportScope}
          onChange={(event) => setExportScope(event.target.value as ConversationExportScope)}
        >
          <option value="all">전체 대화</option>
          <option value="user_only">내 대화·말투만</option>
          <option value="ai_only">AI 작성·조사만</option>
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !selectedThread}
          onClick={() => void exportNow({ original: false, outputFormat: "json" })}
        >
          T3 내보내기
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !selectedThread}
          onClick={() => void exportNow({ original: false, outputFormat: "markdown" })}
        >
          Markdown 분리 저장
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !selectedThread}
          onClick={() => void exportNow({ original: true })}
        >
          보관된 CLI 원본
        </Button>
      </div>
    </SectionCard>
  );
}
