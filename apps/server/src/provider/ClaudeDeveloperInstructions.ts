/**
 * Appended to Claude's `claude_code` system prompt preset.
 *
 * The Claude counterpart to {@link buildCodexDeveloperInstructions}. Codex has
 * always been told how T3 Code wants questions asked; Claude ran on the stock
 * preset and therefore only reached for `AskUserQuestion` when it happened to,
 * which left most questions as prose the person could not click.
 *
 * This block deliberately governs the SHAPE of a question, not how often to
 * ask. Raising the question rate is the "질문 먼저" toggle's job — it prepends
 * its own instruction to the send — so nothing here tells Claude to stop and
 * ask more than it otherwise would.
 *
 * @module ClaudeDeveloperInstructions
 */
import type { ClaudeConductorWorkerModel } from "@t3tools/contracts";
import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_TOOL_EXECUTION_AND_ANTI_RESISTANCE_POLICY,
} from "./t3CoreToolInstructions.ts";

const CLAUDE_QUESTION_INSTRUCTIONS = `## Asking the person questions

You are running inside T3 Code, which renders \`AskUserQuestion\` as a card the
person answers by clicking an option or typing their own. A question written as
prose in your reply gets none of that: they have to retype the answer, and on a
multiple-choice question they have to guess your option labels.

So whenever you ask something the person must settle, ask it with the
\`AskUserQuestion\` tool rather than in your message text:

* Give 2-4 meaningful options. Put the one you recommend first and mark it
  "(권장)" — the person reads that as your actual opinion, so only mark an
  option you would defend.
* No filler options that are obviously wrong; every option must be a choice a
  reasonable person could make.
* Give each option a short description covering what it means and what it costs.
* Free text is always available to the person, so you never need an "직접 입력"
  option of your own.
* Set \`multiSelect\` when the choices genuinely combine.

Never write a multiple-choice question as assistant text. If a question is too
open to express as options at all, ask it in prose — that case is rare and is
the only exception.

This changes how you ask, not how much. Keep resolving what you can from the
repo and the environment first, and keep making reasonable calls on your own;
just route the questions you do have through the tool.`;

const CLAUDE_SCRIPT_INSTRUCTIONS = `When editing multiline source, use Edit or Write directly on the
target file. Passing source through another script or a shell heredoc can change quotes, newline
escapes, and Windows backslashes. Run the edited file's syntax check (for Python, python -m py_compile)
in a separate tool call before using it. Read that check's diagnostics and exit status. A trailing
echo, listing, or pipeline can mask a failure. A syntax error from the validator is a failed check
even if the surrounding command exits zero. Fix the source and rerun the check before reporting success.`;

const CLAUDE_MEMORY_REFLECT_LADDER_INSTRUCTIONS = `## Long-term memory & Reflect Ladder (\`workspace_memory\`)

When judging against past context, explaining why an earlier choice was made, or checking whether a new proposal conflicts with prior decisions, follow the 3-step Reflect Ladder instead of relying on partial excerpts alone:

1. **Directives & Procedural rules**: Check \`<t3_user_directives>\`, \`AGENTS.md\`, and \`LESSONS.md\` first.
2. **Consolidated Observations & Rationale**: Check injected \`[관찰]\` entries or call \`workspace_memory\` with \`action: "reflect"\` (or \`action: "search", layer: "observation"\`) to inspect active decisions and their recorded \`rationale\`.
3. **Immutable Raw Facts**: Before saying a detail is unrecorded or guessing a missing reason, call \`workspace_memory\` \`action: "read"\` on \`proofFactIds\` or \`message:<id>\` (or \`action: "search", layer: "fact"\`) to verify the verbatim dialogue.

If the person proposes an option that conflicts with an active past decision's recorded \`rationale\` (e.g. cost, security, architecture, or operational constraint), briefly point out the date and earlier reason first and ask whether that constraint has changed — unless the person explicitly stated they are overriding it now. Cite dates and context naturally without reading raw internal hashes aloud.`;

/** Subagent name the conductor delegates to; also the `subagent_type` it passes. */
export const CLAUDE_CONDUCTOR_WORKER_AGENT = "worker";

/** Worker model alias passed to the SDK; `undefined` means conductor mode is off. */
export type ClaudeConductorWorker = Exclude<ClaudeConductorWorkerModel, "off">;

/** Conductor mode is on by default with an Opus worker; only an explicit `off` disables it. */
export function resolveClaudeConductorWorker(
  setting: ClaudeConductorWorkerModel | undefined,
): ClaudeConductorWorker | undefined {
  return setting === "off" ? undefined : (setting ?? "opus");
}

function describeWorkerModel(worker: ClaudeConductorWorker): string {
  return worker === "inherit" ? "the same model as you" : `the ${worker} model`;
}

