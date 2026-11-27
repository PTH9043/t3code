import * as Schema from "effect/Schema";
import type { WorkspaceCollaborationRun } from "@t3tools/contracts";

export function orchestraExecutionId(
  run: WorkspaceCollaborationRun,
  nodeId: string,
  attempt: number,
): string {
  const cycle = run.meeting?.continuation?.cycle;
  return `orchestra:${run.id}:${cycle ? `cycle-${cycle}-` : ""}${nodeId}:${attempt}`;
}

const Verdict = Schema.Struct({
  decision: Schema.Literals(["complete", "continue", "blocked"]),
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  nextTask: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
});

export function parsePersistentVerdict(output: string): typeof Verdict.Type {
  const match = /<t3_persistent_verdict>\s*([\s\S]*?)\s*<\/t3_persistent_verdict>/u.exec(output);
  if (!match) throw new Error("감독 AI의 지속 작업 판단을 확인하지 못했습니다.");
  const verdict = Schema.decodeUnknownSync(Schema.fromJsonString(Verdict))(match[1]);
  if (!verdict.summary.trim()) throw new Error("감독 AI의 진행 요약이 비어 있습니다.");
  if (verdict.decision === "continue" && !verdict.nextTask?.trim())
    throw new Error("감독 AI가 이어서 할 작업을 지정하지 않았습니다.");
  return verdict;
}
