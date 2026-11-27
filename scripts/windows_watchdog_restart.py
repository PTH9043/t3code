"""Keep detached T3 watchdog executions alive across a Windows runtime restart."""

import os
from pathlib import Path


def restart_descendants(parent, root, psutil):
    """Return the captured runtime descendants excluding watchdogs and their children.

    A watchdog is identified only by the exact entry point T3 spawns. If a
    process cannot be inspected, abort the restart before terminating anything.
    """
    root = Path(root)
    entries = {
        os.path.normcase(os.path.abspath(str(root / "apps/server/src/orchestration/watchdog-worker.ts"))),
        os.path.normcase(os.path.abspath(str(root / "apps/server/dist/watchdog-worker.mjs"))),
    }
    descendants = parent.children(recursive=True)
    by_pid = {}
    protected = set()
    for process in descendants:
        try:
            command = process.cmdline()
            parent_pid = process.ppid()
        except psutil.NoSuchProcess:
            continue
        except psutil.Error as error:
            raise RuntimeError("Cannot safely inspect the runtime process tree") from error
        by_pid[process.pid] = (process, parent_pid)
        if len(command) >= 2 and os.path.normcase(os.path.abspath(command[1])) in entries:
            protected.add(process.pid)
    changed = True
    while changed:
        changed = False
        for pid, (_, parent_pid) in by_pid.items():
            if pid not in protected and parent_pid in protected:
                protected.add(pid)
                changed = True
    return [process for pid, (process, _) in by_pid.items() if pid not in protected]
