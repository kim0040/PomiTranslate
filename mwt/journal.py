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

A job is *settled* only in ``committed`` (every unit verified), ``rolled_back``, ``kept`` and
``superseded``. Every other state is unsettled: it blocks, for that world, every new writer
(translate, a resume of a different job, restore, recovery of another job) until it is rolled
back or kept. Hash equality alone never makes an old record the owner of a file: each record
carries a per-world ``generation``, and a record that a newer job has passed is refused
(``JOURNAL_SUPERSEDED``).

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
from typing import Any, Callable, Iterable

from mwt.durable import atomic_write_text, copy_durable, fsync_dir, mkdir_durable
from mwt.durable import replace as durable_replace

JOURNAL_NAME = "journal.json"
WORLD_STATE_NAME = "world-state.json"
SCHEMA_VERSION = 1

STATES = frozenset({
    "preparing", "prepared", "committing", "committed", "partial",
    "rolled_back", "recovery_conflict", "recovering", "kept", "superseded",
})
# The only states in which a job no longer needs anyone. ``committed`` counts only while every
# unit is verified (see ``Journal.settled``). Everything else blocks new writers of the world.
SETTLED_STATES = frozenset({"committed", "rolled_back", "kept", "superseded"})
TERMINAL_STATES = SETTLED_STATES  # earlier name
OUTCOMES = frozenset({"pending", "written", "verified", "failed", "unknown", "restored"})
KINDS = frozenset({"translate", "restore", "recovery"})
ROOT_KINDS = frozenset({"world", "external_pack"})

# Minimum seconds between two outcome-only rewrites. State changes and failures always write at
# once. A lost outcome is harmless: recovery re-hashes every target instead of believing it.
SAVE_INTERVAL = 1.0

_SHA = re.compile(r"[0-9a-f]{64}")
_ID = re.compile(r"[A-Za-z0-9_-]+")
_ABSENT = {"absent": True, "sha256": "", "size": 0}


class JournalError(RuntimeError):
    """A journal problem with a stable code the interface can show.

    ``job_ids`` names the jobs behind a refusal such as ``RECOVERY_REQUIRED``.
    """

    def __init__(self, code: str, message: str, job_ids: Iterable[str] = ()) -> None:
        super().__init__(message)
        self.code = code
        self.job_ids = [str(item) for item in job_ids]


class WorldChanged(JournalError):
    """The world is not what the scan (or the plan) saw. Nothing was written for this target."""

    def __init__(self, message: str) -> None:
        super().__init__("WORLD_CHANGED", message)


class TargetChanged(WorldChanged):
    """An external resource pack (or its folder) is not the object that was validated."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "TARGET_CHANGED"


class DiskFull(JournalError):
    def __init__(self, message: str) -> None:
        super().__init__("DISK_FULL", message)


class JournalWriteFailed(JournalError):
    """The record itself could not be saved. What reached the disk before is not lost: the
    transaction keeps it in memory and reports it."""

    def __init__(self, cause: BaseException) -> None:
        full = is_disk_full(cause)
        super().__init__("DISK_FULL" if full else "JOURNAL_WRITE_FAILED",
                         "The recovery record could not be saved" + (": the disk is full" if full else f": {cause}"))
        self.cause = cause


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


def file_identity(path: Path) -> dict:
    """Which object ``path`` names now: ``{"file": {dev, ino, size, mtimeNs} | {"absent": True},
    "parent": "dev:ino" | None}``. A swapped file or a swapped folder gets another identity even
    when the bytes are identical (on Windows ``os.stat`` fills dev/ino from the file index)."""
    path = Path(path)
    try:
        info = os.lstat(path)
        file: dict = {"dev": info.st_dev, "ino": info.st_ino, "size": info.st_size, "mtimeNs": info.st_mtime_ns}
    except (FileNotFoundError, NotADirectoryError):
        file = {"absent": True}
    try:
        parent_info = os.stat(path.parent)
        parent: str | None = f"{parent_info.st_dev}:{parent_info.st_ino}"
    except (FileNotFoundError, NotADirectoryError):
        parent = None
    return {"file": file, "parent": parent}


def identity_matches(expected: dict, current: dict) -> bool:
    """``expected`` may carry only some file fields (a plan that knew dev/ino but not the mtime)."""
    wanted, now = expected.get("file") or {}, current.get("file") or {}
    if wanted.get("absent") or now.get("absent"):
        file_ok = bool(wanted.get("absent")) and bool(now.get("absent"))
    else:
        file_ok = all(now.get(key) == value for key, value in wanted.items())
    parent = expected.get("parent")
    return file_ok and (parent is None or parent == current.get("parent"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _app_version() -> str:
    from mwt.locking import _app_version as version

    return version()


def world_key(world_dir: Path) -> str:
    return hashlib.sha256(os.path.normcase(os.path.realpath(world_dir)).encode("utf-8")).hexdigest()[:16]


def external_ref(path: Path) -> str:
    """``<sha256(canonical target)[:16]>-<basename>``: how an external pack is named in a record,
    a conflict list and the quarantine, so two packs called ``pack.zip`` never share a name."""
    digest = hashlib.sha256(os.path.normcase(os.path.realpath(path)).encode("utf-8")).hexdigest()[:16]
    return f"{digest}-{Path(path).name}"


def _norm(path: Path | str) -> str:
    return os.path.normcase(os.path.realpath(path))


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
    # The object the caller validated (see ``file_identity``). When given, the plan is refused if the
    # target is not that object any more; when None the plan captures it under the guards.
    identity: dict | None = None


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
    """What physically happened to one unit. ``written``/``unknown`` are filled the moment each
    replace returns, independent of whether the record could be saved afterwards."""

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
    persist_error: BaseException | None = None  # the record could not be saved (world outcomes above still hold)


# ---------------------------------------------------------------- per-world generation

def _state_file(store: Path, key: str) -> Path:
    """The counter of one world. The name carries the world, so two worlds that share one backup
    store (a configured location) never write the same file."""
    return Path(store) / f"world-state.{key}.json"


class _UnreadableCounter(Exception):
    """A counter file exists but could not be read (an I/O error, not a missing file)."""

    def __init__(self, cause: OSError) -> None:
        super().__init__(str(cause))
        self.cause = cause


def _read_counter(path: Path, key: str, *, own: bool = True) -> dict:
    """The counter in ``path``. A missing file is ``{}``. A file that exists but cannot be read
    raises ``_UnreadableCounter``. ``own``: the file is this world's own, so damaged content is
    reported as ``{"damaged": True}`` instead of being taken for an absent counter; the shared file
    of an earlier release also holds other worlds, so there anything not about this world is ``{}``."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise _UnreadableCounter(exc) from exc
    damaged = {"damaged": True} if own else {}
    try:
        data = json.loads(text)
    except ValueError:
        return damaged
    if not isinstance(data, dict):
        return damaged
    if data.get("worldKey") != key:
        return damaged if own else {}
    generation = data.get("generation")
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
        return damaged
    return data


