"""Verified backups and world fingerprints for the shipped write path."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import shutil
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

SKIP_DIR_NAMES = {".pomi-backups", ".pomi-translate", "__pycache__", ".venv"}
DATA_SUFFIXES = {".mca", ".mcc", ".mcr", ".linear", ".dat"}
DATA_NAMES = {"level.dat", "resources.zip"}
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
# Folded into every world fingerprint, so a value from the older whole-stream definition never
# compares equal to one from this definition by accident.
_FINGERPRINT_DOMAIN = b"pomi-world-files-v2\0"


class BackupError(RuntimeError):
    pass


class ExternalTargetError(BackupError):
    pass


class PlanInvalidated(RuntimeError):
    pass


# --- durability ------------------------------------------------------------------------------------


def fsync_path(path: Path) -> None:
    """Flush one file's bytes to stable storage."""
    with open(path, "rb") as stream:
        os.fsync(stream.fileno())


def fsync_directory(path: Path) -> None:
    """Flush a directory's entries, so a file created, renamed or removed in it survives power loss.

    Windows has no directory handle for this; NTFS journals the rename itself.
    """
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    except OSError as exc:
        # Some file systems and network shares cannot flush a directory. The file was flushed.
        if exc.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EBADF}:
            raise
    finally:
        os.close(descriptor)


def _fsync_directories(paths: set[Path], stop: Path) -> None:
    """Flush each directory and its parents up to and including ``stop`` (and ``stop``'s parent,
    which holds ``stop`` itself when it was just created)."""
    directories: set[Path] = set()
    for path in paths:
        current = path
        while True:
            directories.add(current)
            if current == stop or stop not in current.parents:
                break
            current = current.parent
    directories.add(stop)
    if stop.parent.is_dir():
        directories.add(stop.parent)
    for directory in sorted(directories, key=lambda item: len(item.parts), reverse=True):
        if directory.is_dir():
            fsync_directory(directory)


def _write_json_durably(path: Path, document: dict, *, indent: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, indent=indent), encoding="utf-8")
    fsync_path(temporary)
    os.replace(temporary, path)
    fsync_directory(path.parent)


# --- world fingerprints ----------------------------------------------------------------------------


def is_data_file_name(path: Path) -> bool:
    return path.suffix.lower() in DATA_SUFFIXES or path.name in DATA_NAMES


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
            if not is_data_file_name(path):
                continue
            if not path.resolve().is_relative_to(root):
                raise ValueError("World data source is outside the selected world")
            if path.is_file():
                files.append(path)
    return sorted(files)


def world_fingerprint_and_digests(world_dir: Path) -> tuple[str, dict[str, str]]:
    """The world fingerprint and every covered file's SHA-256, from one read of each file.

    The fingerprint is one stream over all files, as earlier releases computed and stored it.
    The per-file digests let a writer follow its own writes without reading the world again.
    """
    stream_digest = hashlib.sha256()
    digests: dict[str, str] = {}
    root = world_dir.resolve()
    for path in iter_data_files(root):
        relative = path.relative_to(root).as_posix()
        file_digest = hashlib.sha256()
        stream_digest.update(relative.encode("utf-8"))
        stream_digest.update(b"\0")
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                stream_digest.update(block)
                file_digest.update(block)
        stream_digest.update(b"\0")
        digests[relative] = file_digest.hexdigest()
    return stream_digest.hexdigest(), digests


def world_fingerprint(world_dir: Path) -> str:
    return world_fingerprint_and_digests(world_dir)[0]


def world_file_digests(world_dir: Path) -> dict[str, str]:
    """SHA-256 of every file the world fingerprint covers, by path relative to the world."""
    return world_fingerprint_and_digests(world_dir)[1]


