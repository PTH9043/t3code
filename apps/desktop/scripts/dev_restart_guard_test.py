import importlib.util
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('dev_restart_guard', Path(__file__).with_name('dev-restart-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class AutomaticRestartGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='t3-restart-guard-')
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name) / 'state.sqlite'
        self.replacement_hold = Path(self.temp.name) / 'replacement-hold'
        with closing(sqlite3.connect(self.database)) as db:
            db.executescript('''
                CREATE TABLE projection_thread_sessions (thread_id TEXT, status TEXT, active_turn_id TEXT);
                CREATE TABLE projection_turns (thread_id TEXT, turn_id TEXT, state TEXT);
                CREATE TABLE projection_threads (thread_id TEXT, deleted_at TEXT);
                INSERT INTO projection_threads VALUES ('thread', NULL);
                CREATE TABLE projection_workspace_collaboration_runs (status TEXT);
                CREATE TABLE projection_workspace_program_runs (status TEXT);
                CREATE TABLE workspace_task_inbox (status TEXT);
            ''')

    def run_inspection(self, has_provider=False):
        with patch.object(guard, 'has_provider_process', return_value=has_provider):
            with patch.object(guard, 'REPLACEMENT_HOLD', self.replacement_hold):
                return guard.inspect(self.database, 123)

    def test_replacement_remains_held_until_isolated_validation_finishes(self):
        self.assertTrue((guard.REPLACEMENT_HOLD.parent.parent / 'scripts' / 'dev-runner.ts').is_file())
        self.replacement_hold.write_text('hold', encoding='utf-8')
        self.assertEqual(self.run_inspection(), {'safe': False, 'reason': 'validation-pending'})
        self.replacement_hold.unlink()
        self.assertEqual(self.run_inspection(), {'safe': True, 'reason': 'idle'})

    def test_idle_and_provider_process(self):
        self.assertEqual(self.run_inspection(), {'safe': True, 'reason': 'idle'})
        self.assertEqual(self.run_inspection(True), {'safe': False, 'reason': 'provider-running'})

    def test_active_sessions_and_workspace_work_delay_restart(self):
        for table, values in (
            ('projection_thread_sessions', "('thread', 'running', 'turn')"),
            ('projection_thread_sessions', "('thread', 'ready', 'turn')"),
            ('projection_turns', "('thread', 'turn', 'pending')"),
            ('projection_workspace_collaboration_runs', "('running')"),
            ('projection_workspace_program_runs', "('queued')"),
            ('workspace_task_inbox', "('verifying')"),
        ):
            with self.subTest(table=table, values=values):
                with closing(sqlite3.connect(self.database)) as db:
                    with db:
                        db.execute(f'INSERT INTO {table} VALUES {values}')
                self.assertEqual(self.run_inspection(), {'safe': False, 'reason': 'active-work'})
                with closing(sqlite3.connect(self.database)) as db:
                    with db:
                        db.execute(f'DELETE FROM {table}')

    def test_unreadable_state_fails_closed(self):
        self.database.unlink()
        self.assertEqual(self.run_inspection(), {'safe': False, 'reason': 'state-unavailable'})
        self.assertFalse(self.database.exists())

    def test_terminal_turn_does_not_leave_a_stale_session_blocking_restart(self):
        with closing(sqlite3.connect(self.database)) as db:
            with db:
                db.execute("INSERT INTO projection_thread_sessions VALUES ('thread', 'running', 'turn')")
                db.execute("INSERT INTO projection_turns VALUES ('thread', 'turn', 'interrupted')")
        self.assertEqual(self.run_inspection(), {'safe': True, 'reason': 'idle'})

    def test_deleted_thread_records_do_not_block_but_provider_process_still_does(self):
        with closing(sqlite3.connect(self.database)) as db:
            with db:
                db.execute("UPDATE projection_threads SET deleted_at='2026-09-08' WHERE thread_id='thread'")
                db.execute("INSERT INTO projection_thread_sessions VALUES ('thread', 'running', 'turn')")
                db.execute("INSERT INTO projection_turns VALUES ('thread', 'turn', 'pending')")
        self.assertEqual(self.run_inspection(), {'safe': True, 'reason': 'idle'})
        self.assertEqual(self.run_inspection(True), {'safe': False, 'reason': 'provider-running'})

    def test_unknown_thread_and_missing_projection_fail_closed(self):
        with closing(sqlite3.connect(self.database)) as db:
            with db:
                db.execute("INSERT INTO projection_turns VALUES ('unknown', 'turn', 'pending')")
        self.assertEqual(self.run_inspection(), {'safe': False, 'reason': 'active-work'})
        with closing(sqlite3.connect(self.database)) as db:
            with db:
                db.execute("DROP TABLE projection_threads")
        self.assertEqual(self.run_inspection(), {'safe': False, 'reason': 'state-unavailable'})


if __name__ == '__main__':
    unittest.main()
