"""Regression tests for the second cross-family review of the write journal (B2-H1, B2-M1, B2-M2).

* B2-H1: a resume that was cut off before it wrote anything is reconciled by every gate.
* B2-M1: Keep quarantines every readable conflict (inconsistent units included) before it settles.
* B2-M2: the per-world generation counter is scoped per world, read from every known store, and
  made durable before a record is accepted.

Synthetic worlds only; the real-process kills of the same handshake are in test_journal_kill.py.
"""
from __future__ import annotations

import errno
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from journal_fixtures import (  # noqa: E402
    SimulatedCrash, build_world, checkpoint_runtime, hook, journal_files, leftovers, partial_job, run_job, snapshot,
    stores, world_is_readable,
)
from mwt import journal  # noqa: E402
from mwt.journal import (  # noqa: E402
    Journal, JournalError, JournalWriteFailed, list_interrupted, reconcile_continuations, recover_job,
)
from mwt.region import RegionFile, external_chunk_path  # noqa: E402
from mwt.safety import BackupSet  # noqa: E402

RESULTS: list[str] = []

# The three cuts of the handshake that leave nothing published (see the sequence in test_journal_kill.py):
# the new record is saved, the old record is marked superseded, the new job has backed everything up.
CUTS = {
    "saved": lambda name, d: name == "journal_save" and d["phase"] == "after" and d["kind"] == "translate" and d["state"] == "preparing",
    "superseded": lambda name, d: name == "journal_save" and d["phase"] == "after" and d["state"] == "superseded",
    "committing": lambda name, d: name == "journal_save" and d["phase"] == "after" and d["kind"] == "translate" and d["state"] == "committing",
}


def codes(report: dict) -> list[str]:
    return [entry.get("code") for entry in report["errors"]]


def path_of(root: Path, job_id: str) -> Path:
    return next(p for p in journal_files(root) if p.parent.name == job_id)


def interrupted_resume(world: Path, root: Path, pack: Path, cut: str) -> str:
    """Resume the partial job and stop the process image at ``cut``; returns the id of the new job."""
    def die(name: str, detail: dict) -> None:
        if CUTS[cut](name, detail):
            raise SimulatedCrash(cut)

    with hook(die):
        try:
            run_job(world, root, pack, **checkpoint_runtime(root, resume=True))
        except SimulatedCrash:
            pass
        else:
            raise AssertionError(f"cut {cut} was never reached")
    newer = [p for p in journal_files(root) if Journal.load(p).doc.get("supersedes")]
    assert len(newer) == 1, [p.parent.name for p in journal_files(root)]
    return newer[0].parent.name


def partial_world(temp: str):
    root = Path(temp)
    world, pack = build_world(root)
    baseline = snapshot(world, pack)
    report = partial_job(world, root, pack)
    old_id = report["backup_set_id"]
    mid = snapshot(world, pack)
    assert mid != baseline and Journal.load(path_of(root, old_id)).state == "partial"
    return root, world, pack, baseline, mid, old_id


def check_old_is_back(root: Path, old_id: str, new_id: str) -> None:
    old = Journal.load(path_of(root, old_id))
    assert old.state == "partial" and not old.settled and old.generation == 1, (old.state, old.generation)
    for key in ("supersededBy", "stateBeforeSupersede", "settledBy"):
        assert key not in old.doc, (key, old.doc.get(key))
    new = Journal.load(path_of(root, new_id))
    assert new.state == "rolled_back" and new.doc["settledBy"] == "unpublished_continuation", (new.state, new.doc.get("settledBy"))


# -- B2-H1 ---------------------------------------------------------------------------------------

