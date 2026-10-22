"""Recovery journal: what a write job intends, what it changed, and how to undo it.

Every job that changes world files (a translation, a restore, a recovery) owns one backup set,
and the set owns one record of the job: ``<backup set>/journal.json``. The record is rewritten
only through the durable atomic writer, never edited in place, and each rewrite carries a larger
``seq``. Its evidence is hashes, not trust:

* before the first byte of the world changes, the record holds, for every target, the state it
  is in now (``preimage``), where its backup lives, and the hash of the bytes the job will put
  there (``post``);
* recovery re-hashes the live file and compares it with those two states. Equal to the preimage:
  nothing happened. Equal to the postimage: the job wrote it, and it may be rolled back from the
  backup. Anything else (a game, another tool, or the user changed it since) is a conflict: its
  current bytes are copied to a quarantine folder and the file is not touched.

A *unit* groups targets that only make sense together: one region file with every ``.mcc`` it
references, one resource-pack ZIP. Within a unit targets are published payloads first, region
last, so the region never points at a payload that is not on disk yet. A job is not atomic
across units; each unit is reported on its own.

What this does not promise: no cross-file atomicity under power loss. See docs/safety-model.md.
"""

from __future__ import annotations

import copy
import errno
import hashlib
import json
import os
import re
import shutil
import stat
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from mwt.durable import atomic_write_text, copy_durable, fsync_dir, mkdir_durable
from mwt.durable import replace as durable_replace

JOURNAL_NAME = "journal.json"
SCHEMA_VERSION = 1

STATES = frozenset({
    "preparing", "prepared", "committing", "committed", "partial",
    "rolled_back", "recovery_conflict", "recovering",
})
TERMINAL_STATES = frozenset({"committed", "rolled_back"})
OUTCOMES = frozenset({"pending", "written", "verified", "failed", "unknown", "restored"})
KINDS = frozenset({"translate", "restore", "recovery"})
ROOT_KINDS = frozenset({"world", "external_pack"})
# A job in one of these states died in the middle of a write; a new write waits for its recovery.
# (partial and recovery_conflict are finished, if unhappy, jobs and do not block.)
BLOCKING_STATES = frozenset({"preparing", "prepared", "committing", "recovering", "invalid"})

# Minimum seconds between two outcome-only rewrites. State changes and failures always write at
# once. A lost outcome is harmless: recovery re-hashes every target instead of believing it.
SAVE_INTERVAL = 1.0

_SHA = re.compile(r"[0-9a-f]{64}")
_ID = re.compile(r"[A-Za-z0-9_-]+")
_STATE_PEEK = re.compile(rb'"state":"([a-z_]+)"')
_SETTLED_PEEK = re.compile(rb'"settled":(true|false)')
_ABSENT = {"absent": True, "sha256": "", "size": 0}


