import type { WorkspaceKnowledgeArchiveSnapshot, WorkspaceKnowledgeItem } from "@t3tools/contracts";
import {
  analyzeUserSpeechStyle,
  formatUserSpeechProfileMarkdown,
  type UserSpeechStyleProfile,
} from "@t3tools/shared/userSpeechProfile";

export type KnowledgeExportScope = "all" | "user_only" | "ai_only";

export type ExportInput = {
  projectId: string;
  projectTitle: string;
  exportedAt: string;
  items: readonly WorkspaceKnowledgeItem[];
  archiveSnapshot: WorkspaceKnowledgeArchiveSnapshot;
  scope?: KnowledgeExportScope;
};

export interface SeparatedKnowledgeCorpora {
  readonly userDialogueAndStyle: {
    readonly speechProfile: UserSpeechStyleProfile;
    readonly speechProfileMarkdown: string;
    readonly userMessages: readonly unknown[];
    readonly userKnowledgeItems: readonly WorkspaceKnowledgeItem[];
    readonly userMemories: readonly unknown[];
  };
  readonly aiResearchAndOutputs: {
    readonly assistantMessages: readonly unknown[];
    readonly aiKnowledgeItems: readonly WorkspaceKnowledgeItem[];
    readonly aiMemories: readonly unknown[];
    readonly activities: readonly unknown[];
    readonly plans: readonly unknown[];
  };
}

function asRecord(row: unknown): Readonly<Record<string, unknown>> | null {
  return row !== null && typeof row === "object" && !Array.isArray(row)
    ? (row as Readonly<Record<string, unknown>>)
    : null;
}

function isUserMessageRow(row: unknown): boolean {
  const rec = asRecord(row);
  if (!rec) return false;
  if (typeof rec.role === "string") return rec.role === "user";
  return false;
}

function isAssistantMessageRow(row: unknown): boolean {
  const rec = asRecord(row);
  if (!rec) return false;
  if (typeof rec.role === "string") return rec.role !== "user";
  return false;
}

function isUserMemoryRow(row: unknown): boolean {
  const rec = asRecord(row);
  if (!rec) return false;
  const origin = typeof rec.origin === "string" ? rec.origin : "";
  const verification = typeof rec.verification === "string" ? rec.verification : "";
  return origin === "user" || origin === "user-requested" || verification === "user-statement";
}

export function buildSeparatedKnowledgeCorpora(input: ExportInput): SeparatedKnowledgeCorpora {
  const threadTitleById = new Map<string, string>();
  for (const thread of input.archiveSnapshot.threads) {
    const rec = asRecord(thread);
    const id =
      typeof rec?.thread_id === "string"
        ? rec.thread_id
        : typeof rec?.id === "string"
          ? rec.id
          : "";
    const title = typeof rec?.title === "string" ? rec.title : "";
    if (id && title) threadTitleById.set(id, title);
  }

  const userMessages = input.archiveSnapshot.messages.filter(isUserMessageRow);
  const assistantMessages = input.archiveSnapshot.messages.filter(isAssistantMessageRow);
  const userKnowledgeItems = input.items.filter((item) => item.origin === "user");
  const aiKnowledgeItems = input.items.filter((item) => item.origin !== "user");
  const userMemories = input.archiveSnapshot.memories.filter(isUserMemoryRow);
  const aiMemories = input.archiveSnapshot.memories.filter((row) => !isUserMemoryRow(row));

  const utteranceInputs = userMessages
    .map((row) => {
      const rec = asRecord(row);
      const text = typeof rec?.text === "string" ? rec.text : "";
      const threadId = typeof rec?.thread_id === "string" ? rec.thread_id : null;
      return {
        id: typeof rec?.message_id === "string" ? rec.message_id : undefined,
        threadId,
        threadTitle: threadId ? (threadTitleById.get(threadId) ?? null) : null,
        text,
        createdAt: typeof rec?.created_at === "string" ? rec.created_at : null,
      };
    })
    .filter((u) => u.text.trim().length > 0);

  const speechProfile = analyzeUserSpeechStyle(utteranceInputs);
  const speechProfileMarkdown = formatUserSpeechProfileMarkdown(speechProfile);

  return {
    userDialogueAndStyle: {
      speechProfile,
      speechProfileMarkdown,
      userMessages,
      userKnowledgeItems,
      userMemories,
    },
    aiResearchAndOutputs: {
      assistantMessages,
      aiKnowledgeItems,
      aiMemories,
      activities: input.archiveSnapshot.activities,
      plans: input.archiveSnapshot.plans,
    },
  };
}

