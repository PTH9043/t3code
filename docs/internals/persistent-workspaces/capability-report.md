# Persistent workspace capability report

Verified on Windows, 2026-09-30. This report separates documentation, installed contracts, and executed evidence.

## Installed baseline and scope

| Component        | Installed baseline         | Used by this implementation                                                           |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| Node             | 24.19.0                    | Existing T3 server, typed RPC and SQLite                                              |
| Git              | 2.55.0.windows.3           | Worktree creation, fixed candidate checkouts, ordinary checked-out branch merges      |
| Codex CLI        | 0.159.2                    | Existing Codex adapter and app-server protocol                                        |
| Claude Code CLI  | 2.1.285                    | Existing `claudeAgent` adapter                                                        |
| Claude Agent SDK | 0.3.251                    | Existing `query()` adapter; native transcript verification via `getSessionMessages()` |
| OpenCode CLI     | 1.18.33                    | Persistent Owners and compatible API profiles through the existing v1 adapter         |
| OpenCode SDK     | `@opencode-ai/sdk` 1.15.13 | Existing adapter dependency; its `/v2` export is not OpenCode 2                       |

The repository already wraps multiple provider runtimes. Codex, Claude and the installed OpenCode v1 adapter use the same persistent management core and conversation. Compatible API profiles reuse OpenCode's existing inference, tools and transcript storage. No separate Dots installation, inference engine or hidden replacement session is introduced.