class JournalError(RuntimeError):
    """A journal problem with a stable code the interface can show."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class WorldChanged(JournalError):
    """The world is not what the scan (or the plan) saw. Nothing was written for this target."""

    def __init__(self, message: str) -> None:
        super().__init__("WORLD_CHANGED", message)


class DiskFull(JournalError):
    def __init__(self, message: str) -> None:
        super().__init__("DISK_FULL", message)


# ---------------------------------------------------------------- fault injection (tests only)

_fault_hook: Callable[[str, dict], None] | None = None


def set_fault_hook(hook: Callable[[str, dict], None] | None) -> Callable[[str, dict], None] | None:
    """Install a callback run at every boundary of a write; returns the previous one.

    A test makes the callback raise a ``BaseException`` to stand in for a crash: nothing in this
    module catches that, so the journal and the world stay exactly as the crash found them.
    """
    global _fault_hook
    previous, _fault_hook = _fault_hook, hook
    return previous


def fault_point(name: str, **detail: Any) -> None:
    hook = _fault_hook
    if hook is not None:
        hook(name, detail)


def is_disk_full(exc: BaseException) -> bool:
    return isinstance(exc, OSError) and exc.errno in {errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC)}


# ---------------------------------------------------------------- file state

def sha256_file(path: Path) -> tuple[str, int]:
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256")
        size = stream.tell()
    return digest.hexdigest(), size


def state_of(path: Path) -> dict:
    """``{absent, sha256, size}`` of what is at ``path`` now. A link or a folder is refused."""
    try:
        info = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return dict(_ABSENT)
    if not stat.S_ISREG(info.st_mode):
        raise JournalError("UNREADABLE", f"{path.name} is not a regular file")
    sha, size = sha256_file(path)
    return {"absent": False, "sha256": sha, "size": size}


def same_state(first: dict, second: dict) -> bool:
    if first.get("absent") or second.get("absent"):
        return bool(first.get("absent")) and bool(second.get("absent"))
    return first.get("sha256") == second.get("sha256")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _app_version() -> str:
    from mwt.locking import _app_version as version

    return version()


def world_key(world_dir: Path) -> str:
    return hashlib.sha256(os.path.normcase(os.path.realpath(world_dir)).encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------- plan description

@dataclass
class TargetSpec:
    """One file a job will write (or remove, when ``source`` is None)."""

    path: Path
    root_kind: str = "world"
    source: Path | None = None  # file that holds the intended postimage
    role: str = "file"  # "payload" (.mcc), "region", "pack" or "file"
    # The state the plan was made against: a sha256, "" for "must not exist", None for "unchecked".
    expected_pre: str | None = None
    discard_source: bool = False  # delete ``source`` once the target is verified (staged copies)


@dataclass
class UnitSpec:
    unit_id: str
    kind: str
    label: str
    targets: list[TargetSpec]  # in publish order
    bystanders: list[Path] = field(default_factory=list)  # backed up, never written
    precheck: Callable[[], None] | None = None  # runs just before the first publish; may raise WorldChanged


@dataclass
class UnitResult:
    unit_id: str
    kind: str
    label: str
    verified: bool = False
    written: list[Path] = field(default_factory=list)  # targets whose bytes were checked after the write
    unknown: list[Path] = field(default_factory=list)  # targets whose result could not be checked
    error: BaseException | None = None
    error_code: str = ""
    attempted: bool = False  # false: the job stopped before reaching this unit


@dataclass
class TransactionResult:
    units: list[UnitResult]
    state: str
    stopped: str = ""  # "" or the code that stopped the job (WORLD_CHANGED, DISK_FULL, ...)


# ---------------------------------------------------------------- the record

class Journal:
    def __init__(self, path: Path, doc: dict) -> None:
        self.path = path
        self.doc = doc
        self._dirty = False
        self._last_save = 0.0

    # -- construction -----------------------------------------------------------------------

    @classmethod
    def create(cls, path: Path, *, job_id: str, kind: str, world_dir: Path) -> "Journal":
        if kind not in KINDS:
            raise ValueError("Unknown journal kind")
        resolved = Path(world_dir).resolve()
        doc = {
            "schemaVersion": SCHEMA_VERSION,
            "jobId": job_id,
            "state": "preparing",
            "settled": False,
            "kind": kind,
            "seq": 0,
            "worldKey": world_key(resolved),
            "worldPath": str(resolved),
            "worldName": resolved.name,
            "createdAt": _now(),
            "updatedAt": _now(),
            "appVersion": _app_version(),
            "units": [],
            "log": [],
        }
        return cls(Path(path), doc)

    @classmethod
    def load(cls, path: Path) -> "Journal":
        path = Path(path)
        try:
            raw = path.read_bytes()
        except FileNotFoundError as exc:
            raise JournalError("JOURNAL_NOT_FOUND", "There is no recovery record for this job") from exc
        except OSError as exc:
            raise JournalError("JOURNAL_INVALID", "The recovery record could not be read") from exc
        try:
            doc = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise JournalError("JOURNAL_INVALID", "The recovery record is damaged") from exc
        validate_document(doc)
        return cls(path, doc)

    # -- accessors --------------------------------------------------------------------------

    @property
    def job_id(self) -> str:
        return self.doc["jobId"]

    @property
    def kind(self) -> str:
        return self.doc["kind"]

    @property
    def state(self) -> str:
        return self.doc["state"]

    @property
    def settled(self) -> bool:
        return bool(self.doc.get("settled")) or self.state in TERMINAL_STATES

    @property
    def units(self) -> list[dict]:
        return self.doc["units"]

    @property
    def world_dir(self) -> Path:
        return Path(self.doc["worldPath"])

    def find_unit(self, unit_id: str) -> dict | None:
        return next((unit for unit in self.units if unit["unitId"] == unit_id), None)

    def targets(self):
        for unit in self.units:
            for target in unit["targets"]:
                yield unit, target

    def unit_verified(self, unit: dict) -> bool:
        return bool(unit["targets"]) and all(target["outcome"] == "verified" for target in unit["targets"])

    def all_verified(self) -> bool:
        return all(self.unit_verified(unit) for unit in self.units)

    def counts(self) -> dict[str, int]:
        total = len(self.units)
        verified = sum(1 for unit in self.units if self.unit_verified(unit))
        unknown = sum(1 for unit in self.units if any(t["outcome"] == "unknown" for t in unit["targets"]))
        return {"unitsTotal": total, "unitsVerified": verified, "unitsUnknown": unknown}

    # -- writing ----------------------------------------------------------------------------

    def set_state(self, state: str, *, save: bool = True, settled: bool | None = None) -> None:
        """Move to ``state``. Only a terminal state (or an explicit ``settled``) closes the job;
        any other state reopens it, so a job continued by a later attempt is listed again."""
        if state not in STATES:
            raise ValueError("Unknown journal state")
        self.doc["state"] = state
        self.doc["settled"] = state in TERMINAL_STATES if settled is None else bool(settled)
        self._dirty = True
        if save:
            self.save()

    def note(self, unit: dict, what: str) -> None:
        """A log line for something that is not a target transition (a unit that failed)."""
        self.doc["log"].append([self.doc["seq"] + 1, unit["unitId"], "*", what])
        self._dirty = True

    def record(self, unit: dict, target: dict, outcome: str, *, error: str = "", save: bool = True) -> None:
        """One transition of one target. ``seq`` grows by one per rewrite, the log keeps every step."""
        if outcome not in OUTCOMES:
            raise ValueError("Unknown target outcome")
        seq = self.doc["seq"] + 1
        target["outcome"] = outcome
        target["seq"] = seq
        if error:
            target["error"] = error
        else:
            target.pop("error", None)
        self.doc["log"].append([seq, unit["unitId"], target["path"], outcome])
        self._dirty = True
        if not save:
            return
        if outcome in {"failed", "unknown"} or time.monotonic() - self._last_save >= SAVE_INTERVAL:
            self.save()

    def save(self) -> None:
        """Rewrite the whole record durably. The rewrite is the commit."""
        self.doc["seq"] += 1
        self.doc["updatedAt"] = _now()
        text = json.dumps(self.doc, ensure_ascii=False, separators=(",", ":"))
        mkdir_durable(self.path.parent)
        atomic_write_text(self.path, text)
        self._dirty = False
        self._last_save = time.monotonic()

    def flush(self) -> None:
        if self._dirty:
            self.save()

    def summary(self) -> dict:
        counts = self.counts()
        return {
            "jobId": self.job_id,
            "kind": self.kind,
            "worldPath": self.doc["worldPath"],
            "worldName": self.doc["worldName"],
            "createdAt": self.doc["createdAt"],
            **counts,
            "needsAttention": not self.settled,
            "legacy": False,
            "journalState": self.state,
        }


def validate_document(doc: Any) -> None:
    """Refuse a record that does not have exactly the shape this module writes."""
    def bad(reason: str) -> JournalError:
        return JournalError("JOURNAL_INVALID", f"The recovery record is not valid ({reason})")

    if not isinstance(doc, dict) or doc.get("schemaVersion") != SCHEMA_VERSION:
        raise bad("version")
    for key in ("jobId", "state", "kind", "worldPath", "worldName", "createdAt"):
        if not isinstance(doc.get(key), str):
            raise bad(key)
    if not _ID.fullmatch(doc["jobId"]) or doc["state"] not in STATES or doc["kind"] not in KINDS:
        raise bad("header")
    if not isinstance(doc.get("seq"), int) or isinstance(doc.get("seq"), bool) or doc["seq"] < 0:
        raise bad("seq")
    if not Path(doc["worldPath"]).is_absolute():
        raise bad("worldPath")
    if not isinstance(doc.get("units"), list) or not isinstance(doc.get("log"), list):
        raise bad("units")
    seen_units: set[str] = set()
    for unit in doc["units"]:
        if not isinstance(unit, dict) or not isinstance(unit.get("unitId"), str) or unit["unitId"] in seen_units:
            raise bad("unit")
        seen_units.add(unit["unitId"])
        if not isinstance(unit.get("kind"), str) or not isinstance(unit.get("label"), str):
            raise bad("unit")
        targets = unit.get("targets")
        if not isinstance(targets, list):
            raise bad("targets")
        seen_paths: set[str] = set()
        for target in targets:
            _validate_target(target, seen_paths, bad)


def _validate_target(target: Any, seen: set[str], bad: Callable[[str], JournalError]) -> None:
    if not isinstance(target, dict):
        raise bad("target")
    path, root = target.get("path"), target.get("rootKind")
    if not isinstance(path, str) or root not in ROOT_KINDS or path in seen:
        raise bad("target path")
    seen.add(path)
    pure = PurePosixPath(path)
    if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts) or "\\" in path:
        raise bad("target path")
    if root == "external_pack":
        external = target.get("externalTarget")
        parent = target.get("externalParentId")
        if (not isinstance(external, str) or not Path(external).is_absolute()
                or Path(external).suffix.lower() != ".zip" or not isinstance(parent, str)
                or not re.fullmatch(r"\d+:\d+", parent)):
            raise bad("external target")
    elif "externalTarget" in target:
        raise bad("external target")
    for key in ("preimage", "post"):
        state = target.get(key)
        if (not isinstance(state, dict) or not isinstance(state.get("absent"), bool)
                or not isinstance(state.get("size"), int)
                or not isinstance(state.get("sha256"), str)
                or (not state["absent"] and not _SHA.fullmatch(state["sha256"]))):
            raise bad(key)
    backup = target.get("backup")
    if backup != "absent" and (not isinstance(backup, str) or not backup
            or PurePosixPath(backup).is_absolute() or ".." in PurePosixPath(backup).parts):
        raise bad("backup")
    if (backup == "absent") != target["preimage"]["absent"]:
        raise bad("backup")
    if target.get("outcome") not in OUTCOMES or not isinstance(target.get("priorPosts"), list):
        raise bad("outcome")
    if any(not isinstance(item, str) or not _SHA.fullmatch(item) for item in target["priorPosts"]):
        raise bad("priorPosts")


def peek_unsettled(journal_path: Path) -> bool | None:
    """Cheap test of a record's header: True when it may need attention, False when settled.

    The header (``state``, ``settled``) is written first, so the first few KiB are enough and a
    store with hundreds of finished jobs is not parsed on every start. ``None``: unreadable.
    """
    try:
        with journal_path.open("rb") as stream:
            head = stream.read(4096)
    except OSError:
        return None
    state = _STATE_PEEK.search(head)
    if state is None:
        return None
    settled = _SETTLED_PEEK.search(head)
    if state.group(1).decode() in TERMINAL_STATES:
        return False  # "committed" is only written once every unit is verified
    return not (settled is not None and settled.group(1) == b"true")


def list_interrupted(stores: list[Path]) -> list[dict]:
    """Records that are not settled, newest first. Read-only: nothing is repaired or deleted."""
    found: dict[str, dict] = {}
    for store in stores:
        try:
            candidates = sorted(Path(store).glob(f"*/{JOURNAL_NAME}"))
        except OSError:
            continue
        for path in candidates:
            job_id = path.parent.name
            if job_id in found or not _ID.fullmatch(job_id):
                continue
            unsettled = peek_unsettled(path)
            if unsettled is False:
                continue
            try:
                journal = Journal.load(path)
            except JournalError as exc:
                try:
                    created = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
                except OSError:
                    created = ""
                found[job_id] = {
                    "jobId": job_id, "kind": "translate", "worldPath": "", "worldName": Path(store).name,
                    "createdAt": created,
                    "unitsTotal": 0, "unitsVerified": 0, "unitsUnknown": 0,
                    "needsAttention": True, "legacy": False, "journalState": "invalid", "errorCode": exc.code,
                }
                continue
            summary = journal.summary()
            if summary["needsAttention"]:
                found[job_id] = summary
    return sorted(found.values(), key=lambda item: item["createdAt"], reverse=True)


def journal_state_of_set(set_dir: Path) -> str | None:
    """State of a backup set's journal, or None for a set written before journals existed."""
    path = Path(set_dir) / JOURNAL_NAME
    if not path.is_file():
        return None
    try:
        return Journal.load(path).state
    except JournalError:
        return "invalid"


