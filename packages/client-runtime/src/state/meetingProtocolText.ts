/**
 * The meeting protocol rides inside assistant messages as `<t3_*>` tags
 * wrapping JSON — machine payloads the reactor parses. People should never
 * read those raw: this rewrites each completed tag into readable Markdown
 * before the chat renders the message. The stored message is untouched.
 */

const PROTOCOL_TAG_PATTERN =
  /<(t3_chair_verdict|t3_question|t3_task_graph|t3_validation|t3_synthesis|t3_responds_to)>([\s\S]*?)<\/\1>/g;

function parseJsonPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringItems(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

/** Titles of `{title: string}` entries (task-graph nodes, follow-ups, memory candidates). */
function titleItems(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "object" && item !== null
        ? asString((item as Record<string, unknown>).title)
        : null,
    )
    .filter((title): title is string => title !== null);
}

function embeddedQuestionLines(value: unknown): ReadonlyArray<string> {
  if (typeof value !== "object" || value === null) return [];
  const payload = value as Record<string, unknown>;
  const question = asString(payload.question);
  if (!question) return [];
  const lines = [`❓ ${question}`];
  const options = stringItems(payload.options);
  if (options.length > 0) lines.push(`선택지: ${options.join(" · ")}`);
  lines.push("_이 대화창에 답장을 보내면 오케스트라가 이어집니다._");
  return lines;
}

function blockquote(lines: ReadonlyArray<string>): string {
  return `\n${lines
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .split("\n")
        .map((inner) => `> ${inner}`)
        .join("\n"),
    )
    .join("\n")}\n`;
}

/** Unparseable payloads fall back to a fenced block, never raw tags. */
function fallbackBlock(title: string, body: string): string {
  return `\n> **${title}**\n\n\`\`\`json\n${body.trim()}\n\`\`\`\n`;
}

function renderChairVerdict(body: string): string {
  const payload = parseJsonPayload(body);
  if (!payload) return fallbackBlock("👑 의장 정리", body);
  const lines: string[] = ["**👑 의장 정리**"];
  const summary = asString(payload.summary);
  if (summary) lines.push(summary);
  if (payload.consensusReached === true) lines.push("합의: ✅ 도달");
  else if (payload.consensusReached === false) lines.push("합의: ❌ 아직");
  const nextSpeaker = asString(payload.nextSpeakerId);
  if (nextSpeaker) lines.push(`다음 발언: ${nextSpeaker}`);
  lines.push(...embeddedQuestionLines(payload.question));
  return blockquote(lines);
}

function renderQuestion(body: string): string {
  const payload = parseJsonPayload(body);
  if (!payload) return fallbackBlock("❓ 사용자에게 질문", body);
  const lines: string[] = ["**❓ 사용자에게 질문**"];
  const question = asString(payload.question);
  if (question) lines.push(question);
  const options = stringItems(payload.options);
  if (options.length > 0) lines.push(`선택지: ${options.join(" · ")}`);
  const context = asString(payload.context);
  if (context) lines.push(`배경: ${context}`);
  lines.push("_이 대화창에 답장을 보내면 오케스트라가 이어집니다._");
  return blockquote(lines);
}

function renderTaskGraph(body: string): string {
  const payload = parseJsonPayload(body);
  if (!payload) return fallbackBlock("📋 실행 계획", body);
  const lines: string[] = ["**📋 실행 계획**"];
  const summary = asString(payload.summary);
  if (summary) lines.push(summary);
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  if (nodes.length > 0) {
    lines.push(`작업 ${nodes.length}개:`);
    nodes.forEach((raw, index) => {
      if (typeof raw !== "object" || raw === null) return;
      const node = raw as Record<string, unknown>;
      const title = asString(node.title) ?? asString(node.id) ?? `작업 ${index + 1}`;
      const assignee = asString(node.participantId) ?? asString(node.agent);
      const dependsOn = stringItems(node.dependsOn);
      const head = `${index + 1}. **${title}**${assignee ? ` — ${assignee}` : ""}${
        dependsOn.length > 0 ? ` (의존: ${dependsOn.join(", ")})` : ""
      }`;
      const task = asString(node.task);
      lines.push(task ? `${head}\n   ${task}` : head);
    });
  }
  const nextAction = asString(payload.nextAction);
  if (nextAction) lines.push(`다음: ${nextAction}`);
  return blockquote(lines);
}