def test_every_gate_reconciles_an_interrupted_resume() -> None:
    for cut in CUTS:
        for gate in ("translate", "restore", "rollback_old", "keep_old", "rollback_new", "keep_new"):
            with tempfile.TemporaryDirectory() as temp:
                root, world, pack, baseline, mid, old_id = partial_world(temp)
                new_id = interrupted_resume(world, root, pack, cut)
                assert snapshot(world, pack) == mid, (cut, "a continuation that wrote nothing must leave the world as it was")
                label = (cut, gate)
                old_path, new_path = path_of(root, old_id), path_of(root, new_id)
                if gate == "translate":
                    report = run_job(world, root, pack, **checkpoint_runtime(root, resume=True))
                    assert report["status"] == "completed", (label, report["status"], report["errors"])
                    assert Journal.load(new_path).doc["settledBy"] == "unpublished_continuation", label
                    assert list_interrupted(stores(root)) == [], label
                    world_is_readable(world)
                elif gate == "restore":
                    selected = BackupSet.find(world, old_id, stores(root), external_files=[pack])
                    selected.restore(recovery_store=stores(root)[0], lock_dir=root / "locks")
                    assert snapshot(world, pack) == baseline, label
                    assert Journal.load(new_path).doc["settledBy"] == "unpublished_continuation", label
                    assert list_interrupted(stores(root)) == [], (label, list_interrupted(stores(root)))
                elif gate == "rollback_old":
                    result = recover_job(old_path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
                    assert result["state"] == "rolled_back" and snapshot(world, pack) == baseline, (label, result)
                    assert Journal.load(new_path).doc["settledBy"] == "unpublished_continuation", label
                    assert list_interrupted(stores(root)) == [], label
                    assert not leftovers(world, pack), (label, leftovers(world, pack))
                    world_is_readable(world)
                elif gate == "keep_old":
                    result = recover_job(old_path, "keep", authorized_external=[pack], lock_dir=root / "locks")
                    assert result["state"] == "kept" and not result["conflicts"], (label, result)
                    assert snapshot(world, pack) == mid, (label, "keep must settle A's own partial world, unchanged")
                    assert Journal.load(new_path).doc["settledBy"] == "unpublished_continuation", label
                    assert list_interrupted(stores(root)) == [], label
                    world_is_readable(world)
                else:  # the request names the continuation itself, in either mode
                    result = recover_job(new_path, gate.split("_")[0], authorized_external=[pack], lock_dir=root / "locks")
                    assert result["state"] == "rolled_back" and result["settledBy"] == "unpublished_continuation", (label, result)
                    assert snapshot(world, pack) == mid, label
                    check_old_is_back(root, old_id, new_id)
                    assert [j["jobId"] for j in list_interrupted(stores(root))] == [old_id], label
                    result = recover_job(old_path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
                    assert result["state"] == "rolled_back" and snapshot(world, pack) == baseline, (label, result)
                if gate in {"restore", "rollback_old", "keep_old", "translate"}:
                    assert Journal.load(new_path).state == "rolled_back", label
                RESULTS.append(f"reconcile:{cut}:{gate}")


def test_old_job_is_put_back_exactly() -> None:
    for cut in ("saved", "superseded"):
        with tempfile.TemporaryDirectory() as temp:
            root, world, pack, _baseline, _mid, old_id = partial_world(temp)
            before = Journal.load(path_of(root, old_id)).doc
            new_id = interrupted_resume(world, root, pack, cut)
            during = Journal.load(path_of(root, old_id)).doc
            assert (during["state"] == "superseded") == (cut == "superseded"), cut
            if cut == "superseded":
                assert during["stateBeforeSupersede"] == "partial" and during["supersededBy"] == new_id, during
            assert reconcile_continuations(world, stores(root), authorized=[str(pack.resolve())]) == [new_id]
            after = Journal.load(path_of(root, old_id)).doc
            assert {k: v for k, v in after.items() if k not in {"seq", "updatedAt"}} == \
                   {k: v for k, v in before.items() if k not in {"seq", "updatedAt"}}, cut
            # Idempotent: a second gate finds nothing left to do.
            assert reconcile_continuations(world, stores(root), authorized=[str(pack.resolve())]) == []
            RESULTS.append(f"put_back:{cut}")


def test_published_continuation_is_never_reconciled() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root, world, pack, baseline, mid, old_id = partial_world(temp)

        def die(name: str, detail: dict) -> None:
            if name == "after_replace" and detail.get("kind") == "translate":
                raise SimulatedCrash("first write of the continuation")

        with hook(die):
            try:
                run_job(world, root, pack, **checkpoint_runtime(root, resume=True))
            except SimulatedCrash:
                pass
        new_id = next(p.parent.name for p in journal_files(root) if Journal.load(p).doc.get("supersedes"))
        published = snapshot(world, pack)
        assert published != mid
        states = {p.parent.name: Journal.load(p).state for p in journal_files(root)}
        assert states == {old_id: "superseded", new_id: "committing"}, states
        assert reconcile_continuations(world, stores(root), authorized=[str(pack.resolve())]) == []
        assert {p.parent.name: Journal.load(p).state for p in journal_files(root)} == states
        for mode in ("rollback", "keep"):
            try:
                recover_job(path_of(root, old_id), mode, authorized_external=[pack], lock_dir=root / "locks")
                raise AssertionError("the superseded job must stay refused")
            except JournalError as exc:
                assert exc.code == "JOURNAL_SUPERSEDED" and exc.job_ids == [new_id], (exc.code, exc.job_ids)
        report = run_job(world, root, pack, **checkpoint_runtime(root, resume=True), expected_world_fingerprint="")
        assert "RECOVERY_REQUIRED" in codes(report), report["errors"]
        result = recover_job(path_of(root, new_id), "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] == "rolled_back" and snapshot(world, pack) == mid, result
        RESULTS.append("published_not_reconciled")


def test_continuation_whose_targets_changed_is_not_reconciled() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root, world, pack, _baseline, _mid, old_id = partial_world(temp)
        new_id = interrupted_resume(world, root, pack, "saved")
        target = world / "region" / "r.1.0.mca"  # a file the continuation planned and has not written
        assert Journal.load(path_of(root, new_id)).targets()
        target.write_bytes(target.read_bytes() + b"\0" * 8)
        changed = snapshot(world, pack)
        assert reconcile_continuations(world, stores(root), authorized=[str(pack.resolve())]) == []
        try:
            recover_job(path_of(root, old_id), "rollback", authorized_external=[pack], lock_dir=root / "locks")
            raise AssertionError("nothing can be proven, so the refusal stays")
        except JournalError as exc:
            assert exc.code in {"RECOVERY_REQUIRED", "JOURNAL_SUPERSEDED"}, exc.code
        assert snapshot(world, pack) == changed
        assert Journal.load(path_of(root, new_id)).state == "preparing"
        RESULTS.append("targets_changed")


def test_unrecorded_prior_state_is_never_guessed() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root, world, pack, _baseline, mid, old_id = partial_world(temp)
        new_id = interrupted_resume(world, root, pack, "superseded")
        old = Journal.load(path_of(root, old_id))
        del old.doc["stateBeforeSupersede"]  # a record written before the field existed
        old.save()
        assert reconcile_continuations(world, stores(root), authorized=[str(pack.resolve())]) == []
        assert Journal.load(path_of(root, new_id)).state == "preparing"
        assert Journal.load(path_of(root, old_id)).state == "superseded"
        assert snapshot(world, pack) == mid
        RESULTS.append("prior_state_unrecorded")


def test_continuation_that_failed_to_start_puts_the_old_job_back() -> None:
    """No crash: the continuation's backup hit a full disk after the old job was superseded."""
    with tempfile.TemporaryDirectory() as temp:
        root, world, pack, baseline, mid, old_id = partial_world(temp)
        seen = {"n": 0}

        def full(name: str, detail: dict) -> None:
            if name == "backup_payload" and detail.get("kind") == "translate":
                seen["n"] += 1
                if seen["n"] == 1:
                    raise OSError(errno.ENOSPC, "synthetic full disk")

        with hook(full):
            report = run_job(world, root, pack, **checkpoint_runtime(root, resume=True))
        assert report["status"] != "completed", report["status"]
        new_id = next(p.parent.name for p in journal_files(root) if Journal.load(p).doc.get("supersedes"))
        new = Journal.load(path_of(root, new_id))
        assert new.state == "rolled_back" and new.doc["settledBy"] == "untouched"
        assert Journal.load(path_of(root, old_id)).state == "superseded", "stranded until a gate reconciles it"
        assert snapshot(world, pack) == mid
        result = recover_job(path_of(root, old_id), "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] == "rolled_back" and snapshot(world, pack) == baseline, result
        assert Journal.load(path_of(root, new_id)).doc["settledBy"] == "untouched"
        RESULTS.append("failed_start")


def test_resume_records_what_it_supersedes() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root, world, pack, _baseline, _mid, old_id = partial_world(temp)
        report = run_job(world, root, pack, **checkpoint_runtime(root, resume=True))
        assert report["status"] == "completed", report["errors"]
        old = Journal.load(path_of(root, old_id))
        assert old.state == "superseded" and old.doc["stateBeforeSupersede"] == "partial" and old.doc["supersededBy"]
        RESULTS.append("state_before_supersede")


# -- B2-M1 ---------------------------------------------------------------------------------------

def mixed_restore(root: Path, world: Path, pack: Path) -> Path:
    """A restore cut off between an old payload and its region: an inconsistent unit of two files."""
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
    return next(p for p in journal_files(root) if Journal.load(p).kind == "restore")


def quarantined(result: dict) -> dict[str, str]:
    assert result["quarantineDir"], result
    base = Path(result["quarantineDir"])
    return {path.relative_to(base).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in base.rglob("*") if path.is_file()}


def test_keep_quarantines_inconsistent_unit_files() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        path = mixed_restore(root, world, pack)
        live = {f"world/region/{name}": hashlib.sha256((world / "region" / name).read_bytes()).hexdigest()
                for name in ("c.64.0.mcc", "r.2.0.mca")}
        refused = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks")
        assert refused["state"] == "recovery_conflict", refused
        assert {c["code"] for c in refused["conflicts"]} == {"UNIT_INCONSISTENT"}, refused["conflicts"]
        assert quarantined(refused) == live, "both readable files of the inconsistent unit are copied before anything else"
        assert not Journal.load(path).settled
        accepted = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks", accept_conflicts=True)
        assert accepted["state"] == "kept" and accepted["conflicts"], accepted
        assert quarantined(accepted) == live
        assert accepted["quarantineDir"] != refused["quarantineDir"]
        assert Journal.load(path).doc["acceptedConflicts"] == accepted["conflicts"]
        RESULTS.append("mixed_quarantine")


def test_keep_does_not_settle_when_quarantine_fails() -> None:
    for failure, code in ((OSError(errno.EIO, "synthetic I/O error"), "RECOVERY_FAILED"),
                          (OSError(errno.ENOSPC, "synthetic full disk"), "DISK_FULL")):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            world, pack = build_world(root)
            path = mixed_restore(root, world, pack)
            before = snapshot(world, pack)
            for accept in (False, True):
                with patch.object(journal, "_copy_exclusive", side_effect=failure):
                    result = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks",
                                         accept_conflicts=accept)
                assert result["state"] == "recovery_conflict" and result["errorCode"] == code, (accept, result)
                record = Journal.load(path)
                assert not record.settled and "acceptedConflicts" not in record.doc, (accept, record.state)
                assert snapshot(world, pack) == before
            assert len(list_interrupted(stores(root))) == 1
            # The same request settles once the copy works again.
            done = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks", accept_conflicts=True)
            assert done["state"] == "kept" and done["quarantineDir"], done
            RESULTS.append(f"quarantine_failure:{code}")


# -- B2-M2 ---------------------------------------------------------------------------------------

def new_record(store: Path, name: str, world: Path, **kw) -> Journal:
    return Journal.create(store / name / "journal.json", job_id=name, kind="translate", world_dir=world, **kw)


def test_counter_is_durable_before_the_record_is_accepted() -> None:
    real = journal.atomic_write_text

    def fail_counter(path, text, *args, **kw):
        if Path(path).name.startswith("world-state"):
            raise OSError(failure["errno"], "counter unavailable")
        return real(path, text, *args, **kw)

    for failure, code in (({"errno": errno.ENOSPC}, "DISK_FULL"), ({"errno": errno.EIO}, "JOURNAL_WRITE_FAILED")):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            world, pack = build_world(root)
            baseline = snapshot(world, pack)
            with patch.object(journal, "atomic_write_text", fail_counter):
                try:
                    new_record(root / "a", "first", world)
                    raise AssertionError("a record without a durable counter must be refused")
                except JournalWriteFailed as exc:
                    assert exc.code == code, exc.code
                report = run_job(world, root, pack)
            assert report["status"] != "completed" and code in codes(report), (report["status"], report["errors"])
            assert snapshot(world, pack) == baseline, "no world byte may change"
            assert journal_files(root) == [] and list_interrupted(stores(root)) == []
            RESULTS.append(f"counter_refusal:{code}")


def test_counter_survives_deleted_backups_and_other_stores() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, _pack = build_world(root)
        store, other = root / "a", root / "b"
        first = new_record(store, "first", world)
        first.save()
        first.set_state("kept")
        assert first.generation == 1 and (store / f"world-state.{first.doc['worldKey']}.json").is_file()
        shutil.rmtree(store / "first")  # a settled set may be deleted; the counter is not part of it
        second = new_record(store, "second", world)
        assert second.generation == 2, second.generation
        # A higher counter retained in a store that has no records, reached from another store.
        journal._write_world_state(store, journal.world_key(world), 50, "retained", strict=True)
        third = new_record(other, "third", world, stores=[store])
        assert third.generation == 51, third.generation
        assert journal.read_world_state(other, first.doc["worldKey"])["generation"] == 51
        # The shared file an earlier release wrote is read too.
        legacy = root / "c"
        legacy.mkdir()
        (legacy / "world-state.json").write_text(json.dumps(
            {"worldKey": first.doc["worldKey"], "generation": 70, "lastSettledJobId": "old"}), encoding="utf-8")
        assert new_record(legacy, "fourth", world).generation == 71
        RESULTS.append("counter_retention")


def test_a_counter_that_cannot_be_read_never_lowers_the_generation() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, _pack = build_world(root)
        store = root / "a"
        key = journal.world_key(world)
        journal._write_world_state(store, key, 50, "retained", strict=True)
        counter = store / f"world-state.{key}.json"
        real_read_text = Path.read_text

        def failing_read(path: Path, *args, **kwargs):
            if path == counter:
                raise OSError(errno.EIO, "unreadable counter")
            return real_read_text(path, *args, **kwargs)

        # An I/O error: the number is unknown, so no record is accepted and the counter stays.
        with patch.object(Path, "read_text", failing_read):
            try:
                new_record(store, "first", world)
                raise AssertionError("a record must not be accepted over an unreadable counter")
            except JournalWriteFailed as exc:
                assert exc.code == "JOURNAL_WRITE_FAILED", exc.code
        assert journal_files(root) == []
        assert journal.read_world_state(store, key)["generation"] == 50
        # Damaged content: the lost number is passed by a time-based floor, never restarted at 1.
        counter.write_text("{not json", encoding="utf-8")
        record = new_record(store, "second", world)
        assert record.generation > 50, record.generation
        record.save()
        # Settling with a damaged counter in place writes nothing smaller over it.
        counter.write_text("{not json", encoding="utf-8")
        record.set_state("kept")
        assert counter.read_text(encoding="utf-8") == "{not json"
        assert new_record(store, "third", world).generation > record.generation
        RESULTS.append("counter_unreadable")


def test_worlds_sharing_one_store_have_their_own_counter() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        first_world, _ = build_world(root, external=False, name="one")
        second_world, _ = build_world(root, external=False, name="two")
        store = root / "shared"
        a = new_record(store, "job-a", first_world)
        a.save()
        b = new_record(store, "job-b", second_world)
        b.save()
        c = new_record(store, "job-c", first_world)
        files = sorted(path.name for path in store.glob("world-state.*.json"))
        assert len(files) == 2, files
        assert (a.generation, b.generation, c.generation) == (1, 1, 2)
        assert journal.read_world_state(store, journal.world_key(first_world))["generation"] == 2
        assert journal.read_world_state(store, journal.world_key(second_world))["generation"] == 1
        RESULTS.append("counter_per_world")


def main() -> None:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print(f"PASS {test.__name__}", flush=True)
    print(f"JOURNAL_RECONCILE_PASSED ({len(tests)} tests, {len(RESULTS)} rows)")


if __name__ == "__main__":
    main()