def read_world_state(store: Path, key: str) -> dict:
    """``{generation, lastSettledJobId}`` of this world from ``<store>/world-state.<key>.json``, or
    from the single shared ``world-state.json`` an earlier release wrote there (the larger wins).
    ``damaged`` is set when this world's counter exists but its content is unusable.
    Raises ``_UnreadableCounter`` when a counter file exists but cannot be read."""
    current = _read_counter(_state_file(store, key), key)
    legacy = _read_counter(Path(store) / WORLD_STATE_NAME, key, own=False)
    best = legacy if int(legacy.get("generation", -1)) > int(current.get("generation", -1)) else dict(current)
    if current.get("damaged") or legacy.get("damaged"):
        best["damaged"] = True
    return best


def _write_world_state(store: Path, key: str, generation: int, last_settled: str, *, strict: bool = False) -> None:
    """Write the counter durably. ``strict``: a failure is raised as ``JournalWriteFailed`` (the new
    record must not be accepted without it); otherwise it is best effort - a settled job only notes
    itself, and the generations found in the records keep the number from going back."""
    try:
        mkdir_durable(Path(store))
        atomic_write_text(_state_file(store, key), json.dumps(
            {"worldKey": key, "generation": generation, "lastSettledJobId": last_settled}, separators=(",", ":")))
    except OSError as exc:
        if strict:
            raise JournalWriteFailed(exc) from exc


def allocate_generation(world_dir: Path, store: Path, stores: Iterable[Path] = ()) -> int:
    """The next generation of this world, taken under the world lock when a record is created.

    It is one more than the largest of the counter files of this world in every known store and the
    generation of every record of this world in every known store. The counter of ``store`` is
    written (and fsynced) before the number is returned: if that fails, ``JournalWriteFailed`` is
    raised and the caller must not start the job - nothing in the world has been touched yet.
    """
    key = world_key(world_dir)
    known = [Path(item) for item in [*stores, store]]
    highest = 0
    damaged = False
    try:
        for where in known:
            state = read_world_state(where, key)
            highest = max(highest, int(state.get("generation", 0)))
            damaged = damaged or bool(state.get("damaged"))
        previous = read_world_state(store, key)
    except _UnreadableCounter as exc:
        # The number it holds is unknown, so any number chosen now could go back. Retry later.
        raise JournalWriteFailed(exc.cause) from exc
    for _where, path in iter_journal_files(known):
        head = peek_header(path)
        if head is not None and head["worldKey"] == key:
            highest = max(highest, head["generation"])
    if damaged:
        # A counter exists but its number is lost. The current time in seconds is larger than any
        # count of jobs, so the new generation cannot fall below the lost one.
        highest = max(highest, int(time.time()))
    generation = highest + 1
    _write_world_state(store, key, generation, str(previous.get("lastSettledJobId", "")), strict=True)
    return generation


def _note_settled(journal: "Journal") -> None:
    store = journal.path.parent.parent
    key = journal.doc.get("worldKey") or world_key(journal.world_dir)
    try:
        state = read_world_state(store, key)
    except _UnreadableCounter:
        return  # best effort; writing now could replace a larger number we cannot see
    if state.get("damaged"):
        return  # the next record allocation handles a damaged counter
    generation = max(int(state.get("generation", 0)), int(journal.doc.get("generation", 0)))
    _write_world_state(store, key, generation, journal.job_id)


# ---------------------------------------------------------------- the record

class Journal:
    def __init__(self, path: Path, doc: dict) -> None:
        self.path = path
        self.doc = doc
        self._dirty = False
        self._last_save = 0.0

    # -- construction -----------------------------------------------------------------------

    @classmethod
    def create(
        cls,
        path: Path,
        *,
        job_id: str,
        kind: str,
        world_dir: Path,
        stores: Iterable[Path] = (),
        parent_job_id: str = "",
        supersedes: str = "",
    ) -> "Journal":
        if kind not in KINDS:
            raise ValueError("Unknown journal kind")
        resolved = Path(world_dir).resolve()
        doc = {
            "schemaVersion": SCHEMA_VERSION,
            "jobId": job_id,
            "state": "preparing",
            "settled": False,
            "unitsOpen": 0,
            "kind": kind,
            "seq": 0,
            "generation": allocate_generation(resolved, Path(path).parent.parent, stores),
            "worldKey": world_key(resolved),
            "worldPath": str(resolved),
            "worldName": resolved.name,
            "createdAt": _now(),
            "updatedAt": _now(),
            "appVersion": _app_version(),
            "units": [],
            "log": [],
        }
        if parent_job_id:
            doc["parentJobId"] = parent_job_id
        if supersedes:
            doc["supersedes"] = supersedes
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
    def generation(self) -> int:
        return int(self.doc.get("generation", 0))

    @property
    def settled(self) -> bool:
        """Settled in a settled state; ``committed`` only while every unit really is verified."""
        if self.state not in SETTLED_STATES:
            return False
        return self.state != "committed" or self.all_verified()

    @property
    def display_state(self) -> str:
        """The state the interface shows: a ``committed`` header over unverified units is ``failed``."""
        if self.state == "committed" and not self.settled:
            return "failed"
        return self.state

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

    def set_state(self, state: str, *, save: bool = True) -> None:
        """Move to ``state``. Only a settled state closes the job; any other state reopens it, so
        a job continued by a later attempt is listed again."""
        if state not in STATES:
            raise ValueError("Unknown journal state")
        if state == "committed" and not self.all_verified():
            raise ValueError("A job with unverified units cannot be committed")
        self.doc["state"] = state
        self._dirty = True
        if save:
            self.save()
            if self.settled:
                _note_settled(self)

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
        self.doc["settled"] = self.settled
        self.doc["unitsOpen"] = sum(1 for unit in self.units if not self.unit_verified(unit))
        text = json.dumps(self.doc, ensure_ascii=False, separators=(",", ":"))
        mkdir_durable(self.path.parent)
        fault_point("journal_save", phase="before", kind=self.kind, state=self.state)
        atomic_write_text(self.path, text)
        self._dirty = False
        self._last_save = time.monotonic()
        fault_point("journal_save", phase="after", kind=self.kind, state=self.state)

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
            "blocking": not self.settled,
            "legacy": False,
            "journalState": self.state,
            "state": self.display_state,
            "generation": self.generation,
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
    generation = doc.get("generation", 0)
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
        raise bad("generation")
    for key in ("parentJobId", "supersedes", "supersededBy"):
        if key in doc and (not isinstance(doc[key], str) or (doc[key] and not _ID.fullmatch(doc[key]))):
            raise bad(key)
    if "stateBeforeSupersede" in doc and doc["stateBeforeSupersede"] not in STATES - {"superseded"}:
        raise bad("stateBeforeSupersede")
    if "settledByBeforeSupersede" in doc and not isinstance(doc["settledByBeforeSupersede"], str):
        raise bad("settledByBeforeSupersede")
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
    identity = target.get("identity")
    if identity is not None and not isinstance(identity, dict):
        raise bad("identity")
    parent_identity = target.get("parentIdentity")
    if parent_identity is not None and not isinstance(parent_identity, str):
        raise bad("identity")