/** The source text and associated records are preserved in the JSON snapshot. */
export function serializeWorkspaceKnowledgeExport(input: ExportInput): string {
  const scope: KnowledgeExportScope = input.scope ?? "all";
  const corpora = buildSeparatedKnowledgeCorpora(input);

  if (scope === "user_only") {
    return JSON.stringify(
      {
        format: "t3-workspace-knowledge",
        version: 2,
        exportScope: "user_only",
        exportedAt: input.exportedAt,
        project: { id: input.projectId, title: input.projectTitle },
        count: corpora.userDialogueAndStyle.userKnowledgeItems.length,
        items: corpora.userDialogueAndStyle.userKnowledgeItems,
        archiveSnapshot: {
          memories: corpora.userDialogueAndStyle.userMemories,
          sourceArchives: [],
          importedSources: [],
          threads: input.archiveSnapshot.threads,
          messages: corpora.userDialogueAndStyle.userMessages,
          activities: [],
          plans: [],
          turns: [],
        },
        separatedCorpora: {
          userDialogueAndStyle: corpora.userDialogueAndStyle,
          aiResearchAndOutputs: null,
        },
      },
      null,
      2,
    );
  }

  if (scope === "ai_only") {
    return JSON.stringify(
      {
        format: "t3-workspace-knowledge",
        version: 2,
        exportScope: "ai_only",
        exportedAt: input.exportedAt,
        project: { id: input.projectId, title: input.projectTitle },
        count: corpora.aiResearchAndOutputs.aiKnowledgeItems.length,
        items: corpora.aiResearchAndOutputs.aiKnowledgeItems,
        archiveSnapshot: {
          memories: corpora.aiResearchAndOutputs.aiMemories,
          sourceArchives: input.archiveSnapshot.sourceArchives,
          importedSources: input.archiveSnapshot.importedSources,
          threads: input.archiveSnapshot.threads,
          messages: corpora.aiResearchAndOutputs.assistantMessages,
          activities: corpora.aiResearchAndOutputs.activities,
          plans: corpora.aiResearchAndOutputs.plans,
          turns: input.archiveSnapshot.turns,
        },
        separatedCorpora: {
          userDialogueAndStyle: null,
          aiResearchAndOutputs: corpora.aiResearchAndOutputs,
        },
      },
      null,
      2,
    );
  }

  return JSON.stringify(
    {
      format: "t3-workspace-knowledge",
      version: 2,
      exportScope: "all",
      exportedAt: input.exportedAt,
      project: { id: input.projectId, title: input.projectTitle },
      count: input.items.length,
      items: input.items,
      archiveSnapshot: input.archiveSnapshot,
      separatedCorpora: corpora,
    },
    null,
    2,
  );
}