The documented OpenCode 2 client is `@opencode/client`; its live subscriptions do not replay missed events or reconnect automatically. That contract is distinct from the locally installed v1 CLI and SDK. OpenCode 2 support remains disabled. [OpenCode client documentation](https://opencode.ai/v2/docs/build/client/).

## Adapter boundary

### Compatible API upgrade (2026-09-30)

OpenCode instances now accept a typed `apiConnection` definition in the existing settings contract. API address, actual model IDs, protocol and token limits stay separate from the sensitive account environment. Discovery, normal conversations, Main, persistent Owners and text generation receive the same official inline OpenCode configuration. Chat Completions uses `@ai-sdk/openai-compatible`; Responses uses `@ai-sdk/openai`. No API token is embedded in generated configuration or project definitions. Endpoint/protocol/storage changes alter continuation identity; key rotation does not.

The DeepSeek preset uses the current official IDs `deepseek-flash` and `deepseek-v4-pro`, rather than retired legacy aliases. The installed OpenCode v1.18.33 automatically applies DeepSeek interleaved reasoning handling to custom compatible models with DeepSeek IDs. This is reused from the harness. [DeepSeek changelog](https://api-docs.deepseek.com/updates/), [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/), [OpenCode v1 provider configuration](https://dev.opencode.ai/docs/providers/), [pinned provider implementation](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/provider/provider.ts).

Native smoke command:

```powershell
node scripts/workspace-development-api-demo.mjs .t3/workspace-development-20260930-v2 "C:/Users/박태현/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe"
```

Only HTTP model responses came from a local compatible fixture. T3 RPC/settings redaction, the installed OpenCode, native MCP/file/shell tools, linked Git worktrees, native transcript export, direct takeover, command deduplication and exact verification/integration were actually executed. The fixture requires `reasoning_content` on subsequent assistant messages and includes tool calls and session resume. No live DeepSeek billing account was used. Responses package selection is unit-tested; a paid Responses endpoint was not exercised.

Latest passing fixture: `.t3/workspace-development-20260930-v2/api-demo-QLBHUB/evidence.json`.

| Evidence                                   | Value                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Project                                    | `api-project-f02fc935-c5de-4f26-b706-db84ebce811e`                                                   |
| Owner native ID, before/after direct input | `ses_f0e610b1cffeyiwjZxm00LwmmC`                                                                     |
| Native message IDs                         | `msg_0f19ef4fc0008a87fa6faaa248`, `msg_0f19f18f90003a9ad6f0128b43`, `msg_0f19f37c600021be74e8d2f14a` |
| Managed tasks / requirement revision       | 2 / 2; duplicate direct command created no additional task                                           |
| Exact candidate                            | `8689f8df3b6221c875f2f497d8037ff00b24a197`                                                           |
| Expected target                            | `598b47f84b76eea81b79f5baa0e064d9e773f48a`                                                           |
| Result                                     | `ca2dde89369eac3e36b9d72268d95244251172c3`                                                           |
| Real verification                          | `node --test`, exit 0, 1 passed, 0 skipped; final exported value is 30                               |

The earlier passing fixture `api-demo-Mllm5s` survived a real backend reload: authenticated `workspaceDevelopment.get` returned the same Owner `ses_f0e657bf9ffeUcVv6pnLcvHUAL`, both completed tasks and integration `3c8b1db7152089e2628be47d69a52e64d0439eb2`. This proves recovery of completed records; ambiguous in-flight delivery still uses the existing `delivery_unknown` barrier.

Focused validation: 86 server tests and 37 web tests passed. Server and web typechecks passed. The second-question regression covers single and multiple selection with no timers; the API form regression saves preset, model IDs and a sensitive key atomically. Web/desktop share the settings and chat implementation. Mobile already requires explicit answer submission; API setup and direct Owner selection controls remain web/desktop only. Native external UI input hooks, OpenCode 2, arbitrary non-compatible protocols and autonomous model routing remain unsupported.

`ProviderService` routes to the installed `ProviderAdapter` by instance ID and continuation identity. `WorkspaceAgentExecutor` accepts a stable `persistentSessionKey`, independent run ID and increasing execution attempt. Only adapters use native execution APIs. Owners are ordinary Codex/Claude sessions, with no native parent/subagent relationship to Main.

| Requested capability                                | Documentation / installed contract                                         | Executed result                                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create in specified cwd and resume the same session | Codex thread start/resume; Claude `query({options:{cwd,resume}})`          | Both passed in linked worktrees under Korean paths containing spaces                                                                               |
| Empty session resume                                | Native IDs may appear before a durable first conversation exists           | Both failed after stop with no first input. Provisioning now completes one visible onboarding turn before activation                               |
| Input acceptance versus completion                  | Provider receipt, canonical start/completion events                        | Separate delivery and task state, native turn/message refs, verified candidate SHA                                                                 |
| Shared conversation                                 | T3 execution events can be projected to their owning thread                | Main requests and five Owner responses are in one T3 thread; native inputs were independently read and matched                                     |
| User direct participation                           | Authenticated RPC feeds the same execution queue and binding               | Both providers resumed their actual Owner; Codex requirement changed 99→30; duplicate command produced one task                                    |
| Queue / interrupt / steering                        | Existing adapters support interruption and provider-specific steering      | Management serializes followups. Replace/takeover waits for interrupt and executor cleanup; in-flight native steering is not exposed by this panel |
| Model / variant                                     | Installed catalogs and existing per-provider option application            | Codex `gpt-6.1-sol` low and Claude `claude-sonnet-4-6` low used. Actual cwd/provider/model checked; independent variant attestation is unavailable |
| Namespace identity                                  | Provider instance plus continuation identity and cwd                       | Stored and checked before reuse. A changed configured runtime is rejected                                                                          |
| Idempotent delivery                                 | No verified universal native command-id idempotency                        | SQLite command/outbox dedup; ambiguous delivery becomes `delivery_unknown`, with no automatic retry                                                |
| Native history read                                 | Codex `thread/read` without resume; Claude `getSessionMessages`            | Original input IDs, command IDs and native session identity verified using official interfaces                                                     |
| Events / reconnect                                  | Provider event streams are live; T3 state and runtime bindings are durable | Completed work and bindings survived backend reload. Unfinished accepted work is blocked as unknown rather than replayed                           |
| Unmanaged native UI/CLI                             | No verified pre-input hook across independent processes                    | Unsupported concurrent writing. No claim of preventing an external process's race                                                                  |
| Native message mutation detection                   | Requires durable history comparison beyond last ID                         | Full native message edit/delete/rollback reconciliation is not implemented                                                                         |
| Git external edits                                  | Git HEAD, index/working diff and untracked bytes                           | Freshness barrier blocks automatic dispatch/integration until Main reconciles                                                                      |

The Codex app-server supports reading history without loading or resuming a writer. Claude exposes session resume and history APIs. [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude sessions](https://code.claude.com/docs/en/agent-sdk/sessions).

## Verification evidence

Isolated home: `D:/__NewAutoUsage/.t3/workspace-development-20260930-v2`. Integration repository: `<home>/한글 프로젝트 repo`. SQLite, log files and artifacts belong to this fixture, not the user's live data.

| Identity                            | Value                                      |
| ----------------------------------- | ------------------------------------------ |
| Main T3 thread                      | `persistent-development-main`              |
| Main Codex native thread            | `01a0f0da-297e-7203-8ebf-35c3817d9196`     |
| Inventory workspace                 | `3519c371-73c0-49b6-8b22-734de319b5c3`     |
| Inventory Owner native thread       | `01a0f0e3-b7ac-75f2-b981-2ece261ea9e9`     |
| Combat workspace                    | `9956914a-b9e9-4337-9107-a38908c69ee8`     |
| Combat Owner native session         | `637d33b1-be5d-49e9-8d3b-9dc76a0953ed`     |
| Inventory candidate, requirement r2 | `54ea616715b424c2d963dec8b2dda6cc6c555188` |
| Combat candidate, requirement r1    | `6730f448a9cbef1de4203c2c94d31ad7032c2c97` |
| Expected integration target         | `2aedc5f91f71e6c5a90374235ae18cd9ab236e02` |
| Verified local integration result   | `b8ed7185fd24b1b3b07c0828b74492d3d4a282c2` |

Native Codex input references: Main dispatch `01a0f0e4-74e4-7cb1-a6b3-3881911ea07f`; direct requirement change `01a0f0e5-89fd-7c33-b6e7-2dc111cf90a5`. Native Claude references: Main dispatch `b46a7127-a202-453e-8a69-1de84a066516`; post-restart direct followup `088910e8-dd83-433f-ab8c-affe7f4c9753`. No private reasoning is included in these artifacts.

A second Claude followup retained the same session and returned native input UUID `cfd622c0-77cd-4c96-a806-6ccaf8c09ed0`, matching the task's persisted receipt. The final-code Main recheck produced integration `1cf7351d-90b0-4206-bfd6-d0c30ff93c09`, verified both candidates against the already-integrated target `b8ed7185fd24b1b3b07c0828b74492d3d4a282c2`, and passed both tests again. This recheck preserved the same result SHA; the first integration above proves the actual code combination.

`node --test` passed in each detached candidate checkout, combined checkout, and promoted integration checkout. Combined verification had **2 passing tests, 0 skipped tests**. The standalone candidate suite intentionally skips the unrelated absent module; that limitation is explicit in the fixture. The integration log is `<home>/userdata/workspace-development/logs/769a2ddf-9988-43e0-9230-09ef7e316349-0.log`.

Commands from repository root:

```powershell
node scripts/dev-runner.ts dev --home-dir D:/__NewAutoUsage/.t3/workspace-development-20260930-v2
node scripts/workspace-development-demo.mjs D:/__NewAutoUsage/.t3/workspace-development-20260930-v2 create
node scripts/workspace-development-demo.mjs D:/__NewAutoUsage/.t3/workspace-development-20260930-v2 direct
node scripts/workspace-development-demo.mjs D:/__NewAutoUsage/.t3/workspace-development-20260930-v2 integrate
# Restart the same isolated backend, then:
node scripts/workspace-development-demo.mjs D:/__NewAutoUsage/.t3/workspace-development-20260930-v2 followup
node scripts/workspace-development-evidence.mjs D:/__NewAutoUsage/.t3/workspace-development-20260930-v2
```

`create` on a completed fixture is deliberately not a way to recreate Owners; use a new isolated home to reproduce from scratch. The evidence reader uses `thread/read`, never a second resume or turn.

## Focused implementation checks

**132 focused tests passed:** 104 server tests, 18 web component/timeline tests, and 10 contract tests. These are separate from the real-provider demo above. The final Git fixture also passed after correcting its test-layer dependency composition.

From `apps/server`:

```powershell
node ../../node_modules/vite-plus/bin/vp test run src/orchestration/WorkspaceDevelopment.test.ts src/orchestration/WorkspaceDevelopmentGit.test.ts src/orchestration/workspaceDevelopmentPolicy.test.ts src/persistence/WorkspaceDevelopmentStore.test.ts src/orchestration/Layers/WorkspaceAgentExecutor.test.ts src/mcp/McpSessionRegistry.test.ts src/provider/Layers/ClaudeAdapter.test.ts
```

From `apps/web`:

```powershell
node ../../node_modules/vite-plus/bin/vp test run --project unit src/components/chat/WorkspaceDevelopmentPanel.test.tsx src/components/chat/MessagesTimeline.test.tsx
```

From `packages/contracts`:

```powershell
node ../../node_modules/vite-plus/bin/vp test run src/providerRuntime.test.ts
```

Type checks passed for `apps/server`, `apps/web`, `packages/contracts`, and `packages/client-runtime`, using `node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p <scope>/tsconfig.json` from the repository root. New feature files passed scoped lint and formatting. No repository-wide test/check command or browser/desktop GUI session was run.

## Acceptance coverage and remaining limits

| Scenario                                              | Evidence                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two domains, real worktrees and ordinary sessions     | Real Git and both native providers                                                                                                                        |
| Followup reuses native session                        | Codex direct change and Claude after restart                                                                                                              |
| Same conversation and original IDs                    | Native API evidence plus SQLite projected messages                                                                                                        |
| Direct requirement revision and duplicate suppression | Real Codex + SQLite; r1→r2 and one duplicate command                                                                                                      |
| Direct versus Main dispatch race                      | Focused core test, receipt gate; not yet a native stress test                                                                                             |
| Unmanaged external input                              | Git change barrier tested; external native transcript monitoring unsupported                                                                              |
| Lost receipt / retransmission                         | Core failure injection; unknown delivery blocked, no replay                                                                                               |
| Restart recovery                                      | Real completed session reload + Claude resume; unfinished-run recovery test                                                                               |
| A review followed by B                                | Core policy/integration test plus real fixed-checkout Git test                                                                                            |
| Target changes during verification                    | Core test, no promotion of stale result                                                                                                                   |
| Reviewer concurrent editing                           | Fixed detached verification checkout; persistent Reviewer unsupported                                                                                     |
| Dirty topology failure                                | Real dirty verification checkout preserved; failed provisioning reused original workspace/worktree; split/retire unsupported                              |
| Disallowed model / role / permission                  | Allowed index and authenticated Main boundary tests. Native shell/filesystem are not a complete workspace security sandbox                                |
| Korean and spaces; Windows/Linux                      | Real Windows test; Linux execution not performed                                                                                                          |
| Unapproved external release                           | Manager exposes local integration only; no release method. Unrestricted native shell can bypass this manager and is not a deployment enforcement boundary |

No automatic topology split/organization merge/retirement, cross-provider conversation conversion, autonomous subagent routing, total native-subagent budget enforcement, port/test-database isolation, or automatic promotion of unknown runs is claimed. Architect currently provides a persistent planning session, with executable creation delegated back to authenticated Main. The panel supports web and Electron's shared web surface. Mobile can read the conversation and use Main, but has no direct Owner picker yet. Cursor, Grok and OpenCode are rejected for this feature. Browser/desktop GUI validation has not been performed; automated component tests passed.

Git worktrees share repository references and are not a filesystem sandbox. `git worktree lock` is not used as an editing mutex. [Git worktree documentation](https://git-scm.com/docs/git-worktree).

## Goal-based continuation follow-up

The existing chat now accepts a development objective and acceptance criteria, and exposes start/pause/resume/cancel with bounded progress. No external dots installation or connection is required. The manager's existing authenticated Main queue owns continuation; Codex native Goals is not also enabled.

Actual Codex Main → persistent Codex/Claude Owners → automatic second Main turn → fixed candidate verification/integration passed for goal `f19360ef-8ba5-4ec3-8c58-2632dd78e704`. Exact new integration: `ad6e525e-832a-4c9c-be58-e7837947b3c4`; target `b8ed7185fd24b1b3b07c0828b74492d3d4a282c2`; result `a06c5d5acfb759853b31658a9ea6ca9f0959e094`. The same native sessions and completed goal survived an actual isolated-server restart. See [goal design and native evidence](development-goals.md).

Limits are automatic Main steps and active time, not strict token/cost caps or immediate interruption. Mobile goal controls and a measured Claude Main goal scenario are not claimed. The browser surface was unavailable in this session; component and native backend evidence are reported separately.

Goal changes passed 31 focused server tests and 6 rendered web component tests; the four changed TypeScript scopes passed type checks and goal files passed scoped lint. Actual promoted-repository `node --test` passed 5 tests without skips. No repository-wide suite was run.
