"""Durable write primitives: fsync on writable handles only, tmp cleanup on every failure, honest dir flush."""
from __future__ import annotations

import errno
import os
import stat
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import mwt.durable as durable  # noqa: E402
from mwt.safety import BackupSet  # noqa: E402


def leftovers(folder: Path) -> list[str]:
    return sorted(path.name for path in folder.iterdir() if path.name.endswith(".tmp") or path.name.startswith("tmp"))


class FsyncWatcher:
    """Records every fsync and what the descriptor could do: a read-only one fails on Windows."""

    def __init__(self) -> None:
        self.real = os.fsync
        self.read_only: list[int] = []
        self.calls = 0  # file handles only
        self.directories = 0

    def __call__(self, descriptor: int) -> None:
        if stat.S_ISDIR(os.fstat(descriptor).st_mode):
            # A directory flush (POSIX only) needs a read-only descriptor; it is not a file handle.
            self.directories += 1
            return self.real(descriptor)
        self.calls += 1
        try:
            os.write(descriptor, b"")  # Windows: EBADF on a descriptor opened read-only
        except OSError as exc:
            if exc.errno == errno.EBADF:
                self.read_only.append(descriptor)
                raise OSError(errno.EBADF, "Bad file descriptor") from exc
        return self.real(descriptor)


def test_no_fsync_on_read_only_handles(tmp: Path) -> None:
    watcher = FsyncWatcher()
    with patch.object(durable.os, "fsync", watcher):
        durable.atomic_write_text(tmp / "a.json", "{}")
        durable.copy_durable(tmp / "a.json", tmp / "b.json")
        durable.atomic_write_bytes(tmp / "c.bin", b"x", temporary=tmp / "c.bin.tmp", copy_mode=True)
    assert watcher.calls >= 3 and not watcher.read_only
    assert (tmp / "b.json").read_text() == "{}" and not leftovers(tmp)


def test_temp_files_are_removed_on_every_failure(tmp: Path) -> None:
    target = tmp / "manifest.json"
    target.write_text("old")
    for point in ("write", "fsync", "replace"):
        if point == "fsync":
            context = patch.object(durable, "fsync_fd", side_effect=OSError(errno.EIO, "I/O error"))
        elif point == "replace":
            context = patch.object(durable, "replace", side_effect=OSError(errno.EIO, "I/O error"))
        else:
            context = patch.object(durable.os, "fdopen", side_effect=OSError(errno.EMFILE, "too many files"))
        with context:
            try:
                durable.atomic_write_text(target, "new")
                raise AssertionError(point)
            except OSError:
                pass
        assert target.read_text() == "old", point
        assert not leftovers(tmp), (point, leftovers(tmp))
    # A caller-chosen temporary name is cleaned up as well.
    with patch.object(durable, "fsync_fd", side_effect=OSError(errno.EIO, "I/O error")):
        try:
            durable.atomic_write_text(target, "new", temporary=tmp / "manifest.json.tmp")
        except OSError:
            pass
    assert not (tmp / "manifest.json.tmp").exists()


def test_directory_flush_is_posix_only(tmp: Path) -> None:
    opened = []
    real_open = os.open

    def spy(path, flags, *args, **kwargs):
        opened.append(Path(path))
        return real_open(path, flags, *args, **kwargs)

    with patch.object(durable.sys, "platform", "win32"), patch.object(durable.os, "open", spy):
        durable.fsync_dir(tmp)
    assert opened == [], "Windows has no directory flush and none is pretended"
    # Elsewhere an unsupported filesystem is tolerated, a real I/O error is not.
    if sys.platform != "win32":
        with patch.object(durable.os, "fsync", side_effect=OSError(errno.EINVAL, "no")):
            durable.fsync_dir(tmp)
        with patch.object(durable.os, "fsync", side_effect=OSError(errno.EIO, "disk")):
            try:
                durable.fsync_dir(tmp)
                raise AssertionError("EIO hidden")
            except OSError:
                pass


def test_replace_retries_only_transient_windows_errors(tmp: Path) -> None:
    source, destination = tmp / "s", tmp / "d"
    source.write_text("1")
    calls = []
    real = os.replace

    def flaky(a, b):
        calls.append(1)
        if len(calls) < 3:
            error = PermissionError(errno.EACCES, "in use")
            error.winerror = 32
            raise error
        return real(a, b)

    with patch.object(durable.sys, "platform", "win32"), patch.object(durable.os, "replace", flaky):
        durable.replace(source, destination)
    assert destination.read_text() == "1" and len(calls) == 3
    # A permanent denial is raised after a bounded number of tries, not retried forever.
    source.write_text("2")
    calls.clear()

    def denied(a, b):
        calls.append(1)
        error = PermissionError(errno.EACCES, "denied")
        error.winerror = 5
        raise error

    with patch.object(durable.sys, "platform", "win32"), patch.object(durable.os, "replace", denied), patch.object(durable.time, "sleep"):
        try:
            durable.replace(source, destination)
            raise AssertionError("permanent denial swallowed")
        except PermissionError:
            pass
    assert len(calls) == durable._REPLACE_ATTEMPTS


def test_backup_payloads_are_flushed_before_the_world_changes(tmp: Path) -> None:
    world = tmp / "world"
    (world / "region").mkdir(parents=True)
    (world / "level.dat").write_bytes(b"\x1f\x8b")
    region = world / "region" / "r.0.0.mca"
    region.write_bytes(b"\x00" * 8192)
    events: list[str] = []
    real_fsync_fd = durable.fsync_fd

    def tracking_fsync(descriptor):
        events.append("fsync")
        return real_fsync_fd(descriptor)

    with patch.object(durable, "fsync_fd", tracking_fsync):
        backup = BackupSet.new(world, store=tmp / "backups")
        backup.add(region)
        events.append("payload-added")
        backup.verify()
        backup.publish_latest()
    # The payload copy was flushed (an fsync happened) before the add returned.
    assert events.index("fsync") < events.index("payload-added"), events
    manifest = backup.manifest_path.read_text(encoding="utf-8")
    assert '"verified": true' in manifest.replace(" ", "") or '"verified":true' in manifest.replace(" ", "")
    assert not [p for p in (tmp / "backups").rglob("*") if p.name.endswith(".tmp")]


def main() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for test in (
            test_no_fsync_on_read_only_handles,
            test_temp_files_are_removed_on_every_failure,
            test_directory_flush_is_posix_only,
            test_replace_retries_only_transient_windows_errors,
            test_backup_payloads_are_flushed_before_the_world_changes,
        ):
            (root / test.__name__).mkdir()
            test(root / test.__name__)
            print("PASS", test.__name__)
    print("DURABLE_WRITES_PASSED")


if __name__ == "__main__":
    main()