# ---------------------------------------------------------------- discovery

_PEEK = {
    "jobId": re.compile(rb'"jobId":"([A-Za-z0-9_-]+)"'),
    "state": re.compile(rb'"state":"([a-z_]+)"'),
    "settled": re.compile(rb'"settled":(true|false)'),
    "unitsOpen": re.compile(rb'"unitsOpen":(\d+)'),
    "generation": re.compile(rb'"generation":(\d+)'),
    "worldKey": re.compile(rb'"worldKey":"([0-9a-f]+)"'),
}


def peek_header(journal_path: Path) -> dict | None:
    """The header of a record, from its first few KiB, without parsing the whole file.

    The header fields are written first, so a store with hundreds of finished jobs is not parsed
    on every start. ``None``: unreadable. ``unitsOpen`` is ``None`` for a record that predates it.
    """
    try:
        with Path(journal_path).open("rb") as stream:
            head = stream.read(4096)
    except OSError:
        return None
    found = {name: pattern.search(head) for name, pattern in _PEEK.items()}
    if found["state"] is None:
        return None
    return {
        "jobId": found["jobId"].group(1).decode() if found["jobId"] else "",
        "state": found["state"].group(1).decode(),
        "settled": found["settled"].group(1) == b"true" if found["settled"] else None,
        "unitsOpen": int(found["unitsOpen"].group(1)) if found["unitsOpen"] else None,
        "generation": int(found["generation"].group(1)) if found["generation"] else 0,
        "worldKey": found["worldKey"].group(1).decode() if found["worldKey"] else "",
    }


def header_settled(head: dict) -> bool | None:
    """True / False when the header decides; None when the whole record must be read."""
    if head["state"] not in SETTLED_STATES:
        return False
    if head["state"] != "committed":
        return True
    if head["unitsOpen"] is None:
        return None
    return head["unitsOpen"] == 0


def peek_unsettled(journal_path: Path) -> bool | None:
    """True when a record may need attention, False when settled, None when unreadable."""
    head = peek_header(journal_path)
    if head is None:
        return None
    decided = header_settled(head)
    return True if decided is None else not decided


def iter_journal_files(stores: Iterable[Path]):
    """``(store, path)`` of every ``<store>/<jobId>/journal.json``, each file once."""
    seen: set[str] = set()
    for store in stores:
        try:
            candidates = sorted(Path(store).glob(f"*/{JOURNAL_NAME}"))
        except OSError:
            continue
        for path in candidates:
            if not _ID.fullmatch(path.parent.name):
                continue
            marker = _norm(path)
            if marker in seen:
                continue
            seen.add(marker)
            yield Path(store), path


@dataclass
class Found:
    store: Path
    path: Path
    journal: "Journal | None"
    error: JournalError | None = None

    @property
    def job_id(self) -> str:
        return self.path.parent.name


def unsettled_journals(stores: Iterable[Path]) -> list[Found]:
    """Every record that is not settled, or whose units contradict a settled header, in every store.

    A ``committed`` header over units that are not all verified is still listed (state ``failed``),
    and a damaged record is listed with ``journal=None``. Read-only: nothing is repaired or deleted.
    """
    found: list[Found] = []
    ids: set[str] = set()
    for store, path in iter_journal_files(stores):
        if path.parent.name in ids:
            continue
        head = peek_header(path)
        if head is not None and header_settled(head) is True:
            continue
        try:
            journal = Journal.load(path)
        except JournalError as exc:
            ids.add(path.parent.name)
            found.append(Found(store, path, None, exc))
            continue
        if journal.settled:
            continue
        ids.add(path.parent.name)
        found.append(Found(store, path, journal))
    return found


def _invalid_summary(item: Found) -> dict:
    try:
        created = datetime.fromtimestamp(item.path.stat().st_mtime, timezone.utc).isoformat()
    except OSError:
        created = ""
    return {
        "jobId": item.job_id, "kind": "translate", "worldPath": "", "worldName": item.store.name,
        "createdAt": created,
        "unitsTotal": 0, "unitsVerified": 0, "unitsUnknown": 0,
        "needsAttention": True, "blocking": True, "legacy": False,
        "journalState": "invalid", "state": "failed", "errorCode": item.error.code if item.error else "JOURNAL_INVALID",
    }


def list_interrupted(stores: list[Path]) -> list[dict]:
    """Records that are not settled, newest first. Read-only: nothing is repaired or deleted."""
    summaries = [item.journal.summary() if item.journal is not None else _invalid_summary(item)
                 for item in unsettled_journals(stores)]
    return sorted(summaries, key=lambda item: item["createdAt"], reverse=True)


def find_journal(job_id: str, stores: list[Path]) -> Path:
    """Path of the record of ``job_id`` in the first store that has it."""
    if not _ID.fullmatch(job_id or ""):
        raise JournalError("JOURNAL_NOT_FOUND", "There is no recovery record for this job")
    for store in stores:
        candidate = Path(store) / job_id / JOURNAL_NAME
        if candidate.is_file():
            return candidate
    raise JournalError("JOURNAL_NOT_FOUND", "There is no recovery record for this job")


def journal_state_of_set(set_dir: Path) -> str | None:
    """State of a backup set's journal, or None for a set written before journals existed."""
    path = Path(set_dir) / JOURNAL_NAME
    if not path.is_file():
        return None
    try:
        return Journal.load(path).state
    except JournalError:
        return "invalid"