def unsettled_for_world(world_dir: Path, stores: list[Path], *, ignore: str = "") -> list[dict]:
    """Interrupted jobs of this world (``ignore``: the caller's own job id)."""
    target = world_key(world_dir)
    return [
        item for item in list_interrupted(stores)
        if item["jobId"] != ignore and (not item["worldPath"] or world_key(Path(item["worldPath"])) == target)
    ]


# ---------------------------------------------------------------- the write transaction

@dataclass
class _Planned:
    """One unit of a transaction: its journal record and, per target, the spec and journal entry."""

    spec: UnitSpec
    record: dict
    targets: list[tuple[TargetSpec, dict]]


class WriteTransaction:
    """Intent -> backup -> prepared -> publish -> verify, with every step on record.

    The caller holds every guard (world write lock, session locks, external target locks) for
    the whole call. ``backup`` is the set whose payloads make a rollback possible.
    """

    def __init__(
        self,
        journal: Journal,
        backup: Any,
        world_dir: Path,
        *,
        retries: int = 1,
        on_retry: Callable[[Path, int, BaseException], None] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        write_bytes: Callable[[Path, bytes], None] | None = None,
        should_stop: Callable[[], bool] | None = None,
    ) -> None:
        """``write_bytes`` replaces the default file writer (the translator passes its own, which
        retries and notifies the interface); ``should_stop`` is asked before each unit."""
        self.journal = journal
        self.backup = backup
        self.world_dir = Path(world_dir).resolve()
        self.retries = max(1, int(retries))
        self.on_retry = on_retry
        self._sleep = sleep
        self._write_bytes = write_bytes
        self._should_stop = should_stop

    # -- public -----------------------------------------------------------------------------

    def run(
        self,
        units: list[UnitSpec],
        *,
        stop_on_error: bool = False,
        on_unit_done: Callable[[UnitResult], None] | None = None,
    ) -> TransactionResult:
        """Write ``units`` in order. Raises before any world byte changes when the plan is stale
        (``WorldChanged``), a payload cannot be made (``DiskFull`` or the OS error), and leaves a
        settled record in that case when nothing was touched."""
        journal = self.journal
        info = {"kind": journal.kind}
        if not units:
            return TransactionResult([], journal.state)
        snapshot = copy.deepcopy(journal.doc)
        journal.set_state("preparing", save=False)
        planned: list[_Planned] = []
        try:
            planned = [self._plan_unit(unit) for unit in units]  # WorldChanged: nothing persisted yet
            journal.save()
            fault_point("intent_persisted", **info)
            self._backup(planned)
            journal.set_state("prepared")
            fault_point("prepared", **info)
        except Exception as exc:
            if planned and journal.path.exists():
                self._abort(planned)
            else:
                journal.doc = snapshot  # the plan never reached the disk: forget it
            if is_disk_full(exc):
                raise DiskFull("The disk is full: the backup or the new files could not be saved") from exc
            raise
        journal.set_state("committing")
        results: list[UnitResult] = []
        stopped = ""
        for item in planned:
            if not stopped and self._should_stop is not None and self._should_stop():
                stopped = "CANCELLED"
            if stopped:
                results.append(UnitResult(item.spec.unit_id, item.spec.kind, item.spec.label))
                continue
            result = self._publish_unit(item)
            results.append(result)
            fault_point("unit_done", unit=item.spec.unit_id, **info)
            if on_unit_done is not None:
                on_unit_done(result)
            if result.error_code in {"WORLD_CHANGED", "DISK_FULL"}:
                stopped = result.error_code
            elif stop_on_error and not result.verified:
                stopped = result.error_code or "WRITE_FAILED"
        return TransactionResult(results, self._finalize(), stopped)

    # -- planning ---------------------------------------------------------------------------

    def _relative(self, path: Path, root_kind: str) -> str:
        if root_kind == "external_pack":
            return path.name
        resolved = Path(os.path.abspath(path))
        if not resolved.is_relative_to(self.world_dir):
            raise JournalError("JOURNAL_INVALID", f"{path.name} is outside its authorized root")
        return resolved.relative_to(self.world_dir).as_posix()

    def _plan_unit(self, unit: UnitSpec) -> _Planned:
        record = self.journal.find_unit(unit.unit_id)
        if record is None:
            record = {"unitId": unit.unit_id, "kind": unit.kind, "label": unit.label, "targets": []}
            self.journal.units.append(record)
        return _Planned(unit, record, [(spec, self._plan_target(record, spec)) for spec in unit.targets])

    def _plan_target(self, unit: dict, spec: TargetSpec) -> dict:
        if spec.root_kind not in ROOT_KINDS:
            raise ValueError("Unknown root kind")
        path = Path(spec.path) if spec.root_kind == "external_pack" else Path(os.path.abspath(spec.path))
        relative = self._relative(path, spec.root_kind)
        current = state_of(path)
        existing = next((t for t in unit["targets"] if t["path"] == relative and t["rootKind"] == spec.root_kind), None)
        post = dict(_ABSENT) if spec.source is None else self._source_state(spec.source)
        if existing is None:
            if spec.expected_pre is not None and not _matches(current, spec.expected_pre):
                raise WorldChanged(f"{path.name} changed after the scan")
            target = {
                "path": relative,
                "rootKind": spec.root_kind,
                "role": spec.role,
                "preimage": current,
                "backup": "absent" if current["absent"] else self._backup_path(path, spec.root_kind, relative),
                "post": post,
                "priorPosts": [],
                "outcome": "pending",
                "seq": self.journal.doc["seq"],
            }
            if spec.root_kind == "external_pack":
                from mwt.locking import object_identity

                target["externalTarget"] = str(path)
                target["externalParentId"] = object_identity(path.parent)
            unit["targets"].append(target)
            return target
        # A later attempt at the same file (a resumed job): the first preimage stays the one to
        # roll back to, and whatever the earlier attempt may have written is still ours.
        if not any(same_state(current, item) for item in _known_states(existing)):
            raise WorldChanged(f"{path.name} changed since the previous attempt")
        old = existing["post"]
        if not old["absent"] and old["sha256"] != post["sha256"] and old["sha256"] not in existing["priorPosts"]:
            existing["priorPosts"].append(old["sha256"])
        existing["post"] = post
        existing["role"] = spec.role
        existing["outcome"] = "pending"
        existing.pop("error", None)
        return existing

    @staticmethod
    def _source_state(source: Path) -> dict:
        sha, size = sha256_file(source)
        return {"absent": False, "sha256": sha, "size": size}

    def _backup_path(self, path: Path, root_kind: str, relative: str) -> str:
        if root_kind == "external_pack":
            return self.backup._external_archive_path(path.resolve())
        return relative

    def _live_path(self, target: dict) -> Path:
        if target["rootKind"] == "external_pack":
            return Path(target["externalTarget"])
        return self.world_dir / Path(*PurePosixPath(target["path"]).parts)

    # -- backup -----------------------------------------------------------------------------

    def _backup(self, planned: list[_Planned]) -> None:
        backup = self.backup
        count = 0
        absent: list[tuple[Path, dict]] = []
        for item in planned:
            for path in item.spec.bystanders:
                backup.add(path, commit=False)
            for _spec, target in item.targets:
                path = self._live_path(target)
                if target["preimage"]["absent"]:
                    absent.append((path, target))
                    continue
                backup.add(path, commit=False)
                entry = backup.entry_for(path)
                if entry is None or entry["sha256"] != target["preimage"]["sha256"]:
                    if not target["priorPosts"]:
                        raise WorldChanged(f"{path.name} changed while it was being backed up")
                count += 1
                fault_point("backup_payload", kind=self.journal.kind, index=count, path=str(path))
        # Absence goes in after every present file: an .mcc entry needs its region in the set.
        for path, target in absent:
            if target["rootKind"] == "world":
                backup.record_absent(path, commit=False)
            count += 1
            fault_point("backup_payload", kind=self.journal.kind, index=count, path=str(path))
        backup.commit()
        backup.verify()  # every payload re-read and compared before any world file is touched
        backup.publish_latest(verify=False)

    def _abort(self, planned: list[_Planned]) -> None:
        """A failure before the first publish: close the record if nothing was touched."""
        journal = self.journal
        try:
            if self._untouched():
                journal.doc["settledBy"] = "untouched"
                journal.set_state("rolled_back")
            else:
                journal.set_state("partial")
        except Exception:
            pass  # the original error is the one to report; the record stays as it was

    # -- publishing -------------------------------------------------------------------------

    def _publish_unit(self, item: _Planned) -> UnitResult:
        unit, record = item.spec, item.record
        journal = self.journal
        result = UnitResult(unit.unit_id, unit.kind, unit.label, attempted=True)
        info = {"kind": journal.kind, "unit": unit.unit_id}
        try:
            if unit.precheck is not None:
                unit.precheck()
            for index, (spec, target) in enumerate(item.targets):
                path = self._live_path(target)
                if index:
                    fault_point("between_targets", index=index, **info)
                self._publish_target(record, spec, target, path, info)
                if target["outcome"] == "unknown":
                    result.error_code = "UNKNOWN_OUTCOME"
                    result.error = RuntimeError(f"{path.name}: the result of the write could not be read back")
                    break
                if target["outcome"] != "verified":
                    result.error_code = "VERIFY_MISMATCH"
                    result.error = RuntimeError(f"{path.name}: the written file does not match what was planned")
                    break
                if spec.discard_source and spec.source is not None:
                    spec.source.unlink(missing_ok=True)
        except Exception as exc:  # a crash (BaseException) is deliberately not handled here
            result.error = exc
            result.error_code = getattr(exc, "code", "") or ("DISK_FULL" if is_disk_full(exc) else "WRITE_FAILED")
            for target in record["targets"]:
                if target["outcome"] == "pending":
                    target["error"] = result.error_code
            journal.note(record, f"failed:{result.error_code}")
            journal.save()
        # What reached the disk is read from the record, whatever went wrong afterwards: a file
        # that was replaced and read back counts even when the flush that followed failed.
        for spec, target in item.targets:
            path = self._live_path(target)
            if target["outcome"] in {"verified", "written"} and not target["post"]["absent"]:
                result.written.append(path)
                self.backup.mark_written([path])
            elif target["outcome"] == "unknown":
                result.unknown.append(path)
        result.verified = journal.unit_verified(record)
        return result

    def _publish_target(self, record: dict, spec: TargetSpec, target: dict, path: Path, info: dict) -> None:
        journal = self.journal
        # Re-check the file right before replacing it. The guards keep cooperating programs out;
        # this catches one that does not cooperate.
        current = state_of(path)
        if not any(same_state(current, item) for item in _known_states(target)):
            raise WorldChanged(f"{path.name} changed before it could be written")
        try:
            self._write_with_retries(spec, path, info)
        except Exception as exc:
            # Something failed on the way. Say what the file is now, instead of guessing.
            code = "DISK_FULL" if is_disk_full(exc) else "WRITE_FAILED"
            try:
                now = state_of(path)
            except (OSError, JournalError):
                journal.record(record, target, "unknown", error=code)
                raise
            if same_state(now, target["preimage"]) and not same_state(now, target["post"]):
                journal.record(record, target, "failed", error=code)  # never replaced
            elif same_state(now, target["post"]):
                # Replaced and read back, but a later flush failed: the bytes are there, their
                # durability is not confirmed. Kept as an error, never converted to success.
                journal.record(record, target, "written", error=code)
                if not is_disk_full(exc):
                    raise JournalError("WRITE_NOT_DURABLE", f"{path.name} was written but could not be flushed to disk: {exc}") from exc
            else:
                journal.record(record, target, "failed", error=code)
            if is_disk_full(exc):
                raise DiskFull(f"The disk is full while writing {path.name}") from exc
            raise
        fault_point("after_replace", path=str(path), **info)
        try:
            actual = state_of(path)
        except (OSError, JournalError):
            journal.record(record, target, "unknown", error="VERIFY_UNREADABLE")
            return
        if not same_state(actual, target["post"]):
            journal.record(record, target, "failed", error="VERIFY_MISMATCH")
            return
        fault_point("after_verify", path=str(path), **info)
        journal.record(record, target, "verified")

    def _write_with_retries(self, spec: TargetSpec, path: Path, info: dict) -> None:
        for attempt in range(1, self.retries + 1):
            try:
                self._write_file(spec, path, info)
                return
            except OSError as exc:
                if is_disk_full(exc) or attempt == self.retries:
                    raise
                if self.on_retry is not None:
                    self.on_retry(path, attempt, exc)
                self._sleep(min(0.5 * attempt, 2.0))

    def _write_file(self, spec: TargetSpec, path: Path, info: dict) -> None:
        if spec.source is None:
            if os.path.lexists(path):
                path.unlink()
                fsync_dir(path.parent)
            return
        mkdir_durable(path.parent)
        if self._write_bytes is not None:
            fault_point("before_replace", path=str(path), **info)
            self._write_bytes(path, spec.source.read_bytes())
            return
        temporary = path.with_name(f".{path.name}.pomi-write-{uuid.uuid4().hex}.tmp")
        try:
            copy_durable(spec.source, temporary)  # flushed to the device before it can replace anything
            if os.path.lexists(path):
                shutil.copymode(path, temporary)
            fault_point("before_replace", path=str(path), **info)
            durable_replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        fsync_dir(path.parent)

    # -- end of job -------------------------------------------------------------------------

    def _finalize(self) -> str:
        journal = self.journal
        fault_point("before_final_state", kind=journal.kind)
        if journal.all_verified():
            journal.set_state("committed")
            return "committed"
        if self._untouched():
            journal.doc["settledBy"] = "untouched"
            journal.set_state("rolled_back")
            return "rolled_back"
        journal.set_state("partial")
        return "partial"

    def _untouched(self) -> bool:
        """True when every target still holds its preimage: the job changed nothing."""
        for _unit, target in self.journal.targets():
            try:
                if not same_state(state_of(self._live_path(target)), target["preimage"]):
                    return False
            except (OSError, JournalError):
                return False
        return True


