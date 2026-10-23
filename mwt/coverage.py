"""What a scan actually looked at, chunk by chunk, kept as counts and never as per-chunk lists.

A chunk is counted under ``(version state, DataVersion, compression, status)``. The state says how the
DataVersion is known: ``known`` (the chunk carries one), ``missing`` (the chunk was read and has none,
as in worlds saved before 15w32a) or ``unobserved`` (the chunk was never read, so nothing can be said).
The status is what the scan did with it:

- ``processed``: read and searched for text.
- ``skipped_unsupported``: not searched because the chunk itself cannot be read (an unknown compression).
- ``unreadable``: present, but damaged or too large to read.
- ``not_inspected``: outside the scan scope (the file was excluded, or could not be opened at all).

A chunk the scan read and searched is ``processed`` even when its file cannot be rewritten (an unknown-compression
chunk or an unsafe sector table elsewhere in it). Such a file is counted separately as ``write_blocked``: its text
was looked at, it just cannot be translated in place.

Memory stays bounded: a file keeps at most ``MAX_KEYS_PER_FILE`` distinct keys, and the checkpoint stores the
same counts so a resumed scan can replace one file without double counting. When a file meets more distinct keys
than that, the surplus is counted per status under ``overflow`` (never as unobserved): the distribution then says
it is truncated. The facts that must not depend on the retained keys (lowest and highest DataVersion, whether a
chunk had none) are kept as their own exact values per file, so ``mixed``, ``missing`` and the ranges stay exact.

A checkpoint stays readable by the readers from before the overflow was kept apart: it also exports the overflow
as the row those readers folded it into (the unobserved key of its status), so their totals do not drop. The
export says so with ``overflow_folded``, and this reader takes that row out again instead of counting it twice
or calling known observations unobserved.
"""

from __future__ import annotations

import gzip
import zlib
from pathlib import Path
from typing import Any

from mwt.support_matrix import NEWEST_COVERED_DATA_VERSION

PROCESSED = "processed"
SKIPPED_UNSUPPORTED = "skipped_unsupported"
UNREADABLE = "unreadable"
NOT_INSPECTED = "not_inspected"
STATUSES = (PROCESSED, SKIPPED_UNSUPPORTED, UNREADABLE, NOT_INSPECTED)

KNOWN = "known"
MISSING = "missing"
UNOBSERVED = "unobserved"
VERSION_STATES = (KNOWN, MISSING, UNOBSERVED)
# Only in a summary, never stored: the chunks of a file whose distinct keys exceeded MAX_KEYS_PER_FILE.
OVERFLOW = "overflow"

FILE_SCANNED = "scanned"
FILE_UNREADABLE = "unreadable"
FILE_NOT_INSPECTED = "not_inspected"
FILE_STATES = (FILE_SCANNED, FILE_UNREADABLE, FILE_NOT_INSPECTED)

MAX_KEYS_PER_FILE = 64
MAX_ENTRIES_PER_GROUP = 200
SUMMARY_VERSION = 1  # additive fields (saw_missing, overflow_by_status, overflow_folded, write_blocked, partial) keep it readable both ways

Key = tuple[str, Any, Any, str]  # (version state, DataVersion or None, compression or None, status)


def chunk_data_version(root: Any) -> tuple[str, int | None]:
    """``(state, number)`` of a parsed chunk. A tag that is not an integer counts as missing."""
    tag = root.get("DataVersion") if hasattr(root, "get") else None
    value = getattr(tag, "value", None)
    if getattr(tag, "type_id", 3) == 3 and isinstance(value, int) and not isinstance(value, bool):
        return KNOWN, int(value)
    return MISSING, None


