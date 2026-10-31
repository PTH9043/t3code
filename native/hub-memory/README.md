# Windows hub memory guard

`vp run build:hub-memory` builds `target/<arch>/t3-hub-guard.exe` with Visual Studio C++ tools. The server build bundles it under `dist/hub-memory/win32-<arch>`; Windows desktop packaging also builds the requested target architecture and includes that server directory outside the ASAR archive.

The build entry point is `node native/hub-memory/build.mjs`. It initializes Visual Studio through `cmd.exe`, invokes `cl.exe` directly, checks the PE target architecture, and runs the native version check when the host architecture matches. Use `--architecture arm64` or `--output-directory <path>` to override the default x64 target and output. It does not invoke PowerShell.

The supervisor starts the precompiled guard directly. It reads `T3_HUB_GUARDED_COMMAND` and `T3_HUB_MEMORY_HARD_CAP_MB`, creates a suspended `cmd.exe`, assigns it to a kill-on-close Job Object with a per-process commit cap, and resumes it. Standard handles and the command's exit status are preserved. Missing binaries fail through the normal spawn-failure path; there is no uncapped fallback.

Run the focused `hubMemoryGuard.windows.test.ts` integration tests after building. They cover ConPTY output, quoted commands, exit code 75, commit enforcement and child cleanup. `bench/startup.mjs` compares the native executable with the previous PowerShell/C# implementation retained solely as a benchmark fixture. The benchmark uses ten measured, alternating trials after warmup and records raw samples under `target/`.