def _known_states(target: dict) -> list[dict]:
    """Every state a target may legitimately be in: before the job, planned, or an earlier plan's."""
    states = [target["preimage"], target["post"]]
    states.extend({"absent": False, "sha256": sha, "size": 0} for sha in target["priorPosts"])
    return states


def _matches(current: dict, expected: str) -> bool:
    if expected == "":
        return bool(current.get("absent"))
    return not current.get("absent") and current.get("sha256") == expected


def staging_dir(backup_root: Path) -> Path:
    """Where postimages wait until the backup is verified. Inside the backup set, so deleting the
    set deletes them too; emptied after each job."""
    return Path(backup_root) / "staging"


def clear_staging(backup_root: Path) -> None:
    shutil.rmtree(staging_dir(backup_root), ignore_errors=True)


# ---------------------------------------------------------------- recovery

@dataclass
class Classified:
    unit: dict
    target: dict
    path: Path
    current: dict | None  # None: could not be read
    kind: str  # "pristine" | "owned" | "conflict"
    code: str = ""  # "RECOVERY_CONFLICT" | "MISSING" | "UNREADABLE" for a conflict


def resolve_target(journal: Journal, target: dict, authorized: set[str]) -> Path:
    """The live path of a journal target, after checking that it is still allowed to be touched.

    A record cannot grant itself access: a world target must stay inside the world with no link
    on the way, an external pack must be one the user selected, and its folder must be the same
    folder as when the job started.
    """
    from mwt.locking import object_identity
    from mwt.safety import ExternalTargetError

    if target["rootKind"] == "external_pack":
        selected = target["externalTarget"]
        path = Path(selected)
        try:
            ok = (selected in authorized and not path.is_symlink()
                  and object_identity(path.parent) == target["externalParentId"])
        except OSError:
            ok = False
        if not ok:
            raise ExternalTargetError("External resource pack is unavailable or not explicitly selected")
        return path
    world = journal.world_dir.resolve()
    path = world / Path(*PurePosixPath(target["path"]).parts)
    if not path.resolve(strict=False).is_relative_to(world) or any(
        parent.is_symlink() for parent in [path, *path.parents] if parent.is_relative_to(world) and parent != world
    ):
        raise JournalError("JOURNAL_INVALID", "A recovery target is outside the world folder")
    return path


