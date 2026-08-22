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

/**
 * The `append` payload for Claude's system prompt preset. A constant rather
 * than a builder: unlike Codex, none of this varies by interaction mode.
 */
export function buildClaudeDeveloperInstructions(): string {
  return CLAUDE_QUESTION_INSTRUCTIONS;
}
