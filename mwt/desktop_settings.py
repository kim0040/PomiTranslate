"""Validation and normalization for desktop scan preferences."""

from __future__ import annotations

import json
import re
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any


SCAN_FLAG_KEYS = (
    "translate_signs",
    "translate_books",
    "translate_custom_names",
    "translate_item_names",
    "translate_lore",
    "translate_titles",
    "translate_filtered_titles",
    "translate_command_output",
    "translate_text_displays",
    "skip_command_like_text",
)
SCAN_LIST_LIMITS = {
    "region_dirs": (64, 256),
    "skip_patterns": (64, 256),
    "component_translate_key_prefixes": (128, 256),
}
SCAN_OPTION_KEYS = frozenset((*SCAN_FLAG_KEYS, *SCAN_LIST_LIMITS))

DEFAULT_CONTINUE_ON_FILE_ERROR = True
DEFAULT_MAX_FILE_WRITE_RETRIES = 2
MAX_FILE_WRITE_RETRIES = 10
MAX_SOURCE_OVERRIDES = 5000
MAX_SOURCE_OVERRIDE_CHARS = 32_000
MAX_SOURCE_OVERRIDES_BYTES = 1_048_576
MAX_CUSTOM_PRICES = 1_000

RESOURCE_PACK_OPTION_KEYS = frozenset(
    {"source_lang_files", "target_lang_file", "skip_if_target_exists"}
)
DEFAULT_RESOURCE_PACK_OPTIONS = {
    "source_lang_files": ["en_us.json", "zh_cn.json"],
    "target_lang_file": "ko_kr.json",
    "skip_if_target_exists": False,
}
MAX_RESOURCE_PACK_SOURCE_LANG_FILES = 16
MAX_RESOURCE_PACK_LANG_FILE_LENGTH = 64
_RESOURCE_PACK_LANG_FILE = re.compile(r"[A-Za-z0-9_.-]+\.json", re.ASCII)


def normalize_source_overrides(value: Any, *, field: str = "sourceOverrides") -> dict[str, str]:
    """Validate a bounded map whose keys match source strings exactly."""
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    if len(value) > MAX_SOURCE_OVERRIDES:
        raise ValueError(f"{field} must contain at most {MAX_SOURCE_OVERRIDES} entries")

    normalized: dict[str, str] = {}
    for source, target in value.items():
        if not isinstance(source, str) or not isinstance(target, str):
            raise ValueError(f"{field} must map strings to strings")
        cleaned_target = target.strip()
        if not source.strip() or not cleaned_target:
            raise ValueError(f"{field} cannot contain an empty source or target")
        if len(source) > MAX_SOURCE_OVERRIDE_CHARS or len(target) > MAX_SOURCE_OVERRIDE_CHARS:
            raise ValueError(f"{field} source and target strings must be at most {MAX_SOURCE_OVERRIDE_CHARS} characters")
        if "\x00" in source or "\x00" in cleaned_target:
            raise ValueError(f"{field} cannot contain NUL characters")
        normalized[source] = cleaned_target

    try:
        encoded = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{field} contains invalid Unicode") from exc
    if len(encoded) > MAX_SOURCE_OVERRIDES_BYTES:
        raise ValueError(f"{field} exceeds {MAX_SOURCE_OVERRIDES_BYTES} UTF-8 bytes")
    return normalized


def normalize_custom_prices(value: Any, *, field: str = "customPrices") -> dict[str, dict[str, Any]]:
    """Validate user-supplied USD-per-token prices indexed by provider/model."""
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    if len(value) > MAX_CUSTOM_PRICES:
        raise ValueError(f"{field} can contain at most {MAX_CUSTOM_PRICES} provider/model prices")
    normalized: dict[str, dict[str, Any]] = {}
    for key, raw in value.items():
        if not isinstance(key, str) or "/" not in key:
            raise ValueError(f"{field} keys must be provider/model")
        provider, model = key.split("/", 1)
        if provider not in {"openai", "gemini", "anthropic", "openrouter", "comet", "custom"} or not model.strip():
            raise ValueError(f"{field} contains an invalid provider/model key")
        if not isinstance(raw, dict):
            raise ValueError(f"{field}.{key} must be an object")
        values: dict[str, float] = {}
        for name in ("input", "output"):
            item = raw.get(name)
            if isinstance(item, bool):
                raise ValueError(f"{field}.{key}.{name} must be between 0 and 1000 USD per 1M tokens")
            try:
                number = float(item)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{field}.{key}.{name} must be between 0 and 1000 USD per 1M tokens") from exc
            if not 0 <= number <= 1000:
                raise ValueError(f"{field}.{key}.{name} must be between 0 and 1000 USD per 1M tokens")
            values[name] = number
        updated_at = raw.get("updatedAt")
        if isinstance(updated_at, str):
            try:
                datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError(f"{field}.{key}.updatedAt must be an ISO timestamp") from exc
        else:
            updated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        normalized[key] = {**values, "updatedAt": updated_at}
    return normalized


