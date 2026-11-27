/**
 * Which subordinate each answering model may use.
 *
 * The person assigns subordinates per answering model in a provider account's
 * settings. Assignments are written as text ("opus=sonnet, sonnet=haiku") so
 * they work for any model name without a form per model; a model the person
 * did not mention keeps the account's default.
 *
 * @module subagentSelection
 */
import {
  resolveSubordinateTeam,
  type SubordinateTeamSettings,
  type ProviderInstanceId,
  type SubordinateAssignment,
  type SubordinateRole,
  type ThreadModelTeam,
} from "@t3tools/contracts";

const CONDUCTOR_WORKER_MODELS = ["opus", "sonnet", "haiku", "fable", "inherit", "off"] as const;
export type ConductorWorkerSetting = (typeof CONDUCTOR_WORKER_MODELS)[number];

const entries = (text: string | undefined): ReadonlyArray<string> =>
  (text ?? "")
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/** True when `needle` names the model: a case-insensitive part of its id ("opus" in "claude-opus-5-5"). */
const namesModel = (needle: string, model: string): boolean =>
  model.toLowerCase().includes(needle.toLowerCase());

/** Parses "answering model = value" pairs; malformed entries are ignored. */
export function parseModelAssignments(
  text: string | undefined,
): ReadonlyArray<{ readonly model: string; readonly value: string }> {
  return entries(text).flatMap((entry) => {
    const separator = entry.search(/[=:]/);
    if (separator <= 0) return [];
    const model = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    return model && value ? [{ model, value }] : [];
  });
}

/**
 * The conductor worker for the model answering this session: the first
 * per-model assignment naming it, otherwise the account default. A value that
 * is not a known worker model is skipped rather than guessed at.
 */
export function resolveConductorWorkerForModel(input: {
  readonly fallback: ConductorWorkerSetting | undefined;
  readonly byModel: string | undefined;
  readonly model: string | undefined;
}): ConductorWorkerSetting | undefined {
  const model = input.model;
  if (!model) return input.fallback;
  for (const assignment of parseModelAssignments(input.byModel)) {
    if (!namesModel(assignment.model, model)) continue;
    const value = assignment.value.toLowerCase();
    const worker = CONDUCTOR_WORKER_MODELS.find((candidate) => candidate === value);
    if (worker) return worker;
  }
  return input.fallback;
}

/** A model id that is safe to pass as a bare `-c key=value` CLI override. */
const SUBAGENT_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/_-]*$/;

/**
 * The model Codex sub-agents run on for the model answering this session: the
 * first per-model assignment naming it, otherwise the account default.
 * `undefined` means the sub-agent keeps the answering model, which is also
 * what `inherit` asks for. A value that is not a model id is skipped.
 */
export function resolveSubagentModelForModel(input: {
  readonly fallback: string | undefined;
  readonly byModel: string | undefined;
  readonly model: string | undefined;
}): string | undefined {
  const model = input.model;
  const assigned = model
    ? parseModelAssignments(input.byModel).find(
        (assignment) =>
          namesModel(assignment.model, model) && SUBAGENT_MODEL_NAME.test(assignment.value),
      )?.value
    : undefined;
  const value = assigned ?? input.fallback?.trim();
  return value && value.toLowerCase() !== "inherit" && SUBAGENT_MODEL_NAME.test(value)
    ? value
    : undefined;
}

/**
 * Whether the answering model may use the helper API. An empty list allows
 * every model; otherwise the model must be named. Without a known model the
 * answer is no once a list exists: an unlisted model must not get the helper
 * by accident.
 */
export function helperAllowedForModel(
  list: string | undefined,
  model: string | undefined,
): boolean {
  const names = entries(list);
  if (names.length === 0) return true;
  return model !== undefined && names.some((name) => namesModel(name, model));
}

/** Splits "account:model" at the first colon; both halves are required. */
export function parseHelperAccount(
  text: string | undefined,
): { readonly account: string; readonly model: string } | undefined {
  const value = (text ?? "").trim();
  const separator = value.indexOf(":");
  if (separator <= 0) return undefined;
  const account = value.slice(0, separator).trim();
  const model = value.slice(separator + 1).trim();
  return account && model ? { account, model } : undefined;
}

