"""Regression tests for the cross-family review of the write journal (B-H1..B-H6, B-M1..B-M3).

Each case is a probe of the review made executable: it failed on the code the review was written
against and must pass now. Synthetic worlds only.
"""
from __future__ import annotations

import errno
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from journal_fixtures import (  # noqa: E402
    ROOT, Crash, SimulatedCrash, build_world, config_for, crash_job, hook, journal_files, leftovers, run_job, snapshot,
    stores, world_is_readable,
)
from mc_world_translator import WorldTranslator  # noqa: E402
from mwt import journal, locking  # noqa: E402
from mwt.journal import Journal, JournalError, list_interrupted, recover_job  # noqa: E402
from mwt.locking import object_identity  # noqa: E402
from mwt.region import RegionFile, external_chunk_path  # noqa: E402
from mwt.safety import BackupSet  # noqa: E402

RESULTS: list[str] = []


def disk_full_at(name: str, nth: int):
    seen = {"n": 0}

    def inject(point: str, detail: dict) -> None:
        if point == name:
            seen["n"] += 1
            if seen["n"] == nth:
                raise OSError(errno.ENOSPC, "synthetic full disk")

    return inject


def error_codes(report: dict) -> list[str]:
    return [entry.get("code") for entry in report["errors"]]


# -- B-H1 ----------------------------------------------------------------------------------------

def test_stale_partial_blocks_new_translate() -> None:
    """A run stopped halfway (partial) is unsettled: nothing may write on top of it, and its old
    rollback can never run over a newer job's work."""
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        baseline = snapshot(world, pack)
        with hook(disk_full_at("before_replace", 4)):
            first = run_job(world, root, pack)
        path = journal_files(root)[0]
        assert Journal.load(path).state == "partial" and not Journal.load(path).settled, first["status"]
        listed = list_interrupted(stores(root))
        assert [(j["jobId"], j["state"], j["blocking"]) for j in listed] == [(path.parent.name, "partial", True)], listed
        mid = snapshot(world, pack)
        second = run_job(world, root, pack, expected_world_fingerprint="")
        assert second["status"] == "failed" and "RECOVERY_REQUIRED" in error_codes(second), second["errors"]
        assert second["errors"][0]["jobIds"] == [path.parent.name]
        assert snapshot(world, pack) == mid, "a refused run must not write"
        result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] == "rolled_back" and snapshot(world, pack) == baseline
        RESULTS.append("stale_partial")


