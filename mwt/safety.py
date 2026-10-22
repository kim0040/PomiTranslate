"""Verified backups and world fingerprints for the shipped write path."""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from mwt.durable import atomic_write_text, copy_durable, fsync_dir, mkdir_durable
from mwt.durable import replace as durable_replace

SKIP_DIR_NAMES = {".pomi-backups", ".pomi-translate", "__pycache__", ".venv"}
DATA_SUFFIXES = {".mca", ".mcc", ".mcr", ".linear", ".dat"}
MCC_NAME = r"c\.-?\d+\.-?\d+\.mcc"
# Files a backup may record as "absent now": an .mcc a run creates, or a region file / pack a
# restore recreates. Restoring such an entry deletes the file again.
ABSENT_TARGET_NAMES = (MCC_NAME, r"r\.-?\d+\.-?\d+\.mca", r"resources\.zip")


class BackupError(RuntimeError):
    pass


class ExternalTargetError(BackupError):
    pass


class PlanInvalidated(RuntimeError):
    pass


def iter_data_files(world_dir: Path) -> list[Path]:
    from mwt.layout import world_data_roots

    root = world_dir.resolve()
    files: list[Path] = []
    for data_root in world_data_roots(root):
        if not data_root.resolve().is_relative_to(root):
            raise ValueError("World data source is outside the selected world")
        for path in data_root.rglob("*"):
            if any(part in SKIP_DIR_NAMES for part in path.relative_to(root).parts):
                continue
            if path.suffix.lower() not in DATA_SUFFIXES and path.name not in {"level.dat", "resources.zip"}:
                continue
            if not path.resolve().is_relative_to(root):
                raise ValueError("World data source is outside the selected world")
            if path.is_file():
                files.append(path)
    return sorted(files)


def world_fingerprint(world_dir: Path) -> str:
    digest = hashlib.sha256()
    root = world_dir.resolve()
    for path in iter_data_files(root):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(relative)
        digest.update(b"\0")
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        digest.update(b"\0")
    return digest.hexdigest()


def file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class DigestCache:
    """File digests remembered for one run, keyed by (path, size, mtime_ns).

    A checkpoint after every region file would otherwise re-read the whole world each time.
    A file this run rewrites must be passed to ``forget`` so a same-size, same-tick write
    cannot be served from a stale entry.
    """

    def __init__(self) -> None:
        self._entries: dict[str, tuple[int, int, str]] = {}

    def digest(self, path: Path) -> tuple[int, str]:
        before = path.stat()
        key = str(path)
        hit = self._entries.get(key)
        if hit is not None and hit[0] == before.st_size and hit[1] == before.st_mtime_ns:
            return before.st_size, hit[2]
        digest = file_sha256(path)
        after = path.stat()
        if (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns):
            self._entries[key] = (before.st_size, before.st_mtime_ns, digest)
        return before.st_size, digest

    def forget(self, path: Path) -> None:
        self._entries.pop(str(path), None)


def world_state_fingerprint(world_dir: Path, cache: DigestCache | None = None) -> str:
    """Digest of the same files ``world_fingerprint`` covers, built from per-file digests.

    Unlike ``world_fingerprint`` it can reuse ``cache`` between calls, so a checkpoint only
    re-reads the files that changed since the last one. Its values differ from
    ``world_fingerprint``; checkpoints record which of the two they hold.
    """
    digests = cache if cache is not None else DigestCache()
    outer = hashlib.sha256(b"pomi-world-state-v2\0")
    root = world_dir.resolve()
    for path in iter_data_files(root):
        size, digest = digests.digest(path)
        outer.update(path.relative_to(root).as_posix().encode("utf-8"))
        outer.update(f"\0{size}\0{digest}\n".encode("ascii"))
    return outer.hexdigest()


def legacy_backup_store(world_dir: Path) -> Path:
    """Where releases before the app-data store kept backups: inside the world folder."""
    return world_dir.resolve() / ".pomi-backups"


def backup_store(world_dir: Path, data_dir: Path) -> Path:
    """One folder per world under the app data directory.

    Backups next to the world travel with it when the folder is zipped or shared, and vanish
    when it is deleted. The key is the resolved path, so two worlds with the same name stay apart.
    """
    resolved = world_dir.resolve()
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", resolved.name).strip("-.")[:40] or "world"
    key = hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:10]
    return data_dir / "backups" / f"{slug}-{key}"


