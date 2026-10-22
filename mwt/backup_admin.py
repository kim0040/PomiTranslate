"""Deleting, pruning and measuring backup sets.

Backups are the only way back for a world, so everything here is conservative:

* Only the store the caller names is touched. ``location="app"`` (default) is the per-world folder
  under the app data directory; ``location="world"`` is the old in-world ``.pomi-backups`` folder
  and is used only when passed explicitly. Only a direct child of the store with a manifest, and
  not a link, is ever removed.
* The world write lock is held while deleting, so a running job or restore keeps its backup. A
  running Minecraft session does not block it: deleting a backup never writes the world.
* The last copy rule: the newest "translation" set with no newer "recovery" set is the only way
  back to the pre-translation world. Deleting it needs ``acknowledgeLastCopy``; prune never
  deletes it.
* A set whose journal is unsettled belongs to an unfinished job or restore and is never deleted
  or pruned (``BACKUP_IN_USE_BY_RECOVERY``). The authority is ``mwt.journal.unsettled_for_world``
  (a job's backup set has the job's id); a damaged journal (``journalState == "invalid"``) is
  treated as unsettled. Without ``mwt.journal`` (a core older than the journal change) the
  ``journalState`` of the listing rows decides: anything but committed / rolled_back is in use.

A delete renames ``<id>`` to ``<id>.deleting-<hex>`` first and removes that folder second, so a
crash or a locked file never leaves half a set that still looks usable. Leftover ``*.deleting-*``
folders are swept on the next delete or prune of that store.

Failures raise ``BackupAdminError`` with a code; a bad request shape raises ``ValueError``.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

from mwt import safety
from mwt.durable import atomic_write_text, fsync_dir
from mwt.locking import WorldWriteLock, WorldWriteLocked

ERROR_CODES = (
    "BACKUP_NOT_FOUND",
    "WORLD_LOCKED",
    "BACKUP_IN_USE_BY_RECOVERY",
    "BACKUP_LAST_COPY",
    "BACKUP_DELETE_FAILED",
)

LOCATIONS = ("app", "world")
JOURNAL_FINISHED_STATES = frozenset({"committed", "rolled_back", "completed", "kept"})
MAX_KEEP_LATEST = 1000
MAX_USAGE_MANIFESTS = 5000
MAX_USAGE_MANIFEST_BYTES = 64 * 1024 * 1024

_SET_ID = re.compile(r"[A-Za-z0-9_-]+")
_STALE_DELETE = re.compile(r"[A-Za-z0-9_-]+\.deleting-[0-9a-f]+")


class BackupAdminError(RuntimeError):
    recoverable = True

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# --- pure rules (plain dicts in, so they can be tested without a disk) --------------------------


def _order_key(item: dict) -> tuple[str, str]:
    return (str(item.get("createdAt") or ""), str(item.get("backupSetId") or ""))


def last_copy_ids(listed: list[dict]) -> set[str]:
    """Ids of the sets that are the only way back to the pre-translation world.

    That is the newest "translation" set when no "recovery" set is newer: the world was changed
    by it and has not been restored since.
    """
    translations = [item for item in listed if item.get("kind") == "translation" and item.get("backupSetId")]
    if not translations:
        return set()
    newest = max(translations, key=_order_key)
    for item in listed:
        if item.get("kind") == "recovery" and _order_key(item) > _order_key(newest):
            return set()
    return {str(newest["backupSetId"])}


def _protected(listed: list[dict], unsettled: "set[str] | None" = None) -> dict[str, str]:
    """Set id -> reason, for sets an unfinished job or restore may still need.

    ``unsettled`` is the set of job ids the journal module reports as unsettled; None means the
    module is not there and the listing's ``journalState`` decides.
    """
    result: dict[str, str] = {}
    for item in listed:
        backup_id = item.get("backupSetId")
        if not backup_id:
            continue
        state = item.get("journalState")
        if state == "invalid":
            result[str(backup_id)] = "recovery-needed"
        elif unsettled is not None:
            if str(backup_id) in unsettled:
                result[str(backup_id)] = "recovery-needed"
        elif state is not None and state not in JOURNAL_FINISHED_STATES:
            result[str(backup_id)] = "recovery-needed"
    return result


def _unsettled_jobs(world: Path, store: Path) -> "set[str] | None":
    """Ids of the world's unsettled jobs, or None when this core has no journal module."""
    try:
        from mwt.journal import unsettled_for_world
    except ImportError:
        return None
    try:
        return {str(item["jobId"]) for item in unsettled_for_world(world, [store])}
    except OSError as exc:
        # Not knowing is not permission: refuse rather than delete a set a recovery may need.
        raise BackupAdminError(
            "BACKUP_IN_USE_BY_RECOVERY", f"The recovery records could not be read, so nothing was deleted: {exc.strerror or exc}"
        ) from exc


