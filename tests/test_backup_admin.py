"""Backup admin: delete, prune and usage of backup sets, with the world write lock and last-copy rule."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mwt import backup_admin, journal as journal_module, safety  # noqa: E402
from mwt.backup_admin import BackupAdminError, backup_usage, delete_backup, last_copy_ids, plan_prune, prune_backups  # noqa: E402
from mwt.locking import MinecraftSessionLocks, WorldWriteLock  # noqa: E402
from mwt.safety import BackupSet, backup_store, legacy_backup_store, list_backup_sets  # noqa: E402

HOLDER = """
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from mwt.locking import WorldWriteLock
guard = WorldWriteLock(Path(sys.argv[2]))
guard.acquire()
print("held", flush=True)
time.sleep(120)
"""

_counter = [0]


def raises(kind: type, function, *args):
    try:
        function(*args)
    except kind as exc:
        return exc
    raise AssertionError(f"{kind.__name__} was not raised")


def make_world(tmp: Path, name: str) -> tuple[Path, Path]:
    world = tmp / name / "world"
    (world / "region").mkdir(parents=True)
    (world / "level.dat").write_bytes(b"\x1f\x8b" + b"L" * 98)  # 100 bytes
    (world / "region" / "r.0.0.mca").write_bytes(b"\x00" * 4096)
    data = tmp / name / "data"
    data.mkdir()
    return world, data


def make_set(world: Path, store: Path, kind: str, day: int) -> str:
    """A real, verified backup set whose manifest says it was created on 2026-01-<day>."""
    backup = BackupSet.new(world, kind=kind, store=store)
    backup.add(world / "level.dat", commit=False)
    backup.add(world / "region" / "r.0.0.mca")
    backup.verify()
    document = json.loads(backup.manifest_path.read_text(encoding="utf-8"))
    document["createdAt"] = f"2026-01-{day:02d}T10:00:00+00:00"
    backup.manifest_path.write_text(json.dumps(document), encoding="utf-8")
    return backup.backup_id


def point_latest(store: Path, backup_id: str) -> None:
    (store / "latest.json").write_text(json.dumps({"backupSetId": backup_id}), encoding="utf-8")


def latest(store: Path) -> str | None:
    path = store / "latest.json"
    return json.loads(path.read_text(encoding="utf-8"))["backupSetId"] if path.exists() else None


def ids(store: Path) -> set[str]:
    return {item["backupSetId"] for item in list_backup_sets(store.parent, [store])}


def request(world: Path, backup_id: str, **extra) -> dict:
    return {"worldDir": str(world), "backupSetId": backup_id, **extra}


def write_journal(world: Path, store: Path, backup_id: str, state: str, *, settled: bool | None = None) -> Path:
    """A real recovery record inside a backup set (the set id is the job id), in the given state."""
    path = store / backup_id / journal_module.JOURNAL_NAME
    record = journal_module.Journal.create(path, job_id=backup_id, kind="translate", world_dir=world)
    record.set_state(state, settled=settled)
    return path


def listing(*rows: tuple[str, str, str, object]) -> list[dict]:
    return [{"backupSetId": i, "kind": k, "createdAt": c, "journalState": j, "verified": True, "sizeBytes": 1}
            for i, k, c, j in rows]


def test_last_copy_rule_on_plain_dicts(tmp: Path) -> None:
    assert last_copy_ids([]) == set()
    only_recovery = listing(("r1", "recovery", "2026-01-01", None))
    assert last_copy_ids(only_recovery) == set()
    one = listing(("t1", "translation", "2026-01-01", None))
    assert last_copy_ids(one) == {"t1"}
    two = listing(("t1", "translation", "2026-01-01", None), ("t2", "translation", "2026-01-02", None))
    assert last_copy_ids(two) == {"t2"}
    restored = two + listing(("r1", "recovery", "2026-01-03", None))
    assert last_copy_ids(restored) == set()  # a later restore brought the world back
    old_recovery = two + listing(("r0", "recovery", "2026-01-01", None))
    assert last_copy_ids(old_recovery) == {"t2"}  # a recovery older than the translation changes nothing
    assert last_copy_ids([{"backupSetId": "x"}]) == set()  # rows without a kind are ignored
    # Protection is separate and reads journalState with .get.
    rows = listing(("a", "translation", "2026-01-01", "writing"), ("b", "translation", "2026-01-02", "completed"),
                   ("c", "recovery", "2026-01-03", "rolled_back"), ("d", "translation", "2026-01-04", "kept"),
                   ("e", "translation", "2026-01-05", None), ("f", "translation", "2026-01-06", "restoring"))
    rows.append({"backupSetId": "legacy", "kind": "translation", "createdAt": "2025-12-01"})
    assert backup_admin._protected(rows) == {"a": "recovery-needed", "f": "recovery-needed"}
    doomed, skipped = plan_prune(rows, 2)
    assert doomed == ["d", "c", "b", "legacy"]  # newest first, rows without journalState count as finished
    assert skipped == [{"backupSetId": "a", "reason": "recovery-needed"}]
    assert plan_prune(rows, 100) == ([], [])
    # A last copy outside the window is skipped, never doomed (cannot happen with real data, but the rule holds).
    odd = listing(("t", "translation", "2026-01-01", None), ("x", "recovery", "2026-01-02", None))
    assert plan_prune(odd, 1) == (["t"], [])  # recovery x is newer, so t is not a last copy


def test_delete_normal_set(tmp: Path) -> None:
    world, data = make_world(tmp, "normal")
    store = backup_store(world, data)
    first = make_set(world, store, "translation", 1)
    second = make_set(world, store, "translation", 2)
    recovery = make_set(world, store, "recovery", 3)
    point_latest(store, recovery)
    other = store / "unrelated-folder"
    other.mkdir()
    (other / "keep.txt").write_text("mine", encoding="utf-8")
    size = {row["backupSetId"]: row["sizeBytes"] for row in list_backup_sets(world, [store])}
    assert size[first] == 4196
    result = delete_backup(request(world, first), data)
    assert result == {"deleted": True, "backupSetId": first, "location": "app", "freedBytes": 4196}
    assert ids(store) == {second, recovery}
    assert not (store / first).exists() and not [p for p in store.iterdir() if ".deleting-" in p.name]
    assert (other / "keep.txt").read_text(encoding="utf-8") == "mine"
    assert latest(store) == recovery  # untouched: it did not point at the deleted set
    assert (world / "level.dat").is_file() and not (world / ".pomi-backups").exists()
    # The write lock was released.
    held = WorldWriteLock(world)
    held.acquire()
    held.release()


def test_location_rules(tmp: Path) -> None:
    world, data = make_world(tmp, "location")
    app = backup_store(world, data)
    old = legacy_backup_store(world)
    app_one = make_set(world, app, "translation", 1)
    app_two = make_set(world, app, "translation", 2)
    legacy_one = make_set(world, old, "translation", 1)
    legacy_two = make_set(world, old, "translation", 2)
    # The default location never reaches the in-world store.
    assert raises(BackupAdminError, delete_backup, request(world, legacy_one), data).code == "BACKUP_NOT_FOUND"
    assert raises(BackupAdminError, delete_backup, request(world, legacy_one, location="app"), data).code == "BACKUP_NOT_FOUND"
    assert (old / legacy_one / "manifest.json").is_file()
    # ...and the in-world store only when asked.
    assert raises(BackupAdminError, delete_backup, request(world, app_one, location="world"), data).code == "BACKUP_NOT_FOUND"
    result = delete_backup(request(world, legacy_one, location="world"), data)
    assert result["location"] == "world" and result["freedBytes"] == 4196
    assert ids(old) == {legacy_two} and ids(app) == {app_one, app_two}
    raises(ValueError, delete_backup, request(world, app_one, location="elsewhere"), data)
    raises(ValueError, delete_backup, request(world, app_one, location=None), data)
    # The newest legacy translation set is a last copy there too.
    assert raises(BackupAdminError, delete_backup, request(world, legacy_two, location="world"), data).code == "BACKUP_LAST_COPY"
    # prune follows the same rule
    result = prune_backups({"worldDir": str(world), "keepLatest": 1, "location": "world"}, data)
    assert result["deleted"] == [] and ids(old) == {legacy_two} and ids(app) == {app_one, app_two}


def test_odd_ids_rejected(tmp: Path) -> None:
    world, data = make_world(tmp, "odd")
    store = backup_store(world, data)
    good = make_set(world, store, "translation", 1)
    keep = make_set(world, store, "translation", 2)
    (store / "no-manifest").mkdir()
    (store / "file-not-dir").write_text("x", encoding="utf-8")
    sentinel = store.parent / "sentinel"
    sentinel.mkdir()
    (sentinel / "manifest.json").write_text("{}", encoding="utf-8")
    for bad in ("..", ".", "../" + sentinel.name, "a/b", "a\\b", "", good + "/..", good + "/", good.upper() + "x",
                "x.deleting-abc", "no-manifest", "file-not-dir", "missing", "latest.json", "C:" + good, "a b"):
        exc = raises(BackupAdminError, delete_backup, request(world, bad), data)
        assert exc.code == "BACKUP_NOT_FOUND", bad
    for bad in (None, 5, ["x"]):
        raises(ValueError, delete_backup, request(world, bad), data)
    raises(ValueError, delete_backup, {"worldDir": str(world)}, data)
    raises(ValueError, delete_backup, {"backupSetId": good}, data)
    raises(ValueError, delete_backup, request(world, good, acknowledgeLastCopy="yes"), data)
    raises(ValueError, delete_backup, "nope", data)
    assert (sentinel / "manifest.json").is_file() and ids(store) == {good, keep}
    # A link that looks like a set is not followed.
    link = store / "linked-set"
    try:
        os.symlink(sentinel, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        link = None
    if link is not None:
        assert raises(BackupAdminError, delete_backup, request(world, "linked-set"), data).code == "BACKUP_NOT_FOUND"
        assert (sentinel / "manifest.json").is_file()
        link.unlink()
    # A world that does not exist is not created by a delete.
    ghost = tmp / "odd" / "ghost-world"
    assert raises(BackupAdminError, delete_backup, request(ghost, good), data).code == "BACKUP_NOT_FOUND"
    assert not ghost.exists()


def test_world_lock_blocks_delete(tmp: Path) -> None:
    world, data = make_world(tmp, "locked")
    store = backup_store(world, data)
    old = make_set(world, store, "translation", 1)
    newest = make_set(world, store, "translation", 2)
    with WorldWriteLock(world, "translate"):
        exc = raises(BackupAdminError, delete_backup, request(world, old), data)
        assert exc.code == "WORLD_LOCKED" and exc.recoverable is True and exc.message
        assert raises(BackupAdminError, prune_backups, {"worldDir": str(world), "keepLatest": 1}, data).code == "WORLD_LOCKED"
        assert ids(store) == {old, newest}
    # A second process holding the lock blocks as well.
    process = subprocess.Popen([sys.executable, "-B", "-c", HOLDER, str(ROOT), str(world)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert process.stdout is not None and process.stdout.readline().strip() == "held"
        assert raises(BackupAdminError, delete_backup, request(world, old), data).code == "WORLD_LOCKED"
        assert ids(store) == {old, newest}
        process.kill()
        process.wait(timeout=30)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    # A running Minecraft session does not stop a backup from being deleted.
    (world / "session.lock").write_bytes(b"\x00" * 8)
    session = MinecraftSessionLocks(world)
    session.acquire()
    try:
        assert delete_backup(request(world, old), data)["deleted"] is True
    finally:
        session.release()
    assert ids(store) == {newest}


def test_last_copy_refused_then_acknowledged(tmp: Path) -> None:
    world, data = make_world(tmp, "lastcopy")
    store = backup_store(world, data)
    old = make_set(world, store, "translation", 1)
    newest = make_set(world, store, "translation", 2)
    point_latest(store, newest)
    assert list(backup_usage(world, data)["lastCopyIds"]) == [newest]
    exc = raises(BackupAdminError, delete_backup, request(world, newest), data)
    assert exc.code == "BACKUP_LAST_COPY"
    raises(BackupAdminError, delete_backup, request(world, newest, acknowledgeLastCopy=False), data)
    assert ids(store) == {old, newest}
    result = delete_backup(request(world, newest, acknowledgeLastCopy=True), data)
    assert result["deleted"] is True and ids(store) == {old}
    assert latest(store) == old  # repointed to the newest remaining translation set
    # Once a restore wrote a recovery set, the translation set is no longer the only way back.
    again = make_set(world, store, "translation", 5)
    recovery = make_set(world, store, "recovery", 6)
    assert backup_usage(world, data)["lastCopyIds"] == []
    assert delete_backup(request(world, again), data)["deleted"] is True
    assert ids(store) == {old, recovery}


def test_unsettled_journal_protects_the_set(tmp: Path) -> None:
    world, data = make_world(tmp, "journal")
    store = backup_store(world, data)
    needed = make_set(world, store, "translation", 1)
    done = make_set(world, store, "translation", 2)
    kept = make_set(world, store, "translation", 3)
    newest = make_set(world, store, "translation", 4)
    write_journal(world, store, needed, "committing")
    write_journal(world, store, done, "committed")
    write_journal(world, store, kept, "partial", settled=True)  # closed by "keep what was written"
    write_journal(world, store, newest, "rolled_back")
    assert journal_module.journal_state_of_set(store / needed) == "committing"
    exc = raises(BackupAdminError, delete_backup, request(world, needed, acknowledgeLastCopy=True), data)
    assert exc.code == "BACKUP_IN_USE_BY_RECOVERY"
    assert needed in ids(store)
    result = prune_backups({"worldDir": str(world), "keepLatest": 1}, data)
    assert result["deleted"] == [kept, done]
    assert result["skipped"] == [{"backupSetId": needed, "reason": "recovery-needed"}]
    assert result["kept"] == 2 and result["failed"] == []
    assert ids(store) == {needed, newest}
    # A job continued later reopens its record: it is protected again.
    write_journal(world, store, newest, "partial")
    assert raises(BackupAdminError, delete_backup, request(world, newest, acknowledgeLastCopy=True), data).code == "BACKUP_IN_USE_BY_RECOVERY"
    # Once the journal says it finished, it can go.
    write_journal(world, store, needed, "committed")
    assert delete_backup(request(world, needed), data)["deleted"] is True


def test_damaged_journal_is_never_deleted(tmp: Path) -> None:
    world, data = make_world(tmp, "damaged")
    store = backup_store(world, data)
    first = make_set(world, store, "translation", 1)
    second = make_set(world, store, "translation", 2)
    (store / first / journal_module.JOURNAL_NAME).write_text("{ not json", encoding="utf-8")
    assert journal_module.journal_state_of_set(store / first) == "invalid"
    exc = raises(BackupAdminError, delete_backup, request(world, first, acknowledgeLastCopy=True), data)
    assert exc.code == "BACKUP_IN_USE_BY_RECOVERY"
    result = prune_backups({"worldDir": str(world), "keepLatest": 1}, data)
    assert result["deleted"] == [] and ids(store) == {first, second}


def test_without_a_journal_module_the_listing_state_decides(tmp: Path) -> None:
    rows = listing(("a", "translation", "2026-01-01", "committing"), ("b", "translation", "2026-01-02", "committed"))
    assert backup_admin._protected(rows, None) == {"a": "recovery-needed"}
    assert backup_admin._protected(rows, set()) == {}  # the journal module is authoritative when present
    assert backup_admin._protected(rows, {"b"}) == {"b": "recovery-needed"}
    assert plan_prune(rows, 1, {"a"}) == ([], [{"backupSetId": "a", "reason": "recovery-needed"}])


def test_prune(tmp: Path) -> None:
    world, data = make_world(tmp, "prune")
    store = backup_store(world, data)
    t1 = make_set(world, store, "translation", 1)
    t2 = make_set(world, store, "translation", 2)
    r1 = make_set(world, store, "recovery", 3)
    t3 = make_set(world, store, "translation", 4)
    r2 = make_set(world, store, "recovery", 5)
    t4 = make_set(world, store, "translation", 6)  # newest: the last copy
    point_latest(store, t2)
    expected = sum(row["sizeBytes"] for row in list_backup_sets(world, [store]) if row["backupSetId"] in {t1, t2})
    result = prune_backups({"worldDir": str(world), "keepLatest": 4, "acknowledgeLastCopy": True}, data)
    assert sorted(result["deleted"]) == sorted([t1, t2])
    assert result["kept"] == 4 and result["skipped"] == [] and result["failed"] == []
    assert result["freedBytes"] == expected
    assert ids(store) == {r1, t3, r2, t4}
    assert latest(store) == t4  # the pointer was on a deleted set: repointed to the newest translation
    # keepLatest=1 keeps the newest even though it is a last copy; nothing else needs protecting.
    result = prune_backups({"worldDir": str(world), "keepLatest": 1}, data)
    assert sorted(result["deleted"]) == sorted([r1, t3, r2]) and ids(store) == {t4}
    assert prune_backups({"worldDir": str(world), "keepLatest": 5}, data)["deleted"] == []
    for bad in (0, -1, 1001, True, "2", 2.0, None):
        raises(ValueError, prune_backups, {"worldDir": str(world), "keepLatest": bad}, data)
    raises(ValueError, prune_backups, {"worldDir": str(world)}, data)
    raises(ValueError, prune_backups, {"worldDir": str(world), "keepLatest": 1, "location": "x"}, data)
    # A world with no backups at all is fine.
    empty_world, empty_data = make_world(tmp, "prune-empty")
    result = prune_backups({"worldDir": str(empty_world), "keepLatest": 3}, empty_data)
    assert result == {"deleted": [], "kept": 0, "skipped": [], "freedBytes": 0, "failed": []}


def test_latest_pointer(tmp: Path) -> None:
    world, data = make_world(tmp, "pointer")
    store = backup_store(world, data)
    t1 = make_set(world, store, "translation", 1)
    t2 = make_set(world, store, "translation", 2)
    r1 = make_set(world, store, "recovery", 3)
    point_latest(store, r1)
    delete_backup(request(world, r1), data)
    assert latest(store) == t2  # the pointer was on the deleted recovery set
    point_latest(store, t1)
    delete_backup(request(world, t1), data)
    assert latest(store) == t2
    point_latest(store, t2)
    delete_backup(request(world, t2, acknowledgeLastCopy=True), data)
    assert latest(store) is None and not (store / "latest.json").exists()
    # A damaged pointer is left alone.
    only = make_set(world, store, "translation", 9)
    (store / "latest.json").write_text("{broken", encoding="utf-8")
    delete_backup(request(world, only, acknowledgeLastCopy=True), data)
    assert (store / "latest.json").read_text(encoding="utf-8") == "{broken"


def test_stale_deleting_dirs_are_swept(tmp: Path) -> None:
    world, data = make_world(tmp, "sweep")
    store = backup_store(world, data)
    old = make_set(world, store, "translation", 1)
    keep = make_set(world, store, "translation", 2)
    stale = store / "20260101T000000Z-abc-translation.deleting-0123456789ab"
    (stale / "region").mkdir(parents=True)
    (stale / "region" / "r.0.0.mca").write_bytes(b"x")
    (stale / "region" / "r.0.0.mca").chmod(0o444)
    not_ours = store / "my-notes.deleting-"
    not_ours.mkdir()
    tricky = store / "something.deleting-xyz"
    tricky.mkdir()
    delete_backup(request(world, old), data)
    assert not stale.exists() and not_ours.is_dir() and tricky.is_dir() and ids(store) == {keep}
    # prune sweeps too
    stale.mkdir()
    (stale / "leftover").write_bytes(b"x")
    prune_backups({"worldDir": str(world), "keepLatest": 5}, data)
    assert not stale.exists()
    # A removal that fails midway reports it, leaves the folder for the next sweep, and the set is gone.
    again = make_set(world, store, "translation", 3)
    third = make_set(world, store, "translation", 4)
    real = backup_admin._remove_tree

    def broken(path: Path) -> None:
        raise OSError(13, "locked by an antivirus scan")

    backup_admin._remove_tree = broken
    try:
        exc = raises(BackupAdminError, delete_backup, request(world, again), data)
        assert exc.code == "BACKUP_DELETE_FAILED"
        leftovers = [p for p in store.iterdir() if p.name.startswith(again + ".deleting-")]
        assert len(leftovers) == 1 and again not in ids(store)
        result = prune_backups({"worldDir": str(world), "keepLatest": 1}, data)
        assert result["failed"] == [{"backupSetId": keep, "code": "BACKUP_DELETE_FAILED"}]
        assert result["deleted"] == [] and result["kept"] == 1 and ids(store) == {third}
    finally:
        backup_admin._remove_tree = real
    prune_backups({"worldDir": str(world), "keepLatest": 1}, data)
    assert not leftovers[0].exists()


def test_usage(tmp: Path) -> None:
    world, data = make_world(tmp, "usage")
    other_world, _ = make_world(tmp, "usage-other")
    store = backup_store(world, data)
    other_store = backup_store(other_world, data)
    a = make_set(world, store, "translation", 1)
    b = make_set(world, store, "translation", 2)
    make_set(other_world, other_store, "translation", 1)
    stale = store / (a + ".deleting-abc123")
    stale.mkdir()
    (stale / "manifest.json").write_text(json.dumps({"files": [{"size": "999999"}]}), encoding="utf-8")
    damaged = store / "damaged-set"
    damaged.mkdir()
    (damaged / "manifest.json").write_text("{nope", encoding="utf-8")
    (data / "backups" / "stray.txt").write_text("x", encoding="utf-8")
    make_set(world, legacy_backup_store(world), "translation", 1)  # in-world sets are not counted
    usage = backup_usage(world, data)
    assert usage == {"worldBytes": 2 * 4196, "worldCount": 2, "appBytes": 3 * 4196, "appBytesApproximate": False,
                     "lastCopyIds": [b]}
    # Bounded: past the manifest limit the total is flagged approximate.
    real = backup_admin.MAX_USAGE_MANIFESTS
    backup_admin.MAX_USAGE_MANIFESTS = 2
    try:
        capped = backup_usage(world, data)
    finally:
        backup_admin.MAX_USAGE_MANIFESTS = real
    assert capped["appBytesApproximate"] is True and 0 < capped["appBytes"] <= 2 * 4196
    # Never raises.
    nothing = backup_usage(tmp / "nowhere" / "world", tmp / "nowhere" / "data")
    assert nothing == {"worldBytes": 0, "worldCount": 0, "appBytes": 0, "appBytesApproximate": False, "lastCopyIds": []}
    assert backup_usage(world, data / "backups" / "stray.txt")["appBytes"] == 0


def test_error_codes(tmp: Path) -> None:
    assert set(backup_admin.ERROR_CODES) == {
        "BACKUP_NOT_FOUND", "WORLD_LOCKED", "BACKUP_IN_USE_BY_RECOVERY", "BACKUP_LAST_COPY", "BACKUP_DELETE_FAILED"}
    error = BackupAdminError("BACKUP_NOT_FOUND", "gone")
    assert (error.code, error.message, error.recoverable) == ("BACKUP_NOT_FOUND", "gone", True)


TESTS = [
    test_last_copy_rule_on_plain_dicts,
    test_delete_normal_set,
    test_location_rules,
    test_odd_ids_rejected,
    test_world_lock_blocks_delete,
    test_last_copy_refused_then_acknowledged,
    test_unsettled_journal_protects_the_set,
    test_damaged_journal_is_never_deleted,
    test_without_a_journal_module_the_listing_state_decides,
    test_prune,
    test_latest_pointer,
    test_stale_deleting_dirs_are_swept,
    test_usage,
    test_error_codes,
]


def main() -> None:
    with tempfile.TemporaryDirectory() as temp:
        tmp = Path(temp)
        for test in TESTS:
            test(tmp)
            print("PASS", test.__name__)
    print(f"{len(TESTS)} backup admin tests")
    print("BACKUP_ADMIN_PASSED")


if __name__ == "__main__":
    main()