def classify(journal: Journal, authorized: set[str]) -> list[Classified]:
    """Re-hash every target of the job, verified ones included, and sort it into one of three."""
    classes: list[Classified] = []
    for unit, target in journal.targets():
        path = resolve_target(journal, target, authorized)
        try:
            current = state_of(path)
        except (OSError, JournalError):
            classes.append(Classified(unit, target, path, None, "conflict", "UNREADABLE"))
            continue
        if same_state(current, target["preimage"]):
            classes.append(Classified(unit, target, path, current, "pristine"))
        elif any(same_state(current, item) for item in _known_states(target)[1:]):
            classes.append(Classified(unit, target, path, current, "owned"))
        else:
            code = "MISSING" if current["absent"] else "RECOVERY_CONFLICT"
            classes.append(Classified(unit, target, path, current, "conflict", code))
    return classes


def _public_conflict(item: Classified) -> dict:
    return {"path": item.target["path"], "rootKind": item.target["rootKind"], "code": item.code}


def _quarantine(host_root: Path, recovery_id: str, items: list[Classified]) -> Path | None:
    """Copy the bytes of every conflicting file aside. The files themselves stay where they are."""
    copied = False
    directory = host_root / "quarantine" / recovery_id
    for item in items:
        if item.current is None or item.current["absent"]:
            continue
        destination = directory / item.target["rootKind"] / Path(*PurePosixPath(item.target["path"]).parts)
        mkdir_durable(destination.parent)
        copy_durable(item.path, destination)
        copied = True
    return directory if copied else None


