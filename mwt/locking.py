"""Cross-process world write lock shared by the CLI and desktop sidecar.

Two guards protect a write, and both are held by the operating system, not by the existence of a
file, so a crashed or killed process can never leave a lock behind:

* ``WorldWriteLock`` keeps a kernel lock on ``<world>/.pomi-translate/write.lock``. That file is
  opened without ``O_EXCL``, is never unlinked or replaced, and stays open until ``release``.
* ``MinecraftSessionLocks`` takes the same kind of lock on the game's own ``session.lock``, the
  way Java's ``FileChannel.tryLock`` does, so a running game or server blocks a write.

Who holds the lock is written to ``write.owner.json`` for diagnostics only. On Windows a locked
byte cannot be read by another process, so the lock file itself carries no data and a failed
acquire never depends on reading any metadata.
"""

from __future__ import annotations

import errno
import json
import os
import socket
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


class WorldWriteLocked(RuntimeError):
    pass


class MinecraftWorldInUse(RuntimeError):
    pass


_LOCK_NAME = "write.lock"
_OWNER_NAME = "write.owner.json"
# A kernel lock request fails with one of these when somebody else holds the range.
_CONTENDED = {errno.EACCES, errno.EAGAIN, errno.EDEADLK, getattr(errno, "EWOULDBLOCK", errno.EAGAIN)}
# The filesystem cannot lock at all (some network mounts). That is not "free".
_NO_LOCKING = {errno.ENOLCK, errno.ENOSYS, errno.ENOTSUP, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)}

# Every lock file this process holds, under its path and its inode identity. POSIX record locks
# are per process: opening and closing a second descriptor to a held file would silently drop
# the lock, and a second request from the same process would "succeed". So this process never
# opens a held lock file again and refuses a second holder itself.
_HELD: dict[str, object] = {}
_HELD_GUARD = threading.RLock()


def pid_is_alive(pid: int) -> bool:
    """Whether a process with this id exists. Unknown answers count as alive, never as free."""
    if pid <= 0:
        return False
    if os.name == "nt":
        return _windows_pid_is_alive(pid)
    try:
        os.kill(pid, 0)  # POSIX only: signal 0 probes without delivering anything
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


def _windows_pid_is_alive(pid: int) -> bool:
    """OpenProcess + GetExitCodeProcess. ``os.kill`` must never be used on Windows: any signal
    other than the console events terminates the target."""
    import ctypes
    from ctypes import wintypes

    process_query_limited_information = 0x1000
    error_access_denied = 5
    error_invalid_parameter = 87
    still_active = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        code = ctypes.get_last_error()
        if code == error_access_denied:
            return True  # it exists; we are just not allowed to look
        return code != error_invalid_parameter
    try:
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return True
        return exit_code.value == still_active
    finally:
        kernel32.CloseHandle(handle)


_pid_is_alive = pid_is_alive  # earlier name, kept for callers that imported it


def _identity_keys(path: Path) -> list[str]:
    keys = [os.path.normcase(os.path.realpath(path))]
    try:
        info = path.stat()
    except OSError:
        return keys
    if info.st_ino:
        keys.append(f"inode:{info.st_dev}:{info.st_ino}")
    return keys


def _try_lock(descriptor: int) -> None:
    """Take a non-blocking exclusive lock on the first byte. Raises OSError on contention."""
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        # Windows byte-range locks conflict with the LockFileEx call Java's tryLock makes.
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        # Java takes fcntl byte-range locks; flock() does not conflict with those on Linux.
        fcntl.lockf(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB, 0, 0, 0)


