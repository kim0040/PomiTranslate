"""Validation and prompt helpers for fixed translation terms."""

from __future__ import annotations

import hashlib
import csv
import io
import json
import re
from typing import Any


MAX_GLOSSARY_ENTRIES = 2_000
MAX_SOURCE_LENGTH = 200
MAX_TARGET_LENGTH = 500
MAX_NOTE_LENGTH = 500
_FORMAT_CODE = re.compile(r"§[0-9a-fk-orx]", re.IGNORECASE)
_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]")
_LATIN = re.compile(r"[A-Za-z\u00c0-\u024f\u1e00-\u1eff]")
CSV_HEADER = ("source", "target", "mode", "note", "caseSensitive")


class GlossaryValidationError(ValueError):
    """A bad glossary with row-level feedback suitable for the editor."""

    def __init__(self, rows: list[dict[str, Any]], message: str = "Fix the highlighted glossary entries.") -> None:
        super().__init__(message)
        self.details = {"rows": rows}


def _source_conflicts(left: dict[str, Any], right: dict[str, Any]) -> bool:
    a, b = left["source"], right["source"]
    if a == b:
        return True
    return not left["caseSensitive"] or not right["caseSensitive"] if a.casefold() == b.casefold() else False


def normalize_entries(value: Any, *, field: str = "entries") -> list[dict[str, Any]]:
    """Validate and normalize entries while retaining every row's useful error."""
    if not isinstance(value, list):
        raise ValueError(f"{field} must be a list")
    errors: list[dict[str, Any]] = []
    normalized: list[dict[str, Any]] = []
    seen_sources: list[tuple[str, bool, int]] = []
    if len(value) > MAX_GLOSSARY_ENTRIES:
        errors.append({"index": MAX_GLOSSARY_ENTRIES, "message": f"A scope can contain at most {MAX_GLOSSARY_ENTRIES} entries."})

    for index, raw in enumerate(value[:MAX_GLOSSARY_ENTRIES]):
        row_errors: list[str] = []
        if not isinstance(raw, dict):
            errors.append({"index": index, "message": "Each entry must be an object."})
            continue
        source = raw.get("source")
        target = raw.get("target", "")
        mode = raw.get("mode", "translate")
        note = raw.get("note", "")
        case_sensitive = raw.get("caseSensitive", False)
        if not isinstance(source, str):
            row_errors.append("Source must be text.")
            source = ""
        source = source.strip()
        if not source:
            row_errors.append("Source cannot be empty.")
        if len(source) > MAX_SOURCE_LENGTH:
            row_errors.append(f"Source must be at most {MAX_SOURCE_LENGTH} characters.")
        if not isinstance(target, str):
            row_errors.append("Target must be text.")
            target = ""
        target = target.strip()
        if len(target) > MAX_TARGET_LENGTH:
            row_errors.append(f"Target must be at most {MAX_TARGET_LENGTH} characters.")
        if not isinstance(mode, str) or mode not in {"translate", "keep"}:
            row_errors.append("Mode must be translate or keep.")
        if mode == "translate" and not target:
            row_errors.append("A target is required when mode is translate.")
        if not isinstance(note, str):
            row_errors.append("Note must be text.")
            note = ""
        note = note.strip()
        if len(note) > MAX_NOTE_LENGTH:
            row_errors.append(f"Note must be at most {MAX_NOTE_LENGTH} characters.")
        if type(case_sensitive) is not bool:
            row_errors.append("caseSensitive must be true or false.")
            case_sensitive = False
        if _FORMAT_CODE.search(source) or _FORMAT_CODE.search(target):
            row_errors.append(
                "Minecraft formatting codes are not allowed in source or target; keep formatting codes in the original text so they stay protected."
            )
        entry = {
            "source": source,
            "target": target,
            "mode": mode,
            "note": note,
            "caseSensitive": case_sensitive,
        }
        duplicate_index = next((
            prior_index for prior_source, prior_case_sensitive, prior_index in seen_sources
            if source == prior_source or (
                source.casefold() == prior_source.casefold()
                and (not case_sensitive or not prior_case_sensitive)
            )
        ), None)
        if duplicate_index is not None:
            row_errors.append(f"Source duplicates entry {duplicate_index + 1}.")
        if source and len(source) <= MAX_SOURCE_LENGTH and type(case_sensitive) is bool:
            seen_sources.append((source, case_sensitive, index))
        if row_errors:
            errors.append({"index": index, "message": " ".join(row_errors)})
        else:
            normalized.append(entry)

    if errors:
        raise GlossaryValidationError(errors)
    return normalized