def recover_job(
    journal_path: Path,
    mode: str,
    *,
    authorized_external: list[Path] | None = None,
    lock_dir: Path | None = None,
    progress: Callable[[int, int], None] | None = None,
    retries: int = 2,
) -> dict:
    """Settle an interrupted job: ``rollback`` its own writes or ``keep`` the world as it is.

    Every guard a write needs is taken first; if one is busy this raises ``WorldWriteLocked``,
    ``MinecraftWorldInUse`` or ``TargetLocked`` and changes nothing.
    """
    if mode not in {"rollback", "keep"}:
        raise ValueError("Recovery mode must be rollback or keep")
    from mwt.locking import hold_world

    journal = Journal.load(journal_path)
    world_dir = journal.world_dir
    if not world_dir.is_dir():
        raise JournalError("WORLD_NOT_FOUND", "The world folder of this job does not exist any more")
    externals = [Path(t["externalTarget"]) for _u, t in journal.targets() if t["rootKind"] == "external_pack"]
    with hold_world(world_dir, "recovery", external_targets=externals, lock_dir=lock_dir):
        journal = Journal.load(journal_path)  # read again under the guards: it may have been settled meanwhile
        if journal.settled:
            raise JournalError("JOURNAL_NOT_FOUND", "This job is already settled")
        authorized = {str(Path(p).resolve(strict=False)) for p in authorized_external or []}
        classes = classify(journal, authorized)
        if mode == "keep":
            return _keep(journal, classes)
        return _rollback(journal, classes, authorized, progress, retries)


