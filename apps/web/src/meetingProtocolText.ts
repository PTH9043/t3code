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
  return blockquote(lines);
}

function renderQuestion(body: string): string {
  const payload = parseJsonPayload(body);
  if (!payload) return fallbackBlock("❓ 사용자에게 질문", body);
  const lines: string[] = ["**❓ 사용자에게 질문**"];
  const question = asString(payload.question);
  if (question) lines.push(question);
  if (Array.isArray(payload.options) && payload.options.length > 0) {
    lines.push(
      `선택지: ${payload.options
        .map((option) => (typeof option === "string" ? option : ""))
        .filter((option) => option.length > 0)
        .join(" · ")}`,
    );
  }
  lines.push("_이 대화창에 답장을 보내면 회의가 이어집니다._");
  return blockquote(lines);
}

function renderTaskGraph(body: string): string {
  const payload = parseJsonPayload(body);
  if (!payload) return fallbackBlock("📋 실행 계획", body);
  const lines: string[] = ["**📋 실행 계획**"];
  const summary = asString(payload.summary);
  if (summary) lines.push(summary);
  if (Array.isArray(payload.nodes) && payload.nodes.length > 0) {
    const titles = payload.nodes
      .map((node) =>
        typeof node === "object" && node !== null
          ? asString((node as Record<string, unknown>).title)
          : null,
      )
      .filter((title): title is string => title !== null);
    lines.push(
      `작업 ${payload.nodes.length}개${titles.length > 0 ? `: ${titles.join(" → ")}` : ""}`,
    );
  }
  return blockquote(lines);
}

function renderValidation(body: string): string {
  const payload = parseJsonPayload(body);
  if (!payload) return fallbackBlock("🔍 검증", body);
  const verdict = asString(payload.verdict);
  const icon = verdict === "pass" ? "✅" : verdict === "fail" ? "❌" : "🔍";
  const lines: string[] = [`**${icon} 검증${verdict ? ` · ${verdict}` : ""}**`];
  const summary = asString(payload.summary);
  if (summary) lines.push(summary);
  const nextAction = asString(payload.nextAction);
  if (nextAction) lines.push(`다음: ${nextAction}`);
  return blockquote(lines);
}

function renderSynthesis(body: string): string {
  const payload = parseJsonPayload(body);
  if (!payload) return fallbackBlock("🏁 최종 결과", body);
  const lines: string[] = ["**🏁 최종 결과**"];
  const finalOutput = asString(payload.finalOutput);
  if (finalOutput) lines.push(finalOutput);
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
 * Rewrite every COMPLETED protocol tag into readable Markdown. A tag still
 * streaming in (no closing tag yet) is left alone and converts on the next
 * render once it completes.
 */
export function formatMeetingProtocolText(text: string): string {
  if (!text.includes("<t3_")) return text;
  return text.replace(PROTOCOL_TAG_PATTERN, (_match, tag: string, body: string) => {
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
}
