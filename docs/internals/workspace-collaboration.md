# Workspace collaboration task graphs

> For maintainers. User-facing behavior is documented in [Fable task orchestration](../user/workspace-orchestration.md).

Workspace collaboration runs are durable, provider-backed dependency graphs. They reuse the existing thread and provider runtime instead of introducing a second agent execution system.

## Logical agents and provider routes

The graph uses three logical agents:

- Fable owns planning, validation, graph revision, synthesis, and selective memory.
- Codex owns implementation, debugging, tests, data work, and automation.
- Grok owns current-information and social research.

Workspace role bindings map Fable to `coordinator`, Codex to `implementer`, and Grok to `researcher`. Codex and Grok routes are rejected unless their provider instance has the matching driver kind. A failed attempt can select an unused enabled instance of the same driver; attempts are bounded so a route cannot loop forever.

## Durable model

The wire contract stores a `WorkspaceTaskGraph` on each collaboration run. A graph contains nodes, dependencies, attempts, validation receipts, confidence, failure classifications, revision history, next action, and Fable-selected memory candidates. The collaboration projection stores the snapshot as JSON; the orchestration event log retains the sequence of run updates. Legacy runs decode with a null graph and continue through the former linear-step path.

Database migrations separately add incident/operator compatibility and graph storage so upgrading an existing installation preserves roles and collaboration runs.

## Execution loop

The collaboration reactor implements the loop:

1. create a Fable planning node and compose workspace memory once;
2. parse a bounded tagged JSON graph proposal;
3. reject duplicate IDs, missing dependencies, cycles, existing-ID collisions, and incompatible routing;
4. insert a Fable validation gate after every Codex or Grok producer and a terminal synthesis node;
5. start up to three dependency-ready nodes in one wave and run their provider turns concurrently;
6. apply the wave atomically, persist the graph snapshot, refresh the ready frontier, and continue.

Every assignment contains only the workspace prompt needed by Fable plus the direct outputs of the node's dependencies. The handoff headings are stable because models and tests rely on them: `TASK`, `GOAL`, `CONTEXT`, `INPUT`, `CONSTRAINTS`, `EXPECTED OUTPUT`, `DEPENDENCIES`, and `SUCCESS CRITERIA`.

## Validation and graph revision

Codex and Grok results stop in `awaiting-validation`. Fable emits a typed receipt with a verdict, confidence, evidence, failure classification, and optional follow-up nodes. Pass with medium or high confidence completes the producer. Failure or low confidence either materializes the bounded follow-up nodes immediately or creates a Fable recovery-planning node.

Failures are classified as information, implementation, tool, assumption, or validation. Information recovery must include Grok research; implementation recovery must include Codex implementation or debugging; validation recovery must create a new independently validated Codex or Grok path. A low-confidence synthesis or unresolved result conflict creates another cross-validation path instead of retrying the same synthesis.

Graph application keeps the pre-result graph until parsing and revision succeed. A malformed model response therefore retries the current node without leaving its target partly failed or validated.

## Memory, safety, and payload bounds

Full graph history remains on the collaboration run. Graph runs do not automatically promote their entire transcript into workspace knowledge. Only synthesis memory candidates are written to long-term memory, with non-high confidence retained as candidates.

Incident repair restart approval is typed: the graph must explicitly approve repair, overall confidence cannot be low, and at least one validation receipt for a completed target must pass with non-low confidence. The legacy output marker is read only for pre-graph runs.

Provider responses, node handoffs, attempt records, visible run count, and refresh frequency are bounded. This keeps the polled web/mobile projection from turning historical agent output into an unbounded WebSocket payload.

## Client surfaces

Web and desktop render topological columns with parallel lanes, dependency edges, attempts, validation evidence, graph changes, memory candidates, and thread links. Mobile provides the same read model as a vertical graph monitor, with thread navigation and cancellation but leaves run creation and role configuration in the web/desktop control center.

Layout helpers are pure and isolate missing dependencies, duplicate IDs, cycles, and cycle descendants instead of crashing the client.