class FileCoverage:
    """Counts of one region or entities file."""

    __slots__ = ("dimension", "kind", "state", "counts", "overflow", "low", "high", "saw_missing", "write_blocked")

    def __init__(self, dimension: str, kind: str, state: str = FILE_SCANNED) -> None:
        self.dimension = dimension
        self.kind = kind
        self.state = state
        self.counts: dict[Key, int] = {}
        # Chunks whose key did not fit under MAX_KEYS_PER_FILE, per status. They are neither itemised nor unobserved.
        self.overflow: dict[str, int] = {}
        # Exact whatever the retained keys are: the lowest and highest DataVersion read, and whether a read chunk had none.
        self.low: int | None = None
        self.high: int | None = None
        self.saw_missing = False
        self.write_blocked = False  # read and searched, but the file cannot be rewritten

    def add(self, status: str, *, compression: int | None = None, state: str = UNOBSERVED,
            data_version: int | None = None, count: int = 1) -> None:
        if state == KNOWN and data_version is not None:
            self.low = data_version if self.low is None else min(self.low, data_version)
            self.high = data_version if self.high is None else max(self.high, data_version)
        else:
            state, data_version = (MISSING if state == MISSING else UNOBSERVED), None
            if state == MISSING:
                self.saw_missing = True
        key: Key = (state, data_version, compression, status)
        if key not in self.counts and len(self.counts) >= MAX_KEYS_PER_FILE:
            self.overflow[status] = self.overflow.get(status, 0) + count
            return
        self.counts[key] = self.counts.get(key, 0) + count

    def export(self) -> dict[str, Any]:
        # The overflow also goes into ``counts`` as the earlier format folded it (into the unobserved key of its
        # status), so a reader that only knows ``counts`` still counts every chunk. ``overflow_folded`` tells this
        # reader to take the row out again.
        counts = dict(self.counts)
        for status, count in self.overflow.items():
            key: Key = (UNOBSERVED, None, None, status)
            counts[key] = counts.get(key, 0) + count
        return {
            "dimension": self.dimension, "kind": self.kind, "state": self.state,
            "counts": [[*key, count] for key, count in sorted(counts.items(), key=_sort_key)],
            "overflow": sum(self.overflow.values()), "overflow_by_status": dict(sorted(self.overflow.items())),
            "overflow_folded": bool(self.overflow),
            "low": self.low, "high": self.high, "saw_missing": self.saw_missing, "write_blocked": self.write_blocked,
        }

    @classmethod
    def restore(cls, data: Any) -> FileCoverage | None:
        """A record read back from a checkpoint, or None when it does not have the shape written here."""
        if not isinstance(data, dict) or data.get("state") not in FILE_STATES:
            return None
        record = cls(str(data.get("dimension") or ""), str(data.get("kind") or ""), data["state"])
        for item in data.get("counts") or []:
            if not isinstance(item, list) or len(item) != 5:
                return None
            state, version, compression, status, count = item
            if (
                state not in VERSION_STATES or status not in STATUSES
                or not _optional_int(version) or not _optional_int(compression)
                or not isinstance(count, int) or isinstance(count, bool) or count < 0
            ):
                return None
            record.counts[(state, version, compression, status)] = count
        for name in ("low", "high"):
            value = data.get(name)
            if not _optional_int(value):
                return None
            setattr(record, name, value)
        by_status = data.get("overflow_by_status")
        if by_status is not None:
            if not isinstance(by_status, dict):
                return None
            for status, count in by_status.items():
                if status not in STATUSES or not isinstance(count, int) or isinstance(count, bool) or count < 0:
                    return None
                if count:
                    record.overflow[status] = count
            if data.get("overflow_folded") is True:
                # The legacy row written beside ``overflow_by_status``: it is the overflow, not unobserved chunks.
                for status, count in record.overflow.items():
                    key = (UNOBSERVED, None, None, status)
                    left = record.counts.get(key, 0) - count
                    if left < 0:
                        return None
                    if left:
                        record.counts[key] = left
                    else:
                        record.counts.pop(key, None)
        # A checkpoint from before saw_missing was kept: the retained keys are all it can say.
        record.saw_missing = data.get("saw_missing") is True or any(key[0] == MISSING for key in record.counts)
        record.write_blocked = data.get("write_blocked") is True
        return record


def _optional_int(value: Any) -> bool:
    return value is None or (isinstance(value, int) and not isinstance(value, bool))


def _sort_key(item: tuple[Key, int]) -> tuple:
    (state, version, compression, status), _count = item
    return ((*VERSION_STATES, OVERFLOW).index(state), -1 if version is None else version,
            -1 if compression is None else compression, STATUSES.index(status))


