import type { WorkspaceMeeting, WorkspaceMeetingQuestion } from "@t3tools/contracts";
import { useState } from "react";
import { CrownIcon, MessageCircleQuestionIcon, UsersIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { cn } from "~/lib/utils";
import { formatMeetingProtocolText } from "~/meetingProtocolText";

const MODE_LABELS: Record<WorkspaceMeeting["mode"], string> = {
  "fixed-rounds": "고정 라운드",
  "until-consensus": "합의까지",
  "free-form": "자유 토론",
};

const PHASE_LABELS: Record<WorkspaceMeeting["phase"], string> = {
  clarifying: "지휘 AI 확인",
  discussing: "토론 중",
  planning: "계획 수립",
  executing: "실행 중",
  done: "완료",
};

function participantName(meeting: WorkspaceMeeting, participantId: string | null): string {
  if (participantId === null) return "서버";
  return (
    meeting.participants.find((participant) => participant.id === participantId)?.displayName ??
    participantId
  );
}

type RoundTranscriptEntry =
  | {
      readonly kind: "statement";
      readonly statement: WorkspaceMeeting["rounds"][number]["statements"][number];
    }
  | {
      readonly kind: "interjection";
      readonly interjection: WorkspaceMeeting["interjections"][number];
    };

/** Statements and the person's interjections, in true speaking order. */
function mergeRoundTranscript(
  meeting: WorkspaceMeeting,
  round: WorkspaceMeeting["rounds"][number],
): RoundTranscriptEntry[] {
  const interjections = meeting.interjections.filter(
    (interjection) => interjection.roundIndex === round.index,
  );
  const entries: RoundTranscriptEntry[] = [];
  const pushInterjectionsAt = (position: number) => {
    for (const interjection of interjections) {
      if (interjection.afterStatements === position) {
        entries.push({ kind: "interjection", interjection });
      }
    }
  };
  pushInterjectionsAt(0);
  round.statements.forEach((statement, index) => {
    entries.push({ kind: "statement", statement });
    pushInterjectionsAt(index + 1);
  });
  for (const interjection of interjections) {
    if (interjection.afterStatements > round.statements.length) {
      entries.push({ kind: "interjection", interjection });
    }
  }
  return entries;
}

/**
 * The meeting half of a collaboration run: who sat, what each round said, and
 * — when the run is parked — the question the person owes an answer to.
 */
export function WorkspaceMeetingView(props: {
  readonly meeting: WorkspaceMeeting;
  /** Answering is only offered while the run can still resume. */
  readonly canAnswer: boolean;
  readonly answering: boolean;
  readonly onAnswer: (question: WorkspaceMeetingQuestion, answer: string) => void;
}) {
  const { meeting } = props;
  const pending = meeting.pendingQuestion;
  const questionKey = pending === null ? "" : JSON.stringify([pending.nodeId, pending.askedAt]);
  const [draft, setDraft] = useState({ questionKey: "", text: "" });
  const draftAnswer = draft.questionKey === questionKey ? draft.text : "";
  const setDraftAnswer = (text: string) => setDraft({ questionKey, text });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <Badge variant="outline">
          <UsersIcon className="size-3" /> 오케스트라 · {MODE_LABELS[meeting.mode]}
        </Badge>
        <Badge variant={meeting.phase === "done" ? "success" : "secondary"}>
          {PHASE_LABELS[meeting.phase]}
        </Badge>
        <span>
          {meeting.participants.map((participant) => participant.displayName).join(" · ")} · 최대{" "}
          {meeting.maxRounds}라운드
          {meeting.userInLoop ? " · 라운드마다 확인" : ""}
        </span>
      </div>

      {pending !== null ? (
        <div className="grid gap-2 rounded-xl border border-warning/40 bg-warning/8 p-3">
          <div className="flex items-start gap-2">
            <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">
                {participantName(meeting, pending.askedByParticipantId)}의 질문
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{pending.question}</p>
              {pending.context.length > 0 ? (
                <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">
                  {pending.context}
                </p>
              ) : null}
            </div>
          </div>
          {props.canAnswer ? (
            <>
              {pending.options.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {pending.options.map((option) => (
                    <Button
                      key={option}
                      size="xs"
                      variant="outline"
                      disabled={props.answering}
                      onClick={() => props.onAnswer(pending, option)}
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              ) : null}
              <div className="flex items-end gap-2">
                <Textarea
                  value={draftAnswer}
                  onChange={(event) => setDraftAnswer(event.currentTarget.value)}
                  placeholder="직접 답변 입력..."
                  className="min-h-16 flex-1 text-sm"
                />
                <Button
                  size="sm"
                  disabled={props.answering || draftAnswer.trim().length === 0}
                  onClick={() => {
                    const answer = draftAnswer.trim();
                    if (answer.length === 0) return;
                    props.onAnswer(pending, answer);
                    setDraftAnswer("");
                  }}
                >
                  답변 보내기
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {meeting.rounds.length > 0 ? (
        <div className="grid gap-2">
          {meeting.rounds.map((round) => (
            <details
              key={round.index}
              className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
              open={round.index === meeting.rounds.length - 1}
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold">
                {round.index + 1}라운드
                <span className="font-normal text-muted-foreground">
                  발언 {round.statements.length}건
                </span>
                {round.consensusReached === true ? (
                  <Badge variant="success">합의</Badge>
                ) : round.consensusReached === false ? (
                  <Badge variant="secondary">이견</Badge>
                ) : null}
              </summary>
              <div className="mt-2 grid gap-2">
                {/* A seat speaks at most once per round, so the seat id is the
                    row identity; interjections key on their arrival time. */}
                {mergeRoundTranscript(meeting, round).map((entry) =>
                  entry.kind === "statement" ? (
                    <div key={entry.statement.participantId} className="text-xs">
                      <p className="font-semibold">
                        {participantName(meeting, entry.statement.participantId)}
                        {entry.statement.respondsTo.length > 0 ? (
                          <span className="ml-1 font-normal text-muted-foreground">
                            →{" "}
                            {entry.statement.respondsTo
                              .map((target) => participantName(meeting, target))
                              .join(", ")}
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 line-clamp-6 whitespace-pre-wrap leading-relaxed">
                        {formatMeetingProtocolText(entry.statement.content)}
                      </p>
                    </div>
                  ) : (
                    <div
                      key={`interjection:${entry.interjection.saidAt}`}
                      className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs"
                    >
                      <p className="font-semibold">사용자 (개입)</p>
                      <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">
                        {entry.interjection.text}
                      </p>
                    </div>
                  ),
                )}
                {round.chairSummary !== null ? (
                  <div
                    className={cn(
                      "rounded-md border border-primary/25 bg-primary/5 p-2 text-xs leading-relaxed",
                    )}
                  >
                    <p className="mb-0.5 flex items-center gap-1 font-semibold">
                      <CrownIcon className="size-3" /> 의장 정리
                    </p>
                    <p className="whitespace-pre-wrap">{round.chairSummary}</p>
                  </div>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">아직 발언이 없습니다.</p>
      )}

      {meeting.answers.length > 0 ? (
        <div className="grid gap-1 rounded-lg border border-border/60 p-2 text-xs">
          <p className="font-semibold">사용자 결정</p>
          {meeting.answers.map((answer) => (
            <p key={`${answer.answeredAt}:${answer.question}`} className="text-muted-foreground">
              <span className="text-foreground">{answer.question}</span> → {answer.answer}
              {answer.imageReferences?.length ? (
                <span>
                  {" "}
                  · 이미지: {answer.imageReferences.map((image) => image.name).join(", ")}
                </span>
              ) : null}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