def _keep(journal: Journal, classes: list[Classified]) -> dict:
    for item in classes:
        if item.kind == "owned" or (item.kind == "pristine" and same_state(item.target["preimage"], item.target["post"])):
            journal.record(item.unit, item.target, "verified", save=False)
    journal.doc["settledBy"] = "keep"
    state = "committed" if journal.all_verified() else "partial"
    journal.set_state(state, settled=True)
    clear_staging(journal.path.parent)
    return {
        "jobId": journal.job_id, "mode": "keep", "state": "kept",
        "restoredFiles": 0, "keptFiles": len(classes),
        "conflicts": [_public_conflict(item) for item in classes if item.kind == "conflict"],
        "quarantineDir": None,
    }


def _rollback(journal: Journal, classes: list[Classified], authorized: set[str],
              progress: Callable[[int, int], None] | None, retries: int) -> dict:
    from mwt.safety import BackupSet

    host_root = journal.path.parent
    store = host_root.parent
    world_dir = journal.world_dir.resolve()
    recovery_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
    journal.doc["recoveryMode"] = "rollback"
    journal.set_state("recovering")
    fault_point("recovery_started", kind=journal.kind)

    conflicts = [item for item in classes if item.kind == "conflict"]
    blocked_units = {item.unit["unitId"] for item in conflicts}
    quarantine = _quarantine(host_root, recovery_id, conflicts)
    fault_point("recovery_quarantined", kind=journal.kind)

    # Units with a conflict are left alone as a whole: a region must not be rolled back under a
    # payload somebody else changed.
    by_unit: dict[str, list[Classified]] = {}
    for item in classes:
        if item.unit["unitId"] not in blocked_units:
            by_unit.setdefault(item.unit["unitId"], []).append(item)
    actionable = {uid: items for uid, items in by_unit.items() if any(i.kind == "owned" for i in items)}

    restored = 0
    error_code = ""
    recovery_id_job = ""
    unusable: list[Classified] = []
    if actionable:
        externals = sorted({str(i.path) for items in actionable.values() for i in items if i.target["rootKind"] == "external_pack"})
        recovery = BackupSet.new(world_dir, kind="recovery", store=store, external_files=[Path(p) for p in externals])
        recovery_journal = Journal.create(recovery.root / JOURNAL_NAME, job_id=recovery.backup_id, kind="recovery", world_dir=world_dir)
        units = []
        for uid, items in list(actionable.items()):
            try:
                units.append(_rollback_unit(host_root, uid, items))
            except JournalError:
                # No usable backup for this unit: leave it alone and say so, never half-restore.
                del actionable[uid]
                for item in items:
                    if item.kind == "owned":
                        unusable.append(Classified(item.unit, item.target, item.path, item.current, "conflict", "UNREADABLE"))
        done = 0
        total = len(units)
        if progress is not None:
            progress(0, total)

        def unit_done(_result: UnitResult) -> None:
            nonlocal done
            done += 1
            if progress is not None:
                progress(done, total)

        transaction = WriteTransaction(recovery_journal, recovery, world_dir, retries=retries)
        try:
            outcome = transaction.run(units, on_unit_done=unit_done)
            error_code = outcome.stopped or next((r.error_code for r in outcome.units if r.error_code), "")
        except JournalError as exc:
            error_code = exc.code
        except Exception as exc:
            error_code = "DISK_FULL" if is_disk_full(exc) else "RECOVERY_FAILED"
        recovery_id_job = recovery.backup_id
        verified_paths = {
            (unit["unitId"], t["rootKind"], t["path"])
            for unit, t in recovery_journal.targets() if t["outcome"] == "verified"
        }
        for uid, items in actionable.items():
            for item in items:
                if item.kind == "owned" and (f"rollback:{uid}", item.target["rootKind"], item.target["path"]) in verified_paths:
                    journal.record(item.unit, item.target, "restored", save=False)
                    restored += 1
        clear_staging(recovery.root)
    pending_owned = sum(1 for items in actionable.values() for i in items if i.kind == "owned") - restored
    conflicts = conflicts + unusable
    if recovery_id_job:
        journal.doc["recoveryJobId"] = recovery_id_job
    if error_code or pending_owned:
        state = "partial"
        journal.set_state("partial")
    elif conflicts:
        state = "partial" if restored else "recovery_conflict"
        journal.set_state(state)
    else:
        state = "rolled_back"
        journal.doc["settledBy"] = "rollback"
        journal.set_state("rolled_back")
    clear_staging(host_root)
    result = {
        "jobId": journal.job_id, "mode": "rollback", "state": state,
        "restoredFiles": restored, "keptFiles": max(0, len(classes) - restored),
        "conflicts": [_public_conflict(item) for item in conflicts],
        "quarantineDir": str(quarantine) if quarantine else None,
    }
    if error_code:
        result["errorCode"] = error_code
    if recovery_id_job:
        result["recoverySetId"] = recovery_id_job
    return result