class ChunkCoverage:
    """All files of one scan, keyed by their path inside the world."""

    def __init__(self) -> None:
        self.files: dict[str, FileCoverage] = {}
        self.partial = False  # a resumed scan that could not get the earlier files' counts back

    def file(self, relative: str, dimension: str, kind: str, state: str = FILE_SCANNED) -> FileCoverage:
        """A fresh record for ``relative``; scanning a file again replaces what it counted before."""
        record = FileCoverage(dimension, kind, state)
        self.files[relative] = record
        return record

    def export(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "version": SUMMARY_VERSION, "files": {name: record.export() for name, record in self.files.items()},
        }
        if self.partial:
            data["partial"] = True  # a resumed scan stays incomplete however often it is checkpointed
        return data

    def restore(self, data: Any) -> bool:
        """Take back what a checkpoint holds. False (and nothing taken) when it is absent or malformed."""
        if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
            return False
        restored: dict[str, FileCoverage] = {}
        for name, item in data["files"].items():
            record = FileCoverage.restore(item)
            if not isinstance(name, str) or record is None:
                return False
            restored[name] = record
        self.files.update(restored)
        if data.get("partial") is True:
            self.partial = True
        return True

    def summary(
        self,
        level_versions: list[dict[str, Any]] | None = None,
        *,
        detected_unsupported: dict[str, int] | None = None,
        newest: int = NEWEST_COVERED_DATA_VERSION,
    ) -> dict[str, Any]:
        counts = dict.fromkeys(STATUSES, 0)
        distribution: dict[tuple[str, int | None], int] = {}
        groups: dict[tuple[str, str], list[FileCoverage]] = {}
        files = dict.fromkeys(FILE_STATES, 0)
        low: int | None = None
        high: int | None = None
        saw_missing = False
        overflow = 0
        for record in self.files.values():
            files[record.state] += 1
            groups.setdefault((record.dimension, record.kind), []).append(record)
            for (state, version, _compression, status), count in record.counts.items():
                counts[status] += count
                if state != UNOBSERVED:
                    distribution[(state, version)] = distribution.get((state, version), 0) + count
            for status, count in record.overflow.items():
                counts[status] += count
                overflow += count
            if record.low is not None:
                low = record.low if low is None else min(low, record.low)
            if record.high is not None:
                high = record.high if high is None else max(high, record.high)
            saw_missing = saw_missing or record.saw_missing
        # Exact from the per-file extrema, however many keys a file had to give up: two versions exist when the
        # lowest and highest differ, or when a chunk without one was read next to a chunk with one.
        mixed = (low is not None and low != high) or (saw_missing and low is not None)
        levels = [
            {"world": str(item.get("world") or ""), "data_version": item.get("data_version")}
            for item in (level_versions or [])
        ]
        level_numbers = [item["data_version"] for item in levels if isinstance(item["data_version"], int)]
        summary: dict[str, Any] = {
            "version": SUMMARY_VERSION,
            "level_data_version": max(level_numbers) if level_numbers else None,
            "level_data_versions": levels,
            "newest_covered": newest,
            "chunk_versions": {
                "min": low,
                "max": high,
                **({"truncated": True, "overflow": overflow} if overflow else {}),
                "distribution": [
                    {"data_version": version, "state": state, "count": count}
                    for (state, version), count in sorted(
                        distribution.items(), key=lambda item: (item[0][0] != MISSING, item[0][1] or 0)
                    )
                ],
            },
            "flags": {
                "mixed": mixed,
                "newer": high is not None and high > newest,
                "missing": saw_missing,
            },
            "counts": {**counts, "total": sum(counts.values())},
            "groups": [
                _group_summary(dimension, kind, records)
                for (dimension, kind), records in sorted(groups.items())
            ],
            "files": {
                "scanned": files[FILE_SCANNED],
                "unreadable": files[FILE_UNREADABLE],
                "not_inspected": files[FILE_NOT_INSPECTED],
                "detected_unsupported": {name: int(n) for name, n in (detected_unsupported or {}).items() if n},
            },
        }
        if self.partial:
            summary["partial"] = True
        return summary


