import { useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { WorkspaceKnowledgeItem, WorkspaceWikiLinksResult } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { DesignReferencePreview } from "../control-center/DesignReferenceFields";
import { KnowledgeDocLink } from "./KnowledgeDocLink";
import { wikiReaderMarkdown } from "./knowledgeDocument.logic";
import { RunKnowledgeDocuments } from "./RunKnowledgeDocuments";

const confidenceLabels = { high: "높음", medium: "보통", low: "낮음" } as const;

export type KnowledgeViewMode = "summary" | "json-tree" | "raw";

const VIEW_MODES: ReadonlyArray<{ id: KnowledgeViewMode; label: string }> = [
  { id: "summary", label: "요약/마크다운" },
  { id: "json-tree", label: "JSON 구조 트리" },
  { id: "raw", label: "원본" },
];

export interface ParsedKnowledgePayload {
  readonly isJson: boolean;
  readonly parsed: unknown;
  readonly readableMarkdown: string;
}

function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false };
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== '"') return { ok: false };
  try {
    const firstPass: unknown = JSON.parse(trimmed);
    if (typeof firstPass === "string") {
      const inner = firstPass.trim();
      if (inner.startsWith("{") || inner.startsWith("[")) {
        try {
          return { ok: true, value: JSON.parse(inner) };
        } catch {
          return { ok: true, value: firstPass };
        }
      }
      return { ok: true, value: firstPass };
    }
    return { ok: true, value: firstPass };
  } catch {
    return { ok: false };
  }
}