def fingerprint_from_digests(digests: dict[str, str]) -> str:
    """A fingerprint of the world from per-file digests (not equal to ``world_fingerprint``).

    Each file enters through its own SHA-256, so a writer that replaces one file can update it from
    the bytes it wrote instead of reading the whole world again. Checkpoints saved between two
    region writes carry this one.
    """
    digest = hashlib.sha256(_FINGERPRINT_DOMAIN)
    for relative in sorted(digests):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(digests[relative].encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def fingerprint_key(world_dir: Path, path: Path, data_roots: list[Path] | None = None) -> str | None:
    """The key ``world_file_digests`` uses for ``path``, or None when the fingerprint ignores it."""
    from mwt.layout import world_data_roots

    root = world_dir.resolve()
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(root) or not is_data_file_name(resolved):
        return None
    relative = resolved.relative_to(root)
    if any(part in SKIP_DIR_NAMES for part in relative.parts):
        return None
    roots = data_roots if data_roots is not None else world_data_roots(root)
    if not any(resolved.is_relative_to(data_root.resolve()) for data_root in roots):
        return None
    return relative.as_posix()


def file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


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
    """Copy world files, verify the copies, and only then allow a write.

    Every copy and manifest is flushed to disk, with its directory entry, before the method that
    made it returns: a power loss right after the world file is replaced must not leave a backup
    that exists only in the page cache.
    """

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
                backup_id = str(json.loads(pointer.read_text(encoding="utf-8"))["backupSetId"])
                if backup_id.endswith("-recovery"):
                    # Older releases pointed "latest" at the recovery set a restore had just made,
                    # so restoring "latest" twice brought the translated world back.
                    backup_id = default_restore_backup_id(self.world_dir, [self.store])
        if not re.fullmatch(r"[A-Za-z0-9_-]+", backup_id):
            raise BackupError("Invalid backup set ID")
        self.backup_id = backup_id
        self.root = self.store / backup_id
        self.manifest_path = self.root / "manifest.json"
        self.entries: list[dict[str, str]] = []
        self._written: set[str] = set()
        # Entries whose manifest row and backup copy this object has already checked.
        self._checked: set[str] = set()
        # (size, mtime, inode) of the manifest this object last wrote, to notice anyone else's edit.
        self._manifest_stamp: tuple[int, int, int] | None = None

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
        for entry in backup.entries:
            if "externalTarget" in entry:
                backup._target(entry)
        backup._written = {entry["path"] for entry in backup.entries}
        backup.verify()
        return backup

    def publish_latest(self) -> None:
        """Make this set the one a restore without an id puts back. Never a recovery set."""
        if self.backup_id.endswith("-recovery"):
            raise BackupError("A recovery set is restored by its id, never as the latest backup")
        self.verify()
        _write_json_durably(self.store / "latest.json", {"backupSetId": self.backup_id})

    def external_targets(self) -> list[Path]:
        payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        return [Path(entry["externalTarget"]) for entry in self._validated_manifest_entries(payload) if "externalTarget" in entry]

    def add(self, path: Path) -> None:
        self.add_many([path])

    def add_many(self, paths: list[Path]) -> None:
        """Copy files into the set and check every copy, then write the manifest once.

        Files already in the set are skipped: the set keeps the bytes from before the first write.
        """
        known = {entry["path"]: entry for entry in self.entries}
        start = len(self.entries)
        copied_into: set[Path] = set()
        try:
            for raw in paths:
                raw = Path(raw)
                if raw.is_symlink():
                    raise BackupError("Symbolic links cannot be backed up as writable targets")
                path = raw.resolve()
                if not path.is_file():
                    continue
                external = not path.is_relative_to(self.world_dir)
                if external:
                    relative = self._external_archive_path(path)
                    target = {"externalTarget": str(path), "externalParentId": self._parent_identity(path)}
                    self._target({"path": relative, **target})
                else:
                    relative = path.relative_to(self.world_dir).as_posix()
                    target = {}
                existing = known.get(relative)
                if existing is not None:
                    if existing.get("externalTarget") != target.get("externalTarget"):
                        raise BackupError("Backup target collides with an existing entry")
                    continue
                destination = self.root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, destination)
                original = file_sha256(path)
                copied = file_sha256(destination)
                if original != copied:
                    raise BackupError(f"Backup hash mismatch for {relative}")
                fsync_path(destination)
                copied_into.add(destination.parent)
                entry = {"path": relative, "sha256": original, "size": str(path.stat().st_size), **target}
                self.entries.append(entry)
                known[relative] = entry
            if copied_into:
                _fsync_directories(copied_into, self.store)
                self._write_manifest()
        except BaseException:
            del self.entries[start:]
            raise

    def _manifest_stamp_now(self) -> tuple[int, int, int] | None:
        try:
            info = self.manifest_path.stat()
        except OSError:
            return None
        return info.st_size, info.st_mtime_ns, info.st_ino

    def verify(self) -> None:
        """Check the set before a write.

        A fresh object checks every manifest row and backup copy. After that only rows it has not
        checked yet are, so a run that backs up one file per write does not rehash every earlier
        copy each time. Every source that has not been written yet is compared with its backup on
        every call, so a file changed after it was backed up is still caught before it is written.
        """
        if not self.entries:
            raise BackupError("No files were backed up")
        stamp = self._manifest_stamp_now()
        reread = stamp is None or stamp != self._manifest_stamp
        if reread:
            # Written by someone else (or never read by this object): check what is on disk, which
            # is what a restore would use, from scratch.
            payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            if payload.get("verified") is not True:
                raise BackupError("Backup manifest is not verified")
            self.entries = self._validated_manifest_entries(payload)
            if not self.entries:
                raise BackupError("No files were backed up")
            self._checked.clear()
        unchecked = [entry for entry in self.entries if entry["path"] not in self._checked]
        if unchecked and not reread:
            checked = [entry for entry in self.entries if entry["path"] in self._checked]
            self._validated_manifest_entries({"files": unchecked}, context=checked)
        for entry in unchecked:
            if entry.get("restoreAction") != "remove_created":
                copied = self.root / entry["path"]
                if not copied.is_file() or file_sha256(copied) != entry["sha256"]:
                    raise BackupError(f"Backup verification failed for {entry['path']}")
        self._checked.update(entry["path"] for entry in unchecked)
        self._manifest_stamp = stamp
        for entry in self.entries:
            if entry["path"] in self._written:
                continue
            source = self._target(entry)
            if entry.get("restoreAction") == "remove_created":
                if source.exists():
                    raise BackupError("A new external chunk target already exists")
                continue
            if file_sha256(source) != entry["sha256"]:
                raise BackupError(f"Backup verification failed for {entry['path']}")

    def record_new_external_chunk(self, path: Path) -> None:
        self.record_new_external_chunks([path])

    def record_new_external_chunks(self, paths: list[Path]) -> None:
        """Record absence before creation so restore can recover, then remove, these files.

        The rows are validated together and the manifest is written once for the whole batch.
        """
        known = {entry["path"] for entry in self.entries}
        rows: list[dict[str, str]] = []
        for raw in paths:
            raw = Path(raw)
            candidate = Path(os.path.abspath(raw))
            if not candidate.is_relative_to(self.world_dir):
                candidate = raw.parent.resolve() / raw.name
            if not candidate.is_relative_to(self.world_dir) or not candidate.resolve().is_relative_to(self.world_dir):
                raise BackupError("New external chunks must be inside the selected world")
            relative = candidate.relative_to(self.world_dir).as_posix()
            if relative in known:
                continue
            known.add(relative)
            rows.append({"path": relative, "sha256": EMPTY_SHA256, "size": "0", "restoreAction": "remove_created"})
        if not rows:
            return
        validated = self._validated_manifest_entries({"files": rows}, context=self.entries)
        for entry in validated:
            if self._target(entry).exists():
                raise BackupError("A new external chunk target already exists")
        start = len(self.entries)
        self.entries.extend(validated)
        try:
            self._write_manifest()
        except BaseException:
            del self.entries[start:]
            raise

    def mark_written(self, paths: list[Path]) -> None:
        """Remember files this run has already replaced so later verifies do not expect the pre-write bytes."""
        for path in paths:
            resolved = path.resolve()
            self._written.add(resolved.relative_to(self.world_dir).as_posix() if resolved.is_relative_to(self.world_dir) else self._external_archive_path(resolved))

    def restore(self, recovery_store: Path | None = None) -> str:
        """Put the backed-up files back. The files they replace are kept as a recovery set first.

        The recovery set can be restored by its id. It is never published as the latest backup:
        then a second plain restore would put the translated world back.
        """
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
        recovery.add_many([current for current in (self._target(entry) for entry in entries) if current.is_file()])
        if recovery.entries:
            recovery.verify()
        ordered = sorted(entries, key=lambda entry: 2 if entry.get("restoreAction") == "remove_created"
                         else 0 if entry["path"].endswith(".mcc") else 1)
        touched: set[Path] = set()
        for entry in ordered:
            destination = self._target(entry)
            if entry.get("restoreAction") == "remove_created":
                # The recovery set above includes the current bytes, even if Minecraft
                # edited them since translation. Restore returns to the pre-write absence.
                destination.unlink(missing_ok=True)
                touched.add(destination.parent)
                continue
            source = self.root / entry["path"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(f".{destination.name}.pomi-restore-{uuid.uuid4().hex}.tmp")
            try:
                shutil.copy2(source, temporary)
                fsync_path(temporary)
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
            touched.add(destination.parent)
            if file_sha256(destination) != entry["sha256"]:
                raise BackupError(f"Restore hash mismatch for {entry['path']}")
        for directory in sorted(touched):
            if directory.is_dir():
                fsync_directory(directory)
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

    def _validated_manifest_entries(self, payload: dict, *, context: list[dict[str, str]] | None = None) -> list[dict[str, str]]:
        """Check manifest rows. ``context`` holds rows already checked that these rows join."""
        files = payload.get("files")
        if not isinstance(files, list):
            raise BackupError("Backup manifest file list is invalid")
        world_root = self.world_dir.resolve()
        backup_root = self.root.resolve()
        entries: list[dict[str, str]] = []
        known = list(context or [])
        seen: set[str] = {entry["path"] for entry in known}
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
                or not re.fullmatch(r"c\.-?\d+\.-?\d+\.mcc", relative.name)
                or digest != EMPTY_SHA256 or size != "0"
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
        backed_up_regions = {
            item["path"] for item in [*known, *entries] if "restoreAction" not in item
        }
        for entry in entries:
            if entry.get("restoreAction") == "remove_created":
                path = PurePosixPath(entry["path"])
                _, x, z, _ = path.name.split(".")
                region = str(path.with_name(f"r.{int(x) // 32}.{int(z) // 32}.mca"))
                if region not in backed_up_regions:
                    raise BackupError("New external chunk has no backed-up region")
        return entries

    def _write_manifest(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        document = {
            "schemaVersion": 3 if any("restoreAction" in entry for entry in self.entries) else 2,
            "backupSetId": self.backup_id,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "verified": True,
            "files": self.entries,
        }
        _write_json_durably(self.manifest_path, document, indent=2)
        _fsync_directories({self.root}, self.store)
        self._manifest_stamp = self._manifest_stamp_now()


def default_restore_backup_id(world_dir: Path, stores: list[Path] | None = None) -> str:
    """The backup a restore without an id puts back: the newest verified translation backup.

    A recovery set holds what a restore replaced. As the default it would let a second restore undo
    the first, so it is only ever restored by its id.
    """
    for item in list_backup_sets(world_dir, stores):
        if item["kind"] != "recovery" and item["verified"]:
            return item["backupSetId"]
    raise BackupError("There is no backup to restore")


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
                if not re.fullmatch(r"[A-Za-z0-9_-]+", backup_id) or backup_id in seen:
                    continue
                seen.add(backup_id)
                files = data.get("files", [])
                result.append({
                    "backupSetId": backup_id,
                    "createdAt": data.get("createdAt") or datetime.fromtimestamp(manifest.stat().st_mtime, timezone.utc).isoformat(),
                    "fileCount": len(files),
                    "verified": data.get("verified") is True,
                    "kind": "recovery" if backup_id.endswith("-recovery") else "translation",
                    "sizeBytes": sum(int(item.get("size", 0)) for item in files if str(item.get("size", "")).isdigit()),
                    "inWorldFolder": store.resolve() == legacy_backup_store(world_dir),
                    "externalTargets": [item["externalTarget"] for item in files if isinstance(item, dict) and isinstance(item.get("externalTarget"), str)],
                })
            except (OSError, ValueError, TypeError):
                continue
    return sorted(result, key=lambda item: item["createdAt"], reverse=True)
