import type { WorkspaceMeeting } from "@t3tools/contracts";
import { renderMeetingTranscript } from "./workspaceMeeting.ts";
import {
  contextArtifactHash,
  renderContextArtifact,
  type WorkspaceContextArtifact,
} from "./workspaceContextArtifacts.ts";

const UNRESOLVED_OR_DISSENT =
  /실패|오류|미완료|미해결|반대|이견|보류|불확실|fail|error|unresolved|pending|disagree|dissent|blocked|uncertain/iu;

/** Reuse a closed summary only for text it actually contains. Uncovered evidence stays verbatim. */
export function renderCompactMeetingContext(
  meeting: WorkspaceMeeting,
  source: WorkspaceContextArtifact | null,
): string {
  const original = renderMeetingTranscript(meeting);
  if (
    source === null ||
    source.chars !== original.length ||
    source.sha256 !== contextArtifactHash(original)
  )
    return original;
  let removed = false;
  const rounds = meeting.rounds.map((round) => {
    if (round.chairSummary === null) return round;
    const summaryParagraphs = new Set(
      round.chairSummary
        .split(/\r?\n\s*\r?\n/u)
        .map((text) => text.trim())
        .filter(Boolean),
    );
    const statements = round.statements.flatMap((statement) => {
      if (statement.respondsTo.length || UNRESOLVED_OR_DISSENT.test(statement.content))
        return [statement];
      // Removing exact quotations requires no summary model or semantic faith in the chair.
      const paragraphs = statement.content.split(/\r?\n\s*\r?\n/u);
      const retained = paragraphs.filter((paragraph) => !summaryParagraphs.has(paragraph.trim()));
      if (retained.length === paragraphs.length) return [statement];
      removed = true;
      return retained.length ? [{ ...statement, content: retained.join("\n\n") }] : [];
    });
    // Keep positions of user interjections even when a preceding statement was removed.
    if (meeting.interjections.some((interjection) => interjection.roundIndex === round.index))
      return round;
    return { ...round, statements };
  });
  if (!removed) return original;
  const compact = [
    renderMeetingTranscript({ ...meeting, rounds }),
    "## 종료 라운드 원문",
    renderContextArtifact(source),
  ].join("\n\n");
  return compact.length < original.length ? compact : original;
}
