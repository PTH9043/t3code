/**
 * Storage rules behind the "하위 모델" section of a provider account.
 *
 * The account's own config keeps its settings as text the server reads loosely:
 * "answering model = value" lists where a name matches any model id that
 * contains it (case-insensitive) and the first match wins. The pickers
 * therefore write full model ids, longest first, and keep every entry they
 * cannot map to a known model so nothing a person typed earlier is lost.
 */
import type {
  ClaudeConductorWorkerModel,
  SubordinateAssignment,
  SubordinateRole,
} from "@t3tools/contracts";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/** One "answering model = value" entry; `value` is empty for an entry the server ignores. */
export interface ModelAssignment {
  readonly model: string;
  readonly value: string;
}

export const CLAUDE_WORKER_LABELS: Record<ClaudeConductorWorkerModel, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  inherit: "답변 모델과 같은 모델",
  off: "끄기 (일꾼에게 맡기지 않음)",
};

/** What the server uses when `conductorWorkerModel` is absent. */
export const DEFAULT_CLAUDE_WORKER: ClaudeConductorWorkerModel = "opus";

export const SUBORDINATE_ROLE_OPTIONS: ReadonlyArray<{
  readonly value: SubordinateRole;
  readonly label: string;
}> = [
  { value: "worker", label: "일꾼 — 지시받은 구현과 수정" },
  { value: "advisor", label: "조언자·비판자 — 계획과 결과를 비판적으로 검토" },
  { value: "scout", label: "탐색·보고 — 빠르게 찾아보고 정리" },
  { value: "planner", label: "설계 — 작업 순서와 완료 기준 제안" },
  { value: "tester", label: "검증 — 정해진 검사 실행과 근거 보고" },
  { value: "writer", label: "문서화 — 지정한 문서 작성과 수정" },
  { value: "diagnostician", label: "오류 진단 — 실패 원인과 다음 점검 제안" },
  { value: "analyst", label: "데이터 분석 — 수치·방법·한계 정리" },
  { value: "translator", label: "번역·현지화 — 번역 결과를 답변으로 전달" },
];

/** Value that tells Codex to keep the answering model for its sub-agents. */
export const CODEX_INHERIT = "inherit";

const asRecord = (config: unknown): Record<string, unknown> =>
  config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

