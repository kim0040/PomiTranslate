"""Settings and model catalogs live outside the app install.

An update replaces the program files. This directory stays until the user
deletes it. API keys are not written here.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import stat
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from mwt.durable import atomic_write_text

SCHEMA = 1
SECRET_FIELDS = {"api_key", "apikey", "secret", "token", "password", "authorization"}


def user_data_dir(root: Path | None = None) -> Path:
    if root is not None:
        path = Path(root)
    elif sys.platform == "darwin":
        path = Path.home() / "Library" / "Application Support" / "PomiTranslate"
    elif sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        path = Path(base) / "PomiTranslate"
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        path = Path(base) / "PomiTranslate"
    path.mkdir(parents=True, exist_ok=True)
    return path


def settings_path(root: Path | None = None) -> Path:
    return user_data_dir(root) / "settings.json"


def _backup_path(root: Path | None = None) -> Path:
    return user_data_dir(root) / "settings.backup.json"


def _read_settings_file(path: Path) -> dict | None:
    """The parsed document, or None when the file is missing, unreadable or not an object."""
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return loaded if isinstance(loaded, dict) else None


def _keep_damaged_copy(path: Path) -> None:
    """Leave a damaged settings file where a person can find it, instead of overwriting it later."""
    try:
        raw = path.read_bytes()
    except OSError:
        return
    digest = hashlib.sha256(raw).hexdigest()[:10]
    copy = path.with_name(f"settings.damaged-{digest}.json")
    if not copy.exists():
        try:
            copy.write_bytes(raw)
        except OSError:
            pass


def load_user_settings(root: Path | None = None) -> dict:
    """Saved preferences. A damaged or missing file falls back to the copy written with it."""
    path = settings_path(root)
    loaded = _read_settings_file(path) if path.exists() else None
    if loaded is None:
        if path.exists():
            _keep_damaged_copy(path)
        loaded = _read_settings_file(_backup_path(root)) if _backup_path(root).exists() else None
    if loaded is None:
        return {}
    return {key: value for key, value in loaded.items() if str(key).lower() not in SECRET_FIELDS}


def remember_user_settings(updates: dict, root: Path | None = None) -> dict:
    """Merge public preferences. Unknown keys already on disk are kept."""
    with _settings_lock(root):
        current = load_user_settings(root)
        for key, value in updates.items():
            if str(key).lower() in SECRET_FIELDS:
                continue
            current[key] = value
        current["schema"] = SCHEMA
        _write_user_settings(current, root)
        return current


@contextmanager
def _settings_lock(root: Path | None):
    """Serialize app/CLI read-modify-replace and compare-and-restore operations."""
    with (user_data_dir(root) / "settings.lock").open("a+b") as handle:
        if sys.platform == "win32":
            import msvcrt

            if handle.seek(0, os.SEEK_END) == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if sys.platform == "win32":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def durable_write_text(path: Path, text: str) -> None:
    """Replace a file so that a crash or power loss leaves either the old or the new content.

    The data reaches the disk before the rename, and the rename reaches the disk before return.
    """
    # The same primitive the backups use: fsync the file, replace it, flush the folder entry on
    # POSIX. Windows has no folder flush, and nothing stronger is claimed there.
    atomic_write_text(path, text, temporary=path.with_name(path.name + ".tmp"))


def _write_user_settings(current: dict, root: Path | None) -> None:
    text = json.dumps(current, ensure_ascii=False, indent=2)
    # The copy is written first and holds the same content, so a damaged main file loses nothing.
    durable_write_text(_backup_path(root), text)
    durable_write_text(settings_path(root), text)


def restore_user_settings(previous: dict, expected: dict, root: Path | None = None) -> dict:
    """Undo a desktop save only while the saved snapshot is still current.

    Replacing rather than merging removes preferences introduced by a failed first save.
    An external CLI change must never be overwritten by the desktop rollback.
    """
    if any(str(key).lower() in SECRET_FIELDS for key in previous):
        raise ValueError("Credential fields are not public settings")
    with _settings_lock(root):
        if load_user_settings(root) != expected:
            raise ValueError("Settings changed before recovery; reload the current preferences")
        _write_user_settings(previous, root)
        return load_user_settings(root)


def list_recent_worlds(root: Path | None = None) -> list[dict]:
    raw = load_user_settings(root).get("recent_worlds", [])
    if not isinstance(raw, list):
        return []
    result: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            continue
        try:
            path = str(Path(item["path"]).expanduser().resolve())
            opened = float(item.get("lastOpened") or 0)
        except (OSError, ValueError, TypeError, RuntimeError):
            continue  # a damaged entry is skipped, not fatal
        if path in seen:
            continue
        seen.add(path)
        result.append(
            {
                "path": path,
                "name": Path(path).name or path,
                "lastOpened": opened,
                "available": Path(path).is_dir(),
            }
        )
    return sorted(result, key=lambda item: item["lastOpened"], reverse=True)[:12]


def remember_recent_world(world: Path, root: Path | None = None) -> list[dict]:
    path = str(world.expanduser().resolve())
    existing = [item for item in list_recent_worlds(root) if item["path"] != path]
    updated = [{"path": path, "lastOpened": time.time()}]
    updated.extend({"path": item["path"], "lastOpened": item["lastOpened"]} for item in existing[:11])
    remember_user_settings({"recent_worlds": updated, "last_world_dir": path}, root)
    return list_recent_worlds(root)


def forget_recent_world(world: Path, root: Path | None = None) -> list[dict]:
    path = str(world.expanduser().resolve())
    remaining = [
        {"path": item["path"], "lastOpened": item["lastOpened"]}
        for item in list_recent_worlds(root)
        if item["path"] != path
    ]
    updates: dict = {"recent_worlds": remaining}
    if load_user_settings(root).get("last_world_dir") == path:
        updates["last_world_dir"] = ""
    remember_user_settings(updates, root)
    return list_recent_worlds(root)


def _catalog_path(provider: str, root: Path | None = None) -> Path:
    safe = "".join(character if character.isalnum() or character in {"-", "_"} else "_" for character in provider)
    return user_data_dir(root) / "models" / f"{safe}.json"


def remember_model_catalog(provider: str, models: list[dict], root: Path | None = None) -> None:
    path = _catalog_path(provider, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    # The catalog is what the provider published. Which model is chosen is not part of it: a mark that
    # one request put on a row would otherwise follow the row into the next request's list.
    plain = [{key: value for key, value in item.items() if key != "unsuitable_reason"} for item in models]
    document = {"schema": SCHEMA, "provider": provider, "models": plain}
    durable_write_text(path, json.dumps(document, ensure_ascii=False, indent=2))


def load_model_catalog(provider: str, root: Path | None = None) -> list[dict]:
    path = _catalog_path(provider, root)
    if not path.is_file():
        return []
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    models = loaded.get("models") if isinstance(loaded, dict) else None
    if not isinstance(models, list):
        return []
    return [item for item in models if isinstance(item, dict) and "api_key" not in item]


GEMINI_FLOOR_TTL_SECONDS = 30 * 24 * 3600
_GEMINI_FLOOR_LEVELS = ("minimal", "low", "medium", "high")
# A clock that jumped forward must not pin a floor for longer than the expiry promises.
_GEMINI_FLOOR_FUTURE_SLACK_SECONDS = 24 * 3600


def _gemini_floor_path(root: Path | None = None) -> Path:
    return user_data_dir(root) / "models" / "gemini-thinking-floors.json"


def gemini_floor_endpoint(base_url: str) -> str:
    """A short digest of the endpoint, so a proxy URL with a token in it never reaches the file."""
    return hashlib.sha256(str(base_url).rstrip("/").encode("utf-8")).hexdigest()[:16]


def _read_gemini_floors(path: Path) -> list[dict]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return []
    entries = loaded.get("floors") if isinstance(loaded, dict) else None
    return [item for item in entries if isinstance(item, dict)] if isinstance(entries, list) else []


def _live_gemini_floor(item: dict, now: float) -> tuple[tuple[str, str, str], str, float] | None:
    """((provider, endpoint, model), level, learned_at) of a usable entry, else None."""
    provider, endpoint, model, level = (item.get(key) for key in ("provider", "endpoint", "model", "level"))
    learned = item.get("learned_at")
    if not (isinstance(provider, str) and isinstance(endpoint, str) and isinstance(model, str)):
        return None
    if not (provider and endpoint and model) or level not in _GEMINI_FLOOR_LEVELS:
        return None
    if isinstance(learned, bool) or not isinstance(learned, (int, float)):
        return None
    try:
        stamp = float(learned)  # a JSON integer beyond the float range raises here
    except OverflowError:
        return None
    if not math.isfinite(stamp):  # NaN compares false with everything and would never expire
        return None
    age = now - stamp
    if age > GEMINI_FLOOR_TTL_SECONDS or age < -_GEMINI_FLOOR_FUTURE_SLACK_SECONDS:
        return None
    return (provider, endpoint, model), str(level), stamp


def load_gemini_level_floor_entries(
    root: Path | None = None, now: float | None = None
) -> dict[tuple[str, str, str], tuple[str, float]]:
    """(level, learned_at) per (provider, endpoint digest, model). Expired or damaged entries are skipped."""
    path = _gemini_floor_path(root)
    if not path.is_file():
        return {}
    moment = time.time() if now is None else now
    entries: dict[tuple[str, str, str], tuple[str, float]] = {}
    for item in _read_gemini_floors(path):
        live = _live_gemini_floor(item, moment)
        if live is not None:
            entries[live[0]] = (live[1], live[2])
    return entries


def load_gemini_level_floors(root: Path | None = None, now: float | None = None) -> dict[tuple[str, str, str], str]:
    """Lowest thinking level each (provider, endpoint digest, model) accepted. Expired or damaged entries are skipped."""
    return {key: level for key, (level, _) in load_gemini_level_floor_entries(root, now).items()}


def remember_gemini_level_floor(
    provider: str, base_url: str, model: str, level: str, root: Path | None = None, now: float | None = None
) -> None:
    """Keep the lowest thinking level a model accepted, so the next process does not ask for a refused one.

    Only the provider, a digest of the endpoint, the model, the level and the time are stored: no keys, no prompts.
    """
    if level not in _GEMINI_FLOOR_LEVELS:
        raise ValueError(f"Unknown thinking level: {level}")
    moment = time.time() if now is None else now
    key = (provider, gemini_floor_endpoint(base_url), model)
    with _settings_lock(root):
        path = _gemini_floor_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        kept = []
        for item in _read_gemini_floors(path) if path.is_file() else []:
            live = _live_gemini_floor(item, moment)
            if live is not None and live[0] != key:
                kept.append({"provider": live[0][0], "endpoint": live[0][1], "model": live[0][2], "level": live[1], "learned_at": live[2]})
        kept.append({"provider": key[0], "endpoint": key[1], "model": key[2], "level": level, "learned_at": moment})
        durable_write_text(path, json.dumps({"schema": SCHEMA, "floors": kept}, ensure_ascii=False, indent=2))


def public_settings_from_config(config: dict) -> dict:
    from mwt.desktop_settings import (
        DEFAULT_CONTINUE_ON_FILE_ERROR,
        DEFAULT_MAX_FILE_WRITE_RETRIES,
        normalize_continue_on_file_error,
        normalize_max_file_write_retries,
        normalize_resource_pack_options,
        normalize_source_overrides,
        normalized_options_from_core_scan,
    )

    from mwt.reasoning import normalize_reasoning
    api = config.get("api") or {}
    from mwt.desktop_resource_packs import normalize_external_pack_paths
    prompt = config.get("prompt") or {}
    scan = config.get("scan") or {}
    runtime = config.get("runtime") or {}
    resource_pack = config.get("resource_pack") or {}
    resource_pack_option_fields = (
        "source_lang_files",
        "target_lang_file",
        "skip_if_target_exists",
    )
    return {
        "provider": api.get("provider", ""),
        "model": api.get("model", ""),
        "base_url": api.get("base_url", ""),
        "wire_format": api.get("wire_format", ""),
        "openrouter_reasoning": normalize_reasoning(api.get("openrouter_reasoning", "default")),
        "target_language": prompt.get("target_language", ""),
        "style_preset": prompt.get("style_preset", ""),
        "style_prompt": prompt.get("style_prompt", ""),
        "custom_system_prompt": prompt.get("custom_system_prompt", ""),
        "temperature": config.get("temperature", ""),
        "batch_size": config.get("batch_size", ""),
        "request_timeout": api.get("request_timeout", ""),
        "rpm_limit": api.get("rpm_limit", ""),
        "tpm_limit": api.get("tpm_limit", ""),
        "max_batch_retries": runtime.get("max_batch_retries", ""),
        "concurrency": runtime.get("concurrency", ""),
        "continue_on_file_error": normalize_continue_on_file_error(
            runtime.get("continue_on_file_error", DEFAULT_CONTINUE_ON_FILE_ERROR),
            field="runtime.continue_on_file_error",
        ),
        "max_file_write_retries": normalize_max_file_write_retries(
            runtime.get("max_file_write_retries", DEFAULT_MAX_FILE_WRITE_RETRIES),
            field="runtime.max_file_write_retries",
        ),
        "resource_pack_enabled": resource_pack.get("enabled", False),
        "external_resource_pack_paths": normalize_external_pack_paths(resource_pack.get("external_zip_paths") or []),
        "resource_pack_options": normalize_resource_pack_options(
            {key: resource_pack[key] for key in resource_pack_option_fields if key in resource_pack}
        ),
        "skip_target_language_text": scan.get("skip_target_language_text", True),
        "scan_options": normalized_options_from_core_scan(scan),
        "source_overrides": normalize_source_overrides(
            scan.get("overrides", {}), field="scan.overrides"
        ),
        "last_world_dir": config.get("world_dir", ""),
    }


# --- app preferences and reset ------------------------------------------------------------------

APP_PREF_DEFAULTS: dict = {
    "theme": "system",
    "notice_accepted": False,
    "tutorial_seen": False,
    "setup_dismissed": False,
    "update_auto_check": True,
    "update_last_check": 0,
    "update_skipped_version": "",
    # An OS notification when a long scan or translation ends while the window is in the background.
    "notify_on_finish": True,
    # Text size in percent (100, 115 or 130), applied app-wide through a root CSS variable.
    "font_scale": 100,
}


def _valid_pref(key: str, value):
    if key == "theme":
        if not isinstance(value, str) or value not in {"system", "light", "dark"}:
            raise ValueError("theme must be system, light or dark")
        return value
    if key in {"notice_accepted", "tutorial_seen", "setup_dismissed", "update_auto_check", "notify_on_finish"}:
        if not isinstance(value, bool):
            raise ValueError(f"{key} must be true or false")
        return value
    if key == "font_scale":
        if isinstance(value, bool) or value not in (100, 115, 130):
            raise ValueError("font_scale must be 100, 115 or 130")
        return int(value)
    if key == "update_last_check":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
            raise ValueError("update_last_check must be a timestamp")
        return float(value)
    if key == "update_skipped_version":
        if not isinstance(value, str) or len(value) > 40:
            raise ValueError("update_skipped_version must be a short version string")
        return value
    raise ValueError(f"Unknown app preference: {key}")


LAST_JOBS_KEY = "last_jobs"
MAX_LAST_JOBS = 20
LAST_JOB_STATUSES = {"completed", "partial", "needs_retry", "failed", "cancelled", "budget_stopped"}


def _job_key(world: Path | str) -> str:
    return str(Path(world).expanduser().resolve())


def _count(value) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else 0


def remember_last_job(world: Path | str, report: dict, root: Path | None = None, *, now: float | None = None) -> dict | None:
    """Keep a short summary of the last translation of a world, so the start screen can show it.

    Only the time, the outcome and counts are kept: no text, no key, no report body. Older worlds fall
    off after MAX_LAST_JOBS.
    """
    import time

    status = str(report.get("status") or "")
    if status not in LAST_JOB_STATUSES:
        return None
    translation = report.get("translation") if isinstance(report.get("translation"), dict) else {}
    summary = {
        "at": float(now if now is not None else time.time()),
        "status": status,
        "translated": _count(translation.get("translated")),
        "failed": _count(translation.get("failed")),
        "changedFiles": _count(report.get("changed_file_count")),
        "candidateCount": _count(report.get("candidate_text_count")),
    }
    with _settings_lock(root):
        current = load_user_settings(root)
        jobs = current.get(LAST_JOBS_KEY)
        jobs = dict(jobs) if isinstance(jobs, dict) else {}
        jobs[_job_key(world)] = summary
        newest = sorted(jobs.items(), key=lambda item: float((item[1] or {}).get("at") or 0), reverse=True)
        current[LAST_JOBS_KEY] = dict(newest[:MAX_LAST_JOBS])
        current["schema"] = SCHEMA
        _write_user_settings(current, root)
    return summary


def load_last_job(world: Path | str, root: Path | None = None) -> dict | None:
    """The summary written by remember_last_job for this world, with its folder name added."""
    jobs = load_user_settings(root).get(LAST_JOBS_KEY)
    saved = jobs.get(_job_key(world)) if isinstance(jobs, dict) else None
    if not isinstance(saved, dict) or saved.get("status") not in LAST_JOB_STATUSES:
        return None
    return {
        "world": Path(_job_key(world)).name,
        "at": float(saved.get("at") or 0),
        "status": saved["status"],
        "translated": _count(saved.get("translated")),
        "failed": _count(saved.get("failed")),
        "changedFiles": _count(saved.get("changedFiles")),
        "candidateCount": _count(saved.get("candidateCount")),
    }


def load_app_prefs(root: Path | None = None) -> dict:
    """Window and onboarding state kept with the settings, so a cleared web cache cannot reset it."""
    saved = load_user_settings(root).get("app_prefs")
    prefs = dict(APP_PREF_DEFAULTS)
    if isinstance(saved, dict):
        for key, value in saved.items():
            try:
                prefs[key] = _valid_pref(str(key), value)
            except (ValueError, TypeError):
                continue
    return prefs


def remember_app_prefs(updates: dict, root: Path | None = None) -> dict:
    if not isinstance(updates, dict):
        raise ValueError("prefs must be an object")
    checked = {str(key): _valid_pref(str(key), value) for key, value in updates.items()}
    with _settings_lock(root):
        current = load_user_settings(root)
        merged = load_app_prefs(root)
        merged.update(checked)
        current["app_prefs"] = merged
        current["schema"] = SCHEMA
        _write_user_settings(current, root)
    return load_app_prefs(root)


# What a reset removes. Backups are never in this list: they are the only way back for a world.
RESET_FILES = ("settings.json", "settings.backup.json", "settings.json.tmp", "settings.backup.json.tmp", "world-glossaries.json", "world-glossaries.json.tmp")
# Review drafts hold manual translations, which are world text, so a reset removes them too.
RESET_DIRS = ("models", "scans", "jobs", "review-drafts", "glossary")


# IsReparseTagNameSurrogate: the reparse point names another place (symbolic links, junctions and
# similar). Other reparse points, such as cloud-file placeholders, hold their own content.
_NAME_SURROGATE = 0x20000000


def _is_link(path: Path) -> bool:
    """A symbolic link, a Windows junction or another reparse point that names another place.
    Path.is_symlink() does not see junctions."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT) and bool(
        getattr(info, "st_reparse_tag", 0) & _NAME_SURROGATE
    )


