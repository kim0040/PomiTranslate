"""Reading a saved translation job for the desktop review screen.

A job is the checkpoint a translation run leaves for one scan plan. It holds what the AI answered
for every string, which strings failed and why, and the user's edits. These helpers turn it into
rows for the review table and check an edit before it can reach the world.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from mwt.tokens import _without_trailing_reset, preserve_tokens, tokens_preserved

# NBT stores a string with a 16-bit length; the core keeps the original instead of writing more.
MAX_EDIT_BYTES = 30_000
MAX_EDIT_CHARS = 32_000
STATES = {"all", "translated", "failed", "kept", "edited"}


def load_job(checkpoint_path: Path) -> dict[str, Any]:
    """The saved job, or an empty dict when there is none or it cannot be read."""
    try:
        loaded = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) and loaded.get("version") == 2 else {}


def edit_error(source: str, text: Any) -> str:
    """Why this edit cannot be written, as a stable code, or an empty string when it can.

    The core only warns when the AI breaks a format token and falls back to the original. A person
    who typed the text gets told instead, because nothing else will.
    """
    if not isinstance(text, str):
        return "invalid"
    cleaned = text.strip()
    if not cleaned:
        return "empty"
    if len(cleaned) > MAX_EDIT_CHARS or len(cleaned.encode("utf-8")) > MAX_EDIT_BYTES:
        return "too_long"
    if "\x00" in cleaned:
        return "invalid"
    # Use the exact same harmless trailing-reset normalization as AI output.
    normalized = _without_trailing_reset(source, cleaned)
    if not tokens_preserved(source, normalized):
        return "tokens"
    return ""


def clean_edits(
    raw: Any, source_by_id: dict[str, str]
) -> tuple[dict[str, str | None], list[dict[str, str]]]:
    """Edits keyed by source text, plus one readable problem per row that cannot be applied.

    A null value takes a row back to the AI's answer.
    """
    if raw is None:
        return {}, []
    if not isinstance(raw, dict):
        raise ValueError("edits must be an object")
    by_source: dict[str, str | None] = {}
    problems: list[dict[str, str]] = []
    for candidate_id, text in raw.items():
        if candidate_id not in source_by_id:
            raise ValueError("An edit is not part of this scan plan")
        if text is None:
            by_source[source_by_id[candidate_id]] = None
            continue
        code = edit_error(source_by_id[candidate_id], text)
        if code:
            problems.append({"id": candidate_id, "reason": code})
        else:
            by_source[source_by_id[candidate_id]] = preserve_tokens(source_by_id[candidate_id], text.strip())
    return by_source, problems


def _effective(
    source: str, job: dict[str, Any], overrides: dict[str, str]
) -> tuple[str, str, str, str, str]:
    """(status, shown translation, reason, detail, the AI's own answer) for one string."""
    cache: dict[str, str] = job.get("translation_cache") or {}
    failures: dict[str, Any] = job.get("failures") or {}
    edits: dict[str, str] = job.get("edits") or {}
    ai = cache.get(source, "") if isinstance(cache.get(source, ""), str) else ""
    if source in edits:
        return "edited", preserve_tokens(source, edits[source]), "", "", ai
    if source in overrides:
        return "edited", preserve_tokens(source, overrides[source]), "", "", ai
    if source in failures or source not in cache:
        info = failures.get(source) if isinstance(failures.get(source), dict) else None
        if info:
            return "failed", "", str(info.get("reason") or "unknown"), str(info.get("detail") or ""), ""
        # Never answered: the run stopped before this string was sent, or it was cut off.
        return "failed", "", "unknown", "Not translated yet.", ""
    shown = preserve_tokens(source, ai)
    if ai and not tokens_preserved(source, _without_trailing_reset(source, ai)):
        # The AI's answer lost or added a format code, so the original was kept.
        return "kept", source, "invalid_response", "format tokens differ from the original", ai
    if shown == source:
        return "kept", source, "", "", ai
    return "translated", shown, "", "", ai


def _excluded_ids(job: dict[str, Any]) -> set[str]:
    resume = job.get("resume") or {}
    return {str(item) for item in resume.get("excluded_candidate_ids") or []}


def _manual_by_source(job: dict[str, Any], saved_overrides: dict[str, str]) -> dict[str, str]:
    resume = job.get("resume") or {}
    manual = {**saved_overrides, **{k: v for k, v in (resume.get("manual_overrides") or {}).items() if isinstance(v, str)}}
    return manual


def job_rows(plan: dict[str, Any], job: dict[str, Any], saved_overrides: dict[str, str]) -> list[dict[str, Any]]:
    """Every string of the job, in scan order, with what would be written for it."""
    excluded = _excluded_ids(job)
    manual = _manual_by_source(job, saved_overrides)
    rows: list[dict[str, Any]] = []
    for item in plan.get("candidates", []):
        if not isinstance(item, dict) or str(item.get("id")) in excluded:
            continue
        source = str(item.get("source") or "")
        status, shown, reason, detail, ai = _effective(source, job, manual)
        row = {
            "id": str(item.get("id")),
            "source": source,
            "translated": shown,
            "status": status,
            "kind": str(item.get("kind") or "other"),
            "occurrences": int(item.get("occurrences") or 1),
            "ai": ai,
        }
        if reason:
            row["reason"] = reason
            row["detail"] = detail
        rows.append(row)
    return rows


def failed_sources(plan: dict[str, Any], job: dict[str, Any], saved_overrides: dict[str, str]) -> list[str]:
    """The strings a retry would send: failed or never answered, and not written by hand."""
    return [row["source"] for row in job_rows(plan, job, saved_overrides) if row["status"] == "failed"]


def translations_page(
    plan: dict[str, Any], job: dict[str, Any], saved_overrides: dict[str, str], body: dict[str, Any]
) -> dict[str, Any]:
    """Filter and slice the job on this side so the count and the rows always agree."""
    rows = job_rows(plan, job, saved_overrides)
    draft_ids = {str(item) for item in body.get("draftIds") or []}
    for row in rows:
        if row["id"] in draft_ids:
            row["status"] = "edited"
    counts = {"all": len(rows)}
    for name in ("translated", "failed", "kept", "edited"):
        counts[name] = sum(1 for row in rows if row["status"] == name)
    state = str(body.get("state") or "all")
    if state not in STATES:
        raise ValueError("Unknown translation state filter")
    if state != "all":
        rows = [row for row in rows if row["status"] == state]
    query = str(body.get("query") or "").strip().casefold()
    if query:
        rows = [
            row
            for row in rows
            if query in row["source"].casefold() or query in row["translated"].casefold()
        ]
    offset = max(0, int(body.get("offset") or 0))
    limit = min(500, max(1, int(body.get("limit") or 100)))
    return {
        "rows": rows[offset : offset + limit],
        "offset": offset,
        "total": len(rows),
        "hasMore": offset + limit < len(rows),
        "counts": counts,
    }


def normalize_review_before_apply(value: Any, *, field: str = "reviewBeforeApply") -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{field} must be true or false")
    return value


MAX_COST_USD_LIMIT = 1000.0


def normalize_max_cost_usd(value: Any, *, field: str = "maxCostUsd") -> float:
    """The spending cap in US dollars, 0 meaning no cap."""
    if value is None or value == "":
        return 0.0
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a number") from exc
    if not 0 <= number <= MAX_COST_USD_LIMIT:  # also false for NaN
        raise ValueError(f"{field} must be between 0 and {MAX_COST_USD_LIMIT:g}")
    return round(number, 4)
