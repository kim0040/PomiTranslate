"""Regression tests for the Review A follow-ups owned by the journal work (A-PY-01/04/05, JOB-04, PERF-02)."""
from __future__ import annotations

import errno
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from journal_fixtures import (  # noqa: E402
    build_world, config_for, journal_files, leftovers, run_job, snapshot, stores, world_is_readable,
)
from mc_world_translator import WorldTranslator  # noqa: E402
from mwt import durable, journal, locking  # noqa: E402
from mwt.journal import list_interrupted, recover_job  # noqa: E402
from mwt.region import RegionFile, RegionLayoutUnsafe  # noqa: E402
from test_core_integrity import sign, translator_for  # noqa: E402
from test_release_fixtures import write_region  # noqa: E402


# ---------------------------------------------------------------- A-PY-01

def test_replace_then_directory_flush_failure_reports_the_written_file() -> None:
    with tempfile.TemporaryDirectory() as temp:
        target = Path(temp) / "data.bin"
        target.write_bytes(b"old")

        def broken_flush(path: Path) -> None:
            raise OSError(errno.EIO, "directory flush failed")

        with patch.object(durable, "fsync_dir", broken_flush):
            try:
                durable.atomic_write_bytes(target, b"new")
                raise AssertionError("the flush failure must not be swallowed")
            except durable.CommittedWriteError as exc:
                assert exc.committed_path == target and isinstance(exc, OSError)
        assert target.read_bytes() == b"new", "the replace had succeeded"
        assert not [p for p in Path(temp).iterdir() if p.name.endswith(".tmp")]


def test_unflushed_publish_counts_as_changed_and_stays_an_error() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root, external=False)
        region_dir = (world / "region").resolve()
        real = durable.fsync_dir

        def flaky(path: Path) -> None:
            if Path(path).resolve() == region_dir:
                raise OSError(errno.EIO, "directory flush failed")
            real(path)

        with patch.object(durable, "fsync_dir", flaky):
            report = run_job(world, root, pack)
        written = {Path(item["file"]).name for item in report["changed_files"] if item.get("written_files")}
        assert {"r.0.0.mca", "r.1.0.mca"} <= written, report["changed_files"]
        assert report["changed_file_count"] >= 2, "unflushed files still count as changed"
        assert report["status"] in {"partial", "needs_retry", "failed"}, report["status"]
        assert any(e.get("code") for e in report["errors"]), "the durability failure stays visible"
        # The journal knows these files were written (not "failed"), so a rollback restores them.
        files = journal_files(root)
        assert len(files) == 1
        document = journal.Journal.load(files[0]).doc
        outcomes = {t["path"]: t["outcome"] for u in document["units"] for t in u["targets"]}
        assert outcomes["region/r.1.0.mca"] in {"written", "verified"}, outcomes
        result = recover_job(files[0], "rollback", authorized_external=[], lock_dir=root / "locks")
        assert result["state"] == "rolled_back"
        world_is_readable(world)


# ---------------------------------------------------------------- A-PY-04

def test_region_layout_gate_refuses_incomplete_and_inconsistent_slots() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        cases = {}
        # The last slot is declared full but only five bytes of it are in the file.
        path = root / "truncated" / "world" / "region" / "r.0.0.mca"
        write_region(path, {0: (2, sign("Hello sign"), False), 1: (2, sign("Second"), False)})
        data = path.read_bytes()
        path.write_bytes(data[: len(data) - 4096 + 5])
        cases["truncated final slot"] = path
        # offset = 0 with a sector count.
        path = root / "zero-offset" / "world" / "region" / "r.0.0.mca"
        write_region(path, {0: (2, sign("Hello sign"), False), 1: (2, sign("Second"), False)})
        data = bytearray(path.read_bytes())
        data[8:12] = (0).to_bytes(3, "big") + bytes([2])
        path.write_bytes(bytes(data))
        cases["offset=0/count=2"] = path
        # a real offset with a zero count.
        path = root / "zero-count" / "world" / "region" / "r.0.0.mca"
        write_region(path, {0: (2, sign("Hello sign"), False), 1: (2, sign("Second"), False)})
        data = bytearray(path.read_bytes())
        data[8:12] = (3).to_bytes(3, "big") + bytes([0])
        path.write_bytes(bytes(data))
        cases["offset>0/count=0"] = path
        for name, path in cases.items():
            original = path.read_bytes()
            assert RegionFile.read(path).layout_unsafe, name
            try:
                RegionFile.read(path).build()
                raise AssertionError(f"{name}: build must refuse")
            except RegionLayoutUnsafe:
                pass
            writer = translator_for(path.parent.parent, root / name.replace("/", "_").replace(">", "g").replace("=", "e"),
                                    {"Hello sign": "Hola"})
            result = writer.apply_region_file(path)
            assert result["skipped"] == "region_layout_unsafe" and result["changed_chunks"] == 0, (name, result)
            assert path.read_bytes() == original, f"{name}: the damaged file must be left byte for byte"
        # A healthy region is still accepted, including one whose last slot is exactly full.
        healthy = root / "healthy" / "world" / "region" / "r.0.0.mca"
        write_region(healthy, {0: (2, sign("Hello sign"), False)})
        assert RegionFile.read(healthy).layout_unsafe == ""


# ---------------------------------------------------------------- A-PY-05