class BackupSet:
    """Copy world files, verify the copies, and only then allow a write."""

    def __init__(self, world_dir: Path, backup_id: str = "latest", store: Path | None = None, *, external_files: list[Path] | None = None) -> None:
        self.world_dir = world_dir.resolve()
        # Only explicitly selected ZIP files may become external write targets.
        # A manifest cannot grant itself permission to overwrite an arbitrary path.
        self.external_files: dict[str, str] = {}
        for path in external_files or []:
            selected = Path(path).expanduser()
            if selected.is_symlink() or not selected.is_file() or selected.suffix.lower() != ".zip":
                raise ExternalTargetError("External resource pack must be an existing regular ZIP file")
            resolved = selected.resolve(strict=True)
            if resolved.is_relative_to(self.world_dir):
                continue
            self.external_files[str(resolved)] = self._parent_identity(resolved)
        self.store = Path(store) if store is not None else legacy_backup_store(self.world_dir)
        if backup_id == "latest":
            pointer = self.store / "latest.json"
            if pointer.is_file():
                try:
                    backup_id = str(json.loads(pointer.read_text(encoding="utf-8"))["backupSetId"])
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    raise BackupError("The latest-backup pointer is damaged") from exc
        if not re.fullmatch(r"[A-Za-z0-9_-]+", backup_id):
            raise BackupError("Invalid backup set ID")
        self.backup_id = backup_id
        self.root = self.store / backup_id
        self.manifest_path = self.root / "manifest.json"
        self.entries: list[dict[str, str]] = []
        self._index: dict[str, dict[str, str]] = {}
        self._written: set[str] = set()
        self._dirty = False

    @classmethod
    def new(cls, world_dir: Path, *, kind: str = "translation", store: Path | None = None, external_files: list[Path] | None = None) -> "BackupSet":
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_id = f"{stamp}-{uuid.uuid4().hex[:12]}-{kind}"
        return cls(world_dir, backup_id, store, external_files=external_files)

    @classmethod
    def find(cls, world_dir: Path, backup_id: str, stores: list[Path], *, external_files: list[Path] | None = None) -> "BackupSet":
        """Open a backup by id from the first store that has it."""
        for store in stores:
            candidate = cls(world_dir, backup_id, store, external_files=external_files)
            if candidate.manifest_path.is_file():
                return candidate
        raise BackupError("Backup set was not found")

    @classmethod
    def open_existing(cls, world_dir: Path, backup_id: str, store: Path | None = None, *, external_files: list[Path] | None = None) -> "BackupSet":
        backup = cls(world_dir, backup_id, store, external_files=external_files)
        if not backup.manifest_path.is_file():
            raise BackupError("Backup set for resume was not found")
        payload = json.loads(backup.manifest_path.read_text(encoding="utf-8"))
        if payload.get("verified") is not True:
            raise BackupError("Backup set for resume is not verified")
        backup.entries = backup._validated_manifest_entries(payload)
        backup._index = {entry["path"]: entry for entry in backup.entries}
        for entry in backup.entries:
            if "externalTarget" in entry:
                backup._target(entry)
        backup._written = {entry["path"] for entry in backup.entries}
        backup.verify()
        return backup

    def publish_latest(self, *, verify: bool = True) -> None:
        """Point ``latest.json`` at this set. ``verify=False`` skips the full re-hash when the
        caller verifies once at a better moment (every entry is already checked when added)."""
        self.commit()
        if verify:
            self.verify()
        pointer = self.store / "latest.json"
        mkdir_durable(pointer.parent)
        atomic_write_text(pointer, json.dumps({"backupSetId": self.backup_id}))

    def external_targets(self) -> list[Path]:
        payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        return [Path(entry["externalTarget"]) for entry in self._validated_manifest_entries(payload) if "externalTarget" in entry]

    def add(self, path: Path, *, commit: bool = True) -> None:
        """Copy one file into the set and check the copy. ``commit=False`` defers the manifest
        write, so a caller adding several files pays for one write (see ``commit``)."""
        if path.is_symlink():
            raise BackupError("Symbolic links cannot be backed up as writable targets")
        path = path.resolve()
        if not path.is_file():
            return
        external = not path.is_relative_to(self.world_dir)
        if external:
            relative = self._external_archive_path(path)
            target = {"externalTarget": str(path), "externalParentId": self._parent_identity(path)}
            self._target({"path": relative, **target})
        else:
            relative = path.relative_to(self.world_dir).as_posix()
            target = {}
        existing = self._index.get(relative)
        if existing is not None:
            if existing.get("externalTarget") != target.get("externalTarget"):
                raise BackupError("Backup target collides with an existing entry")
            return
        destination = self.root / relative
        mkdir_durable(destination.parent)
        original = file_sha256(path)
        copy_durable(path, destination)  # flushed before any world file is touched
        copied = file_sha256(destination)
        if original != copied:
            raise BackupError(f"Backup hash mismatch for {relative}")
        self._append({"path": relative, "sha256": original, "size": str(destination.stat().st_size), **target})
        if commit:
            self.commit()

    def _append(self, entry: dict[str, str]) -> None:
        self.entries.append(entry)
        self._index[entry["path"]] = entry
        self._dirty = True

    def commit(self) -> None:
        """Write the manifest if entries were added since the last write."""
        if self._dirty:
            self._write_manifest()
            self._dirty = False

    def verify(self) -> None:
        self.commit()
        if not self.entries:
            raise BackupError("No files were backed up")
        payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        if payload.get("verified") is not True:
            raise BackupError("Backup manifest is not verified")
        for entry in self._validated_manifest_entries(payload):
            if entry.get("restoreAction") == "remove_created":
                source = self._target(entry)
                if entry["path"] not in self._written and source.exists():
                    raise BackupError("A new external chunk target already exists")
                continue
            copied = self.root / entry["path"]
            if not copied.is_file() or file_sha256(copied) != entry["sha256"]:
                raise BackupError(f"Backup verification failed for {entry['path']}")
            if entry["path"] in self._written:
                continue
            source = self._target(entry)
            if file_sha256(source) != entry["sha256"]:
                raise BackupError(f"Backup verification failed for {entry['path']}")

    def record_new_external_chunk(self, path: Path, *, commit: bool = True) -> None:
        """Record absence before creation so restore can recover, then remove, this file."""
        self.record_absent(path, commit=commit)

    def record_absent(self, path: Path, *, commit: bool = True) -> None:
        """Remember that ``path`` does not exist now, so undoing the write removes it again.

        Used for an .mcc the run is about to create, and for a file a restore is about to bring
        back although it is missing: the recovery set can then put the world back exactly.
        """
        path = Path(os.path.abspath(path))
        if not path.resolve().is_relative_to(self.world_dir):
            raise BackupError("Absent targets must be inside the selected world")
        relative = path.relative_to(self.world_dir).as_posix()
        if relative in self._index:
            return
        entry = {"path": relative, "sha256": hashlib.sha256(b"").hexdigest(),
                 "size": "0", "restoreAction": "remove_created"}
        candidate = self._validated_manifest_entries({"files": [*self.entries, entry]})[-1]
        target = self._target(candidate)
        if target.exists():
            raise BackupError("A target recorded as absent already exists")
        self._append(candidate)
        if commit:
            self.commit()

    def mark_written(self, paths: list[Path]) -> None:
        """Remember files this run has already replaced so later verifies do not expect the pre-write bytes."""
        for path in paths:
            resolved = path.resolve()
            self._written.add(resolved.relative_to(self.world_dir).as_posix() if resolved.is_relative_to(self.world_dir) else self._external_archive_path(resolved))

    def restore(self, recovery_store: Path | None = None, *, hold_guards: bool = True) -> str:
        """Put the backed-up files back. The files they replace are kept as a recovery set first.

        The world write lock and the game's session locks are held for the whole restore, and a
        busy world raises ``WorldWriteLocked`` / ``MinecraftWorldInUse`` before anything is
        written. Pass ``hold_guards=False`` only when the caller already holds both.
        """
        if not hold_guards:
            return self._restore(recovery_store)
        from mwt.locking import hold_world

        with hold_world(self.world_dir, "restore"):
            return self._restore(recovery_store)

    def _restore(self, recovery_store: Path | None) -> str:
        payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        entries = self._validated_manifest_entries(payload)
        if not payload.get("verified") or not entries:
            raise BackupError("Refusing to restore an unverified backup set")
        for entry in entries:
            # Validate every destination before creating recovery files or replacing any file.
            self._target(entry)
            if entry.get("restoreAction") == "remove_created":
                continue
            source = self.root / entry["path"]
            if not source.is_file() or file_sha256(source) != entry["sha256"]:
                raise BackupError(f"Refusing to restore an unverified backup of {entry['path']}")

        recovery = BackupSet.new(self.world_dir, kind="recovery", store=recovery_store or self.store,
                                 external_files=[Path(path) for path in self.external_files])
        for entry in entries:
            current = self._target(entry)
            if current.is_file():
                recovery.add(current, commit=False)
            elif entry.get("restoreAction") != "remove_created" and "externalTarget" not in entry:
                recovery.record_absent(current, commit=False)  # undoing this restore removes it again
        if recovery.entries:
            recovery.publish_latest()
        ordered = sorted(entries, key=lambda entry: 2 if entry.get("restoreAction") == "remove_created"
                         else 0 if entry["path"].endswith(".mcc") else 1)
        for entry in ordered:
            destination = self._target(entry)
            if entry.get("restoreAction") == "remove_created":
                # The recovery set above includes the current bytes, even if Minecraft
                # edited them since translation. Restore returns to the pre-write absence.
                destination.unlink(missing_ok=True)
                fsync_dir(destination.parent)
                continue
            source = self.root / entry["path"]
            mkdir_durable(destination.parent)
            temporary = destination.with_name(f".{destination.name}.pomi-restore-{uuid.uuid4().hex}.tmp")
            try:
                copy_durable(source, temporary)
                durable_replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
            fsync_dir(destination.parent)
            if file_sha256(destination) != entry["sha256"]:
                raise BackupError(f"Restore hash mismatch for {entry['path']}")
        return recovery.backup_id if recovery.entries else ""

    @staticmethod
    def _parent_identity(path: Path) -> str:
        info = path.parent.stat()
        return f"{info.st_dev}:{info.st_ino}"

    @staticmethod
    def _external_archive_path(path: Path) -> str:
        return "__external_packs__/" + hashlib.sha256(str(path).encode("utf-8")).hexdigest() + "/pack.zip"

    def _target(self, entry: dict[str, str]) -> Path:
        selected = entry.get("externalTarget")
        if selected is None:
            target = self.world_dir / entry["path"]
            if entry.get("restoreAction") == "remove_created":
                if any(part.is_symlink() for part in [target, *target.parents] if part.is_relative_to(self.world_dir)):
                    raise BackupError("New external chunk restore target cannot be a symbolic link")
                if target.exists() and not target.is_file():
                    raise BackupError("New external chunk restore target is not a regular file")
            return target
        path = Path(selected)
        if (selected not in self.external_files or path.is_symlink() or not path.is_file()
                or str(path.resolve(strict=True)) != selected
                or self._parent_identity(path) != entry.get("externalParentId")
                or self.external_files[selected] != entry.get("externalParentId")):
            raise ExternalTargetError("External resource pack is unavailable or not explicitly selected for restore")
        return path

    def _validated_manifest_entries(self, payload: dict) -> list[dict[str, str]]:
        files = payload.get("files")
        if not isinstance(files, list):
            raise BackupError("Backup manifest file list is invalid")
        world_root = self.world_dir.resolve()
        backup_root = self.root.resolve()
        entries: list[dict[str, str]] = []
        seen: set[str] = set()
        for raw in files:
            if not isinstance(raw, dict):
                raise BackupError("Backup manifest entry is invalid")
            relative_text = raw.get("path")
            digest = raw.get("sha256")
            size = raw.get("size")
            if not isinstance(relative_text, str) or not isinstance(digest, str) or not isinstance(size, str):
                raise BackupError("Backup manifest entry fields are invalid")
            relative = PurePosixPath(relative_text)
            if (
                relative.is_absolute()
                or not relative.parts
                or any(part in {"", ".", ".."} for part in relative.parts)
                or relative.parts[0] in SKIP_DIR_NAMES
                or not re.fullmatch(r"[0-9a-f]{64}", digest)
                or not size.isdigit()
                or relative_text in seen
            ):
                raise BackupError("Backup manifest path or hash is invalid")
            backup_path = (self.root / Path(*relative.parts)).resolve()
            external_target = raw.get("externalTarget")
            external_parent = raw.get("externalParentId")
            action = raw.get("restoreAction")
            if action is not None and (
                action != "remove_created" or external_target is not None
                or not any(re.fullmatch(pattern, relative.name) for pattern in ABSENT_TARGET_NAMES)
                or digest != hashlib.sha256(b"").hexdigest() or size != "0"
            ):
                raise BackupError("Backup restore action is invalid")
            if external_target is not None:
                if (not isinstance(external_target, str) or not Path(external_target).is_absolute()
                        or Path(external_target).suffix.lower() != ".zip"
                        or Path(external_target).is_relative_to(world_root)
                        or relative_text != self._external_archive_path(Path(external_target))
                        or not isinstance(external_parent, str) or not re.fullmatch(r"\d+:\d+", external_parent)):
                    raise BackupError("External backup target is invalid")
            elif external_parent is not None:
                raise BackupError("External backup target is invalid")
            world_path = (self.world_dir / Path(*relative.parts)).resolve()
            if not backup_path.is_relative_to(backup_root) or (external_target is None and not world_path.is_relative_to(world_root)):
                raise BackupError("Backup manifest path escapes its allowed root")
            seen.add(relative_text)
            entry = {"path": relative_text, "sha256": digest, "size": size}
            if action is not None:
                entry["restoreAction"] = action
            if external_target is not None:
                entry.update(externalTarget=external_target, externalParentId=external_parent)
            entries.append(entry)
        for entry in entries:
            if entry.get("restoreAction") == "remove_created" and re.fullmatch(MCC_NAME, PurePosixPath(entry["path"]).name):
                path = PurePosixPath(entry["path"])
                _, x, z, _ = path.name.split(".")
                region = str(path.with_name(f"r.{int(x) // 32}.{int(z) // 32}.mca"))
                if not any(item["path"] == region for item in entries):
                    raise BackupError("New external chunk has no backed-up region")
        return entries

    def _write_manifest(self) -> None:
        mkdir_durable(self.root)
        document = {
            "schemaVersion": 3 if any("restoreAction" in entry for entry in self.entries) else 2,
            "backupSetId": self.backup_id,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "verified": True,
            "files": self.entries,
        }
        atomic_write_text(self.manifest_path, json.dumps(document, indent=2))


