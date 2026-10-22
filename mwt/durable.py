"""Durable file primitives shared by backups, checkpoints, reports and settings.

What these promise, and no more: after ``atomic_write_bytes`` returns, the new content was
flushed to the device before it replaced the old file, and on POSIX the directory entry was
flushed too. Windows has no portable directory flush, so there the rename relies on the
filesystem's own metadata journaling and nothing stronger is claimed. No ordering is promised
across several files; callers that need one (backup before world write) sequence it themselves.
"""

from __future__ import annotations

import errno
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

# Errors that mean "this filesystem cannot do that", as opposed to a real I/O failure.
_UNSUPPORTED = {errno.EINVAL, errno.ENOTSUP, errno.ENOTTY, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)}
# Windows sharing/lock violations are usually an indexer or antivirus holding the file briefly.
_TRANSIENT_WINERRORS = {5, 32, 33}
_REPLACE_ATTEMPTS = 6


def fsync_fd(descriptor: int) -> None:
    """Flush one open file to the device. macOS needs F_FULLFSYNC to pass the drive cache."""
    if sys.platform == "darwin":
        import fcntl

        full = getattr(fcntl, "F_FULLFSYNC", None)
        if full is not None:
            try:
                fcntl.fcntl(descriptor, full)
                return
            except OSError as exc:
                if exc.errno not in _UNSUPPORTED:
                    raise  # a real I/O error must not be hidden behind a plain fsync
    os.fsync(descriptor)


def fsync_dir(path: Path) -> None:
    """Flush a directory entry change (POSIX). A no-op on Windows, which has no equivalent."""
    if sys.platform == "win32":
        return
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError as exc:
        if exc.errno in _UNSUPPORTED:
            return
        raise
    try:
        os.fsync(descriptor)
    except OSError as exc:
        if exc.errno not in _UNSUPPORTED:
            raise
    finally:
        os.close(descriptor)


def mkdir_durable(path: Path) -> None:
    """``mkdir -p`` that also flushes the entry of every directory it had to create (POSIX)."""
    missing: list[Path] = []
    probe = path
    while not probe.exists():
        missing.append(probe)
        if probe.parent == probe:
            break
        probe = probe.parent
    path.mkdir(parents=True, exist_ok=True)
    for created in reversed(missing):
        fsync_dir(created.parent)


def replace(source: Path, destination: Path) -> None:
    """``os.replace`` with a short bounded retry for transient Windows sharing violations only."""
    for attempt in range(1, _REPLACE_ATTEMPTS + 1):
        try:
            os.replace(source, destination)
            return
        except PermissionError as exc:
            transient = sys.platform == "win32" and getattr(exc, "winerror", None) in _TRANSIENT_WINERRORS
            if not transient or attempt == _REPLACE_ATTEMPTS:
                raise
            time.sleep(0.05 * attempt)


def atomic_write_bytes(
    path: Path,
    content: bytes,
    *,
    temporary: Path | None = None,
    copy_mode: bool = False,
) -> None:
    """Write ``content`` next to ``path``, fsync it, then replace ``path``.

    The temporary path is known the moment it exists, so a failure at any later step removes it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        if temporary is not None:
            tmp_path = temporary
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
        else:
            descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
            tmp_path = Path(name)
        try:
            handle = os.fdopen(descriptor, "wb")
        except BaseException:
            os.close(descriptor)
            raise
        with handle:
            handle.write(content)
            handle.flush()
            fsync_fd(handle.fileno())
        if copy_mode and path.exists():
            shutil.copymode(path, tmp_path)
        replace(tmp_path, path)
        tmp_path = None  # published: nothing left to clean up
        fsync_dir(path.parent)
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


def atomic_write_text(path: Path, text: str, *, temporary: Path | None = None, copy_mode: bool = False) -> None:
    atomic_write_bytes(path, text.encode("utf-8"), temporary=temporary, copy_mode=copy_mode)


def copy_durable(source: Path, destination: Path) -> None:
    """Copy a file with its metadata and flush the copy, so a backup payload is on disk before use."""
    with open(source, "rb") as reader, open(destination, "wb") as writer:
        shutil.copyfileobj(reader, writer, 1024 * 1024)
        writer.flush()
        fsync_fd(writer.fileno())  # fsync on the writable handle: a read-only one fails on Windows
    shutil.copystat(source, destination)
    fsync_dir(destination.parent)