def _unlock(descriptor: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.lockf(descriptor, fcntl.LOCK_UN, 0, 0, 0)


def _app_version() -> str:
    try:
        from mwt import __version__

        return str(__version__)
    except Exception:
        return ""


def read_lock_owner(world_dir: Path) -> dict:
    """Who last took the write lock, for messages. Informational: it may be stale or missing."""
    try:
        loaded = json.loads((Path(world_dir) / ".pomi-translate" / _OWNER_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


class WorldWriteLock:
    def __init__(self, world_dir: Path, purpose: str = "translate") -> None:
        self.world_dir = world_dir.resolve()
        self.path = self.world_dir / ".pomi-translate" / _LOCK_NAME
        self.owner_path = self.path.with_name(_OWNER_NAME)
        self.purpose = purpose
        self.token = uuid.uuid4().hex
        self.acquired = False
        self._descriptor: int | None = None
        self._keys: list[str] = []

    def acquire(self) -> None:
        if self.acquired:
            raise WorldWriteLocked("This write lock is already held by this operation")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with _HELD_GUARD:
            if any(key in _HELD for key in _identity_keys(self.path)):
                raise WorldWriteLocked(self._contended_message())
            descriptor = self._open_and_lock()
            self._descriptor = descriptor
            self._keys = _identity_keys(self.path)
            for key in self._keys:
                _HELD[key] = self
            self.acquired = True
        self._publish_owner()

    def _contended_message(self) -> str:
        owner = read_lock_owner(self.world_dir)
        suffix = f" (process {owner['pid']})" if isinstance(owner.get("pid"), int) else ""
        return f"Another PomiTranslate write operation is using this world{suffix}"

    def _open_and_lock(self) -> int:
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0)  # never O_EXCL: existence means nothing
        try:
            descriptor = os.open(self.path, flags, 0o600)
        except OSError as exc:
            raise WorldWriteLocked(f"The world write lock could not be opened: {exc.strerror or exc}") from exc
        try:
            try:
                _try_lock(descriptor)
            except OSError as exc:
                if exc.errno in _NO_LOCKING:
                    raise WorldWriteLocked(
                        "This folder's filesystem does not support file locking, so a safe write cannot be guaranteed"
                    ) from exc
                raise WorldWriteLocked(self._contended_message()) from exc
            self._reclaim_legacy_file(descriptor)
        except BaseException:
            os.close(descriptor)
            raise
        return descriptor

    def _reclaim_legacy_file(self, descriptor: int) -> None:
        """Releases before kernel locks marked ownership with a JSON body in an O_EXCL file.

        Holding the kernel lock proves no new-style writer is active. An old-style owner that
        still looks alive on this machine keeps the world. Anything else is a stale leftover.
        """
        os.lseek(descriptor, 0, os.SEEK_SET)
        content = os.read(descriptor, 4096)
        if not content:
            return
        try:
            existing = json.loads(content.decode("utf-8"))
            pid = int(existing["pid"])
            same_host = existing.get("host") == socket.gethostname()
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            existing = None  # truncated or foreign bytes: nobody can be using it
        if existing is not None and same_host and pid != os.getpid() and pid_is_alive(pid):
            try:
                _unlock(descriptor)
            except OSError:
                pass
            raise WorldWriteLocked(
                f"An earlier PomiTranslate version (process {pid}) still appears to be writing to this world"
            )
        os.lseek(descriptor, 0, os.SEEK_SET)
        os.ftruncate(descriptor, 0)

    def _publish_owner(self) -> None:
        document = {
            "version": 2,
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "appVersion": _app_version(),
            "startedAt": time.time(),
            "purpose": self.purpose,
            "token": self.token,
        }
        temporary = self.owner_path.with_name(f"{_OWNER_NAME}.{self.token[:8]}.tmp")
        try:
            temporary.write_text(json.dumps(document), encoding="utf-8")
            os.replace(temporary, self.owner_path)
        except OSError:
            temporary.unlink(missing_ok=True)  # informational only: the lock is already ours

    def release(self) -> None:
        if not self.acquired:
            return
        self.acquired = False
        try:
            # Drop the owner note while still holding the lock, so it can never delete a successor's.
            if read_lock_owner(self.world_dir).get("token") == self.token:
                self.owner_path.unlink(missing_ok=True)
        except OSError:
            pass
        descriptor, self._descriptor = self._descriptor, None
        if descriptor is not None:
            try:
                _unlock(descriptor)
            except OSError:
                pass
            try:
                os.close(descriptor)
            except OSError:
                pass
        with _HELD_GUARD:
            for key in self._keys:
                if _HELD.get(key) is self:
                    del _HELD[key]
        self._keys = []

    def __enter__(self) -> "WorldWriteLock":
        self.acquire()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.release()


class MinecraftSessionLocks:
    """Hold existing Java Edition session.lock files for the full write operation."""

    def __init__(self, world_dir: Path) -> None:
        self.world_dir = world_dir.resolve()
        self._handles: list[tuple[object, list[str]]] = []

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
                with _HELD_GUARD:
                    if any(key in _HELD for key in _identity_keys(session_path)):
                        # This process already holds it. Opening it again could drop that lock.
                        raise MinecraftWorldInUse(f"Minecraft or a server is using {root.name}")
                    handle = session_path.open("r+b")
                    try:
                        _try_lock(handle.fileno())
                    except OSError as exc:
                        handle.close()
                        raise MinecraftWorldInUse(f"Minecraft or a server is using {root.name}") from exc
                    keys = _identity_keys(session_path)
                    for key in keys:
                        _HELD[key] = self
                    self._handles.append((handle, keys))
        except Exception:
            self.release()
            raise

    def release(self) -> None:
        for handle, keys in reversed(self._handles):
            try:
                _unlock(handle.fileno())
            except OSError:
                pass
            try:
                handle.close()
            except OSError:
                pass
            with _HELD_GUARD:
                for key in keys:
                    if _HELD.get(key) is self:
                        del _HELD[key]
        self._handles.clear()

    def __enter__(self) -> "MinecraftSessionLocks":
        self.acquire()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.release()


@contextmanager
def hold_world(world_dir: Path, purpose: str = "restore"):
    """Both write guards for the whole body, released in any order of failure.

    Raises ``WorldWriteLocked`` or ``MinecraftWorldInUse`` before the body runs.
    """
    write_lock = WorldWriteLock(world_dir, purpose)
    session_locks = MinecraftSessionLocks(world_dir)
    write_lock.acquire()
    try:
        session_locks.acquire()
        yield
    finally:
        session_locks.release()
        write_lock.release()


def world_is_in_use(world_dir: Path) -> bool:
    guard = MinecraftSessionLocks(world_dir)
    try:
        guard.acquire()  # a lock this process already holds is reported before any file is opened
    except (MinecraftWorldInUse, OSError):
        return True
    finally:
        guard.release()
    return False
