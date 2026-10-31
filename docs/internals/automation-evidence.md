# Automation evidence snapshots

`workspace_manage` actions `verify` and `integrate` accept optional `evidencePaths` (up to 8 relative files). Verification commands must produce these files inside the exact detached verification checkout. Supported extensions are PNG, JPG/JPEG, WebP, PDF, HTML/HTM and TXT. Files are limited to 4 MiB each and 16 MiB per execution.

`WorkspaceDevelopmentGit.verify` snapshots requested outputs after running the commands and before releasing the checkout. It records per-file media type, byte count, SHA-256 and the managed snapshot path. Missing, escaped, unsupported, mismatched, empty or oversized outputs retain an error entry and prevent verification from passing. Old persisted records decode without the optional `artifacts` field.

`workspaceAutomation.overview` exposes only record IDs and indexes; no file data is sent until an evidence item is opened. `workspaceAutomation.evidence` checks project ownership, canonical storage containment, size and the recorded hash. Binary content uses base64; UTF-8 text is redacted with the existing conversation redactor. Log behavior remains bounded to 64 KiB. Evidence query atoms have no idle retention.

Web/desktop render images and PDF from temporary Blob URLs and revoke them when closed. HTML is shown inside an opaque sandboxed iframe with a restrictive CSP. Mobile uses native images and a script-disabled WebView for HTML; PDF opens through the existing Expo file-sharing flow using a content-addressed file in the app cache so the receiving application can finish reading it. The RPC path supports local and remote environments without embedding server origins.