function unescapeEscapedText(raw: string): string {
  if (!/\\[nrt"\\]/.test(raw)) return raw;
  return raw
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function formatJsonAsMarkdown(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "_없음_";
  if (typeof value === "string") return unescapeEscapedText(value);
  if (typeof value === "number" || typeof value === "boolean") return `\`${String(value)}\``;
  if (Array.isArray(value)) {
    if (value.length === 0) return "_비어 있음_";
    return value
      .map((entry) => {
        if (entry !== null && typeof entry === "object") {
          const nested = formatJsonAsMarkdown(entry, depth + 1)
            .split("\n")
            .map((line, idx) => (idx === 0 ? `- ${line}` : `  ${line}`))
            .join("\n");
          return nested;
        }
        return `- ${formatJsonAsMarkdown(entry, depth + 1)}`;
      })
      .join("\n");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "_비어 있음_";
  const headingPrefix = "#".repeat(Math.min(depth + 2, 4));
  return entries
    .map(([key, entryValue]) => {
      if (
        entryValue !== null &&
        typeof entryValue === "object" &&
        (!Array.isArray(entryValue) || entryValue.length > 0)
      ) {
        return `${headingPrefix} ${key}\n\n${formatJsonAsMarkdown(entryValue, depth + 1)}`;
      }
      const rendered = formatJsonAsMarkdown(entryValue, depth + 1);
      if (rendered.includes("\n")) {
        return `${headingPrefix} ${key}\n\n${rendered}`;
      }
      return `- **${key}**: ${rendered}`;
    })
    .join("\n\n");
}

export function parseStructuredKnowledgeContent(raw: string): ParsedKnowledgePayload {
  const direct = tryParseJson(raw);
  if (direct.ok) {
    if (typeof direct.value === "string") {
      return {
        isJson: false,
        parsed: direct.value,
        readableMarkdown: unescapeEscapedText(direct.value),
      };
    }
    return {
      isJson: true,
      parsed: direct.value,
      readableMarkdown: formatJsonAsMarkdown(direct.value),
    };
  }
  const fencedMatch = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(raw);
  if (fencedMatch?.[1]) {
    const fenced = tryParseJson(fencedMatch[1]);
    if (fenced.ok && fenced.value !== null && typeof fenced.value === "object") {
      return {
        isJson: true,
        parsed: fenced.value,
        readableMarkdown: formatJsonAsMarkdown(fenced.value),
      };
    }
  }
  // Detect heavily escaped JSON-like dump strings (e.g. \"foo\":\"bar\"\n)
  const escapedCount = (raw.match(/\\n|\\"/g) ?? []).length;
  const readableMarkdown = escapedCount >= 3 ? unescapeEscapedText(raw) : raw;
  return {
    isJson: false,
    parsed: null,
    readableMarkdown,
  };
}

function JsonTreeNode({
  name,
  value,
  depth = 0,
}: {
  name?: string;
  value: unknown;
  depth?: number;
}) {
  if (value === null || value === undefined) {
    return (
      <div className="flex items-baseline gap-1.5 py-0.5 font-mono text-xs">
        {name !== undefined && <span className="theme-json-key font-medium">{name}:</span>}
        <span className="theme-json-constant">{value === null ? "null" : "undefined"}</span>
      </div>
    );
  }
  if (typeof value === "string") {
    const unescaped = unescapeEscapedText(value);
    const isMultiline = unescaped.includes("\n") || unescaped.length > 120;
    return (
      <div className="py-0.5 font-mono text-xs">
        {name !== undefined && <span className="theme-json-key mr-1.5 font-medium">{name}:</span>}
        {isMultiline ? (
          <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-border/70 bg-muted/40 p-2 font-sans text-xs text-foreground">
            {unescaped}
          </pre>
        ) : (
          <span className="theme-json-string break-words">&quot;{unescaped}&quot;</span>
        )}
      </div>
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return (
      <div className="flex items-baseline gap-1.5 py-0.5 font-mono text-xs">
        {name !== undefined && <span className="theme-json-key font-medium">{name}:</span>}
        <span className={typeof value === "number" ? "theme-json-number" : "theme-json-constant"}>
          {String(value)}
        </span>
      </div>
    );
  }
  if (Array.isArray(value)) {
    return (
      <details open={depth < 2} className="my-0.5 rounded border border-border/60 bg-card/40 pl-2">
        <summary className="cursor-pointer py-1 pr-2 font-mono text-xs select-none">
          {name !== undefined && <span className="theme-json-key mr-1.5 font-medium">{name}</span>}
          <span className="text-muted-foreground">Array[{value.length}]</span>
        </summary>
        <div className="border-l border-border/60 pl-3 pb-1">
          {value.length === 0 ? (
            <span className="font-mono text-xs text-muted-foreground">[]</span>
          ) : (
            value.map((entry, idx) => (
              <JsonTreeNode key={idx} name={`[${idx}]`} value={entry} depth={depth + 1} />
            ))
          )}
        </div>
      </details>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    <details open={depth < 2} className="my-0.5 rounded border border-border/60 bg-card/40 pl-2">
      <summary className="cursor-pointer py-1 pr-2 font-mono text-xs select-none">
        {name !== undefined && <span className="theme-json-key mr-1.5 font-medium">{name}</span>}
        <span className="text-muted-foreground">Object({entries.length})</span>
      </summary>
      <div className="border-l border-border/60 pl-3 pb-1">
        {entries.length === 0 ? (
          <span className="font-mono text-xs text-muted-foreground">{"{}"}</span>
        ) : (
          entries.map(([key, entryVal]) => (
            <JsonTreeNode key={key} name={key} value={entryVal} depth={depth + 1} />
          ))
        )}
      </div>
    </details>
  );
}

function markdownComponents(
  project: EnvironmentProject,
  occurrences: ReturnType<typeof wikiReaderMarkdown>["occurrences"],
): Components {
  const documentRef = { environmentId: project.environmentId, projectId: project.id };
  return {
    a({ href, children }) {
      const ref = /^#wiki-ref-(\d+)$/.exec(href ?? "");
      const index = ref ? Number(ref[1]) : -1;
      const occurrence = occurrences[index];
      if (occurrence?.targetItemId)
        return (
          <KnowledgeDocLink {...documentRef} itemId={occurrence.targetItemId}>
            {children}
          </KnowledgeDocLink>
        );
      if (occurrence)
        return (
          <button
            type="button"
            className="underline decoration-dotted underline-offset-4"
            onClick={() => document.getElementById("wiki-unresolved-" + index)?.focus()}
          >
            {children}
          </button>
        );
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };
}

export function KnowledgeReader({
  project,
  item,
  links,
  fork,
}: {
  project: EnvironmentProject;
  item: WorkspaceKnowledgeItem;
  links: WorkspaceWikiLinksResult | null;
  fork: WorkspaceKnowledgeItem | undefined;
}) {
  const [viewMode, setViewMode] = useState<KnowledgeViewMode>("summary");
  const [copiedRaw, setCopiedRaw] = useState(false);
  const documentRef = { environmentId: project.environmentId, projectId: project.id };
  const structured = useMemo(() => parseStructuredKnowledgeContent(item.content), [item.content]);
  const { markdown, occurrences } = useMemo(
    () => wikiReaderMarkdown(structured.readableMarkdown, links?.outgoing ?? []),
    [structured.readableMarkdown, links],
  );
  const components = useMemo(
    () => markdownComponents(project, occurrences),
    [project, occurrences],
  );
  const threadId = item.provenance?.threadId ?? item.research?.attachment?.threadId;
  const runId = item.provenance?.runId;
  const provenance = item.provenance;
  const nodeIds = [
    ...new Set([
      ...(provenance?.nodeIds ?? []),
      ...(provenance?.nodeId ? [provenance.nodeId] : []),
    ]),
  ];
  const documentStructureFallback = useMemo(
    () => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      tags: item.tags,
      promptUses: item.promptUses,
      lastUsedAt: item.lastUsedAt,
      sections: structured.readableMarkdown
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean),
    }),
    [
      item.id,
      item.kind,
      item.lastUsedAt,
      item.promptUses,
      item.status,
      item.tags,
      item.title,
      structured.readableMarkdown,
    ],
  );
  return (
    <div className="grid min-w-0 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,21rem)]">
      <div className="grid min-w-0 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-2">
          <div
            role="tablist"
            aria-label="문서 보기 모드"
            className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border/80 bg-muted/40 p-0.5"
          >
            {VIEW_MODES.map((mode) => {
              const active = viewMode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setViewMode(mode.id)}
                  className={
                    active
                      ? "cursor-pointer rounded-md bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-xs"
                      : "cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  }
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {structured.isJson && (
              <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground">
                JSON 자동 해석됨
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(item.content).then(() => {
                  setCopiedRaw(true);
                  window.setTimeout(() => setCopiedRaw(false), 1800);
                });
              }}
              className="cursor-pointer rounded border border-border/80 px-2 py-0.5 text-[11px] text-foreground hover:bg-accent"
            >
              {copiedRaw ? "복사됨" : "원본 복사"}
            </button>
          </div>
        </div>
        {viewMode === "summary" ? (
          <article className="chat-markdown min-w-0 break-words text-sm leading-relaxed">
            <Markdown remarkPlugins={[remarkGfm]} components={components}>
              {links ? markdown : structured.readableMarkdown}
            </Markdown>
            {item.research?.design && (
              <DesignReferencePreview
                environmentId={project.environmentId}
                reference={item.research.design}
              />
            )}
          </article>
        ) : viewMode === "json-tree" ? (
          <section
            aria-label="JSON 구조 트리"
            className="min-w-0 rounded-xl border border-border bg-card/60 p-3"
          >
            {!structured.isJson && (
              <p className="mb-2 text-xs text-muted-foreground">
                순수 JSON 문서가 아니므로 문서 메타데이터와 문단 구조를 트리로 표시합니다.
              </p>
            )}
            <JsonTreeNode
              name={structured.isJson ? "root" : "document"}
              value={structured.isJson ? structured.parsed : documentStructureFallback}
            />
          </section>
        ) : (
          <section aria-label="원본 내용" className="min-w-0">
            <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
              {item.content}
            </pre>
          </section>
        )}
      </div>
      <aside className="grid min-w-0 gap-5 break-words rounded-xl border p-4 text-sm">
        <section>
          <h2 className="font-semibold">출처</h2>
          <dl className="my-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt>담당 에이전트 (역할)</dt>
            <dd>
              {provenance?.actor === "user"
                ? "사용자 대화 입력 (자동 압축 RAG)"
                : (provenance?.actor ?? "미확인")}
            </dd>
            <dt>신뢰도</dt>
            <dd>
              {provenance?.confidence
                ? (confidenceLabels[provenance.confidence] ?? "미확인")
                : "미확인"}
            </dd>
            <dt>출력 모델</dt>
            <dd className="break-all">{provenance?.modelSelection?.model ?? "미확인"}</dd>
            <dt>제공자 인스턴스</dt>
            <dd className="break-all">{provenance?.modelSelection?.instanceId ?? "미확인"}</dd>
          </dl>
          {runId && (
            <Link
              to="/control-center/$environmentId/$projectId"
              params={documentRef}
              search={{ knowledgeRun: runId }}
              className="block text-primary underline"
            >
              원본 실행 열기
            </Link>
          )}
          {nodeIds.length > 0 && (
            <p className="break-all text-xs">작업 노드 · {nodeIds.join(", ")}</p>
          )}
          {threadId && (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: project.environmentId, threadId }}
              className="text-primary underline"
            >
              원본 대화 열기
            </Link>
          )}
        </section>
        {links && (
          <>
            <section>
              <h2 className="font-semibold">이 문서의 링크</h2>
              {occurrences.some((o) => o.targetItemId) ? (
                <ul>
                  {occurrences.map(
                    (link) =>
                      link.targetItemId && (
                        <li key={link.start}>
                          <KnowledgeDocLink {...documentRef} itemId={link.targetItemId}>
                            {link.alias ?? link.targetTitle}
                          </KnowledgeDocLink>
                          <p className="text-xs text-muted-foreground">{link.context}</p>
                        </li>
                      ),
                  )}
                </ul>
              ) : (
                <p>연결된 링크가 없습니다.</p>
              )}
            </section>
            <section>
              <h2 className="font-semibold">이 문서를 가리키는 링크</h2>
              {links.backlinks.length ? (
                <ul>
                  {links.backlinks.map((link) => (
                    <li key={link.sourceItemId + ":" + link.start}>
                      <KnowledgeDocLink {...documentRef} itemId={link.sourceItemId}>
                        {link.sourceTitle}
                      </KnowledgeDocLink>
                      <p className="text-xs text-muted-foreground">{link.context}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>이 문서를 가리키는 링크가 없습니다.</p>
              )}
            </section>
            {occurrences.some((o) => !o.targetItemId) && (
              <section>
                <h2 className="font-semibold">미해결 링크</h2>
                <ul>
                  {occurrences.map(
                    (link, index) =>
                      !link.targetItemId && (
                        <li key={link.start} id={"wiki-unresolved-" + index} tabIndex={-1}>
                          {link.targetTitle}
                          <p className="text-xs text-muted-foreground">{link.context}</p>
                        </li>
                      ),
                  )}
                </ul>
                {item.status !== "archived" && (
                  <KnowledgeDocLink {...documentRef} itemId={fork?.id ?? item.id} view="edit">
                    편집기에서 연결할 문서 선택
                  </KnowledgeDocLink>
                )}
              </section>
            )}
          </>
        )}
        <section>
          <h2 className="font-semibold">관련 문서</h2>
          {item.supersededBy && (
            <KnowledgeDocLink
              {...documentRef}
              itemId={item.supersededBy}
              className="block text-primary underline"
            >
              병합 대표 문서
            </KnowledgeDocLink>
          )}
          {item.sourceItemId && (
            <KnowledgeDocLink
              {...documentRef}
              itemId={item.sourceItemId}
              className="block text-primary underline"
            >
              자동 수집 원본
            </KnowledgeDocLink>
          )}
          {fork && (
            <KnowledgeDocLink
              {...documentRef}
              itemId={fork.id}
              className="block text-primary underline"
            >
              사용자 편집본 · {fork.title}
            </KnowledgeDocLink>
          )}
          {item.research?.lineage?.supersedes?.map((id) => (
            <KnowledgeDocLink
              {...documentRef}
              key={id}
              itemId={id}
              className="block text-primary underline"
            >
              이 문서가 대체한 문서 · {id}
            </KnowledgeDocLink>
          ))}
          {runId && <RunKnowledgeDocuments project={project} runId={runId} omitItemId={item.id} />}
          {!item.sourceItemId &&
            !item.supersededBy &&
            !item.research?.lineage?.supersedes?.length &&
            !fork &&
            !runId && <p>연결된 관련 문서가 없습니다.</p>}
        </section>
      </aside>
    </div>
  );
}
