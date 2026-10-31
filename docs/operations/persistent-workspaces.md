# Persistent workspace operations

Use the normal T3 server and its configured data home. All worktrees belong to that environment and use the same `state.sqlite`. Do not start another server against the same live database. Project paths come from T3's project record and Git's worktree provisioning service, not guessed directory names.

On Windows use the established [runtime start procedure](windows-runtime-start.md). For test fixtures, use `node scripts/dev-runner.ts dev --home-dir <isolated-home>` and retain the real port/PID output. The provider account credentials stay in the existing provider configuration; no authentication files are copied into the project's `.workspace` definitions.

Enable **지속 작업실** in an existing integration conversation. The current thread is Main. Choose Codex/Claude/OpenCode models with the existing Orchestra model selection before first activation. Enter approved verification commands as JSON objects with `command` and `args`; the manager invokes argument arrays without assembling a shell command. Commands must work in an isolated candidate checkout. Dependencies/build setup required by that project must already be available there; this feature does not automatically install packages or isolate databases/ports.

For compatible APIs configure an OpenCode instance's `apiConnection` and its sensitive `T3_OPENCODE_API_KEY` environment entry through Settings. Discovery, adapter execution and text generation use the same generated official `OPENCODE_CONFIG_CONTENT`; keys are environment references, never inline configuration values. API profiles require a locally managed OpenCode process. To use a remote OpenCode server, configure providers on that server and leave `apiConnection` absent. Endpoint/protocol/data-home changes alter continuation identity and require explicit reconciliation; key rotation preserves identity. Normal settings are stored locally without encryption, with sensitive values redacted on the client wire.

The compatible API smoke script uses a disposable project in an existing isolated T3 environment: `node scripts/workspace-development-api-demo.mjs <isolated-home> <installed-opencode-binary>`. Only HTTP model responses are simulated. It runs native OpenCode, actual MCP management/file/Git tools, durable session resume, authenticated user takeover and exact candidate verification/integration. It does not test an external paid API account. The script restores the isolated environment's provider configuration afterwards and preserves Git/session evidence.

Configuration writes `.workspace/development.json`, Main/Architect role files and an Owner template. Workspace creation writes a domain definition. Review and commit these policy files through the normal project workflow before integration. The manager refuses a dirty integration checkout and never clears it for you.

## Recovery

1. Reuse the same environment home, project and Main conversation. Read the panel's session/task records and `workspace_manage status` before issuing another command.
2. Completed tasks retain native binding, candidate SHA, requirement revision and verification logs. Subsequent input uses the same binding/session key and restores the adapter's persisted resume cursor.
3. A running task at restart becomes `delivery_unknown`. This is a preservation barrier, not an instruction to retry. Inspect native history through the supported harness and compare command ID, native turn/message refs, mirrored output, Git HEAD and diff. No automatic acceptance claim or replay is made.
4. Resolve any actual remaining native execution before allowing a new writer. The manager's `reconcile` checks known provider active turns. An external CLI is outside that check; do not independently resume an Owner while the manager operates it.
5. Record the concrete outcome/remaining work through Main's `reconcile` at the latest workspace revision. Unknown tasks remain in history and are never automatically replayed. A new explicit task can describe the remaining work after native inactivity is confirmed.
6. For human takeover, use **Main에 반환**; Main then records requirement and integration impacts with `reconcile`. Closing a window leaves takeover intact.

Failed worktree/session provisioning keeps the workspace ID, existing worktree and binding. Reissue `create` with the same name, scope and model profile to resume the plan. A profile or scope change is not a retry. If a native session is missing or changed, execution stops; automatic session replacement, topology split/merge/retirement and dirty-worktree cleanup are unsupported.

Any Git edit outside the managed Owner changes the freshness fingerprint, including changed untracked bytes. Main must inspect the actual diff and record its effects before new automatic dispatch/integration. This cannot detect an external transcript-only input or stop an independent native client before it writes. Use the managed composer for all concurrent participation.

## Evidence and verification

Management tables: `workspace_development_state`, `workspace_development_events`. Original conversation storage belongs to the harness; the manager never edits it. T3's `projection_thread_messages` and execution activities are the in-app views. Verification logs and temporary checkouts are in `<userdata>/workspace-development`. An ordinary worktree remove is attempted after verification; dirty/error checkouts are retained and their paths logged.

The manager serializes its own integration and input gates. Independent shells/editors/Git operations are not prevented from modifying the repository after its last check. Native tool access follows the provider's runtime mode; worktree scope guidance is not filesystem isolation. Restrict those tools through the existing provider/runtime policy when the project needs a stronger boundary.

Use the demo and evidence scripts documented in [the capability report](../internals/persistent-workspaces/capability-report.md). Both scripts use an isolated home. Pairing credentials stay in memory and are not written into evidence artifacts. Native transcript evidence records identities/references and excludes private reasoning.

## Development goals

Goals use the same server, Main conversation, SQLite snapshot/audit and provider adapters. There is no dots installation or separate goal worker. Read the goal's control/phase, step/time limits, pending message reference and last summary in the panel. Pause/cancel stops automatic followups; already running providers and tests finish normally. Resume is explicit and never creates a new Main binding.

A restart with an in-flight Main goal input blocks the goal and preserves its ID and bindings. Inspect the Main's actual last turn/history, Owner delivery states and Git changes, reconcile outstanding facts, then resume. If the last Main response omitted `goal-progress`, inspect its outcome before resuming. An exhausted limit cannot be raised by Main; end the goal and set a new approved objective/limit after the current execution is idle. Completion requires current release-ready integration evidence and does not publish it.
