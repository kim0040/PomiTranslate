"""Real process kills: a translate / restore / recovery / resume job is killed with ``os._exit`` at a
named boundary (see journal_kill_helper.py); afterwards bootstrap must list it, rollback must restore the
byte-exact baseline, keep must settle a consistent state or report a conflict, and no orphan temporary
file may remain once the job is settled. Synthetic worlds only.

Besides the journal's own boundaries, the cuts sit inside the common durable replace: with the new file
complete and flushed beside its target (the named temporary exists, the target is unchanged), and right
after the rename (the target is new, the directory entry is not flushed yet)."""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from journal_fixtures import (  # noqa: E402
    Crash, build_world, checkpoint_runtime, crash_job, journal_files, leftovers, partial_job, run_job, snapshot, stores,
    world_is_readable,
)
from journal_kill_helper import KILLED  # noqa: E402
from mwt.journal import Journal, JournalError, list_interrupted, recover_job, world_key  # noqa: E402

HELPER = Path(__file__).resolve().parent / "journal_kill_helper.py"
ROWS: list[tuple[str, str, str, str, str]] = []

# (boundary as POMI_TEST_KILL_AT, only count replaces of this file name, what the row exercises)
TRANSLATE_KILLS = [
    ("intent_persisted#1:translate", "", "after the intent was persisted"),
    ("backup_payload#2:translate", "", "after a backup payload"),
    ("prepared#1:translate", "", "after prepared"),
    ("between_targets#1:translate", "", "between the .mcc and the region publish"),
    ("after_replace#1:translate", "", "after a replace, before the read-back"),
    ("after_record#1:translate", "", "after the journal recorded an outcome"),
    ("after_record#4:translate", "", "after the journal recorded a later outcome"),
    ("before_replace#3:translate", "", "before the writer has staged its temp file (no temp exists yet)"),
    ("durable_before_replace#1", "c.0.0.mcc", "created .mcc: temp complete beside it, not renamed"),
    ("durable_after_replace#1", "c.0.0.mcc", "created .mcc: renamed, directory entry not flushed"),
    ("durable_before_replace#1", "r.0.0.mca", "region: temp complete beside it, not renamed"),
    ("durable_after_replace#1", "r.0.0.mca", "region: renamed, directory entry not flushed"),
    ("durable_before_replace#1", "shared-world.zip", "external pack: temp complete beside it, not renamed"),
    ("durable_after_replace#1", "shared-world.zip", "external pack: renamed, directory entry not flushed"),
]

RESTORE_KILLS = [
    ("between_targets#1:restore", "", "restore, between two targets"),
    ("after_replace#1:restore", "", "restore, after a replace before the read-back"),
    ("before_replace#2:restore", "", "restore, before a replace"),
    ("durable_before_replace#1", "r.0.0.mca", "restore of a region: temp complete beside it, not renamed"),
    ("durable_after_replace#1", "r.0.0.mca", "restore of a region: renamed, directory entry not flushed"),
    ("durable_before_replace#1", "shared-world.zip", "restore of the external pack: temp complete, not renamed"),
    ("durable_after_replace#1", "shared-world.zip", "restore of the external pack: renamed, entry not flushed"),
]


def spawn(scenario: str, root: Path, world: Path, pack: Path, kill_at: str, *extra: str, target: str = "") -> subprocess.CompletedProcess:
    env = dict(os.environ, POMI_TEST_KILL_AT=kill_at, PYTHONDONTWRITEBYTECODE="1")
    env.pop("POMI_TEST_KILL_TARGET", None)
    if target:
        env["POMI_TEST_KILL_TARGET"] = target
    # The base interpreter, so the process that is killed is the interpreter itself and not a venv launcher
    # in front of it; it is given the packages of the running interpreter through PYTHONPATH.
    executable = getattr(sys, "_base_executable", None) or sys.executable
    env["PYTHONPATH"] = os.pathsep.join(item for item in sys.path if item)
    done = subprocess.run([executable, "-B", str(HELPER), scenario, str(root), str(world), str(pack), *extra],
                          env=env, capture_output=True, text=True, timeout=300)
    assert done.returncode == KILLED, (kill_at, target, done.returncode, done.stdout[-500:], done.stderr[-1500:])
    return done