def list_backup_sets(world_dir: Path, stores: list[Path] | None = None) -> list[dict]:
    """Backups of a world from the app store and, for older runs, from inside the world folder."""
    locations = stores if stores is not None else [legacy_backup_store(world_dir)]
    result = []
    seen: set[str] = set()
    for store in locations:
        if not store.is_dir():
            continue
        for manifest in store.glob("*/manifest.json"):
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
                backup_id = manifest.parent.name
                if not isinstance(data, dict) or not re.fullmatch(r"[A-Za-z0-9_-]+", backup_id) or backup_id in seen:
                    continue
                seen.add(backup_id)
                files = data.get("files", [])
                if not isinstance(files, list):
                    continue
                result.append({
                    "backupSetId": backup_id,
                    "createdAt": data.get("createdAt") or datetime.fromtimestamp(manifest.stat().st_mtime, timezone.utc).isoformat(),
                    "fileCount": len(files),
                    "verified": data.get("verified") is True,
                    "kind": "recovery" if backup_id.endswith("-recovery") else "translation",
                    "sizeBytes": sum(int(item.get("size", 0)) for item in files if isinstance(item, dict) and str(item.get("size", "")).isdigit()),
                    "inWorldFolder": store.resolve() == legacy_backup_store(world_dir),
                    "externalTargets": [item["externalTarget"] for item in files if isinstance(item, dict) and isinstance(item.get("externalTarget"), str)],
                })
            except (OSError, ValueError, TypeError, AttributeError):
                continue
    return sorted(result, key=lambda item: item["createdAt"], reverse=True)