def _group_summary(dimension: str, kind: str, records: list[FileCoverage]) -> dict[str, Any]:
    entries: dict[Key, int] = {}
    counts = dict.fromkeys(STATUSES, 0)
    overflow = 0
    lows = [record.low for record in records if record.low is not None]
    highs = [record.high for record in records if record.high is not None]
    for record in records:
        for key, count in record.counts.items():
            entries[key] = entries.get(key, 0) + count
            counts[key[3]] += count
        for status, count in record.overflow.items():
            key = (OVERFLOW, None, None, status)
            entries[key] = entries.get(key, 0) + count
            counts[status] += count
            overflow += count
    ordered = sorted(entries.items(), key=lambda item: (-item[1], *_sort_key(item)))
    group: dict[str, Any] = {
        "dimension": dimension,
        "kind": kind,
        "counts": counts,
        "min": min(lows) if lows else None,
        "max": max(highs) if highs else None,
        "write_blocked_files": sum(1 for record in records if record.write_blocked),
        "entries": [
            {"state": state, "data_version": version, "compression": compression, "status": status, "count": count}
            for (state, version, compression, status), count in ordered[:MAX_ENTRIES_PER_GROUP]
        ],
    }
    if overflow:
        group["overflow"] = overflow
    if len(ordered) > MAX_ENTRIES_PER_GROUP:
        group["entries_truncated"] = True
    return group


def public_summary(summary: dict[str, Any]) -> dict[str, Any]:
    """The same summary under the camelCase names the desktop messages use."""
    versions = summary.get("chunk_versions") or {}
    files = summary.get("files") or {}
    return {
        "version": summary.get("version", SUMMARY_VERSION),
        "levelDataVersion": summary.get("level_data_version"),
        "levelDataVersions": [
            {"world": item.get("world", ""), "dataVersion": item.get("data_version")}
            for item in summary.get("level_data_versions") or []
        ],
        "newestCovered": summary.get("newest_covered", NEWEST_COVERED_DATA_VERSION),
        "chunkVersions": {
            "min": versions.get("min"),
            "max": versions.get("max"),
            **({"truncated": True, "overflow": versions.get("overflow", 0)} if versions.get("truncated") else {}),
            "distribution": [
                {"dataVersion": item.get("data_version"), "state": item.get("state"), "count": item.get("count", 0)}
                for item in versions.get("distribution") or []
            ],
        },
        "flags": dict(summary.get("flags") or {}),
        "counts": dict(summary.get("counts") or {}),
        "groups": [
            {
                "dimension": group.get("dimension", ""),
                "kind": group.get("kind", ""),
                "counts": dict(group.get("counts") or {}),
                "min": group.get("min"),
                "max": group.get("max"),
                "writeBlockedFiles": group.get("write_blocked_files", 0),
                **({"overflow": group["overflow"]} if group.get("overflow") else {}),
                "entries": [
                    {
                        "state": entry.get("state"), "dataVersion": entry.get("data_version"),
                        "compression": entry.get("compression"), "status": entry.get("status"),
                        "count": entry.get("count", 0),
                    }
                    for entry in group.get("entries") or []
                ],
                **({"entriesTruncated": True} if group.get("entries_truncated") else {}),
            }
            for group in summary.get("groups") or []
        ],
        "files": {
            "scanned": files.get("scanned", 0),
            "unreadable": files.get("unreadable", 0),
            "notInspected": files.get("not_inspected", 0),
            "detectedUnsupported": dict(files.get("detected_unsupported") or {}),
        },
        **({"partial": True} if summary.get("partial") else {}),
    }


def level_data_versions(world_dir: Path) -> list[dict[str, Any]]:
    """``[{"world", "data_version"}]`` from the ``level.dat`` of the world, or of each world in a server root."""
    from mwt import nbtio
    from mwt.layout import world_data_roots

    root = world_dir.resolve()
    found: list[dict[str, Any]] = []
    try:
        data_roots = world_data_roots(root)
    except OSError:
        return found
    for data_root in data_roots:
        level = data_root / "level.dat"
        if not level.is_file():
            continue
        version: int | None = None
        try:
            level.resolve().relative_to(root)
            document = nbtio.parse(gzip.decompress(level.read_bytes()), keep_scalars="all")
            data = document.get("Data")
            value = getattr(
                (data if isinstance(data, dict) else document).get("DataVersion"), "value", None
            )
            version = int(value) if isinstance(value, int) and not isinstance(value, bool) else None
        except (OSError, ValueError, TypeError, EOFError, zlib.error):
            version = None
        found.append({"world": data_root.name or data_root.as_posix(), "data_version": version})
    return found


def needs_newer_version_confirmation(coverage: Any) -> bool:
    """True for a stored or public summary of a scan that met chunks newer than this build was tested with.

    Anything that is not such a summary (a scan plan written before coverage existed) is False.
    """
    if not isinstance(coverage, dict):
        return False
    flags = coverage.get("flags")
    return isinstance(flags, dict) and flags.get("newer") is True
