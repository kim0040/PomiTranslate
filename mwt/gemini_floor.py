"""The lowest thinking level a Gemini model accepted, shared by every batch of a job and by later jobs.

Some models refuse the lowest level ("minimal"). A refused request is a paid-for round trip, and the
desktop sidecar starts a new process per request, so the level learned in one job is saved in the app
data folder and read back by the next. Inside a process one lock per model lets the first batch find
the level while the others wait, so a job sends at most one refused request per level step.
"""

from __future__ import annotations

import threading
from pathlib import Path

from mwt.reasoning import GEMINI_LEVELS

Key = tuple[str, str, str]  # provider, endpoint digest, model

_state = threading.Lock()
_floors: dict[Key, str] = {}
_accepted: dict[Key, str] = {}  # lowest level a request already succeeded at in this process
_probe_locks: dict[Key, threading.Lock] = {}
_loaded_roots: set[str] = set()


def _rank(level: str) -> int:
    return GEMINI_LEVELS.index(level)


def key_for(provider: str, base_url: str, model: str) -> Key:
    from mwt.userdata import gemini_floor_endpoint

    return provider, gemini_floor_endpoint(base_url), model


def reset_memory() -> None:
    """Forget everything learned in this process, as a fresh process would."""
    with _state:
        _floors.clear()
        _accepted.clear()
        _probe_locks.clear()
        _loaded_roots.clear()


def _load_root(root: Path | None) -> None:
    if root is None:
        return
    name = str(root)
    with _state:
        if name in _loaded_roots:
            return
        _loaded_roots.add(name)
    from mwt.userdata import load_gemini_level_floors

    try:
        saved = load_gemini_level_floors(root)
    except OSError:
        saved = {}
    with _state:
        for key, level in saved.items():
            if key not in _floors or _rank(level) > _rank(_floors[key]):
                _floors[key] = level


def floor(key: Key, root: Path | None) -> str | None:
    _load_root(root)
    with _state:
        return _floors.get(key)


def needs_probe(key: Key, level: str) -> bool:
    """True while nothing says that this model takes ``level``, so one request must find out first."""
    with _state:
        if key in _floors:
            return False  # the level was raised to the floor already; nothing below it is ever sent
        accepted = _accepted.get(key)
        return accepted is None or _rank(level) < _rank(accepted)


def probe_lock(key: Key) -> threading.Lock:
    with _state:
        return _probe_locks.setdefault(key, threading.Lock())


def accepted(key: Key, level: str) -> None:
    with _state:
        known = _accepted.get(key)
        if known is None or _rank(level) < _rank(known):
            _accepted[key] = level


def learned(key: Key, base_url: str, level: str, root: Path | None) -> None:
    """The model refused a lower level and took ``level``: remember it here and on disk."""
    with _state:
        known = _floors.get(key)
        if known is not None and _rank(known) >= _rank(level):
            return
        _floors[key] = level
    if root is None:
        return
    from mwt.userdata import remember_gemini_level_floor

    try:
        remember_gemini_level_floor(key[0], base_url, key[2], level, root=root)
    except Exception:
        pass  # a file that cannot be written only costs the next job one refused request
