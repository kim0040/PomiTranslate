"""World write lock and Minecraft session lock: OS-held, crash-proof, never stolen from a live owner."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mwt.locking import (  # noqa: E402
    MinecraftSessionLocks,
    MinecraftWorldInUse,
    WorldWriteLock,
    WorldWriteLocked,
    hold_world,
    pid_is_alive,
    world_is_in_use,
)

HOLDER = """
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from mwt.locking import {cls}
guard = {cls}(Path(sys.argv[2]))
guard.acquire()
print("held", flush=True)
time.sleep(120)
"""
PROBE = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from mwt.locking import MinecraftSessionLocks, MinecraftWorldInUse, WorldWriteLock, WorldWriteLocked
kind, world = sys.argv[2], Path(sys.argv[3])
guard = WorldWriteLock(world) if kind == "write" else MinecraftSessionLocks(world)
try:
    guard.acquire()
except (WorldWriteLocked, MinecraftWorldInUse):
    print("BLOCKED")
else:
    print("ACQUIRED")
    guard.release()
"""


def start_holder(world: Path, cls: str = "WorldWriteLock") -> subprocess.Popen:
    process = subprocess.Popen(
        [sys.executable, "-B", "-c", HOLDER.format(cls=cls), str(ROOT), str(world)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    assert process.stdout is not None
    line = process.stdout.readline().strip()
    assert line == "held", (line, process.stderr.read() if process.poll() is not None else "")
    return process


def probe(kind: str, world: Path) -> str:
    done = subprocess.run(
        [sys.executable, "-B", "-c", PROBE, str(ROOT), kind, str(world)],
        capture_output=True, text=True, timeout=60,
    )
    assert done.returncode == 0, done.stderr
    return done.stdout.strip()


def dead_pid() -> int:
    process = subprocess.Popen([sys.executable, "-B", "-c", "pass"])
    process.wait()
    return process.pid


def legacy_lock(world: Path, **fields) -> Path:
    """The file an O_EXCL-era release left behind."""
    path = world / ".pomi-translate" / "write.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {"version": 1, "pid": os.getpid(), "host": socket.gethostname(), "createdAt": time.time(),
                "token": "legacy", **fields}
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def test_two_processes_contend(tmp: Path) -> None:
    world = tmp / "contend"
    world.mkdir()
    lock = WorldWriteLock(world)
    lock.acquire()
    try:
        assert probe("write", world) == "BLOCKED"
        # The lock is stable: it exists, is empty, and metadata lives beside it.
        assert lock.path.is_file() and lock.path.stat().st_size == 0
        owner = json.loads((lock.path.parent / "write.owner.json").read_text(encoding="utf-8"))
        assert owner["pid"] == os.getpid() and owner["purpose"] == "translate"
    finally:
        lock.release()
    assert probe("write", world) == "ACQUIRED"
    assert lock.path.is_file()  # never unlinked
    assert not (lock.path.parent / "write.owner.json").exists()


def test_killed_holder_frees_the_world_at_once(tmp: Path) -> None:
    world = tmp / "killed"
    world.mkdir()
    holder = start_holder(world)
    try:
        assert probe("write", world) == "BLOCKED"
        holder.kill()  # TerminateProcess on Windows, SIGKILL elsewhere: no cleanup code runs
        holder.wait(timeout=30)
    finally:
        if holder.poll() is None:
            holder.kill()
    second = WorldWriteLock(world)
    second.acquire()  # a stale owner note and lock file must not matter
    assert second.acquired
    second.release()


def test_killed_session_holder_frees_the_world(tmp: Path) -> None:
    world = tmp / "session-killed"
    world.mkdir()
    (world / "level.dat").write_bytes(b"\x1f\x8b")
    (world / "session.lock").write_bytes(b"\x00" * 8)
    holder = start_holder(world, "MinecraftSessionLocks")
    try:
        assert probe("session", world) == "BLOCKED"
        assert world_is_in_use(world) is True
        holder.kill()
        holder.wait(timeout=30)
    finally:
        if holder.poll() is None:
            holder.kill()
    assert world_is_in_use(world) is False


def test_leftover_files_never_block(tmp: Path) -> None:
    gone = dead_pid()
    # An old-style file whose owner died.
    world = tmp / "legacy-dead"
    world.mkdir()
    legacy_lock(world, pid=gone)
    lock = WorldWriteLock(world)
    lock.acquire()
    assert lock.path.stat().st_size == 0  # the stale body is cleared
    lock.release()
    # Written on another host.
    world = tmp / "legacy-other-host"
    world.mkdir()
    legacy_lock(world, host="some-other-machine")
    lock = WorldWriteLock(world)
    lock.acquire()
    lock.release()
    # A truncated file from a crash in the middle of the old write (CORE-05).
    world = tmp / "legacy-truncated"
    world.mkdir()
    path = world / ".pomi-translate" / "write.lock"
    path.parent.mkdir()
    path.write_bytes(b'{"version": 1, "pi')
    lock = WorldWriteLock(world)
    lock.acquire()
    lock.release()
    # An empty file.
    world = tmp / "legacy-empty"
    world.mkdir()
    path = world / ".pomi-translate" / "write.lock"
    path.parent.mkdir()
    path.write_bytes(b"")
    lock = WorldWriteLock(world)
    lock.acquire()
    lock.release()
    # The recorded process id is ours but nothing in this process holds the lock: a reused id.
    world = tmp / "legacy-own-pid"
    world.mkdir()
    legacy_lock(world)
    lock = WorldWriteLock(world)
    lock.acquire()
    lock.release()


def test_live_old_owner_keeps_the_world(tmp: Path) -> None:
    world = tmp / "legacy-alive"
    world.mkdir()
    sleeper = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(120)"])
    try:
        legacy_lock(world, pid=sleeper.pid)
        lock = WorldWriteLock(world)
        try:
            lock.acquire()
            raise AssertionError("an earlier release that still looks alive must keep the world")
        except WorldWriteLocked as exc:
            assert "earlier PomiTranslate version" in str(exc)
        assert not lock.acquired
        assert sleeper.poll() is None
    finally:
        sleeper.kill()
        sleeper.wait()
    # Its file is still there; once the owner is gone the world is free again.
    lock = WorldWriteLock(world)
    lock.acquire()
    lock.release()


def test_liveness_probe_never_kills(tmp: Path) -> None:
    sleeper = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(120)"])
    try:
        for _ in range(5):
            assert pid_is_alive(sleeper.pid) is True
        time.sleep(0.2)
        assert sleeper.poll() is None, "probing a process must not terminate it"
    finally:
        sleeper.kill()
        sleeper.wait()
    assert pid_is_alive(sleeper.pid) is False
    assert pid_is_alive(dead_pid()) is False
    assert pid_is_alive(os.getpid()) is True
    assert pid_is_alive(0) is False and pid_is_alive(-4) is False


def test_same_process_double_acquire_fails(tmp: Path) -> None:
    world = tmp / "double"
    world.mkdir()
    first = WorldWriteLock(world)
    first.acquire()
    try:
        for contender in (WorldWriteLock(world), WorldWriteLock(world / "." / "..", "x") if False else WorldWriteLock(Path(os.path.normcase(str(world))))):
            try:
                contender.acquire()
                raise AssertionError("a second holder in the same process acquired the lock")
            except WorldWriteLocked:
                assert not contender.acquired
        try:
            first.acquire()
            raise AssertionError("re-acquiring a held lock must fail")
        except WorldWriteLocked:
            pass
        assert first.acquired  # the failed attempts did not disturb the holder
        assert probe("write", world) == "BLOCKED"
    finally:
        first.release()
    again = WorldWriteLock(world)
    again.acquire()
    again.release()


def test_release_and_reacquire(tmp: Path) -> None:
    world = tmp / "cycle"
    world.mkdir()
    for _ in range(3):
        lock = WorldWriteLock(world)
        lock.acquire()
        lock.release()
        lock.release()  # releasing twice is harmless
    with WorldWriteLock(world) as held:
        assert held.acquired
    assert probe("write", world) == "ACQUIRED"


def test_lock_survives_unrelated_file_io(tmp: Path) -> None:
    world = tmp / "io"
    (world / "region").mkdir(parents=True)
    (world / "level.dat").write_bytes(b"\x1f\x8b")
    (world / "session.lock").write_bytes(b"\x00" * 8)
    (world / "region" / "r.0.0.mca").write_bytes(b"\x00" * 8192)
    lock = WorldWriteLock(world)
    session = MinecraftSessionLocks(world)
    lock.acquire()
    session.acquire()
    try:
        for name in ("level.dat", "region/r.0.0.mca"):
            with (world / name).open("rb") as handle:
                handle.read(16)
        (world / "region" / "r.0.0.mca").write_bytes(b"\x01" * 8192)
        # Asking whether the world is in use must not drop the locks this process holds.
        assert world_is_in_use(world) is True
        assert world_is_in_use(world) is True
        # Neither may a rival session guard in this process, whose release would close the file.
        rival = MinecraftSessionLocks(world)
        try:
            rival.acquire()
            raise AssertionError("a rival session guard in this process acquired")
        except MinecraftWorldInUse:
            pass
        assert probe("write", world) == "BLOCKED"
        assert probe("session", world) == "BLOCKED"
    finally:
        session.release()
        lock.release()
    assert world_is_in_use(world) is False
    assert probe("session", world) == "ACQUIRED"


def test_failed_acquire_does_not_need_metadata(tmp: Path) -> None:
    world = tmp / "no-metadata"
    world.mkdir()
    holder = WorldWriteLock(world)
    holder.acquire()
    try:
        owner = holder.path.parent / "write.owner.json"
        owner.unlink()
        owner.mkdir()  # unreadable as a file
        try:
            WorldWriteLock(world).acquire()
            raise AssertionError("acquired a held world")
        except WorldWriteLocked:
            pass
        owner.rmdir()
        owner.write_bytes(b"\xff\xfe not json")
        try:
            WorldWriteLock(world).acquire()
            raise AssertionError("acquired a held world")
        except WorldWriteLocked:
            pass
    finally:
        holder.release()
        for leftover in (holder.path.parent / "write.owner.json",):
            if leftover.is_dir():
                leftover.rmdir()
            else:
                leftover.unlink(missing_ok=True)


def test_hold_world_releases_everything(tmp: Path) -> None:
    world = tmp / "hold"
    world.mkdir()
    (world / "level.dat").write_bytes(b"\x1f\x8b")
    (world / "session.lock").write_bytes(b"\x00" * 8)
    with hold_world(world, "restore"):
        assert probe("write", world) == "BLOCKED"
        assert probe("session", world) == "BLOCKED"
    assert probe("write", world) == "ACQUIRED"
    assert probe("session", world) == "ACQUIRED"
    try:
        with hold_world(world, "restore"):
            raise RuntimeError("body failed")
    except RuntimeError:
        pass
    assert probe("write", world) == "ACQUIRED"
    # The session lock is busy: the write lock taken first must be given back.
    holder = start_holder(world, "MinecraftSessionLocks")
    try:
        try:
            with hold_world(world, "restore"):
                raise AssertionError("entered a world the game holds")
        except MinecraftWorldInUse:
            pass
        assert probe("write", world) == "ACQUIRED"
    finally:
        holder.kill()
        holder.wait()


def main() -> None:
    with tempfile.TemporaryDirectory() as temp:
        tmp = Path(temp)
        tests = [
            test_two_processes_contend,
            test_killed_holder_frees_the_world_at_once,
            test_killed_session_holder_frees_the_world,
            test_leftover_files_never_block,
            test_live_old_owner_keeps_the_world,
            test_liveness_probe_never_kills,
            test_same_process_double_acquire_fails,
            test_release_and_reacquire,
            test_lock_survives_unrelated_file_io,
            test_failed_acquire_does_not_need_metadata,
            test_hold_world_releases_everything,
        ]
        for test in tests:
            test(tmp)
            print("PASS", test.__name__)
    print("WORLD_LOCKING_PASSED")


if __name__ == "__main__":
    main()