def test_resume_supersedes_partial_and_old_rollback_is_refused() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        checkpoint = root / "job.checkpoint.json"
        cancelled = {"value": False}

        def progress(event: dict) -> None:
            if event.get("event") == "file_done" and event.get("phase") == "write":
                cancelled["value"] = True

        runtime = dict(checkpoint_enabled=True, checkpoint_path=str(checkpoint), scan_plan_id="a" * 64)
        first = WorldTranslator(config_for(world, root, pack, **runtime), progress_callback=progress,
                                cancel_check=lambda: cancelled["value"]).run()
        old_path = journal_files(root)[0]
        assert first["status"] == "cancelled" and checkpoint.is_file(), first["status"]
        assert Journal.load(old_path).state == "partial" and not Journal.load(old_path).settled
        # A different, fresh translation may not write over the partial job...
        other = run_job(world, root, pack, expected_world_fingerprint="")
        assert "RECOVERY_REQUIRED" in error_codes(other), other["errors"]
        # ...but the resume of the very same job may, after its world state passed the Keep check.
        resumed_config = config_for(world, root, pack, **runtime, resume_from_checkpoint=True)
        resumed = WorldTranslator(resumed_config, cancel_check=lambda: False).run()
        assert resumed["status"] == "completed", (resumed["status"], resumed["errors"])
        assert resumed["backup_set_id"] != first["backup_set_id"], "a resume is a new job"
        old = Journal.load(old_path)
        assert old.state == "superseded" and old.settled and old.doc["supersededBy"] == resumed["backup_set_id"]
        new_path = next(p for p in journal_files(root) if p != old_path)
        new = Journal.load(new_path)
        assert new.doc.get("supersedes") == old.job_id and new.generation > old.generation
        assert list_interrupted(stores(root)) == []
        newest = snapshot(world, pack)
        try:
            recover_job(old_path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
            raise AssertionError("a superseded job must not be recoverable")
        except JournalError as exc:
            assert exc.code == "JOURNAL_SUPERSEDED", exc.code
        assert snapshot(world, pack) == newest
        RESULTS.append("resume_supersedes")


def test_resume_is_refused_when_the_partial_job_is_inconsistent() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        checkpoint = root / "job.checkpoint.json"
        runtime = dict(checkpoint_enabled=True, checkpoint_path=str(checkpoint), scan_plan_id="b" * 64)
        # The 4th replace is the region of the unit that already published its .mcc: a mixed unit.
        with hook(disk_full_at("before_replace", 4)):
            first = run_job(world, root, pack, **runtime)
        old_path = journal_files(root)[0]
        assert first["status"] in {"partial", "needs_retry"} and checkpoint.is_file(), first["status"]
        mid = snapshot(world, pack)
        resumed = run_job(world, root, pack, **runtime, resume_from_checkpoint=True)
        assert resumed["status"] == "failed" and "RECOVERY_REQUIRED" in error_codes(resumed), resumed["errors"]
        assert snapshot(world, pack) == mid
        assert not Journal.load(old_path).settled
        RESULTS.append("resume_refused")


def test_generation_refuses_stale_record_even_when_hashes_match() -> None:
    """Hash equality never confers ownership: a record that a newer job passed is refused."""
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        crash_job(world, root, pack, Crash("before_final_state", 1))
        old_path = journal_files(root)[0]
        old = Journal.load(old_path)
        # A newer, committed job of the same world exists in another store (a record the old one cannot see).
        other_store = root / "elsewhere" / "backups" / "x"
        other_store.mkdir(parents=True)
        newer = Journal.create(other_store / "20991231T000000Z-aaaaaaaaaaaa-translation" / "journal.json",
                               job_id="20991231T000000Z-aaaaaaaaaaaa-translation", kind="translate", world_dir=world,
                               stores=stores(root))
        assert newer.generation > old.generation
        newer.save()
        try:
            recover_job(old_path, "rollback", authorized_external=[pack], lock_dir=root / "locks",
                        stores=[other_store])
            raise AssertionError("expected JOURNAL_SUPERSEDED")
        except JournalError as exc:
            assert exc.code in {"JOURNAL_SUPERSEDED", "RECOVERY_REQUIRED"}, exc.code
        # Generations are durable and strictly increasing per world.
        state = json.loads((stores(root)[0] / f"world-state.{old.doc['worldKey']}.json").read_text("utf-8"))
        assert state["generation"] >= old.generation and state["worldKey"] == old.doc["worldKey"]
        RESULTS.append("generation")


def test_unsettled_job_in_other_store_blocks() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        legacy = world / ".pomi-backups"
        crash_job(world, root, pack, Crash("prepared"), backup_store=str(legacy))
        path = next(legacy.glob("*/journal.json"))
        mid = snapshot(world, pack)
        report = run_job(world, root, pack, expected_world_fingerprint="")
        assert report["status"] == "failed" and "RECOVERY_REQUIRED" in error_codes(report), report["errors"]
        assert snapshot(world, pack) == mid
        result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] == "rolled_back"
        later = run_job(world, root, pack)
        assert later["status"] == "completed", later["errors"]
        RESULTS.append("store_bypass")


