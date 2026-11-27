import { useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  isProtectedWorkspaceKnowledgeItem,
  type WorkspaceDesignReference,
  type WorkspaceKnowledgeItem,
  type WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeKind,
  type WorkspaceKnowledgeScope,
  type WorkspaceWikiLinksResult,
} from "@t3tools/contracts";
import {
  formatWorkspaceWikiIdLink,
  parseWorkspaceWikiLinks,
} from "@t3tools/shared/workspaceWikiLinks";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { DesignReferenceFields } from "../control-center/DesignReferenceFields";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { editWikiDocument } from "./knowledgeApi";
import { completionAt, editableWikiBody } from "./knowledgeDocument.logic";
import { KNOWLEDGE_KIND_LABELS } from "./knowledgeKinds";
import { WikiLinkPicker } from "./WikiLinkPicker";

export function KnowledgeEditor({
  project,
  item,
  links,
  sequence,
  onSaved,
}: {
  project: EnvironmentProject;
  item: WorkspaceKnowledgeItem;
  links: WorkspaceWikiLinksResult;
  sequence: number;
  onSaved: (id: WorkspaceKnowledgeItemId) => void;
}) {
  const [base] = useState(() => ({
    item,
    sequence,
    body: editableWikiBody(item.content, links.outgoing),
  }));
  const [title, setTitle] = useState(base.item.title);
  const [body, setBody] = useState(base.body);
  const [kind, setKind] = useState(base.item.kind);
  const [scope, setScope] = useState(base.item.scope ?? "project");
  const [folder, setFolder] = useState(base.item.appliesToFolder ?? "");
  const [location, setLocation] = useState(base.item.relativeFolder ?? "");
  const [tags, setTags] = useState(base.item.tags.join(", "));
  const [design, setDesign] = useState<WorkspaceDesignReference | null>(
    base.item.research?.design ?? null,
  );
  const [caret, setCaret] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const retry = useRef<{ signature: string; commandId: CommandId } | null>(null);
  const edit = useAtomCommand(editWikiDocument, { reportFailure: false });
  const occurrences = useMemo(() => parseWorkspaceWikiLinks(body), [body]);
  const unbound = occurrences.filter(
    (link) =>
      !link.explicitItemId ||
      links.unresolved.some((record) => record.targetTitle === link.targetTitle),
  );
  const chosen = selected === null ? null : occurrences.find((link) => link.start === selected);
  const completion = chosen ?? (caret === null ? null : completionAt(body, caret));
  const search = chosen ? query : completion && "query" in completion ? completion.query : "";
  const outdated = base.sequence !== sequence || base.item.updatedAt !== item.updatedAt;
  const protectedItem = isProtectedWorkspaceKnowledgeItem(base.item);
  function choose(target: { id: WorkspaceKnowledgeItemId; title: string }) {
    if (!completion) return;
    const replacement = formatWorkspaceWikiIdLink(target.id, chosen?.alias ?? target.title);
    setBody(body.slice(0, completion.start) + replacement + body.slice(completion.end));
    setSelected(null);
    setCaret(null);
    const end = completion.start + replacement.length;
    if (!field.current) return;
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(end, end);
    });
  }
  async function save() {
    if (
      saving ||
      outdated ||
      !title.trim() ||
      !body.trim() ||
      (scope === "folder" && !folder.trim())
    )
      return;
    setSaving(true);
    setError("");
    try {
      const research = base.item.research;
      const { design: _oldDesign, ...metadata } = research ?? {
        query: title.trim(),
        sources: [],
        capturedAt: base.item.createdAt,
        verification: "unverified" as const,
      };
      const payload = {
        projectId: project.id,
        itemId: base.item.id,
        expectedSequence: base.sequence,
        title: title.trim(),
        content: body === base.body ? base.item.content : body,
        ...(body !== base.body ? { wikiLinksCanonicalized: true } : {}),
        kind: design && kind !== "long-term-memory" ? ("rag-source" as const) : kind,
        scope,
        appliesToFolder: scope === "folder" ? folder.trim().replaceAll("\\", "/") : null,
        relativeFolder:
          kind === "long-term-memory" && location.trim()
            ? location.trim().replaceAll("\\", "/")
            : null,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        research:
          design || research
            ? {
                ...metadata,
                ...(design
                  ? {
                      design,
                      sources: [
                        ...new Set([
                          ...metadata.sources,
                          ...(design.sourceUrl ? [design.sourceUrl] : []),
                        ]),
                      ],
                    }
                  : {}),
              }
            : null,
      };
      const signature = JSON.stringify(payload);
      if (retry.current?.signature !== signature)
        retry.current = { signature, commandId: CommandId.make(randomUUID()) };
      const result = await edit({
        environmentId: project.environmentId,
        input: { ...payload, commandId: retry.current.commandId },
      });
      if (!mounted.current) return;
      if (result._tag === "Success") onSaved(result.value.itemId);
      else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "저장하지 못했습니다.");
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="grid gap-4"
    >
      {protectedItem && (
        <p className="rounded-lg border p-3 text-sm">
          수정하면 이 원본에 연결된 사용자 문서가 만들어집니다. 원본에는 이후 자동 수집 결과가 계속
          반영됩니다.
        </p>
      )}
      {outdated && (
        <p role="alert">
          편집 중 문서가 변경됐습니다. 작성한 내용을 복사한 뒤 읽기 화면에서 최신 버전을 다시
          여세요.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <fieldset disabled={saving} className="grid min-w-0 gap-4">
        <label className="grid gap-1 text-sm font-medium">
          제목
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Markdown 본문
          <Textarea
            ref={field}
            value={body}
            className="min-h-72 font-mono"
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onChange={(e) => {
              setBody(e.target.value);
              setSelected(null);
              setCaret(e.target.selectionStart);
            }}
            required
          />
        </label>
        {unbound.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-2 text-sm">
            <span>연결 대상 선택</span>
            {unbound.map((link) => (
              <button
                type="button"
                key={link.start}
                title={link.context}
                className="text-primary underline"
                onClick={() => {
                  setSelected(link.start);
                  setQuery(link.explicitItemId ? "" : link.targetTitle);
                }}
              >
                {link.alias ?? link.targetTitle}
              </button>
            ))}
          </div>
        )}
        {chosen && (
          <label className="grid gap-1 text-sm">
            문서 찾기
            <Input value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        {completion && (
          <WikiLinkPicker key={search} project={project} query={search} onPick={choose} />
        )}
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer">종류 · 범위 · 태그 · 디자인</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1">
              종류
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as WorkspaceKnowledgeKind)}
              >
                {Object.entries(KNOWLEDGE_KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              적용 범위
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as WorkspaceKnowledgeScope)}
              >
                <option value="project">프로젝트</option>
                <option value="folder">폴더</option>
                <option value="environment">공용</option>
              </select>
            </label>
            {scope === "folder" && (
              <label>
                적용 폴더
                <Input required value={folder} onChange={(e) => setFolder(e.target.value)} />
              </label>
            )}
            {kind === "long-term-memory" && (
              <label>
                하위 폴더
                <Input value={location} onChange={(e) => setLocation(e.target.value)} />
              </label>
            )}
            <label>
              태그 (쉼표 구분)
              <Input value={tags} onChange={(e) => setTags(e.target.value)} />
            </label>
          </div>
          <DesignReferenceFields
            environmentId={project.environmentId}
            projectId={project.id}
            value={design}
            onChange={setDesign}
          />
        </details>
        <Button
          type="submit"
          className="justify-self-start"
          disabled={outdated || !title.trim() || !body.trim()}
        >
          {saving ? "저장 중…" : protectedItem ? "사용자 문서로 저장" : "변경 저장"}
        </Button>
      </fieldset>
    </form>
  );
}
