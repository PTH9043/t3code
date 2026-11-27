---
name: ponytail-minimalism
description: "Apply the 6-step Ponytail minimalism decision ladder, Graphify AST-first exploration discipline (EXTRACTED/INFERRED/AMBIGUOUS edge tagging), Never-Cut safety boundaries, and // shortcut: debt tracking to prevent over-building and unnecessary dependencies."
---

# Ponytail Minimalism & AST-First Exploration

## 1. 6-Step Minimalism Decision Ladder (Stop at the First Passing Step)

Before writing new code, trace all callers, tests, fixtures, and configs, then evaluate in order:

1. **Existence**: Does this feature, abstraction, or config flag truly need to exist?
2. **Internal Reuse**: Does an existing helper, hook, utility, or component in this repo already do this?
3. **Platform Built-In**: Can standard runtime/language/browser APIs solve this cleanly?
4. **Already-Installed Dependency**: Can an already-installed package in `package.json` solve it without adding new dependencies?
5. **Simple Inline**: Is 2–10 clear inline lines better than premature factory/wrapper abstractions?
6. **Minimal New Code**: Only when Steps 1–5 fail, write the smallest well-tested module that satisfies the requirement.

## 2. Never-Cut Safety Boundaries

Never shrink or skip:

- Input validation at trust boundaries (external APIs, user inputs, SSRF URLs)
- Error handling that prevents data loss or silent partial failure
- Authentication, host approval gates, and secret scrubbing
- Accessibility (`aria-*`, keyboard navigation) and explicit user requirements

## 3. Intentional Shortcut Ledger

Whenever choosing a deliberately simple implementation over a heavier design, leave an explicit inline marker:

```ts
// shortcut: <current limitation>, <concrete upgrade trigger>
```

And pair every trust-boundary or risk-bearing change with at least one focused regression test.

## 4. AST-First Exploration & Confidence Tagging (`graphify-mcp` Soft Mode)

- When `graphify-mcp` is enabled in a project (keep `--strict` OFF to avoid hook collisions with `WorkspaceMemory`), query `god_nodes` / `query_graph` / `get_pr_impact` before reading whole files.
- Label dependency claims strictly:
  - `EXTRACTED`: Directly observed in code AST / imports / call sites.
  - `INFERRED`: Derived from static types or surrounding context.
  - `AMBIGUOUS`: Dynamic dispatch or doc-to-code link — never assert as confirmed fact without verification.