def default_stores(world_dir: Path, store: Path | None = None) -> tuple[list[Path], list[Path]]:
    """``(all stores to look in, the stores that belong to this world)`` when the caller only
    knows one store: it, its siblings when it lives under a ``backups`` folder, and the legacy
    store inside the world. A damaged record only counts for a store of the second list."""
    from mwt.safety import legacy_backup_store

    own: list[Path] = [legacy_backup_store(world_dir)]
    everything: list[Path] = []
    if store is not None:
        own.insert(0, Path(store))
        everything.append(Path(store))
        if Path(store).parent.name == "backups":
            try:
                everything.extend(sorted(path for path in Path(store).parent.iterdir() if path.is_dir()))
            except OSError:
                pass
    everything.append(legacy_backup_store(world_dir))
    return everything, own


def _family(root_id: str, journals: Iterable["Journal"]) -> set[str]:
    """``root_id`` plus every record linked to it through ``parentJobId``: the recovery attempts of a
    job, their siblings and the job itself are one story, not rivals. A record that merely continued
    the job (``supersedes``) is deliberately not part of it: it wrote to the world afterwards."""
    parents = {journal.job_id: str(journal.doc.get("parentJobId") or "") for journal in journals}
    family = {root_id}
    grew = True
    while grew:
        grew = False
        for job_id, parent in parents.items():
            if job_id in family and parent and parent not in family:
                family.add(parent)
                grew = True
            elif job_id not in family and parent in family:
                family.add(job_id)
                grew = True
    return family


def blocking_journals(
    world_dir: Path,
    stores: Iterable[Path],
    *,
    own: Iterable[Path] = (),
    ignore: Iterable[str] = (),
    family_of: str = "",
) -> list[dict]:
    """The reconciliation gate: every unsettled record of this world in any store, as summaries.

    ``own`` are the stores that belong to this world; a damaged record there blocks too (its world
    is unknown), a damaged record in another world's store does not. ``ignore`` are job ids to
    skip; ``family_of`` skips that job and every record linked to it.
    """
    key = world_key(world_dir)
    own_stores = {_norm(path) for path in own}
    skip = set(ignore)
    items = unsettled_journals(stores)
    relevant: list[Found] = []
    for item in items:
        if item.journal is None:
            if _norm(item.store) in own_stores:
                relevant.append(item)
        elif world_key(Path(item.journal.doc["worldPath"])) == key:
            relevant.append(item)
    if family_of:
        skip |= _family(family_of, [item.journal for item in relevant if item.journal is not None])
    result = []
    for item in relevant:
        if item.job_id in skip:
            continue
        result.append(item.journal.summary() if item.journal is not None else _invalid_summary(item))
    return sorted(result, key=lambda entry: entry["createdAt"])


def unsettled_for_world(world_dir: Path, stores: list[Path], *, ignore: str = "") -> list[dict]:
    """Unsettled jobs of this world (``ignore``: the caller's own job id)."""
    return blocking_journals(world_dir, stores, own=stores, ignore=[ignore] if ignore else [])


