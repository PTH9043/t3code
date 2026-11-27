# Windows AutoUsage upgrade room

From an integrated checkout with the official web + server CLI production bundle already built, run `python -I -B scripts/upgrade-room-runtime.py install`. Installation stages the packaged server, its installed production dependencies, and a private Node executable. It installs the current user's desktop shortcut. It does not start the room or open a browser. Normal main-server launches and upgrades do not install or replace the room.

Integrate these exact launcher files from the checkout:

- `scripts/upgrade-room-runtime.py`
- `scripts/upgrade-room-launch.vbs`
- `scripts/upgrade-room/windows_host.py`
- `scripts/upgrade-room/stage.mjs`
- `scripts/upgrade-room/open-room.html`
- `scripts/upgrade-room/open-room.js`

Build the integrated server and matching web assets with the repository's normal Windows packaging build before installing. The installer reads the CLI publisher's `apps/server/dist` layout, including all split chunks, `codex-watch-stdio.mjs`, and `client/index.html`. It uses the repository's pinned pnpm, lockfile, patches, and Windows script-free production-install helpers. The staging process copies Node from `%ProgramFiles%/nodejs/node.exe`, verifies the release has no filesystem links, and loads its CLI before atomically publishing the installation. Repeating `install` on an existing installation repairs the shortcut and reuses the installed release.

The installed entry point is `E:/NewAutoUsage/tools/upgrade-room/upgrade-room-runtime.py`. Its sibling `install.json` has a `python` field containing the absolute console Python executable. The independent T3 home is `E:/NewAutoUsage/upgrade-room`. Its project is `D:/__NewAutoUsage`. Server environment variables are `T3CODE_UPGRADE_PROJECT_ROOT` and `T3CODE_UPGRADE_PRIMARY_HOME`.

A cold request uses local WMI (`root/cimv2`, `Win32_Process.Create`) to launch the installed windowless Python broker as the calling user. The broker holds the startup lease, spawns the private server, and records its PID and creation time. This keeps both processes outside the primary desktop's descendant tree throughout startup. The same verified room is reused on subsequent requests. WMI launch failures are reported to the caller.

Running `install` from the integrated checkout updates a version 1 launcher to version 2 in place. Only the fixed launcher, its Windows helper, the VBS and the install record are replaced. The existing release, interpreter choice, and independent room data are retained.

To replace the package of an already initialized room, build the matching production bundles and stop only the independent server after confirming its executable, PID and creation time. Run `python -I -B scripts/upgrade-room-runtime.py replace-release` from the checkout. It stages and checks the new package on the install volume, takes the room's startup lease before publishing, and never replaces a running host. It does not stop or start processes or change room data, settings or the shortcut. It retains the previous package at `E:/NewAutoUsage/tools/upgrade-room/release.previous` and refuses to overwrite an existing rollback package. Run the installed `ensure` command and verify the served bundle. If startup fails, stop the new host, then move the failed `release` aside and move `release.previous` back to `release` before running `ensure` again.

Launch the installed Python directly with `-I -B`, the absolute installed script and exactly one verb. Use the installed directory as cwd and hide the console. Each command prints one JSON object. Operational failures exit nonzero with `{"ok":false,"error":"..."}`.

| Verb     | Result                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status` | Read-only. Returns `ok`, `status` (uninstalled, stopped, starting, or ready), and the fixed project and thread IDs. A ready result includes `origin`, `environmentId`, and `pid`.                                                                      |
| `ensure` | Starts or reuses the detached host. Returns ready status after verifying the listener, T3 identity, auth gate and reserved room.                                                                                                                       |
| `link`   | Ensures the host and returns ready status plus `url` containing a fresh one-time pairing credential in the fragment. Call only from the authenticated local administrative desktop open action. Pipe stdout privately. Never log or cache this result. |
| `open`   | For an explicit shortcut click. Opens the same URL with the Windows URL handler. Returns ready status without the URL.                                                                                                                                 |

The persistent IDs are `autousage-upgrade-project` and `autousage-upgrade-room`. The dedicated server bootstraps the project. The first explicit model choice creates the reserved thread. The launcher verifies the canonical project root and any existing thread in the independent read model. The entry URL is `http://127.0.0.1:<port>/open-room.html#token=<single-use credential>`. Its page establishes the normal T3 browser session then replaces the page with `/<environmentId>/autousage-upgrade-room`.