def plan_prune(listed: list[dict], keep_latest: int, unsettled: "set[str] | None" = None) -> tuple[list[str], list[dict]]:
    """(ids to delete, skipped rows) for a prune that keeps the newest ``keep_latest`` sets."""
    ordered = sorted(listed, key=_order_key, reverse=True)
    protected = _protected(listed, unsettled)
    last_copies = last_copy_ids(listed)
    doomed: list[str] = []
    skipped: list[dict] = []
    for item in ordered[keep_latest:]:
        backup_id = str(item["backupSetId"])
        if backup_id in protected:
            skipped.append({"backupSetId": backup_id, "reason": protected[backup_id]})
        elif backup_id in last_copies:
            skipped.append({"backupSetId": backup_id, "reason": "last-copy"})
        else:
            doomed.append(backup_id)
    return doomed, skipped


# --- request parsing -----------------------------------------------------------------------------


def _world(payload: dict) -> Path:
    if not isinstance(payload, dict):
        raise ValueError("Request payload must be an object")
    value = payload.get("worldDir")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("worldDir is required")
    return Path(value).expanduser()


def _location(payload: dict) -> str:
    value = payload.get("location", "app")
    if value not in LOCATIONS:
        raise ValueError("location must be app or world")
    return value


def _flag(payload: dict, name: str) -> bool:
    value = payload.get(name, False)
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be true or false")
    return value


def _store(world: Path, data_dir: Path, location: str) -> Path:
    if location == "world":
        return safety.legacy_backup_store(world)
    return safety.backup_store(world, data_dir)


# --- filesystem helpers --------------------------------------------------------------------------


@contextmanager
def _world_guard(world: Path):
    """The world write lock (purpose "backup-delete"); no lock when the world folder is gone.

    A missing world has no writer, and acquiring the lock would create the folder again.
    """
    if not world.is_dir():
        yield
        return
    lock = WorldWriteLock(world, "backup-delete")
    try:
        lock.acquire()
    except WorldWriteLocked as exc:
        raise BackupAdminError("WORLD_LOCKED", str(exc)) from exc
    try:
        yield
    finally:
        lock.release()


def _make_writable(function, path, _error) -> None:
    """rmtree error hook: clear a read-only flag (common on Windows) and retry once."""
    os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
    function(path)


def _remove_tree(path: Path) -> None:
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=_make_writable)
    else:
        shutil.rmtree(path, onerror=_make_writable)


def _sweep_stale(store: Path) -> None:
    """Finish deletes an earlier run could not. Best effort; only names this module creates."""
    try:
        candidates = list(store.iterdir())
    except OSError:
        return
    for entry in candidates:
        if _STALE_DELETE.fullmatch(entry.name) and entry.is_dir() and not entry.is_symlink():
            try:
                _remove_tree(entry)
            except OSError:
                pass


def _set_dir(store: Path, backup_id: object) -> Path:
    """The folder of one set, only if it is a real direct child of ``store`` with a manifest."""
    if not isinstance(backup_id, str):
        raise ValueError("backupSetId is required")
    missing = BackupAdminError("BACKUP_NOT_FOUND", "That backup was not found.")
    if not _SET_ID.fullmatch(backup_id):
        raise missing
    target = store / backup_id
    try:
        if target.is_symlink() or not target.is_dir() or not (target / "manifest.json").is_file():
            raise missing
        if target.resolve().parent != store.resolve():
            raise missing
    except OSError as exc:
        raise missing from exc
    return target


def _repoint_latest(store: Path, deleted_id: str, remaining: list[dict]) -> None:
    pointer = store / "latest.json"
    try:
        current = json.loads(pointer.read_text(encoding="utf-8")).get("backupSetId")
    except (OSError, ValueError, AttributeError):
        return  # no pointer, or one this module does not own the repair of
    if current != deleted_id:
        return
    candidates = [item for item in remaining if item.get("kind") == "translation" and item.get("verified")]
    if candidates:
        newest = max(candidates, key=_order_key)
        atomic_write_text(pointer, json.dumps({"backupSetId": newest["backupSetId"]}))
    else:
        pointer.unlink(missing_ok=True)
        fsync_dir(store)


def _delete_core(store: Path, backup_id: str, listed: list[dict]) -> int:
    """Rename, repoint, remove. Returns the bytes the manifest says the set held."""
    target = _set_dir(store, backup_id)
    freed = next((int(item.get("sizeBytes") or 0) for item in listed if item.get("backupSetId") == backup_id), 0)
    doomed = store / f"{backup_id}.deleting-{uuid.uuid4().hex[:12]}"
    try:
        os.replace(target, doomed)
    except OSError as exc:
        raise BackupAdminError("BACKUP_DELETE_FAILED", f"The backup could not be deleted: {exc.strerror or exc}") from exc
    fsync_dir(store)
    # The rename is the commit point: from here the set no longer exists as far as listing goes.
    remaining = [item for item in listed if item.get("backupSetId") != backup_id]
    try:
        _repoint_latest(store, backup_id, remaining)
    except OSError as exc:
        raise BackupAdminError("BACKUP_DELETE_FAILED", f"The newest-backup pointer could not be updated: {exc.strerror or exc}") from exc
    try:
        _remove_tree(doomed)
    except OSError as exc:
        raise BackupAdminError(
            "BACKUP_DELETE_FAILED",
            f"The backup was removed but some files could not be deleted yet: {exc.strerror or exc}",
        ) from exc
    return freed