def test_restore_is_refused_while_another_job_is_unsettled() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        original = snapshot(world, pack)
        report = run_job(world, root, pack)
        translated = snapshot(world, pack)
        first_set = report["backup_set_id"]
        selected = BackupSet.find(world, first_set, stores(root), external_files=[pack])
        # A restore of that set is cut off: its own record is now an unsettled job of this world.
        with hook(Crash("between_targets", 1, kind="restore")):
            try:
                selected.restore(recovery_store=stores(root)[0], lock_dir=root / "locks")
                raise AssertionError("the restore should have been cut off")
            except SimulatedCrash:
                pass
        crashed = [p for p in journal_files(root) if Journal.load(p).kind == "restore"]
        assert len(crashed) == 1
        mid = snapshot(world, pack)
        assert mid not in (original, translated)
        # Restoring again (a different job over the half-restored files), or translating, must wait for it.
        try:
            selected.restore(recovery_store=stores(root)[0], lock_dir=root / "locks")
            raise AssertionError("restore must be refused")
        except JournalError as exc:
            assert exc.code == "RECOVERY_REQUIRED" and exc.job_ids == [crashed[0].parent.name], (exc.code, exc.job_ids)
        assert snapshot(world, pack) == mid
        blocked = run_job(world, root, pack, expected_world_fingerprint="")
        assert "RECOVERY_REQUIRED" in error_codes(blocked) and snapshot(world, pack) == mid
        result = recover_job(crashed[0], "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] == "rolled_back" and snapshot(world, pack) == translated
        selected.restore(recovery_store=stores(root)[0], lock_dir=root / "locks")
        assert snapshot(world, pack) == original
        RESULTS.append("restore_bypass")


# -- B-H2 / B-M1 -----------------------------------------------------------------------------------

def test_keep_refuses_foreign_edit_and_quarantines() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        crash_job(world, root, pack, Crash("before_final_state"))
        path = journal_files(root)[0]
        pack.write_bytes(b"foreign edit")
        result = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] == "recovery_conflict", result
        assert [c["code"] for c in result["conflicts"]] == ["RECOVERY_CONFLICT"]
        assert result["quarantineDir"] and pack.read_bytes() == b"foreign edit"
        quarantined = [p.read_bytes() for p in Path(result["quarantineDir"]).rglob("*") if p.is_file()]
        assert quarantined == [b"foreign edit"]
        assert not Journal.load(path).settled and len(list_interrupted(stores(root))) == 1
        # Only an explicit acceptance settles it, and it quarantines first and records the conflict.
        accepted = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks", accept_conflicts=True)
        assert accepted["state"] == "kept" and accepted["conflicts"], accepted
        document = json.loads(path.read_text("utf-8"))
        assert document["state"] == "kept" and document["acceptedConflicts"], document.get("acceptedConflicts")
        assert pack.read_bytes() == b"foreign edit"
        assert list_interrupted(stores(root)) == []
        RESULTS.append("keep_foreign")


def test_keep_refuses_mixed_codec_region() -> None:
    """A region and its payload each match a hash the job knows, yet they no longer describe one chunk."""
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        report = run_job(world, root, pack)
        region_path = world / "region" / "r.2.0.mca"
        region = RegionFile.read(region_path)
        raw = region.chunks[0].raw_nbt
        region.chunks[0].compression = 3
        region.replace_nbt(0, raw)
        body, payloads = region.build()
        for index, payload in payloads.items():
            external_chunk_path(region_path, index).write_bytes(payload)
        region_path.write_bytes(body)
        selected = BackupSet.find(world, report["backup_set_id"], stores(root), external_files=[pack])

        def stop(name: str, detail: dict) -> None:
            if name == "after_replace" and detail.get("kind") == "restore" and Path(detail.get("path", "")).name == "c.64.0.mcc":
                raise SimulatedCrash("old payload restored, old codec header not yet")

        with hook(stop):
            try:
                selected.restore(recovery_store=stores(root)[0], lock_dir=root / "locks")
            except SimulatedCrash:
                pass
        path = next(p for p in journal_files(root) if Journal.load(p).kind == "restore")
        result = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] == "recovery_conflict", result
        assert {c["code"] for c in result["conflicts"]} == {"UNIT_INCONSISTENT"}, result["conflicts"]
        assert not Journal.load(path).settled
        # Rollback still reaches a readable world.
        recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
        world_is_readable(world)
        RESULTS.append("keep_mixed_codec")


