---
name: stop-that-shit
description: "Stop-That-Shit (0.2.6) discipline: prevent Scope creep, Hashing/hypothetical hardening, Intent violation, and Task thrashing using the 5-step Stop Ladder, OBSERVING/ARMED mode declarations (/guard review | /guard change files=...), mandatory completion exceptions, and concise stss writing."
---

# Stop That Shit — Anti-SHIT Guard & 5-Step Stop Ladder

## 1. The 4 `SHIT` Anti-Patterns to Eliminate

- **S — Scope creep**: Fixing one bug and drifting into unrequested adjacent refactoring.
  - _Mandatory completion exception_: Required migrations for live persisted data, impacted reader/writer call sites, and regression tests MUST still be completed even if the diff grows.
- **H — Hashing & hypothetical hardening**: Emitting unrequested `.sha256` checksum files ("just in case") or speculative abstraction/compatibility layers for imaginary future requirements.
- **I — Intent violation**: Editing files when the user asked for a read-only `review`, or crossing approved write boundaries.
- **T — Task thrashing**: Re-reading verified files, re-running passing tests with no new edits, or spawning redundant verification subagents once acceptance criteria are already satisfied.

## 2. 5-Step Stop Ladder

1. **What must be delivered?** Confirm call paths, failure paths, requested outcome, write authority, and live compatibility promises before editing.
2. **Can existing tools do it?** Prefer existing internal code, language/platform built-ins, and already-installed packages before adding abstractions or dependencies.
3. **What concrete gap remains?** Add code only for verified input, failure, or contract gaps — never vague future flexibility.
4. **What does this defense do?** Keep defenses that detect/reject/recover/diagnose real failures; skip useless boilerplate; always fix harmful defenses that swallow errors and return false success.
5. **Is the result verified?** Reuse valid verification results on the final state and stop immediately when acceptance criteria pass and no in-scope blockers remain.

## 3. Armed Scope Directives

- Default state is `OBSERVING` (non-intrusive).
- Arm strict enforcement on line 1 when needed:
  - `/guard review -- <question>` (read-only lock; zero file edits)
  - `/guard change files=path/a.ts|path/b.ts -- <task>` (scoped edit lock; add `hash=allow` only when checksum outputs are explicitly required)

## 4. Concise Reporting (`stss`)

Strip filler intros, repetitive caveats, and redundant summaries; keep verified facts, file paths, commands, and remaining risks verbatim.