def _listed(world: Path, store: Path) -> list[dict]:
    return safety.list_backup_sets(world, [store])


# --- public surface ------------------------------------------------------------------------------


def delete_backup(payload: dict, data_dir: Path) -> dict:
    world = _world(payload)
    location = _location(payload)
    acknowledged = _flag(payload, "acknowledgeLastCopy")
    backup_id = payload.get("backupSetId")
    store = _store(world, Path(data_dir), location)
    if not isinstance(backup_id, str):
        raise ValueError("backupSetId is required")
    with _world_guard(world):
        _set_dir(store, backup_id)  # not found before anything else is decided
        _sweep_stale(store)
        listed = _listed(world, store)
        protected = _protected(listed, _unsettled_jobs(world, store))
        if backup_id in protected:
            raise BackupAdminError(
                "BACKUP_IN_USE_BY_RECOVERY",
                "This backup belongs to an unfinished translation or restore and is needed to recover the world.",
            )
        if backup_id in last_copy_ids(listed) and not acknowledged:
            raise BackupAdminError(
                "BACKUP_LAST_COPY",
                "This is the only backup of the world before translation. Deleting it removes the way back.",
            )
        freed = _delete_core(store, backup_id, listed)
    return {"deleted": True, "backupSetId": backup_id, "location": location, "freedBytes": freed}


def prune_backups(payload: dict, data_dir: Path) -> dict:
    world = _world(payload)
    location = _location(payload)
    _flag(payload, "acknowledgeLastCopy")  # accepted for symmetry; prune never deletes a last copy
    keep = payload.get("keepLatest")
    if isinstance(keep, bool) or not isinstance(keep, int) or not 1 <= keep <= MAX_KEEP_LATEST:
        raise ValueError(f"keepLatest must be a whole number from 1 to {MAX_KEEP_LATEST}")
    store = _store(world, Path(data_dir), location)
    deleted: list[str] = []
    failed: list[dict] = []
    freed = 0
    with _world_guard(world):
        _sweep_stale(store)
        listed = _listed(world, store)
        doomed, skipped = plan_prune(listed, keep, _unsettled_jobs(world, store))
        for backup_id in doomed:
            try:
                freed += _delete_core(store, backup_id, listed)
                deleted.append(backup_id)
                listed = [item for item in listed if item.get("backupSetId") != backup_id]
            except BackupAdminError as exc:
                failed.append({"backupSetId": backup_id, "code": exc.code})
                if not (store / backup_id).exists():
                    # Renamed away but not fully removed: it is gone as a backup.
                    listed = [item for item in listed if item.get("backupSetId") != backup_id]
    return {
        "deleted": deleted,
        "kept": len(listed),
        "skipped": skipped,
        "freedBytes": freed,
        "failed": failed,
    }


def _manifest_bytes(manifest: Path) -> int:
    """Sum of recorded file sizes; the payload files are never walked."""
    if manifest.stat().st_size > MAX_USAGE_MANIFEST_BYTES:
        return 0
    data = json.loads(manifest.read_text(encoding="utf-8"))
    files = data.get("files", []) if isinstance(data, dict) else []
    if not isinstance(files, list):
        return 0
    return sum(int(item["size"]) for item in files if isinstance(item, dict) and str(item.get("size", "")).isdigit())


def backup_usage(world_dir: Path, data_dir: Path) -> dict:
    """Cheap sizes for the backups list. Never raises: a failure reports zeros."""
    usage = {"worldBytes": 0, "worldCount": 0, "appBytes": 0, "appBytesApproximate": False, "lastCopyIds": []}
    try:
        world = Path(world_dir)
        listed = _listed(world, safety.backup_store(world, Path(data_dir)))
        usage["worldBytes"] = sum(int(item.get("sizeBytes") or 0) for item in listed)
        usage["worldCount"] = len(listed)
        usage["lastCopyIds"] = sorted(last_copy_ids(listed))
    except (OSError, ValueError, TypeError):
        pass
    try:
        seen = 0
        total = 0
        for world_store in sorted((Path(data_dir) / "backups").iterdir()):
            if not world_store.is_dir() or world_store.is_symlink():
                continue
            for entry in world_store.iterdir():
                manifest = entry / "manifest.json"
                if not _SET_ID.fullmatch(entry.name) or entry.is_symlink() or not manifest.is_file():
                    continue
                if seen >= MAX_USAGE_MANIFESTS:
                    usage["appBytesApproximate"] = True
                    break
                seen += 1
                try:
                    total += _manifest_bytes(manifest)
                except (OSError, ValueError, TypeError):
                    continue
            if usage["appBytesApproximate"]:
                break
        usage["appBytes"] = total
    except OSError:
        pass
    return usage
