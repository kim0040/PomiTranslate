"""Desktop/sidecar entry. Production speaks JSONL and does not open a localhost port."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
from pathlib import Path

from mwt.extract import CATEGORIES, EXTRACTOR_VERSION
from mwt.reasoning import normalize_reasoning
from mwt.desktop_settings import (
    DEFAULT_CONTINUE_ON_FILE_ERROR,
    DEFAULT_MAX_FILE_WRITE_RETRIES,
    normalize_continue_on_file_error,
    normalize_max_file_write_retries,
    normalize_resource_pack_options,
    normalize_scan_options,
    normalize_source_overrides,
)
from mwt.desktop_review import clean_edits, normalize_max_cost_usd, normalize_review_before_apply
from mwt.notices import ABOUT, FIRST_LAUNCH, PRE_TRANSLATE, payload
from mwt.safety import BackupSet, ExternalTargetError, backup_store, legacy_backup_store, list_backup_sets
from mwt.desktop_resource_packs import ExternalPackUnavailable, normalize_external_pack_paths, pack_scope_signature, selected_pack_files


# A job stopped by the user, by an outage, or by a provider error keeps its translated strings
# in the checkpoint. Only these states may be continued.
RESUMABLE_STATUSES = {"cancelled", "needs_retry", "failed", "awaiting_review", "budget_stopped"}

# A model that thinks bills its reasoning as output. The provider does not report it before the
# call, and one real run cost twice the old upper bound, so the upper bound counts the answer
# twice (the answer plus an equal amount of reasoning) when reasoning is on or cannot be ruled out.
REASONING_OUTPUT_FACTOR = 2


def _effective_glossary(data_dir: Path, world: Path | str | None = None) -> list[dict]:
    from mwt.glossary import merge_entries, normalize_entries
    from mwt.userdata import load_world_glossary

    try:
        global_glossary = normalize_entries(_saved(data_dir).get("glossary", []), field="saved glossary")
    except ValueError:
        global_glossary = []
    world_glossary = load_world_glossary(world, data_dir) if world is not None else []
    return merge_entries(global_glossary, world_glossary)


def _settings_fingerprint(data_dir: Path, world: Path | str | None = None) -> str:
    saved = _saved(data_dir)
    from mwt.glossary import entries_hash
    glossary = _effective_glossary(data_dir, world)
    relevant = {
        key: saved.get(key, "")
        for key in (
            "provider",
            "model",
            "base_url",
            "wire_format",
            "target_language",
            "style_preset",
            "style_prompt",
            "custom_system_prompt",
            "temperature",
            "batch_size",
            "request_timeout",
            "rpm_limit",
            "tpm_limit",
            "max_batch_retries",
            "resource_pack_enabled",
        )
    }
    relevant.update(
        {
            "glossary_hash": entries_hash(glossary),
            "source_overrides": normalize_source_overrides(
                saved.get("source_overrides", {}), field="saved source_overrides"
            ),
            "continue_on_file_error": normalize_continue_on_file_error(
                saved.get("continue_on_file_error", DEFAULT_CONTINUE_ON_FILE_ERROR),
                field="saved continue_on_file_error",
            ),
            "max_file_write_retries": normalize_max_file_write_retries(
                saved.get("max_file_write_retries", DEFAULT_MAX_FILE_WRITE_RETRIES),
                field="saved max_file_write_retries",
            ),
            "resource_pack_options": normalize_resource_pack_options(
                saved=saved.get("resource_pack_options")
            ),
        }
    )
    reasoning = normalize_reasoning(saved.get("openrouter_reasoning", "default"))
    if reasoning != "default":
        relevant["openrouter_reasoning"] = reasoning
    external_paths = normalize_external_pack_paths(saved.get("external_resource_pack_paths", []))
    if external_paths:
        relevant["external_resource_pack_paths"] = external_paths
    encoded = json.dumps(relevant, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _scan_scope_fingerprint(data_dir: Path, *, original_external: dict | None = None) -> str:
    """What decides which texts a scan finds. Provider, model and prompt settings do not, so
    changing them does not throw a reviewed scan away."""
    saved = _saved(data_dir)
    scan_options = normalize_scan_options(saved=saved.get("scan_options"))
    resource_pack_options = normalize_resource_pack_options(
        saved=saved.get("resource_pack_options")
    )
    relevant = {
        "target_language": str(saved.get("target_language") or "한국어"),
        "resource_pack_enabled": bool(saved.get("resource_pack_enabled")),
        "resource_pack_options": resource_pack_options,
        "skip_target_language_text": saved.get("skip_target_language_text", True) is not False,
        "scan_options": scan_options,
        "extractor": EXTRACTOR_VERSION,
    }
    external_scope = pack_scope_signature(saved)
    # Reapply validates the applied ZIP's bytes separately, then compares settings and parent
    # identity against the original scan. Our own ZIP write must not invalidate that scan.
    for entry in external_scope:
        original = (original_external or {}).get(entry["path"])
        if isinstance(original, dict) and "sha256" in entry:
            entry["sha256"] = original["sha256"]
    if external_scope:
        relevant["external_resource_packs"] = external_scope
    encoded = json.dumps(relevant, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _scan_plan_id(world_fingerprint: str, scope_fingerprint: str) -> str:
    return hashlib.sha256(f"scan-v2:{world_fingerprint}:{scope_fingerprint}".encode("utf-8")).hexdigest()


def _backup_stores(world: Path, data_dir: Path) -> list[Path]:
    """The app store first, then the folder inside the world where earlier releases put backups."""
    return [backup_store(world, data_dir), legacy_backup_store(world)]


def _scan_plan_path(data_dir: Path, scan_plan_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{64}", scan_plan_id):
        raise ValueError("Invalid scan plan ID")
    return data_dir / "scans" / f"{scan_plan_id}.json"


def _world_identity(world: Path) -> str:
    """A stable, non-reversible local identity for associating saved scan plans with a folder."""
    normalized = os.path.normcase(str(world.expanduser().resolve()))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _last_scan_summary(data_dir: Path, world: Path | None) -> dict | None:
    """Return the newest completed scan saved for this world, independent of translation history."""
    if world is None:
        return None
    scans = data_dir / "scans"
    if not scans.is_dir():
        return None
    identity = _world_identity(world)
    latest: dict | None = None
    for path in scans.glob("*.summary.json"):
        try:
            plan = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(plan, dict) or plan.get("worldIdentity") != identity:
                continue
            created_at = float(plan.get("createdAt") or 0)
            at = int(created_at)
            candidate_count = int(plan.get("candidateCount"))
            if created_at <= 0 or candidate_count < 0:
                continue
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
        if latest is None or created_at > latest["createdAt"]:
            latest = {"at": at, "candidateCount": candidate_count, "createdAt": created_at}
    if latest is not None:
        latest.pop("createdAt")
    return latest


def _checkpoint_path(data_dir: Path, scan_plan_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{64}", scan_plan_id):
        raise ValueError("Invalid scan plan ID")
    return data_dir / "jobs" / f"{scan_plan_id}.checkpoint.json"


def _reapply_path(data_dir: Path, scan_plan_id: str) -> Path:
    return _checkpoint_path(data_dir, scan_plan_id).with_suffix(".reapply.json")


def _durable_json(path: Path, value: dict) -> None:
    """Atomic replacement, with file and directory flush before a world mutation."""
    import tempfile

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(raw)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def _reapply_journal(data_dir: Path, scan_plan_id: str) -> dict:
    path = _reapply_path(data_dir, scan_plan_id)
    if not path.is_file():
        return {}
    # A broken journal must fail closed, rather than reveal an obsolete applied checkpoint.
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("job"), dict):
        raise ValueError("Invalid reapply recovery journal")
    return value if value.get("phase") != "completed" else {}


def _interrupted_job(journal: dict) -> dict:
    job = {**journal["job"], "edits": dict(journal.get("edits", journal["job"].get("edits")) or {})}
    job["resume"] = {**(job.get("resume") or {}), "excluded_candidate_ids": journal.get(
        "excludedCandidateIds", (job.get("resume") or {}).get("excluded_candidate_ids", []))}
    job["applied"] = None  # The previous applied fingerprint no longer describes this world.
    job["report"] = {**(job.get("report") or {}), "status": "reapply_interrupted"}
    job["reapply"] = {key: journal.get(key) for key in (
        "recoverySetId", "backupSetId", "restoredWorldFingerprint", "restoredExternalFingerprints", "originalApplied",
    )}
    job["saved_at"] = journal.get("savedAt") or job.get("saved_at") or 0
    return job


def _request_estimate(candidate_count: int, batch_size: int) -> int:
    """Initial translation batches, before glossary reminders or provider-error retries."""
    return -(-int(candidate_count) // max(1, int(batch_size))) if candidate_count else 0


def _model_price(saved: dict, data_dir: Path) -> dict | None:
    """Prefer published per-token prices, then use a saved user price for this provider/model."""
    from mwt.userdata import load_model_catalog

    from mwt.desktop_settings import normalize_custom_prices

    provider = str(saved.get("provider") or "")
    model = str(saved.get("model") or "")
    if not provider or not model:
        return None
    for item in load_model_catalog(provider, root=data_dir):
        if item.get("id") != model:
            continue
        try:
            prompt = float(item.get("pricing_prompt"))
            completion = float(item.get("pricing_completion"))
        except (TypeError, ValueError):
            break
        if not math.isfinite(prompt) or not math.isfinite(completion) or prompt < 0 or completion < 0:
            break
        return {"input": prompt, "output": completion, "perMillionInput": prompt * 1e6, "perMillionOutput": completion * 1e6, "source": "catalog"}
    try:
        custom = normalize_custom_prices(saved.get("custom_prices", {}), field="saved custom_prices").get(f"{provider}/{model}")
    except ValueError:
        custom = None
    if custom:
        return {
            "input": custom["input"] / 1_000_000,
            "output": custom["output"] / 1_000_000,
            "perMillionInput": custom["input"],
            "perMillionOutput": custom["output"],
            "source": "user",
        }
    return None


def _reasoning_may_bill(saved: dict, data_dir: Path) -> bool:
    """True unless the user turned reasoning off or the model's catalog entry says it never thinks."""
    from mwt.userdata import load_model_catalog

    try:
        choice = normalize_reasoning(saved.get("openrouter_reasoning", "default"))
    except ValueError:
        choice = "default"
    provider, model = str(saved.get("provider") or ""), str(saved.get("model") or "")
    for item in load_model_catalog(provider, root=data_dir) if provider and model else []:
        if item.get("id") != model:
            continue
        meta = item.get("reasoning")
        if isinstance(meta, dict) and meta.get("mandatory"):
            return True
        if choice == "disabled":
            return False
        if choice != "default":
            return True
        if isinstance(meta, dict):
            return bool(meta.get("mandatory") or meta.get("default_enabled") is not False)
        parameters = item.get("supported_parameters")
        return "reasoning" in parameters if isinstance(parameters, list) else True
    return choice != "disabled"  # Unknown model: assume it may think unless disabled.