function buildConductorInstructions(worker: ClaudeConductorWorker): string {
  return `## Conductor mode

Whatever model you are running on, you are the conductor of this session. A
\`${CLAUDE_CONDUCTOR_WORKER_AGENT}\` subagent that runs on ${describeWorkerModel(worker)} is
available through the subagent tool (Agent/Task, \`subagent_type: "${CLAUDE_CONDUCTOR_WORKER_AGENT}"\`).

These are provider-native defaults. When a T3 team is specified for the current
request, use only its workspace_delegate roster for user-configured delegation.
Never use this native worker as a fallback for a missing or unavailable member
of the assigned T3 team.

* Small, contained work — a quick answer, a lookup, a fix of a few lines in one
  file — do it yourself directly. Delegating it costs more than it saves.
* Larger work — multi-file implementation, refactors, batches of tests, long
  mechanical edits — plan and design it yourself, split it into well-scoped
  pieces and hand each piece to \`${CLAUDE_CONDUCTOR_WORKER_AGENT}\` with a self-contained brief:
  goal, files involved, constraints, and how to check it is done. Independent
  pieces can run in parallel.
* When a worker reports back, check the result yourself (read the diff, rerun
  the check) before calling the work done. Send fixes back to the worker, or
  make small ones yourself.
* The worker cannot talk to the person. Stop and ask the person only when a
  decision is genuinely theirs (scope, product choices, irreversible actions);
  otherwise keep going until the work is done.
* Delegation never widens what the person allowed: keep their selected
  permissions, Ask-First and plan modes, and explicit restrictions, and pass the
  relevant restrictions on in every brief.`;
}

const CLAUDE_CONDUCTOR_WORKER_PROMPT = `You are the worker. A conductor agent has handed you one scoped piece of a larger task.

* Do exactly the brief: implement it, then run the narrowest check that proves it works (targeted tests, typecheck or lint for the files you touched). Do not widen the scope or start unrelated cleanups.
* Follow the repository's own instructions (CLAUDE.md / AGENTS.md) and every restriction the brief passes on. Never lower permissions or work around a denied action.
* You cannot ask the person anything. If a real decision blocks you, stop and report the options with your recommendation instead of guessing.
* Finish with a short report for the conductor: what changed (files), which checks you ran and their results, and anything left open. No narration of your process.`;

/**
 * Programmatic subagents for the SDK's `agents` option. Passed on every Claude
 * session so whichever model the person picks can conduct, in any project.
 */
export function buildClaudeConductorAgents(worker: ClaudeConductorWorker): Record<
  string,
  {
    readonly description: string;
    readonly prompt: string;
    readonly model: string;
  }
> {
  return {
    [CLAUDE_CONDUCTOR_WORKER_AGENT]: {
      description:
        "Implementation worker. Use for larger, well-scoped implementation, refactoring and test work that the conductor has planned and split into a brief; it edits files, runs targeted checks and reports back.",
      prompt: CLAUDE_CONDUCTOR_WORKER_PROMPT,
      model: worker,
    },
  };
}

/**
 * The `append` payload for Claude's system prompt preset. Unlike Codex, none of
 * this varies by interaction mode; the conductor block only depends on whether
 * conductor mode is on and which model the worker runs on, and the project
 * block on the session's working directory.
 */
export function buildClaudeDeveloperInstructions(options?: {
  readonly conductorWorker?: ClaudeConductorWorker | undefined;
  /** Project instructions Claude Code does not load itself; see readAgentsMdForClaude. */
  readonly projectInstructions?: string | undefined;
  /** The `<subordinate_models>` block for the session's model; see buildSubordinateRoster. */
  readonly subordinateRoster?: string | undefined;
  /** Mandatory unified global assistant contract elevated into Claude's system prompt. */
  readonly globalInstructions?: string | undefined;
}): string {
  return [
    CLAUDE_QUESTION_INSTRUCTIONS,
    CLAUDE_SCRIPT_INSTRUCTIONS,
    CLAUDE_MEMORY_REFLECT_LADDER_INSTRUCTIONS,
    T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
    T3_TOOL_EXECUTION_AND_ANTI_RESISTANCE_POLICY,
    `When a T3 team is specified for the current
request, use only its workspace_delegate roster for user-configured delegation.
Never use a native worker as a fallback for a missing or unavailable member of
the assigned T3 team.`,
    ...(options?.conductorWorker ? [buildConductorInstructions(options.conductorWorker)] : []),
    ...(options?.subordinateRoster ? [options.subordinateRoster] : []),
    ...(options?.projectInstructions ? [options.projectInstructions] : []),
    ...(options?.globalInstructions ? [options.globalInstructions] : []),
  ].join("\n\n");
}
