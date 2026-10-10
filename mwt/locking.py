"""Cross-process world write lock shared by the CLI and desktop sidecar, and the Minecraft check.

Two kinds of OS lock are involved and they do not behave alike:

* ``flock`` belongs to an open file description. Two descriptors in the same process conflict.
* POSIX record locks (``fcntl``/``lockf``, what Java's ``FileChannel.tryLock`` uses) belong to the
  process. They never conflict inside one process, and closing *any* descriptor of the file drops
  every such lock the process holds on it.

On Linux the two kinds are independent, so an ``flock`` alone never sees Minecraft's lock. On
macOS and the BSDs they are one mechanism and conflict with each other, even inside one process.
"""

from __future__ import annotations

import errno
import json
import os
import socket
import sys
import threading
import time
import uuid
from pathlib import Path

# A lock file that is empty or unreadable is only treated as abandoned once it is this old, so a
# writer that has just created it (and not yet written its owner) is never pushed aside.
_UNWRITTEN_LOCK_GRACE_SECONDS = 2.0
_BUSY_ERRNOS = {errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK}


class WorldWriteLocked(RuntimeError):
    pass


class MinecraftWorldInUse(RuntimeError):
    pass


def _pid_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _try_exclusive(descriptor: int) -> bool | None:
    """Take a non-blocking exclusive lock owned by this open file description.

    True when taken, False when someone else holds it, None when the file system has no such lock.
    """
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        except OSError:
            return False
        return True
    import fcntl

    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if exc.errno in _BUSY_ERRNOS:
            return False
        if exc.errno in {errno.ENOLCK, errno.EOPNOTSUPP, errno.ENOTSUP, errno.EINVAL}:
            return None
        raise
    return True


def _unlock(descriptor: int) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_UN)
    except OSError:
        pass


def _same_file(descriptor: int, path: Path) -> bool:
    try:
        held, named = os.fstat(descriptor), os.stat(path)
    except OSError:
        return False
    return (held.st_dev, held.st_ino) == (named.st_dev, named.st_ino)


def _read_document(descriptor: int) -> tuple[dict | None, bool]:
    """(owner document, whether the file had any content)."""
    os.lseek(descriptor, 0, os.SEEK_SET)
    chunks = []
    while True:
        block = os.read(descriptor, 65536)
        if not block:
            break
        chunks.append(block)
    raw = b"".join(chunks)
    if not raw.strip():
        return None, False
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, True
    return (document if isinstance(document, dict) else None), True


class WorldWriteLock:
    """One PomiTranslate writer per world.

    The lock file names its owner, and the owner also holds an OS lock on it for as long as the
    write runs. A crashed owner's OS lock disappears with its process, so a newcomer that gets the
    OS lock can tell an abandoned file from a live one without the read-then-delete race the
    owner document alone had: two newcomers could both read a dead owner, and the slower one would
    then delete the faster one's fresh lock.
    """

    def __init__(self, world_dir: Path) -> None:
        self.world_dir = world_dir.resolve()
        self.path = self.world_dir / ".pomi-translate" / "write.lock"
        self.token = uuid.uuid4().hex
        self.acquired = False
        self._descriptor: int | None = None

    def _document(self) -> bytes:
        return json.dumps(
            {
                "version": 2,
                "pid": os.getpid(),
                "host": socket.gethostname(),
                "createdAt": time.time(),
                "token": self.token,
            }
        ).encode("utf-8")

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_RDWR | getattr(os, "O_BINARY", 0)
        for _attempt in range(8):
            try:
                descriptor = os.open(self.path, flags | os.O_CREAT | os.O_EXCL, 0o600)
                created = True
            except FileExistsError:
                try:
                    descriptor = os.open(self.path, flags)
                except FileNotFoundError:
                    continue  # its owner just released it
                created = False
            keep = False
            try:
                locked = _try_exclusive(descriptor)
                if locked is None:
                    # No OS locks on this file system: fall back to the owner document alone.
                    os.close(descriptor)
                    descriptor = -1
                    if created:
                        self.path.unlink(missing_ok=True)
                    self._acquire_without_os_lock()
                    return
                if not locked:
                    raise WorldWriteLocked("Another PomiTranslate write operation is using this world")
                if not _same_file(descriptor, self.path):
                    # The previous owner removed this file after we opened it. Lock the new one.
                    continue
                existing, had_content = _read_document(descriptor)
                if (had_content or not created) and not self._abandoned(existing, descriptor):
                    raise WorldWriteLocked("Another PomiTranslate write operation is using this world")
                os.ftruncate(descriptor, 0)
                os.lseek(descriptor, 0, os.SEEK_SET)
                os.write(descriptor, self._document())
                os.fsync(descriptor)
                self._descriptor = descriptor
                self.acquired = True
                keep = True
                return
            finally:
                if not keep and descriptor >= 0:
                    _unlock(descriptor)
                    os.close(descriptor)
        raise WorldWriteLocked("Could not acquire the world write lock")

    def _abandoned(self, existing: dict | None, descriptor: int) -> bool:
        """Whether a lock file whose OS lock we now hold was left by a writer that is gone.

        A live writer of an older release holds no OS lock, and a writer on another computer may
        not see ours, so their owner document still counts.
        """
        if existing is None:
            # Empty or unreadable: a writer may have created it a moment ago and not written yet.
            try:
                age = time.time() - os.fstat(descriptor).st_mtime
            except OSError:
                return False
            return age >= _UNWRITTEN_LOCK_GRACE_SECONDS
        try:
            same_host = existing.get("host") == socket.gethostname()
            pid = int(existing.get("pid", 0))
        except (TypeError, ValueError):
            return False
        if not same_host:
            return False
        if existing.get("version") == 2:
            # A live owner of this release would still hold the OS lock we just took.
            return True
        return not _pid_is_alive(pid)

    def _acquire_without_os_lock(self) -> None:
        encoded = self._document()
        for attempt in range(2):
            try:
                descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                if attempt or not self._remove_stale_lock():
                    raise WorldWriteLocked("Another PomiTranslate write operation is using this world")
                continue
            try:
                os.write(descriptor, encoded)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            self.acquired = True
            return
        raise WorldWriteLocked("Could not acquire the world write lock")

    def _remove_stale_lock(self) -> bool:
        try:
            existing = json.loads(self.path.read_text(encoding="utf-8"))
            same_host = existing.get("host") == socket.gethostname()
            pid = int(existing.get("pid", 0))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False
        if not same_host or _pid_is_alive(pid):
            return False
        try:
            self.path.unlink()
        except OSError:
            return False
        return True

    def release(self) -> None:
        if not self.acquired:
            return
        descriptor, self._descriptor = self._descriptor, None
        self.acquired = False
        if descriptor is None:
            try:
                existing = json.loads(self.path.read_text(encoding="utf-8"))
                if existing.get("token") == self.token:
                    self.path.unlink(missing_ok=True)
            except (OSError, json.JSONDecodeError):
                pass
            return
        try:
            existing, _ = _read_document(descriptor)
            ours = isinstance(existing, dict) and existing.get("token") == self.token
            if ours and os.name != "nt" and _same_file(descriptor, self.path):
                # Remove the name while the lock is still held: whoever opened this file meanwhile
                # finds it gone once they get the lock, and starts over with a new one.
                self.path.unlink(missing_ok=True)
        except OSError:
            ours = False
        finally:
            _unlock(descriptor)
            os.close(descriptor)
        if ours and os.name == "nt":
            # Windows cannot delete an open file. If another writer opened it after we closed it,
            # the delete fails and their lock file stays where it is.
            try:
                self.path.unlink(missing_ok=True)
            except OSError:
                pass