def _estimate(records: list[dict], saved: dict, data_dir: Path, *, glossary: list[dict] | None = None) -> dict:
    """Estimate selected batches plus up to one glossary reminder per matched source.

    Tokens use the existing character heuristic, including the real selected glossary blocks.
    The high band allows every matched row's reminder and possible reasoning, then doubles
    list cost for ordinary estimation uncertainty. Provider-error retries are not bounded here.
    """
    from mwt.glossary import matching_entries, normalize_entries, prompt_block

    if glossary is None:
        glossary = normalize_entries(saved.get("glossary") or [], field="saved glossary")
    source_overrides = normalize_source_overrides(
        saved.get("source_overrides", {}), field="saved source_overrides"
    )
    translatable = [
        record
        for record in records
        if str(record.get("source") or "") not in source_overrides
    ]
    count = len(translatable)
    chars = sum(len(str(record.get("source") or "")) for record in translatable)
    batch_size = max(1, int(saved.get("batch_size") or 40))
    requests = _request_estimate(count, batch_size)
    texts = [str(record.get("source") or "") for record in translatable]
    glossary_chars = sum(len(prompt_block(matching_entries(texts[start:start + batch_size], glossary)))
                         for start in range(0, count, batch_size))
    matched_texts = [(text, matching_entries([text], glossary)) for text in texts]
    reminder_texts = [(text, matched) for text, matched in matched_texts if matched]
    reminder_requests = len(reminder_texts)
    reminder_chars = sum(len(text) for text, _ in reminder_texts)
    reminder_prompt_chars = sum(len(prompt_block(matched, reminder=True)) for _, matched in reminder_texts)
    input_tokens = requests * 450 + math.ceil(count * 4 + (chars + glossary_chars) / 3.2)
    # Fixed spellings may be much longer than the source terms. Include that known output
    # expansion instead of pricing a 500-character target as a short source word.
    def output_chars(text: str, matched: list[dict]) -> int:
        return max(len(text), sum(len(e["target"] if e["mode"] == "translate" else e["source"]) for e in matched))

    output_size = sum(output_chars(text, matched) for text, matched in matched_texts)
    output_tokens = math.ceil(count * 5 + output_size * 0.85)
    input_tokens_high = input_tokens + reminder_requests * 450 + math.ceil(
        reminder_requests * 4 + (reminder_chars + reminder_prompt_chars) / 3.2)
    output_tokens_high = output_tokens + math.ceil(reminder_requests * 5 + sum(
        output_chars(text, matched) for text, matched in reminder_texts) * 0.85)
    price = _model_price(saved, data_dir)
    cost = None
    reasoning = _reasoning_may_bill(saved, data_dir)
    if price and count:
        low = input_tokens * price["input"] + output_tokens * price["output"]
        factor = REASONING_OUTPUT_FACTOR if reasoning else 1
        cost = {"low": low, "high": (input_tokens_high * price["input"] + output_tokens_high * factor * price["output"]) * 2}
    return {
        "candidateCount": count,
        "requests": requests,
        "requestRange": {"low": requests, "high": requests + reminder_requests},
        "glossaryRetryRequests": reminder_requests,
        "glossaryPromptChars": glossary_chars,
        "sourceChars": chars,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "inputTokensHigh": input_tokens_high,
        "outputTokensHigh": output_tokens_high,
        "price": price,
        "priceSource": price.get("source") if price else None,
        "cost": cost,
        "reasoningIncluded": reasoning,
    }


def _format_location(location: dict) -> str:
    holder = str(location.get("holder") or "").removeprefix("minecraft:")
    pos = location.get("pos")
    if holder and pos:
        return f"{holder} ({pos[0]}, {pos[1]}, {pos[2]})"
    chunk = location.get("chunk")
    if holder:
        return holder
    return f"chunk ({chunk[0]}, {chunk[1]})" if chunk else ""


def _candidate_record(source: str, stats: dict | None = None) -> dict:
    stats = stats or {}
    kinds = dict(stats.get("kinds") or {})
    order = {name: index for index, name in enumerate(CATEGORIES)}
    kind = max(kinds, key=lambda name: (kinds[name], -order.get(name, len(order)))) if kinds else "other"
    locations = list(stats.get("locations") or [])
    return {
        "id": hashlib.sha256(source.encode("utf-8")).hexdigest()[:20],
        "source": source,
        "kind": kind,
        "kinds": kinds,
        "occurrences": int(stats.get("count") or 1),
        "locations": locations,
        "location": _format_location(locations[0]) if locations else "",
    }


def _level_data_version(level_path: Path) -> int | None:
    try:
        import gzip

        from mwt import nbtio

        document = nbtio.parse(gzip.decompress(level_path.read_bytes()), keep_scalars="all")
        data = document.get("Data")
        node = data if isinstance(data, dict) else document
        value = node.get("DataVersion")
        return int(value.value) if value is not None else None
    except (OSError, ValueError, TypeError, EOFError):
        return None


def _world_inspection(world: Path, *, recursive_blockers: bool = True) -> dict:
    import os

    from mwt.layout import detect_write_blockers, discover_region_dirs
    from mwt.locking import world_is_in_use

    root = world.expanduser().resolve()
    if not root.is_dir():
        return {"validJavaWorld": False, "kind": "missing", "writeBlockers": ["missing"]}
    if not os.access(root, os.R_OK):
        return {"validJavaWorld": False, "kind": "unknown", "writeBlockers": ["not_readable"]}
    root_world = (root / "level.dat").is_file()
    try:
        child_worlds = sorted(
            child.name for child in root.iterdir() if child.is_dir() and (child / "level.dat").is_file()
        )
    except OSError:
        return {"validJavaWorld": False, "kind": "unknown", "writeBlockers": ["not_readable"]}
    blockers = detect_write_blockers(root, recursive=recursive_blockers)
    if world_is_in_use(root):
        blockers.append("world_in_use")
    if not os.access(root, os.R_OK | os.W_OK):
        blockers.append("not_writable")
    valid = bool(root_world or child_worlds) and "bedrock" not in blockers
    resource_packs = []
    if root_world and (root / "resources.zip").is_file() and not (root / "resources.zip").is_symlink():
        resource_packs.append(str(root / "resources.zip"))
    for child_name in child_worlds:
        resource_pack = root / child_name / "resources.zip"
        if resource_pack.is_file() and not resource_pack.is_symlink() and resource_pack.resolve().is_relative_to(root):
            resource_packs.append(str(resource_pack))
    world_roots = [root] if root_world else [root / name for name in child_worlds]
    data_versions = [
        {
            "world": item.name or item.as_posix(),
            "dataVersion": _level_data_version(item / "level.dat") if (item / "level.dat").resolve().is_relative_to(root) else None,
        }
        for item in world_roots
    ]
    return {
        "validJavaWorld": valid,
        "kind": "java_world" if root_world else "server_root" if child_worlds else "unknown",
        "childWorlds": child_worlds,
        "regionDirs": discover_region_dirs(root),
        "resourcePacks": resource_packs,
        "dataVersions": data_versions,
        "writeBlockers": blockers,
    }


def _save_scan_plan(
    data_dir: Path,
    scan_plan_id: str,
    *,
    world_fingerprint: str,
    scope_fingerprint: str,
    candidates: list[dict],
    world_dir: Path | None = None,
    external_pack_fingerprints: dict | None = None,
) -> None:
    path = _scan_plan_path(data_dir, scan_plan_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {
        "version": 2,
        "scanPlanId": scan_plan_id,
        "worldFingerprint": world_fingerprint,
        "scopeFingerprint": scope_fingerprint,
        "createdAt": time.time(),
        "candidateCount": len(candidates),
        "worldIdentity": _world_identity(world_dir) if world_dir is not None else None,
        "candidates": candidates,
        "externalPackFingerprints": external_pack_fingerprints or {},
    }
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)
    summary = {
        "scanPlanId": scan_plan_id,
        "worldIdentity": document["worldIdentity"],
        "createdAt": document["createdAt"],
        "candidateCount": document["candidateCount"],
    }
    summary_path = path.with_name(f"{path.stem}.summary.json")
    summary_temporary = summary_path.with_suffix(".json.tmp")
    summary_temporary.write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
    os.replace(summary_temporary, summary_path)


def _load_scan_plan(data_dir: Path, scan_plan_id: str) -> dict:
    path = _scan_plan_path(data_dir, scan_plan_id)
    if not path.is_file():
        return {}
    loaded = json.loads(path.read_text(encoding="utf-8"))
    return loaded if isinstance(loaded, dict) else {}


def _coverage(world: Path, resource_pack_enabled: bool, scan_options: dict | None = None, external_pack_paths: list[str] | None = None) -> list[dict]:
    """What a scan reads and what it does not, so the result never reads as "the whole world"."""
    options = normalize_scan_options(scan_options)
    root = world.expanduser().resolve()
    roots = [root] if (root / "level.dat").is_file() else [
        child for child in sorted(root.iterdir()) if child.is_dir() and (child / "level.dat").is_file()
    ] if root.is_dir() else []

    def count(pattern: str) -> int:
        return sum(len(list(base.glob(pattern))) for base in roots)

    datapacks = count("datapacks/*")
    storage = count("data/command_storage_*.dat")
    playerdata = count("playerdata/*.dat")
    resource_packs = count("resources.zip")
    coverage = [
        {"id": "regions", "scanned": True, "present": True},
        {"id": "entities", "scanned": True, "present": True},
        {"id": "resource_pack", "scanned": bool(resource_pack_enabled), "present": resource_packs > 0, "count": resource_packs},
        {"id": "external_resource_pack", "scanned": bool(resource_pack_enabled and external_pack_paths), "present": bool(external_pack_paths), "count": len(external_pack_paths or [])},
        {"id": "datapacks", "scanned": False, "present": datapacks > 0, "count": datapacks},
        {"id": "command_storage", "scanned": False, "present": storage > 0, "count": storage},
        {"id": "playerdata", "scanned": False, "present": playerdata > 0, "count": playerdata},
    ]
    option_rows = (
        ("standard_signs", "translate_signs"),
        ("standard_books", "translate_books"),
        ("standard_custom_names", "translate_custom_names"),
        ("standard_item_names", "translate_item_names"),
        ("standard_lore", "translate_lore"),
        ("standard_titles", "translate_titles"),
        ("standard_filtered_titles", "translate_filtered_titles"),
        ("standard_command_output", "translate_command_output"),
        ("standard_text_displays", "translate_text_displays"),
    )
    coverage.extend(
        {"id": coverage_id, "scanned": bool(options[option]), "scopeOption": True}
        for coverage_id, option in option_rows
    )
    return coverage


def _candidate_page(
    plan: dict, body: dict, source_overrides: dict[str, str] | None = None
) -> dict:
    """Filter, sort and slice a scan plan on this side, so the count and the rows always agree."""
    candidates = [item for item in plan.get("candidates", []) if isinstance(item, dict)]
    query = str(body.get("query") or "").strip().casefold()
    if query:
        candidates = [
            item
            for item in candidates
            if query in str(item.get("source") or "").casefold()
            or query in str(item.get("location") or "").casefold()
        ]
    excluded = {str(item) for item in body.get("excludedCandidateIds") or []}
    manual = {str(item) for item in body.get("overrideCandidateIds") or []}
    global_overrides = normalize_source_overrides(
        {} if source_overrides is None else source_overrides,
        field="saved source_overrides",
    )
    state = str(body.get("state") or "all")
    if state == "included":
        candidates = [item for item in candidates if item.get("id") not in excluded]
    elif state == "excluded":
        candidates = [item for item in candidates if item.get("id") in excluded]
    elif state == "manual":
        candidates = [
            item
            for item in candidates
            if item.get("id") in manual
            or str(item.get("source") or "") in global_overrides
        ]
    facets: dict[str, int] = {}
    for item in candidates:
        name = str(item.get("kind") or "other")
        facets[name] = facets.get(name, 0) + 1
    wanted = str(body.get("kind") or "")
    if wanted:
        candidates = [item for item in candidates if str(item.get("kind") or "other") == wanted]
    sort = str(body.get("sort") or "order")
    if sort == "source":
        candidates.sort(key=lambda item: str(item.get("source") or "").casefold())
    elif sort == "count":
        candidates.sort(key=lambda item: (-int(item.get("occurrences") or 1), str(item.get("source") or "").casefold()))
    elif sort == "kind":
        order = {name: index for index, name in enumerate(CATEGORIES)}
        candidates.sort(key=lambda item: order.get(str(item.get("kind") or "other"), len(order)))
    offset = max(0, int(body.get("offset") or 0))
    limit = min(500, max(1, int(body.get("limit") or 100)))
    return {
        "candidates": candidates[offset : offset + limit],
        "offset": offset,
        "total": len(candidates),
        "hasMore": offset + limit < len(candidates),
        "kinds": facets,
    }