def test_keep_missing_target_is_a_conflict() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        crash_job(world, root, pack, Crash("before_final_state"))
        path = journal_files(root)[0]
        (world / "resources.zip").unlink()
        result = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] == "recovery_conflict"
        assert "MISSING" in {c["code"] for c in result["conflicts"]}, result["conflicts"]
        RESULTS.append("keep_missing")


# -- B-H3 --------------------------------------------------------------------------------------

def test_journal_save_failure_after_publish_keeps_physical_evidence() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        baseline = snapshot(world, pack)
        real = Journal.save

        def fail(self) -> None:
            if any(t["outcome"] == "verified" for _u, t in self.targets()):
                raise OSError(errno.ENOSPC, "synthetic full disk writing the record after a world replace")
            return real(self)

        translator = WorldTranslator(config_for(world, root, pack))
        with patch.object(journal, "SAVE_INTERVAL", 0), patch.object(Journal, "save", fail):
            report = translator.run()
        changed = sorted(k for k, v in snapshot(world, pack).items() if v != baseline.get(k))
        assert changed, "the first target was published"
        assert report["status"] != "completed" and report["changed_file_count"] >= 1, (report["status"], report["changed_file_count"])
        recorded = {Path(p).name for p in report.get("changed_files", []) if isinstance(p, str)} | {
            Path(item["path"]).name if isinstance(item, dict) and "path" in item else "" for item in report.get("changed_files", [])}
        assert recorded or report["changed_file_count"] >= 1
        assert {"DISK_FULL", "JOURNAL_WRITE_FAILED"} & set(error_codes(report)), report["errors"]
        # No further target was published after the record stopped saving: only the first unit changed.
        assert len(changed) < 6, changed
        RESULTS.append("journal_full")


def test_journal_save_failure_matrix_leaves_recoverable_world() -> None:
    """ENOSPC / EIO right before and right after every record save of a clean job: the world stays
    recoverable to the byte-exact baseline, and the physical outcome is never lost."""
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        original = snapshot(world, pack)
        counter = {"n": 0}

        def count(name: str, detail: dict) -> None:
            if name == "journal_save" and detail.get("phase") == "before":
                counter["n"] += 1

        with hook(count), patch.object(journal, "SAVE_INTERVAL", 0):
            run_job(world, root, pack)
        total = counter["n"]
        # Zip members carry their creation time, so worlds are compared by which files a job changed.
        translated_keys = {key for key, value in snapshot(world, pack).items() if value != original.get(key)}
    assert total >= 10, total
    rows = 0
    for nth in range(1, total + 1):
        for phase, code in (("before", errno.ENOSPC), ("after", errno.EIO)):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                world, pack = build_world(root)
                baseline = snapshot(world, pack)
                seen = {"n": 0}

                def inject(name: str, detail: dict, nth=nth, phase=phase, code=code, seen=seen) -> None:
                    if name == "journal_save" and detail.get("phase") == phase:
                        seen["n"] += 1
                        if seen["n"] == nth:
                            raise OSError(code, "synthetic journal save failure")

                with hook(inject), patch.object(journal, "SAVE_INTERVAL", 0):
                    try:
                        report = run_job(world, root, pack)
                    except JournalError:
                        report = None
                    except OSError:
                        report = None
                mid = snapshot(world, pack)
                if report is not None and report["status"] == "completed":
                    continue  # the failing save was not on the success path
                paths = journal_files(root)
                if paths:
                    open_jobs = [path for path in paths if not Journal.load(path).settled]
                    if not open_jobs:
                        # Every record is settled: the world must match what it says - fully translated for a
                        # committed record, untouched for one that never published anything. Never in between.
                        states = {Journal.load(path).state for path in paths}
                        now = snapshot(world, pack)
                        changed_now = {key for key, value in now.items() if value != baseline.get(key)}
                        expected = translated_keys if states == {"committed"} else set()
                        assert changed_now == expected, (nth, phase, states, "a settled record must match the world")
                    for path in open_jobs:
                        result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
                        assert result["state"] == "rolled_back", (nth, phase, result)
                        assert snapshot(world, pack) == baseline, (nth, phase, "rollback after a failed save is byte-exact")
                else:
                    assert mid == baseline, (nth, phase, "no record means nothing may have changed")
                assert not leftovers(world, pack), (nth, phase, leftovers(world, pack))
                world_is_readable(world)
                rows += 1
    assert rows >= total, rows
    RESULTS.append(f"journal_save_matrix:{rows}")