/** Human-readable Markdown export keeping User Utterances & Speech Style strictly separated from AI Outputs. */
export function serializeWorkspaceKnowledgeMarkdown(input: ExportInput): string {
  const scope: KnowledgeExportScope = input.scope ?? "all";
  const corpora = buildSeparatedKnowledgeCorpora(input);
  const scopeLabel =
    scope === "user_only"
      ? "내 대화·말투 전용"
      : scope === "ai_only"
        ? "AI 작성·조사 결과 전용"
        : "전체 (내 대화·말투 / AI 결과 분리 보관)";
  const lines: string[] = [
    `# ${input.projectTitle} · 기억 분리 내보내기 (${scopeLabel})`,
    "",
    `- 내보낸 시각: ${input.exportedAt}`,
    `- 프로젝트 ID: ${input.projectId}`,
    `- 내보내기 구분: ${scopeLabel}`,
    "",
  ];

  if (scope !== "ai_only") {
    lines.push(
      "---",
      "",
      corpora.userDialogueAndStyle.speechProfileMarkdown.trim(),
      "",
      `## 내 대화 원문 보관소 (${corpora.userDialogueAndStyle.userMessages.length}건)`,
      "",
    );
    if (corpora.userDialogueAndStyle.userMessages.length === 0) {
      lines.push("(저장된 사용자 대화 원문이 없습니다.)", "");
    } else {
      for (const row of corpora.userDialogueAndStyle.userMessages) {
        const rec = asRecord(row);
        const createdAt = typeof rec?.created_at === "string" ? rec.created_at : "";
        const threadId = typeof rec?.thread_id === "string" ? rec.thread_id : "";
        const messageId = typeof rec?.message_id === "string" ? rec.message_id : "";
        const text = typeof rec?.text === "string" ? rec.text : JSON.stringify(row);
        lines.push(
          `### [내 발화] ${createdAt}${threadId ? ` · thread:${threadId}` : ""}${messageId ? ` · message:${messageId}` : ""}`,
          "",
          text.trim(),
          "",
        );
      }
    }
    if (corpora.userDialogueAndStyle.userKnowledgeItems.length > 0) {
      lines.push(
        `## 내가 직접 등록한 지식·지침 (${corpora.userDialogueAndStyle.userKnowledgeItems.length}건)`,
        "",
      );
      for (const item of corpora.userDialogueAndStyle.userKnowledgeItems) {
        lines.push(
          `### ${item.title} (${item.kind} · ${item.status})`,
          "",
          item.content.trim(),
          "",
        );
      }
    }
  }

  if (scope !== "user_only") {
    lines.push(
      "---",
      "",
      `## AI 작성·조사 결과 보관소 (응답 ${corpora.aiResearchAndOutputs.assistantMessages.length}건 · 조사 지식 ${corpora.aiResearchAndOutputs.aiKnowledgeItems.length}건)`,
      "",
    );
    for (const item of corpora.aiResearchAndOutputs.aiKnowledgeItems) {
      lines.push(
        `### [AI 지식·협업] ${item.title} (${item.kind} · ${item.origin})`,
        "",
        item.content.trim(),
        "",
      );
    }
    for (const row of corpora.aiResearchAndOutputs.assistantMessages) {
      const rec = asRecord(row);
      const createdAt = typeof rec?.created_at === "string" ? rec.created_at : "";
      const threadId = typeof rec?.thread_id === "string" ? rec.thread_id : "";
      const messageId = typeof rec?.message_id === "string" ? rec.message_id : "";
      const text = typeof rec?.text === "string" ? rec.text : JSON.stringify(row);
      lines.push(
        `### [AI 응답] ${createdAt}${threadId ? ` · thread:${threadId}` : ""}${messageId ? ` · message:${messageId}` : ""}`,
        "",
        text.trim(),
        "",
      );
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

/** Printable view: no source text is interpreted as HTML or script. */
export function renderWorkspaceKnowledgePrintView(input: ExportInput): string {
  const scope: KnowledgeExportScope = input.scope ?? "all";
  const corpora = buildSeparatedKnowledgeCorpora(input);
  const groups: Array<readonly [string, readonly unknown[]]> = [];

  if (scope === "user_only") {
    groups.push(
      [
        "내 말투·화법 프로필",
        [
          {
            title: "내 말투·화법 분석 요약",
            content: corpora.userDialogueAndStyle.speechProfileMarkdown,
          },
        ],
      ],
      ["내가 등록한 프로젝트 지식", corpora.userDialogueAndStyle.userKnowledgeItems],
      ["내 별도 장기기억", corpora.userDialogueAndStyle.userMemories],
      ["내 대화 원문 (AI 응답 제외)", corpora.userDialogueAndStyle.userMessages],
    );
  } else if (scope === "ai_only") {
    groups.push(
      ["AI 작성·조사 지식과 RAG", corpora.aiResearchAndOutputs.aiKnowledgeItems],
      ["AI 별도 장기기억", corpora.aiResearchAndOutputs.aiMemories],
      ["AI 응답 원문 (사용자 발화 제외)", corpora.aiResearchAndOutputs.assistantMessages],
      ["대화 활동", corpora.aiResearchAndOutputs.activities],
      ["대화 계획", corpora.aiResearchAndOutputs.plans],
      ["보관된 대화 원본", input.archiveSnapshot.sourceArchives],
      ["가져온 대화 원본", input.archiveSnapshot.importedSources],
    );
  } else {
    groups.push(
      [
        "내 말투·화법 프로필 (분리 보관)",
        [
          {
            title: "내 말투·화법 분석 요약",
            content: corpora.userDialogueAndStyle.speechProfileMarkdown,
          },
        ],
      ],
      ["내 대화 원문 (분리 보관)", corpora.userDialogueAndStyle.userMessages],
      ["AI 응답 원문 (분리 보관)", corpora.aiResearchAndOutputs.assistantMessages],
      ["프로젝트 지식과 RAG", input.items],
      ["별도 장기기억", input.archiveSnapshot.memories],
      ["보관된 대화 원본", input.archiveSnapshot.sourceArchives],
      ["가져온 대화 원본", input.archiveSnapshot.importedSources],
      ["대화", input.archiveSnapshot.threads],
      ["대화 메시지 원문", input.archiveSnapshot.messages],
      ["대화 활동", input.archiveSnapshot.activities],
      ["대화 계획", input.archiveSnapshot.plans],
      ["대화 턴", input.archiveSnapshot.turns],
    );
  }

  const renderRecord = (row: unknown) => {
    if (row === null || typeof row !== "object" || Array.isArray(row))
      return `<article><pre>${escapeHtml(JSON.stringify(row, null, 2) ?? "null")}</pre></article>`;
    const record = row as Readonly<Record<string, unknown>>;
    const headingKey = ["title", "topic", "summary"].find((key) => typeof record[key] === "string");
    const bodyKey = ["content", "text", "plan_markdown"].find(
      (key) => typeof record[key] === "string",
    );
    const metadata = Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== headingKey && key !== bodyKey),
    );
    const heading = headingKey ? `<h3>${escapeHtml(String(record[headingKey]))}</h3>` : "";
    const body = bodyKey
      ? `<div class="record-body">${escapeHtml(String(record[bodyKey]))}</div>`
      : "";
    return `<article>${heading}${body}<p class="metadata-label">기록 정보</p><pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre></article>`;
  };
  const sections = groups
    .map(
      ([title, rows]) =>
        `<section><h2>${escapeHtml(title)} (${rows.length}건)</h2>${rows.map(renderRecord).join("")}</section>`,
    )
    .join("");
  const headingSuffix =
    scope === "user_only"
      ? "내 대화·말투 분리 내보내기"
      : scope === "ai_only"
        ? "AI 작성·조사 결과 분리 내보내기"
        : "전체 기억 내보내기";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(input.projectTitle)} 기억 내보내기</title><style>
    body{font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif;margin:2rem;color:#171717}
    h1,h2{overflow-wrap:anywhere} pre{white-space:pre-wrap;overflow-wrap:anywhere;font:10pt/1.45 monospace}
    article{border-top:1px solid #ddd;padding:.5rem 0} article h3{margin:.5rem 0} .record-body{white-space:pre-wrap;overflow-wrap:anywhere} .metadata-label{color:#555;font-size:9pt;margin-bottom:0}
    @media print{body{margin:0}h2{break-after:avoid}article{break-inside:auto}}
  </style></head><body>
  <h1>${escapeHtml(input.projectTitle)} · ${headingSuffix}</h1><p>시각: ${escapeHtml(input.exportedAt)}</p>
  <p>대화 원문에는 기억에서 제외한 메시지도 포함될 수 있습니다. 첨부 파일 자체와 삭제한 대화는 포함하지 않습니다.</p>${sections}</body></html>`;
}
