"""Review work that survives a restart: excluded candidates and hand-typed translations.

One small JSON file per scan plan under ``<data_dir>/review-drafts/``. A draft is only useful
while the scan plan it belongs to still exists, so reading a draft whose plan file is gone
deletes it. Nothing here touches a world or a backup, and every path is built from a validated
64-hex scan plan ID, never from request text.

Input shape problems raise ``ValueError`` like the rest of the desktop request handling. Limits
and a missing plan raise ``ReviewDraftError`` with a code the UI can show.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

from mwt.durable import atomic_write_text, mkdir_durable

DRAFT_VERSION = 1
CANDIDATE_ID = re.compile(r"[0-9a-f]{20}")
SCAN_PLAN_ID = re.compile(r"[0-9a-f]{64}")
MAX_OVERRIDE_CHARS = 32_000
MAX_EXCLUDED = 200_000
MAX_OVERRIDES = 20_000
MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
DAMAGED_KEEP_SECONDS = 30 * 24 * 3600
TEMP_KEEP_SECONDS = 24 * 3600

ERROR_CODES = ("PLAN_NOT_FOUND", "DRAFT_TOO_LARGE", "DRAFT_WRITE_FAILED")


class ReviewDraftError(RuntimeError):
    recoverable = True

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _drafts_dir(data_dir: Path) -> Path:
    return Path(data_dir) / "review-drafts"


def _plan_id(payload: dict) -> str:
    if not isinstance(payload, dict):
        raise ValueError("Request payload must be an object")
    value = payload.get("scanPlanId")
    if not isinstance(value, str) or not SCAN_PLAN_ID.fullmatch(value):
        raise ValueError("Invalid scan plan ID")
    return value


def _draft_path(data_dir: Path, plan_id: str) -> Path:
    return _drafts_dir(data_dir) / f"{plan_id}.json"


def _plan_exists(data_dir: Path, plan_id: str) -> bool:
    return (Path(data_dir) / "scans" / f"{plan_id}.json").is_file()


def _empty(plan_id: str) -> dict:
    return {"scanPlanId": plan_id, "exists": False, "savedAt": 0, "excludedCandidateIds": [], "candidateOverrides": {}}


def _keep_damaged_copy(path: Path) -> None:
    """Move an unreadable draft aside, best effort, so it is neither lost nor re-read forever."""
    try:
        path.replace(path.with_name(f"{path.name}.damaged-{int(time.time())}"))
    except OSError:
        pass


def _parsed_document(raw: object, plan_id: str) -> dict | None:
    """The document when it is well formed, else None. Only the shape is checked here."""
    if not isinstance(raw, dict) or raw.get("scanPlanId") != plan_id:
        return None
    excluded = raw.get("excludedCandidateIds")
    overrides = raw.get("candidateOverrides")
    saved_at = raw.get("savedAt")
    if (
        not isinstance(excluded, list)
        or not isinstance(overrides, dict)
        or isinstance(saved_at, bool)
        or not isinstance(saved_at, (int, float))
    ):
        return None
    if not all(isinstance(item, str) and CANDIDATE_ID.fullmatch(item) for item in excluded):
        return None
    if not all(
        isinstance(key, str) and CANDIDATE_ID.fullmatch(key) and isinstance(value, str)
        for key, value in overrides.items()
    ):
        return None
    return raw


def get_draft(payload: dict, data_dir: Path) -> dict:
    plan_id = _plan_id(payload)
    path = _draft_path(data_dir, plan_id)
    if not _plan_exists(data_dir, plan_id):
        try:
            path.unlink(missing_ok=True)  # the plan it belonged to is gone
        except OSError:
            pass
        return _empty(plan_id)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return _empty(plan_id)
    except UnicodeDecodeError:
        _keep_damaged_copy(path)
        return _empty(plan_id)
    except OSError:
        return _empty(plan_id)
    try:
        raw = json.loads(text)
    except ValueError:
        _keep_damaged_copy(path)
        return _empty(plan_id)
    if isinstance(raw, dict) and raw.get("version") != DRAFT_VERSION:
        return _empty(plan_id)  # written by another version: left in place, not interpreted
    document = _parsed_document(raw, plan_id)
    if document is None:
        _keep_damaged_copy(path)
        return _empty(plan_id)
    return {
        "scanPlanId": plan_id,
        "exists": True,
        "savedAt": float(document["savedAt"]),
        "excludedCandidateIds": list(document["excludedCandidateIds"]),
        "candidateOverrides": dict(document["candidateOverrides"]),
    }


def _normalized_excluded(value: object) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("excludedCandidateIds must be a list")
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str) or not CANDIDATE_ID.fullmatch(item):
            raise ValueError("Invalid candidate ID")
        seen.add(item)
    return sorted(seen)


def _normalized_overrides(value: object) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("candidateOverrides must be an object")
    result: dict[str, str] = {}
    for key, text in value.items():
        if not isinstance(key, str) or not CANDIDATE_ID.fullmatch(key):
            raise ValueError("Invalid candidate ID")
        if not isinstance(text, str):
            raise ValueError("A manual translation must be text")
        stripped = text.strip()
        if len(stripped) > MAX_OVERRIDE_CHARS:
            raise ValueError(f"A manual translation is longer than {MAX_OVERRIDE_CHARS} characters")
        if stripped:
            result[key] = stripped  # whitespace-only entries mean "no translation"
    return dict(sorted(result.items()))


def set_draft(payload: dict, data_dir: Path) -> dict:
    plan_id = _plan_id(payload)
    excluded = _normalized_excluded(payload.get("excludedCandidateIds"))
    overrides = _normalized_overrides(payload.get("candidateOverrides"))
    if not _plan_exists(data_dir, plan_id):
        raise ReviewDraftError("PLAN_NOT_FOUND", "The scan this review belongs to no longer exists. Scan again.")
    if len(excluded) > MAX_EXCLUDED or len(overrides) > MAX_OVERRIDES:
        raise ReviewDraftError("DRAFT_TOO_LARGE", "There is too much review work to save as a draft.")
    path = _draft_path(data_dir, plan_id)
    if not excluded and not overrides:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            raise ReviewDraftError("DRAFT_WRITE_FAILED", f"The review draft could not be removed: {exc.strerror or exc}") from exc
        return {"saved": False, "savedAt": 0.0, "excludedCount": 0, "overrideCount": 0}
    saved_at = time.time()
    document = {
        "version": DRAFT_VERSION,
        "scanPlanId": plan_id,
        "savedAt": saved_at,
        "excludedCandidateIds": excluded,
        "candidateOverrides": overrides,
    }
    try:
        text = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ValueError("A manual translation contains characters that cannot be saved") from exc
    if size > MAX_DOCUMENT_BYTES:
        raise ReviewDraftError("DRAFT_TOO_LARGE", "There is too much review work to save as a draft.")
    try:
        mkdir_durable(path.parent)
        atomic_write_text(path, text)
    except OSError as exc:
        raise ReviewDraftError("DRAFT_WRITE_FAILED", f"The review draft could not be saved: {exc.strerror or exc}") from exc
    return {"saved": True, "savedAt": saved_at, "excludedCount": len(excluded), "overrideCount": len(overrides)}


def clear_draft(payload: dict, data_dir: Path) -> dict:
    plan_id = _plan_id(payload)
    path = _draft_path(data_dir, plan_id)
    existed = path.is_file()
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        raise ReviewDraftError("DRAFT_WRITE_FAILED", f"The review draft could not be removed: {exc.strerror or exc}") from exc
    return {"cleared": existed}


def prune_drafts(data_dir: Path, keep: int = 200) -> int:
    """Drop drafts whose scan plan is gone, then the oldest beyond ``keep``. Never raises.

    Also sweeps damaged-draft copies older than 30 days and leftover temp files older than a day.
    Returns how many drafts were removed.
    """
    removed = 0
    directory = _drafts_dir(data_dir)
    now = time.time()
    try:
        entries = list(directory.iterdir())
    except OSError:
        return 0
    live: list[tuple[float, Path]] = []
    for entry in entries:
        try:
            name = entry.name
            if entry.is_symlink() or not entry.is_file():
                continue
            if re.fullmatch(r"[0-9a-f]{64}\.json", name):
                if not _plan_exists(data_dir, name[:-5]):
                    entry.unlink(missing_ok=True)
                    removed += 1
                else:
                    live.append((entry.stat().st_mtime, entry))
            elif re.fullmatch(r"[0-9a-f]{64}\.json\.damaged-\d+", name):
                if now - entry.stat().st_mtime > DAMAGED_KEEP_SECONDS:
                    entry.unlink(missing_ok=True)
            elif name.startswith(".") and name.endswith(".tmp"):
                if now - entry.stat().st_mtime > TEMP_KEEP_SECONDS:
                    entry.unlink(missing_ok=True)
        except OSError:
            continue
    live.sort(key=lambda item: (item[0], item[1].name), reverse=True)
    for _, entry in live[max(0, int(keep)):]:
        try:
            entry.unlink(missing_ok=True)
            removed += 1
        except OSError:
            continue
    return removed