def newer_journals(journal: "Journal", stores: Iterable[Path]) -> list[str]:
    """Records of the same world with a higher generation that are not rolled back and not in this
    record's family: a newer job has written to the world since, so this record is stale."""
    key = world_key(journal.world_dir)
    candidates: list[Journal] = []
    for _store, path in iter_journal_files(stores):
        head = peek_header(path)
        if (head is None or head["jobId"] == journal.job_id or head["worldKey"] != key
                or head["generation"] <= journal.generation or head["state"] == "rolled_back"):
            continue
        try:
            candidates.append(Journal.load(path))
        except JournalError:
            continue
    family = _family(journal.job_id, [journal, *candidates])
    return [item.job_id for item in candidates if item.job_id not in family and item.state != "rolled_back"]


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

    What reached the disk is tracked in memory in each ``UnitResult`` the moment the replace
    returns, so a record that cannot be saved (full disk) never hides a published file: the
    transaction stops publishing, keeps the save error, and hands the facts to its caller.
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
        after_intent: Callable[[], None] | None = None,
    ) -> None:
        """``write_bytes`` replaces the default file writer (the translator passes its own, which
        retries and notifies the interface); ``should_stop`` is asked before each unit;
        ``after_intent`` runs once the whole intent is on disk, before anything else happens."""
        self.journal = journal
        self.backup = backup
        self.world_dir = Path(world_dir).resolve()
        self.retries = max(1, int(retries))
        self.on_retry = on_retry
        self._sleep = sleep
        self._write_bytes = write_bytes
        self._should_stop = should_stop
        self._after_intent = after_intent
        self.persist_error: BaseException | None = None

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
            if self._after_intent is not None:
                self._after_intent()
            fault_point("intent_persisted", **info)
            self._backup(planned)
            journal.set_state("prepared")
            fault_point("prepared", **info)
            journal.set_state("committing")
        except Exception as exc:
            if planned and journal.path.exists():
                self._abort(planned)
            else:
                journal.doc = snapshot  # the plan never reached the disk: forget it
            if is_disk_full(exc):
                raise DiskFull("The disk is full: the backup or the new files could not be saved") from exc
            raise
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
            if self.persist_error is not None:
                stopped = result.error_code if result.error_code in {"DISK_FULL", "JOURNAL_WRITE_FAILED"} else "JOURNAL_WRITE_FAILED"
            elif result.error_code in {"WORLD_CHANGED", "TARGET_CHANGED", "DISK_FULL"}:
                stopped = result.error_code
            elif stop_on_error and not result.verified:
                stopped = result.error_code or "WRITE_FAILED"
        state = self._finalize()
        if self.persist_error is not None and not stopped:
            stopped = "DISK_FULL" if is_disk_full(self.persist_error) else "JOURNAL_WRITE_FAILED"
        return TransactionResult(results, state, stopped, self.persist_error)

    # -- planning ---------------------------------------------------------------------------

    def _relative(self, path: Path, root_kind: str) -> str:
        if root_kind == "external_pack":
            return external_ref(path)
        resolved = Path(os.path.abspath(path))
        if not resolved.is_relative_to(self.world_dir):
            raise JournalError("JOURNAL_INVALID", f"{path.name} is outside its authorized root")
        return resolved.relative_to(self.world_dir).as_posix()

    @staticmethod
    def _changed(root_kind: str, message: str) -> WorldChanged:
        return TargetChanged(message) if root_kind == "external_pack" else WorldChanged(message)

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
        # The object the caller validated, or - when it validated none - the one under the guards now.
        identity = file_identity(path)
        if spec.identity is not None and not identity_matches(spec.identity, identity):
            raise self._changed(spec.root_kind, f"{path.name} was replaced or its folder was swapped after it was checked")
        existing = next((t for t in unit["targets"] if t["path"] == relative and t["rootKind"] == spec.root_kind), None)
        post = dict(_ABSENT) if spec.source is None else self._source_state(spec.source)
        if existing is None:
            if spec.expected_pre is not None and not _matches(current, spec.expected_pre):
                raise self._changed(spec.root_kind, f"{path.name} changed after the scan")
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
                "identity": identity["file"],
                "parentIdentity": identity["parent"],
            }
            if spec.root_kind == "external_pack":
                from mwt.locking import object_identity

                target["externalTarget"] = str(path)
                target["externalParentId"] = object_identity(path.parent)
            unit["targets"].append(target)
            return target
        # A later attempt at the same file (the same job planned twice): the first preimage stays
        # the one to roll back to, and whatever the earlier attempt may have written is still ours.
        if not any(same_state(current, item) for item in _known_states(existing)):
            raise self._changed(spec.root_kind, f"{path.name} changed since the previous attempt")
        old = existing["post"]
        if not old["absent"] and old["sha256"] != post["sha256"] and old["sha256"] not in existing["priorPosts"]:
            existing["priorPosts"].append(old["sha256"])
        existing["post"] = post
        existing["role"] = spec.role
        existing["outcome"] = "pending"
        existing["identity"] = identity["file"]
        existing["parentIdentity"] = identity["parent"]
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
                        raise self._changed(target["rootKind"], f"{path.name} changed while it was being backed up")
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

    def _record(self, record: dict, target: dict, outcome: str, *, error: str = "") -> None:
        """``journal.record`` that turns a failed save into ``JournalWriteFailed`` (and remembers it)."""
        try:
            self.journal.record(record, target, outcome, error=error)
        except OSError as exc:
            self.persist_error = exc
            raise JournalWriteFailed(exc) from exc

    def _save_quietly(self) -> None:
        """A save on an error path. If it fails too the first error is the one that is reported."""
        try:
            self.journal.save()
        except OSError as exc:
            if self.persist_error is None:
                self.persist_error = exc

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
                self._publish_target(record, spec, target, path, info, result)
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
            self._save_quietly()
        result.verified = journal.unit_verified(record)
        return result

    def _publish_target(self, record: dict, spec: TargetSpec, target: dict, path: Path, info: dict,
                        result: UnitResult) -> None:
        journal = self.journal
        # Re-check the file right before replacing it. The guards keep cooperating programs out;
        # this catches one that does not cooperate: another content, or another object (a swapped
        # file or folder with the same bytes). The identity captured at the plan is never replaced.
        current = state_of(path)
        if not any(same_state(current, item) for item in _known_states(target)):
            raise self._changed(target["rootKind"], f"{path.name} changed before it could be written")
        planned_identity = {"file": target.get("identity"), "parent": target.get("parentIdentity")}
        if planned_identity["file"] is not None and not identity_matches(planned_identity, file_identity(path)):
            raise self._changed(target["rootKind"], f"{path.name} was replaced or its folder was swapped since the plan")
        try:
            self._write_with_retries(spec, path, info)
        except Exception as exc:
            # Something failed on the way. Say what the file is now, instead of guessing.
            code = "DISK_FULL" if is_disk_full(exc) else "WRITE_FAILED"
            try:
                now = state_of(path)
            except (OSError, JournalError):
                result.unknown.append(path)
                self._record(record, target, "unknown", error=code)
                raise
            if same_state(now, target["preimage"]) and not same_state(now, target["post"]):
                self._record(record, target, "failed", error=code)  # never replaced
            elif same_state(now, target["post"]):
                # Replaced and read back, but a later flush failed: the bytes are there, their
                # durability is not confirmed. Kept as an error, never converted to success.
                self._note_written(target, path, result)
                self._record(record, target, "written", error=code)
                if not is_disk_full(exc):
                    raise JournalError("WRITE_NOT_DURABLE", f"{path.name} was written but could not be flushed to disk: {exc}") from exc
            else:
                result.unknown.append(path)  # neither the old nor the new bytes: not a state to call a failure
                self._record(record, target, "failed", error=code)
            if is_disk_full(exc):
                raise DiskFull(f"The disk is full while writing {path.name}") from exc
            raise
        fault_point("after_replace", path=str(path), **info)
        try:
            actual = state_of(path)
        except (OSError, JournalError):
            result.unknown.append(path)
            self._record(record, target, "unknown", error="VERIFY_UNREADABLE")
            return
        if not same_state(actual, target["post"]):
            result.unknown.append(path)  # replaced, but not with what was planned
            self._record(record, target, "failed", error="VERIFY_MISMATCH")
            return
        self._note_written(target, path, result)  # known now, whatever the record does next
        fault_point("after_verify", path=str(path), **info)
        self._record(record, target, "verified")
        fault_point("after_record", path=str(path), **info)

    def _note_written(self, target: dict, path: Path, result: UnitResult) -> None:
        if not target["post"]["absent"]:
            result.written.append(path)
            self.backup.mark_written([path])

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
                fault_point("before_replace", path=str(path), **info)
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
        try:
            if journal.all_verified():
                journal.set_state("committed")
                return "committed"
            if self._untouched():
                journal.doc["settledBy"] = "untouched"
                journal.set_state("rolled_back")
                return "rolled_back"
            journal.set_state("partial")
            return "partial"
        except OSError as exc:
            # The final state could not be saved. The record on disk still says "committing" (open),
            # which is the safe answer; the physical outcomes were reported unit by unit.
            if self.persist_error is None:
                self.persist_error = exc
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
    code: str = ""  # "RECOVERY_CONFLICT" | "MISSING" | "UNREADABLE" | "UNIT_INCONSISTENT" for a conflict
    identity: dict | None = None  # the object that was hashed, so the write that follows can insist on it
    at_pre: bool = False
    at_post: bool = False


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
            before = file_identity(path)
            current = state_of(path)
            after = file_identity(path)
        except (OSError, JournalError):
            classes.append(Classified(unit, target, path, None, "conflict", "UNREADABLE"))
            continue
        if before != after:  # it changed while it was being read: whatever it holds, it is not ours
            classes.append(Classified(unit, target, path, current, "conflict", "RECOVERY_CONFLICT", after))
            continue
        at_pre = same_state(current, target["preimage"])
        at_post = any(same_state(current, item) for item in _known_states(target)[1:])
        if at_pre:
            kind, code = "pristine", ""
        elif at_post:
            kind, code = "owned", ""
        else:
            kind, code = "conflict", "MISSING" if current["absent"] else "RECOVERY_CONFLICT"
        classes.append(Classified(unit, target, path, current, kind, code, after, at_pre, at_post))
    return classes


def _public_conflict(item: Classified) -> dict:
    return {"path": item.target["path"], "rootKind": item.target["rootKind"], "code": item.code}