# -- B-H4 --------------------------------------------------------------------------------------

def test_recovery_refuses_swapped_external_parent() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        crash_job(world, root, pack, Crash("before_final_state"))
        path = journal_files(root)[0]
        moved = root / "old-packs"

        def swap(name: str, detail: dict) -> None:
            if name == "recovery_started":
                pack.parent.rename(moved)
                pack.parent.mkdir()
                shutil.copy2(moved / pack.name, pack)

        replacement_identity = None
        with hook(swap):
            result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
        replacement_identity = object_identity(pack.parent)
        assert replacement_identity != object_identity(moved)
        assert pack.read_bytes() == (moved / pack.name).read_bytes(), "the replacement folder's pack was overwritten"
        assert result["state"] != "rolled_back", result
        assert result.get("errorCode") in {"TARGET_CHANGED", "WORLD_CHANGED"}, result
        RESULTS.append("recovery_identity")


def test_translate_refuses_swapped_world_file() -> None:
    """A target replaced by another object of the same bytes, between plan and publish, is refused
    (WORLD_CHANGED) instead of being overwritten under a new baseline."""
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        target = world / "region" / "r.1.0.mca"

        def swap(name: str, detail: dict) -> None:
            if name == "prepared":
                data = target.read_bytes()
                other = target.with_name("swap.tmp-source")
                other.write_bytes(data)
                target.unlink()
                other.rename(target)

        with hook(swap):
            report = run_job(world, root, pack)
        codes = error_codes(report)
        assert "WORLD_CHANGED" in codes or "TARGET_CHANGED" in codes, (report["status"], report["errors"])
        RESULTS.append("translate_identity")


def test_translate_refuses_swapped_external_pack_with_target_changed() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        original = pack.read_bytes()

        def swap(name: str, detail: dict) -> None:
            if name == "prepared":  # after every guard and the backup, before the first publish
                copy = pack.with_name("copy.zip.src")
                copy.write_bytes(pack.read_bytes())
                pack.unlink()
                copy.rename(pack)

        with hook(swap):
            report = run_job(world, root, pack)
        assert "TARGET_CHANGED" in error_codes(report), (report["status"], report["errors"])
        assert pack.read_bytes() == original, "the swapped pack must not be overwritten"
        RESULTS.append("target_changed")


def test_rollback_leaves_conflicts_alone_and_keeps_job_open() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        crash_job(world, root, pack, Crash("before_final_state"))
        path = journal_files(root)[0]
        pack.write_bytes(b"foreign edit")
        result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] == "recovery_conflict", result
        assert pack.read_bytes() == b"foreign edit", "a conflicted target is never overwritten"
        assert not Journal.load(path).settled
        assert [j["state"] for j in list_interrupted(stores(root)) if j["jobId"] == path.parent.name] == ["recovery_conflict"]
        blocked = run_job(world, root, pack, expected_world_fingerprint="")
        assert "RECOVERY_REQUIRED" in error_codes(blocked)
        RESULTS.append("rollback_conflict")


# -- B-H5 --------------------------------------------------------------------------------------

