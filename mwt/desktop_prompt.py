"""Prompt enhancement for Rust-owned desktop requests."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from llm_backends import LLMProviderClient, enhance_style_prompt
from mc_world_translator import DEFAULT_CONFIG, STYLE_PRESETS, merge_nested

from mwt.desktop_provider import resolve_desktop_provider


MAX_BRIEF_CHARS = 4_000
MAX_TARGET_LANGUAGE_CHARS = 256
MAX_STYLE_PROMPT_CHARS = 8_000
MAX_CUSTOM_SYSTEM_PROMPT_CHARS = 8_000

_EMPTY_USAGE = {"prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0, "cost_reported": False, "requests": 0}


def _draft_string(body: dict[str, Any], key: str, maximum: int, *, required: bool = False) -> str:
    value = body.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    if len(value) > maximum:
        raise ValueError(f"{key} is too long")
    if required and not value.strip():
        raise ValueError(f"{key} is required")
    return value


def _request_timeout(saved: dict[str, Any]) -> int:
    raw = saved.get("request_timeout", DEFAULT_CONFIG["api"]["request_timeout"])
    try:
        timeout = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid saved request timeout") from exc
    if not 5 <= timeout <= 600:
        raise ValueError("Saved request timeout must be between 5 and 600 seconds")
    return timeout


def enhance_desktop_prompt(body: dict[str, Any], saved: dict[str, Any], data_dir: Path) -> dict[str, Any]:
    """Enhance a prompt without falling back to process secrets or persisting settings."""
    if not isinstance(body, dict):
        raise ValueError("Prompt enhancement payload must be an object")
    if body.get("credentialOwner") != "rust":
        raise ValueError("Prompt enhancement requires a Rust-owned credential")

    brief = _draft_string(body, "brief", MAX_BRIEF_CHARS, required=True).strip()
    target_language = _draft_string(
        body, "targetLanguage", MAX_TARGET_LANGUAGE_CHARS, required=True
    ).strip()
    style_preset = _draft_string(body, "stylePreset", 32, required=True).strip()
    if style_preset not in STYLE_PRESETS:
        raise ValueError("Unsupported style preset")
    style_prompt = _draft_string(body, "stylePrompt", MAX_STYLE_PROMPT_CHARS)
    custom_system_prompt = _draft_string(body, "customSystemPrompt", MAX_CUSTOM_SYSTEM_PROMPT_CHARS)

    # This validates the provider and pins its endpoint before the enhancer can make a request.
    selected = resolve_desktop_provider(body, saved)
    if not selected["api_key"].strip():
        raise ValueError("Rust-owned API key is missing")
    config = merge_nested(
        DEFAULT_CONFIG,
        {
            "inherit_translate_py": False,
            "runtime": {"data_dir": str(data_dir)},
            "api": {
                **selected,
                "request_timeout": _request_timeout(saved),
            },
            "prompt": {
                "target_language": target_language,
                "style_preset": style_preset,
                "style_prompt": style_prompt,
                "custom_system_prompt": custom_system_prompt,
            },
        },
    )

    # The legacy helper returns only text. The existing client also tracks provider-reported
    # usage globally; isolate this request's counters and restore the caller's prior values.
    with LLMProviderClient._counter_lock:
        previous_request_count = LLMProviderClient.request_count
        previous_usage = dict(LLMProviderClient.usage)
        LLMProviderClient.request_count = 0
        LLMProviderClient.usage = dict(_EMPTY_USAGE)
    try:
        enhanced = enhance_style_prompt(config, brief)
        with LLMProviderClient._counter_lock:
            usage = dict(LLMProviderClient.usage)
    finally:
        with LLMProviderClient._counter_lock:
            LLMProviderClient.request_count = previous_request_count
            LLMProviderClient.usage = previous_usage

    return {"enhancedPrompt": enhanced, "usage": usage}