def _copy_exclusive(source: Path, destination: Path) -> None:
    """Copy ``source`` to a name that does not exist yet. An existing object is never truncated: if it
    holds the same bytes there is nothing to do, otherwise the copy gets a numbered name."""
    for number in range(0, 1000):
        candidate = destination if number == 0 else destination.with_name(f"{destination.stem}.{number}{destination.suffix}")
        try:
            handle = open(candidate, "xb")
        except FileExistsError:
            try:
                if sha256_file(candidate)[0] == sha256_file(source)[0]:
                    return
            except OSError:
                pass
            continue
        try:
            with handle, open(source, "rb") as reader:
                shutil.copyfileobj(reader, handle, 1024 * 1024)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            candidate.unlink(missing_ok=True)
            raise
        fsync_dir(candidate.parent)
        return
    raise JournalError("QUARANTINE_FAILED", "Too many quarantined copies of the same file")


def _quarantine_name(item: Classified) -> PurePosixPath:
    if item.target["rootKind"] == "external_pack":
        return PurePosixPath(external_ref(Path(item.target["externalTarget"])))
    return PurePosixPath(item.target["path"])


def _quarantine(host_root: Path, recovery_id: str, items: list[Classified]) -> Path | None:
    """Copy the bytes of every conflicting file aside. The files themselves stay where they are."""
    copied = False
    directory = host_root / "quarantine" / recovery_id
    for item in items:
        if item.current is None or item.current["absent"]:
            continue
        destination = directory / item.target["rootKind"] / Path(*_quarantine_name(item).parts)
        mkdir_durable(destination.parent)
        _copy_exclusive(item.path, destination)
        copied = True
        fault_point("quarantine_copied", path=str(item.path))
    return directory if copied else None


def _temp_pattern(name: str) -> re.Pattern[str]:
    return re.compile(r"\." + re.escape(name) + r"\.[A-Za-z0-9_-]+\.tmp")


_BOOKKEEPING_TEMP = re.compile(r"\.(journal|manifest|latest|world-state(\.[0-9a-f]+)?)\.json\.[A-Za-z0-9_-]+\.tmp")


def clean_orphan_temps(journal: Journal, paths: Iterable[Path]) -> int:
    """Remove the temporary files a killed write left beside this job's targets (and beside the
    record). Only names this program makes for exactly these targets are removed."""
    removed = 0
    wanted: dict[Path, list[re.Pattern[str]]] = {}
    for path in paths:
        wanted.setdefault(Path(path).parent, []).append(_temp_pattern(Path(path).name))
    wanted.setdefault(journal.path.parent, []).append(_BOOKKEEPING_TEMP)
    for directory, patterns in wanted.items():
        try:
            names = os.listdir(directory)
        except OSError:
            continue
        for name in names:
            if any(pattern.fullmatch(name) for pattern in patterns):
                try:
                    (directory / name).unlink()
                    removed += 1
                except OSError:
                    pass
    return removed


# -- keep: a verify-only settlement ------------------------------------------------------------

def _chunk_index(payload: Path, region: Path) -> int | None:
    parts = payload.name.split(".")
    if len(parts) != 4 or parts[0] != "c" or parts[3] != "mcc":
        return None
    try:
        x, z = int(parts[1]), int(parts[2])
    except ValueError:
        return None
    from mwt.region import region_coordinates

    region_x, region_z = region_coordinates(region)
    column, row = x - region_x * 32, z - region_z * 32
    if not (0 <= column < 32 and 0 <= row < 32):
        return None
    return column + row * 32


def _unit_parses(items: list[Classified]) -> bool:
    """For a region + ``.mcc`` unit: every chunk behind one of its payloads is readable NBT.

    Matching hashes say each file is one the job knows; this says they still describe one chunk.
    A region that points at a payload in another compression format, or at a missing one, fails.
    """
    region = next((item for item in items if item.target["role"] == "region" and item.current
                   and not item.current["absent"]), None)
    payloads = [item for item in items if item.target["role"] == "payload"]
    if region is None or not payloads:
        return True
    from mwt import nbtio
    from mwt.region import RegionFile

    try:
        parsed = RegionFile.read(region.path)
    except Exception:
        return False
    for item in payloads:
        index = _chunk_index(item.path, region.path)
        if index is None:
            continue
        chunk = parsed.chunks[index]
        if chunk.empty:
            continue
        if chunk.malformed or chunk.unsupported:
            return False
        if chunk.raw_nbt is None:
            return False
        try:
            nbtio.parse(chunk.raw_nbt)
        except Exception:
            return False
    return True


def keep_conflicts(classes: list[Classified]) -> list[Classified]:
    """What stops a verify-only settlement. Per unit every target must be on the same side: all at the
    intended postimage, or all at the preimage (absence counts as the preimage side of a created file).
    A foreign, missing or unreadable target is a conflict by itself; a unit whose targets are on
    different sides, or whose chunks no longer parse, is ``UNIT_INCONSISTENT`` as a whole."""
    conflicts = [item for item in classes if item.kind == "conflict"]
    by_unit: dict[str, list[Classified]] = {}
    for item in classes:
        by_unit.setdefault(item.unit["unitId"], []).append(item)
    for items in by_unit.values():
        if any(item.kind == "conflict" for item in items):
            continue  # already reported target by target
        consistent = all(item.at_pre for item in items) or all(item.at_post for item in items)
        if consistent and _unit_parses(items):
            continue
        conflicts.extend(
            Classified(item.unit, item.target, item.path, item.current, "conflict", "UNIT_INCONSISTENT",
                       item.identity, item.at_pre, item.at_post)
            for item in items
        )
    return conflicts


def _recovery_stores(journal_path: Path, world_dir: Path, stores: Iterable[Path] | None) -> tuple[list[Path], list[Path]]:
    store = Path(journal_path).parent.parent
    everything, own = default_stores(world_dir, store)
    if stores is not None:
        everything = [*stores, *everything]
    return everything, own


def check_resume(journal_path: Path, authorized: set[str]) -> list[dict]:
    """The Keep consistency check of a job a later run wants to continue: conflicts (public form), or
    ``[]`` when its world state is consistent unit by unit. Read-only."""
    journal = Journal.load(journal_path)
    if journal.settled:
        return []
    return [_public_conflict(item) for item in keep_conflicts(classify(journal, authorized))]