def _remove(path: Path) -> None:
    """Delete a file or a folder tree. A link at any depth is removed as a link and never followed
    (shutil.rmtree refuses a junction at the top and would leave the reset half done)."""
    if _is_link(path) or not path.is_dir():
        path.unlink()  # on Windows this also removes a directory link or junction
        return
    with os.scandir(path) as entries:
        children = [Path(entry.path) for entry in entries]
    for child in children:
        _remove(child)
    path.rmdir()


class ResetIncomplete(OSError):
    """Some of the reset items could not be removed; `left` names them (top-level names only)."""

    def __init__(self, left: list[str]) -> None:
        super().__init__(f"The reset could not remove: {', '.join(left)}")
        self.left = left


def reset_user_data(root: Path | None = None) -> dict:
    """Return the app to first launch: preferences, recent worlds, model lists and unfinished jobs.

    World backups and copies of damaged settings stay. A link found inside the folder, at any
    depth, is removed as a link and never followed. (The folder itself may be a link: the data then
    lives where it points, and that is where the reset works. A tree changed by another program
    while the reset runs is outside this promise.) An entry that cannot be removed does not stop
    the others; the reset then fails naming what is left.
    """
    base = user_data_dir(root)
    removed: list[str] = []
    failed: list[str] = []
    with _settings_lock(root):
        for name in RESET_FILES + RESET_DIRS:
            target = base / name
            present = _is_link(target) or (target.is_dir() if name in RESET_DIRS else target.is_file())
            if not present:
                continue
            try:
                _remove(target)
            except OSError:
                failed.append(name)
            else:
                removed.append(name)
    if failed:
        raise ResetIncomplete(failed)
    kept = [name for name in ("backups",) if (base / name).is_dir()]
    return {"removed": removed, "kept": kept}
