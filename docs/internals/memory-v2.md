# Memory v2 and bounded history reads

The operational store remains SQLite. Original events, messages and activity payloads remain unchanged; this change does not migrate or delete their live database rows. Full history archives are additional gzip files, verified from disk before a SHA-256 reference is committed to `workspace_memory_source_archives`.

The layout borrows the selective file access pattern from the official Grok CLI memory v2 implementation, inspected at `xai-org/grok-build` commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`. It does not embed that CLI or run its model-based Dream implementation. Our consolidation is extractive: retain sources, suppress exact duplicate excerpts in a bounded topic window, order by source time, and retain prior published revisions. A model can create a curated note explicitly through `remember`.

## Files and state

Under T3 userdata, `memory-v2/workspaces/<project-hash>/` and `memory-v2/global/` contain:

- `observations/_inbox/`: pending durable observations with provenance and excerpt hashes.
- `topics/`: paged topic notes. Consolidation archives processed inbox files.
- `MEMORY.md`: at most 8 KiB and 64 topic pointers per scope. It does not contain the entire memory corpus.
- `.history/` directories: previous note revisions, excluded from the active index.
- `sources/<thread-hash>/<sha256>.ndjson.gz`: consistent full source archives.

Migration 073 adds derived memory/FTS tables, pending-message and progress records, dirty-topic work and verified archive references. Stable source IDs make replay idempotent. A forgotten record stays forgotten after replay. Pending messages are revisited after settlement even when the scan cursor has advanced past them. Folder-scoped knowledge stays with the existing scoped RAG and is not widened to project memory.

The knowledge reactor reconciles on startup, knowledge changes and turn/session settlement. Work is serialized and reads source records in pages of 64; write batches commit together. Capture labels distinguish user statements from unverified agent reports. Current task state is not interpreted as a verified permanent fact.

## Retrieval and provider handoff

`workspace_memory` is registered on the shared managed MCP endpoint. The authenticated invocation thread determines the project before storage is called. It therefore follows the existing managed-MCP support of each provider and does not depend on a provider's private memory implementation. Web, desktop and mobile use the same backend behavior; there is no new client-specific protocol or UI.

Automatic context honors existing conversation RAG and automatic chat-memory settings. Small index excerpts and at most six evidence excerpts share a roughly 14 KiB budget. The existing workspace prompt, mandatory instructions and attachment RAG keep their own established budgets. The memory excerpt is historical evidence and cannot override current user instructions.

Provider switches read at most 30 recent messages using bounded SQL text selection. They do not hydrate the entire activity timeline. The source-preserving handoff additionally publishes a full archive and points the model at `history`, `read` and `export`. A failed archive leaves originals available through those tools and is logged.

`history` is a live paged view, with an explicit cursor/completion flag and excerpts of 1,200 Unicode code points. `read` follows source IDs and uses 12,000-code-point pages. A complete immutable audit uses `export`: a dedicated read-only SQLite connection and read transaction stream messages, activities, plans, checkpoints and the thread's canonical events, including revert/decision evidence. One export per service runs at a time. The writer connection remains separate. JSON escaping of large text cells is chunked, gzip backpressure is respected, and a partial artifact is never published. The original event payload JSON is stored as an exact string in each exported row.

The Node SQLite adapter now implements row streams with an owned native iterator. Cancellation returns the iterator; streams do not reuse cached mutable statements. Existing non-streaming callers retain their behavior.

The Bun adapter currently does not implement SQL streams. Its archive reader uses keyset pages of eight rows on the same snapshot transaction, and marks source-rowid ordering in the header. This fallback is covered using the same SQL source tables; a Bun runtime was not installed on the validation PC.

## Semantic RAG and chunking

Semantic candidate selection uses keyset pages of 64 scoped rows up to a captured rowid boundary. Folder, sharing, attachment and exclusion filters run before paging. The current transaction context is captured for page reads. There is no latest-1,000 ceiling and no all-candidates vector map.

Content-addressed vector files under `semantic-rag/v3/` are keyed by the source project, endpoint, model and indexed content. One page of vectors and the best 100 candidates stay in memory. The requested per-item chunk cap is applied while retaining semantic candidates so one large source cannot fill the entire shortlist. Query vectors use an LRU bounded by both 128 entries and an estimated 1 MiB of retained vector data.

Search reads cached document vectors and queues missing source projects; it never embeds document batches in the request. A cold corpus returns keyword matches and an explicit preparation message. Migration 074 stores coalesced indexing jobs and vector references. One scope-owned worker processes 64-row keyset pages, embeds at most two inputs at a time, commits completed progress and resumes pending work after restart. Changed sources reset a job revision, and references are published only if the source row still matches. Query and background embedding calls share one permit; a request can wait for one current batch, not an entire indexing job. Failed jobs use bounded backoff, with failure/preparation status visible to callers.

Embedding inputs, including titles and queries, have a 4 KiB UTF-8 cap and batches an 8 KiB cap. These byte limits are not a claim about the model's tokenizer. Model-side truncation is disabled; an input the configured model cannot accept remains retryable and keyword retrieval stays available. Existing 1,200-character chunks and heading-aware overlap remain unchanged.

After a complete indexing pass, at most once per scope per day, cleanup streams the scope's derived vector directory and removes only unreferenced vector/temporary files older than 24 hours. An unfinished pass cannot authorize cleanup. Current references protect active vectors, including those unused in a recent query or hidden by that query's folder filter. Cleanup never traverses original history archives or topic revisions. A preview operation reports eligible file counts and bytes without deleting them. Other inactive model scopes and the legacy v2 cache are retained; this is not a global disk quota.

Markdown sections and paragraphs are split before bounded overlap, preserving parent-child heading hierarchies (`H1`–`H6` and Korean clause headings such as `제N조`) on nested and continuation chunks as well as repeating active Markdown table headers across split tables. Korean clause tokens (`제3조`, `제12항`) and hyphenated alphanumeric identifiers (`TS-999`, `A-2201`) are indexed and queried as intact units and prioritized when long queries exceed the term cap. Hybrid search fuses FTS5 BM25 and dense cosine candidates via RRF (`k = 60`, top-100 shortlist) followed by a query–document cross-interaction reranker (exact identifier/clause match, term coverage, token-pair proximity window density, and heading alignment). Knowledge selection applies Self-RAG/CRAG relevance grading and computes an explicit Google Sufficient Context assessment (`findings`, `gaps`, `action`), while `evaluateKnowledge` tracks `p99Ms` tail latency and the four RAGAS metrics (`contextPrecision`, `contextRecall`, `faithfulness`, `answerRelevancy`). Conversation memory preserves message/turn IDs; activities retain their turn linkage and exact raw source in the archive. No summary replaces the original request, reply or tool result.

## Runtime memory lifecycle

Shell subscriptions retain only sequence/type/aggregate envelopes before coalescing; large message and tool payloads are not kept in sidebar buffers. Shell and thread live buffers are bounded by 1,024 items and an estimated 4 MiB of retained payloads per subscription. Overflow immediately clears that tail and fails the subscription with the existing typed snapshot error. Shared clients retry from their last applied sequence; persisted replay or a fresh snapshot recovers omitted live delivery. The global event bus is unchanged, and this does not bound every internal reactor queue.

Memory retrieval examines at most 64 candidates, groups exact repeated evidence with bounded supporting source IDs, and uses relevance/diversity ranking. User statements and explicit corrections receive preference. Only observed session records receive a soft recency penalty; curated permanent notes do not age out. Historical queries retain dated repetitions and disable that penalty. This changes selection, not stored facts: semantic merging of distinct facts or contradictions is not performed automatically.

Claude, Cursor, Grok and Gemini keep native turn payloads in per-session NDJSON files below `userdata/provider-history/<driver>/`. Sessions retain turn IDs, file names and byte boundaries; explicit native-history requests load the completed turns from disk. Active Claude messages are appended as they arrive. Turn rollback records the removed IDs in the index and keeps the original files. Repeated turn IDs after rollback get separate files. These files supplement the database and provider's own resume store; they are not automatically deleted on session close. Disk write/read errors surface as provider process errors. This is normal filesystem persistence, not an fsync durability guarantee.

OpenCode reads native history from its SDK and no longer keeps an unused duplicate of tool-part snapshots. Codex continues to read its native history on demand.

The provider command worker releases a key's queue and fiber after its last queued operation. ACP notification pumps belong to their session scopes so worker retirement cannot interrupt event delivery. Per-thread locks retain a key only while a holder or waiter exists. Preview tab generations are unique across recreation and are removed at close. Provider execution correlation retires on session exit; a 512-entry, five-minute cache and persisted bindings preserve late-event routing. Provider log sink metadata uses a 128-entry LRU cache; normal log retention can reclaim evicted thread files. These diagnostics remain subject to their existing log retention policy.

Failed provider sessions have a one-minute inactivity grace period, checked every minute. Active turns, pending approvals or user input, background liveness and executor-owned Orchestra sessions are excluded. Adapter activity and a fresh persisted-binding check protect errors whose projection is stale. Healthy idle sessions retain the existing 30-minute threshold and resume cursors. Knowledge reconciliation coalesces pending work by project and synchronizes the latest item state, including archived items.

The isolated 100-turn Claude probe retained about 1.1 MiB after GC, compared with about 50.7 MiB before this change, while all 100 original payloads remained readable. This measures retained adapter memory, not total application RAM or the transient allocation of an explicit full-history read. Development watchers, provider runtimes, MCP servers and slow-consumer event backlogs require separate attribution; the audit did not establish that every such allocation is a leak.

## Rollback

Stop only the recorded runtime, restore the saved source files and restart using the existing runtime launcher and original data home. The migration is additive; retaining the added derived tables preserves subsequent user work and originals. Do not copy an experimental database back over live state. A full pre-replacement database snapshot is recovery evidence, not an automatic rollback of conversations created afterward.
