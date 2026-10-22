"""Fault-injection matrix for the write transaction and its recovery (synthetic worlds only)."""
from __future__ import annotations

import errno
import json
import shutil
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from journal_fixtures import (  # noqa: E402
    Census, Crash, SimulatedCrash, build_world, crash_job, hook, journal_files, leftovers, run_job, snapshot, stores,
    world_is_readable,
)
from mwt import journal  # noqa: E402
from mwt.journal import JournalError, find_journal, list_interrupted, recover_job  # noqa: E402
from mwt.locking import TargetLocked, WorldWriteLocked, hold_world  # noqa: E402
from mwt.safety import list_backup_sets  # noqa: E402

POINTS = [
    "intent_persisted", "backup_payload", "prepared", "before_replace", "after_replace", "after_verify",
    "between_targets", "unit_done", "before_final_state",
]
MATRIX_ROWS: list[tuple[str, int, str, str]] = []


def sha(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def only_job(root: Path) -> Path:
    files = journal_files(root)
    assert len(files) == 1, files
    return files[0]


def census() -> dict[tuple[str, str | None], int]:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        counter = Census()
        with hook(counter):
            report = run_job(world, root, pack)
        assert report["status"] == "completed" and report["write_state"] == "committed", report
        return counter.counts


def translated_snapshot() -> dict[str, str]:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        run_job(world, root, pack)
        return {key: value for key, value in snapshot(world, pack).items()}


def crash_and_recover(point: str, nth: int) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        baseline = snapshot(world, pack)
        crash_job(world, root, pack, Crash(point, nth))
        path = only_job(root)
        summary = journal.Journal.load(path).summary()
        interrupted = list_interrupted(stores(root))
        if journal.Journal.load(path).settled:
            raise AssertionError(f"{point}#{nth}: a crashed job must not look settled")
        assert [item["jobId"] for item in interrupted] == [summary["jobId"]], (point, nth, interrupted)
        assert interrupted[0]["legacy"] is False and interrupted[0]["kind"] == "translate"
        # A new job refuses to start on top of the unsettled one.
        blocked = run_job(world, root, pack, expected_world_fingerprint="")
        assert blocked["status"] == "failed" and blocked["errors"][0]["code"] == "RECOVERY_REQUIRED", (point, nth, blocked["errors"])

        result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert result["state"] == "rolled_back" and not result["conflicts"], (point, nth, result)
        restored = snapshot(world, pack)
        assert restored == baseline, (point, nth, {k for k in restored if restored[k] != baseline.get(k)})
        assert not leftovers(world, pack), leftovers(world, pack)
        world_is_readable(world)
        assert journal.Journal.load(path).settled
        assert list_interrupted(stores(root)) == []
        MATRIX_ROWS.append((point, nth, "rolled_back", "baseline"))


def keep_outcome(path: Path, root: Path, pack: Path, world: Path, baseline: dict, label: tuple) -> str:
    """Keep is verify-only: it settles a consistent world as ``kept`` and reports an inconsistent one
    (``UNIT_INCONSISTENT``, job still open and blocking), never touching a file. Returns the state."""
    before = snapshot(world, pack)
    result = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks")
    assert snapshot(world, pack) == before, (label, "keep must not change the world")
    if result["state"] == "kept":
        assert not result["conflicts"], (label, result)
        assert journal.Journal.load(path).settled
        assert list_interrupted(stores(root)) == []
    else:
        assert result["state"] == "recovery_conflict", (label, result)
        assert result["conflicts"] and {c["code"] for c in result["conflicts"]} == {"UNIT_INCONSISTENT"}, (label, result)
        assert not journal.Journal.load(path).settled
        assert [item["jobId"] for item in list_interrupted(stores(root)) if item["kind"] != "recovery"] == [path.parent.name]
        again = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert again["state"] == "rolled_back", (label, again)
        assert snapshot(world, pack) == baseline, (label, "rollback after a refused keep reaches the baseline")
    world_is_readable(world)
    return result["state"]


def crash_and_keep(point: str, nth: int) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        baseline = snapshot(world, pack)
        crash_job(world, root, pack, Crash(point, nth))
        state = keep_outcome(only_job(root), root, pack, world, baseline, (point, nth))
        MATRIX_ROWS.append((point, nth, f"keep -> {state}", "consistent" if state == "kept" else "refused, then baseline"))


def test_clean_job_commits() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        before = snapshot(world, pack)
        report = run_job(world, root, pack)
        after = snapshot(world, pack)
        assert report["status"] == "completed" and report["write_state"] == "committed"
        assert report["changed_file_count"] == 7
        assert {k for k in after if after[k] != before.get(k)} == {
            "region/r.0.0.mca", "region/r.1.0.mca", "region/c.0.0.mcc", "region/c.64.0.mcc", "resources.zip", "external:shared-world.zip",
        }
        document = json.loads(only_job(root).read_text("utf-8"))
        assert document["state"] == "committed" and document["settled"] is True
        assert len(document["units"]) == 5
        assert all(t["outcome"] == "verified" for unit in document["units"] for t in unit["targets"])
        assert not (only_job(root).parent / "staging").exists()
        entry = list_backup_sets(world, stores(root))[0]
        assert entry["journalState"] == "committed" and entry["legacy"] is False
        assert list_interrupted(stores(root)) == []
        MATRIX_ROWS.append(("(none)", 0, "committed", "—"))


def test_matrix() -> None:
    counts = census()
    for point in POINTS:
        total = sum(value for (name, _kind), value in counts.items() if name == point)
        assert total > 0, f"fault point {point} was never reached"
        for nth in range(1, total + 1):
            crash_and_recover(point, nth)
            crash_and_keep(point, nth)


def recovery_points() -> list[tuple[str, int]]:
    """Every boundary a recovery of the standard crash passes, with how often."""
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        crash_job(world, root, pack, Crash("before_final_state", 1))
        counter = Census()
        with hook(counter):
            recover_job(only_job(root), "rollback", authorized_external=[pack], lock_dir=root / "locks")
        return [(name, total) for (name, kind), total in sorted(counter.counts.items(), key=str) if kind == "recovery" or name.startswith("recovery_")]


def test_recovery_can_be_interrupted() -> None:
    """The recovery itself is cut off at every boundary; running it again must still reach the baseline."""
    points = recovery_points()
    names = {name for name, _ in points}
    assert {"recovery_started", "recovery_quarantined", "backup_payload", "before_replace", "after_replace", "after_verify"} <= names, names
    for name, total in points:
        for nth in range(1, total + 1):
            for mode in ("rollback", "keep"):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    world, pack = build_world(root)
                    baseline = snapshot(world, pack)
                    crash_job(world, root, pack, Crash("before_final_state", 1))
                    path = only_job(root)
                    crash = Crash(name, nth, kind=None if name.startswith("recovery_") else "recovery")
                    with hook(crash):
                        try:
                            recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
                        except SimulatedCrash:
                            pass
                    assert crash.fired, (name, nth)
                    assert not journal.Journal.load(path).settled, "an interrupted recovery leaves the job open"
                    # The job is still listed (once), and a new translation still waits for it.
                    listed = [item["jobId"] for item in list_interrupted(stores(root)) if item["kind"] != "recovery"]
                    assert listed == [path.parent.name], (name, nth, listed)
                    if mode == "rollback":
                        result = recover_job(path, mode, authorized_external=[pack], lock_dir=root / "locks")
                        assert not result["conflicts"], (name, nth, mode, result)
                        assert result["state"] == "rolled_back", (name, nth, result)
                        assert snapshot(world, pack) == baseline, (name, nth, "rollback after an interrupted recovery")
                        outcome = "baseline"
                    else:
                        state = keep_outcome(path, root, pack, world, baseline, (name, nth))
                        outcome = "kept as is" if state == "kept" else "refused, then baseline"
                    assert list_interrupted(stores(root)) == [], (name, nth, mode, list_interrupted(stores(root)))
                    world_is_readable(world)
                    MATRIX_ROWS.append((f"recovery:{name}", nth, f"then {mode}", outcome))


def test_foreign_edit_is_quarantined() -> None:
    for point, nth in [("after_verify", 1), ("between_targets", 1)]:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            world, pack = build_world(root)
            baseline = snapshot(world, pack)
            crash_job(world, root, pack, Crash(point, nth))
            path = only_job(root)
            document = json.loads(path.read_text("utf-8"))
            # A target that was published (the file is at its postimage, whatever the record says):
            # someone else edits it after the crash.
            def live_of(t: dict) -> Path:
                return world / t["path"] if t["rootKind"] == "world" else Path(t["externalTarget"])

            target = next(
                t for unit in document["units"] for t in unit["targets"]
                if not t["post"]["absent"] and live_of(t).is_file() and sha(live_of(t)) == t["post"]["sha256"]
                and t["post"]["sha256"] != (t["preimage"]["sha256"] if not t["preimage"]["absent"] else None)
            )
            live = live_of(target)
            foreign = b"hand edited after the crash"
            live.write_bytes(foreign)
            result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
            assert result["state"] == "recovery_conflict", result
            assert [c["code"] for c in result["conflicts"]] == ["RECOVERY_CONFLICT"], result
            assert live.read_bytes() == foreign, "foreign bytes must never be overwritten"
            quarantined = Path(result["quarantineDir"])
            assert any(p.read_bytes() == foreign for p in quarantined.rglob("*") if p.is_file()), "foreign bytes must be preserved"
            others = {k: v for k, v in snapshot(world, pack).items() if k != (target["path"] if target["rootKind"] == "world" else f"external:{pack.name}")}
            assert all(baseline[k] == v for k, v in others.items()), "every other file is back to its baseline"
            MATRIX_ROWS.append((f"{point} + foreign edit", nth, "recovery_conflict", "foreign bytes kept"))


def test_enospc_leaves_no_torn_file() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        baseline = snapshot(world, pack)
        real = journal.WriteTransaction._write_file
        calls = {"n": 0}

        def failing(self, spec, path, info):  # the second publish runs out of space
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError(errno.ENOSPC, "No space left on device")
            return real(self, spec, path, info)

        with patch.object(journal.WriteTransaction, "_write_file", failing):
            report = run_job(world, root, pack)
        assert report["status"] in {"partial", "needs_retry", "failed"}, report["status"]
        assert any(e.get("code") == "DISK_FULL" for e in report["errors"]), report["errors"]
        assert not leftovers(world, pack), leftovers(world, pack)
        world_is_readable(world)
        path = only_job(root)
        state = journal.Journal.load(path).state
        assert state in {"partial", "rolled_back"}, state
        if not journal.Journal.load(path).settled:
            result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
            assert result["state"] == "rolled_back"
        else:
            recover = [item for item in list_interrupted(stores(root))]
            for item in recover:
                recover_job(find_journal(item["jobId"], stores(root)), "rollback", authorized_external=[pack], lock_dir=root / "locks")
        assert list_interrupted(stores(root)) == []
        assert snapshot(world, pack) == baseline, "after recovery every file is byte-exact the baseline"
        assert not leftovers(world, pack), leftovers(world, pack)
        MATRIX_ROWS.append(("ENOSPC at 2nd publish", 2, state, "DISK_FULL, no torn files, baseline after recovery"))


def test_shared_external_zip_lock() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world_a, pack = build_world(root, name="a")
        world_b, _unused = build_world(root, name="b", external=False)
        lock_dir = root / "locks"
        with hold_world(world_a, "translate", external_targets=[pack], lock_dir=lock_dir):
            try:
                with hold_world(world_b, "translate", external_targets=[pack], lock_dir=lock_dir):
                    raise AssertionError("a second world must not hold the same external pack")
            except TargetLocked:
                pass
            # The refusal left world b free for everything else.
            with hold_world(world_b, "translate"):
                pass
        # A translation of world b that uses the locked pack is refused too.
        with hold_world(world_a, "translate", external_targets=[pack], lock_dir=root / "appdata" / "locks"):
            from journal_fixtures import config_for
            from mc_world_translator import WorldTranslator

            config = config_for(world_b, root, pack)
            config["resource_pack"]["zip_paths"] = [str(pack)]
            report = WorldTranslator(config).run()
            assert report["status"] == "locked" and report["errors"][0]["code"] == "TARGET_LOCKED", report["errors"]
        # Once released the lock is free again.
        with hold_world(world_b, "translate", external_targets=[pack], lock_dir=lock_dir):
            pass
        MATRIX_ROWS.append(("shared external ZIP", 0, "TARGET_LOCKED", "second job refused"))


def test_recovery_refuses_under_guards() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        crash_job(world, root, pack, Crash("between_targets", 1))
        path = only_job(root)
        before = snapshot(world, pack)
        with hold_world(world, "translate"):
            try:
                recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
                raise AssertionError("recovery must wait for the world lock")
            except WorldWriteLocked:
                pass
        assert snapshot(world, pack) == before
        try:
            find_journal("does-not-exist", stores(root))
            raise AssertionError("unknown job")
        except JournalError as exc:
            assert exc.code == "JOURNAL_NOT_FOUND"
        recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")


def test_unauthorized_external_target_is_refused() -> None:
    from mwt.safety import ExternalTargetError

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        crash_job(world, root, pack, Crash("after_verify", 7))
        path = only_job(root)
        before = snapshot(world, pack)
        try:
            recover_job(path, "rollback", authorized_external=[], lock_dir=root / "locks")
            raise AssertionError("a record cannot grant itself access to a file outside the world")
        except ExternalTargetError:
            pass
        assert snapshot(world, pack) == before and not journal.Journal.load(path).settled


def test_legacy_set_is_flagged() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        run_job(world, root, pack)
        only_job(root).unlink()
        entry = list_backup_sets(world, stores(root))[0]
        assert entry["legacy"] is True and entry["journalState"] is None
        assert list_interrupted(stores(root)) == []


def test_damaged_journal_is_listed_not_hidden() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        crash_job(world, root, pack, Crash("prepared", 1))
        path = only_job(root)
        path.write_text("{ not json", encoding="utf-8")
        listed = list_interrupted(stores(root))
        assert len(listed) == 1 and listed[0]["needsAttention"] is True
        try:
            recover_job(path, "rollback", lock_dir=root / "locks")
            raise AssertionError("a damaged record must not be acted on")
        except JournalError as exc:
            assert exc.code == "JOURNAL_INVALID", exc.code


def test_world_changed_since_scan_is_refused() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root)
        original = run_job.__globals__["config_for"](world, root, pack)
        (world / "region" / "r.9.9.mca").write_bytes((world / "region" / "r.1.0.mca").read_bytes())
        baseline = snapshot(world, pack)
        from mc_world_translator import WorldTranslator

        report = WorldTranslator(original).run()
        assert report["status"] != "completed", report["status"]
        assert any(e.get("code") == "WORLD_CHANGED" for e in report["errors"]), report["errors"]
        assert snapshot(world, pack) == baseline


def main() -> None:
    tests = [
        test_clean_job_commits, test_matrix, test_recovery_can_be_interrupted, test_foreign_edit_is_quarantined, test_enospc_leaves_no_torn_file,
        test_shared_external_zip_lock, test_recovery_refuses_under_guards, test_unauthorized_external_target_is_refused,
        test_legacy_set_is_flagged, test_damaged_journal_is_listed_not_hidden, test_world_changed_since_scan_is_refused,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print("| fault point | occurrence | result | outcome |")
    print("|---|---|---|---|")
    for point, nth, result, outcome in MATRIX_ROWS:
        print(f"| {point} | {nth} | {result} | {outcome} |")
    print(f"JOURNAL_PASSED ({len(tests)} tests, {len(MATRIX_ROWS)} matrix rows)")


if __name__ == "__main__":
    main()