# Session locks this process holds, by (device, inode). A second descriptor for one of these must
# never be opened: closing it would silently drop the POSIX lock held through the first one.
_HELD_SESSION_LOCKS: set[tuple[int, int]] = set()
_HELD_GUARD = threading.Lock()


def _lock_session_descriptor(descriptor: int) -> None:
    """Raise OSError unless this process now holds the session lock the way Minecraft checks it."""
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        return
    import fcntl

    # The lock Java's FileChannel.tryLock takes (and checks): a POSIX record lock on the whole file.
    fcntl.lockf(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if sys.platform.startswith("linux"):
        # Linux keeps flock separate from POSIX locks; an flock holder (older PomiTranslate
        # releases, other tools) is only visible to flock. Elsewhere both are one mechanism and a
        # second lock from this process would collide with the first.
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in _BUSY_ERRNOS:
                fcntl.lockf(descriptor, fcntl.LOCK_UN)
                raise
            # A file system without flock still has the POSIX lock above.


def _unlock_session_descriptor(descriptor: int) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            return
        import fcntl

        if sys.platform.startswith("linux"):
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            except OSError:
                pass
        fcntl.lockf(descriptor, fcntl.LOCK_UN)
    except OSError:
        pass


class MinecraftSessionLocks:
    """Hold existing Java Edition session.lock files for the full write operation."""

    def __init__(self, world_dir: Path) -> None:
        self.world_dir = world_dir.resolve()
        self._handles: list[tuple[object, tuple[int, int]]] = []

    def _world_roots(self) -> list[Path]:
        if (self.world_dir / "level.dat").is_file():
            return [self.world_dir]
        try:
            return sorted(
                path for path in self.world_dir.iterdir()
                if path.is_dir() and (path / "level.dat").is_file()
            )
        except OSError:
            return []

    def acquire(self) -> None:
        try:
            for root in self._world_roots():
                session_path = root / "session.lock"
                if not session_path.is_file():
                    continue
                self._acquire_one(root, session_path)
        except Exception:
            self.release()
            raise

    def _acquire_one(self, root: Path, session_path: Path) -> None:
        in_use = MinecraftWorldInUse(f"Minecraft or a server is using {root.name}")
        with _HELD_GUARD:
            try:
                info = session_path.stat()
            except OSError as exc:
                raise in_use from exc
            key = (info.st_dev, info.st_ino)
            if key in _HELD_SESSION_LOCKS:
                raise in_use
            handle = session_path.open("r+b")
            try:
                _lock_session_descriptor(handle.fileno())
            except (OSError, BlockingIOError) as exc:
                handle.close()
                raise in_use from exc
            _HELD_SESSION_LOCKS.add(key)
            self._handles.append((handle, key))

    def release(self) -> None:
        with _HELD_GUARD:
            for handle, key in reversed(self._handles):
                _unlock_session_descriptor(handle.fileno())
                try:
                    handle.close()
                except OSError:
                    pass
                _HELD_SESSION_LOCKS.discard(key)
            self._handles.clear()


def world_is_in_use(world_dir: Path) -> bool:
    guard = MinecraftSessionLocks(world_dir)
    try:
        guard.acquire()
    except (MinecraftWorldInUse, OSError):
        return True
    finally:
        guard.release()
    return False