def supersede(old_path: Path, by: str, authorized: set[str], *, stores: Iterable[Path] = ()) -> None:
    """Close the record of a job that a later run continued, durably: ``superseded`` with a link to the
    new job (``by``), or - when no new record exists because nothing was left to write - ``kept``."""
    journal = Journal.load(old_path)
    if journal.settled:
        return
    if by:
        # What the job was before is recorded in the same rewrite, so an interrupted continuation can
        # put it back exactly (see ``reconcile_continuations``).
        journal.doc["stateBeforeSupersede"] = journal.state
        if "settledBy" in journal.doc:
            journal.doc["settledByBeforeSupersede"] = str(journal.doc["settledBy"])
        journal.doc["supersededBy"] = by
        journal.doc["settledBy"] = "resume"
        journal.set_state("superseded")
    else:
        journal.doc["settledBy"] = "resume-complete"
        journal.set_state("kept")
    retire_children(journal, authorized, stores)


def _published_nothing(journal: Journal, authorized: set[str]) -> bool:
    """Proof, by rehashing the files now, that this job changed nothing: no target has an outcome that
    says it was written, and every target still holds the state the job recorded before it began."""
    for _unit, target in journal.targets():
        if target["outcome"] in {"written", "verified", "unknown", "restored"}:
            return False
        try:
            if not same_state(state_of(resolve_target(journal, target, authorized)), target["preimage"]):
                return False
        except Exception:
            return False  # a target that cannot be checked proves nothing
    return True


def _put_back(old: Journal) -> bool:
    """Undo ``supersede``: the continued job is exactly what it was before the resume began (its own
    generation, units and checkpoints were never touched). False when that state was not recorded."""
    prior = old.doc.get("stateBeforeSupersede")
    if prior not in STATES or prior == "superseded":
        return False
    old.doc.pop("supersededBy", None)
    old.doc.pop("stateBeforeSupersede", None)
    before = old.doc.pop("settledByBeforeSupersede", None)
    if before is None:
        old.doc.pop("settledBy", None)
    else:
        old.doc["settledBy"] = before
    old.doc["state"] = prior  # not set_state(): a ``committed`` header over open units is allowed back
    old._dirty = True
    old.save()
    return True


def reconcile_continuations(world_dir: Path, stores: Iterable[Path], *, authorized: Iterable[str] = ()) -> list[str]:
    """Settle the continuation of a job that was cut off before it published anything.

    A resume is a new job ``B`` (``supersedes: A``) whose intent is saved first; only then is ``A``
    marked superseded; only then does ``B`` write. A process that dies in between leaves ``B`` open and
    ``A`` open or superseded, and neither could be recovered. For such a ``B`` that provably changed
    nothing (``_published_nothing``) this puts ``A`` back to the state it had before the resume - if
    ``A`` was superseded by this very ``B`` - and only then settles ``B`` as ``rolled_back``
    (``settledBy: unpublished_continuation``), with no write to the world. A ``B`` that cannot be
    proven unpublished, or an ``A`` whose earlier state was not recorded, is left exactly as it is: the
    refusal stays, nothing is guessed. Also covers a ``B`` that failed to start without a crash
    (``rolled_back``/``untouched``) while ``A`` is still superseded by it.

    Callers hold the world write lock. Returns the ids of the continuations it reconciled.
    """
    key = world_key(world_dir)
    allowed = {str(item) for item in authorized}
    pool: dict[str, Journal] = {}
    for _store, path in iter_journal_files(stores):
        try:
            item = Journal.load(path)
        except JournalError:
            continue
        if world_key(item.world_dir) == key:
            pool.setdefault(item.job_id, item)
    reconciled: list[str] = []
    for later in sorted(pool.values(), key=lambda item: item.generation):
        earlier_id = str(later.doc.get("supersedes") or "")
        if not earlier_id:
            continue
        open_job = not later.settled
        failed_start = later.state == "rolled_back" and later.doc.get("settledBy") == "untouched"
        if not (open_job or failed_start):
            continue
        earlier = pool.get(earlier_id)
        linked = (earlier is not None and earlier.state == "superseded"
                  and earlier.doc.get("supersededBy") == later.job_id)
        if failed_start and not linked:
            continue
        try:
            if not _published_nothing(later, allowed):
                continue
            if linked and not _put_back(earlier):  # A first: B stays open until A is back
                continue
            if open_job:
                later.doc["settledBy"] = "unpublished_continuation"
                later.set_state("rolled_back")
                # A write that was cut off may have left its staged copy beside the target.
                clean_orphan_temps(later, [resolve_target(later, target, allowed) for _unit, target in later.targets()])
        except OSError:
            continue  # nothing more can be saved now; the refusal stays and the next gate tries again
        reconciled.append(later.job_id)
    return reconciled


def _reconciled(child: Journal, parent: Journal, authorized: set[str], parent_state: str) -> bool:
    """Proof, by rehashing the files now, that a recovery attempt's effects are reconciled: every file
    it touched holds what the settled parent says it should."""
    parent_targets = {(t["rootKind"], t["path"]): t for _u, t in parent.targets()}
    for _unit, target in child.targets():
        wanted = parent_targets.get((target["rootKind"], target["path"]))
        if wanted is None:
            return False
        try:
            path = resolve_target(child, target, authorized)
            current = state_of(path)
        except Exception:
            return False
        if parent_state == "rolled_back":
            ok = same_state(current, wanted["preimage"])
        else:
            ok = same_state(current, wanted["preimage"]) or same_state(current, wanted["post"])
        if not ok:
            return False
    return True


def retire_children(parent: Journal, authorized: set[str], stores: Iterable[Path] = ()) -> int:
    """Close earlier, unsettled recovery attempts of ``parent`` that the settled parent has made moot.

    Never marked ``committed`` (they did not complete): they become ``superseded`` with a link, and
    only after a rehash shows their files hold what the parent settled on. Anything else stays listed.
    """
    if parent.state not in {"rolled_back", "kept", "superseded"}:
        return 0
    state = "rolled_back" if parent.state == "rolled_back" else "kept"
    retired = 0
    pool = [parent.path.parent.parent, *stores]
    for item in unsettled_journals(pool):
        child = item.journal
        if child is None or child.doc.get("parentJobId") != parent.job_id or child.settled:
            continue
        if child.job_id == parent.job_id or not _reconciled(child, parent, authorized, state):
            continue
        try:
            child.doc["supersededBy"] = parent.job_id
            child.doc["settledBy"] = "parent-settled"
            child.set_state("superseded")
            retired += 1
        except OSError:
            continue
    return retired