def _resume_candidate(data_dir: Path, world: Path) -> dict:
    from mwt.safety import world_fingerprint

    resolved_world = world.expanduser().resolve()
    if not resolved_world.is_dir():
        return {}
    jobs_dir = data_dir / "jobs"
    if not jobs_dir.is_dir():
        return {}
    try:
        current_scope = _scan_scope_fingerprint(data_dir)
        current_translation = _settings_fingerprint(data_dir, world)
    except (OSError, ValueError, RuntimeError):
        return {}
    preliminary: list[tuple[dict, dict, dict, dict]] = []
    for path in jobs_dir.glob("*.checkpoint.json"):
        try:
            checkpoint = json.loads(path.read_text(encoding="utf-8"))
            resume = checkpoint.get("resume") or {}
            report = checkpoint.get("report") or {}
            scan_plan_id = str(resume.get("scan_plan_id") or "")
            journal = _reapply_journal(data_dir, scan_plan_id)
            if journal:
                checkpoint = _interrupted_job(journal)
                resume = checkpoint.get("resume") or {}
                report = checkpoint.get("report") or {}
            interrupted = report.get("status") == "reapply_interrupted"
            plan = _load_scan_plan(data_dir, scan_plan_id)
            if (
                checkpoint.get("version") != 2
                or (report.get("status") not in RESUMABLE_STATUSES and not interrupted)
                or Path(str(checkpoint.get("world_dir") or "")).expanduser().resolve() != resolved_world
                or (not interrupted and plan.get("scopeFingerprint") != current_scope)
                or (not interrupted and resume.get("translation_settings_fingerprint") != current_translation)
                or plan.get("worldFingerprint") != resume.get("expected_world_fingerprint")
            ):
                continue
            preliminary.append((checkpoint, resume, report, plan))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    if not preliminary:
        return {}

    try:
        current_world = world_fingerprint(resolved_world)
    except (OSError, ValueError, RuntimeError):
        # Inspection reports the unreadable/unsafe path; never reuse its checkpoint.
        return {}
    candidates: list[dict] = []
    for checkpoint, resume, report, plan in preliminary:
        try:
            interrupted = report.get("status") == "reapply_interrupted"
            if not interrupted and checkpoint.get("world_fingerprint") != current_world:
                continue
            scan_plan_id = str(resume.get("scan_plan_id") or "")
            plan_candidates = [item for item in plan.get("candidates", []) if isinstance(item, dict)]
            id_by_source = {str(item.get("source")): str(item.get("id")) for item in plan_candidates}
            candidate_overrides = {
                id_by_source[source]: translated
                for source, translated in (resume.get("manual_overrides") or {}).items()
                if source in id_by_source and isinstance(translated, str)
            }
            candidates.append(
                {
                    "available": True,
                    "scanPlanId": scan_plan_id,
                    "fingerprint": str(resume.get("expected_world_fingerprint") or ""),
                    "candidateCount": len(plan_candidates),
                    "occurrenceCount": sum(int(item.get("occurrences") or 0) for item in plan_candidates),
                    "kinds": {kind: sum(item.get("kind") == kind for item in plan_candidates) for kind in {str(item.get("kind") or "unknown") for item in plan_candidates}},
                    "coverage": _coverage(
                        resolved_world,
                        bool(_saved(data_dir).get("resource_pack_enabled")),
                        _saved(data_dir).get("scan_options"),
                        _saved(data_dir).get("external_resource_pack_paths", []),
                    ),
                    "candidates": plan_candidates[:200],
                    "excludedCandidateIds": list(resume.get("excluded_candidate_ids") or []),
                    "candidateOverrides": candidate_overrides,
                    "savedAt": float(checkpoint.get("saved_at") or 0),
                    "backupSetId": str(report.get("backup_set_id") or ""),
                    "status": str(report.get("status") or ""),
                    "recoverySetId": str((checkpoint.get("reapply") or {}).get("recoverySetId") or ""),
                    "translatedCount": len(checkpoint.get("translation_cache") or {}),
                    "failedCount": len(checkpoint.get("failures") or {}),
                    "reason": next(
                        (str(item.get("message") or "") for item in report.get("errors", []) if isinstance(item, dict)),
                        "",
                    ),
                }
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    return max(candidates, key=lambda item: item["savedAt"], default={})


def _saved(data_dir: Path) -> dict:
    from mwt.userdata import load_user_settings

    return load_user_settings(data_dir)


def _run_translator(
    world: Path,
    *,
    dry_run: bool,
    report_path: Path,
    fingerprint: str = "",
    data_dir: Path,
    progress_callback=None,
    candidate_limit: int = 0,
    excluded_candidate_ids: list[str] | None = None,
    cancel_check=None,
    api_key_override: str = "",
    allow_keyring_fallback: bool = True,
    manual_overrides: dict[str, str] | None = None,
    skip_provider_validation: bool = False,
    scan_plan_id: str = "",
    resume_from_checkpoint: bool = False,
    on_translation_failure: str = "stop",
    desktop_context: dict | None = None,
    external_pack_fingerprints: dict | None = None,
    review_before_apply: bool = False,
    apply_only: bool = False,
    edits: dict | None = None,
    adopt_checkpoint: dict | None = None,
    retry: tuple[list[str], list[str]] | None = None,
    budget_override: bool = False,
    budget_disabled: bool = False,
) -> dict:
    import os

    from mc_world_translator import DEFAULT_CONFIG, WorldTranslator, merge_nested, remember_run_settings
    from mwt.secrets import load_api_key

    saved = _saved(data_dir)
    scan_options = normalize_scan_options(saved=saved.get("scan_options"), defaults=DEFAULT_CONFIG["scan"])
    resource_pack_options = normalize_resource_pack_options(
        saved=saved.get("resource_pack_options")
    )
    persistent_source_overrides = normalize_source_overrides(
        saved.get("source_overrides", {}), field="saved source_overrides"
    )
    source_overrides = dict(persistent_source_overrides)
    if manual_overrides is not None and not isinstance(manual_overrides, dict):
        raise ValueError("candidateOverrides must be an object")
    candidate_overrides: dict[str, str] = {}
    for source, translated in (manual_overrides or {}).items():
        if not isinstance(source, str) or not isinstance(translated, str):
            raise ValueError("candidateOverrides must map strings to strings")
        cleaned = translated.strip()
        if not cleaned or len(cleaned) > 32_000:
            raise ValueError("A manual override is empty or too long")
        candidate_overrides[source] = cleaned
    # Per-run review edits take precedence over persistent exact-source replacements.
    source_overrides.update(candidate_overrides)
    continue_on_file_error = normalize_continue_on_file_error(
        saved.get("continue_on_file_error", DEFAULT_CONTINUE_ON_FILE_ERROR),
        field="saved continue_on_file_error",
    )
    max_file_write_retries = normalize_max_file_write_retries(
        saved.get("max_file_write_retries", DEFAULT_MAX_FILE_WRITE_RETRIES),
        field="saved max_file_write_retries",
    )
    temperature = saved.get("temperature")
    if temperature in (None, ""):
        temperature = DEFAULT_CONFIG["temperature"]
    max_batch_retries = saved.get("max_batch_retries")
    if max_batch_retries in (None, ""):
        max_batch_retries = DEFAULT_CONFIG["runtime"]["max_batch_retries"]
    provider = os.environ.get("POMI_PROVIDER") or str(saved.get("provider") or "openai")
    model = os.environ.get("POMI_MODEL") or str(saved.get("model") or "")
    base_url = os.environ.get("POMI_API_BASE") or str(saved.get("base_url") or "")
    wire_format = os.environ.get("POMI_WIRE_FORMAT") or str(saved.get("wire_format") or "")
    api_key = "" if dry_run else (
        api_key_override
        or os.environ.get("POMI_API_KEY")
        or (load_api_key(provider) if allow_keyring_fallback else "")
        or ""
    )
    if desktop_context is not None:
        from mwt.desktop_provider import resolve_desktop_provider
        selected = resolve_desktop_provider(desktop_context, saved)
        provider, model, base_url, wire_format = (selected[key] for key in ("provider", "model", "base_url", "wire_format"))
        api_key = "" if dry_run else selected["api_key"]
    resource_pack_paths = []
    selected_packs = []
    if bool(saved.get("resource_pack_enabled")):
        inspection = _world_inspection(world)
        selected_packs = selected_pack_files(saved)
        resource_pack_paths = list(dict.fromkeys([*(inspection.get("resourcePacks") or []), *(str(path) for path in selected_packs)]))
    checkpoint_path = _checkpoint_path(data_dir, scan_plan_id) if scan_plan_id else report_path.with_suffix(".checkpoint.json")
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    if scan_plan_id and not dry_run and not resume_from_checkpoint and adopt_checkpoint is None:
        checkpoint_path.unlink(missing_ok=True)
    from mwt.desktop_review import normalize_max_cost_usd

    max_cost_usd = normalize_max_cost_usd(saved.get("max_cost_usd", 0), field="saved max_cost_usd")
    from mwt.glossary import entries_hash, merge_entries, normalize_entries
    from mwt.userdata import load_world_glossary

    try:
        global_glossary = normalize_entries(saved.get("glossary", []), field="saved glossary")
    except ValueError:
        global_glossary = []
    glossary_entries = merge_entries(global_glossary, load_world_glossary(world, data_dir))
    glossary_hash = entries_hash(glossary_entries)
    price = _model_price({**saved, "provider": provider, "model": model}, data_dir)
    config = merge_nested(
        DEFAULT_CONFIG,
        {
            "world_dir": str(world),
            "dry_run": dry_run,
            "report_path": str(report_path),
            "temperature": float(temperature),
            "batch_size": int(saved.get("batch_size") or DEFAULT_CONFIG["batch_size"]),
            "inherit_translate_py": False,
            "runtime": {
                "checkpoint_enabled": bool(scan_plan_id and not dry_run),
                "checkpoint_path": str(checkpoint_path),
                "resume_from_checkpoint": resume_from_checkpoint,
                "scan_plan_id": scan_plan_id,
                "expected_world_fingerprint": fingerprint,
                "data_dir": str(data_dir),
                "excluded_candidate_ids": excluded_candidate_ids or [],
                "skip_provider_validation": skip_provider_validation,
                "backup_store": str(backup_store(world, data_dir)),
                "authorized_external_pack_paths": [str(path) for path in selected_packs],
                "expected_external_pack_fingerprints": external_pack_fingerprints or {},
                "concurrency": int(saved.get("concurrency") or 4),
                "translation_settings_fingerprint": _settings_fingerprint(data_dir, world),
                "on_translation_failure": "skip" if on_translation_failure == "skip" else "stop",
                "max_batch_retries": int(max_batch_retries),
                "continue_on_file_error": continue_on_file_error,
                "max_file_write_retries": max_file_write_retries,
                "review_before_apply": bool(review_before_apply),
                "apply_only": bool(apply_only),
                # The desktop keeps a finished job so its translations can be reviewed and corrected.
                "keep_checkpoint": bool(scan_plan_id and not dry_run),
                # An estimate override grants a start only. Unlimited spending is a separate
                # explicit, one-run authorization and never changes the saved preference.
                "max_cost_usd": 0.0 if budget_disabled else max_cost_usd,
                "price": {"input": price["input"], "output": price["output"], "source": price.get("source", "catalog")} if price else None,
                "glossary_entries": glossary_entries,
                "glossary_hash": glossary_hash,
                "adopt_checkpoint": adopt_checkpoint,
                "glossary_refreshed": bool(retry and adopt_checkpoint and adopt_checkpoint.get("applied")),
                "adopt_report": retry is not None,
                "edits": edits or {},
            },
            "api": {
                "provider": provider,
                "api_key": api_key,
                "model": model,
                "base_url": base_url,
                "wire_format": wire_format,
                "openrouter_reasoning": normalize_reasoning(saved.get("openrouter_reasoning", "default")),
                "request_timeout": int(
                    saved.get("request_timeout") or DEFAULT_CONFIG["api"]["request_timeout"]
                ),
                "rpm_limit": int(saved.get("rpm_limit") or 0),
                "tpm_limit": int(saved.get("tpm_limit") or 0),
            },
            "prompt": {
                "target_language": (os.environ.get("POMI_TARGET_LANGUAGE") if desktop_context is None else None) or saved.get("target_language") or "한국어",
                "style_preset": (os.environ.get("POMI_STYLE_PRESET") if desktop_context is None else None) or saved.get("style_preset") or "neutral",
                "style_prompt": str(saved.get("style_prompt") or ""),
                "custom_system_prompt": str(saved.get("custom_system_prompt") or ""),
            },
            "scan": {
                **scan_options,
                "overrides": source_overrides,
                "skip_target_language_text": saved.get("skip_target_language_text", True) is not False,
            },
            "resource_pack": {
                "enabled": bool(resource_pack_paths),
                "zip_paths": resource_pack_paths,
                "external_zip_paths": normalize_external_pack_paths(saved.get("external_resource_pack_paths", [])),
                **resource_pack_options,
            },
        },
    )
    translator = WorldTranslator(config, progress_callback=progress_callback, cancel_check=cancel_check)
    if retry is not None:
        report = translator.retry_failed(*retry)
    else:
        report = translator.run()
    if dry_run and candidate_limit:
        records = [_candidate_record(source, translator.occurrences.get(source)) for source in translator._candidate_order]
        report["candidate_preview"] = records[:candidate_limit]
        report["_candidate_records"] = records
    report["price_source"] = price.get("source", "catalog") if price else None
    persisted_config = {
        **config,
        "scan": {**config["scan"], "overrides": persistent_source_overrides},
    }
    remember_run_settings(persisted_config, data_dir, None)
    # The run only knows whether this world has a pack. The user's choice must survive a world without one.
    from mwt.userdata import remember_user_settings

    remember_user_settings({"resource_pack_enabled": bool(saved.get("resource_pack_enabled"))}, data_dir)
    return report


def emit(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def hello() -> None:
    emit(
        {
            "v": 1,
            "type": "system.hello",
            "payload": {
                "productName": "PomiTranslate",
                "subtitle": "World Translator for Minecraft",
                "protocolVersion": 1,
                "localhostServer": False,
                "capabilities": [
                    "scan",
                    "translate",
                    "restore",
                    "settings",
                    "models",
                    "region.lz4",
                    "region.external_chunk",
                ],
                "providers": ["openai", "gemini", "anthropic", "openrouter", "comet", "custom"],
                "notices": payload(),
            },
        }
    )


def _settings_payload(data_dir: Path, provider: str = "", *, check_keyring: bool = True) -> dict:
    from mwt.secrets import load_api_key

    saved = dict(_saved(data_dir))
    saved.pop("last_jobs", None)  # world summaries for the start screen, not a setting
    if not saved.get("provider"):
        saved["provider"] = "openai"
    saved["openrouter_reasoning"] = normalize_reasoning(saved.get("openrouter_reasoning", "default"))
    from mwt.desktop_settings import normalize_custom_prices
    from mwt.glossary import normalize_entries
    try:
        saved["glossary"] = normalize_entries(saved.get("glossary", []), field="saved glossary")
    except ValueError:
        saved["glossary"] = []
    try:
        saved["custom_prices"] = normalize_custom_prices(saved.get("custom_prices", {}), field="saved custom_prices")
    except ValueError:
        saved["custom_prices"] = {}
    saved["source_overrides"] = normalize_source_overrides(
        saved.get("source_overrides", {}), field="saved source_overrides"
    )
    saved["continue_on_file_error"] = normalize_continue_on_file_error(
        saved.get("continue_on_file_error", DEFAULT_CONTINUE_ON_FILE_ERROR),
        field="saved continue_on_file_error",
    )
    saved["max_file_write_retries"] = normalize_max_file_write_retries(
        saved.get("max_file_write_retries", DEFAULT_MAX_FILE_WRITE_RETRIES),
        field="saved max_file_write_retries",
    )
    saved["resource_pack_options"] = normalize_resource_pack_options(
        saved=saved.get("resource_pack_options")
    )
    saved["external_resource_pack_paths"] = normalize_external_pack_paths(saved.get("external_resource_pack_paths", []))
    saved["review_before_apply"] = saved.get("review_before_apply", True) is not False
    try:
        saved["max_cost_usd"] = normalize_max_cost_usd(saved.get("max_cost_usd", 0), field="saved max_cost_usd")
    except ValueError:
        saved["max_cost_usd"] = 0.0
    chosen = provider or str(saved.get("provider") or "")
    return {
        "settings": saved,
        "apiKeyStored": bool(check_keyring and chosen and load_api_key(chosen)),
        "localhostServer": False,
    }


def _bootstrap_payload(data_dir: Path, requested_world: str = "", *, check_keyring: bool = True) -> dict:
    from mwt.userdata import list_recent_worlds

    settings = _settings_payload(data_dir, check_keyring=check_keyring)
    selected = str(requested_world or settings["settings"].get("last_world_dir") or "")
    world = Path(selected).expanduser() if selected else None
    inspection = _world_inspection(world, recursive_blockers=False) if world else None
    valid_world = bool(world and inspection and inspection.get("validJavaWorld"))
    from mwt.userdata import load_app_prefs, load_last_job

    last_scan = _last_scan_summary(data_dir, world) if valid_world else None
    resumable = (_resume_candidate(data_dir, world) or {"available": False}) if valid_world else {"available": False}
    resumable["lastScan"] = last_scan

    return {
        "notices": payload(),
        **settings,
        "prefs": load_app_prefs(data_dir),
        "worlds": list_recent_worlds(data_dir),
        "worldInspection": inspection,
        "backups": list_backup_sets(world, _backup_stores(world, data_dir)) if valid_world else [],
        "resume": resumable,
        "lastJob": load_last_job(world, data_dir) if valid_world else None,
        "lastScan": last_scan,
    }


class RequestRefused(Exception):
    """A request the sidecar understood and declined, with a stable code the interface can explain."""

    def __init__(self, code: str, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


def _validated_plan(data_dir: Path, fingerprint: str, scan_plan_id: str, *, applied: dict | None = None) -> dict:
    """The saved scan plan, when it still describes the world and settings being acted on."""
    if not fingerprint or not scan_plan_id:
        raise RequestRefused("SCAN_REQUIRED", "Run Scan Only and review its result before translating.")
    stored_plan = _load_scan_plan(data_dir, scan_plan_id)
    from mwt.safety import file_sha256
    for path, digest in ((applied or {}).get("external_pack_fingerprints") or {}).items():
        target = Path(path)
        if target.is_symlink() or not target.is_file() or file_sha256(target) != digest:
            raise RequestRefused("WORLD_CHANGED_SINCE_APPLY", "An external resource pack changed after this job was applied.")
    scope_fingerprint = _scan_scope_fingerprint(
        data_dir, original_external=stored_plan.get("externalPackFingerprints") if applied else None,
    )
    expected_plan_id = _scan_plan_id(fingerprint, scope_fingerprint)
    if (
        scan_plan_id != expected_plan_id
        or stored_plan.get("worldFingerprint") != fingerprint
        or stored_plan.get("scopeFingerprint") != scope_fingerprint
    ):
        raise RequestRefused(
            "PLAN_INVALIDATED",
            "The world, target language or resource pack setting changed after Scan Only. Run the scan again.",
        )
    return stored_plan


def _load_job(data_dir: Path, scan_plan_id: str, world: Path) -> dict:
    """The saved translation job of this scan plan for this world, or an empty dict."""
    from mwt.desktop_review import load_job

    job = load_job(_checkpoint_path(data_dir, scan_plan_id))
    journal = _reapply_journal(data_dir, scan_plan_id)
    if journal:
        job = _interrupted_job(journal)
    try:
        same_world = Path(str(job.get("world_dir") or "")).expanduser().resolve() == world.expanduser().resolve()
    except (OSError, RuntimeError):
        same_world = False
    return job if same_world else {}


def _job_requests(report: dict) -> int:
    usage = report.get("job_usage") or {}
    try:
        return max(int(usage["requests"]), int(report.get("provider_requests", 0)))
    except (KeyError, TypeError, ValueError):
        return int(report.get("provider_requests", 0) or 0)


def _translate_payload(report: dict) -> dict:
    return {
        "status": report.get("status"),
        "candidateCount": report.get("candidate_text_count", 0),
        "changedFileCount": report.get("changed_file_count", 0),
        "providerRequests": report.get("provider_requests", 0),
        # Requests across every run of the job, like the usage below; providerRequests is this call only.
        "jobProviderRequests": _job_requests(report),
        "backupSetId": report.get("backup_set_id", ""),
        "preTranslate": PRE_TRANSLATE,
        "localhostServer": False,
        "errors": report.get("errors", []),
        "warnings": report.get("warnings", []),
        "translation": report.get("translation") or {},
        "translationFailures": report.get("translation_failures", []),
        "keptOriginalSamples": report.get("kept_original_samples", []),
        "translationSamples": report.get("translation_samples", []),
        "glossaryMismatchCount": len(report.get("glossary_mismatches") or []),
        "glossaryMismatches": report.get("glossary_mismatches", []),
        "priceSource": report.get("price_source"),
        # Everything this job has cost so far, not only the request that just ran.
        "usage": report.get("job_usage") or report.get("usage") or {},
    }


def _glossary_stale_sources(plan: dict, job: dict, saved: dict, entries: list[dict], data_dir: Path) -> list[str]:
    from mwt.desktop_review import job_rows
    from mwt.glossary import entries_hash, matching_entries, row_hashes, source_hash

    resume = job.get("resume") or {}
    if resume.get("glossary_hash") == entries_hash(entries):
        return []
    rows = job_rows(plan, job, saved.get("source_overrides", {}))
    sources = [row["source"] for row in rows if row["status"] != "failed"]
    old_hashes = resume.get("glossary_row_hashes")
    if not isinstance(old_hashes, dict):
        # Older jobs cannot identify removed terms. A changed fingerprint requires a full
        # answer refresh; an unchanged legacy job with no glossary remains compatible.
        old_fingerprint = resume.get("translation_settings_fingerprint")
        if old_fingerprint and old_fingerprint != _settings_fingerprint(data_dir, job.get("world_dir")):
            return sources
        return [text for text in sources if matching_entries([text], entries)]
    current = row_hashes(sources, entries)
    return [text for text in sources if old_hashes.get(source_hash(text)) != current[source_hash(text)]]


def _translations_payload(plan: dict, job: dict, saved: dict, body: dict, data_dir: Path) -> dict:
    from mwt.desktop_review import UNSENT_REASONS, job_rows, translations_page

    if not job:
        raise RequestRefused("JOB_NOT_FOUND", "There is no saved translation job for this scan.")
    overrides = normalize_source_overrides(saved.get("source_overrides", {}), field="saved source_overrides")
    glossary = _effective_glossary(data_dir, plan.get("worldDir") or job.get("world_dir"))
    stale = _glossary_stale_sources(plan, job, saved, glossary, data_dir)
    page = translations_page(plan, job, overrides, body, glossary=glossary, stale_sources=set(stale))
    rows = [row for row in job_rows(plan, job, overrides) if row["status"] == "failed"]
    failed_records = [{"source": row["source"]} for row in rows]
    retry_sources = list(dict.fromkeys(stale + [row["source"] for row in rows]))
    retry_records = [{"source": text} for text in retry_sources]
    applied = job.get("applied") or {}
    report = job.get("report") or {}
    page["meta"] = {
        "status": str(report.get("status") or ""),
        "applied": bool(applied),
        "backupSetId": str(applied.get("backup_set_id") or (job.get("reapply") or {}).get("backupSetId") or ""),
        "recoverySetId": str((job.get("reapply") or {}).get("recoverySetId") or ""),
        "failedCount": len(failed_records),
        "unsentCount": sum(1 for row in rows if row.get("reason") in UNSENT_REASONS),
        "usage": job.get("usage_total") or {},
        "retryCount": len(retry_records),
        "retryEstimate": _estimate(retry_records, saved, data_dir, glossary=glossary) if retry_records else None,
        "glossaryActive": bool(glossary),
        "glossaryStaleCount": len(stale),
        "glossaryRefreshCount": len(stale),
        "glossaryRefreshEstimate": _estimate([{"source": text} for text in stale], saved, data_dir, glossary=glossary) if stale else None,
        "glossaryRefreshed": bool(job.get("glossary_refreshed")),
    }
    return page


def _restore_backup(world: Path, backup_id: str, data_dir: Path, *,
                    expected_fingerprint: str = "", expected_external: dict | None = None,
                    before_restore=None) -> tuple[BackupSet, str]:
    """Put a backup set back (keeping what it replaces as a recovery set) and say which set that is."""
    stores = _backup_stores(world, data_dir)
    if backup_id == "latest":
        listed = list_backup_sets(world, stores)
        if not listed:
            raise ValueError("There is no backup to restore")
        backup_id = listed[0]["backupSetId"]
    selected = BackupSet.find(world, backup_id, stores)
    required = set(selected.external_targets())
    # An unrelated offline pack must not prevent restoring a world-only backup.
    allowed = [Path(path) for path in normalize_external_pack_paths(_saved(data_dir).get("external_resource_pack_paths", []))
               if Path(path).resolve(strict=False) in required]
    selected = BackupSet.find(world, backup_id, stores, external_files=allowed)
    from mwt.locking import WorldWriteLock, MinecraftSessionLocks
    from mwt.safety import world_fingerprint, file_sha256

    guard, session = WorldWriteLock(world), MinecraftSessionLocks(world)
    try:
        guard.acquire()
        session.acquire()
        if expected_fingerprint and world_fingerprint(world) != expected_fingerprint:
            raise RequestRefused("WORLD_CHANGED_SINCE_APPLY", "The world changed after this job was applied.")
        for path, digest in (expected_external or {}).items():
            target = Path(path)
            if target.is_symlink() or not target.is_file() or file_sha256(target) != digest:
                raise RequestRefused("WORLD_CHANGED_SINCE_APPLY", "An external resource pack changed after this job was applied.")
        if before_restore is not None:
            # Prepare a separately durable recovery snapshot before restore can replace even
            # one byte. BackupSet.restore also retains its normal recovery set for legacy callers.
            verified = BackupSet.open_existing(world, selected.backup_id, selected.store, external_files=allowed)
            recovery = BackupSet.new(world, kind="recovery", store=stores[0], external_files=allowed)
            targets = [verified._target(entry) for entry in verified.entries]
            for target in targets:
                if target.is_file():
                    recovery.add(target)
            # Reapply can move an internal chunk to .mcc or restore a previously removed .mcc.
            # Preserve absence as well as bytes so recovery does not leave newly created files.
            from mwt.region import RegionFile, external_chunk_path
            absent = {target for target in targets if not target.exists() and target.suffix == ".mcc"}
            for target in targets:
                if target.suffix == ".mca" and target.is_file():
                    absent.update(external_chunk_path(target, chunk.index)
                                  for chunk in RegionFile.read(target).chunks if not chunk.empty
                                  and not external_chunk_path(target, chunk.index).exists())
            for target in sorted(absent):
                recovery.record_new_external_chunk(target)
            recovery.publish_latest()
            # copy2/manifest atomic replacement alone do not guarantee crash durability.
            for path in recovery.root.rglob("*"):
                if path.is_file():
                    with path.open("rb") as stream:
                        os.fsync(stream.fileno())
            if os.name != "nt":
                directories = [path for path in recovery.root.rglob("*") if path.is_dir()]
                for path in [*sorted(directories, key=lambda p: len(p.parts), reverse=True), recovery.root, recovery.store]:
                    descriptor = os.open(path, os.O_RDONLY)
                    try:
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
            before_restore(selected, recovery.backup_id)
            selected.restore(recovery_store=stores[0])
            return selected, recovery.backup_id
        return selected, selected.restore(recovery_store=stores[0])
    finally:
        session.release()
        guard.release()


def _prune_finished_jobs(data_dir: Path, world: Path, keep_plan_id: str) -> None:
    """A new scan replaces the finished job kept for corrections. Unfinished jobs stay resumable."""
    jobs_dir = data_dir / "jobs"
    if not jobs_dir.is_dir():
        return
    keep = _checkpoint_path(data_dir, keep_plan_id)
    for path in jobs_dir.glob("*.checkpoint.json"):
        if path == keep:
            continue
        try:
            job = _load_job(data_dir, path.name.split(".", 1)[0], world)
            if (
                (job.get("report") or {}).get("status") in {"completed", "partial"}
                and Path(str(job.get("world_dir") or "")).expanduser().resolve() == world.expanduser().resolve()
            ):
                path.unlink(missing_ok=True)
        except (OSError, ValueError, RuntimeError):
            continue


def handle(message: dict, report_dir: Path, data_dir: Path, cancel_path: Path | None = None) -> None:
    kind = message.get("type")
    request_id = message.get("id", "")
    body = message.get("payload") or {}
    world = Path(body.get("worldDir", "")).expanduser()
    if kind == "app.bootstrap":
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": _bootstrap_payload(
                    data_dir,
                    str(body.get("worldDir") or ""),
                    check_keyring=body.get("credentialOwner") != "rust",
                ),
            }
        )
        return
    if kind == "prefs.set":
        from mwt.userdata import remember_app_prefs

        prefs = remember_app_prefs(body.get("prefs"), data_dir)
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": {"prefs": prefs}})
        return
    if kind == "app.reset":
        from mwt.userdata import reset_user_data

        if body.get("confirm") != "reset":
            raise ValueError("Reset needs an explicit confirmation")
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": reset_user_data(data_dir)})
        return
    if kind == "notices.get":
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": payload()})
        return
    if kind == "glossary.get":
        from mwt.glossary import merge_entries, normalize_entries
        from mwt.userdata import load_world_glossary

        try:
            global_entries = normalize_entries(_saved(data_dir).get("glossary", []), field="saved glossary")
        except ValueError:
            global_entries = []
        world_entries = []
        if body.get("world"):
            world_value = body.get("world")
            if not isinstance(world_value, str) or not world_value.strip():
                raise RequestRefused("INVALID_REQUEST", "world must be a non-empty folder path")
            world_entries = load_world_glossary(Path(world_value).expanduser(), data_dir)
        emit({
            "v": 1,
            "id": request_id,
            "type": "response.ok",
            "payload": {
                "global": global_entries,
                "world": world_entries,
                "effective": merge_entries(global_entries, world_entries),
            },
        })
        return
    if kind == "glossary.set":
        from mwt.glossary import GlossaryValidationError, normalize_entries
        from mwt.userdata import remember_user_settings, remember_world_glossary

        scope = body.get("scope")
        if not isinstance(scope, str) or scope not in {"global", "world"}:
            raise RequestRefused("INVALID_REQUEST", "scope must be global or world")
        try:
            entries = normalize_entries(body.get("entries"), field="entries")
        except GlossaryValidationError as exc:
            raise RequestRefused("GLOSSARY_INVALID", str(exc), exc.details) from exc
        except ValueError as exc:
            raise RequestRefused("GLOSSARY_INVALID", str(exc), {"rows": []}) from exc
        if scope == "global":
            remember_user_settings({"glossary": entries}, data_dir)
        else:
            world_value = body.get("world")
            if not isinstance(world_value, str) or not world_value.strip():
                raise RequestRefused("INVALID_REQUEST", "A world folder is required for a world glossary")
            remember_world_glossary(Path(world_value).expanduser(), entries, data_dir)
        emit({
            "v": 1,
            "id": request_id,
            "type": "response.ok",
            "payload": {"scope": scope, "entries": entries, "count": len(entries)},
        })
        return
    if kind == "settings.import_legacy":
        from mwt.desktop_legacy_import import parse_legacy_settings

        config = parse_legacy_settings(body.get("source"))
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": {"config": config}})
        return
    if kind == "settings.get":
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": _settings_payload(
                    data_dir, check_keyring=body.get("credentialOwner") != "rust"
                ),
            }
        )
        return
    if kind == "settings.restore":
        from mwt.userdata import restore_user_settings

        previous, expected = body.get("settings"), body.get("expectedSettings")
        if body.get("credentialOwner") != "rust" or not isinstance(previous, dict) or not isinstance(expected, dict):
            raise ValueError("Invalid settings recovery request")
        restored = restore_user_settings(previous, expected, data_dir)
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": {"settings": restored}})
        return
    if kind == "settings.set":
        from mc_world_translator import DEFAULT_CONFIG
        from llm_backends import default_base_url
        from mwt.userdata import list_recent_worlds, public_settings_from_config, remember_user_settings

        saved = _saved(data_dir)
        if "scan_options" in body:
            raise ValueError("Use scanOptions for desktop scan preferences")
        if "resource_pack_options" in body:
            raise ValueError("Use resourcePackOptions for desktop resource-pack preferences")
        scan_options = normalize_scan_options(
            body.get("scanOptions") if "scanOptions" in body else None,
            saved=saved.get("scan_options"),
            defaults=DEFAULT_CONFIG["scan"],
        )
        if "resourcePackOptions" in body and not isinstance(body["resourcePackOptions"], dict):
            raise ValueError("resourcePackOptions must be an object")
        resource_pack_options = normalize_resource_pack_options(
            body.get("resourcePackOptions") if "resourcePackOptions" in body else None,
            saved=saved.get("resource_pack_options"),
        )
        external_pack_paths = normalize_external_pack_paths(body.get("externalResourcePackPaths", saved.get("external_resource_pack_paths", [])))

        def public_setting(camel_name: str, saved_name: str, default):
            if camel_name in body:
                return body[camel_name]
            if saved_name in body:
                return body[saved_name]
            return saved.get(saved_name, default)

        source_overrides = normalize_source_overrides(
            public_setting("sourceOverrides", "source_overrides", {}),
            field="sourceOverrides",
        )
        continue_on_file_error = normalize_continue_on_file_error(
            public_setting(
                "continueOnFileError",
                "continue_on_file_error",
                DEFAULT_CONTINUE_ON_FILE_ERROR,
            ),
            field="continueOnFileError",
        )
        max_file_write_retries = normalize_max_file_write_retries(
            public_setting(
                "maxFileWriteRetries",
                "max_file_write_retries",
                DEFAULT_MAX_FILE_WRITE_RETRIES,
            ),
            field="maxFileWriteRetries",
        )
        review_before_apply = normalize_review_before_apply(
            public_setting("reviewBeforeApply", "review_before_apply", True), field="reviewBeforeApply"
        )
        max_cost_usd = normalize_max_cost_usd(
            public_setting("maxCostUsd", "max_cost_usd", 0), field="maxCostUsd"
        )
        from mwt.desktop_settings import normalize_custom_prices
        from mwt.glossary import GlossaryValidationError, normalize_entries
        try:
            glossary = normalize_entries(public_setting("glossary", "glossary", []), field="glossary")
        except GlossaryValidationError as exc:
            raise RequestRefused("GLOSSARY_INVALID", str(exc), exc.details) from exc
        custom_prices = normalize_custom_prices(public_setting("customPrices", "custom_prices", {}), field="customPrices")
        ui_language = str(body.get("uiLanguage") or saved.get("ui_language") or "ko")
        if ui_language not in {"ko", "en", "ja"}:
            raise ValueError("Unsupported interface language")
        provider = str(body.get("provider") or saved.get("provider") or "openai")
        def text_setting(camel_name: str, saved_name: str, default: str = "") -> str:
            if camel_name in body:
                return str(body.get(camel_name) or "")
            if saved_name in body:
                return str(body.get(saved_name) or "")
            return str(saved.get(saved_name) or default)

        def bounded_number(name: str, saved_name: str, default: float, minimum: float, maximum: float) -> float:
            raw = body.get(name, saved.get(saved_name, default))
            try:
                value = float(raw)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Invalid {name}") from exc
            if not minimum <= value <= maximum:
                raise ValueError(f"{name} must be between {minimum:g} and {maximum:g}")
            return value

        temperature = bounded_number("temperature", "temperature", DEFAULT_CONFIG["temperature"], 0, 2)
        batch_size = int(bounded_number("batchSize", "batch_size", DEFAULT_CONFIG["batch_size"], 1, 200))
        request_timeout = int(
            bounded_number("requestTimeout", "request_timeout", DEFAULT_CONFIG["api"]["request_timeout"], 5, 600)
        )
        rpm_limit = int(bounded_number("rpmLimit", "rpm_limit", 0, 0, 10000))
        tpm_limit = int(bounded_number("tpmLimit", "tpm_limit", 0, 0, 10000000))
        max_batch_retries = int(
            bounded_number(
                "maxBatchRetries",
                "max_batch_retries",
                DEFAULT_CONFIG["runtime"]["max_batch_retries"],
                0,
                10,
            )
        )
        concurrency = int(bounded_number("concurrency", "concurrency", 4, 1, 8))
        base_url = str(body.get("baseUrl") or body.get("base_url") or "")
        if not base_url:
            # The desktop UI deliberately omits a URL for public providers. This also migrates
            # settings written by older builds that could retain a hidden Custom endpoint.
            base_url = default_base_url(provider) if provider in {"openai", "gemini", "anthropic", "openrouter", "comet"} else str(saved.get("base_url") or "")
        config = {
            "world_dir": str(body.get("worldDir") or saved.get("last_world_dir") or ""),
            "temperature": temperature,
            "batch_size": batch_size,
            "api": {
                "provider": provider,
                "model": str(body.get("model") or saved.get("model") or ""),
                "base_url": base_url,
                "wire_format": str(body.get("wireFormat") or body.get("wire_format") or saved.get("wire_format") or ""),
                "openrouter_reasoning": normalize_reasoning(public_setting("openrouterReasoning", "openrouter_reasoning", "default")),
                "request_timeout": request_timeout,
                "rpm_limit": rpm_limit,
                "tpm_limit": tpm_limit,
            },
            "prompt": {
                "target_language": text_setting("targetLanguage", "target_language"),
                "style_preset": text_setting("stylePreset", "style_preset", "neutral"),
                "style_prompt": text_setting("stylePrompt", "style_prompt"),
                "custom_system_prompt": text_setting("customSystemPrompt", "custom_system_prompt"),
            },
            "runtime": {
                "max_batch_retries": max_batch_retries,
                "concurrency": concurrency,
                "continue_on_file_error": continue_on_file_error,
                "max_file_write_retries": max_file_write_retries,
            },
            "scan": {
                **scan_options,
                "overrides": source_overrides,
                "skip_target_language_text": bool(
                    body.get("skipTargetLanguageText", saved.get("skip_target_language_text", True))
                )
            },
            "resource_pack": {
                "enabled": bool(body.get("resourcePackEnabled", saved.get("resource_pack_enabled", False))),
                "external_zip_paths": external_pack_paths,
                **resource_pack_options,
            },
        }
        # Rust-owned requests never read or write a Python keyring credential. Validate all
        # public preferences before one atomic file replacement, including UI language.
        supplied_key = "" if body.get("credentialOwner") == "rust" else str(body.get("apiKey") or "")
        if supplied_key:
            from mwt.secrets import remember_api_key

            remember_api_key(provider, supplied_key)
        updates = {
            **public_settings_from_config(config),
            "ui_language": ui_language,
            "review_before_apply": review_before_apply,
            "max_cost_usd": max_cost_usd,
            "glossary": glossary,
            "custom_prices": custom_prices,
        }
        if config["world_dir"] and Path(config["world_dir"]).expanduser().is_dir():
            path = str(Path(config["world_dir"]).expanduser().resolve())
            recent = list_recent_worlds(data_dir)
            updates["recent_worlds"] = [{"path": path, "lastOpened": time.time()}] + [
                {"path": item["path"], "lastOpened": item["lastOpened"]}
                for item in recent if item["path"] != path
            ][:11]
            updates["last_world_dir"] = path
        remember_user_settings(updates, data_dir)
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": {
                    "remembered": True,
                    "apiKeyStored": bool(supplied_key) or _settings_payload(
                        data_dir,
                        provider,
                        check_keyring=body.get("credentialOwner") != "rust",
                    )["apiKeyStored"],
                    "settings": _saved(data_dir),
                    "localhostServer": False,
                },
            }
        )
        return
    if kind in {"worlds.list", "worlds.remember", "worlds.forget"}:
        from mwt.userdata import forget_recent_world, list_recent_worlds, remember_recent_world

        if kind == "worlds.remember":
            if not isinstance(body.get("worldDir"), str) or not body["worldDir"].strip() or not world.is_dir():
                raise ValueError("A valid world directory is required")
            worlds = remember_recent_world(world, data_dir)
        elif kind == "worlds.forget":
            if not isinstance(body.get("worldDir"), str) or not body["worldDir"].strip():
                raise ValueError("A world directory is required")
            worlds = forget_recent_world(world, data_dir)
        else:
            worlds = list_recent_worlds(data_dir)
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": {"worlds": worlds, "localhostServer": False},
            }
        )
        return
    if kind == "world.inspect":
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": _world_inspection(world)})
        return
    if kind == "worlds.discover":
        from mwt.discovery import discover_worlds

        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": discover_worlds()})
        return
    if kind == "resume.status":
        from mwt.userdata import load_last_job

        candidate = _resume_candidate(data_dir, world)
        last_scan = _last_scan_summary(data_dir, world)
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": {
                    **(candidate or {"available": False}),
                    "lastJob": load_last_job(world, data_dir),
                    "lastScan": last_scan,
                },
            }
        )
        return
    if kind == "models.list":
        import os

        from mc_world_translator import DEFAULT_CONFIG, merge_nested
        from llm_backends import LLMProviderClient
        from mwt.secrets import load_api_key

        saved = _saved(data_dir)
        provider = str(body.get("provider") or saved.get("provider") or "openai")
        public_catalog = provider == "openrouter" and body.get("publicCatalog") is True
        config = merge_nested(
            DEFAULT_CONFIG,
            {
                "inherit_translate_py": False,
                "runtime": {"data_dir": str(data_dir)},
                "api": {
                    "provider": provider,
                    "api_key": "" if public_catalog else str(body.get("apiKey") or "")
                    or os.environ.get("POMI_API_KEY")
                    or (load_api_key(provider) if body.get("credentialOwner") != "rust" else "")
                    or "",
                    "model": str(body.get("model") or saved.get("model") or ""),
                    "base_url": str(body.get("baseUrl") or os.environ.get("POMI_API_BASE") or saved.get("base_url") or ""),
                    "wire_format": str(body.get("wireFormat") or saved.get("wire_format") or ""),
                },
            },
        )
        if body.get("credentialOwner") == "rust":
            from mwt.desktop_provider import resolve_desktop_provider
            config["api"].update(resolve_desktop_provider(body, saved))
        if body.get("model") == "":
            config["api"]["model"] = ""  # Catalog lookup must not validate the saved model.
        # A connection check proves the key: it never falls back to a cached list, and a failure
        # keeps the reason (wrong key, no network, timeout) instead of looking like an empty catalog.
        connection_check = body.get("connectionCheck") is True and not public_catalog
        try:
            cached = False
            if public_catalog:
                from mwt.userdata import load_model_catalog, remember_model_catalog
                config["api"].update({"api_key": "", "base_url": "https://openrouter.ai/api/v1", "wire_format": "openai", "model": ""})
                try:
                    models = LLMProviderClient(config).list_public_models()
                    remember_model_catalog(provider, models, root=data_dir)
                except Exception:
                    models = load_model_catalog(provider, root=data_dir)
                    if not models:
                        raise
                    cached = True
            elif connection_check:
                from mwt.userdata import remember_model_catalog

                models = LLMProviderClient(config).check_connection()
                remember_model_catalog(provider, models, root=data_dir)
            else:
                client = LLMProviderClient(config)
                models = client.try_refresh_model_catalog()
                cached = client.catalog_cached
        except Exception as exc:
            from llm_backends import ProviderError

            if isinstance(exc, ProviderError):
                code = exc.code
            elif connection_check and "API key is missing" in str(exc):
                code = "KEY_MISSING"
            else:
                code = "MODELS_FAILED"
            emit(
                {
                    "v": 1,
                    "id": request_id,
                    "type": "response.error",
                    "error": {"code": code, "message": str(exc)},
                }
            )
            return
        from llm_backends import annotate_suitability

        models = annotate_suitability(models)
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": {
                    "provider": provider,
                    "models": models,
                    "hiddenCount": sum(1 for item in models if item.get("suitable") is False),
                    "cached": cached,
                    "localhostServer": False,
                },
            }
        )
        return
    if kind == "provider.usage":
        from mwt.desktop_usage import fetch_openrouter_usage

        result = fetch_openrouter_usage(body, _saved(data_dir))
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": result})
        return
    if kind == "prompt.enhance":
        from mwt.desktop_prompt import enhance_desktop_prompt

        result = enhance_desktop_prompt(body, _saved(data_dir), data_dir)
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": result})
        return
    if kind == "scan.start":
        inspection = _world_inspection(world)
        if not inspection["validJavaWorld"]:
            emit(
                {
                    "v": 1,
                    "id": request_id,
                    "type": "response.error",
                    "error": {
                        "code": "WORLD_NOT_SUPPORTED",
                        "message": "Select a Minecraft Java world folder or a server root containing Java worlds.",
                        "details": inspection,
                        "recoverable": True,
                    },
                }
            )
            return
        scope_before = _scan_scope_fingerprint(data_dir)
        pack_inputs = pack_scope_signature(_saved(data_dir))
        report = _run_translator(
            world,
            dry_run=True,
            report_path=report_dir / "scan-report.json",
            data_dir=data_dir,
            candidate_limit=200,
            progress_callback=lambda event: emit(
                {"v": 1, "id": request_id, "type": "scan.progress", "payload": event}
            ),
            cancel_check=(lambda: cancel_path.is_file()) if cancel_path else None,
            desktop_context=body if body.get("credentialOwner") == "rust" else None,
        )
        skipped = [
            item for item in report.get("changed_files", [])
            if item.get("skipped") in {"unsupported_compression", "parse_error", "file_error"}
        ]
        blockers = list(report.get("write_blockers") or [])
        blockers.extend(
            f"{item.get('skipped')}: {item.get('file', 'unknown file')}" for item in skipped
        )
        fingerprint = str(report.get("world_fingerprint", ""))
        def invalidate_report() -> None:
            from mc_world_translator import write_text_atomic

            report["status"] = "invalidated"
            report.setdefault("errors", []).append({"code": "PLAN_INVALIDATED", "scope": "scan", "message": "Translation scope changed while scanning"})
            public_report = {key: value for key, value in report.items() if not key.startswith("_")}
            write_text_atomic(report_dir / "scan-report.json", json.dumps(public_report, ensure_ascii=False, indent=2))

        try:
            scope_fingerprint = _scan_scope_fingerprint(data_dir)
        except ExternalPackUnavailable:
            invalidate_report()
            raise
        if scope_fingerprint != scope_before:
            invalidate_report()
            emit({"v": 1, "id": request_id, "type": "response.error",
                  "error": {"code": "PLAN_INVALIDATED", "message": "Translation scope changed while scanning. Run Scan again.", "recoverable": True}})
            return
        scan_plan_id = _scan_plan_id(fingerprint, scope_fingerprint)
        records = list(report.pop("_candidate_records", []))
        if report.get("status") == "completed":
            _prune_finished_jobs(data_dir, world, scan_plan_id)
            _save_scan_plan(
                data_dir,
                scan_plan_id,
                world_fingerprint=fingerprint,
                scope_fingerprint=scope_fingerprint,
                candidates=records,
                world_dir=world,
                external_pack_fingerprints={item["path"]: {"sha256": item["sha256"], "parentIdentity": item["parentIdentity"]} for item in pack_inputs if "sha256" in item},
            )
        last_scan = _last_scan_summary(data_dir, world) if report.get("status") == "completed" else None
        saved = _saved(data_dir)
        estimate = _estimate(records, saved, data_dir, glossary=_effective_glossary(data_dir, world))
        kind_counts: dict[str, int] = {}
        for record in records:
            kind_counts[record["kind"]] = kind_counts.get(record["kind"], 0) + 1
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": {
                    "status": report.get("status"),
                    "candidateCount": report.get("candidate_text_count", 0),
                    "occurrenceCount": sum(record["occurrences"] for record in records),
                    "kinds": kind_counts,
                    "providerRequests": report.get("provider_requests", 0),
                    "fingerprint": fingerprint,
                    "scanPlanId": scan_plan_id,
                    "lastScan": last_scan,
                    "dryRun": True,
                    "localhostServer": False,
                    "preTranslate": PRE_TRANSLATE,
                    "writeBlockers": blockers,
                    "errors": report.get("errors", []),
                    "warnings": report.get("warnings", []),
                    "requestEstimate": estimate["requests"],
                    "estimate": estimate,
                    "coverage": _coverage(
                        world,
                        bool(_saved(data_dir).get("resource_pack_enabled")),
                        _saved(data_dir).get("scan_options"),
                        _saved(data_dir).get("external_resource_pack_paths", []),
                    ),
                    "candidates": report.get("candidate_preview", []),
                },
            }
        )
        return
    if kind == "estimate.get":
        plan = _load_scan_plan(data_dir, str(body.get("scanPlanId") or ""))
        if not plan:
            raise ValueError("Scan plan was not found")
        saved = _saved(data_dir)
        source_overrides = normalize_source_overrides(
            saved.get("source_overrides", {}), field="saved source_overrides"
        )
        skipped = {str(item) for item in body.get("excludedCandidateIds") or []}
        skipped.update(str(item) for item in body.get("overrideCandidateIds") or [])
        skipped.update(
            str(item.get("id"))
            for item in plan.get("candidates", [])
            if isinstance(item, dict)
            and str(item.get("source") or "") in source_overrides
        )
        included = [item for item in plan.get("candidates", []) if isinstance(item, dict) and item.get("id") not in skipped]
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": _estimate(included, saved, data_dir, glossary=_effective_glossary(data_dir, world))})
        return
    if kind == "candidates.page":
        scan_plan_id = str(body.get("scanPlanId") or "")
        plan = _load_scan_plan(data_dir, scan_plan_id)
        if not plan:
            raise ValueError("Scan plan was not found")
        saved = _saved(data_dir)
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": _candidate_page(plan, body, saved.get("source_overrides", {})),
            }
        )
        return
    if kind == "translations.page":
        scan_plan_id = str(body.get("scanPlanId") or "")
        plan = _load_scan_plan(data_dir, scan_plan_id)
        if not plan:
            raise ValueError("Scan plan was not found")
        job = _load_job(data_dir, scan_plan_id, world)
        saved = _saved(data_dir)
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": _translations_payload(plan, job, saved, body, data_dir),
            }
        )
        return
    if kind in {"translate.start", "translate.resume"}:
        if kind == "translate.resume":
            resumable = _resume_candidate(data_dir, world)
            if not resumable:
                emit(
                    {
                        "v": 1,
                        "id": request_id,
                        "type": "response.error",
                        "error": {
                            "code": "RESUME_NOT_AVAILABLE",
                            "message": "The cancelled job no longer matches the world or translation settings.",
                            "recoverable": True,
                        },
                    }
                )
                return
            if resumable.get("status") == "reapply_interrupted":
                raise RequestRefused("REAPPLY_INTERRUPTED", "Restore the recovery snapshot or reapply the saved translations.",
                                     {"recoverySetId": resumable.get("recoverySetId")})
            body = {
                "fingerprint": resumable["fingerprint"],
                "scanPlanId": resumable["scanPlanId"],
                "excludedCandidateIds": resumable["excludedCandidateIds"],
                "candidateOverrides": resumable["candidateOverrides"],
                # Older clients can omit review fields. Explicit current review choices
                # (including empty lists/maps) must win over checkpoint defaults.
                # The core fingerprint rejects a cached job when these choices changed.
                **body,
            }
        fingerprint = str(body.get("fingerprint") or "")
        scan_plan_id = str(body.get("scanPlanId") or "")
        stored_plan = _validated_plan(data_dir, fingerprint, scan_plan_id)
        pending_reapply = (_load_job(data_dir, scan_plan_id, world).get("reapply") or {})
        if pending_reapply:
            raise RequestRefused("REAPPLY_INTERRUPTED", "Restore the recovery snapshot or reapply the saved translations.",
                                 {"recoverySetId": pending_reapply.get("recoverySetId")})
        excluded = [
            str(candidate_id)
            for candidate_id in body.get("excludedCandidateIds", [])
            if isinstance(candidate_id, str) and len(candidate_id) == 20
        ]
        known_candidate_ids = {
            str(candidate.get("id"))
            for candidate in stored_plan.get("candidates", [])
            if isinstance(candidate, dict)
        }
        if any(candidate_id not in known_candidate_ids for candidate_id in excluded):
            raise ValueError("An excluded candidate is not part of this scan plan")
        candidate_by_id = {
            str(candidate.get("id")): str(candidate.get("source"))
            for candidate in stored_plan.get("candidates", [])
            if isinstance(candidate, dict)
        }
        raw_overrides = body.get("candidateOverrides") or {}
        if not isinstance(raw_overrides, dict):
            raise ValueError("Candidate overrides must be an object")
        overrides_by_source: dict[str, str] = {}
        for candidate_id, translated in raw_overrides.items():
            if candidate_id not in candidate_by_id or not isinstance(translated, str):
                raise ValueError("A manual override is not part of this scan plan")
            cleaned = translated.strip()
            if not cleaned or len(cleaned) > 32_000:
                raise ValueError("A manual override is empty or too long")
            overrides_by_source[candidate_by_id[candidate_id]] = cleaned
        saved = _saved(data_dir)
        source_overrides = normalize_source_overrides(
            saved.get("source_overrides", {}), field="saved source_overrides"
        )
        included_ids = known_candidate_ids.difference(excluded)
        uncovered_ids = {
            candidate_id
            for candidate_id in included_ids
            if candidate_id not in raw_overrides
            and candidate_by_id[candidate_id] not in source_overrides
        }
        manual_only = bool(included_ids) and not uncovered_ids
        review = saved.get("review_before_apply", True) is not False
        normalize_review_before_apply(body.get("budgetOverride", False), field="budgetOverride")
        normalize_review_before_apply(body.get("budgetDisabled", False), field="budgetDisabled")
        report = _run_translator(
            world,
            dry_run=False,
            report_path=report_dir / "translate-report.json",
            fingerprint=fingerprint,
            data_dir=data_dir,
            excluded_candidate_ids=excluded,
            progress_callback=lambda event: emit(
                {"v": 1, "id": request_id, "type": "translate.progress", "payload": event}
            ),
            cancel_check=(lambda: cancel_path.is_file()) if cancel_path else None,
            api_key_override=str(body.get("apiKey") or ""),
            allow_keyring_fallback=body.get("credentialOwner") != "rust",
            manual_overrides=overrides_by_source,
            skip_provider_validation=manual_only,
            scan_plan_id=scan_plan_id,
            resume_from_checkpoint=kind == "translate.resume",
            external_pack_fingerprints=stored_plan.get("externalPackFingerprints", {}),
            on_translation_failure=str(body.get("failurePolicy") or "stop"),
            desktop_context=body if body.get("credentialOwner") == "rust" else None,
            review_before_apply=review,
            budget_override=body.get("budgetOverride", False),
            budget_disabled=body.get("budgetDisabled", False),
        )
        try:
            from mwt.userdata import remember_last_job

            remember_last_job(world, report, data_dir)
        except (OSError, ValueError):
            pass  # the start screen's summary is a convenience; the result below is what matters
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": _translate_payload(report)})
        return
    if kind in {"translate.apply", "translate.reapply"}:
        reapply = kind == "translate.reapply"
        fingerprint = str(body.get("fingerprint") or "")
        scan_plan_id = str(body.get("scanPlanId") or "")
        if not fingerprint or not scan_plan_id:
            raise RequestRefused("SCAN_REQUIRED", "Run Scan Only and review its result before translating.")
        job = _load_job(data_dir, scan_plan_id, world)
        interrupted = job.get("reapply") or {}
        validation_applied = job.get("applied") if reapply else None
        if interrupted:
            if not reapply:
                raise RequestRefused("REAPPLY_INTERRUPTED", "Restore the recovery snapshot or reapply the saved translations.",
                                     {"recoverySetId": interrupted.get("recoverySetId")})
            validation_applied = {"external_pack_fingerprints": interrupted.get("restoredExternalFingerprints") or {}}
        stored_plan = _validated_plan(data_dir, fingerprint, scan_plan_id, applied=validation_applied)
        if not job:
            raise RequestRefused("JOB_NOT_FOUND", "There is no saved translation job for this scan.")
        applied = job.get("applied") or {}
        job_applied = bool(applied)
        source_by_id = {
            str(item.get("id")): str(item.get("source"))
            for item in stored_plan.get("candidates", [])
            if isinstance(item, dict)
        }
        edits_by_source, problems = clean_edits(body.get("edits"), source_by_id)
        if problems:
            raise RequestRefused(
                "EDITS_INVALID", "Some edited translations cannot be written.", {"rows": problems}
            )
        if reapply and not (interrupted or (job_applied and applied.get("backup_set_id"))):
            raise RequestRefused("NOTHING_TO_REAPPLY", "This job has no applied backup to restore first.")
        if not reapply and job_applied:
            raise RequestRefused("ALREADY_APPLIED", "This job was already written to the world.")
        saved = _saved(data_dir)
        glossary = _effective_glossary(data_dir, world)
        stale = _glossary_stale_sources(stored_plan, job, saved, glossary, data_dir)
        if stale:
            raise RequestRefused("GLOSSARY_CHANGED", "The glossary changed. Re-check affected rows before applying.", {"count": len(stale)})
        checked_job = {**job, "edits": {**(job.get("edits") or {})}}
        for source, text in edits_by_source.items():
            if text is None:
                checked_job["edits"].pop(source, None)
            else:
                checked_job["edits"][source] = text
        from mwt.desktop_review import job_rows
        mismatches = [row for row in job_rows(stored_plan, checked_job, saved.get("source_overrides", {}), glossary=glossary)
                      if row["status"] == "glossary_mismatch"]
        if mismatches and body.get("acknowledgeGlossaryMismatch") is not True:
            raise RequestRefused("GLOSSARY_MISMATCH_UNCONFIRMED", "Review the glossary mismatch warning before applying.", {"count": len(mismatches)})
        raw_excluded = body.get("excludedCandidateIds", [])
        if not isinstance(raw_excluded, list) or any(item not in source_by_id for item in raw_excluded):
            raise ValueError("An excluded candidate is not part of this scan plan")
        excluded = sorted(
            {str(item) for item in (job.get("resume") or {}).get("excluded_candidate_ids") or []}
            | {
                str(item)
                for item in raw_excluded
            }
        )
        resume = job.get("resume") or {}
        manual = {k: v for k, v in (resume.get("manual_overrides") or {}).items() if isinstance(v, str)}
        recovery_id = str(interrupted.get("recoverySetId") or "")
        journal = _reapply_journal(data_dir, scan_plan_id) if reapply else {}
        journal_path = _reapply_path(data_dir, scan_plan_id)

        def journal_restore(_selected, recovery_set_id):
            nonlocal journal, recovery_id
            recovery_id = recovery_set_id
            journal = {
                "version": 1, "phase": "restoring", "savedAt": time.time(),
                "job": job, "edits": checked_job["edits"],
                "excludedCandidateIds": excluded,
                "recoverySetId": recovery_id, "backupSetId": applied["backup_set_id"],
                "originalApplied": applied, "restoredWorldFingerprint": fingerprint,
                "restoredExternalFingerprints": {
                    path: info["sha256"] for path, info in stored_plan.get("externalPackFingerprints", {}).items()
                },
            }
            _durable_json(journal_path, journal)

        try:
            if reapply:
                from mwt.safety import world_fingerprint, file_sha256

                expected = interrupted.get("restoredWorldFingerprint") if interrupted else applied.get("world_fingerprint")
                if world_fingerprint(world.expanduser().resolve()) != expected:
                    raise RequestRefused(
                        "WORLD_CHANGED_SINCE_APPLY",
                        "The world no longer matches the saved state. Restore the recovery snapshot before reapplying.",
                    )
                if not interrupted:
                    _restore_backup(
                        world, str(applied["backup_set_id"]), data_dir,
                        expected_fingerprint=str(applied["world_fingerprint"]),
                        expected_external=applied.get("external_pack_fingerprints") or {},
                        before_restore=journal_restore,
                    )
                if world_fingerprint(world) != journal["restoredWorldFingerprint"]:
                    raise OSError("Restored world does not match the scan baseline")
                for path, digest in journal.get("restoredExternalFingerprints", {}).items():
                    target = Path(path)
                    if target.is_symlink() or not target.is_file() or file_sha256(target) != digest:
                        raise OSError("Restored external pack does not match the scan baseline")
                journal.update(phase="applying", savedAt=time.time(), edits=checked_job["edits"], excludedCandidateIds=excluded)
                _durable_json(journal_path, journal)
            report = _run_translator(
                world,
                dry_run=False,
                report_path=report_dir / "translate-report.json",
                fingerprint=fingerprint,
                data_dir=data_dir,
                excluded_candidate_ids=excluded,
                progress_callback=lambda event: emit(
                    {"v": 1, "id": request_id, "type": "translate.progress", "payload": event}
                ),
                cancel_check=(lambda: cancel_path.is_file()) if cancel_path else None,
                allow_keyring_fallback=False,
                manual_overrides=manual,
                skip_provider_validation=True,
                scan_plan_id=scan_plan_id,
                external_pack_fingerprints=stored_plan.get("externalPackFingerprints", {}),
                on_translation_failure="skip",
                apply_only=True,
                edits=edits_by_source,
                adopt_checkpoint={**checked_job, "applied": None} if reapply else job,
            )
            if reapply:
                # A cancelled/failed/invalidated run or a skipped write is an interrupted
                # reapply, even if the core returned a report rather than raising.
                write_errors = [item for item in report.get("errors", [])
                                if item.get("scope") not in {"provider", "translation", "budget"}]
                if report.get("status") not in {"completed", "partial"} or write_errors:
                    raise OSError("Reapply did not finish all writes")
                finished_journal = {**journal, "phase": "completed", "savedAt": time.time()}
                _durable_json(journal_path, finished_journal)
                journal = finished_journal
        except Exception as exc:
            if interrupted and isinstance(exc, RequestRefused):
                raise  # Fingerprint refusal before a new attempt leaves recovery available.
            if reapply and journal and journal.get("phase") != "completed":
                # The active journal already gives restart readers the honest state even if
                # this checkpoint update fails (disk full, process termination, etc.).
                try:
                    _durable_json(_checkpoint_path(data_dir, scan_plan_id), _interrupted_job(journal))
                except OSError:
                    pass
                raise RequestRefused(
                    "REAPPLY_INTERRUPTED", "Reapply was interrupted. Restore the recovery snapshot or try reapply again.",
                    {"recoverySetId": recovery_id},
                ) from exc
            raise
        try:
            from mwt.userdata import remember_last_job

            remember_last_job(world, report, data_dir)
        except (OSError, ValueError):
            pass  # the start screen's summary is a convenience; the result below is what matters
        payload = _translate_payload(report)
        if reapply:
            payload["recoverySetId"] = recovery_id
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": payload})
        return
    if kind == "translate.retry_failed":
        scan_plan_id = str(body.get("scanPlanId") or "")
        stored_plan = _load_scan_plan(data_dir, scan_plan_id)
        job = _load_job(data_dir, scan_plan_id, world)
        if not job:
            raise RequestRefused("JOB_NOT_FOUND", "There is no saved translation job for this scan.")
        if job.get("reapply"):
            raise RequestRefused("REAPPLY_INTERRUPTED", "Restore the recovery snapshot or reapply the saved translations.",
                                 {"recoverySetId": job["reapply"].get("recoverySetId")})
        stored_plan = _validated_plan(
            data_dir, str(stored_plan.get("worldFingerprint") or ""), scan_plan_id, applied=job.get("applied"),
        )
        from mwt.safety import world_fingerprint, file_sha256
        applied = job.get("applied") or {}
        expected_world = applied.get("world_fingerprint") or job.get("world_fingerprint")
        if world_fingerprint(world) != expected_world:
            raise RequestRefused("PLAN_INVALIDATED", "The world changed after this translation job was saved.")
        for path, digest in (applied.get("external_pack_fingerprints") or {}).items():
            if not Path(path).is_file() or Path(path).is_symlink() or file_sha256(Path(path)) != digest:
                raise RequestRefused("PLAN_INVALIDATED", "An external pack changed after this translation job was applied.")
        saved = _saved(data_dir)
        source_overrides = normalize_source_overrides(
            saved.get("source_overrides", {}), field="saved source_overrides"
        )
        from mwt.desktop_review import failed_sources, job_rows

        glossary = _effective_glossary(data_dir, world)
        stale = _glossary_stale_sources(stored_plan, job, saved, glossary, data_dir)
        refresh = normalize_review_before_apply(body.get("refreshGlossary", False), field="refreshGlossary")
        # Every retry must refresh stale rows too, before it stamps the current glossary hash.
        sources = list(dict.fromkeys(stale + ([] if refresh else failed_sources(stored_plan, job, source_overrides))))
        ordered = [row["source"] for row in job_rows(stored_plan, job, source_overrides)]
        resume = job.get("resume") or {}
        report = _run_translator(
            world,
            dry_run=False,
            report_path=report_dir / "translate-report.json",
            fingerprint=str(stored_plan.get("worldFingerprint") or ""),
            data_dir=data_dir,
            excluded_candidate_ids=[str(item) for item in resume.get("excluded_candidate_ids") or []],
            progress_callback=lambda event: emit(
                {"v": 1, "id": request_id, "type": "translate.progress", "payload": event}
            ),
            cancel_check=(lambda: cancel_path.is_file()) if cancel_path else None,
            api_key_override=str(body.get("apiKey") or ""),
            allow_keyring_fallback=body.get("credentialOwner") != "rust",
            manual_overrides={k: v for k, v in (resume.get("manual_overrides") or {}).items() if isinstance(v, str)},
            scan_plan_id=scan_plan_id,
            external_pack_fingerprints=stored_plan.get("externalPackFingerprints", {}),
            desktop_context=body if body.get("credentialOwner") == "rust" else None,
            adopt_checkpoint=job,
            retry=(ordered, sources),
            budget_override=normalize_review_before_apply(body.get("budgetOverride", False), field="budgetOverride"),
            budget_disabled=normalize_review_before_apply(body.get("budgetDisabled", False), field="budgetDisabled"),
        )
        try:
            from mwt.userdata import remember_last_job

            remember_last_job(world, report, data_dir)
        except (OSError, ValueError):
            pass  # the start screen's summary is a convenience; the result below is what matters
        emit({"v": 1, "id": request_id, "type": "response.ok", "payload": _translate_payload(report)})
        return
    if kind == "backups.list":
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": {"backups": list_backup_sets(world, _backup_stores(world, data_dir)), "localhostServer": False},
            }
        )
        return
    if kind == "restore.start":
        selected, recovery_id = _restore_backup(world, str(body.get("backupSetId") or "latest"), data_dir)
        # Restoring a reapply recovery snapshot returns the original applied job as well as
        # its bytes. Keep the snapshot itself; only settle its active journal after validation.
        from mwt.safety import world_fingerprint, file_sha256
        for path in (data_dir / "jobs").glob("*.checkpoint.reapply.json"):
            scan_plan_id = path.name.split(".", 1)[0]
            journal = _reapply_journal(data_dir, scan_plan_id)
            if not journal or journal.get("recoverySetId") != selected.backup_id:
                continue
            original = journal.get("originalApplied") or {}
            if world_fingerprint(world) != original.get("world_fingerprint"):
                continue
            if any(not Path(target).is_file() or Path(target).is_symlink() or file_sha256(Path(target)) != digest
                   for target, digest in (original.get("external_pack_fingerprints") or {}).items()):
                continue
            _durable_json(_checkpoint_path(data_dir, scan_plan_id), journal["job"])
            _durable_json(path, {**journal, "phase": "completed", "savedAt": time.time()})
        emit(
            {
                "v": 1,
                "id": request_id,
                "type": "response.ok",
                "payload": {
                    "status": "restored",
                    "backupSetId": selected.backup_id,
                    "recoverySetId": recovery_id,
                    "localhostServer": False,
                },
            }
        )
        return
    emit(
        {
            "v": 1,
            "id": request_id,
            "type": "response.error",
            "error": {"code": "UNKNOWN_MESSAGE", "message": f"Unknown message {kind}"},
        }
    )


