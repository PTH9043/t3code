# Agent control

WorkspaceAgentControl stores messages, input receipts and terminal reports as thread.activity.append events with orchestra.agent-control payloads. Stable activity IDs upsert the latest record; command IDs include record revision. Repository reads load durable activities rather than the bounded thread UI cache. No database migration is needed.

The workspace_mailbox MCP tool authenticates the sender from the owner thread and currently running Orchestra session key. UI callers represent the user. Cross-project/run access, stale revisions, conflicting request IDs and tool-driven requeue/cancel are rejected. The UI never submits an approval from an inbox snapshot; it opens the existing request UI.

The executor prepares exact task input only after its completed/interrupted-message recovery guard. Content-addressed context files are read and hash-checked before submission and again on retrieval. sendTurn acceptance advances prepared/dispatching to accepted; recipient ack alone means read. Unsettled claims become unknown on reconciliation and are never automatically replayed.

Terminal reports use deterministic node/attempt/status IDs. They follow the committed graph update and are reconciled when a run re-enters or a terminal run is viewed; this is not an atomic transaction with the graph update. A terminal reply report does not imply delivery verification passed.

The attention subscription reads only resumable runs, returns compact entries (at most 200), coalesces collaboration changes and uses the client shell for native approval/question/error flags. Full input artifacts are queried on demand. Mailbox subscriptions mount only when expanded.

Usage recovery persists fingerprint, deadline, phase and count on the task node. A pure policy requires an actual limit error and known future reset, applies count/attempt bounds, and suppresses the same fingerprint. Dispatch uses the injected clock. A parked run releases its project semaphore and receives a scoped deadline wake-up; startup schedules from persisted deadlines. Cancellation invalidates a pending wake-up.