function renderValidation(body: string): string {
  const payload = parseJsonPayload(body);
  if (!payload) return fallbackBlock("🔍 검증", body);
  const verdict = asString(payload.verdict);
  const icon = verdict === "pass" ? "✅" : verdict === "fail" ? "❌" : "🔍";
  const confidence = asString(payload.confidence);
  const lines: string[] = [
    `**${icon} 검증${verdict ? ` · ${verdict}` : ""}${confidence ? ` · 신뢰도 ${confidence}` : ""}**`,
  ];
  const summary = asString(payload.summary);
  if (summary) lines.push(summary);
  const evidence = stringItems(payload.evidence);
  if (evidence.length > 0) {
    lines.push(`증거:\n${evidence.map((item) => `- ${item}`).join("\n")}`);
  }
  const classification = asString(payload.failureClassification);
  if (classification) lines.push(`원인 분류: ${classification}`);
  const followUps = titleItems(payload.followUpNodes);
  if (followUps.length > 0) lines.push(`후속 작업: ${followUps.join(" → ")}`);
  const nextAction = asString(payload.nextAction);
  if (nextAction) lines.push(`다음: ${nextAction}`);
  return blockquote(lines);
}

function renderSynthesis(body: string): string {
  const payload = parseJsonPayload(body);
  if (!payload) return fallbackBlock("🏁 최종 결과", body);
  const confidence = asString(payload.confidence);
  const lines: string[] = [`**🏁 최종 결과${confidence ? ` · 신뢰도 ${confidence}` : ""}**`];
  const finalOutput = asString(payload.finalOutput);
  if (finalOutput) lines.push(finalOutput);
  if (payload.conflictDetected === true) {
    lines.push("⚠️ 검증된 결과 사이에 충돌이 남아 교차 검증이 이어집니다.");
  }
  if (payload.repairApproved === true) lines.push("재시작 승인: ✅");
  else if (payload.repairApproved === false) lines.push("재시작 승인: ❌");
  const memories = titleItems(payload.memoryCandidates);
  if (memories.length > 0) lines.push(`메모리 후보: ${memories.join(" · ")}`);
  const nextAction = asString(payload.nextAction);
  if (nextAction) lines.push(`다음: ${nextAction}`);
  return blockquote(lines);
}

const TAG_TITLES: Record<string, string> = {
  t3_chair_verdict: "👑 의장 정리",
  t3_question: "❓ 사용자에게 질문",
  t3_task_graph: "📋 실행 계획",
  t3_validation: "🔍 검증",
  t3_synthesis: "🏁 최종 결과",
};

/** Best-effort read of one string field out of a JSON payload still streaming in. */
function extractPartialString(body: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(body);
  if (!match || match[1] === undefined) return null;
  const value = match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
  return value.length > 0 ? value : null;
}

/**
 * A tag still being written out must not sit on screen as raw JSON for the
 * seconds (or minutes) the model spends typing it. Show a live block with
 * whatever readable text has arrived; the completed render replaces it.
 */
function renderStreamingTag(tag: string, body: string): string {
  if (tag === "t3_responds_to") return "";
  const title = TAG_TITLES[tag] ?? "오케스트라 메시지";
  const partial =
    extractPartialString(body, "summary") ??
    extractPartialString(body, "question") ??
    extractPartialString(body, "finalOutput");
  const lines = [`**${title}** _(작성 중…)_`];
  if (partial) lines.push(partial);
  return blockquote(lines);
}

function renderRespondsTo(body: string): string {
  const targets = body
    .split(",")
    .map((target) => target.trim())
    .filter((target) => target.length > 0);
  if (targets.length === 0) return "";
  return `\n_↩︎ ${targets.join(", ")}에게_\n`;
}

/**
 * Rewrite every COMPLETED protocol tag into readable Markdown, and render a
 * tag still streaming in (no closing tag yet) as a live "작성 중" block so raw
 * JSON never sits on screen while the model types it out.
 */
export function formatMeetingProtocolText(text: string): string {
  if (!text.includes("<t3_")) return text;
  const completed = text.replace(PROTOCOL_TAG_PATTERN, (_match, tag: string, body: string) => {
    switch (tag) {
      case "t3_chair_verdict":
        return renderChairVerdict(body);
      case "t3_question":
        return renderQuestion(body);
      case "t3_task_graph":
        return renderTaskGraph(body);
      case "t3_validation":
        return renderValidation(body);
      case "t3_synthesis":
        return renderSynthesis(body);
      case "t3_responds_to":
        return renderRespondsTo(body);
      default:
        return "";
    }
  });
  return completed.replace(
    /<(t3_chair_verdict|t3_question|t3_task_graph|t3_validation|t3_synthesis|t3_responds_to)>([\s\S]*)$/,
    (match, tag: string, body: string) =>
      body.includes(`</${tag}>`) ? match : renderStreamingTag(tag, body),
  );
}