/** A model the user placed under an answering account, with its account's display name. */
export interface SubordinateRow {
  readonly unavailable?: true;
  readonly instructions?: string;
  /** Answering model this row is limited to; absent means every model of the account. */
  readonly forModel?: string | undefined;
  readonly role: SubordinateRole;
  readonly account: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

/** The slice of server settings subordinate assignments are resolved from. */
export interface SubordinateSettingsSource extends SubordinateTeamSettings {
  readonly threadModelTeams?: readonly ThreadModelTeam[];
  readonly subordinateModels: ReadonlyArray<SubordinateAssignment>;
  readonly providerInstances: Readonly<
    Record<
      string,
      {
        readonly displayName?: string | undefined;
        readonly enabled?: boolean | undefined;
        readonly config?: unknown;
      }
    >
  >;
  /** Legacy per-driver settings: a driver's default account may exist only here. */
  readonly providers?: Readonly<Record<string, unknown>> | undefined;
}

const configEnabled = (config: unknown): boolean | undefined => {
  if (typeof config !== "object" || config === null) return undefined;
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

/** Display name of an account that exists and is enabled, the way the instance registry reads it. */
function enabledAccountName(
  source: SubordinateSettingsSource,
  instanceId: string,
): string | undefined {
  const explicit = Object.hasOwn(source.providerInstances, instanceId)
    ? source.providerInstances[instanceId]
    : undefined;
  if (explicit) {
    return (explicit.enabled ?? configEnabled(explicit.config) ?? true)
      ? explicit.displayName?.trim() || instanceId
      : undefined;
  }
  const legacy =
    source.providers && Object.hasOwn(source.providers, instanceId)
      ? source.providers[instanceId]
      : undefined;
  return legacy !== undefined && (configEnabled(legacy) ?? true) ? instanceId : undefined;
}

/**
 * The subordinates assigned to one answering account, for all of its models.
 * A row whose subordinate account is missing or disabled is dropped.
 */
export function resolveAccountSubordinates(
  source: SubordinateSettingsSource,
  answeringInstanceId: string,
): ReadonlyArray<SubordinateRow> {
  return source.subordinateModels.flatMap((row) => {
    if (row.answeringInstanceId !== answeringInstanceId) return [];
    const account = enabledAccountName(source, row.instanceId);
    return account === undefined
      ? []
      : [
          {
            ...(row.forModel === undefined ? {} : { forModel: row.forModel }),
            role: row.role,
            account,
            instanceId: row.instanceId,
            model: row.model,
          },
        ];
  });
}

/**
 * The rows that apply while `model` answers: those for every model plus those
 * naming it (case-insensitive). Without a known model only the former apply.
 */
export function subordinatesForModel(
  rows: ReadonlyArray<SubordinateRow>,
  model: string | undefined,
): ReadonlyArray<SubordinateRow> {
  const answering = model?.trim().toLowerCase();
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (row.forModel !== undefined && row.forModel.trim().toLowerCase() !== answering) return false;
    const key = subordinateAddress(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SUBORDINATE_ROLE_PURPOSE: Record<SubordinateRole, string> = {
  worker: "does implementation work you have planned and scoped; it edits files and runs checks",
  advisor:
    "acts as an independent critic: reviews against pinned spec, deterministic evidence, and repo checklists (CONFIRM/REJECT/UNVERIFIED_ERROR) without editing files",
  scout: "looks things up fast in files, commands and docs; it does not edit files",
  planner: "proposes a design, dependencies and acceptance criteria without changing files",
  tester:
    "runs scoped checks and reports evidence; it does not edit project files (mechanical execution & raw logs only; never final architectural approval)",
  writer: "writes or edits only the documentation assigned to it",
  diagnostician:
    "traces failures from evidence and suggests the next diagnostic step without editing files",
  analyst: "analyzes data and reports methods and limitations without editing files",
  translator: "returns translations or localized text without editing files",
};

type TeamScope = Pick<ThreadModelTeam, "threadId" | "answeringInstanceId" | "forModel">;

export interface TurnDelegateTeam extends TeamScope {
  readonly source: "room" | "global" | "account";
  readonly members: readonly SubordinateRow[];
}

/** Resolve once at submission. The prompt and the authenticated tool call use these same rows. */
export function resolveTurnDelegateTeam(
  settings: SubordinateSettingsSource,
  scope: TeamScope,
): TurnDelegateTeam {
  // A conversation's custom team wins; without one the global team applies.
  const team = resolveSubordinateTeam(settings, scope.threadId);
  return {
    ...scope,
    source: team.source,
    members: team.members.map((member) => {
      const account = enabledAccountName(settings, member.instanceId);
      return account === undefined
        ? { ...member, account: member.instanceId, unavailable: true }
        : { ...member, account };
    }),
  };
}

export const restrictNativeTeam = (team: TurnDelegateTeam): boolean =>
  team.source === "room" || (team.source === "global" && team.members.length > 0);

/** Exact tool address even when several accounts expose the same model under the same role. */
export const subordinateAddress = (row: SubordinateRow): string =>
  `${row.role}@${encodeURIComponent(row.instanceId)}:${encodeURIComponent(row.model)}`;

/** The roster is prompt text built from user-entered names; keep each on one line. */
const singleLine = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

/**
 * The instruction block that tells an answering model which models work under
 * it and how to hand them work. `undefined` when it has none.
 */
export function buildSubordinateRoster(rows: ReadonlyArray<SubordinateRow>): string | undefined {
  if (rows.length === 0) return undefined;
  const availableRoles = new Set(rows.filter((row) => !row.unavailable).map((row) => row.role));
  const roleNudges: string[] = [];
  if (availableRoles.has("tester")) {
    roleNudges.push(
      'After non-trivial code changes, backtests, or quantitative analysis, actively delegate independent verification (mechanical test/typecheck/lint execution and raw log/metric collection) to `tester`. Do NOT delegate final architectural or adversarial approve/reject judgment to a weaker `tester`; use `workspace_delegate(action="verify")`, a stronger `advisor` (with `criticContext`), or decide yourself.',
    );
  }
  if (availableRoles.has("writer")) {
    roleNudges.push(
      "When creating or updating documentation, READMEs, or structured reports, actively delegate drafting/editing to `writer` with the verified facts.",
    );
  }
  if (availableRoles.has("advisor")) {
    roleNudges.push(
      "Use `advisor` for fast, focused single-pass reviews, summaries, or logic/risk sanity checks, or as an independent critic with `criticContext` (pinnedSpec, deterministicEvidence, checklist) so final judgment is isolated from the implementer's narrative.",
    );
  }
  return [
    "<subordinate_models>",
    "The user placed these models under you. Each runs as a full agent in your working directory:",
    ...rows.map(
      (row) =>
        `- ${row.role} — ${singleLine(row.account)} · ${singleLine(row.model)} — ${SUBORDINATE_ROLE_PURPOSE[row.role]}. Exact to: "${subordinateAddress(row)}"${row.unavailable ? ". Account unavailable; report this and do not substitute another member" : ""}${row.instructions ? `. User role description: ${singleLine(row.instructions)}` : ""}`,
    ),
    "The user assigned this team to be used when a request calls for it; nothing obliges you to delegate. Before you start working alone, check whether the request needs any of these, and if it does, delegate that part first: exploring 4 or more files or large logs, implementation that splits into independent parts, a check that should not depend on your own work, documentation drafting, or a review by a different model. Only you (the supervisor) can call `workspace_delegate` — subordinates cannot re-delegate, so after `worker` finishes, you should hand verification or documentation to `tester`/`writer`/`advisor` yourself. Work you have already done alone cannot be handed over afterwards.",
    ...roleNudges,
    "Small tasks are yours to do directly: up to 3 known files or one single-file edit. Ask each subordinate for a short structured summary (about 800 tokens: file paths, line numbers, verified facts) so that delegating costs less than reading everything yourself.",
    'Hand independent tasks over together with the `workspace_delegate` tool of the t3-code MCP server: prefer `action: "run_parallel"` with `tasks: [{ to, task }, ...]` (using the exact addresses shown; up to 6 run at once) for scouts, testers and advisors, and for `worker`/`writer` too when their target files do not overlap. Run tasks one after another only when one depends on another\'s result or edits the same files. `action: "start"` + `action: "wait"` (`delegationIds`) or `action: "run"` handles a single task. Give each a self-contained task, because it sees nothing of this conversation. Verify what comes back; you stay responsible for the result.',
    "</subordinate_models>",
  ].join("\n");
}

export function turnDelegateInstructions(
  team: TurnDelegateTeam,
  available: boolean,
): string | undefined {
  if (team.source !== "room" && !team.members.length)
    return available
      ? "There is no T3 team assigned for this request. Disregard rosters from earlier turns. Provider-native subagent settings apply independently."
      : undefined;
  const rule =
    "For user-configured delegation on this request, these turn instructions supersede earlier rosters and provider-native worker defaults. Never substitute a native subagent or another account or model for a designated team member.";
  if (!team.members.length) return `${rule} This turn has no assigned team. Do the work yourself.`;
  if (!available)
    return [
      rule,
      buildSubordinateRoster(team.members),
      "The authenticated workspace_delegate tool is unavailable for this session. Report that limitation if delegation is requested.",
    ].join("\n");
  return [rule, buildSubordinateRoster(team.members)].join("\n");
}
