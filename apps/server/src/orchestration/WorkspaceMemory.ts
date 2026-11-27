// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import {
  analyzeUserSpeechStyle,
  formatUserSpeechProfileMarkdown,
} from "@t3tools/shared/userSpeechProfile";
import {
  type ProjectId,
  type ThreadId,
  type MessageId,
  WorkspaceMemoryError,
  type WorkspaceMemoryAction,
  type WorkspaceMemoryLayerFilter,
  type WorkspaceMemorySpeakerFilter,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  classifyCognitiveMemory,
  classifyMemorySalience,
  type CognitiveMemoryType,
} from "./memorySalience.ts";
import { readHandoffWorkingState } from "./conversationHandoffState.ts";
import { runDreamCrystallizationCycle } from "./workspaceDreamCompiler.ts";
import { knowledgeAppliesToContext } from "./workspaceKnowledgeScope.ts";
import { ServerConfig } from "../config.ts";
import { vramArbiter } from "../background/VramArbiter.ts";
import {
  COLD_OFFLOAD_INACTIVE_MS,
  coldMemoryArchivePath,
  writeColdMemoryGzipArchive,
} from "./coldMemoryArchive.ts";
import { resolveAdaptiveMemoryBudget } from "./workspacePromptTokens.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";
import { readHistorySource } from "../persistence/historySource.ts";
import {
  increment,
  memorySearchDuration,
  memorySearchResultsTotal,
  memorySearchesTotal,
  withMetrics,
} from "../observability/Metrics.ts";
import {
  buildSearchQuery,
  analyzeSearchText,
  chunkSearchableContent,
  CHUNK_OVERLAP,
  termCoverage,
} from "../persistence/searchText.ts";
import {
  computeMemoryRetentionAndHeat,
  hasMemorySearchAnchor,
  isHistoricalMemoryQuery,
  matchedMemoryExcerpt,
  matchedMemoryExcerptRange,
  rankMemoryCandidates4Arm,
  recordMemoryAccessReinforcementEffect,
  selectMemoryEvidence,
  type MemoryTier,
  type WorkspaceMemoryRecord,
} from "./memoryRetrieval.ts";
import { buildTemporalIndexTail, parseKoreanTemporalRange } from "./koreanTemporalParser.ts";
import {
  buildDeterministicContextPrefix,
  extractDecisionCandidate,
  extractMemoryEntities,
  normalizeSpecificSlotEntity,
  synthesizeSubjectObservations,
  type ExtractedDecisionCandidate,
  type MemoryLayer,
} from "./memoryConsolidatorV3.ts";
import { redactMemorySensitiveData } from "./memoryPrivacyGuard.ts";
import {
  memoryHash,
  memoryScopeDirectory,
  publishMemoryFile,
  publishProceduralLessonsFile,
  publishSeparatedConversationCorpora,
  writeHistoryArchive,
  verifyHistoryArchive,
  withdrawMemoryPages,
  archiveMemoryFile,
} from "./memoryFiles.ts";

export type ConsolidationAction = "ADD" | "SUPERSEDE" | "AUGMENT" | "NOOP";

export interface ExtractedSlotFact {
  entityKey: string;
  predicateSlot: string;
  normalizedValue: string;
  isNegationOrRollback: boolean;
}

const CANONICAL_PREDICATE_SLOTS: Readonly<Record<string, string>> = {
  포트: "port",
  port: "port",
  패키지_매니저: "package_manager",
  패키지매니저: "package_manager",
  package_manager: "package_manager",
  데이터베이스: "database",
  db: "database",
  모델: "model",
  model: "model",
  런타임: "runtime",
  runtime: "runtime",
  버전: "version",
  version: "version",
  경로: "path",
  path: "path",
  역할: "role",
  role: "role",
  담당: "owner",
  owner: "owner",
};

const CONVERSATION_USER_TOPIC = "사용자 결정과 정정";
const CONVERSATION_REPORT_TOPIC = "이전 작업 보고";

/**
 * Topic that may stand in for a slot fact's missing entity, or "" when the text must name one.
 * Conversation rows share two constant topics and agent notes reuse generic titles, so only a
 * user's own note falls back to its topic; everything else needs an explicit `<name>의` entity.
 */
export const slotFallbackTopic = (topic: string, origin: string): string =>
  (origin === "user" || origin === "user-requested") &&
  topic !== CONVERSATION_USER_TOPIC &&
  topic !== CONVERSATION_REPORT_TOPIC
    ? topic
    : "";

// A slot fact is one line: `[<name>의] <keyword> <separator> <assignment>`. The keyword must be a
// whole token (not part of `Portfolio/`, `db_broker.vbs`, `model_failed`, `포트폴리오`) and the
// value must be followed by a real assignment, never a bare `로` inside a path or sentence.
// `<name>` is a Latin identifier directly before `의`; it never includes a list marker or the
// word before it. A bare `: value` / `= value` must be the rest of its line, which keeps type
// annotations, object literals, shell assignments and timestamps out.
const SLOT_GAP = String.raw`[^\S\r\n]`;
const SLOT_TOKEN_START = String.raw`(?<![\p{L}\p{N}_./\\-])`;
const SLOT_VALUE = "[`\"']?([a-zA-Z0-9_./:-]+)[`\"']?";
const SLOT_OLD_VALUE = "[`\"']?[a-zA-Z0-9_./:-]+[`\"']?";
const SLOT_ROLE_VALUE = "[`\"']?([a-zA-Z0-9가-힣_./:-]+)[`\"']?";
const SLOT_SEPARATOR = String.raw`(?:(?:는|은|이|가|을|를)${SLOT_GAP}+|${SLOT_GAP}*[:=]${SLOT_GAP}*|${SLOT_GAP}+(?:(?:is|to)${SLOT_GAP}+)?)`;
const SLOT_FACT_PATTERN = new RegExp(
  String.raw`(?:${SLOT_TOKEN_START}([a-zA-Z0-9가-힣](?:[a-zA-Z0-9가-힣_.-]*[a-zA-Z0-9가-힣])?)의${SLOT_GAP}+)?` +
    String.raw`${SLOT_TOKEN_START}(포트|port|패키지${SLOT_GAP}*매니저|package${SLOT_GAP}*manager|데이터베이스|db|모델|model|런타임|runtime|버전|version|경로|path|역할|role|담당|owner)(?![a-zA-Z0-9_./\\-])` +
    "(?:" +
    // `8000 → 8080`
    String.raw`${SLOT_SEPARATOR}${SLOT_OLD_VALUE}${SLOT_GAP}*(?:→|->|=>)${SLOT_GAP}*${SLOT_VALUE}(?![a-zA-Z0-9_./:\\-])` +
    // `[8000에서] 8080으로 변경`
    String.raw`|${SLOT_SEPARATOR}(?:${SLOT_OLD_VALUE}${SLOT_GAP}*(?:에서|from)${SLOT_GAP}*)?${SLOT_VALUE}${SLOT_GAP}*(?:으로|로)${SLOT_GAP}*(?:변경|설정|고정|전환|교체)` +
    // `pnpm 사용`
    String.raw`|${SLOT_SEPARATOR}${SLOT_VALUE}${SLOT_GAP}*(?:을|를)?${SLOT_GAP}*사용(?![자량법처료권])` +
    // `: 8080`, `= 8080`, `: 백엔드` (Hangul values allowed only for role/owner below)
    String.raw`|${SLOT_GAP}*[:=]${SLOT_GAP}*${SLOT_ROLE_VALUE}[.,]?${SLOT_GAP}*$` +
    ")",
  "dimu",
);
// A line that forbids, negates, asks, proposes or supposes a change states no fact.
const SLOT_NOT_ASSERTED =
  /하지\s*(?:마|말|않|못)|않(?:는|았|을|음|다|고|아|습)|금지|중단|불가|보류|말고|말\s*것|마세요|마라|면\s*안|[할될]\s*(?:까|지|경우)|[하되]면|한다면|하려면|하자|해야|어떨|검토|제안|고려|\?|\b(?:don'?t|do\s+not|does\s+not|doesn'?t|should|shall|never|not|no\s+longer|if|whether|maybe|consider)\b/iu;
