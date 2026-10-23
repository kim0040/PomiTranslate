"""The lowest thinking level a Gemini model accepted, shared by every batch of a job and by later jobs.

Some models refuse the lowest level ("minimal"). A refused request is a paid-for round trip, and the
desktop sidecar starts a new process per request, so the level learned in one job is saved in the app
data folder and read back by the next. Inside a process one slot per model lets the first batch (the
learner) find the level while the others wait, so a job sends at most one refused request per level step.

A waiting batch never stops watching the job: ``check`` is called between short waits and raises when the
job was cancelled or given up. The learner tells the waiters how it ended: a level they read from the
floor, a terminal error (a bad key, a wrong endpoint) they raise without sending anything, or nothing,
when its request failed in a way another batch may try again.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Callable

from mwt.reasoning import GEMINI_LEVELS

Key = tuple[str, str, str]  # provider, endpoint digest, model
Check = Callable[[], None]

# How long a waiter sleeps before it looks at the job again. Cancelling a job is noticed within this time.
POLL_SECONDS = 0.05
# Added to (levels x request timeout) for the whole learning sequence: persistence, parameter adaptation.
LEARNING_MARGIN_SECONDS = 10.0

_LOADING = "loading"
_LOADED = "loaded"

_cond = threading.Condition(threading.Lock())  # guards everything below; waiters sleep on it
_floors: dict[Key, tuple[str, float]] = {}  # level, learned_at
_accepted: dict[Key, str] = {}  # lowest level a request already succeeded at in this process
_roots: dict[str, str] = {}  # data folder -> _LOADING while its file is read, _LOADED after it was merged
_slots: dict[Key, "Slot"] = {}


class LearnerFailed(Exception):
    """The batch that was finding the level ended with an error that no other batch can get around."""

    def __init__(self, error: BaseException) -> None:
        super().__init__(str(error))
        self.error = error


class LearningTimeout(Exception):
    """The learner did not finish within the whole learning sequence's deadline."""


class Slot:
    """The right to send the requests that find a model's lowest level. One batch holds it at a time."""

    __slots__ = ("busy", "generation", "terminal", "terminal_generation")

    def __init__(self) -> None:
        self.busy = False
        self.generation = 0  # counts releases, so a waiter knows whether the learner finished since it started waiting
        self.terminal: BaseException | None = None
        self.terminal_generation = 0


def _never_stop() -> None:
    return None


def _rank(level: str) -> int:
    return GEMINI_LEVELS.index(level)


def _ttl() -> float:
    from mwt.userdata import GEMINI_FLOOR_TTL_SECONDS

    return float(GEMINI_FLOOR_TTL_SECONDS)


def key_for(provider: str, base_url: str, model: str) -> Key:
    from mwt.userdata import gemini_floor_endpoint

    return provider, gemini_floor_endpoint(base_url), model


def reset_memory() -> None:
    """Forget everything learned in this process, as a fresh process would."""
    with _cond:
        _floors.clear()
        _accepted.clear()
        _roots.clear()
        _slots.clear()
        _cond.notify_all()


def _live_level(key: Key) -> str | None:
    """The floor of ``key`` if it has not expired. Call with ``_cond`` held. An expired one is dropped on use."""
    entry = _floors.get(key)
    if entry is None:
        return None
    if time.time() - entry[1] > _ttl():
        del _floors[key]
        return None
    return entry[0]


def _load_root(root: Path | None, check: Check) -> None:
    """Merge the floors on disk once per data folder. Concurrent callers wait until the merge has happened."""
    if root is None:
        return
    name = str(root)
    while True:
        check()
        with _cond:
            state = _roots.get(name)
            if state == _LOADED:
                return
            if state is None:
                _roots[name] = _LOADING
                break
            _cond.wait(POLL_SECONDS)  # another batch is reading the file
    from mwt.userdata import load_gemini_level_floor_entries

    saved: dict[Key, tuple[str, float]] = {}
    complete = False
    try:
        try:
            saved = load_gemini_level_floor_entries(root)
            complete = True
        except Exception:
            pass  # unreadable now: no floor for this call, and the next call reads the file again
    finally:
        with _cond:
            if complete:
                for key, (level, stamp) in saved.items():
                    known = _floors.get(key)
                    if known is None or _rank(level) > _rank(known[0]):
                        _floors[key] = (level, stamp)
                _roots[name] = _LOADED
            else:
                _roots.pop(name, None)
            _cond.notify_all()


def floor(key: Key, root: Path | None, check: Check = _never_stop) -> str | None:
    _load_root(root, check)
    with _cond:
        return _live_level(key)


def needs_probe(key: Key, level: str) -> bool:
    """True while nothing says that this model takes ``level``, so one request must find out first."""
    with _cond:
        if _live_level(key) is not None:
            return False  # the level was raised to the floor already; nothing below it is ever sent
        accepted = _accepted.get(key)
        return accepted is None or _rank(level) < _rank(accepted)


def acquire(key: Key, timeout: float, check: Check = _never_stop) -> Slot:
    """Wait for the right to find the level; the caller releases the slot it gets.

    Raises whatever ``check`` raises when the job has stopped, ``LearnerFailed`` when the batch that held the
    slot meanwhile ended with a terminal error, and ``LearningTimeout`` after ``timeout`` seconds.
    """
    deadline = time.monotonic() + timeout
    with _cond:
        slot = _slots.setdefault(key, Slot())
        seen = slot.generation
    while True:
        check()
        with _cond:
            if slot.terminal is not None and slot.terminal_generation > seen:
                raise LearnerFailed(slot.terminal)
            if not slot.busy:
                slot.busy = True
                return slot
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LearningTimeout()
            _cond.wait(min(POLL_SECONDS, remaining))


def release(slot: Slot, failure: BaseException | None = None) -> None:
    """Give the slot up and wake the waiters. ``failure`` is a terminal error they must not repeat."""
    with _cond:
        slot.busy = False
        slot.generation += 1
        slot.terminal = failure
        slot.terminal_generation = slot.generation
        _cond.notify_all()


def accepted(key: Key, level: str) -> None:
    with _cond:
        known = _accepted.get(key)
        if known is None or _rank(level) < _rank(known):
            _accepted[key] = level


def learned(key: Key, base_url: str, level: str, root: Path | None) -> None:
    """The model refused a lower level and took ``level``: remember it here and on disk."""
    with _cond:
        known = _live_level(key)
        if known is not None and _rank(known) >= _rank(level):
            return
        _floors[key] = (level, time.time())
    if root is None:
        return
    from mwt.userdata import remember_gemini_level_floor

    try:
        remember_gemini_level_floor(key[0], base_url, key[2], level, root=root)
    except Exception:
        pass  # a file that cannot be written only costs the next job one refused request
