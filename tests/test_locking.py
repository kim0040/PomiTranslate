"""Minecraft's session lock is seen on every POSIX system, and one PomiTranslate writer per world.

Java's FileChannel.tryLock takes a POSIX record lock (fcntl). On Linux an flock never sees it, so
a running game or server looked idle there. The world write lock's stale-lock takeover used to
read the owner and then delete the file, so two newcomers could both take over.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import mwt.locking as locking  # noqa: E402
from mwt.locking import MinecraftSessionLocks, MinecraftWorldInUse, WorldWriteLock, WorldWriteLocked, world_is_in_use  # noqa: E402

POSIX = os.name != "nt"


def hold(path: Path, kind: str) -> subprocess.Popen:
    """A separate process that holds ``path`` the way Minecraft (lockf) or older tools (flock) do."""
    code = textwrap.dedent(f"""
        import fcntl, sys
        handle = open({str(path)!r}, "r+b")
        if {kind!r} == "lockf":
            fcntl.lockf(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        print("held", flush=True)
        sys.stdin.read()
    """)
    process = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    assert process.stdout.readline().strip() == "held"
    return process


def stop(process: subprocess.Popen) -> None:
    process.stdin.close()
    process.wait(timeout=10)
    process.stdout.close()


def other_process_can_lockf(path: Path) -> bool:
    code = textwrap.dedent(f"""
        import fcntl
        handle = open({str(path)!r}, "r+b")
        try:
            fcntl.lockf(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            print("free")
        except OSError:
            print("busy")
    """)
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=20)
    return out.stdout.strip() == "free"


def make_world(root: Path) -> Path:
    world = root / "world"
    world.mkdir()
    (world / "level.dat").write_bytes(b"\x1f\x8b")
    (world / "session.lock").write_bytes("☃".encode("utf-8"))
    return world


@unittest.skipUnless(POSIX, "POSIX record locks")
class SessionLockTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pomi-locks-")
        self.addCleanup(self.temporary.cleanup)
        self.world = make_world(Path(self.temporary.name))
        self.session = self.world / "session.lock"

    def test_record_lock_of_another_process_means_in_use(self):
        process = hold(self.session, "lockf")
        try:
            self.assertTrue(world_is_in_use(self.world))
            with self.assertRaises(MinecraftWorldInUse):
                MinecraftSessionLocks(self.world).acquire()
        finally:
            stop(process)
        self.assertFalse(world_is_in_use(self.world))

    def test_flock_of_another_process_means_in_use(self):
        process = hold(self.session, "flock")
        try:
            self.assertTrue(world_is_in_use(self.world))
        finally:
            stop(process)
        self.assertFalse(world_is_in_use(self.world))

    def test_held_lock_blocks_others_and_survives_a_second_attempt_in_this_process(self):
        guard = MinecraftSessionLocks(self.world)
        guard.acquire()
        try:
            self.assertFalse(other_process_can_lockf(self.session), "Minecraft must see the world as in use")
            with self.assertRaises(MinecraftWorldInUse):
                MinecraftSessionLocks(self.world).acquire()
            self.assertTrue(world_is_in_use(self.world))
            # Closing a second descriptor would have dropped the POSIX lock held through the first.
            self.assertFalse(other_process_can_lockf(self.session), "a failed second attempt dropped the lock")
        finally:
            guard.release()
        self.assertTrue(other_process_can_lockf(self.session))
        guard.acquire()
        guard.release()

    def test_translation_run_reports_locked_while_minecraft_holds_the_world(self):
        import mc_world_translator as core

        process = hold(self.session, "lockf")
        try:
            config = core.merge_nested(core.DEFAULT_CONFIG, {
                "world_dir": str(self.world), "dry_run": False, "inherit_translate_py": False,
                "report_path": str(Path(self.temporary.name) / "report.json"),
                "api": {"provider": "openai", "api_key": "k", "model": "m"},
                "runtime": {"checkpoint_enabled": False},
            })
            report = core.WorldTranslator(config).run()
        finally:
            stop(process)
        self.assertEqual(report["status"], "locked")
        self.assertEqual(report["errors"][-1]["scope"], "minecraft_session")


class WorldWriteLockTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pomi-write-lock-")
        self.addCleanup(self.temporary.cleanup)
        self.world = Path(self.temporary.name) / "world"
        self.world.mkdir()
        self.path = self.world / ".pomi-translate" / "write.lock"

    def write_owner(self, pid: int, *, version: int | None = None, host: str | None = None) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        document = {"pid": pid, "host": host or socket.gethostname(), "createdAt": time.time(), "token": "legacy"}
        if version is not None:
            document["version"] = version
        self.path.write_text(json.dumps(document), encoding="utf-8")

    def test_one_writer_and_release_removes_the_file(self):
        first = WorldWriteLock(self.world)
        first.acquire()
        with self.assertRaises(WorldWriteLocked):
            WorldWriteLock(self.world).acquire()
        first.release()
        self.assertFalse(self.path.exists())
        second = WorldWriteLock(self.world)
        second.acquire()
        second.release()

    def test_two_newcomers_cannot_both_take_over_a_stale_lock(self):
        self.write_owner(999_999_999)  # an older release's lock whose process is gone
        first, second = WorldWriteLock(self.world), WorldWriteLock(self.world)
        outcomes: list[str] = []
        real = locking._pid_is_alive

        def racing(pid: int) -> bool:
            # While the first newcomer decides the file is stale, the second one tries as well.
            if not outcomes:
                try:
                    second.acquire()
                    outcomes.append("second acquired")
                except WorldWriteLocked:
                    outcomes.append("second refused")
            return real(pid)

        with patch.object(locking, "_pid_is_alive", side_effect=racing):
            first.acquire()
        try:
            self.assertEqual(outcomes, ["second refused"])
            self.assertTrue(first.acquired)
            self.assertFalse(second.acquired)
            self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["token"], first.token)
        finally:
            first.release()
        self.assertFalse(self.path.exists())

    def test_a_live_older_release_still_counts(self):
        self.write_owner(os.getpid())
        with self.assertRaises(WorldWriteLocked):
            WorldWriteLock(self.world).acquire()
        self.assertTrue(self.path.exists())

    def test_another_computer_still_counts(self):
        self.write_owner(999_999_999, version=2, host="some-other-computer.invalid")
        with self.assertRaises(WorldWriteLocked):
            WorldWriteLock(self.world).acquire()

    def test_a_crashed_writer_is_replaced(self):
        code = textwrap.dedent(f"""
            import os, sys
            sys.path.insert(0, {str(ROOT)!r})
            from pathlib import Path
            from mwt.locking import WorldWriteLock
            WorldWriteLock(Path({str(self.world)!r})).acquire()
            os._exit(0)  # no release: the process ends with the lock file still there
        """)
        subprocess.run([sys.executable, "-c", code], check=True, timeout=30)
        self.assertTrue(self.path.exists())
        replacement = WorldWriteLock(self.world)
        replacement.acquire()
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["token"], replacement.token)
        replacement.release()

    def test_a_just_created_empty_lock_file_is_not_taken_over(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_bytes(b"")
        with self.assertRaises(WorldWriteLocked):
            WorldWriteLock(self.world).acquire()
        old = time.time() - 60
        os.utime(self.path, (old, old))
        late = WorldWriteLock(self.world)
        late.acquire()
        late.release()


if __name__ == "__main__":
    unittest.main()
