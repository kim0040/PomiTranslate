"""Real process kills: a translate / restore / recovery job is killed with ``os._exit`` at a named
boundary (see journal_kill_helper.py); afterwards bootstrap must list it, rollback must restore the
byte-exact baseline, keep must settle a consistent state or report a conflict, and no orphan
temporary file may remain once the job is settled. Synthetic worlds only."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from journal_fixtures import (  # noqa: E402
    Crash, build_world, crash_job, journal_files, leftovers, run_job, snapshot, stores, world_is_readable,
)
from journal_kill_helper import KILLED  # noqa: E402
from mwt.journal import Journal, list_interrupted, recover_job  # noqa: E402

HELPER = Path(__file__).resolve().parent / "journal_kill_helper.py"
ROWS: list[tuple[str, str, str, str, str]] = []

# (boundary as POMI_TEST_KILL_AT, scenario, what the row exercises)
TRANSLATE_KILLS = [
    ("intent_persisted#1:translate", "after the intent was persisted"),
    ("backup_payload#2:translate", "after a backup payload"),
    ("prepared#1:translate", "after prepared"),
    ("between_targets#1:translate", "between the .mcc and the region publish"),
    ("after_replace#1:translate", "after a replace, before the read-back"),
    ("after_record#1:translate", "after the journal recorded an outcome"),
    ("after_record#4:translate", "after the journal recorded a later outcome"),
    ("before_replace#3:translate", "with a staged temp file beside the target"),
]


def spawn(scenario: str, root: Path, world: Path, pack: Path, kill_at: str, *extra: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, POMI_TEST_KILL_AT=kill_at, PYTHONDONTWRITEBYTECODE="1")
    done = subprocess.run([sys.executable, "-B", str(HELPER), scenario, str(root), str(world), str(pack), *extra],
                          env=env, capture_output=True, text=True, timeout=300)
    assert done.returncode == KILLED, (kill_at, done.returncode, done.stdout[-500:], done.stderr[-1500:])
    return done


def files_only(world: Path, pack: Path) -> dict[str, str]:
    """The snapshot without temporary files: settling a job removes the ones a killed write left."""
    return {key: value for key, value in snapshot(world, pack).items() if not key.endswith(".tmp")}


def only_open(root: Path) -> Path:
    open_jobs = [p for p in journal_files(root) if not Journal.load(p).settled and Journal.load(p).kind != "recovery"]
    assert len(open_jobs) == 1, [p.parent.name for p in journal_files(root)]
    return open_jobs[0]


def check_settled(root: Path, world: Path, pack: Path, label: str) -> None:
    assert list_interrupted(stores(root)) == [], (label, list_interrupted(stores(root)))
    assert not leftovers(world, pack), (label, leftovers(world, pack))
    world_is_readable(world)


def killed_translate_rollback_and_keep() -> None:
    for kill_at, what in TRANSLATE_KILLS:
        for mode in ("rollback", "keep"):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                world, pack = build_world(root)
                baseline = snapshot(world, pack)
                spawn("translate", root, world, pack, kill_at)
                label = (kill_at, mode)
                listed = list_interrupted(stores(root))
                assert len(listed) == 1 and listed[0]["blocking"] is True and listed[0]["kind"] == "translate", (label, listed)
                path = only_open(root)
                if mode == "rollback":
                    result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
                    assert result["state"] == "rolled_back" and not result["conflicts"], (label, result)
                    assert snapshot(world, pack) == baseline, (label, "rollback must restore every file byte-exact")
                    assert not (world / "region" / "c.0.0.mcc").exists(), (label, "a created .mcc must be gone")
                    outcome = "rolled back to baseline"
                else:
                    before = files_only(world, pack)
                    result = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks")
                    assert files_only(world, pack) == before, (label, "keep must not touch the world")
                    if result["state"] == "kept":
                        outcome = "kept (consistent)"
                    else:
                        assert result["state"] == "recovery_conflict", (label, result)
                        assert {c["code"] for c in result["conflicts"]} == {"UNIT_INCONSISTENT"}, (label, result)
                        assert [j["jobId"] for j in list_interrupted(stores(root))] == [path.parent.name]
                        again = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
                        assert again["state"] == "rolled_back" and snapshot(world, pack) == baseline, (label, again)
                        outcome = "conflict reported, then baseline"
                check_settled(root, world, pack, label)
                ROWS.append(("translate", what, kill_at, mode, outcome))


def killed_restore() -> None:
    for kill_at, what in [("between_targets#1:restore", "restore, between two targets"),
                          ("after_replace#1:restore", "restore, after a replace before the read-back"),
                          ("before_replace#2:restore", "restore, before a replace")]:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            world, pack = build_world(root)
            original = snapshot(world, pack)
            report = run_job(world, root, pack)
            translated = snapshot(world, pack)
            spawn("restore", root, world, pack, kill_at, report["backup_set_id"])
            listed = list_interrupted(stores(root))
            assert [j["kind"] for j in listed] == ["restore"], (kill_at, listed)
            path = only_open(root)
            result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
            assert result["state"] == "rolled_back" and snapshot(world, pack) == translated, (kill_at, result)
            check_settled(root, world, pack, kill_at)
            assert original != translated
            ROWS.append(("restore", what, kill_at, "rollback", "back to the pre-restore (translated) world"))


def killed_recovery() -> None:
    cases = [
        ("before_replace#1:recovery", "rollback", "recovery, between its backup and its first rollback write"),
        ("after_replace#1:recovery", "rollback", "recovery, after a rollback write before the read-back"),
        ("recovery_quarantined#1", "rollback", "recovery, after quarantine"),
        ("keep_before_settle#1", "keep", "keep, before it settles"),
        ("keep_quarantined#1", "keep", "keep, after quarantine"),
    ]
    for kill_at, mode, what in cases:
        for after_kill in ("rollback", "keep"):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                world, pack = build_world(root)
                baseline = snapshot(world, pack)
                crash_job(world, root, pack, Crash("before_final_state", 1))
                path = only_open(root)
                spawn("recover", root, world, pack, kill_at, str(path), mode)
                assert not Journal.load(path).settled, (kill_at, "a killed recovery leaves the job open")
                label = (kill_at, after_kill)
                if after_kill == "rollback":
                    result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
                    assert result["state"] == "rolled_back" and snapshot(world, pack) == baseline, (label, result)
                    outcome = "baseline after the next recovery"
                else:
                    before = files_only(world, pack)
                    result = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks")
                    assert files_only(world, pack) == before, (label, "keep must not touch the world")
                    if result["state"] != "kept":
                        assert result["state"] == "recovery_conflict" and {c["code"] for c in result["conflicts"]} <= {
                            "UNIT_INCONSISTENT", "RECOVERY_CONFLICT", "MISSING"}, (label, result)
                        result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
                        assert result["state"] == "rolled_back" and snapshot(world, pack) == baseline, (label, result)
                        outcome = "keep refused, then baseline"
                    else:
                        outcome = "kept"
                check_settled(root, world, pack, label)
                ROWS.append(("recovery", what, kill_at, after_kill, outcome))


def main() -> None:
    for step in (killed_translate_rollback_and_keep, killed_restore, killed_recovery):
        step()
        print(f"PASS {step.__name__}", flush=True)
    print("| job | boundary | POMI_TEST_KILL_AT | then | result |")
    print("|---|---|---|---|---|")
    for row in ROWS:
        print("| " + " | ".join(row) + " |")
    print(f"JOURNAL_KILL_PASSED ({len(ROWS)} real-kill rows)")


if __name__ == "__main__":
    main()