const SLOT_LINE_START = /^[ \t]*(?:(?:[-*+•]|\d+[.)])[ \t]+)?$/u;
const SLOT_CODE_FENCE = /^[ \t]*(?:```|~~~)/gmu;

/**
 * Deterministic (entity_key, predicate_slot) parser without requiring an LLM call.
 * `topic` names the entity when the text does not; pass "" to require an explicit entity.
 * Only the first candidate in the text is considered, and any doubt about it returns null:
 * a missed fact leaves two memories visible, a wrong one hides a memory.
 */
export function extractDeterministicEntitySlot(
  content: string,
  topic: string,
): ExtractedSlotFact | null {
  const normalized = content.normalize("NFKC").trim();
  const kvMatch = SLOT_FACT_PATTERN.exec(normalized);
  if (!kvMatch) return null;

  const lineStart = normalized.lastIndexOf("\n", kvMatch.index) + 1;
  const lineEnd = normalized.indexOf("\n", kvMatch.index);
  const line = normalized.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  if (SLOT_NOT_ASSERTED.test(line)) return null;
  if ((normalized.slice(0, lineStart).match(SLOT_CODE_FENCE)?.length ?? 0) % 2 === 1) return null;

  // A bare generic Korean noun (`서버의`, `서비스의`, `설정의`) is shared by unrelated things;
  // accept specific Latin identifiers (`auth-api`) and specific Korean named entities (`결제서버`, `김민지님`).
  const specificEntity = normalizeSpecificSlotEntity(kvMatch[1]);
  const beforeEntity = kvMatch.indices?.[1]
    ? normalized.slice(lineStart, kvMatch.indices[1][0])
    : "";
  const isPureHangulEntity = specificEntity !== null && !/[a-z]/iu.test(specificEntity);
  const namedEntity =
    specificEntity !== null && (!isPureHangulEntity || SLOT_LINE_START.test(beforeEntity));
  const beforeKeyword = normalized.slice(lineStart, kvMatch.indices![2]![0]);
  if (!namedEntity) {
    // `<something>의 <keyword>` names an entity this parser cannot identify; the topic is not it.
    if (/의[ \t]+$/u.test(beforeKeyword)) return null;
    // A note's bare `key: value` counts only as its own line (after an optional list marker).
    if (kvMatch[6] !== undefined && !SLOT_LINE_START.test(beforeKeyword)) return null;
  }
  const rawEntity = (namedEntity ? specificEntity! : topic)
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
  const rawSlotKey = kvMatch[2]!.trim().toLowerCase().replace(/\s+/gu, "_");
  const canonicalSlot = CANONICAL_PREDICATE_SLOTS[rawSlotKey] ?? rawSlotKey;
  const val = (kvMatch[3] ?? kvMatch[4] ?? kvMatch[5] ?? kvMatch[6] ?? "").replace(/[.:,]+$/u, "");
  const allowsHangulSlotValue = canonicalSlot === "role" || canonicalSlot === "owner";
  const hasValidSlotValue = allowsHangulSlotValue
    ? /^[\p{L}\p{N}_./:-]+$/u.test(val) && /[\p{L}\p{N}]/u.test(val)
    : /^[a-z0-9_./:-]+$/iu.test(val) && /[a-z0-9]/iu.test(val);
  if (!rawEntity || !hasValidSlotValue) return null;
  return {
    entityKey: rawEntity,
    predicateSlot: canonicalSlot,
    normalizedValue: val,
    isNegationOrRollback: /(?:취소|롤백|안\s*씀|제거|deprecated|revert|disable)/iu.test(line),
  };
}

/**
 * Graphiti 4 temporal invalidation rules (Rules 1~4) + Mem0 (ADD/SUPERSEDE/AUGMENT/NOOP) resolver.
 * Defense against Graphiti Issue #1728: only invalidates within identical (entityKey, predicateSlot) pairs,
 * and never allows an assistant report to supersede an explicit user decision.
 * Each record's `topic` is its entity fallback (see `slotFallbackTopic`). An identical value is
 * always NOOP: a longer restatement never closes the earlier memory.
 */
export function resolveTemporalSlotConflict(
  newRecord: Pick<WorkspaceMemoryRecord, "id" | "content" | "topic" | "role" | "validFrom">,
  newFact: ExtractedSlotFact,
  activeSlotMemories: ReadonlyArray<
    Pick<WorkspaceMemoryRecord, "id" | "content" | "topic" | "role" | "validFrom" | "validTo">
  >,
  _nowMs: number = Date.now(),
): {
  action: ConsolidationAction;
  supersededRecordIds: string[];
  newRecordValidTo: number | null;
} {
  if (activeSlotMemories.length === 0) {
    return { action: "ADD", supersededRecordIds: [], newRecordValidTo: null };
  }

  const supersededIds: string[] = [];
  let newRecordValidTo: number | null = null;

  for (const existing of activeSlotMemories) {
    if (existing.id === newRecord.id) continue;
    // Never let an assistant report supersede a user decision.
    if (existing.role === "user" && newRecord.role !== "user") continue;

    const existingFact = extractDeterministicEntitySlot(existing.content, existing.topic);
    if (!existingFact) continue;
    if (
      existingFact.entityKey !== newFact.entityKey ||
      existingFact.predicateSlot !== newFact.predicateSlot
    ) {
      continue;
    }

    // Same value -> Mem0 NOOP
    if (
      existingFact.normalizedValue.toLowerCase() === newFact.normalizedValue.toLowerCase() &&
      existingFact.isNegationOrRollback === newFact.isNegationOrRollback
    ) {
      return { action: "NOOP", supersededRecordIds: [], newRecordValidTo: null };
    }

    // Graphiti Rule 3: out-of-order historical fact arriving earlier on the T-axis
    if (newRecord.validFrom < existing.validFrom) {
      newRecordValidTo =
        newRecordValidTo === null
          ? existing.validFrom
          : Math.min(newRecordValidTo, existing.validFrom);
      continue;
    }

    // Graphiti Rule 4: overlapping interval where new fact starts at or after existing -> close existing interval
    const existingStillOpen = existing.validTo === null || existing.validTo > newRecord.validFrom;
    if (existingStillOpen) {
      supersededIds.push(existing.id);
    }
  }

  if (supersededIds.length > 0) {
    return { action: "SUPERSEDE", supersededRecordIds: supersededIds, newRecordValidTo };
  }

  return { action: "ADD", supersededRecordIds: [], newRecordValidTo };
}

const MAX_NOTE_CHARS = 8_000;
const PAGE_SIZE = 64;
const MANIFEST_BYTES = 8 * 1024;
// Dream rewrites a memory's decay metrics only once they have drifted this far; tier, slot and
// supersession changes always write. Anything smaller would cost an index write per memory per turn.
const HEAT_WRITE_DELTA = 0.05;
const STABILITY_WRITE_DELTA_DAYS = 0.5;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeIdList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

const Settings = Schema.Struct({
  conversationRag: Schema.optional(Schema.Struct({ enabled: Schema.Boolean })),
  contextOptimization: Schema.optional(
    Schema.Struct({ autoChatMemory: Schema.optional(Schema.Boolean) }),
  ),
});
const decodeSettings = Schema.decodeUnknownSync(Schema.fromJsonString(Settings));
const Source = Schema.Struct({
  kind: Schema.String,
  id: Schema.String,
  projectId: Schema.optionalKey(Schema.String),
  folder: Schema.optionalKey(Schema.String),
});
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(Source));
const isMemoryError = Schema.is(WorkspaceMemoryError);
type RecordRow = {
  id: string;
  project_id: string;
  scope: string;
  topic: string;
  text: string;
  source_json: string;
  source_hash: string;
  origin: string;
  verification: string;
  status: string;
  created_at: string;
  updated_at: string;
  memory_tier?: MemoryTier;
  cognitive_type?: CognitiveMemoryType;
  access_count?: number;
  last_accessed_at?: number | null;
  stability_days?: number;
  heat_score?: number;
  entity_key?: string | null;
  predicate_slot?: string | null;
  valid_from?: number;
  valid_to?: number | null;
  expired_at?: number | null;
  superseded_by_id?: string | null;
  supersedes_ids?: string;
  memory_layer?: MemoryLayer;
  context_prefix?: string | null;
  rationale?: string | null;
  entities_json?: string;
  proof_fact_ids?: string;
  partialSource?: boolean;
};
type MessageRow = {
  rowid: number;
  message_id: string;
  thread_id: string;
  turn_id: string | null;
  role: string;
  text: string;
  text_length: number;
  created_at: string;
  updated_at: string;
  settled: number;
};
type Capture = {
  projectId: string;
  id: string;
  topic: string;
  text: string;
  source: unknown;
  origin: string;
  verification: string;
  createdAt: string;
  scope?: string | undefined;
  durable?: boolean;
};
type PreparedCapture = {
  input: Capture;
  sourceJson: string;
  scope: string;
  hash: string;
  text: string;
  searchText: string;
  existing: RecordRow | undefined;
};

/**
 * Folder answer guides are folder-scoped user directives. They are instructions,
 * not recalled memory, so they apply whether or not automatic chat memory is on.
 */
export interface WorkspaceDirectiveOptions {
  /** Project-relative folders of the current work; overrides the recorded message folder. */
  readonly folderPaths?: ReadonlyArray<string>;
  /** Text already sent to the model; a directive whose body appears in it is not repeated. */
  readonly presentIn?: string;
}

export class WorkspaceMemory extends Context.Service<
  WorkspaceMemory,
  {
    invoke: (
      input: WorkspaceMemoryAction,
      context?: {
        readonly threadId: ThreadId;
        readonly projectRoot?: true;
        readonly agentReported?: true;
      },
    ) => Effect.Effect<string, WorkspaceMemoryError>;
    context: (
      projectId: ProjectId,
      task: string,
      directivesOnly?: boolean,
      current?: {
        readonly threadId: ThreadId;
        readonly messageId: MessageId;
        readonly inheritFolder?: boolean;
        readonly excludeDirectives?: boolean;
        readonly excludeDirectiveReferences?: ReadonlyArray<{
          readonly projectId: ProjectId;
          readonly itemId: string;
        }>;
        readonly excludeRecentConversation?: boolean;
        readonly includedKnowledge?: {
          readonly prompt: string;
          readonly sourcePassages: ReadonlyArray<{
            readonly projectId: ProjectId;
            readonly itemId: string;
            readonly start: number;
            readonly end: number;
          }>;
        };
      },
      directiveOptions?: WorkspaceDirectiveOptions,
    ) => Effect.Effect<string, WorkspaceMemoryError>;
    contextPaths: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly cwd: string;
      readonly recordCurrent?: boolean;
    }) => Effect.Effect<ReadonlyArray<string>, WorkspaceMemoryError>;
    reconcile: (projectId: ProjectId) => Effect.Effect<void, WorkspaceMemoryError>;
    handoff: (
      projectId: ProjectId,
      threadId: ThreadId,
      messageId: MessageId,
      archive: boolean,
      folderScopeAvailable?: boolean,
      onArchiveAttached?: () => void,
    ) => Effect.Effect<string | undefined, WorkspaceMemoryError>;
  }
>()("t3/orchestration/WorkspaceMemory") {
  static readonly layer = Layer.effect(
    WorkspaceMemory,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const clock = yield* Clock.Clock;
      const gate = yield* Semaphore.make(1);
      const exportGate = yield* Semaphore.make(1);
      const folderCache = new Map<
        ThreadId,
        {
          projectId: ProjectId;
          cwd: string;
          rowid: number;
          messageId: MessageId;
          folder: string | null;
        }
      >();
      type DerivedRowCacheEntry = {
        readonly marker: string;
        readonly classification: ReturnType<typeof classifyCognitiveMemory>;
        readonly slotFact: ExtractedSlotFact | null;
        readonly decisionCandidate: ExtractedDecisionCandidate | null;
        readonly entities: ReadonlyArray<string>;
        readonly textForSlotOrProcedural: string | null;
      };
      const DERIVED_CACHE_MAX_ENTRIES = 60_000;
      const DERIVED_FETCH_BATCH_SIZE = 250;
      const derivedRowCache = new Map<string, DerivedRowCacheEntry>();
      const setDerivedCache = (id: string, entry: DerivedRowCacheEntry) => {
        if (derivedRowCache.has(id)) {
          derivedRowCache.delete(id);
        } else if (derivedRowCache.size >= DERIVED_CACHE_MAX_ENTRIES) {
          const oldest = derivedRowCache.keys().next().value;
          if (oldest !== undefined) derivedRowCache.delete(oldest);
        }
        derivedRowCache.set(id, entry);
      };
      const now = () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
      const io = <A>(f: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({
          try: f,
          catch: (cause) =>
            new WorkspaceMemoryError({ message: "기억 원문 파일을 처리하지 못했습니다.", cause }),
        });
      const safe = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isMemoryError(cause)
              ? cause
              : new WorkspaceMemoryError({ message: "기억 저장소를 처리하지 못했습니다.", cause }),
          ),
        );
      const directory = (project: string, scope = "project") =>
        memoryScopeDirectory(config.stateDir, project, scope);
      const inbox = (project: string, scope: string, id: string) =>
        NodePath.join(directory(project, scope), "observations", "_inbox", `${id}.md`);
      const dirty = (projectId: string, scope: string, topic: string) =>
        sql`INSERT OR IGNORE INTO workspace_memory_v2_dirty(project_id,scope,topic) VALUES (${projectId},${scope},${topic})`;
      const checkedProject = Effect.fn("WorkspaceMemory.project")(function* (projectId: string) {
        const [project] = yield* sql<{
          workspace_control_json: string;
        }>`SELECT workspace_control_json FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
        if (!project)
          return yield* new WorkspaceMemoryError({ message: "프로젝트를 찾을 수 없습니다." });
        return yield* Effect.try({
          try: () => decodeSettings(project.workspace_control_json),
          catch: (cause) =>
            new WorkspaceMemoryError({
              message: "프로젝트 기억 설정을 확인하지 못했습니다.",
              cause,
            }),
        });
      });
      const checkedThread = Effect.fn("WorkspaceMemory.thread")(function* (
        projectId: string,
        threadId: string,
      ) {
        const [thread] =
          yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id=${threadId} AND project_id=${projectId} AND deleted_at IS NULL`;
        if (!thread)
          return yield* new WorkspaceMemoryError({
            message: "현재 프로젝트의 대화만 조회할 수 있습니다.",
          });
      });
      const contextPaths = Effect.fn("WorkspaceMemory.contextPaths")(function* (input: {
        readonly projectId: ProjectId;
        readonly threadId: ThreadId;
        readonly messageId: MessageId;
        readonly cwd: string;
        readonly recordCurrent?: boolean;
      }) {
        yield* checkedThread(input.projectId, input.threadId);
        const [boundary] = yield* sql<{
          rowid: number;
        }>`SELECT rowid FROM projection_thread_messages WHERE thread_id=${input.threadId} AND message_id=${input.messageId}`;
        if (!boundary) {
          return yield* new WorkspaceMemoryError({
            message: "현재 대화의 메시지 위치를 확인하지 못했습니다.",
          });
        }
        const root = NodePath.resolve(input.cwd);
        const canonicalRoot = yield* fileSystem
          .realPath(root)
          .pipe(Effect.orElseSucceed(() => null));
        if (!canonicalRoot) {
          return yield* new WorkspaceMemoryError({
            message: "현재 작업 폴더를 확인하지 못했습니다.",
          });
        }
        const previous = folderCache.get(input.threadId);
        let validPrevious =
          previous?.projectId === input.projectId &&
          previous.cwd === root &&
          (previous.rowid < boundary.rowid ||
            (previous.rowid === boundary.rowid && previous.messageId === input.messageId));
        if (validPrevious && previous) {
          const [existing] = yield* sql<{
            rowid: number;
          }>`SELECT rowid FROM projection_thread_messages WHERE thread_id=${input.threadId} AND message_id=${previous.messageId} AND rowid=${previous.rowid}`;
          validPrevious = Boolean(existing);
        }
        const lower = validPrevious && previous ? previous.rowid : 0;
        let upper = boundary.rowid;
        let folder: string | null = validPrevious && previous ? previous.folder : null;
        while (upper > lower) {
          const rows = yield* sql<{
            rowid: number;
            text: string;
          }>`SELECT rowid,text FROM projection_thread_messages
            WHERE thread_id=${input.threadId} AND role='user' AND rowid>${lower} AND rowid<=${upper}
            ORDER BY rowid DESC LIMIT ${PAGE_SIZE}`;
          if (!rows.length) break;
          let selected: string | null | undefined;
          for (const row of rows) {
            const tokens = collectComposerInlineTokens(`${row.text} `)
              .filter((token) => token.type === "mention")
              .map((token) => token.value);
            const quoted = [...row.text.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1] ?? "");
            const bare = [
              ...row.text.matchAll(
                /(?:^|\s)([\p{L}\p{N}_.:-]+(?:[\\/][\p{L}\p{N}_.-]+)+)(?=\s|$)/gu,
              ),
            ].map((match) => match[1] ?? "");
            const found = new Set<string>();
            for (const candidate of new Set([...tokens, ...quoted, ...bare])) {
              if (!candidate || candidate.includes("\0")) continue;
              const absolute = NodePath.resolve(root, candidate);
              const relative = NodePath.relative(root, absolute);
              if (
                relative === ".." ||
                relative.startsWith(`..${NodePath.sep}`) ||
                NodePath.isAbsolute(relative)
              )
                continue;
              const canonical = yield* fileSystem
                .realPath(absolute)
                .pipe(Effect.orElseSucceed(() => null));
              if (!canonical) continue;
              const inside = NodePath.relative(canonicalRoot, canonical);
              if (
                inside === ".." ||
                inside.startsWith(`..${NodePath.sep}`) ||
                NodePath.isAbsolute(inside)
              )
                continue;
              const info = yield* fileSystem.stat(canonical).pipe(Effect.orElseSucceed(() => null));
              if (info?.type !== "Directory") continue;
              const normalized = relative.replaceAll("\\", "/");
              if (normalized.length > 240) continue;
              found.add(normalized);
            }
            if (found.size === 1) {
              selected = [...found][0] || null;
              break;
            }
            if (found.size > 1 && input.recordCurrent) {
              const [prior] = yield* sql<{ folder: string | null }>`
                SELECT f.folder FROM projection_thread_messages u
                LEFT JOIN workspace_memory_v2_message_folders f
                  ON f.message_id=u.message_id AND f.project_id=${input.projectId}
                WHERE u.thread_id=${input.threadId} AND u.role='user' AND u.rowid<${row.rowid}
                ORDER BY u.rowid DESC LIMIT 1`;
              if (prior?.folder != null) {
                selected = prior.folder || null;
                break;
              }
              return yield* new WorkspaceMemoryError({
                message: "여러 작업 폴더가 지정되어 이전에 확인한 폴더를 찾지 못했습니다.",
              });
            }
          }
          if (selected !== undefined) {
            folder = selected;
            break;
          }
          if (rows.length < PAGE_SIZE) break;
          upper = rows[rows.length - 1]!.rowid - 1;
          yield* Effect.yieldNow;
        }
        const cached = folderCache.get(input.threadId);
        if (!cached || cached.rowid <= boundary.rowid || !validPrevious) {
          folderCache.set(input.threadId, {
            projectId: input.projectId,
            cwd: root,
            rowid: boundary.rowid,
            messageId: input.messageId,
            folder,
          });
        }
        if (input.recordCurrent) {
          yield* sql`INSERT OR IGNORE INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
            SELECT message_id,${input.projectId},${input.threadId},${folder ?? ""}
            FROM projection_thread_messages WHERE thread_id=${input.threadId} AND message_id=${input.messageId} AND role='user'`;
          const [recorded] = yield* sql<{
            folder: string;
          }>`SELECT folder FROM workspace_memory_v2_message_folders
            WHERE message_id=${input.messageId} AND project_id=${input.projectId} AND thread_id=${input.threadId}`;
          if (!recorded || recorded.folder !== (folder ?? ""))
            return yield* new WorkspaceMemoryError({
              message: "현재 메시지의 기록된 폴더가 달라 기억을 주입하지 않았습니다.",
            });
        }
        return folder ? [folder] : [];
      });
      const prepareCapture = Effect.fn("WorkspaceMemory.prepareCapture")(function* (
        input: Capture,
      ) {
        const sourceJson = encodeJson(input.source);
        const scope = input.scope ?? "project";
        const scrubbedInputText = redactMemorySensitiveData(input.text).content;
        const hash = memoryHash(encodeJson([scrubbedInputText, sourceJson, scope, input.topic]));
        const text = Array.from(scrubbedInputText).slice(0, MAX_NOTE_CHARS).join("");
        const [existing] =
          yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 WHERE id=${input.id}`;
        if (
          existing?.status === "forgotten" ||
          (existing?.source_hash === hash &&
            existing.text === text &&
            existing.status !== "archived")
        )
          return;
        // SQLite is the durable source; do not create transient inbox documents.
        return {
          input,
          sourceJson,
          scope,
          hash,
          text,
          searchText: analyzeSearchText(input.topic + " " + text),
          existing,
        };
      });
      const persistCapture = Effect.fn("WorkspaceMemory.persistCapture")(function* (
        prepared: PreparedCapture,
      ) {
        const { input, sourceJson, scope, hash, text, existing } = prepared;
        if (existing) yield* dirty(existing.project_id, existing.scope, existing.topic);
        const nowMs = clock.currentTimeMillisUnsafe();
        const parsedCreated = Date.parse(input.createdAt);
        const validFrom = Number.isFinite(parsedCreated) ? parsedCreated : nowMs;
        const classification = classifyCognitiveMemory(text, input.origin);
        const slotFact = extractDeterministicEntitySlot(
          text,
          slotFallbackTopic(input.topic, input.origin),
        );
        const decisionCandidate = extractDecisionCandidate(text, input.origin, input.topic);
        const entities = extractMemoryEntities(text, input.topic, slotFact?.entityKey);
        const sourceFolder =
          typeof input.source === "object" &&
          input.source !== null &&
          "folder" in input.source &&
          typeof (input.source as { readonly folder?: unknown }).folder === "string"
            ? (input.source as { readonly folder: string }).folder || null
            : null;
        const contextPrefix = buildDeterministicContextPrefix({
          createdAtMs: validFrom,
          topic: input.topic,
          origin: input.origin,
          scope,
          folder: sourceFolder,
          rationale: decisionCandidate?.rationale ?? null,
        });
        const tailSearchText = analyzeSearchText(
          [
            contextPrefix,
            input.topic,
            text,
            buildTemporalIndexTail(text, validFrom),
            entities.join(" "),
          ]
            .filter(Boolean)
            .join(" "),
        );
        const metrics = computeMemoryRetentionAndHeat(
          {
            createdAt: validFrom,
            lastAccessedAt: existing?.last_accessed_at ?? null,
            accessCount: existing?.access_count ?? 0,
            salience: classification.salience,
            cognitiveType: classification.cognitiveType,
          },
          nowMs,
        );
        yield* sql`INSERT INTO workspace_memory_v2 (
            id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,created_at,updated_at,
            memory_tier,cognitive_type,stability_days,heat_score,entity_key,predicate_slot,valid_from,
            memory_layer,context_prefix,rationale,entities_json,proof_fact_ids
          )
          VALUES (
            ${input.id},${input.projectId},${scope},${input.topic},${text},${sourceJson},${hash},${input.origin},${input.verification},${input.durable ? "pending" : "observed"},${input.createdAt},${now()},
            ${metrics.recommendedTier},${classification.cognitiveType},${metrics.stabilityDays},${metrics.heatScore},${slotFact?.entityKey ?? null},${slotFact?.predicateSlot ?? null},${validFrom},
            'fact',${contextPrefix},${decisionCandidate?.rationale ?? null},${encodeJson(entities)},'[]'
          )
          ON CONFLICT(id) DO UPDATE SET
            project_id=excluded.project_id,scope=excluded.scope,topic=excluded.topic,text=excluded.text,
            source_json=excluded.source_json,source_hash=excluded.source_hash,origin=excluded.origin,
            verification=excluded.verification,status=excluded.status,created_at=excluded.created_at,
            updated_at=excluded.updated_at,memory_tier=excluded.memory_tier,cognitive_type=excluded.cognitive_type,
            stability_days=excluded.stability_days,heat_score=excluded.heat_score,
            entity_key=excluded.entity_key,predicate_slot=excluded.predicate_slot,valid_from=excluded.valid_from,
            memory_layer=excluded.memory_layer,context_prefix=excluded.context_prefix,
            rationale=excluded.rationale,entities_json=excluded.entities_json`;
        yield* sql`DELETE FROM workspace_memory_v2_fts WHERE rowid=(SELECT rowid FROM workspace_memory_v2 WHERE id=${input.id})`;
        yield* sql`INSERT INTO workspace_memory_v2_fts(rowid,id,project_id,scope,content) SELECT rowid,id,project_id,scope,${tailSearchText} FROM workspace_memory_v2 WHERE id=${input.id}`;
        if (input.durable) yield* dirty(input.projectId, scope, input.topic);
      });
      const capture = Effect.fn("WorkspaceMemory.capture")(function* (input: Capture) {
        const prepared = yield* prepareCapture(input);
        if (prepared) yield* sql.withTransaction(persistCapture(prepared));
      });
      const clearChunks = Effect.fn("WorkspaceMemory.clearChunks")(function* (memoryId: string) {
        yield* sql`DELETE FROM workspace_memory_v2_chunks WHERE rowid IN (SELECT chunk_rowid FROM workspace_memory_v2_chunk_rows WHERE memory_id=${memoryId})`;
        yield* sql`DELETE FROM workspace_memory_v2_chunk_rows WHERE memory_id=${memoryId}`;
      });
      const indexLongSource = Effect.fn("WorkspaceMemory.indexLongSource")(function* (input: {
        projectId: string;
        memoryId: string;
        kind: "message" | "knowledge";
        sourceId: string;
        updatedAt: string;
        length: number;
      }) {
        const [record] =
          yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 WHERE id=${input.memoryId}`;
        const [state] = yield* sql<{
          source_version: string;
        }>`SELECT source_version FROM workspace_memory_v2_chunk_state WHERE memory_id=${input.memoryId}`;
        if (input.length <= MAX_NOTE_CHARS && !state) return;
        if (!record || record.status === "forgotten" || record.status === "archived") {
          if (state) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* clearChunks(input.memoryId);
                yield* sql`DELETE FROM workspace_memory_v2_chunk_state WHERE memory_id=${input.memoryId}`;
              }),
            );
          }
          return;
        }
        const version = `${input.updatedAt}:${input.length}`;
        if (state?.source_version === version) return;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* clearChunks(input.memoryId);
            if (input.length > MAX_NOTE_CHARS) {
              for (
                let offset = 0;
                offset < input.length;
                offset += MAX_NOTE_CHARS - CHUNK_OVERLAP
              ) {
                const [page] =
                  input.kind === "message"
                    ? yield* sql<{
                        text: string;
                      }>`SELECT substr(m.text,${offset + 1},${MAX_NOTE_CHARS}) AS text FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id WHERE m.message_id=${input.sourceId} AND t.project_id=${input.projectId} AND t.deleted_at IS NULL`
                    : yield* sql<{
                        text: string;
                      }>`SELECT substr(content,${offset + 1},${MAX_NOTE_CHARS}) AS text FROM projection_workspace_knowledge_items WHERE project_id=${input.projectId} AND item_id=${input.sourceId} AND status='active'`;
                if (!page)
                  return yield* new WorkspaceMemoryError({
                    message: "기억 원문을 찾을 수 없습니다.",
                  });
                for (const chunk of chunkSearchableContent(page.text)) {
                  yield* sql`INSERT INTO workspace_memory_v2_chunk_rows(memory_id) VALUES (${input.memoryId})`;
                  yield* sql`INSERT INTO workspace_memory_v2_chunks(rowid,memory_id,project_id,chunk_text,content) VALUES (last_insert_rowid(),${input.memoryId},${input.projectId},${chunk},${analyzeSearchText(chunk)})`;
                }
              }
            }
            yield* sql`INSERT INTO workspace_memory_v2_chunk_state(memory_id,project_id,source_kind,source_id,source_version)
              VALUES (${input.memoryId},${input.projectId},${input.kind},${input.sourceId},${version})
              ON CONFLICT(memory_id) DO UPDATE SET project_id=excluded.project_id,source_kind=excluded.source_kind,source_id=excluded.source_id,source_version=excluded.source_version`;
          }),
        );
      });
      const indexLongMessage = (projectId: string, row: MessageRow) =>
        indexLongSource({
          projectId,
          memoryId: memoryHash(`message:${row.message_id}`),
          kind: "message",
          sourceId: row.message_id,
          updatedAt: row.updated_at,
          length: row.text_length,
        });
      const manifest = Effect.fn("WorkspaceMemory.manifest")(function* (
        projectId: string,
        scope = "project",
      ) {
        const hotRows = yield* sql<{
          id: string;
          topic: string;
          text: string;
        }>`SELECT id,topic,substr(text,1,240) AS text FROM workspace_memory_v2 r
        WHERE ${scope === "global" ? sql`scope='global'` : sql`project_id=${projectId} AND scope='project'`}
        AND status='consolidated' AND memory_tier='hot' AND expired_at IS NULL AND superseded_by_id IS NULL
        AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
        ORDER BY heat_score DESC,updated_at DESC,id ASC LIMIT 12`;
        const rows = yield* sql<{
          topic: string;
          total: number;
        }>`SELECT topic,count(*) AS total FROM workspace_memory_v2 r
        WHERE ${scope === "global" ? sql`scope='global'` : sql`project_id=${projectId} AND scope='project'`} AND status='consolidated'
        AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
        GROUP BY topic ORDER BY max(updated_at) DESC,topic LIMIT 65`;
        let text = `# ${scope === "global" ? "공용" : "프로젝트"} 기억 목차\n\n자동 생성된 출처 목차입니다. workspace_memory search/read로 확인하고, 최신의 명시적 정정을 우선하세요.\n`;
        if (hotRows.length > 0) {
          let hotSection = "\n## 핵심 상주 지침 (Hot Core Memory)\n";
          for (const hot of hotRows) {
            const firstLine = hot.text.replace(/\s+/g, " ").trim().slice(0, 140);
            const itemLine = `\n- [${hot.id.slice(0, 12)}] ${hot.topic.replace(/\s+/g, " ")}: ${firstLine}`;
            if (Buffer.byteLength(text + hotSection + itemLine) > 2600) break;
            hotSection += itemLine;
          }
          text += hotSection + "\n";
        }
        let entries = 0;
        for (const row of rows.slice(0, 64)) {
          const line = `\n- ${row.topic.replace(/\s+/g, " ")} (${row.total}개): topics/${memoryHash(row.topic).slice(0, 24)}-0000.md`;
          if (Buffer.byteLength(text + line) > MANIFEST_BYTES - 180) break;
          text += line;
          entries++;
        }
        if (entries < rows.length) text += "\n\n추가 주제는 전체 검색 색인에서 조회하세요.";
        if (scope === "project") {
          const separatedSection = [
            "",
            "## 분리 보관 코퍼스 (내 대화·말투 vs AI 작성·조사)",
            "- 내 말투·화법 프로필: user-utterances/USER_STYLE_PROFILE.md",
            "- 내 대화 원문 보관소: user-utterances/utterances-0000.md",
            "- AI 작성·조사 결과 보관소: ai-outputs/outputs-0000.md",
          ].join("\n");
          if (Buffer.byteLength(text + separatedSection) <= MANIFEST_BYTES - 120) {
            text += separatedSection;
          }
        }
        return text;
      });
      type ConsolidationLightRow = {
        id: string;
        project_id: string;
        scope: string;
        topic: string;
        source_json: string;
        source_hash: string;
        origin: string;
        created_at: string;
        updated_at: string;
        memory_tier?: MemoryTier;
        cognitive_type?: CognitiveMemoryType;
        access_count?: number;
        last_accessed_at?: number | null;
        stability_days?: number;
        heat_score?: number;
        entity_key?: string | null;
        predicate_slot?: string | null;
        valid_from?: number;
        valid_to?: number | null;
        superseded_by_id?: string | null;
        supersedes_ids?: string;
        memory_layer?: MemoryLayer;
        rationale?: string | null;
        entities_json?: string;
        proof_fact_ids?: string;
      };
      const derivedRowMarker = (
        row: Pick<ConsolidationLightRow, "updated_at" | "source_hash" | "origin" | "topic">,
      ) => `${row.updated_at}\0${row.source_hash}\0${row.origin}\0${row.topic}`;
      const consolidateTierAndSlots = Effect.fn("WorkspaceMemory.consolidateTierAndSlots")(
        function* (projectId: string) {
          const nowMs = clock.currentTimeMillisUnsafe();
          const activeRows = yield* sql<ConsolidationLightRow>`SELECT
              id, project_id, scope, topic, source_json, source_hash, origin, created_at, updated_at,
              memory_tier, cognitive_type, access_count, last_accessed_at,
              stability_days, heat_score, entity_key, predicate_slot,
              valid_from, valid_to, superseded_by_id, supersedes_ids,
              memory_layer, rationale, entities_json, proof_fact_ids
            FROM workspace_memory_v2 r
            WHERE (r.project_id=${projectId} OR r.scope='global')
              AND r.status NOT IN ('forgotten','archived')
              AND r.expired_at IS NULL
            ORDER BY r.valid_from ASC, r.created_at ASC, r.id ASC`;

          const factRows = activeRows.filter(
            (row) => (row.memory_layer ?? "fact") !== "observation",
          );
          const existingObsRows = activeRows.filter((row) => row.memory_layer === "observation");

          const resolved = new Map<string, DerivedRowCacheEntry>();
          const missingRows: ConsolidationLightRow[] = [];
          for (const row of factRows) {
            const marker = derivedRowMarker(row);
            const cached = derivedRowCache.get(row.id);
            if (cached && cached.marker === marker) {
              resolved.set(row.id, cached);
            } else {
              missingRows.push(row);
            }
          }

          for (let offset = 0; offset < missingRows.length; offset += DERIVED_FETCH_BATCH_SIZE) {
            const batch = missingRows.slice(offset, offset + DERIVED_FETCH_BATCH_SIZE);
            const textRows = yield* sql<{
              id: string;
              text: string;
            }>`SELECT id, text FROM workspace_memory_v2 WHERE id IN ${sql.in(batch.map((r) => r.id))}`;
            const textById = new Map(textRows.map((entry) => [entry.id, entry.text]));
            for (const row of batch) {
              const text = textById.get(row.id) ?? "";
              const classification = classifyCognitiveMemory(text, row.origin);
              // Stored entity_key/predicate_slot are derived values; recompute them, never trust them.
              const entityTopic = slotFallbackTopic(row.topic, row.origin);
              const slotFact = extractDeterministicEntitySlot(text, entityTopic);
              const decisionCandidate = extractDecisionCandidate(text, row.origin, row.topic);
              const entities = extractMemoryEntities(text, row.topic, slotFact?.entityKey);
              const entry: DerivedRowCacheEntry = {
                marker: derivedRowMarker(row),
                classification,
                slotFact,
                decisionCandidate,
                entities,
                textForSlotOrProcedural:
                  slotFact !== null || classification.cognitiveType === "procedural" ? text : null,
              };
              setDerivedCache(row.id, entry);
              resolved.set(row.id, entry);
            }
            yield* Effect.yieldNow;
          }

          let promotedToHot = 0;
          let demotedToCold = 0;
          let supersededCount = 0;
          const activeBySlot = new Map<
            string,
            Array<
              Pick<
                WorkspaceMemoryRecord,
                "id" | "content" | "topic" | "role" | "validFrom" | "validTo"
              >
            >
          >();
          const proceduralByScope = new Map<
            string,
            Array<{
              id: string;
              topic: string;
              summaryHeader: string;
              text: string;
              origin: string;
              requiresReview: boolean;
              createdAtMs: number;
            }>
          >();
          const decisionGroups = new Map<
            string,
            {
              readonly scope: string;
              readonly projectId: string;
              readonly folder: string | null;
              readonly events: Array<{
                readonly factId: string;
                readonly createdAtMs: number;
                readonly candidate: ExtractedDecisionCandidate;
              }>;
            }
          >();
          const supersededUpdates: Array<{
            oldId: string;
            projectId: string;
            validTo: number;
            supersededById: string;
          }> = [];
          const rowUpdates: Array<{
            id: string;
            entityKey: string | null;
            predicateSlot: string | null;
            cognitiveType: CognitiveMemoryType;
            validFrom: number;
            validTo: number | null;
            stabilityDays: number;
            heatScore: number;
            memoryTier: MemoryTier;
            supersedesJson: string;
            rationale: string | null;
            entitiesJson: string;
          }> = [];

          for (let index = 0; index < factRows.length; index++) {
            const row = factRows[index]!;
            const derived = resolved.get(row.id)!;
            const { classification, slotFact, decisionCandidate, entities } = derived;
            const parsedCreated = Date.parse(row.created_at);
            const createdAtMs =
              row.valid_from && row.valid_from > 0
                ? row.valid_from
                : Number.isFinite(parsedCreated)
                  ? parsedCreated
                  : nowMs;
            const entityTopic = slotFallbackTopic(row.topic, row.origin);
            const entityKey = slotFact?.entityKey ?? null;
            const predicateSlot = slotFact?.predicateSlot ?? null;
            const role: "user" | "assistant" | "system" =
              row.origin === "user" || row.origin === "user-requested"
                ? "user"
                : row.origin === "system"
                  ? "system"
                  : "assistant";
            let supersededIds: string[] = [];
            let newRecordValidTo: number | null = row.valid_to ?? null;

            if (entityKey && predicateSlot && slotFact) {
              const slotKey = `${row.scope}::${row.project_id}::${entityKey}::${predicateSlot}`;
              const currentActive = activeBySlot.get(slotKey) ?? [];
              const candidateRecord = {
                id: row.id,
                content: derived.textForSlotOrProcedural ?? "",
                topic: entityTopic,
                role,
                validFrom: createdAtMs,
                validTo: newRecordValidTo,
              };
              const resolution = resolveTemporalSlotConflict(
                candidateRecord,
                slotFact,
                currentActive,
                nowMs,
              );
              if (resolution.newRecordValidTo !== null) {
                newRecordValidTo = resolution.newRecordValidTo;
              }
              if (resolution.action === "SUPERSEDE") {
                supersededIds = resolution.supersededRecordIds;
                for (const oldId of supersededIds) {
                  supersededUpdates.push({
                    oldId,
                    projectId: row.project_id,
                    validTo: createdAtMs,
                    supersededById: row.id,
                  });
                  supersededCount++;
                }
                const remaining = currentActive.filter((r) => !supersededIds.includes(r.id));
                remaining.push({ ...candidateRecord, validTo: newRecordValidTo });
                activeBySlot.set(slotKey, remaining);
              } else {
                // A NOOP restatement stays tracked so a later change closes it too.
                currentActive.push({ ...candidateRecord, validTo: newRecordValidTo });
                activeBySlot.set(slotKey, currentActive);
              }
            }

            if (decisionCandidate && newRecordValidTo === null) {
              const parsedSource = Option.getOrUndefined(
                Schema.decodeUnknownOption(Schema.fromJsonString(Source))(row.source_json),
              );
              const folderKey = parsedSource?.folder ?? "";
              const groupKey = `${row.scope}\0${row.project_id}\0${folderKey}\0${decisionCandidate.subjectKey}`;
              let group = decisionGroups.get(groupKey);
              if (!group) {
                group = {
                  scope: row.scope,
                  projectId: row.project_id,
                  folder: parsedSource?.folder ?? null,
                  events: [],
                };
                decisionGroups.set(groupKey, group);
              }
              group.events.push({
                factId: row.id,
                createdAtMs,
                candidate: decisionCandidate,
              });
            }

            const metrics = computeMemoryRetentionAndHeat(
              {
                createdAt: createdAtMs,
                lastAccessedAt: row.last_accessed_at ?? null,
                accessCount: row.access_count ?? 0,
                salience: classification.salience,
                cognitiveType: classification.cognitiveType,
              },
              nowMs,
            );
            const nextTier: MemoryTier =
              newRecordValidTo !== null && newRecordValidTo <= nowMs
                ? "cold"
                : metrics.recommendedTier;
            if (nextTier === "hot" && row.memory_tier !== "hot") promotedToHot++;
            if (nextTier === "cold" && row.memory_tier !== "cold") demotedToCold++;

            const knownSupersedes =
              !row.supersedes_ids || row.supersedes_ids === "[]"
                ? []
                : Option.getOrElse(decodeIdList(row.supersedes_ids), () => []);
            // Lineage only grows: earlier dreams already closed the rows listed here.
            const supersedes = [...new Set([...knownSupersedes, ...supersededIds])];
            const nextRationale = decisionCandidate?.rationale ?? null;
            const nextEntitiesJson = encodeJson(entities);
            if (
              (row.entity_key ?? null) !== entityKey ||
              (row.predicate_slot ?? null) !== predicateSlot ||
              row.cognitive_type !== classification.cognitiveType ||
              row.valid_from !== createdAtMs ||
              (row.valid_to ?? null) !== newRecordValidTo ||
              row.memory_tier !== nextTier ||
              supersedes.length !== knownSupersedes.length ||
              (row.rationale ?? null) !== nextRationale ||
              (row.entities_json ?? "[]") !== nextEntitiesJson ||
              Math.abs((row.heat_score ?? 0) - metrics.heatScore) >= HEAT_WRITE_DELTA ||
              Math.abs((row.stability_days ?? 0) - metrics.stabilityDays) >=
                STABILITY_WRITE_DELTA_DAYS
            ) {
              rowUpdates.push({
                id: row.id,
                entityKey,
                predicateSlot,
                cognitiveType: classification.cognitiveType,
                validFrom: createdAtMs,
                validTo: newRecordValidTo,
                stabilityDays: metrics.stabilityDays,
                heatScore: metrics.heatScore,
                memoryTier: nextTier,
                supersedesJson: encodeJson(supersedes),
                rationale: nextRationale,
                entitiesJson: nextEntitiesJson,
              });
            }

            if (classification.cognitiveType === "procedural") {
              const list = proceduralByScope.get(row.scope) ?? [];
              list.push({
                id: row.id,
                topic: row.topic,
                summaryHeader: classification.extractedSummaryHeader,
                text: derived.textForSlotOrProcedural ?? "",
                origin: row.origin,
                requiresReview: classification.requiresProceduralReview,
                createdAtMs,
              });
              proceduralByScope.set(row.scope, list);
            }

            if ((index + 1) % 1_000 === 0) {
              yield* Effect.yieldNow;
            }
          }

          // Synthesize 2nd-layer `observation` records with Rationale Precedence & Transition Narrative
          const existingObsById = new Map(existingObsRows.map((r) => [r.id, r]));
          const desiredObsIds = new Set<string>();
          const obsUpserts: Array<{
            id: string;
            projectId: string;
            scope: string;
            topic: string;
            text: string;
            sourceJson: string;
            sourceHash: string;
            createdAt: string;
            validFrom: number;
            validTo: number | null;
            supersededById: string | null;
            supersedesJson: string;
            memoryTier: MemoryTier;
            stabilityDays: number;
            heatScore: number;
            entityKey: string;
            contextPrefix: string;
            rationale: string | null;
            entitiesJson: string;
            proofFactIdsJson: string;
            ftsText: string;
          }> = [];

          for (const group of decisionGroups.values()) {
            const hasSubstantiveDecision = group.events.some(
              (ev) => ev.candidate.kind !== "tentative_question",
            );
            if (!hasSubstantiveDecision) continue;
            const specs = synthesizeSubjectObservations(group.events);
            const obsIdByKey = new Map<string, string>();
            for (const spec of specs) {
              const obsId = memoryHash(
                `obs:${group.scope}:${group.projectId}:${group.folder ?? ""}:${spec.subjectKey}:${spec.primaryFactId}`,
              );
              obsIdByKey.set(`${spec.subjectKey}::${spec.primaryFactId}`, obsId);
            }
            const supersededByMap = new Map<string, string>();
            for (const spec of specs) {
              const currentId = obsIdByKey.get(`${spec.subjectKey}::${spec.primaryFactId}`)!;
              for (const prevKey of spec.supersededObservationKeys) {
                const prevId = obsIdByKey.get(prevKey);
                if (prevId) supersededByMap.set(prevId, currentId);
              }
            }

            for (const spec of specs) {
              const obsId = obsIdByKey.get(`${spec.subjectKey}::${spec.primaryFactId}`)!;
              desiredObsIds.add(obsId);
              const supersededById = supersededByMap.get(obsId) ?? null;
              const supersedesObsIds = spec.supersededObservationKeys
                .map((k) => obsIdByKey.get(k))
                .filter((id): id is string => Boolean(id));
              const proofFactIdsJson = encodeJson(spec.proofFactIds);
              const entitiesJson = encodeJson(spec.entities);
              const supersedesJson = encodeJson(supersedesObsIds);
              const sourceJson = encodeJson({
                kind: "observation",
                id: spec.primaryFactId,
                projectId: group.projectId,
                ...(group.folder !== null ? { folder: group.folder } : {}),
              });
              const stateHash = memoryHash(
                encodeJson([
                  spec.topic,
                  spec.text,
                  spec.rationale,
                  spec.proofFactIds,
                  spec.entities,
                  spec.validFrom,
                  spec.validTo,
                  supersededById,
                ]),
              );
              const existingObs = existingObsById.get(obsId);
              if (
                existingObs &&
                existingObs.source_hash === stateHash &&
                (existingObs.valid_to ?? null) === spec.validTo &&
                (existingObs.superseded_by_id ?? null) === supersededById
              ) {
                continue;
              }
              const obsMetrics = computeMemoryRetentionAndHeat(
                {
                  createdAt: spec.validFrom,
                  lastAccessedAt: existingObs?.last_accessed_at ?? null,
                  accessCount: existingObs?.access_count ?? 0,
                  salience: "user-decision",
                  cognitiveType: "semantic",
                },
                nowMs,
              );
              const obsTier: MemoryTier =
                spec.validTo !== null ? "cold" : obsMetrics.recommendedTier;
              const contextPrefix = buildDeterministicContextPrefix({
                createdAtMs: spec.validFrom,
                topic: spec.topic,
                origin: "user",
                scope: group.scope,
                folder: group.folder,
                rationale: spec.rationale,
              });
              const createdIso = DateTime.formatIso(DateTime.makeUnsafe(spec.validFrom));
              obsUpserts.push({
                id: obsId,
                projectId: group.projectId,
                scope: group.scope,
                topic: spec.topic,
                text: spec.text,
                sourceJson,
                sourceHash: stateHash,
                createdAt: createdIso,
                validFrom: spec.validFrom,
                validTo: spec.validTo,
                supersededById,
                supersedesJson,
                memoryTier: obsTier,
                stabilityDays: obsMetrics.stabilityDays,
                heatScore: obsMetrics.heatScore,
                entityKey: spec.subjectKey,
                contextPrefix,
                rationale: spec.rationale,
                entitiesJson,
                proofFactIdsJson,
                ftsText: analyzeSearchText(
                  [
                    contextPrefix,
                    spec.topic,
                    spec.text,
                    spec.rationale ?? "",
                    buildTemporalIndexTail(spec.text, spec.validFrom),
                    spec.entities.join(" "),
                  ]
                    .filter(Boolean)
                    .join(" "),
                ),
              });
            }
          }

          const orphanedObsIds = existingObsRows
            .filter((r) => !desiredObsIds.has(r.id))
            .map((r) => r.id);

          if (
            supersededUpdates.length > 0 ||
            rowUpdates.length > 0 ||
            obsUpserts.length > 0 ||
            orphanedObsIds.length > 0
          ) {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                for (const update of supersededUpdates) {
                  yield* sql`UPDATE workspace_memory_v2
                    SET valid_to=${update.validTo},
                        expired_at=${nowMs},
                        superseded_by_id=${update.supersededById},
                        memory_tier='cold'
                    WHERE id=${update.oldId} AND project_id=${update.projectId}`;
                }
                for (const update of rowUpdates) {
                  yield* sql`UPDATE workspace_memory_v2
                    SET entity_key=${update.entityKey},
                        predicate_slot=${update.predicateSlot},
                        cognitive_type=${update.cognitiveType},
                        valid_from=${update.validFrom},
                        valid_to=${update.validTo},
                        stability_days=${update.stabilityDays},
                        heat_score=${update.heatScore},
                        memory_tier=${update.memoryTier},
                        supersedes_ids=${update.supersedesJson},
                        rationale=${update.rationale},
                        entities_json=${update.entitiesJson}
                    WHERE id=${update.id}`;
                }
                for (const obs of obsUpserts) {
                  yield* sql`INSERT INTO workspace_memory_v2 (
                      id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,
                      created_at,updated_at,memory_tier,cognitive_type,stability_days,heat_score,
                      entity_key,predicate_slot,valid_from,valid_to,expired_at,superseded_by_id,supersedes_ids,
                      memory_layer,context_prefix,rationale,entities_json,proof_fact_ids
                    ) VALUES (
                      ${obs.id},${obs.projectId},${obs.scope},${obs.topic},${obs.text},${obs.sourceJson},${obs.sourceHash},
                      'user','consolidated-observation','consolidated',
                      ${obs.createdAt},${now()},${obs.memoryTier},'semantic',${obs.stabilityDays},${obs.heatScore},
                      ${obs.entityKey},'decision',${obs.validFrom},${obs.validTo},${obs.supersededById ? nowMs : null},
                      ${obs.supersededById},${obs.supersedesJson},
                      'observation',${obs.contextPrefix},${obs.rationale},${obs.entitiesJson},${obs.proofFactIdsJson}
                    )
                    ON CONFLICT(id) DO UPDATE SET
                      topic=excluded.topic,text=excluded.text,source_json=excluded.source_json,
                      source_hash=excluded.source_hash,updated_at=excluded.updated_at,
                      memory_tier=excluded.memory_tier,stability_days=excluded.stability_days,
                      heat_score=excluded.heat_score,valid_from=excluded.valid_from,
                      valid_to=excluded.valid_to,expired_at=excluded.expired_at,
                      superseded_by_id=excluded.superseded_by_id,supersedes_ids=excluded.supersedes_ids,
                      context_prefix=excluded.context_prefix,rationale=excluded.rationale,
                      entities_json=excluded.entities_json,proof_fact_ids=excluded.proof_fact_ids`;
                  yield* sql`DELETE FROM workspace_memory_v2_fts WHERE rowid=(SELECT rowid FROM workspace_memory_v2 WHERE id=${obs.id})`;
                  yield* sql`INSERT INTO workspace_memory_v2_fts(rowid,id,project_id,scope,content)
                    SELECT rowid,id,project_id,scope,${obs.ftsText} FROM workspace_memory_v2 WHERE id=${obs.id}`;
                }
                if (orphanedObsIds.length > 0) {
                  yield* sql`DELETE FROM workspace_memory_v2_fts WHERE id IN ${sql.in(orphanedObsIds)}`;
                  yield* sql`UPDATE workspace_memory_v2 SET status='archived',updated_at=${now()} WHERE id IN ${sql.in(orphanedObsIds)}`;
                }
              }),
            );
          }

          for (const [scope, entries] of proceduralByScope) {
            if (entries.length > 0) {
              yield* io(() => publishProceduralLessonsFile(directory(projectId, scope), entries));
            }
          }

          return {
            promotedToHot,
            demotedToCold,
            supersededCount,
            observationsSynthesized: obsUpserts.length,
          };
        },
      );
      // The user's unscoped history remains available; AI-scoped retrieval and
      // automatic excerpts exclude messages explicitly removed from memory.
      const messageIsNotForgotten = (projectId: string) => sql`NOT EXISTS (
        SELECT 1 FROM workspace_memory_v2 forgotten
        WHERE forgotten.project_id=${projectId} AND forgotten.status='forgotten'
          AND CASE WHEN json_valid(forgotten.source_json)
            AND json_extract(forgotten.source_json,'$.kind')='message'
            THEN json_extract(forgotten.source_json,'$.id') END = m.message_id
      )`;
      const dream = Effect.fn("WorkspaceMemory.dream")(function* (projectId: string) {
        const tiering = yield* consolidateTierAndSlots(projectId);
        let written = 0;
        while (true) {
          const topics = yield* sql<{
            topic: string;
            scope: string;
          }>`SELECT DISTINCT topic,scope FROM workspace_memory_v2_dirty WHERE project_id=${projectId} OR scope='global' ORDER BY scope,topic LIMIT 64`;
          if (!topics.length) break;
          for (const topic of topics) {
            let date = "\uffff";
            let cursor = "\uffff";
            let part = 0;
            const seen = new Set<string>();
            const root = directory(projectId, topic.scope);
            const prefix = memoryHash(topic.topic).slice(0, 24);
            while (true) {
              const rows = yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 r WHERE
              ${topic.scope === "global" ? sql`scope='global'` : sql`project_id=${projectId} AND scope='project'`} AND topic=${topic.topic}
              AND status IN ('pending','consolidated') AND (created_at<${date} OR (created_at=${date} AND id<${cursor}))
              AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
              ORDER BY created_at DESC,id DESC LIMIT 8`;
              if (!rows.length) break;
              const chunks: string[] = [];
              for (const row of rows) {
                const digest = memoryHash(row.text);
                chunks.push(
                  `## ${row.created_at} · ${row.origin} · ${row.verification} [${row.id}]\n${seen.has(digest) ? "동일 본문의 추가 출처" : row.text}\n근거: ${row.source_json}`,
                );
                if (seen.size < 4096) seen.add(digest);
              }
              const body = `# ${topic.topic}\n\n최신 기록부터 나열한 근거 모음입니다. 현재 사용자 지시·명시적 정정을 우선하고, 에이전트 보고는 검증 전 사실로 확정하지 마세요.\n\n${chunks.join("\n\n")}\n`;
              yield* io(() =>
                publishMemoryFile(
                  NodePath.join(root, "topics", `${prefix}-${String(part++).padStart(4, "0")}.md`),
                  body,
                ),
              );
              yield* sql`UPDATE workspace_memory_v2 SET status='consolidated' WHERE id IN ${sql.in(rows.map((row) => row.id))}`;
              for (const row of rows)
                yield* io(() => archiveMemoryFile(inbox(row.project_id, row.scope, row.id)));
              date = rows.at(-1)!.created_at;
              cursor = rows.at(-1)!.id;
              written++;
              yield* Effect.yieldNow;
            }
            yield* io(() => withdrawMemoryPages(NodePath.join(root, "topics"), prefix, part));
            yield* sql`DELETE FROM workspace_memory_v2_dirty WHERE topic=${topic.topic} AND ${topic.scope === "global" ? sql`scope='global'` : sql`scope='project' AND project_id=${projectId}`}`;
          }
        }
        const userUtteranceRows = yield* sql<{
          message_id: string;
          thread_id: string;
          thread_title: string | null;
          text: string;
          created_at: string;
        }>`SELECT m.message_id, m.thread_id, t.title AS thread_title, substr(m.text, 1, ${MAX_NOTE_CHARS}) AS text, m.created_at
          FROM projection_thread_messages m
          JOIN projection_threads t ON t.thread_id = m.thread_id
          WHERE t.project_id = ${projectId}
            AND t.deleted_at IS NULL
            AND m.role = 'user'
            AND m.is_streaming = 0
            AND length(trim(m.text)) > 0
            AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM projection_turns p WHERE p.thread_id = m.thread_id AND p.turn_id = m.turn_id AND p.state IN ('completed','interrupted','error')))
            AND ${messageIsNotForgotten(projectId)}
          ORDER BY m.rowid DESC
          LIMIT 200`;
        const assistantMessageRows = yield* sql<{
          message_id: string;
          thread_id: string;
          thread_title: string | null;
          text: string;
          created_at: string;
        }>`SELECT m.message_id, m.thread_id, t.title AS thread_title, substr(m.text, 1, ${MAX_NOTE_CHARS}) AS text, m.created_at
          FROM projection_thread_messages m
          JOIN projection_threads t ON t.thread_id = m.thread_id
          WHERE t.project_id = ${projectId}
            AND t.deleted_at IS NULL
            AND m.role = 'assistant'
            AND m.is_streaming = 0
            AND length(trim(m.text)) > 0
            AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM projection_turns p WHERE p.thread_id = m.thread_id AND p.turn_id = m.turn_id AND p.state IN ('completed','interrupted','error')))
            AND ${messageIsNotForgotten(projectId)}
          ORDER BY m.rowid DESC
          LIMIT 80`;
        const agentKnowledgeRows = yield* sql<{
          item_id: string;
          title: string;
          content: string;
          updated_at: string;
        }>`SELECT item_id, title, substr(content, 1, ${MAX_NOTE_CHARS}) AS content, updated_at
          FROM projection_workspace_knowledge_items
          WHERE project_id = ${projectId}
            AND status = 'active'
            AND origin IN ('agent', 'imported')
          ORDER BY updated_at DESC, item_id DESC
          LIMIT 80`;
        const separated = yield* io(() =>
          publishSeparatedConversationCorpora(directory(projectId, "project"), {
            userUtterances: userUtteranceRows.map((row) => ({
              id: row.message_id,
              threadId: row.thread_id,
              threadTitle: row.thread_title,
              text: row.text,
              createdAt: row.created_at,
            })),
            aiOutputs: [
              ...assistantMessageRows.map((row) => ({
                id: `message:${row.message_id}`,
                kind: "assistant_message" as const,
                title: row.thread_title?.trim() || row.thread_id,
                threadId: row.thread_id,
                text: row.text,
                createdAt: row.created_at,
              })),
              ...agentKnowledgeRows.map((row) => ({
                id: `knowledge:${row.item_id}`,
                kind: "agent_knowledge" as const,
                title: row.title,
                text: row.content,
                createdAt: row.updated_at,
              })),
            ],
          }),
        );
        for (const scope of ["project", "global"]) {
          const text = yield* manifest(projectId, scope);
          yield* io(() =>
            publishMemoryFile(NodePath.join(directory(projectId, scope), "MEMORY.md"), text),
          );
        }
        const coldCutoffMs = clock.currentTimeMillisUnsafe() - COLD_OFFLOAD_INACTIVE_MS;
        const staleColdRows = yield* sql<{
          id: string;
          project_id: string;
          scope: string;
          topic: string;
          text: string;
          source_json: string;
          origin: string;
          verification: string;
          created_at: string;
          valid_from: number | null;
          valid_to: number | null;
          last_accessed_at: number | null;
          access_count: number | null;
        }>`SELECT id, project_id, scope, topic, text, source_json, origin, verification, created_at,
                  valid_from, valid_to, last_accessed_at, access_count
           FROM workspace_memory_v2
           WHERE project_id = ${projectId}
             AND memory_tier = 'cold'
             AND status != 'forgotten'
             AND COALESCE(last_accessed_at, valid_from, 0) <= ${coldCutoffMs}
           ORDER BY created_at DESC, id DESC
           LIMIT 500`;
        const coldArchive =
          staleColdRows.length > 0
            ? yield* io(() =>
                writeColdMemoryGzipArchive(
                  coldMemoryArchivePath(config.stateDir, projectId),
                  staleColdRows.map((row) => ({
                    id: row.id,
                    projectId: row.project_id,
                    scope: row.scope,
                    topic: row.topic,
                    text: row.text,
                    sourceJson: row.source_json,
                    origin: row.origin,
                    verification: row.verification,
                    createdAt: row.created_at,
                    validFrom: row.valid_from,
                    validTo: row.valid_to,
                    lastAccessedAt: row.last_accessed_at,
                    accessCount: row.access_count ?? 0,
                  })),
                ),
              )
            : { archivedCount: 0, rawBytes: 0, gzipBytes: 0 };
        const routingDream = yield* runDreamCrystallizationCycle(sql, {
          projectId,
          maxItemsPerCycle: 160,
          maxReportsPerCycle: 4,
        }).pipe(
          Effect.orElseSucceed(() => ({
            indexedKnowledgeCount: 0,
            indexedMemoryCount: 0,
            edgesCreated: 0,
            reportsSynthesized: 0,
          })),
        );
        return {
          topicPagesWritten: written,
          separatedUserPagesWritten: separated.userPagesWritten,
          separatedAiPagesWritten: separated.aiPagesWritten,
          coldArchivedCount: coldArchive.archivedCount,
          coldArchiveGzipBytes: coldArchive.gzipBytes,
          routingGraphIndexed: routingDream.indexedKnowledgeCount + routingDream.indexedMemoryCount,
          routingGraphEdges: routingDream.edgesCreated,
          routingGraphReports: routingDream.reportsSynthesized,
          consolidation: "source-preserving-extractive",
          ...tiering,
        };
      });
      const messageCapture = (projectId: string, row: MessageRow): Capture => ({
        projectId,
        id: memoryHash(`message:${row.message_id}`),
        topic: row.role === "user" ? CONVERSATION_USER_TOPIC : CONVERSATION_REPORT_TOPIC,
        text: row.text,
        source: {
          kind: "message",
          id: row.message_id,
          projectId,
          threadId: row.thread_id,
          turnId: row.turn_id,
          length: row.text_length,
          excerpt: row.text_length > MAX_NOTE_CHARS,
        },
        origin: row.role,
        verification: row.role === "user" ? "user-statement" : "unverified-report",
        createdAt: row.created_at,
        durable: classifyMemorySalience(row.role, row.text) !== "ordinary",
      });
      const backfill = Effect.fn("WorkspaceMemory.backfill")(function* (projectId: string) {
        if ((yield* checkedProject(projectId)).conversationRag?.enabled === false)
          return { processed: 0, hasMore: false };
        const key = `messages:${projectId}`;
        const [progress] = yield* sql<{
          position: number;
        }>`SELECT position FROM workspace_memory_v2_progress WHERE stream_key=${key}`;
        const rows =
          yield* sql<MessageRow>`SELECT m.rowid,m.message_id,m.thread_id,m.turn_id,m.role,substr(m.text,1,${MAX_NOTE_CHARS}) AS text,length(m.text) AS text_length,m.created_at,m.updated_at,
        (m.is_streaming=0 AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM projection_turns p WHERE p.thread_id=m.thread_id AND p.turn_id=m.turn_id AND p.state IN ('completed','interrupted','error')))) AS settled
        FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND m.rowid>${progress?.position ?? 0} ORDER BY m.rowid LIMIT ${PAGE_SIZE}`;
        const prepared = yield* Effect.forEach(
          rows,
          (row) =>
            row.settled && row.text.trim()
              ? prepareCapture(messageCapture(projectId, row))
              : Effect.succeed(undefined),
          { concurrency: 1 },
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const row of rows) {
              if (!row.settled)
                yield* sql`INSERT OR IGNORE INTO workspace_memory_v2_pending(message_id,project_id) VALUES (${row.message_id},${projectId})`;
            }
            for (const entry of prepared) if (entry) yield* persistCapture(entry);
            if (rows.length)
              yield* sql`INSERT INTO workspace_memory_v2_progress(stream_key,position,updated_at) VALUES (${key},${rows.at(-1)!.rowid},${now()}) ON CONFLICT(stream_key) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at`;
          }),
        );
        const pending =
          yield* sql<MessageRow>`SELECT m.rowid,m.message_id,m.thread_id,m.turn_id,m.role,substr(m.text,1,${MAX_NOTE_CHARS}) AS text,length(m.text) AS text_length,m.created_at,m.updated_at,1 AS settled
        FROM workspace_memory_v2_pending q JOIN projection_thread_messages m ON m.message_id=q.message_id JOIN projection_threads t ON t.thread_id=m.thread_id
        WHERE q.project_id=${projectId} AND t.deleted_at IS NULL AND m.is_streaming=0 AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM projection_turns p WHERE p.thread_id=m.thread_id AND p.turn_id=m.turn_id AND p.state IN ('completed','interrupted','error')))
        ORDER BY m.rowid LIMIT ${PAGE_SIZE}`;
        const preparedPending = yield* Effect.forEach(
          pending,
          (row) =>
            row.text.trim()
              ? prepareCapture(messageCapture(projectId, row))
              : Effect.succeed(undefined),
          { concurrency: 1 },
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const entry of preparedPending) if (entry) yield* persistCapture(entry);
          }),
        );
        for (const row of pending) {
          if (row.text_length > MAX_NOTE_CHARS) yield* indexLongMessage(projectId, row);
          yield* sql`DELETE FROM workspace_memory_v2_pending WHERE message_id=${row.message_id}`;
        }
        return {
          processed: rows.length + pending.length,
          hasMore: rows.length === PAGE_SIZE || pending.length === PAGE_SIZE,
        };
      });
      const backfillLongMessages = Effect.fn("WorkspaceMemory.backfillLongMessages")(function* (
        projectId: string,
      ) {
        const key = `long-messages:${projectId}`;
        const [progress] = yield* sql<{
          position: number;
        }>`SELECT position FROM workspace_memory_v2_progress WHERE stream_key=${key}`;
        const rows =
          yield* sql<MessageRow>`SELECT m.rowid,m.message_id,m.thread_id,m.turn_id,m.role,substr(m.text,1,${MAX_NOTE_CHARS}) AS text,length(m.text) AS text_length,m.created_at,m.updated_at,
          (m.is_streaming=0 AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM projection_turns p WHERE p.thread_id=m.thread_id AND p.turn_id=m.turn_id AND p.state IN ('completed','interrupted','error')))) AS settled
          FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id
          WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND m.rowid>${progress?.position ?? 0} AND length(CAST(m.text AS BLOB))>${MAX_NOTE_CHARS}
          ORDER BY m.rowid LIMIT ${PAGE_SIZE}`;
        for (const row of rows) {
          if (!row.settled) {
            yield* sql`INSERT OR IGNORE INTO workspace_memory_v2_pending(message_id,project_id) VALUES (${row.message_id},${projectId})`;
          } else if (row.text.trim()) {
            yield* capture(messageCapture(projectId, row));
            yield* indexLongMessage(projectId, row);
          }
          yield* sql`INSERT INTO workspace_memory_v2_progress(stream_key,position,updated_at) VALUES (${key},${row.rowid},${now()})
            ON CONFLICT(stream_key) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at`;
        }
        return rows.length === PAGE_SIZE;
      });
      const refreshLongMessages = Effect.fn("WorkspaceMemory.refreshLongMessages")(function* (
        projectId: string,
      ) {
        while (true) {
          const rows =
            yield* sql<MessageRow>`SELECT m.rowid,m.message_id,m.thread_id,m.turn_id,m.role,substr(m.text,1,${MAX_NOTE_CHARS}) AS text,length(m.text) AS text_length,m.created_at,m.updated_at,1 AS settled
            FROM workspace_memory_v2_chunk_state s JOIN projection_thread_messages m ON m.message_id=s.source_id
            JOIN projection_threads t ON t.thread_id=m.thread_id
            WHERE s.project_id=${projectId} AND s.source_kind='message' AND t.project_id=${projectId} AND t.deleted_at IS NULL
            AND s.source_version<>(m.updated_at || ':' || length(m.text)) AND m.is_streaming=0
            AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM projection_turns p WHERE p.thread_id=m.thread_id AND p.turn_id=m.turn_id AND p.state IN ('completed','interrupted','error')))
            ORDER BY m.rowid LIMIT ${PAGE_SIZE}`;
          for (const row of rows) {
            yield* capture(messageCapture(projectId, row));
            yield* indexLongMessage(projectId, row);
          }
          if (rows.length < PAGE_SIZE) break;
          yield* Effect.yieldNow;
        }
      });
      const reconcileUnsafe = Effect.fn("WorkspaceMemory.reconcile")(function* (
        projectId: ProjectId,
      ) {
        if ((yield* checkedProject(projectId)).conversationRag?.enabled === false) return;
        let cursor = "";
        while (true) {
          const notes = yield* sql<{
            item_id: string;
            title: string;
            content: string;
            content_length: number;
            status: string;
            origin: string;
            scope: string;
            created_at: string;
            updated_at: string;
          }>`SELECT item_id,title,substr(content,1,${MAX_NOTE_CHARS}) AS content,length(content) AS content_length,status,origin,scope,created_at,updated_at FROM projection_workspace_knowledge_items
          WHERE project_id=${projectId} AND kind IN ('directive','goal','prompt','long-term-memory') AND item_id>${cursor} ORDER BY item_id LIMIT ${PAGE_SIZE}`;
          for (const note of notes) {
            const id = memoryHash(`knowledge:${projectId}:${note.item_id}`);
            if (note.status !== "active" || note.scope === "folder") {
              const [old] =
                yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 WHERE id=${id} AND status NOT IN ('archived','forgotten')`;
              if (old) {
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* dirty(old.project_id, old.scope, old.topic);
                    yield* sql`UPDATE workspace_memory_v2 SET status='archived' WHERE id=${id}`;
                    derivedRowCache.delete(id);
                    yield* clearChunks(id);
                    yield* sql`DELETE FROM workspace_memory_v2_chunk_state WHERE memory_id=${id}`;
                  }),
                );
                yield* io(() => archiveMemoryFile(inbox(old.project_id, old.scope, id)));
              }
            } else {
              yield* capture({
                projectId,
                id,
                topic: note.title,
                text: note.content,
                source: {
                  kind: "knowledge",
                  id: note.item_id,
                  projectId,
                  updatedAt: note.updated_at,
                },
                origin: note.origin,
                verification: note.origin === "user" ? "user-statement" : "unverified-report",
                createdAt: note.updated_at,
                scope: note.scope === "environment" ? "global" : "project",
                durable: true,
              });
              yield* indexLongSource({
                projectId,
                memoryId: id,
                kind: "knowledge",
                sourceId: note.item_id,
                updatedAt: note.updated_at,
                length: note.content_length,
              });
            }
          }
          if (notes.length < PAGE_SIZE) break;
          cursor = notes.at(-1)!.item_id;
          yield* Effect.yieldNow;
        }
        let more = true;
        while (more) {
          more = (yield* backfill(projectId)).hasMore;
          yield* Effect.yieldNow;
        }
        more = true;
        while (more) {
          more = yield* backfillLongMessages(projectId);
          yield* Effect.yieldNow;
        }
        yield* refreshLongMessages(projectId);
        yield* dream(projectId);
      });
      const sourceScopeIsCurrent = sql`CASE WHEN json_valid(r.source_json) THEN (
        json_extract(r.source_json,'$.kind') <> 'knowledge' OR EXISTS (
          SELECT 1 FROM projection_workspace_knowledge_items k
          WHERE k.project_id=r.project_id AND k.item_id=json_extract(r.source_json,'$.id')
            AND k.status='active' AND (
              (r.scope='project' AND k.scope='project') OR
              (r.scope='global' AND k.scope='environment')
            )
        )
      ) ELSE 0 END`;
      const search = Effect.fn("WorkspaceMemory.search")(
        function* (
          projectId: string,
          query: string,
          limit = 8,
          excludeFromThread?: { readonly threadId: ThreadId; readonly fromRowid: number },
          folder?: string,
          speaker: WorkspaceMemorySpeakerFilter = "all",
          searchOptions?: {
            readonly layer?: WorkspaceMemoryLayerFilter | undefined;
            readonly fromDate?: string | undefined;
            readonly toDate?: string | undefined;
            readonly includeSuperseded?: boolean | undefined;
          },
        ) {
          const nowMs = clock.currentTimeMillisUnsafe();
          const parsed = buildSearchQuery(query);
          const parsedTemporal = parseKoreanTemporalRange(query, nowMs);
          const queryEntities = extractMemoryEntities(query);
          if (!parsed && parsedTemporal === null && queryEntities.length === 0) {
            yield* increment(memorySearchResultsTotal, { result: "empty-query" });
            return [];
          }
          const candidateLimit = Math.min(64, Math.max(limit, limit * 8));
          const beforeCurrent = excludeFromThread
            ? sql`CASE WHEN json_valid(r.source_json) THEN (
              json_extract(r.source_json,'$.kind') NOT IN ('message','observation') OR (
                json_extract(r.source_json,'$.kind')='message' AND NOT EXISTS (
                  SELECT 1 FROM projection_thread_messages m
                  WHERE m.message_id=json_extract(r.source_json,'$.id')
                    AND m.thread_id=${excludeFromThread.threadId} AND m.rowid>=${excludeFromThread.fromRowid}
                )
              ) OR (
                json_extract(r.source_json,'$.kind')='observation' AND NOT EXISTS (
                  SELECT 1 FROM workspace_memory_v2 pf
                  JOIN projection_thread_messages m ON m.message_id=json_extract(pf.source_json,'$.id')
                  WHERE pf.id=json_extract(r.source_json,'$.id')
                    AND json_valid(pf.source_json)
                    AND json_extract(pf.source_json,'$.kind')='message'
                    AND m.thread_id=${excludeFromThread.threadId} AND m.rowid>=${excludeFromThread.fromRowid}
                )
              )
            ) ELSE 0 END`
            : sql`1=1`;
          const inFolder =
            folder === undefined
              ? sql`1=1`
              : sql`(
          r.scope='global' OR (r.project_id=${projectId} AND CASE
            WHEN json_extract(r.source_json,'$.kind')='message' THEN EXISTS (
              SELECT 1 FROM projection_thread_messages m
              JOIN workspace_memory_v2_message_folders f ON f.message_id=(
                SELECT u.message_id FROM projection_thread_messages u
                WHERE u.thread_id=m.thread_id AND u.role='user' AND u.rowid<=m.rowid
                ORDER BY u.rowid DESC LIMIT 1
              )
              WHERE m.message_id=json_extract(r.source_json,'$.id') AND f.project_id=${projectId} AND f.folder=${folder}
            )
            WHEN json_extract(r.source_json,'$.kind')='manual' THEN json_extract(r.source_json,'$.folder')=${folder}
            WHEN json_extract(r.source_json,'$.kind')='observation' THEN coalesce(json_extract(r.source_json,'$.folder'),'')=${folder}
            WHEN json_extract(r.source_json,'$.kind')='knowledge' THEN ${folder}=''
            ELSE 0 END)
        )`;
          const includeHistorical =
            searchOptions?.includeSuperseded === true || isHistoricalMemoryQuery(query);
          const activeTemporalFilter = includeHistorical
            ? sql`1=1`
            : sql`r.expired_at IS NULL AND r.superseded_by_id IS NULL`;
          const matchesSpeaker =
            speaker === "user"
              ? sql`r.origin IN ('user','user-requested')`
              : speaker === "ai"
                ? sql`r.origin NOT IN ('user','user-requested')`
                : sql`1=1`;
          const layerFilter =
            searchOptions?.layer === "observation"
              ? sql`r.memory_layer='observation'`
              : searchOptions?.layer === "fact"
                ? sql`coalesce(r.memory_layer,'fact')='fact'`
                : sql`1=1`;
          const fromMs = searchOptions?.fromDate ? Date.parse(searchOptions.fromDate) : NaN;
          const toMs = searchOptions?.toDate ? Date.parse(searchOptions.toDate) : NaN;
          const explicitDateFilter =
            Number.isFinite(fromMs) && Number.isFinite(toMs)
              ? sql`r.valid_from >= ${fromMs} AND r.valid_from <= ${toMs + 86_399_999}`
              : Number.isFinite(fromMs)
                ? sql`r.valid_from >= ${fromMs}`
                : Number.isFinite(toMs)
                  ? sql`r.valid_from <= ${toMs + 86_399_999}`
                  : sql`1=1`;

          const rows = parsed
            ? yield* sql<RecordRow>`SELECT r.* FROM workspace_memory_v2_fts f JOIN workspace_memory_v2 r ON r.id=f.id
        WHERE workspace_memory_v2_fts MATCH ${parsed.match} AND (r.project_id=${projectId} OR r.scope='global') AND r.status NOT IN ('forgotten','archived')
        AND ${activeTemporalFilter}
        AND ${layerFilter}
        AND ${explicitDateFilter}
        AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
        AND ${sourceScopeIsCurrent}
        AND ${beforeCurrent}
        AND ${inFolder}
        AND ${matchesSpeaker}
        ORDER BY bm25(workspace_memory_v2_fts),r.created_at DESC,r.id LIMIT ${candidateLimit}`
            : [];
          const chunks = parsed
            ? yield* sql<RecordRow & { chunk_text: string }>`
          WITH hits AS MATERIALIZED (
            SELECT r.id AS memory_id,c.rowid AS chunk_rowid,bm25(workspace_memory_v2_chunks) AS score
            FROM workspace_memory_v2_chunks c JOIN workspace_memory_v2 r ON r.id=c.memory_id
            WHERE workspace_memory_v2_chunks MATCH ${parsed.match} AND (r.project_id=${projectId} OR r.scope='global')
            AND r.status NOT IN ('forgotten','archived')
            AND ${activeTemporalFilter}
            AND ${layerFilter}
            AND ${explicitDateFilter}
            AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
            AND ${sourceScopeIsCurrent}
            AND ${beforeCurrent}
            AND ${inFolder}
            AND ${matchesSpeaker}
          ), ranked AS (
            SELECT *,row_number() OVER (PARTITION BY memory_id ORDER BY score,chunk_rowid) AS ordinal FROM hits
          )
          SELECT r.*,c.chunk_text FROM ranked h JOIN workspace_memory_v2 r ON r.id=h.memory_id
          JOIN workspace_memory_v2_chunks c ON c.rowid=h.chunk_rowid WHERE h.ordinal=1
          ORDER BY h.score,r.created_at DESC,r.id LIMIT ${candidateLimit}`
            : [];

          // Arm 3 & Arm 4 supplemental candidates: pull shared-entity observations (e.g. option_plan:
          // "그냥 A안으로 할까?" matching "B안 채택 (이유: 비용 문제)") and temporal-window hits.
          const supplementalRows: RecordRow[] = [];
          if (queryEntities.length > 0 && searchOptions?.layer !== "fact") {
            const entityLikeClauses = queryEntities
              .slice(0, 4)
              .map((ent) => `%${ent.replace(/[%_]/g, "")}%`);
            const entityObs = yield* sql<RecordRow>`SELECT r.* FROM workspace_memory_v2 r
              WHERE (r.project_id=${projectId} OR r.scope='global')
                AND r.status NOT IN ('forgotten','archived')
                AND r.memory_layer='observation'
                AND ${activeTemporalFilter}
                AND ${explicitDateFilter}
                AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
                AND ${sourceScopeIsCurrent}
                AND ${beforeCurrent}
                AND ${inFolder}
                AND ${matchesSpeaker}
              ORDER BY r.valid_from DESC, r.id ASC LIMIT 24`;
            for (const obsRow of entityObs) {
              const hay = `${obsRow.entities_json ?? ""} ${obsRow.entity_key ?? ""}`.toLowerCase();
              if (entityLikeClauses.some((pat) => hay.includes(pat.slice(1, -1)))) {
                supplementalRows.push(obsRow);
              }
            }
          }
          if (parsedTemporal !== null) {
            const windowRows = yield* sql<RecordRow>`SELECT r.* FROM workspace_memory_v2 r
              WHERE (r.project_id=${projectId} OR r.scope='global')
                AND r.status NOT IN ('forgotten','archived')
                AND r.valid_from >= ${parsedTemporal.startMs}
                AND r.valid_from <= ${parsedTemporal.endMs}
                AND ${layerFilter}
                AND ${explicitDateFilter}
                AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL)
                AND ${sourceScopeIsCurrent}
                AND ${beforeCurrent}
                AND ${inFolder}
                AND ${matchesSpeaker}
              ORDER BY r.heat_score DESC, r.valid_from DESC, r.id ASC LIMIT 24`;
            supplementalRows.push(...windowRows);
          }

          const queryTerms = parsed?.terms ?? [];
          const lexicalCandidates = [
            ...rows.map((row, rank) => ({ row, rank })),
            ...chunks.map(({ chunk_text, ...row }, rank) => ({
              row: { ...row, text: chunk_text, partialSource: true },
              rank,
            })),
          ].map((candidate) => ({
            ...candidate,
            coverage: termCoverage(queryTerms, candidate.row.text),
          }));
          lexicalCandidates.sort((a, b) => b.coverage - a.coverage || a.rank - b.rank);

          const unique = new Map<string, RecordRow & { lexicalRank?: number }>();
          lexicalCandidates.forEach((candidate, idx) => {
            if (!unique.has(candidate.row.id)) {
              unique.set(candidate.row.id, { ...candidate.row, lexicalRank: idx });
            }
          });
          for (const supp of supplementalRows) {
            if (!unique.has(supp.id)) {
              unique.set(supp.id, supp);
            }
          }

          const fusedPool = rankMemoryCandidates4Arm([...unique.values()], query, nowMs, {
            explicitRange: parsedTemporal,
          });
          const evidence = selectMemoryEvidence(fusedPool, query, limit, nowMs, {
            includeSuperseded: searchOptions?.includeSuperseded,
          });
          yield* increment(memorySearchResultsTotal, {
            result: evidence.length > 0 ? "hit" : "miss",
          });
          return evidence;
        },
        withMetrics({ counter: memorySearchesTotal, timer: memorySearchDuration }),
      );
      const context = Effect.fn("WorkspaceMemory.context")(function* (
        projectId: ProjectId,
        task: string,
        directivesOnly = false,
        current?: {
          readonly threadId: ThreadId;
          readonly messageId: MessageId;
          readonly inheritFolder?: boolean;
          readonly excludeDirectives?: boolean;
          readonly excludeDirectiveReferences?: ReadonlyArray<{
            readonly projectId: ProjectId;
            readonly itemId: string;
          }>;
          readonly excludeRecentConversation?: boolean;
          readonly includedKnowledge?: {
            readonly prompt: string;
            readonly sourcePassages: ReadonlyArray<{
              readonly projectId: ProjectId;
              readonly itemId: string;
              readonly start: number;
              readonly end: number;
            }>;
          };
        },
        directiveOptions?: WorkspaceDirectiveOptions,
      ) {
        const settings = yield* checkedProject(projectId);
        // Read-only: the folder recorded for this message (or, for automation, the
        // previous user message). Recording stays with contextPaths/the history path.
        let directiveFolders = directiveOptions?.folderPaths;
        if (directiveFolders === undefined && current && !current.excludeDirectives) {
          const [own] = yield* sql<{ folder: string }>`
            SELECT folder FROM workspace_memory_v2_message_folders
            WHERE message_id=${current.messageId} AND thread_id=${current.threadId} AND project_id=${projectId}`;
          let folder = own?.folder;
          if (own === undefined && current.inheritFolder) {
            const [inherited] = yield* sql<{ folder: string | null }>`
              SELECT f.folder FROM projection_thread_messages u
              JOIN projection_thread_messages c ON c.thread_id=u.thread_id AND c.message_id=${current.messageId}
              LEFT JOIN workspace_memory_v2_message_folders f ON f.message_id=u.message_id AND f.project_id=${projectId}
              WHERE u.thread_id=${current.threadId} AND u.role='user' AND u.rowid<c.rowid
              ORDER BY u.rowid DESC LIMIT 1`;
            folder = inherited?.folder ?? undefined;
          }
          directiveFolders = folder ? [folder] : [];
        }
        const directives = yield* sql<{
          project_id: string;
          item_id: string;
          content: string;
          scope: string;
          applies_to_folder: string | null;
        }>`
          SELECT k.project_id,k.item_id,k.content,k.scope,k.applies_to_folder FROM projection_workspace_knowledge_items k
          JOIN projection_projects p ON p.project_id=k.project_id
          WHERE p.deleted_at IS NULL AND k.status='active' AND k.origin='user' AND k.kind='directive'
          AND (k.scope='environment' OR (k.project_id=${projectId} AND k.scope IN ('project','folder')))
          ORDER BY k.updated_at,k.project_id,k.item_id`;
        const presentIn = directiveOptions?.presentIn;
        const selectedDirectives = directives.filter(
          (item) =>
            (item.scope !== "folder" ||
              ((directiveFolders?.length ?? 0) > 0 &&
                knowledgeAppliesToContext(
                  {
                    projectId: item.project_id as ProjectId,
                    scope: "folder",
                    appliesToFolder: item.applies_to_folder,
                  },
                  { projectId, contextPaths: directiveFolders ?? [] },
                ))) &&
            !current?.excludeDirectiveReferences?.some(
              (reference) =>
                reference.projectId === item.project_id && reference.itemId === item.item_id,
            ) &&
            !(presentIn && item.content.trim() && presentIn.includes(item.content.trim())),
        );
        // Broad directives first keep a stable prompt prefix; the folder guide sits
        // nearest the task because it changes with the folder.
        const broadDirectives = selectedDirectives.filter((item) => item.scope !== "folder");
        const folderGuides = selectedDirectives.filter((item) => item.scope === "folder");
        const required =
          current?.excludeDirectives || selectedDirectives.length === 0
            ? ""
            : [
                "<t3_user_directives>",
                "사용자가 명시한 필수 지침입니다. 공용 지침은 모든 프로젝트에 적용합니다. 검색 관련도와 자동 기억 설정에 관계없이 적용하고, 현재 사용자 지시와 최신 명시적 정정을 우선하세요.",
                ...broadDirectives.map(
                  (item) => `[${item.project_id}/${item.item_id}]\n${item.content}`,
                ),
                ...(folderGuides.length > 0
                  ? [
                      "폴더 답변 가이드: 현재 작업 폴더에 지정된 지침이며 위 공용·프로젝트 지침보다 구체적인 경우 이를 따르세요.",
                    ]
                  : []),
                ...folderGuides.map(
                  (item) =>
                    `[${item.project_id}/${item.item_id} · ${item.applies_to_folder}]\n${item.content}`,
                ),
                "</t3_user_directives>",
              ].join("\n\n");
        if (
          directivesOnly ||
          settings.conversationRag?.enabled === false ||
          settings.contextOptimization?.autoChatMemory === false
        )
          return required;
        type RecentMessage = {
          rowid: number;
          message_id: string;
          role: string;
          text: string;
          truncated: number;
          created_at: string;
        };
        let recent: ReadonlyArray<RecentMessage> = [];
        let boundaryRowid: number | undefined;
        let currentFolder: string | undefined;
        let hasUnclassifiedHistory = false;
        if (current) {
          yield* checkedThread(projectId, current.threadId);
          const [boundary] = yield* sql<{
            rowid: number;
          }>`SELECT rowid FROM projection_thread_messages WHERE thread_id=${current.threadId} AND message_id=${current.messageId}`;
          if (!boundary) {
            return yield* new WorkspaceMemoryError({
              message: "현재 대화의 메시지 위치를 확인하지 못했습니다.",
            });
          }
          boundaryRowid = boundary.rowid;
          let [selected] = yield* sql<{
            folder: string | null;
          }>`SELECT folder FROM workspace_memory_v2_message_folders
            WHERE message_id=${current.messageId} AND thread_id=${current.threadId} AND project_id=${projectId}`;
          if (!selected && current.inheritFolder) {
            [selected] = yield* sql<{
              folder: string | null;
            }>`SELECT f.folder FROM projection_thread_messages u
              LEFT JOIN workspace_memory_v2_message_folders f ON f.message_id=u.message_id AND f.project_id=${projectId}
              WHERE u.thread_id=${current.threadId} AND u.role='user' AND u.rowid<${boundary.rowid}
              ORDER BY u.rowid DESC LIMIT 1`;
            if (selected?.folder != null)
              yield* sql`INSERT OR IGNORE INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder)
              SELECT message_id,${projectId},${current.threadId},${selected.folder} FROM projection_thread_messages
              WHERE thread_id=${current.threadId} AND message_id=${current.messageId} AND role='user'`;
          }
          if (!selected || selected.folder === null)
            return [
              required,
              "<t3_folder_memory_unavailable>현재 요청의 대화 기억에 적용할 폴더 범위가 기록되지 않아 이전 대화 기억 검색을 생략했습니다. 폴더가 없다는 뜻은 아닙니다. 기존 기록은 보존되어 있으며 확인되지 않은 기억을 읽었다고 추측하지 마세요.</t3_folder_memory_unavailable>",
            ]
              .filter(Boolean)
              .join("\n\n");
          currentFolder = selected.folder;
          const [unclassified] = yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM projection_thread_messages m
            WHERE m.thread_id=${current.threadId} AND m.role='user' AND m.rowid<${boundary.rowid}
            AND NOT EXISTS(SELECT 1 FROM workspace_memory_v2_message_folders f WHERE f.message_id=m.message_id AND f.project_id=${projectId})`;
          hasUnclassifiedHistory = (unclassified?.count ?? 0) > 0;
          recent =
            current.excludeRecentConversation === true
              ? []
              : yield* sql<RecentMessage>`SELECT m.rowid,m.message_id,m.role,substr(m.text,1,2000) AS text,length(m.text)>2000 AS truncated,m.created_at
            FROM projection_thread_messages m WHERE m.thread_id=${current.threadId} AND m.rowid<${boundary.rowid}
            AND m.is_streaming=0 AND length(trim(m.text))>0 AND ${messageIsNotForgotten(projectId)} AND EXISTS (
              SELECT 1 FROM workspace_memory_v2_message_folders f WHERE f.project_id=${projectId} AND f.folder=${currentFolder}
              AND f.message_id=(SELECT u.message_id FROM projection_thread_messages u WHERE u.thread_id=m.thread_id AND u.role='user' AND u.rowid<=m.rowid ORDER BY u.rowid DESC LIMIT 1)
            ) ORDER BY m.rowid DESC LIMIT 30`;
        }
        let previousUser = recent.find((row) => row.role === "user");
        if (!previousUser && current && boundaryRowid !== undefined) {
          [previousUser] =
            yield* sql<RecentMessage>`SELECT m.rowid,m.message_id,m.role,substr(m.text,1,2000) AS text,length(m.text)>2000 AS truncated,m.created_at
            FROM projection_thread_messages m WHERE m.thread_id=${current.threadId} AND m.rowid<${boundaryRowid}
            AND m.role='user' AND m.is_streaming=0 AND length(trim(m.text))>0 AND ${messageIsNotForgotten(projectId)} AND EXISTS (
              SELECT 1 FROM workspace_memory_v2_message_folders f WHERE f.message_id=m.message_id AND f.project_id=${projectId} AND f.folder=${currentFolder ?? ""}
            ) ORDER BY m.rowid DESC LIMIT 1`;
          if (previousUser && current.excludeRecentConversation !== true)
            recent = [...recent.slice(0, 29), previousUser];
        }
        let searchAnchor = previousUser;
        if (
          previousUser &&
          !hasMemorySearchAnchor(task) &&
          !hasMemorySearchAnchor(previousUser.text) &&
          current &&
          boundaryRowid !== undefined
        ) {
          let beforeRowid = previousUser.rowid;
          while (beforeRowid > 0) {
            const olderUsers =
              yield* sql<RecentMessage>`SELECT m.rowid,m.message_id,m.role,substr(m.text,1,2000) AS text,length(m.text)>2000 AS truncated,m.created_at
            FROM projection_thread_messages m WHERE m.thread_id=${current.threadId} AND m.rowid<${beforeRowid}
            AND m.role='user' AND m.is_streaming=0 AND length(trim(m.text))>0 AND ${messageIsNotForgotten(projectId)} AND EXISTS (
              SELECT 1 FROM workspace_memory_v2_message_folders f WHERE f.message_id=m.message_id AND f.project_id=${projectId} AND f.folder=${currentFolder ?? ""}
            ) ORDER BY m.rowid DESC LIMIT ${PAGE_SIZE}`;
            const substantive = olderUsers.find((row) => hasMemorySearchAnchor(row.text));
            if (substantive) {
              searchAnchor = substantive;
              break;
            }
            if (olderUsers.length < PAGE_SIZE) break;
            beforeRowid = olderUsers[olderUsers.length - 1]!.rowid;
            yield* Effect.yieldNow;
          }
        }
        vramArbiter.recordUserActivity(clock.currentTimeMillisUnsafe());
        const memoryBudget = resolveAdaptiveMemoryBudget(task);
        const query = [
          task,
          previousUser?.text,
          searchAnchor?.message_id !== previousUser?.message_id ? searchAnchor?.text : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n");
        const terms = buildSearchQuery(query)?.terms ?? [];
        const recentLines: Array<{
          rowid: number;
          messageId: string;
          complete: boolean;
          text: string;
        }> = [];
        let chars = 0;
        const prioritized = current?.excludeRecentConversation
          ? []
          : previousUser
            ? [previousUser, ...recent.filter((row) => row.message_id !== previousUser.message_id)]
            : recent;
        for (const row of prioritized) {
          const truncatedNote = row.truncated
            ? `\n[원문의 앞부분만 발췌했습니다. 조건과 정정을 확인하려면 workspace_memory read에서 message:${row.message_id}의 나머지를 조회하세요.]`
            : "";
          const line = `[${row.role}] [message:${row.message_id}] ${row.created_at}\n${row.text}${truncatedNote}`;
          if (chars + line.length > memoryBudget.maxRecentHistoryChars && recentLines.length >= 2)
            break;
          recentLines.push({
            rowid: row.rowid,
            messageId: row.message_id,
            complete: !row.truncated,
            text: line,
          });
          chars += line.length;
        }
        recentLines.sort((left, right) => left.rowid - right.rowid);
        const completeRecentIds = new Set(
          recentLines.filter((line) => line.complete).map((line) => line.messageId),
        );
        const candidates = yield* search(
          projectId,
          query,
          Math.min(64, memoryBudget.maxMemoryItems + completeRecentIds.size),
          current && boundaryRowid !== undefined
            ? { threadId: current.threadId, fromRowid: boundaryRowid }
            : undefined,
          currentFolder,
        );
        const matches: typeof candidates = [];
        for (const row of candidates) {
          const source = yield* decodeSource(row.source_json).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (
            source?.kind === "message" &&
            completeRecentIds.has(source.id) &&
            !row.additionalSources
          )
            continue;
          matches.push(row);
          if (matches.length === memoryBudget.maxMemoryItems) break;
        }
        const recentContext = recentLines.length
          ? `<t3_recent_conversation>\n현재 폴더에서 확인된 같은 대화의 최근 발언 발췌입니다(오래된 순). 현재 사용자 지시와 최신 명시적 정정이 우선이며, 에이전트의 보고는 완료 사실을 검증한 증거가 아닙니다. 필요한 근거는 workspace_memory search/read로 확인하세요.\n${recentLines.map((line) => line.text).join("\n\n")}\n</t3_recent_conversation>`
          : "";
        const chronologicalRecentUsers = current?.excludeRecentConversation
          ? []
          : [...prioritized]
              .filter((row) => row.role === "user")
              .sort((left, right) => left.rowid - right.rowid)
              .map((row) => ({
                id: row.message_id,
                text: row.text,
                createdAt: row.created_at,
              }));
        const recentStyleProfile =
          chronologicalRecentUsers.length > 0
            ? analyzeUserSpeechStyle(chronologicalRecentUsers)
            : null;
        const userStyleContext =
          recentStyleProfile && recentStyleProfile.analyzedVoiceSegmentCount > 0
            ? (() => {
                const registerLabel: Record<typeof recentStyleProfile.dominantRegister, string> = {
                  casual_banmal: "편한 반말·구어체",
                  polite_haeyo: "해요체",
                  formal_hapsipsio: "하십시오체",
                  concise_directive: "명사형·간결 지시체",
                  mixed: "반말·존댓말 혼용",
                };
                const habits = recentStyleProfile.habitObservations
                  .slice(0, 4)
                  .map((h) => `${h.label}(${h.count}회)`)
                  .join(", ");
                const endings = recentStyleProfile.frequentEndings
                  .slice(0, 5)
                  .map((e) => `-${e.ending}`)
                  .join(", ");
                return `<t3_user_speech_profile>\n내 대화 원문과 AI 작성·조사 결과는 분리 보관되며 AI는 두 영역을 모두 열람할 수 있습니다(workspace_memory speaker='user'|'ai'|'all', action='user_style').\n주 화법: ${registerLabel[recentStyleProfile.dominantRegister]} · 분석 발화 ${recentStyleProfile.analyzedVoiceSegmentCount}건(평균 ${recentStyleProfile.avgVoiceChars}자)${habits ? `\n화법 특징: ${habits}` : ""}${endings ? `\n자주 쓰는 종결: ${endings}` : ""}\n</t3_user_speech_profile>`;
              })()
            : "";
        let body = `<t3_memory_v2>\n과거 근거보다 현재 사용자 지시와 최신 정정이 우선이며 에이전트 보고는 미검증입니다. 성찰 사다리(Reflect Ladder): ① 지침·절차 대조 → ② 통합 관찰([관찰]) 및 결정 이유 확인 → ③ 이유·전후 맥락이 부족하면 단정하지 말고 workspace_memory search 또는 action='reflect'/read로 원본 Fact를 확인하세요. 사용자의 가벼운 제안이 과거 확정 결정의 명시적 이유(비용·보안·구조 등)와 충돌하면 당시 날짜와 이유를 먼저 짚어 제약 조건 변경 여부를 확인하세요.\n`;
        const injectedRows: typeof matches = [];
        for (const row of matches) {
          const source = yield* decodeSource(row.source_json).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const included = current?.includedKnowledge;
          const matched = matchedMemoryExcerptRange(row.text, terms, 1200);
          const matchedBody = row.text.slice(matched.start, matched.end);
          const bodyAlreadyIncluded =
            source?.kind === "knowledge" &&
            matchedBody.length > 0 &&
            included !== undefined &&
            included.sourcePassages.some(
              (passage) =>
                passage.projectId === (source.projectId ?? row.project_id) &&
                passage.itemId === source.id &&
                passage.start >= 0 &&
                passage.end >= passage.start &&
                passage.end <= included.prompt.length &&
                included.prompt.slice(passage.start, passage.end).includes(matchedBody),
            );
          const additional = row.additionalSources
            ? `\n동일 근거 ${row.additionalSources}개 추가 · 조회 ID: ${row.supportingIds?.join(", ")}`
            : "";
          const proofList =
            row.proof_fact_ids && row.proof_fact_ids !== "[]"
              ? Option.getOrElse(decodeIdList(row.proof_fact_ids), () => [])
              : [];
          const layerBadge =
            row.memory_layer === "observation"
              ? `[관찰${row.rationale ? ` · 이유: ${row.rationale}` : ""}${proofList.length > 0 ? ` · 근거Fact: ${proofList.join(", ")}` : ""}] `
              : row.rationale
                ? `[사실 · 이유: ${row.rationale}] `
                : "";
          const excerptText = bodyAlreadyIncluded
            ? "이 기억의 검색 발췌는 앞의 프로젝트 문맥에 이미 포함되어 있습니다. 발췌 범위 밖의 원문은 필요할 때 별도로 확인해야 합니다."
            : `${matched.text}${row.partialSource ? "\n[긴 원문의 일부입니다. 필요한 내용은 원문에서 확인하세요.]" : ""}`;
          const excerpt = `\n[${row.id}] ${layerBadge}${row.topic} · ${row.created_at} · ${row.verification}\n${excerptText}\n근거: ${row.source_json}${additional}\n`;
          if (
            Buffer.byteLength(body + excerpt + "</t3_memory_v2>") >
              memoryBudget.maxMemoryEvidenceChars &&
            injectedRows.length > 0
          )
            break;
          body += excerpt;
          injectedRows.push(row);
        }
        if (injectedRows.length > 0) {
          yield* recordMemoryAccessReinforcementEffect(
            sql,
            projectId,
            injectedRows,
            clock.currentTimeMillisUnsafe(),
          ).pipe(Effect.ignore);
        }
        return [
          required,
          hasUnclassifiedHistory
            ? "<t3_folder_history_unclassified>현재 요청의 기억은 기록된 폴더 범위로 조회했습니다. 일부 이전 대화는 당시 폴더가 기록되지 않아 자동 주입에서 제외했습니다. 원문은 보존되며 확인되지 않은 이전 기억을 읽었다고 추측하지 마세요.</t3_folder_history_unclassified>"
            : "",
          recentContext,
          userStyleContext,
          body + "</t3_memory_v2>",
        ]
          .filter(Boolean)
          .join("\n\n");
      });
      const history = Effect.fn("WorkspaceMemory.history")(function* (
        projectId: string,
        threadId: string,
        after = 0,
        query?: string,
        folder?: string,
        speaker: WorkspaceMemorySpeakerFilter = "all",
      ) {
        yield* checkedThread(projectId, threadId);
        const inFolder =
          folder === undefined
            ? sql`1=1`
            : sql`EXISTS (
          SELECT 1 FROM workspace_memory_v2_message_folders f WHERE f.project_id=${projectId} AND f.folder=${folder}
            AND f.message_id=(SELECT u.message_id FROM projection_thread_messages u
              WHERE u.thread_id=m.thread_id AND u.role='user' AND u.rowid<=m.rowid ORDER BY u.rowid DESC LIMIT 1)
        )`;
        const matchesSpeaker =
          speaker === "user"
            ? sql`m.role='user'`
            : speaker === "ai"
              ? sql`m.role<>'user'`
              : sql`1=1`;
        const rows =
          yield* sql<MessageRow>`SELECT m.rowid,m.message_id,m.thread_id,m.turn_id,m.role,substr(m.text,1,1200) AS text,length(m.text) AS text_length,m.created_at,m.updated_at FROM projection_thread_messages m
        WHERE m.thread_id=${threadId} AND m.rowid>${after} AND m.is_streaming=0 AND ${query ? sql`instr(lower(m.text),lower(${query}))>0` : sql`1=1`} AND ${inFolder} AND ${matchesSpeaker} AND ${folder === undefined ? sql`1=1` : messageIsNotForgotten(projectId)} ORDER BY m.rowid LIMIT 21`;
        const entries = rows.slice(0, 20);
        return {
          entries,
          next: rows.length > 20 ? entries.at(-1)!.rowid : null,
          complete: rows.length <= 20,
          note:
            folder === undefined
              ? "본문은 최대 1,200자 발췌입니다. 긴 원문은 read message:<message_id>와 offset으로 이어서 조회하세요. 활동·도구 원문까지 일관된 스냅샷으로 확인하려면 export를 사용하세요."
              : "현재 폴더가 확인된 메시지만 표시합니다. 다른 폴더와 폴더가 기록되지 않은 과거 기록은 제외했으며 원문은 보존됩니다. 본문은 최대 1,200자이며 긴 원문은 read message:<message_id>와 offset으로 이어서 조회하세요. 전체 대화 export는 사용할 수 없습니다.",
        };
      });
      const read = Effect.fn("WorkspaceMemory.read")(function* (
        projectId: string,
        id: string,
        offset = 0,
        folder?: string,
      ) {
        let source: typeof Source.Type;
        if (id.startsWith("message:") || id.startsWith("activity:")) {
          const [kind, ...rest] = id.split(":");
          source = { kind: kind!, id: rest.join(":"), projectId };
        } else {
          const [record] =
            yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 r WHERE id=${id} AND (project_id=${projectId} OR scope='global') AND status NOT IN ('archived','forgotten') AND EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=r.project_id AND p.deleted_at IS NULL) AND ${sourceScopeIsCurrent}`;
          if (!record)
            return yield* new WorkspaceMemoryError({
              message: "조회 가능한 기억을 찾을 수 없습니다.",
            });
          source = yield* decodeSource(record.source_json);
          if (
            (source.kind === "manual" || source.kind === "observation") &&
            folder !== undefined &&
            record.scope !== "global" &&
            (source.folder ?? "") !== folder
          )
            return yield* new WorkspaceMemoryError({
              message: "현재 폴더 범위를 확인할 수 없는 기억입니다.",
            });
          if (source.kind === "manual" || source.kind === "observation")
            return {
              id,
              text: record.text,
              ...(record.rationale ? { rationale: record.rationale } : {}),
              ...(record.proof_fact_ids && record.proof_fact_ids !== "[]"
                ? { proofFactIds: Option.getOrElse(decodeIdList(record.proof_fact_ids), () => []) }
                : {}),
              next: null,
              source: record.source_json,
              verification: record.verification,
            };
          source = { ...source, projectId: record.project_id };
        }
        const sourceProject = source.projectId ?? projectId;
        if (folder !== undefined && source.kind === "message") {
          const [allowed] = yield* sql`SELECT 1 AS allowed FROM projection_thread_messages m
            JOIN workspace_memory_v2_message_folders f ON f.message_id=(SELECT u.message_id FROM projection_thread_messages u
              WHERE u.thread_id=m.thread_id AND u.role='user' AND u.rowid<=m.rowid ORDER BY u.rowid DESC LIMIT 1)
            WHERE m.message_id=${source.id} AND f.project_id=${projectId} AND f.folder=${folder}`;
          if (!allowed)
            return yield* new WorkspaceMemoryError({
              message: "원문의 폴더 범위가 현재 폴더와 다르거나 확인되지 않습니다.",
            });
        }
        if (folder !== undefined && source.kind === "activity")
          return yield* new WorkspaceMemoryError({
            message: "활동 원문의 폴더 범위가 기록되지 않아 조회하지 않았습니다.",
          });
        if (folder !== undefined && source.kind === "knowledge") {
          const [note] = yield* sql<{
            scope: string;
          }>`SELECT scope FROM projection_workspace_knowledge_items
            WHERE item_id=${source.id} AND project_id=${sourceProject} AND status='active'`;
          if (note?.scope !== "environment" && !(folder === "" && note?.scope === "project"))
            return yield* new WorkspaceMemoryError({
              message: "이 원문의 폴더 범위가 확인되지 않아 조회하지 않았습니다.",
            });
        }
        const rows =
          source.kind === "message"
            ? yield* sql<{
                text: string;
                total: number;
              }>`SELECT substr(m.text,${offset + 1},12000) AS text,length(m.text) AS total FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id WHERE m.message_id=${source.id} AND t.project_id=${sourceProject} AND t.deleted_at IS NULL`
            : source.kind === "activity"
              ? yield* sql<{
                  text: string;
                  total: number;
                }>`SELECT substr(a.payload_json,${offset + 1},12000) AS text,length(a.payload_json) AS total FROM projection_thread_activities a JOIN projection_threads t ON t.thread_id=a.thread_id WHERE a.activity_id=${source.id} AND t.project_id=${sourceProject} AND t.deleted_at IS NULL`
              : yield* sql<{
                  text: string;
                  total: number;
                }>`SELECT substr(content,${offset + 1},12000) AS text,length(content) AS total FROM projection_workspace_knowledge_items WHERE item_id=${source.id} AND project_id=${sourceProject} AND status='active' AND (project_id=${projectId} OR scope='environment')`;
        const row = rows[0];
        if (!row)
          return yield* new WorkspaceMemoryError({
            message: "원문이 없거나 현재 프로젝트 범위 밖입니다.",
          });
        return { id, offset, ...row, next: offset + 12000 < row.total ? offset + 12000 : null };
      });
      const hasForgottenHandoffSource = (projectId: string, threadId: string) => sql`EXISTS (
        SELECT 1 FROM workspace_memory_v2 f
        WHERE f.project_id=${projectId} AND f.status='forgotten' AND CASE WHEN json_valid(f.source_json)
          THEN CASE json_extract(f.source_json,'$.kind')
            WHEN 'message' THEN EXISTS (SELECT 1 FROM projection_thread_messages m
              WHERE m.thread_id=${threadId} AND m.message_id=json_extract(f.source_json,'$.id'))
            WHEN 'activity' THEN EXISTS (SELECT 1 FROM projection_thread_activities a
              WHERE a.thread_id=${threadId} AND a.activity_id=json_extract(f.source_json,'$.id'))
          END END
      )`;
      const exportHistoryUnsafe = Effect.fn("WorkspaceMemory.export")(function* (
        projectId: string,
        threadId: string,
        handoffBoundary?: MessageId,
      ) {
        yield* checkedThread(projectId, threadId);
        const archive = yield* Effect.gen(function* () {
          const reader = yield* SqlClient.SqlClient;
          return yield* reader.withTransaction(
            Effect.gen(function* () {
              if (handoffBoundary !== undefined) {
                // An automatic archive includes raw activities and events. Verify its entire
                // scope against the same database snapshot that will be written to disk.
                const [allowed] = yield* reader`SELECT 1 FROM projection_thread_messages c
                  JOIN workspace_memory_v2_message_folders f ON f.message_id=c.message_id AND f.thread_id=c.thread_id AND f.project_id=${projectId}
                  WHERE c.thread_id=${threadId} AND c.message_id=${handoffBoundary}
                    AND NOT ${hasForgottenHandoffSource(projectId, threadId)}
                    -- The raw log retains discarded turns. A surviving message ID cannot
                    -- establish that its historical versions are still in scope after a revert.
                    AND NOT EXISTS (
                      SELECT 1 FROM orchestration_events e
                      WHERE e.aggregate_kind='thread' AND e.stream_id=c.thread_id AND (
                        e.event_type='thread.reverted' OR (
                          e.event_type IN ('thread.message-sent','thread.turn-start-requested')
                          AND NOT EXISTS (
                            SELECT 1 FROM projection_thread_messages m
                            WHERE m.thread_id=c.thread_id AND m.message_id=CASE WHEN json_valid(e.payload_json)
                              THEN json_extract(e.payload_json,'$.messageId') END
                          )
                        )
                      )
                    )
                    AND NOT EXISTS (SELECT 1 FROM projection_thread_messages m WHERE m.thread_id=c.thread_id
                      AND (m.rowid>c.rowid OR (m.role='user' AND NOT EXISTS (
                        SELECT 1 FROM workspace_memory_v2_message_folders origin WHERE origin.message_id=m.message_id
                          AND origin.thread_id=c.thread_id AND origin.project_id=f.project_id AND origin.folder=f.folder))))
                    AND NOT EXISTS (SELECT 1 FROM projection_thread_activities a WHERE a.thread_id=c.thread_id
                      AND (a.created_at>=c.created_at OR NOT EXISTS (
                        SELECT 1 FROM projection_turns t JOIN projection_thread_messages u ON u.message_id=t.pending_message_id
                        WHERE t.thread_id=a.thread_id AND t.turn_id=a.turn_id AND u.thread_id=t.thread_id AND u.role='user' AND u.rowid<c.rowid)))`;
                if (!allowed)
                  return yield* new WorkspaceMemoryError({
                    message: "전체 인계 스냅샷의 폴더 또는 대화 범위를 확인할 수 없습니다.",
                  });
              }
              const iterable = yield* readHistorySource(
                reader,
                threadId,
                {
                  record_type: "header",
                  version: 1,
                  projectId,
                  threadId,
                  exportedAt: now(),
                },
                process.versions.bun === undefined,
              );
              return yield* io((signal) =>
                writeHistoryArchive(
                  NodePath.join(directory(projectId), "sources", memoryHash(threadId)),
                  iterable,
                  signal,
                ),
              );
            }),
          );
        }).pipe(
          Effect.provide(makeRuntimeSqliteLayer({ filename: config.dbPath, readonly: true })),
        );
        yield* io((signal) => verifyHistoryArchive(archive.path, archive.sha256, signal));
        yield* sql`INSERT OR IGNORE INTO workspace_memory_source_archives(sha256,project_id,thread_id,path,records,original_bytes,compressed_bytes,created_at)
        VALUES (${archive.sha256},${projectId},${threadId},${archive.path},${archive.records},${archive.originalBytes},${archive.compressedBytes},${now()})`;
        return archive;
      });
      const exportHistory = (projectId: string, threadId: string, handoffBoundary?: MessageId) =>
        exportGate.withPermit(exportHistoryUnsafe(projectId, threadId, handoffBoundary));
      const invokeUnsafe = Effect.fn("WorkspaceMemory.invoke")(function* (
        input: WorkspaceMemoryAction,
        context?: {
          readonly threadId: ThreadId;
          readonly projectRoot?: true;
          readonly agentReported?: true;
        },
      ) {
        yield* checkedProject(input.projectId);
        let folder: string | undefined;
        if (context && input.action !== "status") {
          yield* checkedThread(input.projectId, context.threadId);
          if ((context.projectRoot || context.agentReported) && input.action !== "remember")
            return yield* new WorkspaceMemoryError({
              message: "프로젝트 루트 범위는 기억 저장에만 사용할 수 있습니다.",
            });
          if (input.action === "read" && input.id.startsWith("message:")) {
            const messageId = input.id.slice("message:".length);
            const [message] = yield* sql<{ allowed: number; thread_id: string }>`SELECT m.thread_id,
              CASE WHEN ${messageIsNotForgotten(input.projectId)} THEN 1 ELSE 0 END AS allowed
              FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id=m.thread_id
              WHERE m.message_id=${messageId} AND t.project_id=${input.projectId} AND t.deleted_at IS NULL`;
            if (!message)
              return yield* new WorkspaceMemoryError({
                message: "원문이 없거나 현재 프로젝트 범위 밖입니다.",
              });
            if (!message.allowed)
              return yield* new WorkspaceMemoryError({ message: "기억에서 제외한 발언입니다." });
            if (message.thread_id === context.threadId)
              return encodeJson(yield* read(input.projectId, input.id, input.offset));
          }
          if (context.projectRoot) {
            folder = "";
          } else {
            const [owner] = yield* sql<{
              orchestra_run_thread_id: string | null;
            }>`SELECT orchestra_run_thread_id FROM projection_threads
            WHERE thread_id=${context.threadId} AND project_id=${input.projectId} AND deleted_at IS NULL`;
            const folderThread = owner?.orchestra_run_thread_id ?? context.threadId;
            yield* checkedThread(input.projectId, folderThread);
            const [selected] = yield* sql<{
              folder: string;
            }>`SELECT f.folder FROM projection_thread_messages m
            LEFT JOIN workspace_memory_v2_message_folders f ON f.message_id=m.message_id AND f.project_id=${input.projectId}
            WHERE m.thread_id=${folderThread} AND m.role='user' ORDER BY m.rowid DESC LIMIT 1`;
            if (!selected || selected.folder === null)
              return yield* new WorkspaceMemoryError({
                message:
                  "현재 대화의 작업 폴더가 기록되지 않아 기억을 조회하지 않았습니다. 기존 기록은 보존됩니다.",
              });
            folder = selected.folder;
          }
        }
        let result: unknown;
        switch (input.action) {
          case "search": {
            const terms = buildSearchQuery(input.query)?.terms ?? [];
            const matches = (yield* search(
              input.projectId,
              input.query,
              input.limit,
              undefined,
              folder,
              input.speaker ?? "all",
              {
                layer: input.layer,
                fromDate: input.fromDate,
                toDate: input.toDate,
                includeSuperseded: input.includeSuperseded,
              },
            )).map((row) => {
              const proofFactIds =
                row.proof_fact_ids && row.proof_fact_ids !== "[]"
                  ? Option.getOrElse(decodeIdList(row.proof_fact_ids), () => [])
                  : [];
              return {
                id: row.id,
                topic: row.topic,
                layer: row.memory_layer ?? "fact",
                text: matchedMemoryExcerpt(row.text, terms, 2000),
                ...(row.rationale ? { rationale: row.rationale } : {}),
                ...(proofFactIds.length > 0 ? { proofFactIds } : {}),
                ...(row.superseded_by_id ? { supersededById: row.superseded_by_id } : {}),
                source: row.source_json,
                verification: row.verification,
                ...(input.speaker !== undefined
                  ? {
                      speaker:
                        row.origin === "user" || row.origin === "user-requested"
                          ? ("user" as const)
                          : ("ai" as const),
                    }
                  : {}),
                createdAt: row.created_at,
                ...(row.additionalSources
                  ? { supportingIds: row.supportingIds, additionalSources: row.additionalSources }
                  : {}),
              };
            });
            result =
              folder === undefined
                ? matches
                : {
                    matches,
                    note: "당시 폴더가 기록되지 않은 이전 대화는 제외했습니다. 원문은 보존됩니다.",
                  };
            break;
          }
          case "reflect": {
            const limit = Math.min(input.limit ?? 6, 12);
            const terms = buildSearchQuery(input.query)?.terms ?? [];
            const temporalWindow = parseKoreanTemporalRange(
              input.query,
              clock.currentTimeMillisUnsafe(),
            );
            const directiveRows = yield* sql<{
              item_id: string;
              title: string;
              content: string;
              scope: string;
              applies_to_folder: string | null;
            }>`SELECT item_id, title, substr(content, 1, 600) AS content, scope, applies_to_folder
              FROM projection_workspace_knowledge_items
              WHERE status='active' AND origin='user' AND kind='directive'
                AND (scope='environment' OR (project_id=${input.projectId} AND scope IN ('project','folder')))
              ORDER BY updated_at DESC LIMIT 12`;
            const matchingDirectives = directiveRows
              .filter(
                (d) =>
                  d.scope !== "folder" ||
                  (folder !== undefined &&
                    knowledgeAppliesToContext(
                      {
                        projectId: input.projectId,
                        scope: "folder",
                        appliesToFolder: d.applies_to_folder,
                      },
                      { projectId: input.projectId, contextPaths: folder ? [folder] : [] },
                    )),
              )
              .map((d) => ({
                itemId: d.item_id,
                scope: d.scope,
                title: d.title,
                excerpt: d.content,
              }));
            const observationRows = yield* search(
              input.projectId,
              input.query,
              limit,
              undefined,
              folder,
              "all",
              { layer: "observation" },
            );
            const factRows = yield* search(
              input.projectId,
              input.query,
              limit,
              undefined,
              folder,
              "all",
              { layer: "fact" },
            );
            result = {
              ladder: "directives -> observations -> raw_facts",
              ...(temporalWindow
                ? {
                    parsedTemporalWindow: {
                      expression: temporalWindow.matchedExpression,
                      startDate: temporalWindow.startIsoDate,
                      endDate: temporalWindow.endIsoDate,
                    },
                  }
                : {}),
              directives: matchingDirectives,
              observations: observationRows.map((row) => ({
                id: row.id,
                topic: row.topic,
                text: row.text,
                rationale: row.rationale ?? null,
                proofFactIds:
                  row.proof_fact_ids && row.proof_fact_ids !== "[]"
                    ? Option.getOrElse(decodeIdList(row.proof_fact_ids), () => [])
                    : [],
                createdAt: row.created_at,
              })),
              rawFacts: factRows.map((row) => ({
                id: row.id,
                topic: row.topic,
                excerpt: matchedMemoryExcerpt(row.text, terms, 1200),
                rationale: row.rationale ?? null,
                source: row.source_json,
                verification: row.verification,
                createdAt: row.created_at,
              })),
              guidance:
                "통합 관찰(observations)의 결정 이유(rationale)와 현재 제안이 충돌하면 당시 날짜와 사유를 먼저 짚어 제약 조건 변경 여부를 확인하세요. 세부 맥락이 더 필요하면 rawFacts 또는 proofFactIds를 action='read'로 원문 조회하세요.",
            };
            break;
          }
          case "read":
            result = yield* read(input.projectId, input.id, input.offset, folder);
            break;
          case "history":
            result = yield* history(
              input.projectId,
              input.threadId,
              input.after,
              input.query,
              folder,
              input.speaker ?? "all",
            );
            break;
          case "user_style": {
            const inFolder =
              folder === undefined
                ? sql`1=1`
                : sql`EXISTS (
                  SELECT 1 FROM workspace_memory_v2_message_folders f
                  WHERE f.project_id=${input.projectId} AND f.folder=${folder} AND f.message_id=m.message_id
                ) AND ${messageIsNotForgotten(input.projectId)}`;
            const rows = yield* sql<{
              message_id: string;
              thread_id: string;
              thread_title: string | null;
              text: string;
              created_at: string;
            }>`SELECT m.message_id, m.thread_id, t.title AS thread_title, substr(m.text, 1, 2000) AS text, m.created_at
              FROM projection_thread_messages m
              JOIN projection_threads t ON t.thread_id = m.thread_id
              WHERE t.project_id = ${input.projectId}
                AND t.deleted_at IS NULL
                AND m.role = 'user'
                AND m.is_streaming = 0
                AND length(trim(m.text)) > 0
                AND ${inFolder}
              ORDER BY m.rowid DESC
              LIMIT 120`;
            const chronological = [...rows].reverse().map((r) => ({
              id: r.message_id,
              threadId: r.thread_id,
              threadTitle: r.thread_title,
              text: r.text,
              createdAt: r.created_at,
            }));
            const profile = analyzeUserSpeechStyle(chronological);
            result = {
              scope: folder === undefined ? "project" : folder || "root",
              profile,
              markdown: formatUserSpeechProfileMarkdown(profile),
            };
            break;
          }
          case "export":
            if (folder !== undefined)
              return yield* new WorkspaceMemoryError({
                message:
                  "전체 대화에는 다른 폴더 또는 범위 미확인 기록이 섞일 수 있어 현재 폴더에서 일괄 내보내지 않았습니다.",
              });
            result = yield* exportHistory(input.projectId, input.threadId);
            break;
          case "backfill":
            result = yield* gate.withPermit(backfill(input.projectId));
            break;
          case "dream":
            result = yield* gate.withPermit(dream(input.projectId));
            break;
          case "remember": {
            if (!input.text.trim() || !input.topic.trim())
              return yield* new WorkspaceMemoryError({ message: "기억 본문과 주제를 입력하세요." });
            const id = memoryHash(`manual:${input.projectId}:${input.requestId}`);
            result = yield* gate.withPermit(
              Effect.gen(function* () {
                const [existing] =
                  yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 WHERE id=${id}`;
                const existingSource = existing
                  ? yield* decodeSource(existing.source_json)
                  : undefined;
                const scopedFolder = input.scope === "global" ? undefined : folder;
                const sanitizedText = Array.from(redactMemorySensitiveData(input.text).content)
                  .slice(0, MAX_NOTE_CHARS)
                  .join("");
                if (
                  existing &&
                  (existing.status === "forgotten" ||
                    existing.text !== sanitizedText ||
                    existing.topic !== input.topic ||
                    existing.scope !== (input.scope ?? "project") ||
                    existing.origin !== (context?.agentReported ? "assistant" : "user-requested") ||
                    existingSource?.folder !== scopedFolder)
                )
                  return yield* new WorkspaceMemoryError({
                    message:
                      "같은 requestId에는 같은 기억만 재요청할 수 있습니다. 수정은 새 requestId로 저장하세요.",
                  });
                yield* capture({
                  projectId: input.projectId,
                  id,
                  topic: input.topic,
                  text: input.text,
                  source: {
                    kind: "manual",
                    id: input.requestId,
                    projectId: input.projectId,
                    ...(scopedFolder === undefined ? {} : { folder: scopedFolder }),
                  },
                  origin: context?.agentReported ? "assistant" : "user-requested",
                  verification: context?.agentReported
                    ? "unverified-report"
                    : "user-requested-note",
                  createdAt: existing?.created_at ?? now(),
                  scope: input.scope,
                  durable: scopedFolder === undefined,
                });
                yield* dream(input.projectId);
                return { id, saved: true };
              }),
            );
            break;
          }
          case "forget":
          case "forget-message":
            if (folder !== undefined) yield* read(input.projectId, input.id, 0, folder);
            result = yield* gate.withPermit(
              Effect.gen(function* () {
                const [record] =
                  yield* sql<RecordRow>`SELECT * FROM workspace_memory_v2 WHERE id=${input.id} AND project_id=${input.projectId}`;
                if (!record)
                  return yield* new WorkspaceMemoryError({
                    message: "현재 프로젝트가 소유한 기억만 제외할 수 있습니다.",
                  });
                if (input.action === "forget-message") {
                  const source = yield* decodeSource(record.source_json);
                  if (source.kind !== "message")
                    return yield* new WorkspaceMemoryError({
                      message: "대화에서 생성된 검색 기록만 이 방법으로 삭제할 수 있습니다.",
                    });
                }
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* dirty(record.project_id, record.scope, record.topic);
                    if (input.action === "forget-message")
                      yield* sql`UPDATE workspace_memory_v2 SET status='forgotten',text='',updated_at=${now()} WHERE id=${input.id}`;
                    else
                      yield* sql`UPDATE workspace_memory_v2 SET status='forgotten',updated_at=${now()} WHERE id=${input.id}`;
                    derivedRowCache.delete(input.id);
                    yield* sql`DELETE FROM workspace_memory_v2_fts WHERE rowid=(SELECT rowid FROM workspace_memory_v2 WHERE id=${input.id})`;
                    yield* clearChunks(input.id);
                    yield* sql`DELETE FROM workspace_memory_v2_chunk_state WHERE memory_id=${input.id}`;
                  }),
                );
                if (input.action === "forget")
                  yield* io(() =>
                    archiveMemoryFile(inbox(record.project_id, record.scope, record.id)),
                  );
                yield* dream(input.projectId);
                return { id: input.id, forgotten: true, sourceHistoryPreserved: true };
              }),
            );
            break;
          case "status":
            result = {
              version: 2,
              directory: directory(input.projectId),
              manifestBytes: MANIFEST_BYTES,
              counts:
                yield* sql`SELECT status,verification,count(*) AS total FROM workspace_memory_v2 WHERE project_id=${input.projectId} GROUP BY status,verification`,
              progress:
                yield* sql`SELECT * FROM workspace_memory_v2_progress WHERE stream_key=${`messages:${input.projectId}`}`,
              semanticIndexing:
                yield* sql`SELECT count(*) AS pendingJobs,coalesce(sum(failures>0),0) AS retryingJobs
                  FROM workspace_semantic_index_jobs WHERE project_id=${input.projectId}`,
            };
            break;
        }
        return encodeJson(result);
      });
      const handoff = Effect.fn("WorkspaceMemory.handoff")(function* (
        projectId: ProjectId,
        threadId: ThreadId,
        messageId: MessageId,
        archive: boolean,
        folderScopeAvailable = true,
        onArchiveAttached?: () => void,
      ) {
        yield* checkedThread(projectId, threadId);
        const [boundary] = yield* sql<{
          rowid: number;
        }>`SELECT rowid FROM projection_thread_messages WHERE thread_id=${threadId} AND message_id=${messageId}`;
        if (!boundary)
          return "<t3_memory_unavailable>현재 요청의 대화 위치를 확인하지 못해 이전 대화 인계를 생략했습니다. 원본 대화는 보존됩니다.</t3_memory_unavailable>";
        const readRecent = (userOnly: boolean) => sql<{
          rowid: number;
          message_id: string;
          role: string;
          text: string;
          tail: string | null;
          truncated: number;
        }>`SELECT m.rowid,m.message_id,m.role,
          substr(m.text,1,CASE WHEN m.role='user' AND length(m.text)>2000 THEN 1000 ELSE 2000 END) AS text,
          CASE WHEN m.role='user' AND length(m.text)>2000 THEN substr(m.text,-1000) END AS tail,
          length(m.text)>2000 AS truncated FROM projection_thread_messages m
        WHERE m.thread_id=${threadId} AND m.rowid<${boundary.rowid} AND m.is_streaming=0 AND length(trim(m.text))>0 AND ${messageIsNotForgotten(projectId)}
          ${userOnly ? sql`AND m.role='user'` : sql``}
        ORDER BY m.rowid DESC LIMIT ${userOnly ? 1 : 30}`;
        const { recent, latestUser, forgotten, workingState } = yield* sql.withTransaction(
          Effect.gen(function* () {
            const recent = yield* readRecent(false);
            const latestUser =
              recent.find((row) => row.role === "user") ?? (yield* readRecent(true))[0];
            // Tool results and the full archive can echo any earlier message.
            // Check exclusions in the same snapshot used to read the excerpts.
            const [forgotten] =
              yield* sql`SELECT 1 WHERE ${hasForgottenHandoffSource(projectId, threadId)}`;
            const workingState =
              forgotten || !folderScopeAvailable
                ? ""
                : yield* readHandoffWorkingState(sql, projectId, threadId, messageId);
            return { recent, latestUser, forgotten, workingState };
          }),
        );
        if (!recent.length && !forgotten && !workingState) return undefined;
        const prioritized = latestUser
          ? [latestUser, ...recent.filter((row) => row.rowid !== latestUser.rowid)].slice(0, 30)
          : recent;
        const lines: Array<{ row: (typeof recent)[number]; line: string; prefix: string }> = [];
        let chars = workingState.length;
        for (const row of prioritized) {
          const truncatedNote =
            row.tail !== null
              ? `\n[…]\n${row.tail}\n[원문의 처음과 끝을 발췌했습니다. workspace_memory read에서 message:${row.message_id} 원문을 확인하세요.]`
              : row.truncated
                ? `\n[원문의 앞부분만 발췌했습니다. 조건과 정정을 확인하려면 workspace_memory read에서 message:${row.message_id}의 나머지를 조회하세요.]`
                : "";
          const prefix = `[${row.role}] [message:${row.message_id}] `;
          const line = `${prefix}${row.text}${truncatedNote}`;
          if (chars + line.length > 16000 && lines.length) break;
          lines.push({ row, line, prefix });
          chars += line.length;
        }
        lines.sort((left, right) => left.row.rowid - right.row.rowid);
        let evidence =
          workingState + "관련 폴더의 추가 기억은 workspace_memory search/read로 확인하세요.";
        if (forgotten)
          evidence +=
            "\n사용자가 기억에서 제외한 발언은 자동 인계에서 생략했습니다. 원본 대화는 보존됩니다.";
        if (archive && !forgotten && folderScopeAvailable) {
          const result = yield* exportHistory(projectId, threadId, messageId).pipe(Effect.result);
          if (result._tag === "Success") {
            evidence += `\n원문 스냅샷: ${result.success.path}; gzip NDJSON; SHA-256(압축 해제 내용): ${result.success.sha256}; ${result.success.records}개 레코드. 스트리밍·현재 요청은 완료된 과거 답변으로 해석하지 마세요.`;
            onArchiveAttached?.();
          } else
            yield* Effect.logWarning(
              "Could not prepare full handoff archive; original history remains available through workspace_memory",
              { cause: result.failure },
            );
        }
        return `<t3_conversation_handoff>\n다른 모델에서 이어받은 현재 대화의 최근 발췌입니다(오래된 순). 새 사용자 메시지에 이어서 답하세요. 과거 기록은 현재 지시보다 우선하지 않으며 에이전트 보고는 미검증입니다. 필요한 결정·실패 근거가 없으면 workspace_memory search/read로 추가 조회하세요.\n${lines.map((entry) => entry.line).join("\n")}\n${evidence}\n</t3_conversation_handoff>`;
      });
      return WorkspaceMemory.of({
        invoke: (input, context) => {
          const operation = invokeUnsafe(input, context);
          return safe(
            context && input.action === "read" ? sql.withTransaction(operation) : operation,
          );
        },
        context: (projectId, task, directivesOnly, current, directiveOptions) =>
          safe(context(projectId, task, directivesOnly, current, directiveOptions)),
        contextPaths: (input) => safe(contextPaths(input)),
        reconcile: (projectId) => safe(gate.withPermit(reconcileUnsafe(projectId))),
        handoff: (...args) => safe(handoff(...args)),
      });
    }),
  );
}