def test_failed_recovery_child_is_never_committed() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        baseline = snapshot(world, pack)
        crash_job(world, root, pack, Crash("before_final_state"))
        path = journal_files(root)[0]
        calls = {"n": 0}
        real = journal.WriteTransaction._write_file

        def fail(self, spec, target, info):
            if self.journal.kind == "recovery":
                calls["n"] += 1
                if calls["n"] == 2:
                    raise OSError(errno.ENOSPC, "synthetic full disk during rollback")
            return real(self, spec, target, info)

        with patch.object(journal.WriteTransaction, "_write_file", fail):
            result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] != "rolled_back", result
        child = next(Journal.load(p) for p in journal_files(root) if p != path)
        assert child.kind == "recovery" and child.state != "committed" and not child.settled, child.state
        assert not Journal.load(path).settled
        listed = {item["jobId"] for item in list_interrupted(stores(root))}
        assert child.job_id in listed and path.parent.name in listed, listed
        # Running the recovery again finishes the job; the failed child is retired only after a rehash, as superseded.
        again = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert again["state"] == "rolled_back" and snapshot(world, pack) == baseline, again
        retired = Journal.load(child.path)
        assert retired.state in {"superseded", "rolled_back", "committed"}
        assert retired.state != "committed" or retired.all_verified(), "a child is never faked as committed"
        assert list_interrupted(stores(root)) == [], list_interrupted(stores(root))
        RESULTS.append("recovery_failure")


def test_committed_header_over_open_units_is_listed() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        run_job(world, root, pack)
        path = journal_files(root)[0]
        document = json.loads(path.read_text("utf-8"))
        document["units"][0]["targets"][0]["outcome"] = "failed"
        document["unitsOpen"] = 1  # as a record from an older release (or a damaged one) might still say committed
        path.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
        listed = list_interrupted(stores(root))
        assert [j["jobId"] for j in listed] == [path.parent.name] and listed[0]["state"] == "failed", listed
        RESULTS.append("committed_with_open_units")


# -- B-H6 --------------------------------------------------------------------------------------

def test_backup_false_keeps_validation_and_backup() -> None:
    for flag in (False, True):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            world, pack = build_world(base)
            cfg = config_for(world, base, pack)
            cfg["backup"] = flag
            translator = WorldTranslator(cfg)
            real = WorldTranslator._commit_units

            def edit_then_commit(self, units, **kwargs):
                with zipfile.ZipFile(pack, "a") as archive:
                    archive.writestr("user-edit.bin", b"new user bytes after plan")
                return real(self, units, **kwargs)

            with patch.object(WorldTranslator, "_commit_units", edit_then_commit):
                report = translator.run()
            with zipfile.ZipFile(pack) as archive:
                kept = "user-edit.bin" in archive.namelist()
            assert kept, f"backup={flag}: the user's edit was overwritten"
            assert {"WORLD_CHANGED", "TARGET_CHANGED"} & set(error_codes(report)) or report["status"] != "completed", (flag, report["errors"])
            warnings = [w.get("code") for w in report.get("warnings", [])]
            assert ("backup_always_on" in warnings) == (not flag), (flag, warnings)
    RESULTS.append("backup_false_validation")


# -- B-M2 / B-M3 ---------------------------------------------------------------------------------

