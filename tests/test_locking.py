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

    def test_one_writer_and_release_keeps_the_same_inode(self):
        first = WorldWriteLock(self.world)
        first.acquire()
        identity = self.path.stat().st_ino
        try:
            with self.assertRaises(WorldWriteLocked):
                WorldWriteLock(self.world).acquire()
        finally:
            first.release()
        self.assertTrue(self.path.exists())
        second = WorldWriteLock(self.world)
        second.acquire()
        try:
            self.assertEqual(self.path.stat().st_ino, identity)
        finally:
            second.release()

    def test_stale_metadata_never_replaces_the_lock_inode(self):
        self.path.parent.mkdir()
        self.path.write_text(json.dumps({"pid": 999999999, "host": socket.gethostname()}))
        identity = self.path.stat().st_ino
        guard = WorldWriteLock(self.world)
        with guard:
            self.assertEqual(self.path.stat().st_ino, identity)
            self.assertEqual(self.path.stat().st_size, 0)
            with self.assertRaises(WorldWriteLocked):
                WorldWriteLock(self.world).acquire()

    def test_empty_and_foreign_leftovers_are_governed_by_the_kernel(self):
        self.path.parent.mkdir()
        for content in [b"", json.dumps({"pid": os.getpid(), "host": socket.gethostname()}).encode(), json.dumps({"pid": 999999999, "host": "some-other-host"}).encode()]:
            self.path.write_bytes(content)
            with WorldWriteLock(self.world):
                with self.assertRaises(WorldWriteLocked):
                    WorldWriteLock(self.world).acquire()

    def test_a_crashed_writer_releases_its_kernel_lock(self):
        code = f"import os,sys;sys.path.insert(0,{str(ROOT)!r});from pathlib import Path;from mwt.locking import WorldWriteLock;WorldWriteLock(Path({str(self.world)!r})).acquire();os._exit(0)"
        subprocess.run([sys.executable, "-c", code], check=True, timeout=30)
        self.assertTrue(self.path.exists())
        with WorldWriteLock(self.world) as replacement:
            owner = json.loads((self.path.parent / "write.owner.json").read_text())
            self.assertEqual(owner["token"], replacement.token)


if __name__ == "__main__":
    unittest.main()
