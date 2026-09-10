# Orchestra and memory repair validation

This repair keeps conductor and worker executions in one durable conversation. Provider session keys remain independent, but no worker `projection_threads` rows are created. Attempt metadata is stored as `orchestra.block` activities; ordinary assistant messages hold the streamed bodies. Approval and input IDs include the execution ID and route back to the original provider request. Retrying appends a block, and terminal cleanup closes pending requests.

The conductor's initial roster comes from the user. Planning may add enabled, installed, authenticated provider/model candidates. Candidate IDs use a stable digest because participant IDs prohibit colons and model slugs may contain separators. The selected conductor and initial seats are preserved. Existing historical worker conversations are retained; new executions use the owning conversation.

Memory has explicit environment, project and folder scopes. Existing records remain project-local through migration 065, including their FTS content and usage counters. Folder context is matched at path-component boundaries; an empty context does not include folder records. Shared references retain the owning project ID for edits and usage accounting. Raw provider search reports retain sources and a verification marker after credential redaction.

## Failures reproduced and repaired

- Vite rejected the newly introduced `state/orchestra` package subpath. Web and mobile now consume orchestra helpers through the existing `state/presentation` export; protocol formatting is shared through the same path.
- The tab strip occupied the Windows caption-button region. The desktop layout now reserves a separate titlebar region before tabs. A follow-up inspection of the running Electron app reproduced another cause: a horizontal Windows scrollbar consumed space inside the fixed-height tab strip and pushed its bottom-aligned tabs above the strip. The strip now uses a minimum height so tabs and the scrollbar both fit. At a 22px interface font, the first tab previously began at y=29.5, above the native 40px titlebar boundary; it now begins at y=45.5 and remains fully visible.
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

The client rendered five synthetic blocks, preserved retry history, opened instructions and collapsed/expanded results. Initial browser-only desktop styling checks at widths 1440, 900 and 600 used the 52px fallback titlebar. These checks did not exercise the native overlay or individual tab clipping, which is why the scrollbar defect required follow-up verification in Electron.

A separate Electron instance used its own app profile, T3 home and server. Eight test conversations plus the initial draft produced horizontal overflow. At widths 1500, 1000 and 640 and interface fonts 12, 16, 22 and 32px, all twelve cases kept every tab below the real 40px native titlebar and above the scrollbar, with no page-level horizontal overflow. Ctrl+Tab and Ctrl+Shift+Tab switched tabs; Ctrl+W and the tab close button closed tabs; the new-tab button opened a tab. Native minimize, restore, maximize, unmaximize and close events were exercised through Electron's BrowserWindow API on owned windows. The live application was left running. Physical caption-button clicks were not exercised through the unavailable computer-use bridge.

Failure recovery was also tested with real providers, separately from the synthetic blocks. Claude planned a task for a Codex seat configured with an intentionally unsupported model. The provider rejected two attempts, and the client displayed the intervention question. Clicking “다른 좌석에게 맡기기” reassigned the task to the selected Claude conductor; the third attempt and the entire run completed. All graph nodes retained the owning conversation ID, and the UI retained both earlier attempts.

Another real run in that same conversation was cancelled with the client's “오케스트라 중지” button while a block was running. The run and block reached `cancelled`, and the active stop banner disappeared. The database still contained exactly four conversations before and after the run, proving that no worker conversations were created. The recovery and cancellation clients reported no uncaught page errors.

Authenticated WebSocket requests saved and queried three memory scopes. General searches returned project/shared records; `apps/web/src` also returned the `apps/web` folder record; `apps/server` did not. The knowledge controls rendered in the real client.

Focused regression tests cover execution isolation, request routing, retries, search capture/redaction, token attribution, old-memory migration, source usage, provider startup and Windows shim resolution. The follow-up tab repair passed 108 tests across seven related web test files, the web typecheck, targeted lint and formatting, and a production web build. Web and server use their scoped typechecks. Mobile additionally uses TypeScript 6.0.3 because the installed native preview reports unrelated React Navigation generic errors; physical mobile devices were not exercised.

Machine-local screenshots, browser sessions and test databases remain in the ignored validation home. Browser credentials, pairing tokens and copied conversation contents are not committed. The accompanying [memory records](./knowledge/orchestra-repair-notes.json) contain only reusable findings and source paths for storage through the application's knowledge API.

## Project control-center return navigation

An additional report reproduced OnChainBot's control center returning to a different project. `lastChatView` stored only one app-wide conversation, and the index-route fallback also selected a project globally. Return history now persists under an environment/project key. Before navigating, the control center validates remembered thread and draft ownership against current state. Missing history falls back to a recent, unarchived conversation in the same project, then an explicitly scoped new draft. Deleted conversations and promoted drafts update remembered targets even when their former tab now displays the control center.

An isolated browser reproduced the wrong return before the fix. Afterward it passed cross-project return, refresh persistence, direct-link fallback, empty-project draft creation, and project switching through the control-center sidebar. Focused tests cover independent environments with overlapping IDs, late project identity, deleted history, draft promotion, archived/legacy worker exclusion, and invalid draft ownership. The same sidebar handles direct links, restored tabs and navigation from the project list on web and Electron; native mobile uses separate React Navigation screens. No provider or wire contracts changed.

An isolated native Electron instance also passed the actual menu sequence: open OnChainBot's conversation, use the project filter to visit another project's conversation, open OnChainBot's control center, and click “대화로 돌아가기”. The selected tab returned to OnChainBot's original conversation with no uncaught page errors. All 24 focused tests, the web typecheck, targeted lint, and the production web build passed.

## Windows launcher CPU saturation

The running desktop launcher consumed 100.5% of one CPU core while the renderer used about 1.9%. A five-second event sample recorded 711,900 repeated `rename` notifications naming the `dist-electron` directory itself. Ignoring those filenames did not stop native event processing. Closing the two launcher FSWatcher handles while retaining its existing file polling reduced measured launcher CPU time from 4.86 seconds to zero over the next five-second sample.

Windows now polls only the three runnable bundles once per second. Other platforms retain native notifications with polling as a fallback. Bundle fingerprints include inode, modification time and size; output-directory replacement and temporarily missing files are handled without restarting against an incomplete set of bundles. Focused tests cover idle operation without native Windows watchers, disposal, coalesced edits, directory replacement and incomplete builds. This follows Node's documented warning that filesystem watching varies by platform and may not survive directory or inode replacement. See the [Node filesystem watcher caveats](https://nodejs.org/api/fs.html#caveats).

## Live memory persistence

After the developer explicitly authorized the required live-state write, the existing `t3 pair` command issued a temporary credential for the running application. All nine prepared records were stored through its authenticated orchestration API: one environment record, one project record and seven folder records. No validation server was started against the live home.

The application returned the saved content, scope and revision-pinned source links unchanged. Each record was retrieved through RAG search. Searches from another existing project included only the environment record; disabling sharing excluded that record as well. General and sibling-folder contexts excluded folder records, while matching child paths included them. Prompt composition for `apps/web/src` included the web repair memory. This verification completed on September 11, 2026 (Korea time).
