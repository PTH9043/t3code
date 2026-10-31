"""Read-only check used before an automatic development restart."""
import json
import os
import sqlite3
import sys
from pathlib import Path

import psutil


REPLACEMENT_HOLD = Path(__file__).resolve().parents[3] / '.t3' / 'unified-work-replacement-hold'


PROVIDER_PROCESSES = {
    'codex', 'codex.exe', 'claude', 'claude.exe', 'opencode', 'opencode.exe',
    'grok', 'grok.exe', 'gemini', 'gemini.exe', 'cursor-agent', 'cursor-agent.exe',
    # Their descendants may run outside the Windows process tree.
    'wsl', 'wsl.exe', 'ssh', 'ssh.exe',
    # A terminal may contain user work even without an active agent turn.
    'cmd.exe', 'bash', 'bash.exe', 'sh', 'sh.exe', 'powershell.exe', 'pwsh.exe',
}


def has_active_database_work(database):
    if not database.is_file():
        raise RuntimeError('state-unavailable')
    connection = sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'projection_thread_sessions' not in tables or 'projection_threads' not in tables:
            raise RuntimeError('state-unavailable')
        if 'projection_turns' in tables:
            if connection.execute('''
                SELECT 1 FROM projection_turns AS turns
                LEFT JOIN projection_threads AS threads ON threads.thread_id = turns.thread_id
                WHERE turns.state IN ('pending', 'running')
                  AND (threads.thread_id IS NULL OR threads.deleted_at IS NULL)
                LIMIT 1
            ''').fetchone():
                return True
            if connection.execute('''
                SELECT 1 FROM projection_thread_sessions AS sessions
                LEFT JOIN projection_turns AS turns
                  ON turns.thread_id = sessions.thread_id AND turns.turn_id = sessions.active_turn_id
                LEFT JOIN projection_threads AS threads ON threads.thread_id = sessions.thread_id
                WHERE (sessions.status = 'running' OR sessions.active_turn_id IS NOT NULL)
                  AND (turns.state IS NULL OR turns.state NOT IN ('completed', 'error', 'interrupted'))
                  AND (threads.thread_id IS NULL OR threads.deleted_at IS NULL)
                LIMIT 1
            ''').fetchone():
                return True
        elif connection.execute('''
            SELECT 1 FROM projection_thread_sessions AS sessions
            LEFT JOIN projection_threads AS threads ON threads.thread_id = sessions.thread_id
            WHERE (sessions.status='running' OR sessions.active_turn_id IS NOT NULL)
              AND (threads.thread_id IS NULL OR threads.deleted_at IS NULL)
            LIMIT 1
        ''').fetchone():
            return True
        for table, statuses in (
            ('projection_workspace_collaboration_runs', ('queued', 'running', 'cancel-requested')),
            ('projection_workspace_program_runs', ('queued', 'running', 'cancel-requested')),
            ('workspace_task_inbox', ('queued', 'checking', 'dispatching', 'running', 'verifying', 'cancel-requested')),
        ):
            if table not in tables:
                continue
            placeholders = ','.join('?' for _ in statuses)
            if connection.execute(f'SELECT 1 FROM {table} WHERE status IN ({placeholders}) LIMIT 1', statuses).fetchone():
                return True
        return False
    finally:
        connection.close()


def has_provider_process(app_pid):
    parent = psutil.Process(app_pid)
    for child in parent.children(recursive=True):
        try:
            name = child.name().lower()
            if name in PROVIDER_PROCESSES:
                return True
            if name in ('node', 'node.exe', 'bun', 'bun.exe'):
                arguments = ' '.join(child.cmdline()).lower().replace('\\', '/')
                if any(marker in arguments for marker in ('/codex/', '/claude/', '/opencode/', '/grok/', '/gemini/')):
                    return True
        except psutil.NoSuchProcess:
            continue
    return False


def inspect(database, app_pid):
    try:
        if REPLACEMENT_HOLD.is_file():
            return {'safe': False, 'reason': 'validation-pending'}
        if has_active_database_work(database):
            return {'safe': False, 'reason': 'active-work'}
        if has_provider_process(app_pid):
            return {'safe': False, 'reason': 'provider-running'}
        return {'safe': True, 'reason': 'idle'}
    except (OSError, sqlite3.Error, psutil.Error, RuntimeError):
        return {'safe': False, 'reason': 'state-unavailable'}


if __name__ == '__main__':
    if len(sys.argv) != 3 or not sys.argv[2].isdigit():
        raise SystemExit(2)
    print(json.dumps(inspect(Path(os.path.abspath(sys.argv[1])), int(sys.argv[2]))))
