# Persistent development inside one conversation

The existing T3 conversation becomes Main. Each logical development workspace has one Git worktree and one stable native Owner binding. Codex and Claude share the same manager; their provider adapters keep their own native protocols and histories. No extra chat rooms or temporary Owner subagents are created.

The implementation is in `apps/server/src/orchestration/WorkspaceDevelopment.ts`. It composes the existing provider service, execution projector, worktree provisioning and orchestration engine. Migration 067 adds one project snapshot table and one ordered immutable command audit table. Changes update a snapshot and audit entry in a short SQLite transaction; native execution occurs outside that transaction.

Workspace ID, binding ID, native session ID, task ID, run ID and execution generation are independent. The stable provider key is `development:<binding-id>`. Every execution increments the persisted generation, including onboarding. Mirrored output uses the existing execution/attempt identity, so later work never resolves to an earlier completed response.

The `.workspace/development.json` file describes approved configuration; SQLite stores its applied revision and runtime state. It is not a branch-local live registry. Schema is exported as `WorkspaceDevelopmentDefinition` and published alongside this document as [development.schema.json](development.schema.json). Roles are generated under `.workspace/roles`, and the Owner template under `.workspace/templates`; shared project `AGENTS.md` remains the project's own common instructions.

Authenticated browser RPC is the direct-user path. Authenticated MCP scope is the Main path. Model text cannot grant itself a user source or Main role. `workspace_manage` combines status, create, dispatch, reconcile, verify, integrate and Architect planning. The actual provider instance, continuation namespace, cwd and selected model are checked before an Owner is reused.

A direct input is persisted before conflicting automatic work can proceed. `takeover` keeps human control until explicit return; closing the panel does not release it. Followups/queue keep the writer serial, while replace/takeover interrupts the active group and waits for cleanup. Delivery receipts, task completion, human control and verification are different facts. Unknown acknowledgement is blocked without blind retry. Freshness compares Git bytes before Main's dispatch, verification and integration.

Main's notification is bounded state and references, not a copy of every Owner transcript. Changes are grouped into one queued resume of the existing Main. Active Main turns drain it after finishing. An observation cursor and impact-resolution cursor remain separate. The queue does not wake Main on individual token/file events.

Verification operates in detached checkouts at exact candidate SHA, requirement revision, workspace generation and target SHA. Integration owns one queue, combines those candidates in another detached checkout, runs approved argv commands, then rechecks target and human control under the management input lock. Promotion uses an ordinary `git merge --ff-only`, updating the checked-out tree and index. Failed dirty checkouts are retained. There is no manager push, release or deploy operation.

The UI is an optional compact panel above the existing composer. Main/Owner selection changes where that same composer sends text. Existing message/execution rendering displays each provider's result in the same conversation. Shared typed RPC works over the existing environment connection, including remote web access; no origin or localhost credential is embedded in the bundle.

See [capability-report.md](capability-report.md) for the installed baseline, actual session/commit evidence and unsupported capabilities. See [recovery runbook](../../operations/persistent-workspaces.md) for recovery. This is the first vertical feature, not a claim that every proposed topology/security capability has shipped.

The [Goals measurement](dots-goals-measurement-20260930.md) proves native Codex continuation. The product's [development goal controls](development-goals.md) use the shared manager queue and existing Codex/Claude sessions, with no external dots installation or connection.