def files_only(world: Path, pack: Path) -> dict[str, str]:
    """The snapshot without temporary files: settling a job removes the ones a killed write left."""
    return {key: value for key, value in snapshot(world, pack).items() if not key.endswith(".tmp")}


def only_open(root: Path) -> Path:
    open_jobs = [p for p in journal_files(root) if not Journal.load(p).settled and Journal.load(p).kind != "recovery"]
    assert len(open_jobs) == 1, [p.parent.name for p in journal_files(root)]
    return open_jobs[0]


def check_settled(root: Path, world: Path, pack: Path, label: object) -> None:
    assert list_interrupted(stores(root)) == [], (label, list_interrupted(stores(root)))
    assert not leftovers(world, pack), (label, leftovers(world, pack))
    world_is_readable(world)


def live(world: Path, pack: Path, name: str) -> Path:
    return pack if name == pack.name else world / "region" / name


def digest(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def staged_temps(path: Path) -> list[Path]:
    """The temporary files a durable write names after ``path``, beside it."""
    return sorted(path.parent.glob(f".{path.name}.*.tmp"))


def check_cut(kill_at: str, path: Path, before: str | None) -> None:
    """What the process left at a cut inside the durable replace of ``path`` (``before``: its hash then)."""
    if kill_at.startswith("durable_before_replace"):
        assert staged_temps(path), (kill_at, path.name, "the named temp must exist beside the target at the cut")
        assert digest(path) == before, (kill_at, path.name, "the target must still be what it was")
    else:
        assert not staged_temps(path), (kill_at, path.name, "the temp was renamed away")
        assert digest(path) is not None and digest(path) != before, (kill_at, path.name, "the target must be the new file")


def killed_translate_rollback_and_keep() -> None:
    for kill_at, target, what in TRANSLATE_KILLS:
        for mode in ("rollback", "keep"):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                world, pack = build_world(root)
                baseline = snapshot(world, pack)
                before = digest(live(world, pack, target)) if target else None
                spawn("translate", root, world, pack, kill_at, target=target)
                label = (kill_at, target, mode)
                if target:
                    check_cut(kill_at, live(world, pack, target), before)
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
                    kept_before = files_only(world, pack)
                    result = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks")
                    assert files_only(world, pack) == kept_before, (label, "keep must not touch the world")
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
                ROWS.append(("translate", what, kill_at + (f" [{target}]" if target else ""), mode, outcome))


def killed_restore() -> None:
    for kill_at, target, what in RESTORE_KILLS:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            world, pack = build_world(root)
            original = snapshot(world, pack)
            report = run_job(world, root, pack)
            translated = snapshot(world, pack)
            before = digest(live(world, pack, target)) if target else None
            spawn("restore", root, world, pack, kill_at, report["backup_set_id"], target=target)
            if target:
                check_cut(kill_at, live(world, pack, target), before)
            listed = list_interrupted(stores(root))
            assert [j["kind"] for j in listed] == ["restore"], (kill_at, listed)
            path = only_open(root)
            result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
            assert result["state"] == "rolled_back" and snapshot(world, pack) == translated, (kill_at, result)
            check_settled(root, world, pack, kill_at)
            assert original != translated
            ROWS.append(("restore", what, kill_at + (f" [{target}]" if target else ""), "rollback",
                         "back to the pre-restore (translated) world"))


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


def quarantined_files(path: Path) -> dict[str, bytes]:
    return {str(item.relative_to(path)): item.read_bytes()
            for item in path.rglob("quarantine/*/*/*") if item.is_file()} if path.is_dir() else {}


def killed_quarantine() -> None:
    """The conflicts are real: foreign bytes sit in two files, so a quarantine copy has to be made
    (and the process dies after the first copy, after all of them, or before settling)."""
    foreign_pack, foreign_zip = b"foreign pack edit", b"foreign resources edit"
    cases = [
        ("quarantine_copied#1", "rollback", 1, "recovery, after the first of two quarantine copies"),
        ("recovery_quarantined#1", "rollback", 2, "recovery, after every quarantine copy"),
        ("keep_quarantined#1", "keep", 2, "keep, after every quarantine copy"),
    ]
    for kill_at, mode, copies, what in cases:
        for after_kill in ("rollback", "keep"):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                world, pack = build_world(root)
                baseline = snapshot(world, pack)
                crash_job(world, root, pack, Crash("before_final_state", 1))
                path = only_open(root)
                pack.write_bytes(foreign_pack)
                (world / "resources.zip").write_bytes(foreign_zip)
                foreign = snapshot(world, pack)
                spawn("recover", root, world, pack, kill_at, str(path), mode)
                label = (kill_at, after_kill)
                assert not Journal.load(path).settled, (label, "a killed recovery leaves the job open")
                copied = quarantined_files(path.parent)
                assert len(copied) == copies and set(copied.values()) <= {foreign_pack, foreign_zip}, (label, list(copied))
                if after_kill == "rollback":
                    result = recover_job(path, "rollback", authorized_external=[pack], lock_dir=root / "locks")
                    assert result["state"] == "recovery_conflict", (label, result)
                    assert {c["code"] for c in result["conflicts"]} == {"RECOVERY_CONFLICT"} and len(result["conflicts"]) == 2
                    # Everything that was not edited is back at the baseline; the two foreign files stay.
                    expected = {key: (foreign[key] if key in {"resources.zip", f"external:{pack.name}"} else value)
                                for key, value in baseline.items()}
                    assert snapshot(world, pack) == expected, (label, "only the edited files may differ from the baseline")
                    outcome = "baseline except the two foreign files, which stay"
                else:
                    result = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks")
                    assert result["state"] == "recovery_conflict" and len(result["conflicts"]) == 2, (label, result)
                    assert {item.read_bytes() for item in Path(result["quarantineDir"]).rglob("*") if item.is_file()} == {
                        foreign_pack, foreign_zip}, label
                    assert files_only(world, pack) == {k: v for k, v in foreign.items() if not k.endswith(".tmp")}
                    accepted = recover_job(path, "keep", authorized_external=[pack], lock_dir=root / "locks", accept_conflicts=True)
                    assert accepted["state"] == "kept", (label, accepted)
                    outcome = "conflicts reported and quarantined, settled once accepted"
                assert not leftovers(world, pack), (label, leftovers(world, pack))
                ROWS.append(("quarantine", what, kill_at, after_kill, outcome))


# The supersession handshake of a resume, cut at both sides of each durable save. Counted among the
# replaces of one file name in the resuming process (the sequence is printed by the test):
#   world-state.<key>.json  counter for the continuation       journal.json #1  the continuation's record
#   journal.json #2         the old job marked superseded      journal.json #3/#4  prepared / committing
#   r.1.0.mca #1            the continuation's first world write
HANDSHAKE = [
    ("durable_before_replace#1", "world-state.{key}.json", "counter of the continuation staged", "none"),
    ("durable_before_replace#1", "journal.json", "continuation's record staged", "none"),
    ("durable_after_replace#1", "journal.json", "continuation saved, old job still open", "unpublished"),
    ("durable_before_replace#2", "journal.json", "old job's supersession staged", "unpublished"),
    ("durable_after_replace#2", "journal.json", "old job superseded", "unpublished"),
    ("durable_before_replace#1", "r.1.0.mca", "continuation's first world write staged (nothing published)", "unpublished"),
    ("durable_after_replace#1", "r.1.0.mca", "continuation's first world write renamed (published)", "published"),
]


def killed_resume_handshake() -> None:
    for kill_at, target_pattern, what, expect in HANDSHAKE:
        if expect == "published":
            modes = ("rollback_new", "keep_new")
        else:
            modes = ("rollback_old", "keep_old", "resume_again") + (("rollback_new_then_old",) if expect == "unpublished" else ())
        for mode in modes:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                world, pack = build_world(root)
                baseline = snapshot(world, pack)
                report = partial_job(world, root, pack)
                old_id = report["backup_set_id"]
                mid = snapshot(world, pack)
                target = target_pattern.format(key=world_key(world))
                label = (kill_at, target, mode)
                is_world_file = target.endswith(".mca")
                before = digest(world / "region" / target) if is_world_file else None
                spawn("resume", root, world, pack, kill_at, target=target)
                if is_world_file:
                    check_cut(kill_at, world / "region" / target, before)
                paths = {p.parent.name: p for p in journal_files(root)}
                old_path = paths[old_id]
                new = [p for name, p in paths.items() if name != old_id and Journal.load(p).doc.get("supersedes") == old_id]
                assert len(new) == (0 if expect == "none" else 1), (label, sorted(paths))
                if expect != "published":
                    assert files_only(world, pack) == mid, (label, "nothing was published yet")
                new_path = new[0] if new else None
                auth = dict(authorized_external=[pack], lock_dir=root / "locks")
                if mode == "rollback_old":
                    result = recover_job(old_path, "rollback", **auth)
                    assert result["state"] == "rolled_back" and not result["conflicts"], (label, result)
                    assert snapshot(world, pack) == baseline, (label, "the original world, byte-exact")
                    outcome = "original pre-resume world, byte-exact"
                elif mode == "keep_old":
                    result = recover_job(old_path, "keep", **auth)
                    assert result["state"] == "kept" and not result["conflicts"], (label, result)
                    assert files_only(world, pack) == mid, (label, "the partial world of the first job, unchanged")
                    outcome = "kept: the first job's partial world, consistent"
                elif mode == "resume_again":
                    again = run_job(world, root, pack, **checkpoint_runtime(root, resume=True))
                    assert again["status"] == "completed", (label, again["status"], again["errors"])
                    outcome = "resume runs again and completes"
                elif mode == "rollback_new_then_old":
                    result = recover_job(new_path, "rollback", **auth)
                    assert result["state"] == "rolled_back" and result["settledBy"] == "unpublished_continuation", (label, result)
                    assert snapshot(world, pack) == mid
                    assert [j["jobId"] for j in list_interrupted(stores(root))] == [old_id], (label, "the first job is open again")
                    result = recover_job(old_path, "rollback", **auth)
                    assert result["state"] == "rolled_back" and snapshot(world, pack) == baseline, (label, result)
                    outcome = "settled, the first job open again, then the original world"
                elif mode == "rollback_new":
                    for refused in ("rollback", "keep"):
                        try:
                            recover_job(old_path, refused, **auth)
                            raise AssertionError("a superseded job whose continuation published must stay refused")
                        except JournalError as exc:
                            assert exc.code == "JOURNAL_SUPERSEDED" and exc.job_ids == [new_path.parent.name], (label, exc.code)
                    result = recover_job(new_path, "rollback", **auth)
                    assert result["state"] == "rolled_back" and snapshot(world, pack) == mid, (label, result)
                    outcome = "refusal stays; the continuation rolls back to the first job's partial world"
                else:  # keep_new
                    published = files_only(world, pack)
                    result = recover_job(new_path, "keep", **auth)
                    assert result["state"] == "kept" and files_only(world, pack) == published, (label, result)
                    outcome = "refusal stays; the continuation keeps its consistent world"
                check_settled(root, world, pack, label)
                ROWS.append(("resume", what, kill_at + f" [{target}]", mode, outcome))


def main() -> None:
    for step in (killed_translate_rollback_and_keep, killed_restore, killed_recovery, killed_quarantine,
                 killed_resume_handshake):
        step()
        print(f"PASS {step.__name__}", flush=True)
    print("| job | boundary | POMI_TEST_KILL_AT [file] | then | result |")
    print("|---|---|---|---|---|")
    for row in ROWS:
        print("| " + " | ".join(row) + " |")
    print(f"JOURNAL_KILL_PASSED ({len(ROWS)} real-kill rows)")


if __name__ == "__main__":
    main()