def test_owner_metadata_failures_never_leak_the_lock() -> None:
    with tempfile.TemporaryDirectory() as temp:
        world = Path(temp) / "world"
        world.mkdir()
        original_unlink = Path.unlink

        def failing_unlink(self, *args, **kwargs):
            if self.name.endswith(".tmp"):
                raise PermissionError(errno.EACCES, "cannot remove the temporary owner file")
            return original_unlink(self, *args, **kwargs)

        def failing_write(self, *args, **kwargs):
            raise OSError(errno.ENOSPC, "no space for the owner note")

        lock = locking.WorldWriteLock(world, "translate")
        with patch.object(Path, "write_text", failing_write), patch.object(Path, "unlink", failing_unlink):
            lock.acquire()  # the note is informational: neither its write nor its cleanup may fail the acquire
        assert lock.acquired
        other = locking.WorldWriteLock(world, "translate")
        try:
            other.acquire()
            raise AssertionError("the held lock must keep others out")
        except locking.WorldWriteLocked:
            pass
        lock.release()
        again = locking.WorldWriteLock(world, "translate")
        again.acquire()
        again.release()
        assert not locking._HELD, locking._HELD


def test_exception_after_the_kernel_lock_rolls_everything_back() -> None:
    with tempfile.TemporaryDirectory() as temp:
        world = Path(temp) / "world"
        world.mkdir()
        lock = locking.WorldWriteLock(world, "translate")
        calls = {"n": 0}
        real = locking._identity_keys

        def explode_second_time(path):  # the registry step after the lock was taken
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("registry failure")
            return real(path)

        with patch.object(locking, "_identity_keys", explode_second_time):
            try:
                lock.acquire()
                raise AssertionError("the failure must surface")
            except RuntimeError:
                pass
        assert not lock.acquired and not locking._HELD
        fresh = locking.WorldWriteLock(world, "translate")
        fresh.acquire()  # the kernel lock was dropped with the failed acquire
        fresh.release()


def test_hold_world_acquires_inside_its_protected_scope() -> None:
    with tempfile.TemporaryDirectory() as temp:
        world = Path(temp) / "world"
        world.mkdir()
        released = []
        real_release = locking.WorldWriteLock.release

        def tracking_release(self):
            released.append(self.acquired)
            return real_release(self)

        real_acquire = locking.WorldWriteLock.acquire

        def acquire_then_fail(self):
            real_acquire(self)
            raise KeyboardInterrupt()  # arrives right after the lock was taken

        with patch.object(locking.WorldWriteLock, "acquire", acquire_then_fail), \
                patch.object(locking.WorldWriteLock, "release", tracking_release):
            try:
                with locking.hold_world(world, "translate"):
                    raise AssertionError("body must not run")
            except KeyboardInterrupt:
                pass
        assert released == [True], released
        free = locking.WorldWriteLock(world, "translate")
        free.acquire()
        free.release()


# ---------------------------------------------------------------- JOB-04

def test_backup_verification_only_partial_keeps_its_checkpoint() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root, external=False)
        checkpoint = root / "keep.checkpoint.json"

        def verify_fails(self) -> None:
            self.report["errors"].append({"scope": "backup", "code": "BACKUP_VERIFY_FAILED", "message": "synthetic"})

        with patch.object(WorldTranslator, "_verify_backup_copies", verify_fails):
            report = run_job(world, root, pack, checkpoint_enabled=True, checkpoint_path=str(checkpoint))
        assert report["status"] == "partial", report["status"]
        assert checkpoint.is_file(), "a partial run is resumable until it completes or is discarded"
        # (A completed job clears its checkpoint: covered by test_core_integrity.test_discard_clears_checkpoint
        # and the release fixtures' cancel/resume case.)


# ---------------------------------------------------------------- PERF-02

def test_zip_backups_are_verified_and_published_once() -> None:
    from mwt.safety import BackupSet

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root, external=False)
        extra = []
        for number in range(4):
            copy = world / f"pack{number}.zip"
            copy.write_bytes((world / "resources.zip").read_bytes())
            extra.append(copy)
        writer = WorldTranslator(config_for(world, root, None))
        counts = {"verify": 0, "publish": 0}
        real_verify, real_publish = BackupSet.verify, BackupSet.publish_latest

        def counting_verify(self):
            counts["verify"] += 1
            return real_verify(self)

        def counting_publish(self, **kwargs):
            counts["publish"] += 1
            return real_publish(self, **kwargs)

        with patch.object(BackupSet, "verify", counting_verify), patch.object(BackupSet, "publish_latest", counting_publish):
            writer.backup_many(extra)
            assert counts == {"verify": 1, "publish": 1}, counts
            writer.backup_many(extra)  # nothing new: nothing to check
            assert counts == {"verify": 1, "publish": 1}, counts
            for path in extra:
                writer.backup_once(path)
            assert counts == {"verify": 1, "publish": 1}, counts
        assert len(writer._run_backup.entries) == 4


def main() -> None:
    tests = [
        test_replace_then_directory_flush_failure_reports_the_written_file,
        test_unflushed_publish_counts_as_changed_and_stays_an_error,
        test_region_layout_gate_refuses_incomplete_and_inconsistent_slots,
        test_owner_metadata_failures_never_leak_the_lock,
        test_exception_after_the_kernel_lock_rolls_everything_back,
        test_hold_world_acquires_inside_its_protected_scope,
        test_backup_verification_only_partial_keeps_its_checkpoint,
        test_zip_backups_are_verified_and_published_once,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"REVIEW_A_FOLLOWUPS_PASSED ({len(tests)} tests)")


if __name__ == "__main__":
    main()