def _validated_resource_pack_options(value: Any, *, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    unknown = set(value).difference(RESOURCE_PACK_OPTION_KEYS)
    if unknown:
        raise ValueError(f"Unknown {field} option: {sorted(str(key) for key in unknown)[0]}")

    normalized: dict[str, Any] = {}
    if "source_lang_files" in value:
        source_files = value["source_lang_files"]
        if not isinstance(source_files, list) or len(source_files) > MAX_RESOURCE_PACK_SOURCE_LANG_FILES:
            raise ValueError(
                f"{field}.source_lang_files must be a list of at most {MAX_RESOURCE_PACK_SOURCE_LANG_FILES} filenames"
            )
        cleaned_files: list[str] = []
        for filename in source_files:
            cleaned = filename.strip() if isinstance(filename, str) else ""
            if (
                not cleaned
                or len(cleaned) > MAX_RESOURCE_PACK_LANG_FILE_LENGTH
                or ".." in cleaned
                or not _RESOURCE_PACK_LANG_FILE.fullmatch(cleaned)
            ):
                raise ValueError(f"{field}.source_lang_files contains an invalid .json filename")
            if cleaned in cleaned_files:
                raise ValueError(f"{field}.source_lang_files must contain unique filenames")
            cleaned_files.append(cleaned)
        normalized["source_lang_files"] = cleaned_files

    if "target_lang_file" in value:
        target_file = value["target_lang_file"]
        cleaned_target = target_file.strip() if isinstance(target_file, str) else ""
        if (
            not cleaned_target
            or len(cleaned_target) > MAX_RESOURCE_PACK_LANG_FILE_LENGTH
            or ".." in cleaned_target
            or not _RESOURCE_PACK_LANG_FILE.fullmatch(cleaned_target)
        ):
            raise ValueError(f"{field}.target_lang_file must be a valid .json filename")
        normalized["target_lang_file"] = cleaned_target

    if "skip_if_target_exists" in value:
        skip_if_target_exists = value["skip_if_target_exists"]
        if type(skip_if_target_exists) is not bool:
            raise ValueError(f"{field}.skip_if_target_exists must be a boolean")
        normalized["skip_if_target_exists"] = skip_if_target_exists

    return normalized


def normalize_resource_pack_options(
    options: Any = None,
    *,
    saved: Any = None,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return complete resource-pack locale settings, applying defaults, saved values, then updates."""
    normalized = dict(DEFAULT_RESOURCE_PACK_OPTIONS if defaults is None else defaults)
    # Validate the defaults too so callers cannot accidentally produce unsafe settings.
    normalized = _validated_resource_pack_options(normalized, field="default resource_pack_options")
    if set(normalized) != RESOURCE_PACK_OPTION_KEYS:
        raise ValueError("default resource_pack_options must define every supported option")
    if saved is not None:
        normalized.update(
            _validated_resource_pack_options(saved, field="saved resource_pack_options")
        )
    if options is not None:
        normalized.update(_validated_resource_pack_options(options, field="resourcePackOptions"))
    if normalized["target_lang_file"] in normalized["source_lang_files"]:
        raise ValueError("resource_pack_options.target_lang_file cannot be a source language file")
    return normalized


def normalize_continue_on_file_error(value: Any, *, field: str = "continueOnFileError") -> bool:
    if type(value) is not bool:
        raise ValueError(f"{field} must be a boolean")
    return value


def normalize_max_file_write_retries(value: Any, *, field: str = "maxFileWriteRetries") -> int:
    if type(value) is not int or not 1 <= value <= MAX_FILE_WRITE_RETRIES:
        raise ValueError(f"{field} must be an integer between 1 and {MAX_FILE_WRITE_RETRIES}")
    return value


def _defaults(default_scan: dict[str, Any] | None = None) -> dict[str, Any]:
    if default_scan is None:
        from mc_world_translator import DEFAULT_CONFIG

        default_scan = DEFAULT_CONFIG["scan"]
    return {key: deepcopy(default_scan[key]) for key in SCAN_OPTION_KEYS if key in default_scan}


def _validated_options(value: Any, *, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    unknown = set(value).difference(SCAN_OPTION_KEYS)
    if unknown:
        raise ValueError(f"Unknown {field} option: {sorted(str(key) for key in unknown)[0]}")

    result: dict[str, Any] = {}
    for key, item in value.items():
        if key in SCAN_FLAG_KEYS:
            if type(item) is not bool:
                raise ValueError(f"{field}.{key} must be a boolean")
            result[key] = item
            continue

        maximum_items, maximum_length = SCAN_LIST_LIMITS[key]
        if not isinstance(item, list) or len(item) > maximum_items:
            raise ValueError(f"{field}.{key} must be a list of at most {maximum_items} strings")
        normalized: list[str] = []
        for entry in item:
            if not isinstance(entry, str):
                raise ValueError(f"{field}.{key} must contain only strings")
            cleaned = entry.strip()
            if not cleaned or len(cleaned) > maximum_length or any(ord(char) < 32 for char in cleaned):
                raise ValueError(f"{field}.{key} contains an empty, too long, or invalid string")
            normalized.append(cleaned)
        result[key] = normalized
    return result


def normalize_scan_options(
    options: Any = None,
    *,
    saved: Any = None,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the complete core scan option set, applying defaults, saved values, then updates."""
    normalized = _defaults(defaults)
    if saved is not None:
        normalized.update(_validated_options(saved, field="saved scan_options"))
    if options is not None:
        normalized.update(_validated_options(options, field="scanOptions"))
    return normalized


def normalized_options_from_core_scan(
    scan_config: Any,
    *,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Pick and normalize public options from the core's flat scan config."""
    if not isinstance(scan_config, dict):
        scan_config = {}
    selected = {key: scan_config[key] for key in SCAN_OPTION_KEYS if key in scan_config}
    return normalize_scan_options(selected, defaults=defaults)
