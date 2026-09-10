# Orchestra and memory repair validation

This repair keeps conductor and worker executions in one durable conversation. Provider session keys remain independent, but no worker `projection_threads` rows are created. Attempt metadata is stored as `orchestra.block` activities; ordinary assistant messages hold the streamed bodies. Approval and input IDs include the execution ID and route back to the original provider request. Retrying appends a block, and terminal cleanup closes pending requests.

The conductor's initial roster comes from the user. Planning may add enabled, installed, authenticated provider/model candidates. Candidate IDs use a stable digest because participant IDs prohibit colons and model slugs may contain separators. The selected conductor and initial seats are preserved. Existing historical worker conversations are retained; new executions use the owning conversation.

Memory has explicit environment, project and folder scopes. Existing records remain project-local through migration 065, including their FTS content and usage counters. Folder context is matched at path-component boundaries; an empty context does not include folder records. Shared references retain the owning project ID for edits and usage accounting. Raw provider search reports retain sources and a verification marker after credential redaction.

## Failures reproduced and repaired

- Vite rejected the newly introduced `state/orchestra` package subpath. Web and mobile now consume orchestra helpers through the existing `state/presentation` export; protocol formatting is shared through the same path.
- The tab strip occupied the Windows caption-button region. The desktop layout now reserves a separate titlebar region before tabs.
- Opening Add Project before connection completion retained a stale menu snapshot. The open environment menu now follows the current connection state.
- Provider subscriptions could miss events emitted immediately after startup. Subscription fibers now start immediately before provider work is dispatched.
- Workers reusing a provider usage source ID could share token cursors. Orchestra usage now identifies each block independently, including retries.
- Client activity compaction could erase older block headers and instructions. Bounded retention now preserves block metadata alongside retained messages; a regression test covers 3,100 subsequent tool rows.
- Research capture masked credentials in the body and query but left the title unmasked. Titles now use the same redaction, with a regression assertion against the entire persisted record.
- SQLite connections did not tolerate brief contention with another application process. They now configure a five-second busy timeout.
- A 15,270-character Windows PATH made `cmd.exe` unable to launch `node`, producing failed Codex probes. Stock npm Node shims now launch their resolved Node executable and script directly. Custom batch scripts retain their behavior; no global PATH or registry setting is changed.

## Integrated proof

Validation used an isolated T3 home, a dedicated Git workspace, and a headless Edge client. A read-only copy of 24 existing messages provided populated history. Synthetic blocks tested failure/retry presentation; these fixtures were written only while the isolated server was stopped.

A separate real run used authenticated Codex and Claude accounts against a README-only workspace. The conductor planned two independent read-only tasks, workers reported the README title and whitespace token count, validation gates passed, and synthesis completed. All six graph nodes used `live-orchestra-validation` as their conversation ID. The run completed without an error in approximately one minute.

The client rendered five synthetic blocks, preserved retry history, opened instructions and collapsed/expanded results. At widths 1440, 900 and 600, the desktop titlebar region was 52 pixels high and the tab list began at y=52. This is DOM/CSS geometry verification; native caption-button clicks were not available through the computer-use bridge.

Authenticated WebSocket requests saved and queried three memory scopes. General searches returned project/shared records; `apps/web/src` also returned the `apps/web` folder record; `apps/server` did not. The knowledge controls rendered in the real client.

Focused regression tests cover execution isolation, request routing, retries, search capture/redaction, token attribution, old-memory migration, source usage, provider startup and Windows shim resolution. Web and server use their scoped typechecks. Mobile additionally uses TypeScript 6.0.3 because the installed native preview reports unrelated React Navigation generic errors.

Machine-local screenshots, browser sessions and test databases remain in the ignored validation home. Browser credentials, pairing tokens and copied conversation contents are not committed. The accompanying [memory records](./knowledge/orchestra-repair-notes.json) contain only reusable findings and source paths for storage through the application's knowledge API.

## Live memory persistence

After the developer explicitly authorized the required live-state write, the existing `t3 pair` command issued a temporary credential for the running application. All nine prepared records were stored through its authenticated orchestration API: one environment record, one project record and seven folder records. No validation server was started against the live home.

The application returned the saved content, scope and revision-pinned source links unchanged. Each record was retrieved through RAG search. Searches from another existing project included only the environment record; disabling sharing excluded that record as well. General and sibling-folder contexts excluded folder records, while matching child paths included them. Prompt composition for `apps/web/src` included the web repair memory. This verification completed on September 11, 2026 (Korea time).