export function readConfigText(config: unknown, key: string): string {
  const value = asRecord(config)[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Unsaved edits to the account's own config keys, as text per key (blank
 * removes the key). Saving an account's config restarts that account on the
 * server, so the section collects edits here and writes them in one go.
 */
export type ConfigDraft = Readonly<Record<string, string>>;

export const draftText = (config: unknown, draft: ConfigDraft, key: string): string =>
  draft[key] ?? readConfigText(config, key);

export const isDraftDirty = (config: unknown, draft: ConfigDraft): boolean =>
  Object.entries(draft).some(([key, value]) => value.trim() !== readConfigText(config, key));

/**
 * The config with every changed draft key written and blank ones removed;
 * other keys are carried over. Returns `undefined` when no key is left, which
 * the card stores as "no config".
 */
export function applyDraft(
  config: unknown,
  draft: ConfigDraft,
): Record<string, unknown> | undefined {
  const next = asRecord(config);
  for (const [key, value] of Object.entries(draft)) {
    if (value.trim() === readConfigText(config, key)) continue;
    if (value.trim().length === 0) delete next[key];
    else next[key] = value.trim();
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Writes the draft with exactly one `onChange`, or none when it changes nothing. */
export function commitDraft(
  config: unknown,
  draft: ConfigDraft,
  onChange: (nextConfig: Record<string, unknown> | undefined) => void,
): void {
  if (isDraftDirty(config, draft)) onChange(applyDraft(config, draft));
}

const splitEntries = (text: string): ReadonlyArray<string> =>
  text
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/** True when `name` names the model the way the server decides it: a case-insensitive part of its id. */
const namesModel = (name: string, model: string): boolean =>
  name.length > 0 && model.toLowerCase().includes(name.toLowerCase());

/** A model id can be written as a name in the text settings only without their separators. */
export const isAssignmentName = (slug: string): boolean => !/[=:,;\n]/.test(slug);

/** A model id can be listed in `helperForModels` only without the entry separators. */
export const isListName = (slug: string): boolean => !/[,;\n]/.test(slug);

/** The known id a saved name spells (ids match case-insensitively), or the saved text itself. */
export function canonicalName(saved: string, known: ReadonlyArray<string>): string {
  return known.find((candidate) => candidate.toLowerCase() === saved.toLowerCase()) ?? saved;
}

/** Splits like the server does, but keeps the entries the server ignores so they stay visible. */
export function parseModelAssignments(text: string): ReadonlyArray<ModelAssignment> {
  return splitEntries(text).map((entry) => {
    const separator = entry.search(/[=:]/);
    return separator < 0
      ? { model: entry, value: "" }
      : { model: entry.slice(0, separator).trim(), value: entry.slice(separator + 1).trim() };
  });
}

/**
 * Writes the entries longest name first: the server takes the first name that
 * is part of the answering model id, so "gpt-6-sol-mini" must come before
 * "gpt-6-sol". Entries of equal length keep their order.
 */
export function formatModelAssignments(rows: ReadonlyArray<ModelAssignment>): string {
  return rows
    .toSorted((left, right) => right.model.length - left.model.length)
    .map((row) => (row.value ? `${row.model}=${row.value}` : row.model))
    .join(", ");
}

/**
 * For each entry, the account models it decides. An entry can decide more
 * than the model it was picked for (its id is part of a longer id) or none
 * (an earlier entry already matched), which the section shows as a hint.
 */
export function modelsDecidedByAssignments(
  rows: ReadonlyArray<ModelAssignment>,
  modelSlugs: ReadonlyArray<string>,
  isUsableValue: (value: string) => boolean,
): ReadonlyArray<ReadonlyArray<string>> {
  const decided = rows.map((): string[] => []);
  for (const slug of modelSlugs) {
    decided[decidingAssignment(rows, slug, isUsableValue)]?.push(slug);
  }
  return decided;
}

/** Position of the entry the server uses for `slug` (the first usable one naming it), or -1. */
export function decidingAssignment(
  rows: ReadonlyArray<ModelAssignment>,
  slug: string,
  isUsableValue: (value: string) => boolean,
): number {
  return rows.findIndex((row) => namesModel(row.model, slug) && isUsableValue(row.value));
}

/** First account model without an entry of its own, for the "추가" button. */
export function nextUnassignedModel(
  rows: ReadonlyArray<ModelAssignment>,
  modelSlugs: ReadonlyArray<string>,
): string | undefined {
  const used = new Set(rows.map((row) => row.model.toLowerCase()));
  return modelSlugs.find((slug) => isAssignmentName(slug) && !used.has(slug.toLowerCase()));
}

/** The worker literal a saved value spells, or `undefined` when it is not one. */
export function claudeWorkerValue(value: unknown): ClaudeConductorWorkerModel | undefined {
  const lowered = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.hasOwn(CLAUDE_WORKER_LABELS, lowered)
    ? (lowered as ClaudeConductorWorkerModel)
    : undefined;
}

/** Mirrors the server: a Codex sub-agent model must be safe as a bare `-c key=value` override. */
export const isCodexSubagentValue = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);

/**
 * Adds the saved value as its own option when the list does not offer it, so
 * a setting that no longer maps to a known model stays visible and removable.
 */
export function withSavedOption(
  options: ReadonlyArray<SelectOption>,
  saved: string,
  describe: (saved: string) => string,
): ReadonlyArray<SelectOption> {
  return options.some((option) => option.value === saved)
    ? options
    : [...options, { value: saved, label: describe(saved) }];
}

// ── 잡일용 하위 API ────────────────────────────────────────────────

export interface HelperApiAccount {
  readonly instanceId: string;
  readonly displayName: string;
  readonly models: ReadonlyArray<string>;
  /** The helper only speaks the chat-completions protocol. */
  readonly supported: boolean;
}

/** Enabled OpenCode accounts that carry an API connection, in settings order. */
export function listHelperApiAccounts(
  providerInstances:
    | Readonly<
        Record<
          string,
          {
            readonly driver: string;
            readonly displayName?: string | undefined;
            readonly enabled?: boolean | undefined;
            readonly config?: unknown;
          }
        >
      >
    | undefined,
): ReadonlyArray<HelperApiAccount> {
  return Object.entries(providerInstances ?? {}).flatMap(([instanceId, instance]) => {
    if (instance.driver !== "opencode" || instance.enabled === false) return [];
    const connection = asRecord(asRecord(instance.config).apiConnection);
    if (!Array.isArray(connection.models)) return [];
    return [
      {
        instanceId,
        displayName: instance.displayName?.trim() || instanceId,
        models: connection.models.filter((model): model is string => typeof model === "string"),
        supported: connection.protocol === "chat-completions",
      },
    ];
  });
}

export const helperAccountValue = (instanceId: string, model: string): string =>
  `${instanceId}:${model}`;

/**
 * The option a saved "account:model" points at. The account may be written as
 * an instance id or a display name (the server accepts both); either resolves
 * to the id-based value. Anything that does not resolve comes back unchanged.
 */
export function resolveHelperAccount(
  saved: string,
  accounts: ReadonlyArray<HelperApiAccount>,
): string {
  const text = saved.trim();
  const separator = text.indexOf(":");
  if (separator <= 0) return text;
  const wanted = text.slice(0, separator).trim().toLowerCase();
  const model = text.slice(separator + 1).trim();
  const account = accounts.find(
    (candidate) =>
      candidate.instanceId.toLowerCase() === wanted ||
      candidate.displayName.toLowerCase() === wanted,
  );
  return account?.models.includes(model) ? helperAccountValue(account.instanceId, model) : text;
}

export function helperAccountOptions(
  accounts: ReadonlyArray<HelperApiAccount>,
): ReadonlyArray<SelectOption> {
  return [
    { value: "", label: "사용 안 함" },
    ...accounts.flatMap((account) =>
      account.models.map((model) => ({
        value: helperAccountValue(account.instanceId, model),
        label: account.supported
          ? `${account.displayName} · ${model}`
          : `${account.displayName} · ${model} (Chat Completions 형식만 지원)`,
        ...(account.supported ? {} : { disabled: true }),
      })),
    ),
  ];
}

/** Names in `helperForModels`; an empty list lets every answering model use the helper. */
export const parseHelperModelNames = (text: string): ReadonlyArray<string> => splitEntries(text);

export const formatHelperModelNames = (names: ReadonlyArray<string>): string => names.join(", ");

export interface HelperModelChoice {
  readonly slug: string;
  readonly checked: boolean;
  /**
   * Checked only because another checked model's id is part of this one's, so
   * it cannot be turned off on its own.
   */
  readonly locked: boolean;
}

/** Which account models the saved names allow, plus the names that match none of them. */
export function helperModelChoices(
  names: ReadonlyArray<string>,
  modelSlugs: ReadonlyArray<string>,
): { readonly models: ReadonlyArray<HelperModelChoice>; readonly unknown: ReadonlyArray<string> } {
  const isChecked = (slug: string) => names.some((name) => namesModel(name, slug));
  return {
    models: modelSlugs.map((slug) => ({
      slug,
      checked: isChecked(slug),
      locked: modelSlugs.some(
        (other) => other !== slug && isChecked(other) && namesModel(other, slug),
      ),
    })),
    unknown: names.filter((name) => !modelSlugs.some((slug) => namesModel(name, slug))),
  };
}

/**
 * Allows or disallows one account model. Turning a model off removes every
 * name that matches it and writes back the full ids of the other models those
 * names had allowed, so a short name like "opus" narrows instead of vanishing.
 */
export function toggleHelperModel(
  names: ReadonlyArray<string>,
  modelSlugs: ReadonlyArray<string>,
  slug: string,
  checked: boolean,
): ReadonlyArray<string> {
  if (checked) return names.some((name) => namesModel(name, slug)) ? names : [...names, slug];
  const kept = names.filter((name) => !namesModel(name, slug));
  const restored = modelSlugs.filter(
    (other) =>
      other !== slug &&
      names.some((name) => namesModel(name, other)) &&
      !kept.some((name) => namesModel(name, other)),
  );
  return [...kept, ...restored];
}

// ── 역할을 맡길 다른 모델 ─────────────────────────────────────────

/**
 * One answering account's rows of the server-wide `subordinateModels` list,
 * each with its position in that list so an edit can be written back.
 */
export function accountSubordinates(
  all: ReadonlyArray<SubordinateAssignment>,
  answeringInstanceId: string,
): ReadonlyArray<{ readonly index: number; readonly subordinate: SubordinateAssignment }> {
  return all.flatMap((subordinate, index) =>
    subordinate.answeringInstanceId === answeringInstanceId ? [{ index, subordinate }] : [],
  );
}

/**
 * The whole list with the row at `index` replaced, or removed when `next` is
 * `undefined`. The setting is replaced wholesale on save, so every other
 * account's rows are carried over untouched.
 */
export function withSubordinateAt(
  all: ReadonlyArray<SubordinateAssignment>,
  index: number,
  next: SubordinateAssignment | undefined,
): ReadonlyArray<SubordinateAssignment> {
  return all.flatMap((subordinate, position) =>
    position === index ? (next ? [next] : []) : [subordinate],
  );
}

/** Option value for one account's model; ids and model names may contain any separator. */
export const subordinateKey = (instanceId: string, model: string): string =>
  JSON.stringify([instanceId, model]);

/** `forModel` absent means every answering model of the answering account. */
export function withSubordinateForModel(
  subordinate: SubordinateAssignment,
  forModel: string,
): SubordinateAssignment {
  const { forModel: _omit, ...rest } = subordinate;
  return forModel ? { forModel, ...rest } : rest;
}