def _rollback_unit(host_root: Path, unit_id: str, items: list[Classified]) -> UnitSpec:
    """Targets in undo order: payloads that existed before come back first, the region next, files
    the job created are removed last. Putting the region back before its payloads would let it point
    at the new bytes; removing a created payload first would break the region that still uses it."""
    def order(item: Classified) -> int:
        pre_present = not item.target["preimage"]["absent"]
        if pre_present and item.target["role"] != "region":
            return 0
        return 1 if pre_present else 2

    specs: list[TargetSpec] = []
    for item in sorted(items, key=order):
        if item.kind != "owned":
            continue  # already as it was before the job
        target = item.target
        if target["preimage"]["absent"]:
            source = None
        else:
            source = host_root / Path(*PurePosixPath(target["backup"]).parts)
            if not source.is_file() or sha256_file(source)[0] != target["preimage"]["sha256"]:
                raise JournalError("JOURNAL_INVALID", f"The backup of {item.path.name} is missing or damaged")
        current = item.current or {"absent": True, "sha256": ""}
        specs.append(TargetSpec(
            path=item.path, root_kind=target["rootKind"], source=source, role=target["role"],
            expected_pre="" if current["absent"] else current["sha256"],
        ))
    first = items[0].unit
    return UnitSpec(unit_id=f"rollback:{unit_id}", kind="recovery", label=first["label"], targets=specs)
