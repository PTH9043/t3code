import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { writeFileStringAtomically } from "../atomicWrite.ts";

export const contextArtifactHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

export interface WorkspaceContextArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly chars: number;
}

/** An immutable source is readable and hash-checked before any detail is omitted. */
export const saveWorkspaceContextArtifact = Effect.fn("saveWorkspaceContextArtifact")(
  function* (input: {
    readonly stateDir: string;
    readonly projectId: string;
    readonly runId: string;
    readonly content: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sha256 = contextArtifactHash(input.content);
    const filePath = path.join(
      input.stateDir,
      "workspace-context",
      contextArtifactHash(`${input.projectId.length}:${input.projectId}${input.runId}`),
      `${sha256}.txt`,
    );
    return yield* Effect.gen(function* () {
      if (
        !(yield* fs.exists(filePath)) ||
        contextArtifactHash(yield* fs.readFileString(filePath)) !== sha256
      ) {
        yield* writeFileStringAtomically({ filePath, contents: input.content });
      }
      if (contextArtifactHash(yield* fs.readFileString(filePath)) !== sha256) return null;
      return {
        path: filePath,
        sha256,
        chars: input.content.length,
      } satisfies WorkspaceContextArtifact;
    }).pipe(Effect.catch(() => Effect.succeed(null)));
  },
);

function formatArtifactPath(filePath: string): string {
  return /[\r\n\t"]/.test(filePath) ? JSON.stringify(filePath) : filePath;
}

export function renderContextArtifact(source: WorkspaceContextArtifact): string {
  return [
    `원문 파일: ${formatArtifactPath(source.path)}; SHA-256: ${source.sha256}; ${source.chars}자.`,
    '이 파일은 이 작업의 인계 근거다. 필요한 제목/식별자를 검색한 뒤 해당 문단·줄 범위만 읽어라. 원문을 읽을 수 없거나 현재 내용과 hash가 다르면 누락을 알리고, 결과를 추측하거나 검증을 통과한 것으로 처리하지 마라. (Windows cmd.exe에서는 경로에 \\" 이스케이프를 쓰지 말고 그대로 전달하거나 node/python으로 확인하라.)',
  ].join("\n");
}

/** Persisted previews must retain an exact, readable source instead of cutting a final verdict away. */
export function boundedEvidencePreview(
  content: string,
  source: WorkspaceContextArtifact,
  maxChars: number,
): string | null {
  if (content.length <= maxChars) return content;
  if (source.chars !== content.length || source.sha256 !== contextArtifactHash(content))
    return null;
  const notice =
    "[일부 미리보기입니다. 이 미리보기만으로 검증을 통과시키지 마세요. 원문에서 근거·반대·미완료 상태를 확인한 뒤 판단하세요.]\n" +
    renderContextArtifact(source);
  const available = maxChars - notice.length - 2;
  if (available < 0) return null;
  const boundary = content.lastIndexOf("\n\n", available);
  return (boundary > 0 ? content.slice(0, boundary) + "\n\n" : "") + notice;
}

const REQUIRED_HANDOFF_SECTIONS = [
  /결론|summary|conclusion|result/iu,
  /변경|산출|changes|artifacts/iu,
  /검사|검증|tests|validation|checks/iu,
  /미완료|미해결|남은|pending|unresolved/iu,
  /근거|evidence|references/iu,
];
const OPTIONAL_DETAILS =
  /^(?:#{1,6}\s*)?(?:상세(?:\s*로그|\s*기록|\s*과정)?|details|raw logs|full log|transcript)\s*[:：]?$/iu;
const PROTECTED_DETAIL =
  /실패|오류|미완료|미해결|반대|이견|보류|주의|없|아니|않|못|fail|error|unresolved|pending|disagree|dissent|blocked|\bnot\b|\bno\b|\bnever\b/iu;

/** Only explicitly labelled detail sections can be omitted; unknown report formats stay whole. */
export function compactEvidenceHandoff(output: string, source?: WorkspaceContextArtifact): string {
  if (source === undefined || output.length < 2_000) return output;
  const sections = output.split(/(?=^#{1,6}\s)/mu).filter(Boolean);
  const headings = sections.map((section) => section.split(/\r?\n/u, 1)[0] ?? "");
  if (
    !REQUIRED_HANDOFF_SECTIONS.every((pattern) => headings.some((heading) => pattern.test(heading)))
  )
    return output;
  const retained = sections.filter(
    (section, index) => !OPTIONAL_DETAILS.test(headings[index]!) || PROTECTED_DETAIL.test(section),
  );
  if (retained.length === sections.length) return output;
  const compact = [...retained, renderContextArtifact(source)].join("\n\n");
  return compact.length < output.length ? compact : output;
}