def recover_job(
    journal_path: Path,
    mode: str,
    *,
    authorized_external: list[Path] | None = None,
    lock_dir: Path | None = None,
    progress: Callable[[int, int], None] | None = None,
    retries: int = 2,
    accept_conflicts: bool = False,
    stores: Iterable[Path] | None = None,
) -> dict:
    """Settle an interrupted job: ``rollback`` its own writes or ``keep`` the world as it is.

    Every guard a write needs is taken first; if one is busy this raises ``WorldWriteLocked``,
    ``MinecraftWorldInUse`` or ``TargetLocked`` and changes nothing. A job that a newer job has
    passed is refused (``JOURNAL_SUPERSEDED``), and so is any recovery while another, unrelated job
    of the same world is unsettled (``RECOVERY_REQUIRED``).

    ``keep`` only verifies: when every unit is consistent it settles as ``kept``; on any conflict it
    quarantines the foreign bytes and leaves the job open (``recovery_conflict``) unless
    ``accept_conflicts`` records them as accepted and settles anyway.
    """
    if mode not in {"rollback", "keep"}:
        raise ValueError("Recovery mode must be rollback or keep")
    from mwt.locking import hold_world

    journal = Journal.load(journal_path)
    world_dir = journal.world_dir
    if not world_dir.is_dir():
        raise JournalError("WORLD_NOT_FOUND", "The world folder of this job does not exist any more")
    store_list, own = _recovery_stores(journal_path, world_dir, stores)
    externals = [Path(t["externalTarget"]) for _u, t in journal.targets() if t["rootKind"] == "external_pack"]
    authorized = {str(Path(p).resolve(strict=False)) for p in authorized_external or []}
    with hold_world(world_dir, "recovery", external_targets=externals, lock_dir=lock_dir):
        # A continuation that was cut off before it wrote anything is settled first (the job it
        # continued comes back); a request about that very job is answered by that settlement.
        reconciled = reconcile_continuations(world_dir, store_list, authorized=authorized)
        journal = Journal.load(journal_path)  # read again under the guards: it may have been settled meanwhile
        if journal.job_id in reconciled:
            return {"jobId": journal.job_id, "mode": mode, "state": "rolled_back", "restoredFiles": 0, "keptFiles": 0,
                    "conflicts": [], "quarantineDir": None, "settledBy": "unpublished_continuation"}
        if journal.state == "superseded":
            raise JournalError("JOURNAL_SUPERSEDED", "A later run continued this job; it can no longer be recovered",
                               [journal.doc.get("supersededBy", "")] if journal.doc.get("supersededBy") else [])
        if journal.settled:
            raise JournalError("JOURNAL_NOT_FOUND", "This job is already settled")
        newer = newer_journals(journal, store_list)
        if newer:
            raise JournalError("JOURNAL_SUPERSEDED", "A newer job has written to this world since; resolve that one first", newer)
        blockers = blocking_journals(world_dir, store_list, own=own, ignore=[journal.job_id], family_of=journal.job_id)
        if blockers:
            raise JournalError("RECOVERY_REQUIRED", "Another interrupted job of this world has to be settled first",
                               [item["jobId"] for item in blockers])
        classes = classify(journal, authorized)
        if mode == "keep":
            result = _keep(journal, classes, accept_conflicts, authorized, store_list)
        else:
            result = _rollback(journal, classes, authorized, progress, retries, store_list)
        # Only after the job is settled or reported: a killed write leaves its temporary files, the
        # next recovery (this one) removes exactly the names this program gives them.
        clean_orphan_temps(journal, [item.path for item in classes])
        return result


def _keep(journal: Journal, classes: list[Classified], accept_conflicts: bool, authorized: set[str],
          stores: list[Path]) -> dict:
    host_root = journal.path.parent
    recovery_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
    journal.doc["recoveryMode"] = "keep"
    fault_point("keep_classified", kind=journal.kind)
    conflicts = keep_conflicts(classes)
    public = [_public_conflict(item) for item in conflicts]
    quarantine: Path | None = None
    failure = ""
    if conflicts:
        # Every conflict goes in, whatever its code: the copy takes each file that is readable now, so
        # even the files of an inconsistent unit are kept as they are before anyone accepts or reverts.
        try:
            quarantine = _quarantine(host_root, recovery_id, conflicts)
        except Exception as exc:
            failure = "DISK_FULL" if is_disk_full(exc) else "RECOVERY_FAILED"
    fault_point("keep_quarantined", kind=journal.kind)
    clear_staging(host_root)
    base = {"jobId": journal.job_id, "mode": "keep", "restoredFiles": 0,
            "keptFiles": len({id(item.target) for item in classes} - {id(item.target) for item in conflicts}),
            "conflicts": public, "quarantineDir": str(quarantine) if quarantine else None}
    if failure:
        # The foreign bytes could not all be preserved, so nothing is settled - not even an accepted keep.
        try:
            journal.set_state("recovery_conflict")
        except OSError:
            pass  # the record on disk stays open either way
        return {**base, "state": "recovery_conflict", "errorCode": failure}
    if conflicts and not accept_conflicts:
        # Nothing is settled: the job stays open and listed, the foreign bytes are safe in quarantine.
        journal.set_state("recovery_conflict")
        return {**base, "state": "recovery_conflict"}
    for item in classes:
        if item.at_post and item.kind != "conflict":
            journal.record(item.unit, item.target, "verified", save=False)
    journal.doc["settledBy"] = "keep"
    if conflicts:
        journal.doc["acceptedConflicts"] = public  # the user accepted these; they are recorded, not hidden
    fault_point("keep_before_settle", kind=journal.kind)
    journal.set_state("kept")
    retire_children(journal, authorized, stores)
    return {**base, "state": "kept"}


def _rollback(journal: Journal, classes: list[Classified], authorized: set[str],
              progress: Callable[[int, int], None] | None, retries: int, stores: list[Path]) -> dict:
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
        recovery_journal = Journal.create(recovery.root / JOURNAL_NAME, job_id=recovery.backup_id, kind="recovery",
                                          world_dir=world_dir, stores=stores, parent_job_id=journal.job_id)
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
        # Whatever was safe has been restored; what somebody else changed is left alone and reported.
        state = "recovery_conflict"
        journal.set_state(state)
    else:
        state = "rolled_back"
        journal.doc["settledBy"] = "rollback"
        journal.set_state("rolled_back")
    clear_staging(host_root)
    if state == "rolled_back":
        # Earlier, interrupted attempts of this very recovery are moot now - closed only after the
        # files they touched are rehashed, and as superseded, never as a success they did not have.
        retire_children(journal, authorized, stores)
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
            identity=item.identity,  # the object that was classified is the only one this write may replace
        ))
    first = items[0].unit
    return UnitSpec(unit_id=f"rollback:{unit_id}", kind="recovery", label=first["label"], targets=specs)