def merge_entries(global_entries: Any, world_entries: Any = None) -> list[dict[str, Any]]:
    """World entries replace matching global terms; the caller supplies validated scopes."""
    global_rows = normalize_entries(global_entries or [], field="global glossary")
    world_rows = normalize_entries(world_entries or [], field="world glossary")
    merged = list(global_rows)
    for world_entry in world_rows:
        merged = [entry for entry in merged if not _source_conflicts(entry, world_entry)]
        merged.append(world_entry)
    return merged


def contains_term(text: str, entry: dict[str, Any]) -> bool:
    """Match Latin terms at word boundaries and CJK terms as substrings."""
    source = str(entry.get("source") or "")
    if not source:
        return False
    case_sensitive = entry.get("caseSensitive") is True
    if _CJK.search(source) or not _LATIN.search(source):
        haystack, needle = (text, source) if case_sensitive else (text.casefold(), source.casefold())
        return needle in haystack
    pattern = re.compile(rf"(?<!\w){re.escape(source)}(?!\w)", 0 if case_sensitive else re.IGNORECASE)
    return pattern.search(text) is not None


def matching_entries(texts: list[str], entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only terms that occur in at least one source in a batch."""
    return [entry for entry in entries if any(contains_term(text, entry) for text in texts)]


def output_matches(source: str, answer: str, entries: list[dict[str, Any]]) -> bool:
    """Check every matched fixed translation or untranslated term in one answer."""
    for entry in entries:
        expected = entry["target"] if entry["mode"] == "translate" else entry["source"]
        if not expected:
            continue
        probe = {**entry, "source": expected}
        if not contains_term(answer, probe):
            return False
    return True


def prompt_block(entries: list[dict[str, Any]], *, reminder: bool = False) -> str:
    """Compact, delimited instructions; JSON quoting keeps user text inside the data block."""
    translating = [{"source": e["source"], "target": e["target"]} for e in entries if e["mode"] == "translate"]
    keeping = [e["source"] for e in entries if e["mode"] == "keep"]
    if not translating and not keeping:
        return ""
    lines = ["", "[FIXED GLOSSARY — BEGIN]"]
    if reminder:
        lines.append("Reminder: follow every glossary rule below exactly; these rules are mandatory.")
    if translating:
        lines.append("Use these fixed translations exactly (do not vary their spelling):")
        lines.append(json.dumps(translating, ensure_ascii=False, separators=(",", ":")))
    if keeping:
        lines.append("Keep these terms untranslated exactly as written:")
        lines.append(json.dumps(keeping, ensure_ascii=False, separators=(",", ":")))
    lines.append("[FIXED GLOSSARY — END]")
    return "\n".join(lines)


def entries_hash(entries: list[dict[str, Any]]) -> str:
    encoded = json.dumps(entries, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def export_json(entries: Any) -> str:
    return json.dumps(normalize_entries(entries), ensure_ascii=False, indent=2) + "\n"


def import_json(text: str) -> list[dict[str, Any]]:
    value = json.loads(text)
    if isinstance(value, dict):
        value = value.get("entries")
    return normalize_entries(value)


def export_csv(entries: Any) -> str:
    normalized = normalize_entries(entries)
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(CSV_HEADER)
    for entry in normalized:
        writer.writerow((entry["source"], entry["target"], entry["mode"], entry["note"], str(entry["caseSensitive"]).lower()))
    return "\ufeff" + stream.getvalue()


def import_csv(text: str) -> list[dict[str, Any]]:
    rows = list(csv.reader(io.StringIO(text.lstrip("\ufeff"), newline="")))
    if not rows or tuple(rows[0]) != CSV_HEADER:
        raise ValueError("CSV header must be source,target,mode,note,caseSensitive")
    entries: list[dict[str, Any]] = []
    for index, row in enumerate(rows[1:], start=2):
        if not row:
            continue
        if len(row) != len(CSV_HEADER) or row[4] not in {"true", "false"}:
            raise ValueError(f"CSV row {index} must have five columns and a true/false caseSensitive value")
        entries.append({
            "source": row[0],
            "target": row[1],
            "mode": row[2],
            "note": row[3],
            "caseSensitive": row[4] == "true",
        })
    return normalize_entries(entries)