def test_quarantine_does_not_collide_between_same_named_packs() -> None:
    from mwt.locking import hold_world

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world = root / "world"
        world.mkdir()
        (world / "level.dat").write_bytes(b"\x1f\x8b")
        packs = [root / "a" / "pack.zip", root / "b" / "pack.zip"]
        for p in packs:
            p.parent.mkdir()
            p.write_bytes(b"original")
        source = root / "post"
        source.write_bytes(b"new")
        backup = BackupSet.new(world, store=root / "backups", external_files=packs)
        record = Journal.create(backup.root / "journal.json", job_id=backup.backup_id, kind="translate", world_dir=world)
        units = [journal.UnitSpec(unit_id=f"zip:{i}", kind="resource_pack", label=str(p),
                                  targets=[journal.TargetSpec(p, root_kind="external_pack", source=source, role="pack")])
                 for i, p in enumerate(packs)]
        with hold_world(world, external_targets=packs, lock_dir=root / "locks"), hook(Crash("before_final_state")):
            try:
                journal.WriteTransaction(record, backup, world).run(units)
            except SimulatedCrash:
                pass
        packs[0].write_bytes(b"foreign A")
        packs[1].write_bytes(b"foreign B")
        result = recover_job(record.path, "rollback", authorized_external=packs, lock_dir=root / "locks")
        files = [p for p in Path(result["quarantineDir"]).rglob("*.zip")]
        assert sorted(p.read_text() for p in files) == ["foreign A", "foreign B"], [p.read_text() for p in files]
        assert len({p.name for p in files}) == 2 and all(p.name.endswith("-pack.zip") for p in files), [p.name for p in files]
        assert len({c["path"] for c in result["conflicts"]}) == 2, result["conflicts"]
        # A second quarantine into an existing name never truncates it.
        existing = files[0]
        before = existing.read_bytes()
        different = root / "different"
        different.write_bytes(b"something else")
        journal._copy_exclusive(different, existing)
        assert existing.read_bytes() == before
        assert any(p.read_bytes() == b"something else" for p in existing.parent.iterdir())
        RESULTS.append("quarantine_collision")


def child_probe(pack: Path, lock_dir: Path) -> str:
    code = ("import sys; sys.path.insert(0, sys.argv[1]); from pathlib import Path; "
            "from mwt.locking import ExternalTargetLock, TargetLocked; l = ExternalTargetLock(Path(sys.argv[2]), Path(sys.argv[3]))\n"
            "try:\n l.acquire(); print('acquired'); l.release()\nexcept TargetLocked:\n print('blocked')")
    return subprocess.check_output([sys.executable, "-B", "-c", code, str(ROOT), str(pack), str(lock_dir)], text=True).strip()


def test_external_lock_does_not_leak_on_interrupt() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        pack = root / "pack.zip"
        pack.write_bytes(b"pack")
        lock = locking.ExternalTargetLock(pack, root / "locks")
        real = locking._identity_keys
        calls = {"n": 0}

        def interrupt(path):
            calls["n"] += 1
            if calls["n"] == 2:
                raise KeyboardInterrupt("interrupt after the kernel lock was taken")
            return real(path)

        with patch.object(locking, "_identity_keys", interrupt):
            try:
                lock.acquire()
                raise AssertionError("the interrupt should have propagated")
            except KeyboardInterrupt:
                pass
        assert lock._descriptor is None and not lock.acquired
        lock.release()
        assert child_probe(pack, root / "locks") == "acquired", "the kernel lock leaked"
        RESULTS.append("external_lock_leak")


def test_external_lock_release_cleans_half_built_holder() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        pack = root / "pack.zip"
        pack.write_bytes(b"pack")
        lock = locking.ExternalTargetLock(pack, root / "locks")
        lock.acquire()
        lock.acquired = False  # a holder whose flag was never set but whose descriptor is held
        lock.release()
        assert lock._descriptor is None
        assert child_probe(pack, root / "locks") == "acquired"
        RESULTS.append("external_lock_release")


def test_legacy_set_without_journal_still_restores() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        baseline = snapshot(world, pack)
        report = run_job(world, root, pack)
        path = journal_files(root)[0]
        path.unlink()
        BackupSet.find(world, report["backup_set_id"], stores(root), external_files=[pack]).restore(
            recovery_store=stores(root)[0], lock_dir=root / "locks")
        assert snapshot(world, pack) == baseline
        RESULTS.append("legacy_restore")


def main() -> None:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print(f"PASS {test.__name__}", flush=True)
    print(f"JOURNAL_REVIEW_PASSED ({len(tests)} tests: {', '.join(RESULTS)})")


if __name__ == "__main__":
    main()
