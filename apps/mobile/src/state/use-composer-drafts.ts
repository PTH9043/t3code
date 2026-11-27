import { useAtomValue } from "@effect/atom-react";
import {
  ModelSelection as ModelSelectionSchema,
  CommandId,
  MessageId,
  ThreadId,
  ThreadResponseStyle,
  ThreadTeamMember,
  type ThreadSettingsImportResult,
  IsoDateTime,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  RuntimeMode as RuntimeModeSchema,
  WorkspaceCollaborationRunId,
  WorkspaceMeetingQuestionRef,
  WorkflowStart,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { Atom } from "effect/unstable/reactivity";

import { DraftComposerImageAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import type { TurnCommandMetadata } from "../lib/commandMetadata";
import { NewTaskModelTeam } from "../lib/newTaskModelTeam";
import { SerializedAsyncQueue } from "../lib/serialized-async-queue";
import { appAtomRegistry } from "./atom-registry";
import { MobileOrchestraConfigSchema, type MobileOrchestraConfig } from "./thread-orchestra-config";

const COMPOSER_DRAFTS_SCHEMA_VERSION = 1;
const COMPOSER_DRAFTS_DIRECTORY = "composer-drafts";
const COMPOSER_DRAFTS_FILE = "drafts.json";
const COMPOSER_DRAFTS_ALTERNATE_FILE = "drafts-alternate.json";
const PERSIST_DEBOUNCE_MS = 200;

export class ComposerDraftPersistenceError extends Schema.TaggedErrorClass<ComposerDraftPersistenceError>()(
  "ComposerDraftPersistenceError",
  {
    operation: Schema.Literals(["open", "read", "decode", "encode", "write", "hydrate"]),
    directory: Schema.String,
    fileName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Composer draft persistence operation ${this.operation} failed for ${this.directory}/${this.fileName}.`;
  }
}

export interface ComposerDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly importedShareIds?: ReadonlyArray<string>;
  readonly modelSelection?: ModelSelection;
  readonly requireExactModel?: boolean;
  readonly modelBeforeImport?: ModelSelection | null;
  readonly responseStyle?: ThreadResponseStyle;
  readonly customSubordinateTeam?: readonly ThreadTeamMember[];
  readonly modelTeams?: readonly NewTaskModelTeam[];
  readonly firstTurnMetadata?: TurnCommandMetadata;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly workspaceSelection?: ComposerDraftWorkspaceSelection;
  readonly orchestraAttempt?: ComposerOrchestraAttempt;
  readonly orchestraConfig?: MobileOrchestraConfig;
  readonly orchestraStartAttempt?: ComposerOrchestraStartAttempt;
}

const ComposerOrchestraStartAttemptSchema = Schema.Struct({
  threadKey: Schema.String,
  originalText: Schema.String,
  config: MobileOrchestraConfigSchema,
  input: WorkflowStart,
});
export type ComposerOrchestraStartAttempt = typeof ComposerOrchestraStartAttemptSchema.Type;

const ComposerOrchestraAttemptSchema = Schema.Struct({
  threadKey: Schema.String,
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  commandId: CommandId,
  createdAt: Schema.String,
  originalText: Schema.String,
  originalAttachments: Schema.Array(DraftComposerImageAttachmentSchema),
  prepared: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("stop") }),
    Schema.Struct({ kind: Schema.Literal("interject"), text: Schema.String }),
    Schema.Struct({
      kind: Schema.Literal("answer"),
      text: Schema.String,
      question: Schema.String,
      questionRef: WorkspaceMeetingQuestionRef,
    }),
  ]),
});
export type ComposerOrchestraAttempt = typeof ComposerOrchestraAttemptSchema.Type;

export interface ComposerDraftContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly sourceShareId?: string;
}

export interface ComposerDraftWorkspaceSelection {
  readonly mode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export type ComposerDraftSettingsUpdate = Pick<
  ComposerDraft,
  | "modelSelection"
  | "customSubordinateTeam"
  | "modelTeams"
  | "responseStyle"
  | "requireExactModel"
  | "runtimeMode"
  | "interactionMode"
  | "workspaceSelection"
>;

const ComposerDraftWorkspaceSelectionSchema = Schema.Struct({
  mode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ComposerDraftSchema = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  importedShareIds: Schema.optional(Schema.Array(Schema.String)),
  modelSelection: Schema.optional(ModelSelectionSchema),
  requireExactModel: Schema.optional(Schema.Boolean),
  modelBeforeImport: Schema.optional(Schema.NullOr(ModelSelectionSchema)),
  responseStyle: Schema.optional(ThreadResponseStyle),
  customSubordinateTeam: Schema.optional(Schema.Array(ThreadTeamMember)),
  modelTeams: Schema.optional(Schema.Array(NewTaskModelTeam)),
  firstTurnMetadata: Schema.optional(
    Schema.Struct({
      threadId: ThreadId,
      commandId: CommandId,
      messageId: MessageId,
      createdAt: IsoDateTime,
    }),
  ),
  runtimeMode: Schema.optional(RuntimeModeSchema),
  interactionMode: Schema.optional(ProviderInteractionModeSchema),
  workspaceSelection: Schema.optional(ComposerDraftWorkspaceSelectionSchema),
  orchestraAttempt: Schema.optional(ComposerOrchestraAttemptSchema),
  orchestraConfig: Schema.optional(MobileOrchestraConfigSchema),
  orchestraStartAttempt: Schema.optional(ComposerOrchestraStartAttemptSchema),
});

const PersistedComposerDraftsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSER_DRAFTS_SCHEMA_VERSION),
  generation: Schema.optional(Schema.Number),
  drafts: Schema.Record(Schema.String, ComposerDraftSchema),
});

const decodePersistedComposerDraftsDocument = Schema.decodeUnknownSync(
  PersistedComposerDraftsSchema,
);

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
};

export const composerDraftsAtom = Atom.make<Record<string, ComposerDraft>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:composer-drafts"),
);

let loadPromise: Promise<void> | null = null;
let loadFailure: ComposerDraftPersistenceError | null = null;
let lastPersistedSlot: string | null = null;
let lastPersistedGeneration = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const persistenceQueue = new SerializedAsyncQueue();

function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft {
  if (!draft) {
    return EMPTY_DRAFT;
  }
  return {
    ...draft,
    text: draft.text,
    attachments: draft.attachments,
  };
}

export function getComposerDraftSnapshot(draftKey: string): ComposerDraft {
  return normalizeDraft(appAtomRegistry.get(composerDraftsAtom)[draftKey]);
}

export function orchestraAttemptMatchesContent(
  draft: Pick<ComposerDraft, "text" | "attachments">,
  attempt: ComposerOrchestraAttempt,
): boolean {
  return (
    draft.text === attempt.originalText &&
    draft.attachments.length === attempt.originalAttachments.length &&
    draft.attachments.every((image, index) => {
      const original = attempt.originalAttachments[index];
      return (
        original !== undefined &&
        image.id === original.id &&
        image.name === original.name &&
        image.mimeType === original.mimeType &&
        image.sizeBytes === original.sizeBytes &&
        image.dataUrl === original.dataUrl
      );
    })
  );
}

export function sameComposerOrchestraAttempt(
  left: ComposerOrchestraAttempt,
  right: ComposerOrchestraAttempt,
): boolean {
  const a = left.prepared;
  const b = right.prepared;
  const samePrepared =
    a.kind === "stop"
      ? b.kind === "stop"
      : a.kind === "interject"
        ? b.kind === "interject" && a.text === b.text
        : b.kind === "answer" &&
          a.text === b.text &&
          a.question === b.question &&
          a.questionRef.nodeId === b.questionRef.nodeId &&
          a.questionRef.askedAt === b.questionRef.askedAt;
  return (
    left.threadKey === right.threadKey &&
    left.projectId === right.projectId &&
    left.runId === right.runId &&
    left.commandId === right.commandId &&
    left.createdAt === right.createdAt &&
    samePrepared &&
    orchestraAttemptMatchesContent(
      { text: right.originalText, attachments: right.originalAttachments },
      left,
    )
  );
}

export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return isEmptyDraft(draft);
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.attachments.length === 0 &&
    draft.modelSelection === undefined &&
    draft.customSubordinateTeam === undefined &&
    !draft.modelTeams?.length &&
    draft.responseStyle === undefined &&
    draft.firstTurnMetadata === undefined &&
    draft.runtimeMode === undefined &&
    draft.interactionMode === undefined &&
    draft.workspaceSelection === undefined &&
    draft.orchestraAttempt === undefined &&
    draft.orchestraConfig === undefined &&
    draft.orchestraStartAttempt === undefined
  );
}

export function decodePersistedComposerDrafts(value: unknown): Record<string, ComposerDraft> {
  const parsed = decodePersistedComposerDraftsDocument(value);
  return Object.fromEntries(
    Object.entries(parsed.drafts).filter(([, draft]) => !isEmptyDraft(draft)),
  );
}

export function mergeLoadedComposerDrafts(
  persistedDrafts: Record<string, ComposerDraft>,
  current: Record<string, ComposerDraft>,
): Record<string, ComposerDraft> {
  const combined = { ...persistedDrafts, ...current };
  for (const [key, persisted] of Object.entries(persistedDrafts)) {
    const local = current[key];
    if (local && persisted.modelTeams && local.modelTeams === undefined)
      combined[key] = { ...local, modelTeams: persisted.modelTeams };
    if (
      local &&
      persisted.customSubordinateTeam !== undefined &&
      local.customSubordinateTeam === undefined
    )
      combined[key] = { ...combined[key]!, customSubordinateTeam: persisted.customSubordinateTeam };
    if (local && !local.responseStyle && persisted.responseStyle)
      combined[key] = { ...combined[key]!, responseStyle: persisted.responseStyle };
    if (local && !local.modelSelection && persisted.modelSelection)
      combined[key] = {
        ...combined[key]!,
        modelSelection: persisted.modelSelection,
        requireExactModel: persisted.requireExactModel,
        modelBeforeImport: persisted.modelBeforeImport,
      };
    if (local && persisted.firstTurnMetadata && !local.firstTurnMetadata)
      combined[key] = { ...combined[key]!, firstTurnMetadata: persisted.firstTurnMetadata };
    if (local && persisted.orchestraAttempt && !local.orchestraAttempt)
      combined[key] = { ...combined[key]!, orchestraAttempt: persisted.orchestraAttempt };
    if (local && persisted.orchestraStartAttempt && !local.orchestraStartAttempt)
      combined[key] = { ...combined[key]!, orchestraStartAttempt: persisted.orchestraStartAttempt };
    if (local && persisted.orchestraConfig && !local.orchestraConfig)
      combined[key] = { ...combined[key]!, orchestraConfig: persisted.orchestraConfig };
  }
  return combined;
}

async function getComposerDraftsFile(fileName: string) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_DRAFTS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, fileName);
}

async function loadPersistedComposerDrafts(): Promise<Record<string, ComposerDraft>> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  let fileName = COMPOSER_DRAFTS_FILE;
  try {
    const candidates: Array<{
      fileName: string;
      generation: number;
      drafts: Record<string, ComposerDraft>;
    }> = [];
    let invalid: { fileName: string; cause: unknown } | null = null;
    for (fileName of [COMPOSER_DRAFTS_FILE, COMPOSER_DRAFTS_ALTERNATE_FILE]) {
      operation = "open";
      const file = await getComposerDraftsFile(fileName);
      if (!file.exists) continue;
      operation = "read";
      const raw = await file.text();
      operation = "decode";
      try {
        const value: unknown = JSON.parse(raw);
        const parsed = decodePersistedComposerDraftsDocument(value);
        const generation = parsed.generation ?? 0;
        if (!Number.isSafeInteger(generation) || generation < 0)
          throw new Error("Invalid draft generation");
        candidates.push({ fileName, generation, drafts: decodePersistedComposerDrafts(value) });
      } catch (cause) {
        invalid = { fileName, cause };
      }
    }
    candidates.sort((a, b) => b.generation - a.generation);
    const selected = candidates[0];
    if (!selected) {
      if (invalid !== null) {
        fileName = invalid.fileName;
        throw invalid.cause;
      }
      return {};
    }
    lastPersistedSlot = selected.fileName;
    lastPersistedGeneration = selected.generation;
    if (invalid !== null) console.warn("[composer-drafts] recovered a valid previous slot");
    return selected.drafts;
  } catch (cause) {
    loadFailure = new ComposerDraftPersistenceError({
      operation,
      directory: COMPOSER_DRAFTS_DIRECTORY,
      fileName,
      cause,
    });
    console.warn("[composer-drafts] ignored persisted draft failure", loadFailure);
    return {};
  }
}

async function writePersistedComposerDrafts(drafts: Record<string, ComposerDraft>): Promise<void> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  const fileName =
    lastPersistedSlot === COMPOSER_DRAFTS_FILE
      ? COMPOSER_DRAFTS_ALTERNATE_FILE
      : COMPOSER_DRAFTS_FILE;
  try {
    const file = await getComposerDraftsFile(fileName);
    operation = "encode";
    const nonEmptyDrafts = Object.fromEntries(
      Object.entries(drafts).filter(([, draft]) => !isEmptyDraft(draft)),
    );
    const document = {
      schemaVersion: COMPOSER_DRAFTS_SCHEMA_VERSION,
      generation: lastPersistedGeneration + 1,
      drafts: nonEmptyDrafts,
    } as const;
    const encoded = JSON.stringify(document);
    operation = "write";
    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(encoded);
    operation = "read";
    if ((await file.text()) !== encoded) throw new Error("Draft write verification failed");
    lastPersistedSlot = fileName;
    lastPersistedGeneration = document.generation;
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation,
      directory: COMPOSER_DRAFTS_DIRECTORY,
      fileName,
      cause,
    });
  }
}

async function savePersistedComposerDrafts(): Promise<void> {
  try {
    if (!(await awaitComposerDraftsLoaded())) throw loadFailure;
    await persistenceQueue.run(() =>
      writePersistedComposerDrafts(appAtomRegistry.get(composerDraftsAtom)),
    );
  } catch (error) {
    console.warn("[composer-drafts] failed to persist drafts", error);
    // Draft persistence is best-effort; in-memory drafts still keep working.
  }
}

function schedulePersistComposerDrafts(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void savePersistedComposerDrafts();
  }, PERSIST_DEBOUNCE_MS);
}

export function ensureComposerDraftsLoaded(): void {
  if (loadPromise !== null) {
    return;
  }
  loadPromise = loadPersistedComposerDrafts()
    .then((persistedDrafts) => {
      if (Object.keys(persistedDrafts).length === 0) {
        return;
      }
      const current = appAtomRegistry.get(composerDraftsAtom);
      appAtomRegistry.set(composerDraftsAtom, mergeLoadedComposerDrafts(persistedDrafts, current));
    })
    .catch((cause) => {
      loadFailure = new ComposerDraftPersistenceError({
        operation: "hydrate",
        directory: COMPOSER_DRAFTS_DIRECTORY,
        fileName: COMPOSER_DRAFTS_FILE,
        cause,
      });
      console.warn("[composer-drafts] failed to hydrate drafts", loadFailure);
      // Draft loading is best-effort; in-memory drafts still keep working.
    });
}

export async function awaitComposerDraftsLoaded(): Promise<boolean> {
  ensureComposerDraftsLoaded();
  await loadPromise;
  return loadFailure === null;
}

/** Persist the exact request before starting an orchestra command. */
export async function persistComposerOrchestraAttempt(
  threadKey: string,
  attempt: ComposerOrchestraAttempt,
): Promise<boolean> {
  if (!(await awaitComposerDraftsLoaded())) throw loadFailure;
  const current = appAtomRegistry.get(composerDraftsAtom);
  const draft = normalizeDraft(current[threadKey]);
  if (
    attempt.threadKey !== threadKey ||
    (draft.orchestraAttempt && !sameComposerOrchestraAttempt(draft.orchestraAttempt, attempt)) ||
    (!draft.orchestraAttempt && !orchestraAttemptMatchesContent(draft, attempt))
  )
    return false;
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const next = { ...current, [threadKey]: { ...draft, orchestraAttempt: attempt } };
  appAtomRegistry.set(composerDraftsAtom, next);
  await persistenceQueue.run(() => writePersistedComposerDrafts(next));
  return true;
}

export function clearComposerOrchestraAttempt(threadKey: string, commandId: CommandId): void {
  updateComposerDrafts((current) => {
    const draft = current[threadKey];
    if (!draft || draft.orchestraAttempt?.commandId !== commandId) return current;
    const { orchestraAttempt: _attempt, ...retained } = draft;
    const next = { ...current };
    if (isEmptyDraft(retained)) delete next[threadKey];
    else next[threadKey] = retained;
    return next;
  });
}

export function setComposerOrchestraConfig(threadKey: string, config: MobileOrchestraConfig): void {
  updateComposerDrafts((current) => ({
    ...current,
    [threadKey]: { ...normalizeDraft(current[threadKey]), orchestraConfig: config },
  }));
}

/** The same saved request ID and payload are reused after an uncertain start. */
export async function persistComposerOrchestraStartAttempt(
  threadKey: string,
  attempt: ComposerOrchestraStartAttempt,
): Promise<boolean> {
  if (!(await awaitComposerDraftsLoaded())) throw loadFailure;
  const current = appAtomRegistry.get(composerDraftsAtom);
  const draft = normalizeDraft(current[threadKey]);
  if (
    attempt.threadKey !== threadKey ||
    draft.orchestraAttempt ||
    (draft.orchestraStartAttempt
      ? JSON.stringify(draft.orchestraStartAttempt) !== JSON.stringify(attempt)
      : draft.text !== attempt.originalText ||
        draft.attachments.length > 0 ||
        JSON.stringify(draft.orchestraConfig) !== JSON.stringify(attempt.config))
  )
    return false;
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const next = { ...current, [threadKey]: { ...draft, orchestraStartAttempt: attempt } };
  appAtomRegistry.set(composerDraftsAtom, next);
  await persistenceQueue.run(() => writePersistedComposerDrafts(next));
  return true;
}

export function finishComposerOrchestraStartAttempt(threadKey: string, requestId: string): void {
  updateComposerDrafts((current) => {
    const draft = current[threadKey];
    const attempt = draft?.orchestraStartAttempt;
    if (!draft || !attempt || attempt.input.requestId !== requestId) return current;
    const { orchestraStartAttempt: _attempt, ...rest } = draft;
    return {
      ...current,
      [threadKey]: {
        ...rest,
        text: draft.text === attempt.originalText ? "" : draft.text,
        ...(draft.orchestraConfig?.activationId === attempt.config.activationId &&
        draft.orchestraConfig
          ? { orchestraConfig: { ...draft.orchestraConfig, enabled: false } }
          : {}),
      },
    };
  });
}

export function clearComposerOrchestraStartAttempt(threadKey: string, requestId: string): void {
  updateComposerDrafts((current) => {
    const draft = current[threadKey];
    if (!draft || draft.orchestraStartAttempt?.input.requestId !== requestId) return current;
    const { orchestraStartAttempt: _attempt, ...rest } = draft;
    return { ...current, [threadKey]: rest };
  });
}

function updateComposerDrafts(
  update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
): void {
  const next = update(appAtomRegistry.get(composerDraftsAtom));
  appAtomRegistry.set(composerDraftsAtom, next);
  schedulePersistComposerDrafts();
}

export function setComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      text: value,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function appendComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        text: `${existing.text}${value}`,
      },
    };
  });
}

export function appendComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  if (attachments.length === 0) {
    return;
  }
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        attachments: [...existing.attachments, ...attachments],
      },
    };
  });
}

export function replaceComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      attachments,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function removeComposerDraftAttachment(draftKey: string, imageId: string): void {
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const draft = {
      ...existing,
      attachments: existing.attachments.filter((image) => image.id !== imageId),
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function updateComposerDraftSettings(
  draftKey: string,
  settings: Partial<ComposerDraftSettingsUpdate>,
): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      ...(settings.modelSelection ? { requireExactModel: false, modelBeforeImport: null } : {}),
      ...settings,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export async function saveImportedDraftSettings(
  draftKey: string,
  plan: Extract<ThreadSettingsImportResult, { ok: true }>,
): Promise<void> {
  if (!(await awaitComposerDraftsLoaded())) throw loadFailure;
  const apply = (draft: ComposerDraft): ComposerDraft => {
    const team = plan.teamUpdate;
    return {
      ...draft,
      ...(plan.responseStyle ? { responseStyle: plan.responseStyle } : {}),
      ...(plan.modelSelection
        ? {
            modelSelection: plan.modelSelection,
            requireExactModel: true,
            modelBeforeImport: draft.requireExactModel
              ? (draft.modelBeforeImport ?? null)
              : (draft.modelSelection ?? null),
          }
        : {}),
      ...(team ? { customSubordinateTeam: team.members ?? undefined } : {}),
    };
  };
  await persistenceQueue.run(async () => {
    const current = appAtomRegistry.get(composerDraftsAtom);
    const next = restoreComposerDraftSnapshotState(
      current,
      draftKey,
      apply(normalizeDraft(current[draftKey])),
    );
    await writePersistedComposerDrafts(next);
    const latest = appAtomRegistry.get(composerDraftsAtom);
    if (latest !== current && current[draftKey] && !latest[draftKey]) return;
    appAtomRegistry.set(
      composerDraftsAtom,
      latest === current
        ? next
        : restoreComposerDraftSnapshotState(
            latest,
            draftKey,
            apply(normalizeDraft(latest[draftKey])),
          ),
    );
  });
}

export async function saveDraftSubordinateTeam(
  draftKey: string,
  members: readonly ThreadTeamMember[] | null,
): Promise<void> {
  if (!(await awaitComposerDraftsLoaded())) throw loadFailure;
  await persistenceQueue.run(async () => {
    const current = appAtomRegistry.get(composerDraftsAtom);
    const draft = normalizeDraft(current[draftKey]);
    const customSubordinateTeam = members ?? undefined;
    const next = restoreComposerDraftSnapshotState(current, draftKey, {
      ...draft,
      customSubordinateTeam,
    });
    await writePersistedComposerDrafts(next);
    const latest = appAtomRegistry.get(composerDraftsAtom);
    // Typing may continue while the file is being written. A concurrent discard wins.
    if (latest !== current && current[draftKey] && !latest[draftKey]) return;
    appAtomRegistry.set(
      composerDraftsAtom,
      latest === current
        ? next
        : restoreComposerDraftSnapshotState(latest, draftKey, {
            ...normalizeDraft(latest[draftKey]),
            customSubordinateTeam,
          }),
    );
  });
}

/** Commit the identifiers locally before a first send can reach the server. */
export async function reserveNewTaskTurnMetadata(
  draftKey: string,
  create: () => TurnCommandMetadata,
): Promise<TurnCommandMetadata> {
  if (!(await awaitComposerDraftsLoaded())) throw loadFailure;
  const current = appAtomRegistry.get(composerDraftsAtom);
  const draft = normalizeDraft(current[draftKey]);
  const metadata = draft.firstTurnMetadata ?? create();
  if (!draft.firstTurnMetadata) {
    appAtomRegistry.set(composerDraftsAtom, {
      ...current,
      [draftKey]: { ...draft, firstTurnMetadata: metadata },
    });
  }
  await persistenceQueue.run(() =>
    writePersistedComposerDrafts(appAtomRegistry.get(composerDraftsAtom)),
  );
  return metadata;
}

export function clearComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  options?: { readonly clearWorkspaceSelection?: boolean },
): Record<string, ComposerDraft> {
  const existing = current[draftKey];
  if (!existing) {
    return current;
  }
  const {
    importedShareIds: _importedShareIds,
    requireExactModel,
    modelBeforeImport,
    modelSelection,
    customSubordinateTeam: _customSubordinateTeam,
    modelTeams: _modelTeams,
    responseStyle: _responseStyle,
    firstTurnMetadata: _firstTurnMetadata,
    workspaceSelection,
    ...retained
  } = existing;
  const nextModel = requireExactModel ? modelBeforeImport : modelSelection;
  const draft = {
    ...retained,
    ...(nextModel ? { modelSelection: nextModel } : {}),
    ...(options?.clearWorkspaceSelection || workspaceSelection === undefined
      ? {}
      : { workspaceSelection }),
    text: "",
    attachments: [],
  };
  if (isEmptyDraft(draft)) {
    const next = { ...current };
    delete next[draftKey];
    return next;
  }
  return {
    ...current,
    [draftKey]: draft,
  };
}

export function restoreComposerDraftSnapshotState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  snapshot: ComposerDraft,
): Record<string, ComposerDraft> {
  const next = { ...current };
  if (isEmptyDraft(snapshot)) {
    delete next[draftKey];
  } else {
    next[draftKey] = snapshot;
  }
  return next;
}

function mergeComposerDraftText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  // Import retries are possible after an interrupted native handoff. Keep the
  // operation idempotent when the same shared text is already present.
  if (existing === incoming || existing.endsWith(`\n\n${incoming}`)) {
    return existing;
  }
  return `${existing}\n\n${incoming}`;
}

export function mergeComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  content: ComposerDraftContent,
): Record<string, ComposerDraft> {
  const existing = normalizeDraft(current[draftKey]);
  if (content.sourceShareId && existing.importedShareIds?.includes(content.sourceShareId)) {
    return current;
  }
  const attachmentIds = new Set(existing.attachments.map((attachment) => attachment.id));
  const incomingAttachments = content.attachments.filter((attachment) => {
    if (attachmentIds.has(attachment.id)) {
      return false;
    }
    attachmentIds.add(attachment.id);
    return true;
  });
  const attachments = [...existing.attachments, ...incomingAttachments].slice(
    0,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  );
  const text = mergeComposerDraftText(existing.text, content.text);
  const importedShareIds = content.sourceShareId
    ? [...(existing.importedShareIds ?? []), content.sourceShareId]
    : existing.importedShareIds;
  if (
    text === existing.text &&
    attachments.length === existing.attachments.length &&
    importedShareIds === existing.importedShareIds
  ) {
    return current;
  }
  return {
    ...current,
    [draftKey]: {
      ...existing,
      text,
      attachments,
      ...(importedShareIds ? { importedShareIds } : {}),
    },
  };
}

/**
 * Atomically moves an incoming share into a project-scoped composer draft.
 * The durable write happens before the share inbox item can be acknowledged.
 */
export async function mergeComposerDraftContent(
  draftKey: string,
  content: ComposerDraftContent,
): Promise<{ readonly skippedAttachmentCount: number }> {
  if (!(await awaitComposerDraftsLoaded())) throw loadFailure;
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = mergeComposerDraftContentState(current, draftKey, content);
  const currentAttachmentIds = new Set(
    normalizeDraft(current[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const nextAttachmentIds = new Set(
    normalizeDraft(next[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const skippedAttachmentCount = content.attachments.filter(
    (attachment) =>
      !currentAttachmentIds.has(attachment.id) && !nextAttachmentIds.has(attachment.id),
  ).length;
  // Publish the content and its import receipt together before the filesystem
  // await. Typing during persistence then builds on the receipt-bearing state,
  // and its debounced write is serialized after this transaction.
  if (next !== current) {
    appAtomRegistry.set(composerDraftsAtom, next);
  }
  await persistenceQueue.run(() => writePersistedComposerDrafts(next));
  return { skippedAttachmentCount };
}

/** Restores the exact content/settings captured before an interrupted import. */
export async function restoreComposerDraftSnapshot(
  draftKey: string,
  snapshot: ComposerDraft,
): Promise<void> {
  if (!(await awaitComposerDraftsLoaded())) throw loadFailure;
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const next = restoreComposerDraftSnapshotState(
    appAtomRegistry.get(composerDraftsAtom),
    draftKey,
    snapshot,
  );
  appAtomRegistry.set(composerDraftsAtom, next);
  await persistenceQueue.run(() => writePersistedComposerDrafts(next));
}

export function clearComposerDraftContent(
  draftKey: string,
  options?: { readonly clearWorkspaceSelection?: boolean },
): void {
  updateComposerDrafts((current) => clearComposerDraftContentState(current, draftKey, options));
}

export function clearComposerDraft(draftKey: string): void {
  updateComposerDrafts((current) => {
    if (!current[draftKey]) {
      return current;
    }
    const next = { ...current };
    delete next[draftKey];
    return next;
  });
}

export function removeComposerDraftsForEnvironment(
  drafts: Record<string, ComposerDraft>,
  environmentId: EnvironmentId,
): Record<string, ComposerDraft> {
  const environmentPrefix = `${environmentId}:`;
  const newTaskPrefix = `new-task:${environmentId}:`;
  return Object.fromEntries(
    Object.entries(drafts).filter(
      ([draftKey]) =>
        !draftKey.startsWith(environmentPrefix) && !draftKey.startsWith(newTaskPrefix),
    ),
  );
}

export async function clearComposerDraftsEnvironment(environmentId: EnvironmentId): Promise<void> {
  if (!(await awaitComposerDraftsLoaded())) throw loadFailure;

  const next = removeComposerDraftsForEnvironment(
    appAtomRegistry.get(composerDraftsAtom),
    environmentId,
  );

  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  appAtomRegistry.set(composerDraftsAtom, next);
  await persistenceQueue.run(() => writePersistedComposerDrafts(next));
}

export function useComposerDraft(draftKey: string | null): ComposerDraft {
  const drafts = useAtomValue(composerDraftsAtom);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return draftKey ? normalizeDraft(drafts[draftKey]) : EMPTY_DRAFT;
}
