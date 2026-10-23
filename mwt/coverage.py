"""What a scan actually looked at, chunk by chunk, kept as counts and never as per-chunk lists.

A chunk is counted under ``(version state, DataVersion, compression, status)``. The state says how the
DataVersion is known: ``known`` (the chunk carries one), ``missing`` (the chunk was read and has none,
as in worlds saved before 15w32a) or ``unobserved`` (the chunk was never read, so nothing can be said).
The status is what the scan did with it:

- ``processed``: read and searched for text.
- ``skipped_unsupported``: not searched because its structure is not supported (an unknown
  compression, or a region file that cannot be rewritten safely).
- ``unreadable``: present, but damaged or too large to read.
- ``not_inspected``: outside the scan scope (the file was excluded, or could not be opened at all).

Memory stays bounded: a file keeps at most ``MAX_KEYS_PER_FILE`` distinct keys, and the checkpoint stores the
same counts so a resumed scan can replace one file without double counting.
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

FILE_SCANNED = "scanned"
FILE_UNREADABLE = "unreadable"
FILE_NOT_INSPECTED = "not_inspected"
FILE_STATES = (FILE_SCANNED, FILE_UNREADABLE, FILE_NOT_INSPECTED)

MAX_KEYS_PER_FILE = 64
MAX_ENTRIES_PER_GROUP = 200
SUMMARY_VERSION = 1

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

    __slots__ = ("dimension", "kind", "state", "counts", "overflow", "low", "high")

    def __init__(self, dimension: str, kind: str, state: str = FILE_SCANNED) -> None:
        self.dimension = dimension
        self.kind = kind
        self.state = state
        self.counts: dict[Key, int] = {}
        self.overflow = 0  # chunks folded into the unobserved key because the file met too many keys
        self.low: int | None = None
        self.high: int | None = None

    def add(self, status: str, *, compression: int | None = None, state: str = UNOBSERVED,
            data_version: int | None = None, count: int = 1) -> None:
        if state == KNOWN and data_version is not None:
            self.low = data_version if self.low is None else min(self.low, data_version)
            self.high = data_version if self.high is None else max(self.high, data_version)
        else:
            state, data_version = (MISSING if state == MISSING else UNOBSERVED), None
        key: Key = (state, data_version, compression, status)
        if key not in self.counts and len(self.counts) >= MAX_KEYS_PER_FILE:
            key = (UNOBSERVED, None, None, status)
            self.overflow += count
        self.counts[key] = self.counts.get(key, 0) + count

    def export(self) -> dict[str, Any]:
        return {
            "dimension": self.dimension, "kind": self.kind, "state": self.state,
            "counts": [[*key, count] for key, count in sorted(self.counts.items(), key=_sort_key)],
            "overflow": self.overflow, "low": self.low, "high": self.high,
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
        overflow = data.get("overflow")
        record.overflow = overflow if isinstance(overflow, int) and not isinstance(overflow, bool) else 0
        return record


def _optional_int(value: Any) -> bool:
    return value is None or (isinstance(value, int) and not isinstance(value, bool))


def _sort_key(item: tuple[Key, int]) -> tuple:
    (state, version, compression, status), _count = item
    return (VERSION_STATES.index(state), -1 if version is None else version,
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
        return {"version": SUMMARY_VERSION, "files": {name: record.export() for name, record in self.files.items()}}

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
        groups: dict[tuple[str, str], dict[Key, int]] = {}
        files = dict.fromkeys(FILE_STATES, 0)
        low: int | None = None
        high: int | None = None
        for record in self.files.values():
            files[record.state] += 1
            group = groups.setdefault((record.dimension, record.kind), {})
            for key, count in record.counts.items():
                state, version, _compression, status = key
                counts[status] += count
                group[key] = group.get(key, 0) + count
                if state != UNOBSERVED:
                    distribution[(state, version)] = distribution.get((state, version), 0) + count
            if record.low is not None:
                low = record.low if low is None else min(low, record.low)
            if record.high is not None:
                high = record.high if high is None else max(high, record.high)
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
                "distribution": [
                    {"data_version": version, "state": state, "count": count}
                    for (state, version), count in sorted(
                        distribution.items(), key=lambda item: (item[0][0] != MISSING, item[0][1] or 0)
                    )
                ],
            },
            "flags": {
                "mixed": len(distribution) > 1,
                "newer": high is not None and high > newest,
                "missing": any(key[0] == MISSING for key in distribution),
            },
            "counts": {**counts, "total": sum(counts.values())},
            "groups": [
                _group_summary(dimension, kind, entries)
                for (dimension, kind), entries in sorted(groups.items())
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


def _group_summary(dimension: str, kind: str, entries: dict[Key, int]) -> dict[str, Any]:
    counts = dict.fromkeys(STATUSES, 0)
    known = []
    for (state, version, _compression, status), count in entries.items():
        counts[status] += count
        if state == KNOWN and version is not None:
            known.append(version)
    ordered = sorted(entries.items(), key=lambda item: (-item[1], *_sort_key(item)))
    group: dict[str, Any] = {
        "dimension": dimension,
        "kind": kind,
        "counts": counts,
        "min": min(known) if known else None,
        "max": max(known) if known else None,
        "entries": [
            {"state": state, "data_version": version, "compression": compression, "status": status, "count": count}
            for (state, version, compression, status), count in ordered[:MAX_ENTRIES_PER_GROUP]
        ],
    }
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