def serve(report_dir: Path, data_dir: Path, cancel_path: Path | None = None) -> None:
    hello()
    for line in sys.stdin:
        if not line.strip():
            continue
        dispatch(line, report_dir, data_dir, cancel_path)


def dispatch(line: str, report_dir: Path, data_dir: Path, cancel_path: Path | None = None) -> None:
    """Handle one JSONL request and answer it, turning every failure into an error response."""
    message: dict = {}
    try:
        message = json.loads(line)
        if not isinstance(message, dict):
            raise ValueError("Protocol message must be an object")
        if message.get("v") != 1:
            raise ValueError("Unsupported protocol version")
        handle(message, report_dir, data_dir, cancel_path)
    except RequestRefused as exc:
        error = {"code": exc.code, "message": str(exc), "recoverable": True}
        if exc.details:
            error["details"] = exc.details
        emit({"v": 1, "id": message.get("id", ""), "type": "response.error", "error": error})
    except (ExternalPackUnavailable, ExternalTargetError):
        emit({"v": 1, "id": message.get("id", ""), "type": "response.error",
              "error": {"code": "EXTERNAL_PACK_UNAVAILABLE", "message": "Selected external ZIP is unavailable or its parent directory changed. Select the original ZIP in Settings before scanning or restoring.", "recoverable": True}})
    except (json.JSONDecodeError, ValueError) as exc:
        emit(
            {
                "v": 1,
                "id": message.get("id", ""),
                "type": "response.error",
                "error": {"code": "INVALID_REQUEST", "message": str(exc), "recoverable": True},
            }
        )
    except Exception:
        emit(
            {
                "v": 1,
                "id": message.get("id", ""),
                "type": "response.error",
                "error": {
                    "code": "OPERATION_FAILED",
                    "message": "The operation failed. The world was not marked as completed.",
                    "recoverable": True,
                },
            }
        )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="PomiTranslate desktop entry")
    parser.add_argument("--notices", action="store_true")
    parser.add_argument("--about", action="store_true")
    parser.add_argument("--scan", type=str)
    parser.add_argument("--translate", type=str)
    parser.add_argument("--fingerprint", default="")
    parser.add_argument("--restore", type=str)
    parser.add_argument("--jsonl", action="store_true")
    parser.add_argument("--report-dir", default="")
    parser.add_argument("--data-dir", default="")
    parser.add_argument("--cancel-file", default="")
    args = parser.parse_args(argv)
    from mwt.userdata import user_data_dir

    report_dir = Path(args.report_dir) if args.report_dir else Path.cwd() / ".pomi-reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    data_dir = Path(args.data_dir).expanduser() if args.data_dir else user_data_dir()
    if args.notices:
        print(FIRST_LAUNCH)
        return
    if args.about:
        print(ABOUT)
        return
    if args.jsonl:
        cancel_path = Path(args.cancel_file) if args.cancel_file else None
        serve(report_dir, data_dir, cancel_path)
        return
    if args.scan:
        report = _run_translator(
            Path(args.scan),
            dry_run=True,
            report_path=report_dir / "scan-report.json",
            data_dir=data_dir,
        )
        print(json.dumps({"localhostServer": False, "dryRun": True, **report}, ensure_ascii=False))
        return
    if args.translate:
        report = _run_translator(
            Path(args.translate),
            dry_run=False,
            report_path=report_dir / "translate-report.json",
            fingerprint=args.fingerprint,
            data_dir=data_dir,
        )
        print(json.dumps({"localhostServer": False, "preTranslate": PRE_TRANSLATE, **report}, ensure_ascii=False))
        return
    if args.restore:
        world = Path(args.restore)
        stores = _backup_stores(world, data_dir)
        listed = list_backup_sets(world, stores)
        if not listed:
            raise SystemExit("There is no backup to restore")
        BackupSet.find(world, listed[0]["backupSetId"], stores).restore(recovery_store=stores[0])
        print(json.dumps({"status": "restored", "localhostServer": False}))
        return
    hello()


if __name__ == "__main__":
    main()
