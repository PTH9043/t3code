# Generated results in chat

Assistant output images and UTF-8 text files appear inline in the owning response. The implementation reuses durable message attachments, their event projection, asset signing and file lifetime rather than adding a parallel result database.

ChatAttachment.result contains kind, SHA-256 and optional source path, language and image dimensions. Persisted attachment sizes allow generated outputs up to the collector's 64MB limit. UploadChatAttachment still enforces the existing 10MB input limits. Assistant completion commands may carry attachments; existing thread.message-sent events and attachments_json preserve metadata on replay. Older attachments remain valid.

ProviderRuntimeIngestion collects declared local result links at assistant completion for every provider. It also recognizes native Codex imageGeneration (including savedPath) and image-generation MCP outputs from Codex and Claude. Image reads, browser screenshots and other tool images are not automatically published. Results without assistant text get a result-only assistant message. Stable per-thread/turn/content IDs reuse stored bytes; clients display a shared result once under its latest referring response. Blue file links resolve to that response’s stored snapshot even after the workspace original is removed.

The collector validates real workspace paths, reads completed files, checks UTF-8 or image signatures, and atomically snapshots original bytes under the existing attachments directory. Only explicit native image-generation paths may originate outside the workspace. No folder watcher or recursive scan is used. Image and generated file attachments participate in revert/deletion retention.

Attachment asset resources can request preview:true or downloadName. These options are signed separately from the ordinary original-file capability. Preview reads at most 64KiB and returns X-T3-Preview-Truncated and X-T3-Asset-Bytes; the client initially displays at most 20,000 characters. Full-copy and download use the original bytes, not the preview. Content stays out of WebSocket events and message state.

Web and desktop share ChatGeneratedResults. MarkdownResultImage resolves legacy local image Markdown through the owning environment's asset API. A result already rendered below an assistant response suppresses its duplicate image Markdown. Orchestra attempt views resolve their message attachments from the same timeline. Mobile uses GeneratedResult for inline images and selectable original text, full copy and download.

Remote assets resolve against the connected environment, with no baked localhost origin. Signed URLs are refreshed by the existing asset atoms. No output automatically opens a window, switches a panel or moves focus.

Known boundaries: external HTTP image URLs use ordinary Markdown rendering and are not snapshotted; arbitrary shell logs and unsupported binary documents are not expanded. Mobile text currently displays selectable source rather than the desktop Markdown reading layout. Native mobile rendering requires a separate device/emulator verification pass.
